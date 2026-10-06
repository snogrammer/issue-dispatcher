import { createHash } from "node:crypto";

import type { Report } from "../claude/report.js";
import type { Config } from "../config/schema.js";
import { questionLabel } from "../conventions.js";
import type { GiteaClient } from "../gitea/client.js";
import type { Issue } from "../gitea/types.js";
import { silentLogger, type Logger } from "../log.js";
import type { WorkContext } from "./lifecycle.js";

/**
 * Questions Claude raises become Gitea issues for the human reviewer: the
 * dispatcher files them, not Claude, so writes stay deterministic.
 *
 * All state lives in Gitea, so it survives a lost database:
 * - each question issue has the `claude:question` label and a hidden marker
 *   naming its source issue, a dedup key and whether it blocks;
 * - a blocking question is also a Gitea dependency of the source issue.
 *
 * Non-blocking questions (follow-ups, decisions to confirm) are never
 * dependencies, because Gitea won't close an issue with open dependencies and
 * the source issue has to close when its PRs merge.
 *
 * A blocking question counts as answered when it's closed, or when the human
 * reviewer has commented on it. Comments from anyone else are ignored, so a
 * stranger can't feed instructions into the resumed session.
 */

export type QuestionGitea = Pick<
  GiteaClient,
  | "listIssues"
  | "listLabels"
  | "createIssue"
  | "addDependency"
  | "listDependencies"
  | "listComments"
  | "createComment"
  | "closeIssue"
>;

export interface QuestionDraft {
  key: string;
  title: string;
  body: string;
  blocking: boolean;
}

export interface Marker {
  source: number;
  key: string;
  blocking: boolean;
}

export interface Answer {
  issue: Issue;
  question: string;
  answer: string;
  /** Answered by a comment and still open (the dispatcher closes it on resume). */
  open: boolean;
}

export interface FiledQuestions {
  /** Open blocking questions for the source issue, new or already filed. */
  blocking: Issue[];
  /** Issues created by this call. */
  created: Issue[];
}

const MARKER =
  /<!-- claude-dispatcher:question source=(\d+) key=([0-9a-f]+) blocking=(true|false) -->/;

export function fingerprint(kind: "followup" | "decision", title: string): string {
  const normalized = title.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(`${kind}:${normalized}`).digest("hex").slice(0, 12);
}

export function marker({ source, key, blocking }: Marker): string {
  return `<!-- claude-dispatcher:question source=${String(source)} key=${key} blocking=${String(blocking)} -->`;
}

export function parseMarker(body: string): Marker | undefined {
  const match = MARKER.exec(body);
  if (!match) return undefined;
  return { source: Number(match[1]), key: match[2] ?? "", blocking: match[3] === "true" };
}

/** The question issues a report asks for, in order. */
export function draftsFromReport(
  source: Pick<Issue, "number" | "title">,
  report: Report,
  reviewer: string,
): QuestionDraft[] {
  const ref = `#${String(source.number)}`;
  const followups = report.followups.map((followup) => {
    const key = fingerprint("followup", followup.title);
    const status = followup.blocking
      ? `Work on ${ref} is paused until this is answered. Reply here as @${reviewer}, or close this issue to let Claude continue with its recommended option.`
      : `Work on ${ref} continues; this is for later.`;
    return {
      key,
      blocking: followup.blocking,
      title: `Question from ${ref}: ${followup.title}`,
      body: `While working on ${ref} (${source.title}), Claude raised this ${followup.blocking ? "blocking question" : "follow-up"}:\n\n${followup.body}\n\n${status}\n\n${marker({ source: source.number, key, blocking: followup.blocking })}`,
    };
  });
  const decisions = report.decisions
    .filter((decision) => decision.needsConfirmation)
    .map((decision) => {
      const key = fingerprint("decision", decision.question);
      const alternatives =
        decision.alternatives.length > 0 ? decision.alternatives.join(", ") : "none listed";
      return {
        key,
        blocking: false,
        title: `Confirm decision on ${ref}: ${decision.question}`,
        body: `While working on ${ref} (${source.title}), Claude made this decision on its own and work continued with it. Please confirm it, or say what should change.\n\n**Question:** ${decision.question}\n**Chosen:** ${decision.chosen}\n**Why:** ${decision.rationale}\n**Alternatives:** ${alternatives}\n\n${marker({ source: source.number, key, blocking: false })}`,
      };
    });
  return [...followups, ...decisions];
}

export class QuestionDesk {
  private readonly labelIds = new Map<string, number>();

  constructor(
    private readonly config: Pick<Config, "labelPrefix" | "humanReviewer">,
    private readonly gitea: QuestionGitea,
    private readonly log: Logger = silentLogger,
  ) {}

  /**
   * File the report's questions, skipping any already filed for this source
   * (dedup by key, so a resumed run asking again doesn't duplicate). Open
   * blocking questions become dependencies of the source issue.
   */
  async fileFromReport(context: WorkContext, report: Report): Promise<FiledQuestions> {
    const drafts = draftsFromReport(context.issue, report, this.config.humanReviewer);
    const filed: FiledQuestions = { blocking: [], created: [] };
    if (drafts.length === 0) return filed;

    const { ref } = context.repo;
    const source = context.issue.number;
    const existing = await this.existing(context);
    const dependencies = new Set(
      (await this.gitea.listDependencies(ref, source)).map((issue) => issue.number),
    );
    const labelId = await this.questionLabelId(context);

    for (const draft of drafts) {
      let issue = existing.get(draft.key);
      if (issue === undefined) {
        issue = await this.gitea.createIssue(ref, {
          title: draft.title,
          body: draft.body,
          assignees: [this.config.humanReviewer],
          ...(labelId === undefined ? {} : { labelIds: [labelId] }),
        });
        filed.created.push(issue);
        this.log.info("filed question", {
          repo: context.repo.fullName,
          source,
          question: issue.number,
        });
      }
      // A closed duplicate was already answered; asking again must not block forever.
      if (!draft.blocking || issue.state !== "open") continue;
      if (!dependencies.has(issue.number)) {
        await this.gitea.addDependency(ref, source, { repo: ref, index: issue.number });
        dependencies.add(issue.number);
      }
      filed.blocking.push(issue);
    }
    return filed;
  }

  /**
   * The answers to the source's blocking questions: "none" if it has no
   * blocking questions, "pending" while any is unanswered.
   */
  async answers(context: WorkContext): Promise<Answer[] | "none" | "pending"> {
    const { ref } = context.repo;
    const source = context.issue.number;
    const questions = (await this.gitea.listDependencies(ref, source)).filter((issue) => {
      const meta = parseMarker(issue.body);
      return meta?.source === source && meta.blocking && this.isQuestion(issue);
    });
    if (questions.length === 0) return "none";

    const answers: Answer[] = [];
    for (const question of questions) {
      const replies = (await this.gitea.listComments(ref, question.number))
        .filter((comment) => comment.user.login === this.config.humanReviewer)
        .map((comment) => comment.body.trim())
        .filter((body) => body !== "");
      if (question.state === "open" && replies.length === 0) return "pending";
      answers.push({
        issue: question,
        question: questionText(question),
        answer:
          replies.join("\n\n") ||
          "The question was closed without a reply. Continue with the option you recommended.",
        open: question.state === "open",
      });
    }
    return answers;
  }

  /** Close questions answered by comment, so the source issue can close later. */
  async closeAnswered(context: WorkContext, answers: Answer[]): Promise<void> {
    for (const answer of answers.filter((a) => a.open)) {
      await this.gitea.createComment(
        context.repo.ref,
        answer.issue.number,
        `Thanks. Continuing #${String(context.issue.number)} with this answer.`,
      );
      await this.gitea.closeIssue(context.repo.ref, answer.issue.number);
    }
  }

  /** Question issues already filed for the source, by key (open or closed). */
  private async existing(context: WorkContext): Promise<Map<string, Issue>> {
    const issues = await this.gitea.listIssues(context.repo.ref, {
      state: "all",
      labels: [questionLabel(this.config.labelPrefix)],
    });
    const byKey = new Map<string, Issue>();
    for (const issue of issues.filter((i) => this.isQuestion(i))) {
      const meta = parseMarker(issue.body);
      if (meta?.source === context.issue.number) byKey.set(meta.key, issue);
    }
    return byKey;
  }

  private isQuestion(issue: Issue): boolean {
    return issue.labels.some((label) => label.name === questionLabel(this.config.labelPrefix));
  }

  private async questionLabelId(context: WorkContext): Promise<number | undefined> {
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

/** The question as Claude asked it: the issue title and body, minus the marker. */
function questionText(issue: Issue): string {
  return `${issue.title}\n\n${issue.body.replace(MARKER, "").trim()}`;
}
