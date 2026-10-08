import { createHash } from "node:crypto";

import type { Report } from "../claude/report.js";
import type { Config } from "../config/schema.js";
import { questionLabel } from "../conventions.js";
import type { GiteaClient } from "../gitea/client.js";
import type { Issue } from "../gitea/types.js";
import { silentLogger, type Logger } from "../log.js";
import type { WorkContext } from "./lifecycle.js";
import type { WatchedRepo } from "./repos.js";

/** What filing needs to know: the repo and the source issue. */
export interface QuestionContext {
  repo: Pick<WatchedRepo, "ref" | "fullName">;
  issue: Issue;
}

/**
 * Questions Claude raises go to the human reviewer in one Gitea issue per
 * source issue ("Questions for #n: …"). The dispatcher writes it, not Claude,
 * so writes stay deterministic.
 *
 * Each question is an item block in the body, opened by a hidden item marker
 * (dedup key and kind) and listing its options as task-list checkboxes with
 * the recommended or chosen one ticked, so the reviewer can answer by ticking.
 * Later rounds append new items and never rewrite old ones, so ticks survive.
 *
 * All state lives in Gitea, so it survives a lost database. A hidden issue
 * marker at the end names the source issue, the blocking items still waiting
 * for an answer, and the last comment before they were asked. While any item
 * is pending, the questions issue is a Gitea dependency of the source issue.
 * Without pending items it isn't, because Gitea won't close an issue with
 * open dependencies and the source has to close when its PRs merge.
 *
 * Pending items count as answered when the questions issue is closed, or when
 * the human reviewer comments on it after they were asked. Comments from
 * anyone else are ignored, so a stranger can't feed instructions into the
 * resumed session. Ticks are read from the body, which only users with write
 * access to the repo can edit.
 */

export type QuestionGitea = Pick<
  GiteaClient,
  | "listIssues"
  | "listLabels"
  | "createIssue"
  | "editIssue"
  | "addDependency"
  | "removeDependency"
  | "listDependencies"
  | "listComments"
  | "createComment"
>;

export type ItemKind = "blocking" | "decision" | "followup";

/** One question for the reviewer, as appended to the questions issue. */
export interface Item {
  key: string;
  kind: ItemKind;
  title: string;
  body: string;
  /** Options to tick; the first is the recommended (blocking) or chosen (decision) one. */
  options: string[];
}

/** An item as it currently reads in the issue body, ticks included. */
export interface ParsedItem {
  key: string;
  kind: ItemKind;
  /** The item's Markdown, without its marker. */
  text: string;
  /** Labels of the ticked options, without the "(recommended)"/"(chosen)" suffix. */
  ticked: string[];
}

export interface IssueMarker {
  source: number;
  /** Comment id the pending items were asked after; earlier replies don't answer them. */
  since: number;
  /** Keys of blocking items still waiting for an answer. */
  pending: string[];
}

export interface Answers {
  /** The questions issue. */
  issue: Issue;
  /** Keys of the items answered. */
  keys: string[];
  /** Question/answer pairs for the resumed Claude session. */
  answers: { question: string; answer: string }[];
}

export interface FiledQuestions {
  /** The questions issue, if the source has one. */
  issue?: Issue;
  /** Items added by this call. */
  added: number;
  /** Whether the source now waits on answers there. */
  blocking: boolean;
}

/** A blocking question the dispatcher raises itself, e.g. when fix rounds run out. */
export interface Escalation {
  /** Unique per situation, e.g. the PR and head it's about; deduplicates re-filing. */
  key: string;
  title: string;
  body: string;
}

const ITEM_MARKER =
  /<!-- claude-dispatcher:item key=([0-9a-f]+) kind=(blocking|decision|followup) -->/g;
const ISSUE_MARKER =
  /<!-- claude-dispatcher:questions source=(\d+) since=(\d+) pending=([0-9a-f,]*) -->/;
const CHECKBOX = /^\s*[-*] \[([ xX])\] (.*)$/gm;
const SUFFIX = / \((?:recommended|chosen)\)$/;

const HEADINGS: Record<ItemKind, string> = {
  blocking: "🛑 Blocking",
  decision: "Decision to confirm",
  followup: "Follow-up",
};

export function fingerprint(kind: "followup" | "decision" | "escalation", title: string): string {
  const normalized = title.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(`${kind}:${normalized}`).digest("hex").slice(0, 12);
}

export function issueMarker({ source, since, pending }: IssueMarker): string {
  return `<!-- claude-dispatcher:questions source=${String(source)} since=${String(since)} pending=${pending.join(",")} -->`;
}

export function parseIssueMarker(body: string): IssueMarker | undefined {
  const match = ISSUE_MARKER.exec(body);
  if (!match) return undefined;
  return {
    source: Number(match[1]),
    since: Number(match[2]),
    pending: (match[3] ?? "").split(",").filter((key) => key !== ""),
  };
}

function itemMarker(item: Pick<Item, "key" | "kind">): string {
  return `<!-- claude-dispatcher:item key=${item.key} kind=${item.kind} -->`;
}

/** The items a report asks the reviewer about, in order. */
export function itemsFromReport(report: Report): Item[] {
  const followups = report.followups.map((followup): Item => ({
    key: fingerprint("followup", followup.title),
    kind: followup.blocking ? "blocking" : "followup",
    title: followup.title,
    body: followup.body,
    options: followup.options,
  }));
  const decisions = report.decisions
    .filter((decision) => decision.needsConfirmation)
    .map((decision): Item => ({
      key: fingerprint("decision", decision.question),
      kind: "decision",
      title: decision.question,
      body: decision.rationale === "" ? "" : `**Why:** ${decision.rationale}`,
      options: [decision.chosen, ...decision.alternatives],
    }));
  return [...followups, ...decisions];
}

export function renderItem(item: Item): string {
  const lines = [itemMarker(item), `### ${HEADINGS[item.kind]}: ${item.title}`];
  if (item.body.trim() !== "") lines.push("", item.body.trim());
  const boxes =
    item.kind === "followup"
      ? ["- [ ] Handled"]
      : item.options.map((option, index) => {
          if (index > 0) return `- [ ] ${option}`;
          return `- [x] ${option} (${item.kind === "blocking" ? "recommended" : "chosen"})`;
        });
  if (boxes.length > 0) lines.push("", ...boxes);
  return lines.join("\n");
}

export function renderIssue(
  source: Pick<Issue, "number" | "title">,
  reviewer: string,
  items: Item[],
  marker: IssueMarker,
): string {
  const ref = `#${String(source.number)}`;
  const intro = `Questions and decisions Claude raised while working on ${ref} (${source.title}), all in one place.

🛑 **Blocking** items pause work on ${ref}: tick an option and reply here as @${reviewer}, or close this issue to go with the ticked options, and work resumes. Decisions and follow-ups don't pause anything: work continued with the ticked choice, so review them when convenient and open an issue for anything that should change.`;
  return `${[intro, ...items.map(renderItem)].join("\n\n")}\n\n${issueMarker(marker)}`;
}

/** Append items before the issue marker and update the marker; old items stay as they are. */
export function appendItems(body: string, items: Item[], marker: IssueMarker): string {
  const content = body.replace(ISSUE_MARKER, "").trimEnd();
  return `${[content, ...items.map(renderItem)].join("\n\n")}\n\n${issueMarker(marker)}`;
}

export function parseItems(body: string): ParsedItem[] {
  const content = body.replace(ISSUE_MARKER, "");
  const matches = [...content.matchAll(ITEM_MARKER)];
  return matches.map((match, index) => {
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? content.length;
    const text = content.slice(start, end).trim();
    const ticked = [...text.matchAll(CHECKBOX)]
      .filter((box) => box[1] !== " ")
      .map((box) => (box[2] ?? "").trim().replace(SUFFIX, ""));
    return { key: match[1] ?? "", kind: match[2] as ItemKind, text, ticked };
  });
}

export class QuestionDesk {
  private readonly labelIds = new Map<string, number>();

  constructor(
    private readonly config: Pick<Config, "labelPrefix" | "humanReviewer">,
    private readonly gitea: QuestionGitea,
    private readonly log: Logger = silentLogger,
  ) {}

  /**
   * Add the report's questions to the source's questions issue, skipping any
   * already there (dedup by key, so a resumed run asking again doesn't
   * duplicate). New blocking items make it a dependency of the source issue.
   */
  async fileFromReport(context: WorkContext, report: Report): Promise<FiledQuestions> {
    return this.file(context, itemsFromReport(report));
  }

  /**
   * Add a blocking item from the dispatcher itself. Answering it resumes the
   * source issue the same way as Claude's own questions. Returns the
   * questions issue, or undefined if the same item was already answered.
   */
  async escalate(context: WorkContext, escalation: Escalation): Promise<Issue | undefined> {
    const filed = await this.file(context, [
      {
        key: fingerprint("escalation", escalation.key),
        kind: "blocking",
        title: escalation.title,
        body: escalation.body,
        options: [],
      },
    ]);
    return filed.blocking ? filed.issue : undefined;
  }

  /** Add items to the source's questions issue, creating it if needed. */
  async file(context: QuestionContext, items: Item[]): Promise<FiledQuestions> {
    const { ref } = context.repo;
    const source = context.issue;
    let issue = await this.find(context);
    const known = new Set(issue ? parseItems(issue.body).map((item) => item.key) : []);
    const fresh = items.filter((item) => {
      if (known.has(item.key)) return false;
      known.add(item.key);
      return true;
    });
    const asked = fresh.filter((item) => item.kind === "blocking").map((item) => item.key);
    if (issue === undefined && fresh.length === 0) return { added: 0, blocking: false };

    if (issue === undefined) {
      const labelId = await this.questionLabelId(context);
      const marker = { source: source.number, since: 0, pending: asked };
      issue = await this.gitea.createIssue(ref, {
        title: `Questions for #${String(source.number)}: ${source.title}`,
        body: renderIssue(source, this.config.humanReviewer, fresh, marker),
        assignees: [this.config.humanReviewer],
        ...(labelId === undefined ? {} : { labelIds: [labelId] }),
      });
      this.log.info("filed questions", {
        repo: context.repo.fullName,
        source: source.number,
        questions: issue.number,
        items: fresh.length,
      });
    } else if (fresh.length > 0) {
      const old = parseIssueMarker(issue.body) ?? { source: source.number, since: 0, pending: [] };
      // Replies before a new question was asked don't answer it.
      const since =
        asked.length > 0 && old.pending.length === 0
          ? await this.lastCommentId(context, issue)
          : old.since;
      const marker = {
        source: source.number,
        since,
        pending: [...new Set([...old.pending, ...asked])],
      };
      issue = await this.gitea.editIssue(ref, issue.number, {
        body: appendItems(issue.body, fresh, marker),
        ...(asked.length > 0 && issue.state !== "open" ? { state: "open" } : {}),
      });
      this.log.info("added questions", {
        repo: context.repo.fullName,
        source: source.number,
        questions: issue.number,
        items: fresh.length,
      });
    }

    const blocking =
      (parseIssueMarker(issue.body)?.pending.length ?? 0) > 0 && issue.state === "open";
    if (blocking) {
      const dependencies = await this.gitea.listDependencies(ref, source.number);
      if (!dependencies.some((dependency) => dependency.number === issue.number)) {
        await this.gitea.addDependency(ref, source.number, { repo: ref, index: issue.number });
      }
    }
    return { issue, added: fresh.length, blocking };
  }

  /**
   * The answers to the source's pending items: "none" if nothing is pending,
   * "pending" while the reviewer hasn't replied or closed the issue.
   */
  async answers(context: WorkContext): Promise<Answers | "none" | "pending"> {
    const { ref } = context.repo;
    const source = context.issue.number;
    const issue = (await this.gitea.listDependencies(ref, source)).find((dependency) => {
      const meta = parseIssueMarker(dependency.body);
      return meta?.source === source && meta.pending.length > 0 && this.isQuestion(dependency);
    });
    const meta = issue && parseIssueMarker(issue.body);
    if (issue === undefined || meta === undefined) return "none";

    const replies = (await this.gitea.listComments(ref, issue.number))
      .filter(
        (comment) => comment.id > meta.since && comment.user.login === this.config.humanReviewer,
      )
      .map((comment) => comment.body.trim())
      .filter((body) => body !== "");
    if (issue.state === "open" && replies.length === 0) return "pending";

    const items = parseItems(issue.body).filter((item) => meta.pending.includes(item.key));
    const answers = items.map((item) => ({
      question: item.text,
      answer:
        item.ticked.length > 0
          ? `Ticked: ${item.ticked.join("; ")}`
          : "Nothing ticked; see the reviewer's reply.",
    }));
    answers.push({
      question: `Reviewer's reply on #${String(issue.number)}`,
      answer:
        replies.join("\n\n") ||
        "The questions issue was closed without a reply. Continue with the ticked options, or the option you recommended where nothing is ticked.",
    });
    return { issue, keys: items.map((item) => item.key), answers };
  }

  /**
   * Mark answered items as done: the questions issue stays open for the rest
   * of its items but no longer blocks the source, so the source can close.
   */
  async resolve(context: WorkContext, answered: Answers): Promise<void> {
    const { ref } = context.repo;
    const { issue } = answered;
    const meta = parseIssueMarker(issue.body);
    if (meta !== undefined) {
      const pending = meta.pending.filter((key) => !answered.keys.includes(key));
      await this.gitea.editIssue(ref, issue.number, {
        body: issue.body.replace(ISSUE_MARKER, issueMarker({ ...meta, pending })),
      });
    }
    await this.gitea.removeDependency(ref, context.issue.number, {
      repo: ref,
      index: issue.number,
    });
    if (issue.state === "open") {
      await this.gitea.createComment(
        ref,
        issue.number,
        `Thanks. Continuing #${String(context.issue.number)} with this answer.`,
      );
    }
  }

  /** The source's questions issue (open or closed), if it has one. */
  private async find(context: QuestionContext): Promise<Issue | undefined> {
    const issues = await this.gitea.listIssues(context.repo.ref, {
      state: "all",
      labels: [questionLabel(this.config.labelPrefix)],
    });
    return issues
      .filter(
        (issue) =>
          this.isQuestion(issue) && parseIssueMarker(issue.body)?.source === context.issue.number,
      )
      .sort((a, b) => a.number - b.number)[0];
  }

  private async lastCommentId(context: QuestionContext, issue: Issue): Promise<number> {
    const comments = await this.gitea.listComments(context.repo.ref, issue.number);
    return Math.max(0, ...comments.map((comment) => comment.id));
  }

  private isQuestion(issue: Issue): boolean {
    return issue.labels.some((label) => label.name === questionLabel(this.config.labelPrefix));
  }

  private async questionLabelId(context: QuestionContext): Promise<number | undefined> {
    const name = context.repo.fullName;
    if (!this.labelIds.has(name)) {
      const label = (await this.gitea.listLabels(context.repo.ref)).find(
        (l) => l.name === questionLabel(this.config.labelPrefix),
      );
      if (label) this.labelIds.set(name, label.id);
    }
    return this.labelIds.get(name);
  }
}
