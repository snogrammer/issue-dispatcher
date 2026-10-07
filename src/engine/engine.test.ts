import { describe, expect, it } from "vitest";

import { A, B, cycle, FakeWorkspace, report, setup } from "../../test/helpers/engine-fakes.js";
import type { ClaudeRunResult, RunRequest } from "../claude/runner.js";
import { createLogger } from "../log.js";
import { Engine } from "./engine.js";
import { prLifecycle } from "./pr-lifecycle.js";

describe("startup", () => {
  it("bootstraps labels and discovers org repos, skipping archived and empty ones", async () => {
    const { gitea, config, store, runner } = setup({ REPOS: A, ORGS: "team" });
    gitea.addRepo("team/live");
    gitea.addRepo("team/old", { archived: true });
    gitea.addRepo("team/new", { empty: true });
    const engine = new Engine({
      config,
      gitea,
      store,
      workspace: () => new FakeWorkspace(),
      runClaude: runner.run,
    });

    await engine.tick();

    expect(engine.watchedRepos().map((r) => r.fullName)).toEqual([A, "team/live"]);
    expect(gitea.labels.get("team/live")?.map((l) => l.name)).toContain("claude:working");
    expect(gitea.labels.get("team/old")).toEqual([]);
  });

  it("starts when an org repo has issues turned off", async () => {
    const { gitea, config, store, runner } = setup({ REPOS: A, ORGS: "team" });
    gitea.addRepo("team/code-only", { hasIssues: false });
    const engine = new Engine({
      config,
      gitea,
      store,
      workspace: () => new FakeWorkspace(),
      runClaude: runner.run,
    });

    await engine.start();
    await engine.stop();

    expect(engine.watchedRepos().map((r) => r.fullName)).toEqual([A]);
    expect(engine.snapshot().skipped).toEqual([
      { name: "team/code-only", reason: "issues disabled" },
    ]);
  });

  it("starts and skips a repo whose labels can't be set up, then retries it", async () => {
    const { gitea, config, store, runner, clock } = setup({ REPOS: `${A},team/locked` });
    gitea.addRepo("team/locked");
    gitea.labelFailures.add("team/locked");
    const engine = new Engine({
      config,
      gitea,
      store,
      workspace: () => new FakeWorkspace(),
      runClaude: runner.run,
      now: () => clock.now,
    });

    await engine.start();
    await engine.stop();

    expect(engine.watchedRepos().map((r) => r.fullName)).toEqual([A]);
    expect(engine.snapshot().skipped).toEqual([
      {
        name: "team/locked",
        reason: "label setup failed: GET /repos/team/locked/labels failed (403): forbidden",
      },
    ]);

    gitea.labelFailures.delete("team/locked");
    clock.now = new Date(clock.now.getTime() + 10 * 60_000);
    await engine.tick();
    expect(engine.watchedRepos().map((r) => r.fullName)).toEqual([A, "team/locked"]);
  });
});

describe("skipped repos", () => {
  it("comments once on issues assigned to the bot in an empty repo, across refreshes and restarts", async () => {
    const { gitea, config, store, runner, clock } = setup({ REPOS: `${A},team/new` });
    gitea.addRepo("team/new", { empty: true });
    gitea.addIssue("team/new", { number: 1 });
    gitea.addIssue("team/new", { number: 2, assignees: ["human"] });
    const make = () =>
      new Engine({
        config,
        gitea,
        store,
        workspace: () => new FakeWorkspace(),
        runClaude: runner.run,
        now: () => clock.now,
      });

    const engine = make();
    await engine.tick();
    clock.now = new Date(clock.now.getTime() + 10 * 60_000);
    await engine.tick();
    await make().tick();

    expect(gitea.commentsOn("team/new", 1)).toHaveLength(1);
    expect(gitea.commentsOn("team/new", 1)[0]).toContain("`team/new` has no commits");
    expect(gitea.commentsOn("team/new", 2)).toEqual([]);
    expect(engine.snapshot().skipped).toEqual([{ name: "team/new", reason: "empty" }]);
  });

  it("logs a skip once, and again only when it clears", async () => {
    const { gitea, config, store, runner, clock } = setup({ REPOS: `${A},team/new` });
    gitea.addRepo("team/new", { empty: true });
    const lines: string[] = [];
    const engine = new Engine({
      config,
      gitea,
      store,
      workspace: () => new FakeWorkspace(),
      runClaude: runner.run,
      now: () => clock.now,
      log: createLogger("info", { write: (line) => lines.push(line) }),
    });
    const messages = () => lines.map((line) => (JSON.parse(line) as { msg: string }).msg);

    await engine.tick();
    clock.now = new Date(clock.now.getTime() + 10 * 60_000);
    await engine.tick();
    expect(messages().filter((m) => m === "not watching repo")).toHaveLength(1);

    gitea.addRepo("team/new");
    clock.now = new Date(clock.now.getTime() + 10 * 60_000);
    await engine.tick();
    expect(messages()).toContain("repo no longer skipped");
    expect(engine.snapshot().skipped).toEqual([]);
    expect(engine.watchedRepos().map((r) => r.fullName)).toContain("team/new");
  });
});

describe("snapshot", () => {
  it("reports runs in progress and when the last poll finished", async () => {
    const { gitea, engine, runner, clock } = setup();
    gitea.addIssue(A, { number: 1 });
    runner.script("hold");
    expect(engine.snapshot().lastTickAt).toBeNull();

    await engine.tick();

    expect(engine.snapshot()).toMatchObject({
      lastTickAt: clock.now,
      ciBusy: false,
      repos: [A, B],
      running: [{ repo: A, issue: 1, phase: "implement", startedAt: clock.now }],
    });
    runner.release();
    await engine.idle();
    expect(engine.snapshot().running).toEqual([]);
  });
});

describe("picking up issues", () => {
  it("takes high priority first, then oldest, skipping blocked and question issues", async () => {
    const { gitea, engine, store, runner } = setup();
    gitea.addIssue(A, { number: 1, labels: ["priority:low"] });
    gitea.addIssue(A, { number: 2 });
    gitea.addIssue(A, { number: 3, labels: ["priority:high"], createdAt: "2026-03-01T00:00:00Z" });
    gitea.addIssue(A, { number: 4, labels: ["priority:high"], blockedBy: [2] });
    gitea.addIssue(A, { number: 5, labels: ["priority:high", "claude:question"] });
    gitea.addIssue(A, { number: 6, labels: ["priority:high"], assignees: ["someone"] });
    runner.script("hold");

    await engine.tick();

    expect(store.activeIssue(A)).toBe(3);
    expect(gitea.labelNames(A, 3)).toEqual(["claude:working", "priority:high"]);
    expect(gitea.commentsOn(A, 3)).toEqual(["Picked up by bot. Working on `claude/3-issue-3`."]);
    expect(runner.requests[0]).toMatchObject({
      phase: "implement",
      issue: 3,
      cwd: "/work",
      sessionId: "session-1",
    });
    expect(runner.requests[0]?.prompt).toContain("Title: Issue 3");
    expect(store.getWork(A, 3)?.sessionId).toBe("session-1");
  });

  it("labels the issue in Gitea before anything else", async () => {
    const { gitea, engine } = setup();
    gitea.addIssue(A, { number: 1 });
    await cycle(engine);
    expect(gitea.calls[0]).toBe("addLabel org/a#1 claude:working");
  });

  it("picks up an issue once its dependency is closed", async () => {
    const { gitea, engine, store } = setup();
    gitea.addIssue(A, { number: 1, assignees: ["human"] });
    gitea.addIssue(A, { number: 2, blockedBy: [1] });
    await cycle(engine);
    expect(store.activeIssue(A)).toBeNull();

    gitea.issue(A, 1).state = "closed";
    await engine.tick();
    expect(store.activeIssue(A)).toBe(2);
  });

  it("works on one issue per repo, and on repos in parallel up to the session cap", async () => {
    const { gitea, engine, store, runner } = setup({ MAX_CONCURRENT_SESSIONS: "2" });
    gitea.addIssue(A, { number: 1 });
    gitea.addIssue(A, { number: 2 });
    gitea.addIssue(B, { number: 7 });
    runner.script("hold", "hold");

    await engine.tick();
    await engine.tick();

    expect(store.activeIssue(A)).toBe(1);
    expect(store.activeIssue(B)).toBe(7);
    expect(engine.running).toBe(2);
    expect(runner.requests.map((r) => r.issue)).toEqual([1, 7]);
    expect(gitea.labelNames(A, 2)).toEqual([]);
  });

  it("waits for a free session before picking up in another repo", async () => {
    const { gitea, engine, store, runner } = setup();
    gitea.addIssue(A, { number: 1 });
    gitea.addIssue(B, { number: 7 });
    runner.script("hold");

    await engine.tick();
    expect(store.activeIssue(B)).toBeNull();

    runner.release();
    await engine.idle();
    await engine.tick();
    expect(store.activeIssue(B)).toBe(7);
  });
});

describe("after a run", () => {
  it("pushes the reported branches and moves the issue to in-review", async () => {
    const { gitea, engine, store, workspace } = setup();
    gitea.addIssue(A, { number: 1, title: "Add login" });

    await cycle(engine);

    expect(workspace(A).prepared).toEqual([["claude/1-add-login", "main"]]);
    expect(workspace(A).pushed).toEqual([[1, ["claude/1-x"]]]);
    expect(gitea.labelNames(A, 1)).toEqual(["claude:in-review"]);
    expect(store.getWork(A, 1)?.state).toBe("in-review");
    expect(store.activeIssue(A)).toBe(1);
    expect(gitea.commentsOn(A, 1).at(-1)).toContain("Finished implement. Pushed `claude/1-x`.");
    expect(store.recentRuns()[0]).toMatchObject({
      phase: "implement",
      exit: "success",
      costUsd: 0.1,
    });

    // Still held while in review: no new pickup in this repo.
    gitea.addIssue(A, { number: 2 });
    await cycle(engine);
    expect(store.activeIssue(A)).toBe(1);
  });

  it("adds the new state label before removing the old one", async () => {
    const { gitea, engine } = setup();
    gitea.addIssue(A, { number: 1 });
    await cycle(engine);
    const added = gitea.calls.indexOf("addLabel org/a#1 claude:in-review");
    const removed = gitea.calls.indexOf("removeLabel org/a#1 claude:working");
    expect(added).toBeGreaterThan(-1);
    expect(removed).toBeGreaterThan(added);
  });

  it.each(["error", "timeout", "max_turns", "max_budget"] as const)(
    "blocks the issue when the run ends with %s",
    async (kind) => {
      const { gitea, engine, store, runner } = setup();
      gitea.addIssue(A, { number: 1 });
      runner.script(kind);

      await cycle(engine);

      expect(gitea.labelNames(A, 1)).toEqual(["claude:blocked"]);
      expect(store.getWork(A, 1)?.state).toBe("blocked");
      const comment = gitea.commentsOn(A, 1).at(-1) ?? "";
      expect(comment).toContain(`The implement run failed (${kind})`);
      expect(comment).toContain("remove the `claude:blocked` label");
    },
  );

  it("blocks when the workspace can't be prepared", async () => {
    const { gitea, engine, workspace } = setup();
    workspace(A).failPrepare = true;
    gitea.addIssue(A, { number: 1 });
    await cycle(engine);
    expect(gitea.labelNames(A, 1)).toEqual(["claude:blocked"]);
    expect(gitea.commentsOn(A, 1).at(-1)).toContain("could not prepare the run: git fetch failed");
  });

  it("blocks with Claude's questions when it needs a human", async () => {
    const { gitea, engine, runner } = setup();
    gitea.addIssue(A, { number: 1 });
    runner.script((request) => ({
      kind: "success",
      sessionId: request.sessionId ?? "",
      stderrTail: "",
      report: report(1, {
        outcome: "needs_human",
        branches: [],
        followups: [{ title: "Which API?", body: "v1 or v2", blocking: true }],
      }),
    }));
    await cycle(engine);
    expect(gitea.labelNames(A, 1)).toEqual(["claude:blocked"]);
    expect(gitea.issue(A, 2).title).toBe("Question from #1: Which API?");
    expect(gitea.commentsOn(A, 1).at(-1)).toContain(
      "Claude needs answers before it can continue: #2.",
    );
  });
});

describe("rate limits", () => {
  it("pauses all runs until the reset, then resumes the same session", async () => {
    const { gitea, engine, store, runner, clock } = setup();
    gitea.addIssue(A, { number: 1 });
    gitea.addIssue(B, { number: 7 });
    runner.script("rate_limited");

    await cycle(engine);
    expect(store.getGovernor().pausedUntil).toEqual(new Date("2026-06-01T05:00:00Z"));
    expect(gitea.labelNames(A, 1)).toEqual(["claude:working"]);

    await cycle(engine);
    expect(runner.requests).toHaveLength(1);
    expect(store.activeIssue(B)).toBeNull();

    clock.now = new Date("2026-06-01T05:00:01Z");
    await cycle(engine);
    expect(runner.requests[1]).toMatchObject({ issue: 1, resumeSessionId: "session-1" });
    expect(store.getGovernor().pausedUntil).toBeNull();
  });
});

describe("usage limits", () => {
  it("backs off without a reset time and comments once on the paused issue", async () => {
    const { gitea, engine, store, runner, clock } = setup();
    gitea.addIssue(A, { number: 1 });
    const limited = (request: RunRequest): ClaudeRunResult => ({
      kind: "rate_limited",
      sessionId: request.resumeSessionId ?? request.sessionId ?? "",
      stderrTail: "",
      error: "Claude AI usage limit reached",
    });
    runner.script(limited, limited);

    await cycle(engine);
    expect(store.getGovernor().pausedUntil).toEqual(new Date("2026-06-01T00:15:00Z"));
    expect(gitea.commentsOn(A, 1).at(-1)).toBe(
      "Paused: Claude's usage limit was reached. Work continues after 2026-06-01T00:15:00.000Z.",
    );

    clock.now = new Date("2026-06-01T00:15:00Z");
    await cycle(engine);
    expect(store.getGovernor().pausedUntil).toEqual(new Date("2026-06-01T00:45:00Z"));
    expect(gitea.commentsOn(A, 1).filter((c) => c.startsWith("Paused:"))).toHaveLength(2);

    clock.now = new Date("2026-06-01T00:45:00Z");
    await cycle(engine);
    expect(runner.requests).toHaveLength(3);
    expect(store.getGovernor().backoffLevel).toBe(0);
    expect(gitea.labelNames(A, 1)).toEqual(["claude:in-review"]);
  });

  it("near the limit, finishes work in progress but picks up nothing new", async () => {
    const { gitea, engine, store, runner, clock } = setup(
      { MAX_CONCURRENT_SESSIONS: "2" },
      (deps) => prLifecycle(deps),
    );
    gitea.addIssue(A, { number: 1 });
    runner.script((request) => ({
      kind: "success",
      sessionId: request.sessionId ?? "",
      stderrTail: "",
      report: report(1),
      rateLimit: {
        status: "allowed_warning",
        resetsAt: new Date("2026-06-01T03:00:00Z"),
        utilization: 0.93,
      },
    }));
    await cycle(engine); // implement → PR #2, and the CLI warns
    expect(store.getGovernor().pickupPausedUntil).toEqual(new Date("2026-06-01T03:00:00Z"));

    gitea.addIssue(B, { number: 7 });
    gitea.setStatus("sha-1", "failure");
    await cycle(engine);
    // The issue in progress still gets its fix round; the new issue waits.
    expect(runner.requests.map((r) => [r.issue, r.phase])).toEqual([
      [1, "implement"],
      [1, "fix-ci"],
    ]);
    expect(store.activeIssue(B)).toBeNull();

    clock.now = new Date("2026-06-01T03:00:00Z");
    await cycle(engine);
    expect(store.activeIssue(B)).toBe(7);
  });

  it("doesn't count a fix round cut off by the limit", async () => {
    const { gitea, engine, store, runner, clock } = setup({}, (deps) => prLifecycle(deps));
    gitea.addIssue(A, { number: 1 });
    runner.script("success", "rate_limited");
    await cycle(engine);
    gitea.setStatus("sha-1", "failure");
    await cycle(engine);
    expect(store.getWork(A, 1)?.fixAttempts).toBe(0);

    clock.now = new Date("2026-06-01T05:00:01Z");
    await cycle(engine);
    expect(runner.requests.at(-1)).toMatchObject({ phase: "fix-ci", resumeSessionId: "session-1" });
    expect(store.getWork(A, 1)?.fixAttempts).toBe(1);
  });
});

describe("routing", () => {
  it("runs with the model and effort from the issue's labels", async () => {
    const { gitea, engine, runner, store } = setup();
    gitea.addIssue(A, { number: 1, labels: ["model:opus", "effort:high"] });
    await cycle(engine);
    expect(runner.requests[0]?.route).toEqual({ model: "opus", effort: "high", maxTurns: 100 });
    expect(store.recentRuns()[0]).toMatchObject({ model: "opus", effort: "high", maxTurns: 100 });
  });

  it("ignores unknown routing labels with a warning", async () => {
    const lines: string[] = [];
    const { gitea, store, runner, config } = setup();
    const engine = new Engine({
      config,
      gitea,
      store,
      workspace: () => new FakeWorkspace(),
      runClaude: runner.run,
      log: createLogger("warn", { write: (line) => lines.push(line) }),
    });
    gitea.addIssue(A, { number: 1, labels: ["model:gpt-9"] });
    await cycle(engine);
    expect(runner.requests[0]?.route).toEqual({ maxTurns: 100 });
    expect(lines.map((line) => JSON.parse(line) as Record<string, unknown>)).toContainEqual(
      expect.objectContaining({
        msg: "ignoring routing label",
        label: "model:gpt-9 (not a configured model; add it to MODEL_LABELS)",
        issue: 1,
      }),
    );
  });
});

describe("unusable Claude credentials", () => {
  it("pauses everything instead of blocking issue after issue", async () => {
    const { gitea, engine, store, runner, clock } = setup();
    gitea.addIssue(A, { number: 1 });
    gitea.addIssue(B, { number: 7 });
    const notLoggedIn = (request: RunRequest): ClaudeRunResult => ({
      kind: "auth_failed",
      sessionId: request.resumeSessionId ?? request.sessionId ?? "",
      stderrTail: "",
      error: "Not logged in · Please run /login",
    });
    runner.script(notLoggedIn);

    await cycle(engine);
    await cycle(engine);

    expect(runner.requests).toHaveLength(1);
    expect(gitea.labelNames(A, 1)).toEqual(["claude:working"]);
    expect(store.activeIssue(B)).toBeNull();
    expect(store.getGovernor().pausedUntil).toEqual(new Date("2026-06-01T00:15:00Z"));
    expect(gitea.commentsOn(A, 1).at(-1)).toBe(
      "Paused: Claude Code can't authenticate (Not logged in · Please run /login); check CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY. Retrying after 2026-06-01T00:15:00.000Z.",
    );

    clock.now = new Date("2026-06-01T00:15:00Z");
    await cycle(engine);
    expect(runner.requests.at(-1)).toMatchObject({ issue: 1, resumeSessionId: "session-1" });
  });
});

describe("CI backpressure", () => {
  it("doesn't start runs while CI is backed up, and resumes when it drains", async () => {
    const { gitea, engine, store, runner } = setup({ CI_MAX_QUEUE: "2" });
    gitea.addRun(B, "other", "in_progress");
    gitea.addRun(B, "other2", "queued");
    gitea.addIssue(A, { number: 1 });

    await cycle(engine);
    expect(store.activeIssue(A)).toBeNull();
    expect(runner.requests).toEqual([]);

    gitea.runs.forEach((run) => {
      run.status = "completed";
    });
    await cycle(engine);
    expect(store.activeIssue(A)).toBe(1);
    expect(runner.requests).toHaveLength(1);
  });

  it("holds fix rounds too, without counting them", async () => {
    const { gitea, engine, store, runner } = setup({ CI_MAX_QUEUE: "2" }, (deps) =>
      prLifecycle(deps),
    );
    gitea.addIssue(A, { number: 1 });
    await cycle(engine); // PR #2
    gitea.setStatus("sha-1", "failure");
    gitea.addRun(B, "x", "queued");
    gitea.addRun(B, "y", "queued");

    await cycle(engine);
    expect(runner.requests.map((r) => r.phase)).toEqual(["implement"]);
    expect(store.getWork(A, 1)?.fixAttempts).toBe(0);

    gitea.runs.forEach((run) => {
      run.status = "completed";
    });
    await cycle(engine);
    expect(runner.requests.map((r) => r.phase)).toEqual(["implement", "fix-ci"]);
  });
});

describe("dashboard controls", () => {
  it("a manual pause stops pickups but not work in progress, until resumed", async () => {
    const { gitea, engine, store, runner } = setup({ MAX_CONCURRENT_SESSIONS: "2" });
    gitea.addIssue(A, { number: 1 });
    runner.script("hold");
    await engine.tick();
    expect(engine.running).toBe(1);

    store.setGovernor({ manualPause: true });
    gitea.addIssue(B, { number: 7 });
    await engine.tick();
    expect(store.activeIssue(B)).toBeNull();
    expect(engine.running).toBe(1);

    runner.release();
    await engine.idle();
    expect(store.getWork(A, 1)?.state).toBe("in-review");

    store.setGovernor({ manualPause: false });
    await cycle(engine);
    expect(store.activeIssue(B)).toBe(7);
  });

  it("reads the CI queue limit live", async () => {
    const { gitea, engine, store, config } = setup({ CI_MAX_QUEUE: "2" });
    gitea.addRun(B, "x", "queued");
    gitea.addRun(B, "y", "in_progress");
    gitea.addIssue(A, { number: 1 });
    await cycle(engine);
    expect(store.activeIssue(A)).toBeNull();

    config.ciMaxQueue = 3;
    await cycle(engine);
    expect(store.activeIssue(A)).toBe(1);
  });

  it("rediscovers repos right away when the repo list changes", async () => {
    const { engine, config } = setup();
    await engine.tick();
    expect(engine.watchedRepos().map((r) => r.fullName)).toEqual([A, B]);

    config.repos = [A];
    await engine.tick();
    expect(engine.watchedRepos()).toHaveLength(2); // cached for a few minutes

    engine.configChanged(["repos"]);
    await engine.tick();
    expect(engine.watchedRepos().map((r) => r.fullName)).toEqual([A]);
  });
});

describe("humans steering", () => {
  it("stops when the bot is unassigned: aborts the run, frees the slot, leaves a note", async () => {
    const { gitea, engine, store, runner } = setup();
    gitea.addIssue(A, { number: 1 });
    runner.script("hold");
    await engine.tick();

    gitea.issue(A, 1).assignees = [];
    await cycle(engine);

    expect(store.activeIssue(A)).toBeNull();
    expect(store.getWork(A, 1)?.state).toBe("abandoned");
    expect(gitea.labelNames(A, 1)).toEqual([]);
    expect(gitea.commentsOn(A, 1).at(-1)).toBe(
      "Stopped: bot was unassigned. Any open PRs were left as they are.",
    );
    expect(store.recentRuns()[0]?.exit).toBe("aborted");
  });

  it("stops when the issue is closed", async () => {
    const { gitea, engine, store } = setup();
    gitea.addIssue(A, { number: 1 });
    await cycle(engine);
    gitea.issue(A, 1).state = "closed";
    await cycle(engine);
    expect(store.activeIssue(A)).toBeNull();
    expect(gitea.commentsOn(A, 1).at(-1)).toContain("Stopped: the issue was closed.");
  });

  it("starts over when a human removes the state label", async () => {
    const { gitea, engine, store, runner } = setup();
    gitea.addIssue(A, { number: 1 });
    runner.script("error");
    await cycle(engine);
    expect(gitea.labelNames(A, 1)).toEqual(["claude:blocked"]);

    gitea.issue(A, 1).labels = [];
    await cycle(engine); // releases the slot
    await cycle(engine); // picks it up again

    expect(store.getWork(A, 1)).toMatchObject({ state: "in-review", fixAttempts: 0 });
    expect(runner.requests.at(-1)).toMatchObject({ issue: 1, sessionId: "session-2" });
  });
});

describe("restarts", () => {
  it("resumes in-flight work after a restart", async () => {
    const { gitea, store, runner, make } = setup();
    gitea.addIssue(A, { number: 1 });
    runner.script("hold");
    const first = make();
    await first.tick();
    await first.stop(); // the process going down mid-run

    expect(gitea.labelNames(A, 1)).toEqual(["claude:working"]);
    expect(store.getWork(A, 1)?.sessionId).toBe("session-1");

    const second = make();
    await second.start();
    await second.stop(); // stop the poll timer; drive ticks by hand
    const restarted = make();
    await cycle(restarted);
    expect(runner.requests.at(-1)).toMatchObject({ issue: 1, resumeSessionId: "session-1" });
    expect(gitea.labelNames(A, 1)).toEqual(["claude:in-review"]);
  });

  it("rebuilds an empty store from labels", async () => {
    const { gitea, runner, make } = setup();
    gitea.addIssue(A, { number: 1, labels: ["claude:working"] });
    const engine = make();
    await engine.start();
    await engine.stop();
    // The rebuild restored the slot, so a new engine resumes the work.
    const next = make();
    await cycle(next);
    expect(runner.requests.at(-1)).toMatchObject({ issue: 1, sessionId: "session-1" });
  });

  it("starts a new session when the recorded one can't be resumed", async () => {
    const { gitea, store, runner, make } = setup();
    gitea.addIssue(A, { number: 1 });
    runner.script("hold");
    const first = make();
    await first.tick();
    await first.stop();

    runner.script("session_not_found");
    const second = make();
    await cycle(second);
    expect(store.getWork(A, 1)?.sessionId).toBeNull();
    expect(gitea.labelNames(A, 1)).toEqual(["claude:working"]);

    await cycle(second);
    expect(runner.requests.at(-1)).toMatchObject({ issue: 1, sessionId: "session-2" });
  });
});
