import type { ActiveState } from "../conventions.js";
import type { Report } from "../claude/report.js";
import type { CiFailure, ReviewNote } from "../claude/prompts.js";
import type { Phase } from "../config/schema.js";
import type { Issue } from "../gitea/types.js";
import type { IssueWork, WorkPatch } from "../state/store.js";
import type { Workspace } from "../workspace/git.js";
import type { WatchedRepo } from "./repos.js";

/**
 * The engine owns slots, labels, runs and failure handling. What happens
 * between runs (opening PRs, watching CI, merging, asking the human) is a
 * Lifecycle, so the PR and question features can be built and tested on
 * their own and plugged in.
 */

export interface WorkContext {
  repo: WatchedRepo;
  /** As last read from Gitea. */
  issue: Issue;
  work: IssueWork;
}

export type WorkspaceLike = Pick<
  Workspace,
  "dir" | "prepare" | "push" | "isClean" | "commitsAhead"
>;

export interface RunDetails {
  failures?: CiFailure[];
  reviewNotes?: ReviewNote[];
  onto?: string;
}

/** What a lifecycle may do; implemented by the engine. */
export interface EngineActions {
  /** Move the issue to `state`: label first, then the store. */
  setState(context: WorkContext, state: ActiveState): Promise<WorkContext>;
  /** Record progress (PR stack, head SHA, fix attempts) for the slot holder. */
  update(context: WorkContext, patch: WorkPatch): WorkContext;
  comment(context: WorkContext, body: string): Promise<void>;
  /** Mark blocked and explain why and how to continue. */
  block(context: WorkContext, reason: string): Promise<void>;
  /** Release the repo slot and remove state labels. */
  finish(context: WorkContext, outcome: "done" | "abandoned"): Promise<void>;
  /** Start a Claude run in the background. False if no capacity right now. */
  startRun(context: WorkContext, phase: Phase, details?: RunDetails): boolean;
}

export interface Lifecycle {
  /** A run of `phase` succeeded with `report`; its commits are in `workspace`. */
  afterRun(
    context: WorkContext,
    phase: Phase,
    report: Report,
    workspace: WorkspaceLike,
    actions: EngineActions,
  ): Promise<void>;
  /** Called each poll while the issue is `in-review` and no run is going. */
  inReview(context: WorkContext, actions: EngineActions): Promise<void>;
  /** Called each poll while the issue is `blocked` and no run is going. */
  blocked(context: WorkContext, actions: EngineActions): Promise<void>;
}

/**
 * Block when a report says there is nothing to ship: Claude needs an answer,
 * or made no changes. Returns true if it blocked.
 */
export async function blockForReport(
  context: WorkContext,
  phase: Phase,
  report: Report,
  actions: EngineActions,
): Promise<boolean> {
  if (report.outcome === "needs_human") {
    const questions = report.followups
      .filter((followup) => followup.blocking)
      .map((followup) => `- **${followup.title}**\n\n  ${followup.body}`)
      .join("\n");
    await actions.block(context, `Claude needs an answer before it can continue:\n\n${questions}`);
    return true;
  }
  if (report.outcome === "no_changes" || report.branches.length === 0) {
    const what =
      phase === "implement"
        ? "Claude found nothing to change."
        : `The ${phase} round made no changes.`;
    await actions.block(context, `${what}\n\n${report.summary}`);
    return true;
  }
  return false;
}

/**
 * Minimal lifecycle: push what Claude committed and hand over for review,
 * without opening PRs. Useful for tests and for running without auto-merge.
 */
export const basicLifecycle: Lifecycle = {
  async afterRun(context, phase, report, workspace, actions) {
    if (await blockForReport(context, phase, report, actions)) return;
    const pushed = await workspace.push(
      context.issue.number,
      report.branches.map((branch) => branch.name),
    );
    const dirty = (await workspace.isClean()) ? "" : "\n\nNote: uncommitted changes were left out.";
    const next = await actions.setState(context, "in-review");
    await actions.comment(
      next,
      `Finished ${phase}. Pushed ${[...pushed.keys()].map((b) => `\`${b}\``).join(", ")}.\n\n${report.summary}${dirty}`,
    );
  },
  inReview: () => Promise.resolve(),
  blocked: () => Promise.resolve(),
};
