import type { CiFailure, ReviewNote } from "../claude/prompts.js";
import type { Report } from "../claude/report.js";
import type { Config, Phase } from "../config/schema.js";
import type { GiteaClient } from "../gitea/client.js";
import { GiteaError } from "../gitea/http.js";
import type { CombinedStatus, PullRequest } from "../gitea/types.js";
import { silentLogger, type Logger } from "../log.js";
import {
  blockForReport,
  type EngineActions,
  type Lifecycle,
  type RunDetails,
  type WorkContext,
  type WorkspaceLike,
} from "./lifecycle.js";

/**
 * From pushed branches to merged PRs. After an implement run it opens one PR
 * per reported branch (stacked when there are several). While the issue is in
 * review it watches the bottom PR of the stack each poll:
 *
 *   merged ─────────────▶ next PR in the stack, or close the issue
 *   closed, not merged ──▶ blocked
 *   `/merge` by reviewer ▶ merge now
 *   changes requested ───▶ address-review run
 *   CI green ────────────▶ merge
 *   CI red ──────────────▶ fix-ci run with the failing logs
 *   no CI at all ────────▶ wait, then blocked (REQUIRE_CI)
 *
 * Fix and review rounds share MAX_FIX_ATTEMPTS per PR; a round that pushes no
 * new commit blocks instead of looping. Merges pass the checked head SHA, so a
 * commit pushed after the check is never merged unchecked.
 */

export type PrGitea = Pick<
  GiteaClient,
  | "listPulls"
  | "createPull"
  | "getPull"
  | "retargetPull"
  | "mergePull"
  | "listPullReviews"
  | "listReviewComments"
  | "getCombinedStatus"
  | "listWorkflowRuns"
  | "listRunJobs"
  | "getJobLogs"
  | "listComments"
  | "createComment"
  | "deleteBranch"
  | "closeIssue"
>;

export interface PrLifecycleDeps {
  config: Config;
  gitea: PrGitea;
  now?: () => Date;
  log?: Logger;
}

const LOG_TAIL_LINES = 150;
const LOG_TAIL_CHARS = 12_000;
const MAX_FAILURES = 5;
const PASSING: readonly CombinedStatus["state"][] = ["success", "warning", "skipped"];
const FAILING: readonly CombinedStatus["state"][] = ["failure", "error"];

export function prLifecycle(deps: PrLifecycleDeps): Lifecycle {
  return new PrLifecycle(deps);
}

class PrLifecycle implements Lifecycle {
  private readonly config: Config;
  private readonly gitea: PrGitea;
  private readonly now: () => Date;
  private readonly log: Logger;
  /**
   * PR heads whose last merge attempt failed. Gitea can refuse a merge
   * transiently (seen live: 405 right after another merge attempt), so the
   * first failure for a head is retried next poll and only a repeat blocks.
   */
  private readonly mergeFailedFor = new Set<string>();

  constructor(deps: PrLifecycleDeps) {
    this.config = deps.config;
    this.gitea = deps.gitea;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? silentLogger;
  }

  // --- After a run ------------------------------------------------------------

  async afterRun(
    context: WorkContext,
    phase: Phase,
    report: Report,
    workspace: WorkspaceLike,
    actions: EngineActions,
  ): Promise<void> {
    if (await blockForReport(context, phase, report, actions)) return;

    const pushed = await workspace.push(
      context.issue.number,
      report.branches.map((branch) => branch.name),
    );

    if (context.work.prStack.length === 0) {
      const pulls = await this.ensurePulls(context, report);
      let next = actions.update(context, {
        prStack: pulls.map((pull) => pull.number),
        lastSha: pulls[0]?.head.sha ?? null,
        fixAttempts: 0,
      });
      next = await actions.setState(next, "in-review");
      await actions.comment(
        next,
        `Opened ${pulls.map((pull) => `#${String(pull.number)}`).join(", ")}. It merges automatically once CI passes.\n\n${report.summary}`,
      );
      return;
    }

    // A follow-up round (fix-ci, address-review) on the bottom PR.
    const bottom = await this.gitea.getPull(context.repo.ref, context.work.prStack[0] ?? 0);
    const head = pushed.get(bottom.head.ref);
    if (head === undefined || head === context.work.lastSha) {
      await actions.block(
        context,
        `The ${phase} round on #${String(bottom.number)} made no new commits, so it would only repeat itself.`,
      );
      return;
    }
    actions.update(context, { lastSha: head });
    await this.gitea.createComment(
      context.repo.ref,
      bottom.number,
      `Pushed ${head.slice(0, 7)} (${phase}, round ${String(context.work.fixAttempts)} of ${String(this.config.maxFixAttempts)}).\n\n${report.summary}`,
    );
  }

  /** Open (or reuse) one PR per branch, each based on the one below it. */
  private async ensurePulls(context: WorkContext, report: Report): Promise<PullRequest[]> {
    const { repo } = context;
    const open = await this.gitea.listPulls(repo.ref, { state: "open" });
    const pulls: PullRequest[] = [];
    for (const [index, branch] of report.branches.entries()) {
      const base = index === 0 ? repo.defaultBranch : (report.branches[index - 1]?.name ?? "");
      const existing = open.find((pull) => pull.head.ref === branch.name);
      if (existing) {
        pulls.push(
          existing.base.ref === base
            ? existing
            : await this.gitea.retargetPull(repo.ref, existing.number, base),
        );
        continue;
      }
      pulls.push(
        await this.gitea.createPull(repo.ref, {
          head: branch.name,
          base,
          title: branch.title,
          body: pullBody(context, report, index),
        }),
      );
    }
    return pulls;
  }

  // --- While in review --------------------------------------------------------

  async inReview(context: WorkContext, actions: EngineActions): Promise<void> {
    const number = context.work.prStack[0];
    if (number === undefined) {
      await actions.block(context, "No pull request is open for this issue.");
      return;
    }
    const pull = await this.gitea.getPull(context.repo.ref, number);
    if (pull.merged) {
      await this.afterMerge(context, pull, actions);
      return;
    }
    if (pull.state === "closed") {
      await actions.block(context, `#${String(pull.number)} was closed without being merged.`);
      return;
    }
    // Someone (or a previous round) pushed: track the head so CI timing is right.
    const current =
      pull.head.sha === context.work.lastSha
        ? context
        : actions.update(context, { lastSha: pull.head.sha });

    if (await this.mergeRequested(current, pull)) {
      await this.merge(current, pull, actions);
      return;
    }
    const notes = await this.changesRequested(current, pull);
    if (notes.length > 0) {
      await this.fixRound(current, pull, actions, "address-review", { reviewNotes: notes });
      return;
    }

    const status = await this.gitea.getCombinedStatus(context.repo.ref, pull.head.sha);
    if ((status.statuses ?? []).length === 0) {
      await this.withoutCi(current, pull, actions);
    } else if (PASSING.includes(status.state)) {
      await this.merge(current, pull, actions);
    } else if (FAILING.includes(status.state)) {
      const failures = await this.ciFailures(current, pull, status);
      await this.fixRound(current, pull, actions, "fix-ci", { failures });
    }
    // Otherwise CI is pending; check again next poll.
  }

  private async withoutCi(
    context: WorkContext,
    pull: PullRequest,
    actions: EngineActions,
  ): Promise<void> {
    if (!this.config.requireCi) {
      await this.merge(context, pull, actions);
      return;
    }
    const since = Date.parse(context.work.headSince ?? context.work.updatedAt);
    const waitedMin = (this.now().getTime() - since) / 60_000;
    if (waitedMin < this.config.ciNoStatusTimeoutMin) return;
    await actions.block(
      context,
      `No CI status was reported for ${pull.head.sha.slice(0, 7)} on #${String(pull.number)} after ${String(this.config.ciNoStatusTimeoutMin)} minutes, and REQUIRE_CI keeps it from merging without one. Check the repo's CI, or comment \`/merge\` on #${String(pull.number)} to merge anyway.`,
    );
  }

  private async fixRound(
    context: WorkContext,
    pull: PullRequest,
    actions: EngineActions,
    phase: "fix-ci" | "address-review",
    details: RunDetails,
  ): Promise<void> {
    const attempts = context.work.fixAttempts;
    const max = this.config.maxFixAttempts;
    if (attempts >= max) {
      const what = phase === "fix-ci" ? "CI is still failing" : "Review feedback is still open";
      await actions.block(
        context,
        `${what} on #${String(pull.number)} after ${String(max)} rounds. Comment \`/merge\` on #${String(pull.number)} to merge anyway.`,
      );
      return;
    }
    const next = actions.update(context, { fixAttempts: attempts + 1 });
    if (!actions.startRun(next, phase, details)) {
      // No capacity right now; undo so the round isn't counted, try next poll.
      actions.update(context, { fixAttempts: attempts });
    }
  }

  /** Blocked issues wait for a human; answering questions comes with question issues. */
  blocked(): Promise<void> {
    return Promise.resolve();
  }

  // --- Merging ----------------------------------------------------------------

  private async merge(
    context: WorkContext,
    pull: PullRequest,
    actions: EngineActions,
  ): Promise<void> {
    if (!pull.mergeable) {
      await actions.block(
        context,
        `#${String(pull.number)} can't be merged automatically (it conflicts with \`${pull.base.ref}\`).`,
      );
      return;
    }
    const stacked = context.work.prStack.length > 1;
    try {
      await this.gitea.mergePull(context.repo.ref, pull.number, {
        style: context.repo.mergeStyle,
        headCommitId: pull.head.sha,
        // In a stack the next PR still targets this branch; retarget it first.
        deleteBranch: !stacked,
      });
    } catch (error) {
      if (!(error instanceof GiteaError)) throw error;
      const key = `${context.repo.fullName}#${String(pull.number)}@${pull.head.sha}`;
      if (!this.mergeFailedFor.has(key)) {
        this.mergeFailedFor.add(key);
        this.log.warn("merge refused; retrying next poll", {
          repo: context.repo.fullName,
          pull: pull.number,
          status: error.status,
          detail: error.detail,
        });
        return;
      }
      this.mergeFailedFor.delete(key);
      await actions.block(context, `Merging #${String(pull.number)} failed: ${error.detail}`);
      return;
    }
    this.log.info("merged", { repo: context.repo.fullName, pull: pull.number });
    await this.afterMerge(context, { ...pull, merged: true }, actions);
  }

  private async afterMerge(
    context: WorkContext,
    pull: PullRequest,
    actions: EngineActions,
  ): Promise<void> {
    const { repo } = context;
    const rest = context.work.prStack.slice(1);
    const next = rest[0];
    if (next !== undefined) {
      const retargeted = await this.gitea.retargetPull(repo.ref, next, repo.defaultBranch);
      await this.gitea.deleteBranch(repo.ref, pull.head.ref).catch((error: unknown) => {
        this.log.warn("could not delete merged branch", { branch: pull.head.ref, error });
      });
      const updated = actions.update(context, {
        prStack: rest,
        fixAttempts: 0,
        lastSha: retargeted.head.sha,
      });
      await actions.comment(
        updated,
        `Merged #${String(pull.number)}. Next in the stack: #${String(next)}, now targeting \`${repo.defaultBranch}\`.`,
      );
      return;
    }
    // Close before releasing: if we crash in between, the issue can't be
    // picked up and redone.
    await actions.comment(context, `Merged #${String(pull.number)}. Done.`);
    if (context.issue.state === "open") {
      await this.gitea.closeIssue(repo.ref, context.issue.number);
    }
    await actions.finish(context, "done");
  }

  // --- Signals from humans and CI ---------------------------------------------

  /** A `/merge` line from the human reviewer on the PR. */
  private async mergeRequested(context: WorkContext, pull: PullRequest): Promise<boolean> {
    const comments = await this.gitea.listComments(context.repo.ref, pull.number);
    return comments.some(
      (comment) =>
        comment.user.login === this.config.humanReviewer && /^\s*\/merge\s*$/m.test(comment.body),
    );
  }

  /** Change requests on the current head, as notes for an address-review round. */
  private async changesRequested(context: WorkContext, pull: PullRequest): Promise<ReviewNote[]> {
    const reviews = await this.gitea.listPullReviews(context.repo.ref, pull.number);
    const active = reviews.filter(
      (review) =>
        review.state === "REQUEST_CHANGES" &&
        !review.dismissed &&
        !review.stale &&
        review.commit_id === pull.head.sha &&
        review.user?.login !== this.config.gitea.botUsername,
    );
    const notes: ReviewNote[] = [];
    for (const review of active) {
      const author = review.user?.login ?? "reviewer";
      if (review.body.trim() !== "") notes.push({ author, body: review.body });
      const comments = await this.gitea.listReviewComments(
        context.repo.ref,
        pull.number,
        review.id,
      );
      for (const comment of comments) {
        notes.push({ author: comment.user.login, body: comment.body, path: comment.path });
      }
    }
    return notes;
  }

  /** Failing Actions jobs with their log tails; plain commit statuses as a fallback. */
  private async ciFailures(
    context: WorkContext,
    pull: PullRequest,
    status: CombinedStatus,
  ): Promise<CiFailure[]> {
    const failures: CiFailure[] = [];
    const runs = await this.gitea.listWorkflowRuns(context.repo.ref, { headSha: pull.head.sha });
    for (const run of runs.filter((r) => r.conclusion === "failure")) {
      const jobs = await this.gitea.listRunJobs(context.repo.ref, run.id);
      for (const job of jobs.filter((j) => j.conclusion === "failure")) {
        const logs = await this.gitea.getJobLogs(context.repo.ref, job.id).catch(() => "");
        failures.push({ name: job.name, url: job.html_url, logTail: logTail(logs) });
      }
    }
    if (failures.length === 0) {
      for (const failed of (status.statuses ?? []).filter((s) => FAILING.includes(s.status))) {
        failures.push({
          name: failed.context,
          url: failed.target_url,
          logTail: failed.description,
        });
      }
    }
    return failures.slice(0, MAX_FAILURES);
  }
}

function pullBody(context: WorkContext, report: Report, index: number): string {
  const branch = report.branches[index];
  const total = report.branches.length;
  const issue = `#${String(context.issue.number)}`;
  const decisions = report.decisions.map(
    (d) =>
      `- **${d.question}** → ${d.chosen}. ${d.rationale}${d.alternatives.length > 0 ? ` (Alternatives: ${d.alternatives.join(", ")}.)` : ""}${d.needsConfirmation ? " _Needs confirmation._" : ""}`,
  );
  // Only the top PR closes the issue; earlier ones merge first.
  const link =
    index === total - 1
      ? `Closes ${issue}`
      : `Part of ${issue} (${String(index + 1)} of ${String(total)} in a stack).`;
  return [
    branch?.body ?? "",
    decisions.length > 0 ? `## Decisions\n\n${decisions.join("\n")}` : "",
    link,
    "---\nOpened by claude-dispatcher. Merges automatically when CI passes.",
  ]
    .filter((part) => part.trim() !== "")
    .join("\n\n");
}

/** The end of a job log, without per-line timestamps or color codes. */
export function logTail(log: string): string {
  const lines = log
    .split("\n")
    .map((line) =>
      line
        .replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, "")
        // eslint-disable-next-line no-control-regex
        .replace(/\u001b\[[0-9;]*m/g, ""),
    )
    .slice(-LOG_TAIL_LINES)
    .join("\n");
  return lines.length > LOG_TAIL_CHARS ? lines.slice(-LOG_TAIL_CHARS) : lines;
}
