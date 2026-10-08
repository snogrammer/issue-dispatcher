import type { GiteaClient } from "../gitea/client.js";
import type { Issue } from "../gitea/types.js";
import type { Logger } from "../log.js";
import { renderIssue, type Item, type QuestionDesk } from "./questions.js";
import type { WatchedRepo } from "./repos.js";

/**
 * Before #53 the dispatcher filed one issue per question ("Question from #n:
 * …", "Confirm decision on #n: …"). This folds the open ones into the single
 * questions issue per source that QuestionDesk now keeps, keeping their dedup
 * keys so they aren't asked again, and closes them with a link to it.
 */

const LEGACY_MARKER =
  /<!-- claude-dispatcher:question source=(\d+) key=([0-9a-f]+) blocking=(true|false) -->/;

export interface LegacyQuestion {
  number: number;
  source: number;
  item: Item;
}

/** The legacy question an issue holds, or undefined if it isn't one. */
export function legacyQuestion(
  issue: Pick<Issue, "number" | "title" | "body">,
): LegacyQuestion | undefined {
  const match = LEGACY_MARKER.exec(issue.body);
  if (!match) return undefined;
  const source = Number(match[1]);
  const key = match[2] ?? "";
  const body = issue.body.replace(LEGACY_MARKER, "").trim();

  const field = (name: string) =>
    new RegExp(`^\\*\\*${name}:\\*\\* (.*)$`, "m").exec(body)?.[1]?.trim();
  const question = field("Question");
  const chosen = field("Chosen");
  if (question !== undefined && chosen !== undefined) {
    const why = field("Why") ?? "";
    // Alternatives were joined with ", " and can't be split back reliably.
    const alternatives = field("Alternatives");
    return {
      number: issue.number,
      source,
      item: {
        key,
        kind: "decision",
        title: question,
        body: why === "" ? "" : `**Why:** ${why}`,
        options: [
          chosen,
          ...(alternatives === undefined || alternatives === "none listed" ? [] : [alternatives]),
        ],
      },
    };
  }

  // Preamble paragraph, Claude's text, status paragraph.
  const paragraphs = body.split("\n\n");
  return {
    number: issue.number,
    source,
    item: {
      key,
      kind: match[3] === "true" ? "blocking" : "followup",
      title: issue.title.replace(/^Question from #\d+: /, ""),
      body: paragraphs.slice(1, -1).join("\n\n"),
      options: [],
    },
  };
}

export type SquashGitea = Pick<
  GiteaClient,
  | "listIssues"
  | "getIssue"
  | "listDependencies"
  | "removeDependency"
  | "createComment"
  | "closeIssue"
>;

export interface SquashOptions {
  repo: Pick<WatchedRepo, "ref" | "fullName">;
  questionLabel: string;
  reviewer: string;
  gitea: SquashGitea;
  desk: QuestionDesk;
  log: Logger;
  /** Without it, only report what would change. */
  apply: boolean;
  /** Where a dry run prints the issues it would file. */
  write?: (text: string) => void;
}

/** Squash a repo's open legacy question issues into one questions issue per source. */
export async function squashLegacyQuestions(options: SquashOptions): Promise<void> {
  const { repo, gitea, log } = options;
  const open = await gitea.listIssues(repo.ref, { state: "open", labels: [options.questionLabel] });
  const bySource = new Map<number, LegacyQuestion[]>();
  for (const legacy of open.map(legacyQuestion)) {
    if (legacy === undefined) continue;
    bySource.set(legacy.source, [...(bySource.get(legacy.source) ?? []), legacy]);
  }
  if (bySource.size === 0) {
    log.info("no legacy questions to squash", { repo: repo.fullName });
    return;
  }

  for (const [number, legacies] of [...bySource].sort(([a], [b]) => a - b)) {
    legacies.sort((a, b) => a.number - b.number);
    const source = await gitea.getIssue(repo.ref, number);
    const items = legacies.map((legacy) => legacy.item);
    const numbers = legacies.map((legacy) => `#${String(legacy.number)}`).join(", ");
    if (!options.apply) {
      const pending = items.filter((item) => item.kind === "blocking").map((item) => item.key);
      log.info(`would squash ${numbers} into one questions issue for #${String(number)}`, {
        repo: repo.fullName,
        blocking: pending.length > 0,
      });
      (options.write ?? ((text) => process.stdout.write(text)))(
        `\n----- Questions for #${String(number)}: ${source.title}\n${renderIssue(source, options.reviewer, items, { source: number, since: 0, pending })}\n\n`,
      );
      continue;
    }

    const filed = await options.desk.file({ repo, issue: source }, items);
    if (filed.issue === undefined) throw new Error(`no questions issue for #${String(number)}`);
    const target = filed.issue.number;
    const dependencies = new Set(
      (await gitea.listDependencies(repo.ref, number)).map((dependency) => dependency.number),
    );
    for (const legacy of legacies) {
      if (dependencies.has(legacy.number)) {
        await gitea.removeDependency(repo.ref, number, { repo: repo.ref, index: legacy.number });
      }
      await gitea.createComment(
        repo.ref,
        legacy.number,
        `Merged into #${String(target)}, which collects every question about #${String(number)}.`,
      );
      await gitea.closeIssue(repo.ref, legacy.number);
    }
    log.info(`squashed ${numbers} into #${String(target)}`, {
      repo: repo.fullName,
      source: number,
    });
  }
}
