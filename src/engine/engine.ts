import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import { buildPrompt, systemRules, type PromptContext } from "../claude/prompts.js";
import type { ClaudeRunResult, RunRequest } from "../claude/runner.js";
import type { Report } from "../claude/report.js";
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
import type { Issue, Label, RepoRef } from "../gitea/types.js";
import { dispatcherLabels, ensureLabels } from "../labels.js";
import { silentLogger, type Logger } from "../log.js";
import { resolveRoute } from "../routing.js";
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
import { CiQueue } from "./ci-queue.js";
import { Governor, type Observation } from "./governor.js";
import { KeyedLock } from "./lock.js";
import { orderCandidates } from "./pickup.js";
import { QuestionDesk } from "./questions.js";
import { resolveRepos, type SkippedRepo, type WatchedRepo } from "./repos.js";

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
  | "createIssue"
  | "editIssue"
  | "addDependency"
  | "removeDependency"
  | "closeIssue"
  | "countWorkflowRuns"
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
  /** How often start() retries while another dispatcher holds the database. */
  leaseRetryMs?: number;
  /** Extra work run at the end of every poll, e.g. resolving fixed Bugsink issues. */
  sweeps?: readonly (() => Promise<void>)[];
}

/** What the engine is doing right now, for /status and /healthz. */
export interface EngineSnapshot {
  startedAt: Date | null;
  /** When the last poll over all repos finished. */
  lastTickAt: Date | null;
  ciBusy: boolean;
  repos: string[];
  /** Configured repos the engine can't work on, and why (empty, archived, lookup error). */
  skipped: { name: string; reason: string }[];
  running: { repo: string; issue: number; phase: Phase; startedAt: Date }[];
}

interface InFlight {
  issue: number;
  startedAt: Date;
  phase: Phase;
  controller: AbortController;
  /** Set when work was stopped; the run's result is then ignored. */
  cancelled: boolean;
  done: Promise<void>;
}

const REPO_REFRESH_MS = 5 * 60_000;
/** A lease not renewed for this many polls belongs to a dead or hung process. */
const LEASE_STALE_POLLS = 5;

/** Hidden in the comment left on issues assigned to the bot in an empty repo. */
const EMPTY_REPO_MARKER = "<!-- claude-dispatcher:empty-repo -->";

export class Engine {
  private readonly config: Config;
  private readonly gitea: EngineGitea;
  private readonly store: StateStore;
  private readonly lifecycle: Lifecycle;
  private readonly questions: QuestionDesk;
  private readonly governor: Governor;
  private readonly ciQueue: CiQueue;
  /** Whether CI was backed up at the start of this poll (see CiQueue). */
  private ciBusy = false;
  private readonly log: Logger;
  private readonly now: () => Date;
  private readonly newSessionId: () => string;
  private readonly lock = new KeyedLock();
  private readonly inFlight = new Map<string, InFlight>();
  private readonly labelled = new Set<string>();
  private repos: WatchedRepo[] = [];
  /** Skipped repos from the last refresh, keyed by name, so each skip is logged once. */
  private skipped = new Map<string, string>();
  /** `owner/name#n` issues already told their repo is empty (or found already told). */
  private readonly emptyNoticed = new Set<string>();
  private reposRefreshedAt = Number.NEGATIVE_INFINITY;
  private stopping = false;
  private startedAt: Date | null = null;
  private lastTickAt: Date | null = null;
  private timer: NodeJS.Timeout | undefined;
  private currentTick: Promise<void> = Promise.resolve();
  private ticking = false;
  /** pollNow() was called during a poll: start the next one right after. */
  private pollRequested = false;
  /** Identifies this process in the database lease. */
  private readonly leaseHolder = `${hostname()}:${String(process.pid)}:${randomUUID().slice(0, 8)}`;
  /** Set once start() holds the lease; from then on every poll renews it. */
  private leased = false;
  /** Logged once per loss, not every poll. */
  private leaseLost = false;

  constructor(private readonly deps: EngineDeps) {
    this.config = deps.config;
    this.gitea = deps.gitea;
    this.store = deps.store;
    this.lifecycle = deps.lifecycle ?? basicLifecycle;
    this.log = deps.log ?? silentLogger;
    this.now = deps.now ?? (() => new Date());
    this.newSessionId = deps.newSessionId ?? randomUUID;
    this.questions = new QuestionDesk(deps.config, deps.gitea, this.log);
    this.governor = new Governor(deps.store, deps.config.rateLimit, this.now, this.log);
    this.ciQueue = new CiQueue(deps.gitea, () => this.config.ciMaxQueue, this.log);
  }

  /** Number of Claude runs in progress. */
  get running(): number {
    return this.inFlight.size;
  }

  watchedRepos(): readonly WatchedRepo[] {
    return this.repos;
  }

  /** Discover repos, bootstrap labels, rebuild state from Gitea, start polling. */
  snapshot(): EngineSnapshot {
    return {
      startedAt: this.startedAt,
      lastTickAt: this.lastTickAt,
      ciBusy: this.ciBusy,
      repos: this.repos.map((repo) => repo.fullName),
      skipped: [...this.skipped].map(([name, reason]) => ({ name, reason })),
      running: [...this.inFlight.entries()].map(([repo, run]) => ({
        repo,
        issue: run.issue,
        phase: run.phase,
        startedAt: run.startedAt,
      })),
    };
  }

  async start(): Promise<void> {
    this.startedAt = this.now();
    if (!(await this.takeLease())) return;
    this.governor.liftAuthPause();
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
    const { failed, ...rebuilt } = report;
    this.log.info("state rebuilt from Gitea", { ...rebuilt });
    for (const { repo, error } of failed) {
      this.log.warn("could not rebuild repo state from Gitea; keeping the stored state", {
        repo,
        error,
      });
    }
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
    if (this.leased) this.store.releaseLease(this.leaseHolder);
  }

  /** One pass over every watched repo. Public for tests and manual runs. */
  async tick(): Promise<void> {
    if (!this.renewLease()) return;
    try {
      await this.refreshRepos();
    } catch (error) {
      this.log.error("repo discovery failed; using the previous list", { error });
    }
    await this.checkCi();
    for (const repo of this.repos) {
      if (this.stopping) return;
      try {
        await this.lock.run(repo.fullName, () => this.reconcile(repo));
      } catch (error) {
        this.log.error("reconcile failed", { repo: repo.fullName, error });
      }
    }
    for (const sweep of this.deps.sweeps ?? []) {
      if (this.stopping) return;
      try {
        await sweep();
      } catch (error) {
        this.log.error("sweep failed", { error });
      }
    }
    this.lastTickAt = this.now();
  }

  /** Wait for every run in progress to finish (tests). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight.values()].map((run) => run.done));
    }
  }

  // --- Database lease -------------------------------------------------------

  /**
   * Two dispatchers on one database would run the same issues twice (#52).
   * Wait until no other live process holds the lease. Returns false if
   * stopped while waiting.
   */
  private async takeLease(): Promise<boolean> {
    let waiting = false;
    while (!this.stopping) {
      const lease = this.store.acquireLease(this.leaseHolder, this.leaseStaleMs());
      if (lease.ok) {
        if (waiting) this.log.info("database lease taken; starting");
        this.leased = true;
        return true;
      }
      if (!waiting) {
        this.log.warn("another dispatcher is using this data directory; waiting for it to stop", {
          holder: lease.holder,
        });
        waiting = true;
      }
      await new Promise((resolve) => setTimeout(resolve, this.deps.leaseRetryMs ?? 10_000));
    }
    return false;
  }

  /** Heartbeat the lease; false (skip this poll) if another process took it over. */
  private renewLease(): boolean {
    if (!this.leased) return true;
    const lease = this.store.acquireLease(this.leaseHolder, this.leaseStaleMs());
    if (!lease.ok) {
      if (!this.leaseLost) {
        this.log.error("another dispatcher took over this data directory; not polling", {
          holder: lease.holder,
        });
      }
      this.leaseLost = true;
      return false;
    }
    if (this.leaseLost) this.log.info("database lease taken back; polling again");
    this.leaseLost = false;
    return true;
  }

  private leaseStaleMs(): number {
    return LEASE_STALE_POLLS * this.config.pollIntervalS * 1000;
  }

  // --- Polling --------------------------------------------------------------

  private schedule(delayMs: number): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.ticking = true;
      this.currentTick = this.tick().finally(() => {
        this.ticking = false;
        const again = this.pollRequested;
        this.pollRequested = false;
        this.schedule(again ? 0 : this.config.pollIntervalS * 1000);
      });
    }, delayMs);
  }

  /** Poll now instead of waiting out the interval (dashboard, config changes). */
  pollNow(): void {
    if (this.stopping || this.startedAt === null) return;
    if (this.ticking) {
      this.pollRequested = true;
      return;
    }
    clearTimeout(this.timer);
    this.schedule(0);
  }

  /**
   * The shared config was edited in place (see config/overrides.ts). Most
   * keys are read on use; repo lists and model labels need the repos
   * rediscovered and labels re-checked, and a new interval needs a fresh timer.
   */
  configChanged(keys: readonly string[]): void {
    if (keys.some((key) => key === "repos" || key === "orgs" || key === "routing")) {
      this.reposRefreshedAt = Number.NEGATIVE_INFINITY;
      this.labelled.clear();
    }
    this.log.info("config changed", { keys });
    this.pollNow();
  }

  private async refreshRepos(): Promise<void> {
    if (this.now().getTime() - this.reposRefreshedAt < REPO_REFRESH_MS) return;
    const resolved = await resolveRepos(this.config, this.gitea);
    const skipped = [...resolved.skipped];
    const repos: WatchedRepo[] = [];
    // A repo whose labels can't be set up is skipped (and retried next
    // refresh), so it can't take the others down with it.
    for (const repo of resolved.repos) {
      if (!this.labelled.has(repo.fullName)) {
        try {
          const result = await ensureLabels(this.gitea, repo.ref, dispatcherLabels(this.config));
          if (result.created.length > 0) {
            this.log.info("created labels", { repo: repo.fullName, labels: result.created });
          }
          this.labelled.add(repo.fullName);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          skipped.push({ name: repo.fullName, reason: `label setup failed: ${message}` });
          continue;
        }
      }
      repos.push(repo);
    }
    this.noteSkipped(skipped);
    for (const skip of skipped) {
      if (skip.reason === "empty" && skip.ref) await this.noticeEmptyRepo(skip.name, skip.ref);
    }
    this.repos = repos;
    this.reposRefreshedAt = this.now().getTime();
  }

  /** Log a skip when it starts or its reason changes, not on every refresh. */
  private noteSkipped(skipped: readonly SkippedRepo[]): void {
    const next = new Map(skipped.map((skip) => [skip.name, skip.reason]));
    for (const [name, reason] of next) {
      if (this.skipped.get(name) !== reason) this.log.warn("not watching repo", { name, reason });
    }
    for (const name of this.skipped.keys()) {
      if (!next.has(name)) this.log.info("repo no longer skipped", { name });
    }
    this.skipped = next;
  }

  /**
   * An empty repo has no branch to work from, so issues assigned to the bot
   * there would sit unanswered. Say so once on each, with a hidden marker so a
   * restart doesn't repeat it. Failures are logged, never fatal to discovery.
   */
  private async noticeEmptyRepo(fullName: string, ref: RepoRef): Promise<void> {
    try {
      const assigned = await this.gitea.listIssues(ref, {
        assignee: this.config.gitea.botUsername,
      });
      for (const issue of assigned) {
        const key = `${fullName}#${String(issue.number)}`;
        if (this.emptyNoticed.has(key)) continue;
        const comments = await this.gitea.listComments(ref, issue.number);
        if (!comments.some((comment) => comment.body.includes(EMPTY_REPO_MARKER))) {
          await this.gitea.createComment(
            ref,
            issue.number,
            `I can't start on this yet: \`${fullName}\` has no commits, so there's no branch to work from. Push an initial commit (a README is enough) and I'll pick this up within about 5 minutes.\n\n${EMPTY_REPO_MARKER}`,
          );
          this.log.info("told assigned issue its repo is empty", {
            repo: fullName,
            issue: issue.number,
          });
        }
        this.emptyNoticed.add(key);
      }
    } catch (error) {
      this.log.warn("could not comment on issues in empty repo", { repo: fullName, error });
    }
  }

  // --- Per-repo reconcile ---------------------------------------------------

  private async reconcile(repo: WatchedRepo): Promise<void> {
    const held = this.store.activeIssue(repo.fullName);
    if (held !== null) {
      await this.reconcileActive(repo, held);
      return;
    }
    if (!this.hasCapacity() || this.governor.pickupsPaused()) return;
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
        // Unless this session's last run already succeeded: then its result
        // was never handled, and running it again would only repeat (and
        // re-bill) the same work (#49).
        if (this.lastRunSucceeded(context)) {
          await actions.block(
            context,
            "The implement run finished, but its result was never handled (the dispatcher may have stopped part way). Not running it again.",
          );
          return;
        }
        this.startRun(context, "implement");
        return;
      case "in-review":
        await this.lifecycle.inReview(context, actions);
        return;
      case "blocked":
        if (await this.resumeIfAnswered(context)) return;
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
      !this.stopping &&
      !this.ciBusy &&
      !this.governor.isPaused() &&
      this.inFlight.size < this.config.maxConcurrentSessions
    );
  }

  /**
   * Count active CI runs once per poll, but only when a run could start
   * anyway (a session is free and no usage pause), to save API calls.
   */
  private async checkCi(): Promise<void> {
    if (this.inFlight.size >= this.config.maxConcurrentSessions || this.governor.isPaused()) {
      return;
    }
    const load = await this.ciQueue.load(this.repos.map((repo) => repo.ref));
    if (load.busy !== this.ciBusy) {
      if (load.busy) {
        this.log.info("CI is backed up; not starting runs", {
          active: load.active,
          max: this.config.ciMaxQueue,
        });
      } else {
        this.log.info("CI has room again; starting runs", { active: load.active });
      }
    }
    this.ciBusy = load.busy;
  }

  private startRun(context: WorkContext, phase: Phase, details: RunDetails = {}): boolean {
    const name = context.repo.fullName;
    if (!this.hasCapacity() || this.inFlight.has(name)) return false;

    // Record the session before running, so a crash mid-run can resume it.
    const resume = context.work.sessionId !== null;
    const sessionId = context.work.sessionId ?? this.newSessionId();
    if (!resume) this.store.updateWork(name, context.issue.number, { sessionId });

    const run: InFlight = {
      issue: context.issue.number,
      startedAt: this.now(),
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
    const log = this.log.child({ repo: name, issue: issue.number, phase });
    const { route, ignored } = resolveRoute(
      this.config.routing,
      phase,
      name,
      labelNames(issue.labels),
    );
    for (const label of ignored) log.warn("ignoring routing label", { label });

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
      const toolchain = await workspace.ensureToolchain();
      for (const problem of toolchain.problems) log.warn("toolchain install failed", { problem });
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
        toolchainProblems: toolchain.problems,
        testServices: this.config.toolchain.testServices,
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
        env: toolchain.env,
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
    const limit = this.governor.observe(result);
    log.info("run finished", { kind: result.kind, costUsd: result.costUsd, error: result.error });

    await this.lock.run(name, async () => {
      if (run.cancelled || this.stopping) return;
      const work = this.store.getWork(name, issue.number);
      if (work === undefined || this.store.activeIssue(name) !== issue.number) return;
      try {
        await this.handleResult({ repo, issue, work }, phase, result, workspace, limit);
      } catch (error) {
        // Left alone, the issue would keep its state and the next poll would
        // run the same phase again, forever (#49). Block instead.
        await this.blockAfterFailure({ repo, issue, work }, phase, error);
      }
    });
  }

  /**
   * What follows a run (pushing, opening PRs, filing questions) failed. Block
   * so a human can look, rather than re-running a session that already did
   * the work. If even blocking fails, the run-history check in
   * reconcileActive still keeps the run from repeating.
   */
  private async blockAfterFailure(
    context: WorkContext,
    phase: Phase,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.log.error("handling the run result failed; blocking", {
      repo: context.repo.fullName,
      issue: context.issue.number,
      phase,
      error,
    });
    try {
      await this.actions().block(
        context,
        `The ${phase} run finished, but what comes after it failed: ${message}\n\nCheck that ${this.config.gitea.botUsername} can push branches and open PRs in this repo.`,
      );
    } catch (blockError) {
      this.log.error("could not block the issue", {
        repo: context.repo.fullName,
        issue: context.issue.number,
        error: blockError,
      });
    }
  }

  private async handleResult(
    context: WorkContext,
    phase: Phase,
    result: ClaudeRunResult,
    workspace: WorkspaceLike,
    limit: Observation,
  ): Promise<void> {
    const name = context.repo.fullName;
    switch (result.kind) {
      case "success":
        if (!result.report) throw new Error("the run succeeded without a report");
        await this.afterSuccess(context, phase, result.report, workspace);
        return;
      case "aborted":
        return;
      case "rate_limited":
      case "auth_failed": {
        // State and session are kept; the run resumes once the governor allows.
        if (result.kind === "auth_failed") {
          this.log.error("Claude Code can't authenticate; pausing all runs until it can", {
            error: result.error,
          });
        }
        if (phase === "fix-ci" || phase === "address-review" || phase === "rebase") {
          // A round cut off by the limit doesn't count against MAX_FIX_ATTEMPTS.
          this.store.updateWork(name, context.issue.number, {
            fixAttempts: Math.max(0, context.work.fixAttempts - 1),
          });
        }
        if (limit.pauseStarted && limit.pausedUntil) {
          const why =
            result.kind === "auth_failed"
              ? `Claude Code can't authenticate (${result.error ?? "unknown error"}); check CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY. Retrying`
              : "Claude's usage limit was reached. Work continues";
          await this.gitea.createComment(
            context.repo.ref,
            context.issue.number,
            `Paused: ${why} after ${limit.pausedUntil.toISOString()}.`,
          );
        }
        return;
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

  // --- Questions ------------------------------------------------------------

  /**
   * Add the report's questions to the source's questions issue. Blocking ones
   * stop here (the issue waits for answers); otherwise the lifecycle carries
   * on and the source issue gets a note linking the questions issue.
   */
  private async afterSuccess(
    context: WorkContext,
    phase: Phase,
    report: Report,
    workspace: WorkspaceLike,
  ): Promise<void> {
    const filed = await this.questions.fileFromReport(context, report);
    const where = filed.issue === undefined ? "" : `#${String(filed.issue.number)}`;
    if (filed.blocking) {
      await this.actions().block(
        context,
        `Claude needs answers before it can continue: see ${where}. Tick an option and reply there, or close it to go with the ticked options; work resumes automatically.`,
      );
      return;
    }
    if (filed.added > 0) {
      await this.gitea.createComment(
        context.repo.ref,
        context.issue.number,
        `Added ${String(filed.added)} question${filed.added === 1 ? "" : "s"} for @${this.config.humanReviewer} to ${where}. Work continues.`,
      );
    }
    await this.lifecycle.afterRun(context, phase, report, workspace, this.actions());
  }

  /**
   * Resume a blocked issue once every blocking question is answered: continue
   * the same session with the answers. The run is started before the state
   * changes, so if there's no capacity the issue stays blocked and the answers
   * are picked up again next poll. Returns true if the issue is waiting on
   * questions (answered or not), so nothing else should handle it this poll.
   */
  private async resumeIfAnswered(context: WorkContext): Promise<boolean> {
    const answers = await this.questions.answers(context);
    if (answers === "none") return false;
    if (answers === "pending") return true;

    const phase: Phase = context.work.prStack.length > 0 ? "address-review" : "implement";
    const details: RunDetails = { answers: answers.answers };
    // A human answered: the PR gets a fresh set of fix rounds, or the next
    // red CI would escalate again straight away.
    const fresh =
      phase === "address-review" && context.work.fixAttempts > 0
        ? { ...context, work: { ...context.work, fixAttempts: 0 } }
        : context;
    if (!this.startRun(fresh, phase, details)) return true;
    if (fresh !== context) {
      this.store.updateWork(context.repo.fullName, context.issue.number, { fixAttempts: 0 });
    }

    const next = await this.setState(context, phase === "implement" ? "working" : "in-review");
    await this.questions.resolve(next, answers);
    await this.gitea.createComment(
      next.repo.ref,
      next.issue.number,
      `Answers received on #${String(answers.issue.number)}. Continuing.`,
    );
    this.log.info("resumed with answers", {
      repo: next.repo.fullName,
      issue: next.issue.number,
      phase,
    });
    return true;
  }

  // --- Actions for lifecycles -------------------------------------------------

  private actions(): EngineActions {
    return {
      setState: (context, state) => this.setState(context, state),
      update: (context, patch) => ({
        ...context,
        work: this.store.updateWork(context.repo.fullName, context.issue.number, patch),
      }),
      comment: async (context, body) => {
        await this.gitea.createComment(context.repo.ref, context.issue.number, body);
      },
      block: async (context, reason) => {
        const next = await this.setState(context, "blocked");
        const { labelPrefix, humanReviewer, gitea } = this.config;
        await this.gitea.createComment(
          next.repo.ref,
          next.issue.number,
          `@${humanReviewer} ${reason}\n\nTo retry from scratch, remove the \`${stateLabel(labelPrefix, "blocked")}\` label. To drop the issue, unassign ${gitea.botUsername}.`,
        );
      },
      escalate: async (context, escalation) => {
        const question = await this.questions.escalate(context, escalation);
        const where =
          question === undefined
            ? ""
            : ` See #${String(question.number)}: reply there or close it and work continues.`;
        await this.actions().block(context, `${escalation.title}.${where}`);
      },
      finish: async (context, outcome) => {
        this.store.release(context.repo.fullName, outcome);
        await this.removeStateLabels(context.repo, context.issue.number, context.issue.labels);
      },
      startRun: (context, phase, details) => this.startRun(context, phase, details),
      workspace: (context) => this.deps.workspace(context.repo),
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

  /** Whether the latest run on this issue, in its current session, succeeded. */
  private lastRunSucceeded({ repo, issue, work }: WorkContext): boolean {
    if (work.sessionId === null) return false;
    const [last] = this.store.listRuns({ repo: repo.fullName, issue: issue.number, limit: 1 });
    return last?.sessionId === work.sessionId && last.exit === "success";
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
