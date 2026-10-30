import type { CiFailure, ReviewNote } from "../claude/prompts.js";
import type { Report } from "../claude/report.js";
import type { Config, Phase } from "../config/schema.js";
import type { GiteaClient } from "../gitea/client.js";
import { GiteaError } from "../gitea/http.js";
import type { CombinedStatus, PullRequest, WorkflowRun } from "../gitea/types.js";
import { silentLogger, type Logger } from "../log.js";
import {
  blockForReport,
  type EngineActions,
  type Lifecycle,
  type RunDetails,
  type WorkContext,
  type WorkspaceLike,
} from "./lifecycle.js";
import type { Escalation } from "./questions.js";

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
 *   CI red ──────────────▶ fix-ci run with the failing logs (once all runs finish)
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
      // From here on runs work on the bottom PR's branch, whatever Claude named it.
      let next = actions.update(context, {
        prStack: pulls.map((pull) => pull.number),
        branch: pulls[0]?.head.ref ?? context.work.branch,
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
    if (head === undefined) {
      await actions.block(
        context,
        `The ${phase} round on #${String(bottom.number)} didn't report its branch \`${bottom.head.ref}\`, so nothing was pushed to the PR.`,
      );
      return;
    }
    if (head === context.work.lastSha) {
      await actions.block(
        context,
        `The ${phase} round on #${String(bottom.number)} made no new commits, so it would only repeat itself.`,
      );
      return;
    }
    actions.update(context, {
      lastSha: head,
      ...(phase === "rebase" ? { rebaseFrom: null } : {}),
    });
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
    if (context.work.rebaseFrom !== null) {
      await this.rebaseStack(context, pull, actions);
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

    // A PR handed to the bot is often stuck on a conflict; CI may not even run on one.
    if (context.issue.pull_request !== null && !pull.mergeable) {
      await this.fixRound(current, pull, actions, "rebase", { onto: pull.base.ref });
      return;
    }

    const status = await this.gitea.getCombinedStatus(context.repo.ref, pull.head.sha);
    if ((status.statuses ?? []).length === 0) {
      await this.withoutCi(current, pull, actions);
    } else if (PASSING.includes(status.state)) {
      await this.merge(current, pull, actions);
    } else if (FAILING.includes(status.state)) {
      // Gitea reports failure as soon as one job fails. Wait for the rest, so
      // one round sees every failure instead of chasing them one at a time.
      const runs = await this.gitea.listWorkflowRuns(context.repo.ref, { headSha: pull.head.sha });
      if (runs.some((run) => run.status !== "completed")) return;
      const failures = await this.ciFailures(current, runs, status);
      await this.fixRound(current, pull, actions, "fix-ci", { failures });
    }
    // Otherwise CI is pending; check again next poll.
  }

  private async withoutCi(
    context: WorkContext,
    pull: PullRequest,
    actions: EngineActions,
  ): Promise<void> {
    // A run may exist before Gitea posts its commit status: that's pending, not "no CI".
    const runs = await this.gitea.listWorkflowRuns(context.repo.ref, { headSha: pull.head.sha });
    if (runs.some((run) => run.status !== "completed")) return;
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
    phase: "fix-ci" | "address-review" | "rebase",
    details: RunDetails,
  ): Promise<void> {
    const attempts = context.work.fixAttempts;
    const max = this.config.maxFixAttempts;
    if (attempts >= max) {
      await actions.escalate(context, escalation(context, pull, phase, details, max));
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

  /**
   * The PR below `pull` in the stack merged; `rebaseFrom` is its head. Replay
   * this branch's own commits onto the default branch: mechanically when it
   * applies cleanly, otherwise as a Claude rebase round (whose conflicts can
   * still end in a question for the human). Either way the push uses a lease.
   */
  private async rebaseStack(
    context: WorkContext,
    pull: PullRequest,
    actions: EngineActions,
  ): Promise<void> {
    const upstream = context.work.rebaseFrom;
    if (upstream === null) return;
    const { repo } = context;
    const branch = pull.head.ref;
    const workspace = actions.workspace(context);
    await workspace.prepare(branch, repo.defaultBranch);

    if (!(await workspace.isAncestor(upstream, branch))) {
      // Already rebased (e.g. by an earlier round before a restart).
      actions.update(context, { rebaseFrom: null });
      return;
    }
    if ((await workspace.rebaseOnto(branch, repo.defaultBranch, upstream)) === "rebased") {
      const head = (await workspace.push(context.issue.number, [branch])).get(branch) ?? null;
      actions.update(context, { rebaseFrom: null, lastSha: head });
      await this.gitea.createComment(
        repo.ref,
        pull.number,
        `Rebased onto \`${repo.defaultBranch}\` now that the PR below it merged.`,
      );
      return;
    }
    await this.fixRound(context, pull, actions, "rebase", {
      onto: repo.defaultBranch,
      upstream,
    });
  }

  // --- Merging ----------------------------------------------------------------

  private async merge(
    context: WorkContext,
    pull: PullRequest,
    actions: EngineActions,
  ): Promise<void> {
    if (!pull.mergeable) {
      // The base moved under the PR: let Claude rebase and resolve, as a round.
      await this.fixRound(context, pull, actions, "rebase", { onto: pull.base.ref });
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
      // Recorded first, so the rebase still happens after a restart or a wait.
      const updated = actions.update(context, {
        prStack: rest,
        branch: retargeted.head.ref,
        fixAttempts: 0,
        lastSha: retargeted.head.sha,
        rebaseFrom: pull.head.sha,
      });
      await actions.comment(
        updated,
        `Merged #${String(pull.number)}. Next in the stack: #${String(next)}, now targeting \`${repo.defaultBranch}\`.`,
      );
      await this.rebaseStack(updated, retargeted, actions);
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
    runs: WorkflowRun[],
    status: CombinedStatus,
  ): Promise<CiFailure[]> {
    const failures: CiFailure[] = [];
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

/**
 * The ticket filed for the human when a PR's fix rounds run out: what keeps
 * failing, and how to answer. One per PR head, so a new push that fails again
 * gets its own ticket.
 */
function escalation(
  context: WorkContext,
  pull: PullRequest,
  phase: "fix-ci" | "address-review" | "rebase",
  details: RunDetails,
  rounds: number,
): Escalation {
  const pr = `#${String(pull.number)}`;
  const what = {
    "fix-ci": `CI is still failing on ${pr}`,
    "address-review": `Review feedback is still open on ${pr}`,
    rebase: `${pr} still conflicts with \`${details.onto ?? pull.base.ref}\``,
  }[phase];
  const failures = (details.failures ?? []).map(
    (failure) => `- ${failure.url ? `[${failure.name}](${failure.url})` : failure.name}`,
  );
  return {
    key: `${phase}:${String(pull.number)}:${pull.head.sha}`,
    title: `Help needed on #${String(context.issue.number)}: ${what} after ${String(rounds)} rounds`,
    body: [
      `While working on #${String(context.issue.number)} (${context.issue.title}), ${what.charAt(0).toLowerCase()}${what.slice(1)} after ${String(rounds)} automatic rounds (head ${pull.head.sha.slice(0, 7)}), so the dispatcher stopped instead of guessing again.`,
      failures.length > 0 ? `Failing jobs:\n\n${failures.join("\n")}` : "",
      `What happens next:\n\n- Reply here with what should change; Claude continues on ${pr} with your answer and gets ${String(rounds)} fresh rounds.\n- Close this issue to let Claude try again as it sees fit.\n- To ship ${pr} as it is, merge it yourself, then close this issue and #${String(context.issue.number)}.`,
    ]
      .filter((part) => part !== "")
      .join("\n\n"),
  };
}

/** Drop "Closes #N"-style references to this issue; the dispatcher owns the link. */
function stripClosingRefs(body: string, issueNumber: number): string {
  const pattern = new RegExp(
    `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\b:?[ \\t]+#${String(issueNumber)}(?!\\d)[.,;]?`,
    "gi",
  );
  return body
    .replace(pattern, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
    stripClosingRefs(branch?.body ?? "", context.issue.number),
    decisions.length > 0 ? `## Decisions\n\n${decisions.join("\n")}` : "",
    link,
    "---\nOpened by IssueDispatcher. Merges automatically when CI passes.",
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
