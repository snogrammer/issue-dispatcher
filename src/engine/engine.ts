import { randomUUID } from "node:crypto";

import { buildPrompt, systemRules, type PromptContext } from "../claude/prompts.js";
import type { ClaudeRunResult, RunRequest } from "../claude/runner.js";
import type { Config, Phase } from "../config/schema.js";
import {
  ACTIVE_STATES,
  branchName,
  stateFromLabels,
  stateLabel,
  type ActiveState,
} from "../conventions.js";
import type { GiteaClient } from "../gitea/client.js";
import { isNotFound } from "../gitea/http.js";
import type { Issue, Label } from "../gitea/types.js";
import { dispatcherLabels, ensureLabels } from "../labels.js";
import { silentLogger, type Logger } from "../log.js";
import { routeFor } from "../routing.js";
import { rebuildFromGitea } from "../state/rebuild.js";
import type { RunExit, StateStore } from "../state/store.js";
import {
  basicLifecycle,
  type EngineActions,
  type Lifecycle,
  type RunDetails,
  type WorkContext,
  type WorkspaceLike,
} from "./lifecycle.js";
import { KeyedLock } from "./lock.js";
import { orderCandidates } from "./pickup.js";
import { resolveRepos, type WatchedRepo } from "./repos.js";

/**
 * The dispatcher's main loop. Every poll it walks the watched repos; each
 * repo holds at most one issue:
 *
 *   free ──pick──▶ working ──run ok──▶ in-review ──(lifecycle)──▶ done ──▶ free
 *                     │                    │
 *                     └──run failed──▶ blocked ◀──(lifecycle)──┘
 *
 * Gitea labels are the source of truth; the store mirrors them and keeps what
 * Gitea can't (sessions, counters). Ordering rules that keep a crash or a
 * concurrent rebuild from losing work: label in Gitea before claiming the
 * slot, release the slot before removing labels, add a new state label before
 * removing the old one.
 *
 * Humans steer with assignment and labels: unassigning the bot or closing the
 * issue stops work (PRs stay open); removing the state label releases the
 * slot so the issue is picked up again from scratch.
 */

export type EngineGitea = Pick<
  GiteaClient,
  | "getCurrentUser"
  | "getRepo"
  | "listOrgRepos"
  | "listIssues"
  | "getIssue"
  | "listComments"
  | "createComment"
  | "listDependencies"
  | "listLabels"
  | "createLabel"
  | "addLabels"
  | "removeLabel"
  | "listPulls"
>;

export interface EngineDeps {
  config: Config;
  gitea: EngineGitea;
  store: StateStore;
  workspace: (repo: WatchedRepo) => WorkspaceLike;
  runClaude: (request: RunRequest) => Promise<ClaudeRunResult>;
  lifecycle?: Lifecycle;
  log?: Logger;
  now?: () => Date;
  newSessionId?: () => string;
}

interface InFlight {
  phase: Phase;
  controller: AbortController;
  /** Set when work was stopped; the run's result is then ignored. */
  cancelled: boolean;
  done: Promise<void>;
}

const REPO_REFRESH_MS = 5 * 60_000;
const DEFAULT_PAUSE_MS = 30 * 60_000;

export class Engine {
  private readonly config: Config;
  private readonly gitea: EngineGitea;
  private readonly store: StateStore;
  private readonly lifecycle: Lifecycle;
  private readonly log: Logger;
  private readonly now: () => Date;
  private readonly newSessionId: () => string;
  private readonly lock = new KeyedLock();
  private readonly inFlight = new Map<string, InFlight>();
  private readonly labelled = new Set<string>();
  private repos: WatchedRepo[] = [];
  private reposRefreshedAt = Number.NEGATIVE_INFINITY;
  private stopping = false;
  private timer: NodeJS.Timeout | undefined;
  private currentTick: Promise<void> = Promise.resolve();

  constructor(private readonly deps: EngineDeps) {
    this.config = deps.config;
    this.gitea = deps.gitea;
    this.store = deps.store;
    this.lifecycle = deps.lifecycle ?? basicLifecycle;
    this.log = deps.log ?? silentLogger;
    this.now = deps.now ?? (() => new Date());
    this.newSessionId = deps.newSessionId ?? randomUUID;
  }

  /** Number of Claude runs in progress. */
  get running(): number {
    return this.inFlight.size;
  }

  watchedRepos(): readonly WatchedRepo[] {
    return this.repos;
  }

  /** Discover repos, bootstrap labels, rebuild state from Gitea, start polling. */
  async start(): Promise<void> {
    const tokenOwner = (await this.gitea.getCurrentUser()).login;
    if (tokenOwner !== this.config.gitea.botUsername) {
      this.log.warn(
        "GITEA_TOKEN does not belong to BOT_USERNAME; comments, labels and pushes will be attributed to the token owner",
        {
          tokenOwner,
          botUsername: this.config.gitea.botUsername,
        },
      );
    }
    await this.refreshRepos();
    const report = await rebuildFromGitea(this.store, this.gitea, {
      repos: this.repos.map((repo) => repo.ref),
      botUsername: this.config.gitea.botUsername,
      labelPrefix: this.config.labelPrefix,
    });
    this.log.info("state rebuilt from Gitea", { ...report });
    for (const conflict of report.conflicts) {
      this.log.warn("several issues carry state labels; working on the oldest", { ...conflict });
    }
    this.schedule(0);
  }

  /**
   * Stop polling and abort running sessions. Their issues keep their state
   * and session IDs, so the next start resumes them.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    await this.currentTick;
    for (const run of this.inFlight.values()) run.controller.abort();
    await Promise.all([...this.inFlight.values()].map((run) => run.done));
  }

  /** One pass over every watched repo. Public for tests and manual runs. */
  async tick(): Promise<void> {
    try {
      await this.refreshRepos();
    } catch (error) {
      this.log.error("repo discovery failed; using the previous list", { error });
    }
    for (const repo of this.repos) {
      if (this.stopping) return;
      try {
        await this.lock.run(repo.fullName, () => this.reconcile(repo));
      } catch (error) {
        this.log.error("reconcile failed", { repo: repo.fullName, error });
      }
    }
  }

  /** Wait for every run in progress to finish (tests). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight.values()].map((run) => run.done));
    }
  }

  // --- Polling --------------------------------------------------------------

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.currentTick = this.tick().finally(() => {
        this.schedule(this.config.pollIntervalS * 1000);
      });
    }, delayMs);
  }

  private async refreshRepos(): Promise<void> {
    if (this.now().getTime() - this.reposRefreshedAt < REPO_REFRESH_MS) return;
    const { repos, skipped } = await resolveRepos(this.config, this.gitea);
    for (const skip of skipped) this.log.warn("not watching repo", skip);
    for (const repo of repos) {
      if (this.labelled.has(repo.fullName)) continue;
      const result = await ensureLabels(this.gitea, repo.ref, dispatcherLabels(this.config));
      if (result.created.length > 0) {
        this.log.info("created labels", { repo: repo.fullName, labels: result.created });
      }
      this.labelled.add(repo.fullName);
    }
    this.repos = repos;
    this.reposRefreshedAt = this.now().getTime();
  }

  // --- Per-repo reconcile ---------------------------------------------------

  private async reconcile(repo: WatchedRepo): Promise<void> {
    const held = this.store.activeIssue(repo.fullName);
    if (held !== null) {
      await this.reconcileActive(repo, held);
      return;
    }
    if (!this.hasCapacity()) return;
    const next = await this.pickNext(repo);
    if (next) await this.begin(repo, next);
  }

  private async reconcileActive(repo: WatchedRepo, number: number): Promise<void> {
    const issue = await this.fetchIssue(repo, number);
    if (issue === undefined || issue.state === "closed") {
      await this.stopWork(repo, number, issue, "the issue was closed");
      return;
    }
    if (!this.isAssigned(issue)) {
      await this.stopWork(repo, number, issue, `${this.config.gitea.botUsername} was unassigned`);
      return;
    }

    const state = stateFromLabels(this.config.labelPrefix, labelNames(issue.labels));
    if (state === undefined) {
      // A human removed the state label: let go so the issue is picked up fresh.
      this.cancelRun(repo.fullName);
      this.store.release(repo.fullName, "abandoned");
      this.log.info("state label removed; released slot", { repo: repo.fullName, issue: number });
      return;
    }

    let work = this.store.getWork(repo.fullName, number);
    if (work === undefined) return;
    if (work.state !== state) work = this.store.updateWork(repo.fullName, number, { state });
    if (this.inFlight.has(repo.fullName)) return;

    const context: WorkContext = { repo, issue, work };
    const actions = this.actions();
    switch (state) {
      case "working":
        // Nothing running means the dispatcher restarted mid-run, or a rate
        // limit or capacity check deferred it: (re)start the implement run.
        this.startRun(context, "implement");
        return;
      case "in-review":
        await this.lifecycle.inReview(context, actions);
        return;
      case "blocked":
        await this.lifecycle.blocked(context, actions);
        return;
    }
  }

  private async pickNext(repo: WatchedRepo): Promise<Issue | undefined> {
    const assigned = (
      await this.gitea.listIssues(repo.ref, { assignee: this.config.gitea.botUsername })
    ).filter((issue) => this.isAssigned(issue));
    for (const issue of orderCandidates(assigned, this.config.labelPrefix)) {
      const blockers = await this.gitea.listDependencies(repo.ref, issue.number);
      if (blockers.some((blocker) => blocker.state === "open")) continue;
      return issue;
    }
    return undefined;
  }

  private async begin(repo: WatchedRepo, issue: Issue): Promise<void> {
    const branch = branchName(this.config.labelPrefix, issue.number, issue.title);
    // Label in Gitea first, so a crash between the two leaves a rebuildable trail.
    const labels = await this.gitea.addLabels(repo.ref, issue.number, [
      stateLabel(this.config.labelPrefix, "working"),
    ]);
    const work = this.store.claim(repo.fullName, issue.number, { state: "working", branch });
    const context: WorkContext = { repo, issue: { ...issue, labels }, work };
    this.log.info("picked up issue", { repo: repo.fullName, issue: issue.number, branch });
    await this.gitea.createComment(
      repo.ref,
      issue.number,
      `Picked up by ${this.config.gitea.botUsername}. Working on \`${branch}\`.`,
    );
    this.startRun(context, "implement");
  }

  private async stopWork(
    repo: WatchedRepo,
    number: number,
    issue: Issue | undefined,
    reason: string,
  ): Promise<void> {
    this.cancelRun(repo.fullName);
    // Release locally before touching labels (see ordering rules above).
    this.store.release(repo.fullName, "abandoned");
    this.log.info("stopped work", { repo: repo.fullName, issue: number, reason });
    if (issue === undefined) return;
    await this.removeStateLabels(repo, issue.number, issue.labels);
    await this.gitea.createComment(
      repo.ref,
      issue.number,
      `Stopped: ${reason}. Any open PRs were left as they are.`,
    );
  }

  // --- Runs -----------------------------------------------------------------

  private hasCapacity(): boolean {
    return (
      !this.stopping && !this.isPaused() && this.inFlight.size < this.config.maxConcurrentSessions
    );
  }

  private isPaused(): boolean {
    const { pausedUntil } = this.store.getGovernor();
    if (pausedUntil === null) return false;
    if (pausedUntil.getTime() > this.now().getTime()) return true;
    this.store.setGovernor({ pausedUntil: null });
    this.log.info("rate-limit pause over; resuming");
    return false;
  }

  private startRun(context: WorkContext, phase: Phase, details: RunDetails = {}): boolean {
    const name = context.repo.fullName;
    if (!this.hasCapacity() || this.inFlight.has(name)) return false;

    // Record the session before running, so a crash mid-run can resume it.
    const resume = context.work.sessionId !== null;
    const sessionId = context.work.sessionId ?? this.newSessionId();
    if (!resume) this.store.updateWork(name, context.issue.number, { sessionId });

    const run: InFlight = {
      phase,
      controller: new AbortController(),
      cancelled: false,
      done: Promise.resolve(),
    };
    this.inFlight.set(name, run);
    run.done = this.executeRun(context, phase, details, sessionId, resume, run)
      .catch((error: unknown) => {
        this.log.error("run handling failed", { repo: name, issue: context.issue.number, error });
      })
      .finally(() => {
        if (this.inFlight.get(name) === run) this.inFlight.delete(name);
      });
    return true;
  }

  private cancelRun(name: string): void {
    const run = this.inFlight.get(name);
    if (!run) return;
    run.cancelled = true;
    run.controller.abort();
  }

  private async executeRun(
    context: WorkContext,
    phase: Phase,
    details: RunDetails,
    sessionId: string,
    resume: boolean,
    run: InFlight,
  ): Promise<void> {
    const { repo, issue } = context;
    const name = repo.fullName;
    const workspace = this.deps.workspace(repo);
    const branch =
      context.work.branch ?? branchName(this.config.labelPrefix, issue.number, issue.title);
    const route = routeFor(this.config.routing, phase, name);
    const log = this.log.child({ repo: name, issue: issue.number, phase });

    let result: ClaudeRunResult;
    const runId = this.store.startRun({
      repo: name,
      issue: issue.number,
      phase,
      model: route.model,
      effort: route.effort,
      maxTurns: route.maxTurns,
      sessionId,
    });
    try {
      await workspace.prepare(branch, repo.defaultBranch);
      const prompt: PromptContext = {
        issue: {
          repo: name,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          comments: await this.humanComments(context),
        },
        branch,
        baseBranch: repo.defaultBranch,
      };
      log.info("run started", { model: route.model, effort: route.effort, resume });
      result = await this.deps.runClaude({
        phase,
        issue: issue.number,
        cwd: workspace.dir,
        prompt: buildPrompt(phase, prompt, details),
        systemPrompt: systemRules(prompt),
        route,
        ...(resume ? { resumeSessionId: sessionId } : { sessionId }),
        signal: run.controller.signal,
      });
    } catch (error) {
      result = {
        kind: "error",
        sessionId,
        stderrTail: "",
        error: `could not prepare the run: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    this.store.finishRun(runId, {
      exit: runExit(result),
      sessionId: result.sessionId,
      costUsd: result.costUsd,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      error: result.error,
    });
    log.info("run finished", { kind: result.kind, costUsd: result.costUsd, error: result.error });

    await this.lock.run(name, async () => {
      if (run.cancelled || this.stopping) return;
      const work = this.store.getWork(name, issue.number);
      if (work === undefined || this.store.activeIssue(name) !== issue.number) return;
      await this.handleResult({ repo, issue, work }, phase, result, workspace);
    });
  }

  private async handleResult(
    context: WorkContext,
    phase: Phase,
    result: ClaudeRunResult,
    workspace: WorkspaceLike,
  ): Promise<void> {
    const name = context.repo.fullName;
    switch (result.kind) {
      case "success":
        if (result.report) {
          await this.lifecycle.afterRun(context, phase, result.report, workspace, this.actions());
        }
        return;
      case "aborted":
        return;
      case "rate_limited": {
        const resetsAt = result.rateLimit?.resetsAt;
        const until =
          resetsAt && resetsAt.getTime() > this.now().getTime()
            ? resetsAt
            : new Date(this.now().getTime() + DEFAULT_PAUSE_MS);
        this.store.setGovernor({ pausedUntil: until });
        this.log.warn("rate limited; pausing all new runs", { until: until.toISOString() });
        return; // State and session are kept; the run resumes after the pause.
      }
      case "session_not_found":
        // The session never got created (or was lost); start a fresh one next poll.
        this.store.updateWork(name, context.issue.number, { sessionId: null });
        this.log.warn("session to resume not found; next run starts a new one", {
          repo: name,
          issue: context.issue.number,
        });
        return;
      default:
        await this.actions().block(
          context,
          `The ${phase} run failed (${result.kind}): ${result.error ?? "no details"}`,
        );
    }
  }

  // --- Actions for lifecycles -------------------------------------------------

  private actions(): EngineActions {
    return {
      setState: (context, state) => this.setState(context, state),
      comment: async (context, body) => {
        await this.gitea.createComment(context.repo.ref, context.issue.number, body);
      },
      block: async (context, reason) => {
        const next = await this.setState(context, "blocked");
        await this.gitea.createComment(
          next.repo.ref,
          next.issue.number,
          `${reason}\n\nTo retry from scratch, remove the \`${stateLabel(this.config.labelPrefix, "blocked")}\` label. To drop the issue, unassign ${this.config.gitea.botUsername}.`,
        );
      },
      finish: async (context, outcome) => {
        this.store.release(context.repo.fullName, outcome);
        await this.removeStateLabels(context.repo, context.issue.number, context.issue.labels);
      },
      startRun: (context, phase, details) => this.startRun(context, phase, details),
    };
  }

  private async setState(context: WorkContext, state: ActiveState): Promise<WorkContext> {
    const { repo, issue } = context;
    // Add the new label before removing the old ones, so the issue is never unlabeled.
    const labels = await this.gitea.addLabels(repo.ref, issue.number, [
      stateLabel(this.config.labelPrefix, state),
    ]);
    const others = labels.filter((label) =>
      ACTIVE_STATES.some(
        (other) => other !== state && label.name === stateLabel(this.config.labelPrefix, other),
      ),
    );
    for (const label of others) await this.gitea.removeLabel(repo.ref, issue.number, label.id);
    const work = this.store.updateWork(repo.fullName, issue.number, { state });
    return {
      repo,
      issue: { ...issue, labels: labels.filter((label) => !others.includes(label)) },
      work,
    };
  }

  private async removeStateLabels(
    repo: WatchedRepo,
    number: number,
    labels: Label[],
  ): Promise<void> {
    const names = new Set(ACTIVE_STATES.map((state) => stateLabel(this.config.labelPrefix, state)));
    for (const label of labels.filter((l) => names.has(l.name))) {
      await this.gitea.removeLabel(repo.ref, number, label.id);
    }
  }

  // --- Helpers --------------------------------------------------------------

  private async fetchIssue(repo: WatchedRepo, number: number): Promise<Issue | undefined> {
    try {
      return await this.gitea.getIssue(repo.ref, number);
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  private isAssigned(issue: Issue): boolean {
    return (issue.assignees ?? []).some((user) => user.login === this.config.gitea.botUsername);
  }

  private async humanComments(context: WorkContext): Promise<{ author: string; body: string }[]> {
    const comments = await this.gitea.listComments(context.repo.ref, context.issue.number);
    return comments
      .filter((comment) => comment.user.login !== this.config.gitea.botUsername)
      .map((comment) => ({ author: comment.user.login, body: comment.body }));
  }
}

function labelNames(labels: Label[]): string[] {
  return labels.map((label) => label.name);
}

function runExit(result: ClaudeRunResult): RunExit {
  switch (result.kind) {
    case "success":
    case "timeout":
    case "aborted":
    case "rate_limited":
      return result.kind;
    default:
      return "error";
  }
}
