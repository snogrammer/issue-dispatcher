import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { MIGRATIONS } from "./migrations.js";
import { SlotOccupiedError, StateStore } from "./store.js";

const REPO = "org/repo";

function clock(start = "2026-01-01T00:00:00.000Z") {
  let time = new Date(start).getTime();
  return {
    now: () => new Date(time),
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe("migrations", () => {
  const dirs: string[] = [];
  const tempDir = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "dispatcher-state-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("creates the schema and persists across reopen", () => {
    const dir = tempDir();
    const first = StateStore.open(path.join(dir, "nested"));
    first.claim(REPO, 1);
    first.close();

    const db = new Database(path.join(dir, "nested", "dispatcher.db"));
    expect(db.pragma("user_version", { simple: true })).toBe(MIGRATIONS.length);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    db.close();

    const second = StateStore.open(path.join(dir, "nested"));
    expect(second.activeIssue(REPO)).toBe(1);
    second.close();
  });

  it("refuses a database from a newer build", () => {
    const dir = tempDir();
    const db = new Database(path.join(dir, "dispatcher.db"));
    db.pragma(`user_version = ${String(MIGRATIONS.length + 1)}`);
    db.close();
    expect(() => StateStore.open(dir)).toThrow("refusing to downgrade");
  });
});

describe("repo slots", () => {
  it("claims a free slot with a new working record", () => {
    const { now } = clock();
    const store = StateStore.inMemory({ now });
    const work = store.claim(REPO, 4, { branch: "claude/4-x" });
    expect(work).toEqual({
      repo: REPO,
      issue: 4,
      state: "working",
      branch: "claude/4-x",
      prStack: [],
      sessionId: null,
      fixAttempts: 0,
      lastSha: null,
      headSince: null,
      rebaseFrom: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(store.activeIssue(REPO)).toBe(4);
  });

  it("keeps progress when the holder re-claims", () => {
    const store = StateStore.inMemory();
    store.claim(REPO, 4);
    store.updateWork(REPO, 4, { sessionId: "s1", fixAttempts: 2 });
    const again = store.claim(REPO, 4, { state: "in-review" });
    expect(again).toMatchObject({ state: "in-review", sessionId: "s1", fixAttempts: 2 });
  });

  it("allows one issue per repo but different repos in parallel", () => {
    const store = StateStore.inMemory();
    store.claim(REPO, 4);
    expect(() => store.claim(REPO, 5)).toThrow(SlotOccupiedError);
    expect(() => store.claim(REPO, 5)).toThrow("org/repo is already working on #4");
    store.claim("org/other", 5);
    expect(store.activeWork().map((w) => [w.repo, w.issue])).toEqual([
      ["org/other", 5],
      [REPO, 4],
    ]);
  });

  it("releases with an outcome and frees the slot", () => {
    const store = StateStore.inMemory();
    store.claim(REPO, 4);
    expect(store.release(REPO, "done")?.state).toBe("done");
    expect(store.activeIssue(REPO)).toBeNull();
    expect(store.activeWork()).toEqual([]);
    expect(store.release(REPO, "done")).toBeUndefined();
    store.claim(REPO, 5);
    expect(store.activeIssue(REPO)).toBe(5);
  });

  it("starts fresh when a finished issue is claimed again", () => {
    const store = StateStore.inMemory();
    store.claim(REPO, 4);
    store.updateWork(REPO, 4, { sessionId: "s1", fixAttempts: 3, prStack: [9], lastSha: "abc" });
    store.release(REPO, "abandoned");
    expect(store.claim(REPO, 4)).toMatchObject({
      state: "working",
      sessionId: null,
      fixAttempts: 0,
      prStack: [],
      lastSha: null,
    });
  });
});

describe("updateWork", () => {
  it("patches only the given fields and bumps updatedAt", () => {
    const { now, advance } = clock();
    const store = StateStore.inMemory({ now });
    store.claim(REPO, 4, { branch: "claude/4-x" });
    advance(1000);
    const work = store.updateWork(REPO, 4, {
      state: "in-review",
      prStack: [10, 11],
      lastSha: "f00",
    });
    expect(work).toMatchObject({
      state: "in-review",
      branch: "claude/4-x",
      prStack: [10, 11],
      lastSha: "f00",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    });
    expect(store.updateWork(REPO, 4, { branch: null }).branch).toBeNull();
  });

  it("records when the head SHA last changed", () => {
    const { now, advance } = clock();
    const store = StateStore.inMemory({ now });
    store.claim(REPO, 4);
    advance(1000);
    expect(store.updateWork(REPO, 4, { lastSha: "a" }).headSince).toBe("2026-01-01T00:00:01.000Z");
    advance(1000);
    expect(store.updateWork(REPO, 4, { lastSha: "a", fixAttempts: 1 }).headSince).toBe(
      "2026-01-01T00:00:01.000Z",
    );
    advance(1000);
    expect(store.updateWork(REPO, 4, { lastSha: "b" }).headSince).toBe("2026-01-01T00:00:03.000Z");
  });

  it("refuses to update an issue that doesn't hold the slot", () => {
    const store = StateStore.inMemory();
    expect(() => store.updateWork(REPO, 4, { fixAttempts: 1 })).toThrow("does not hold");
    store.claim(REPO, 4);
    store.release(REPO, "done");
    expect(() => store.updateWork(REPO, 4, { fixAttempts: 1 })).toThrow("does not hold");
    expect(store.getWork(REPO, 4)?.state).toBe("done");
  });
});

describe("governor", () => {
  it("defaults to not paused", () => {
    expect(StateStore.inMemory().getGovernor()).toEqual({
      pausedUntil: null,
      pickupPausedUntil: null,
      backoffLevel: 0,
      manualPause: false,
    });
  });

  it("stores and clears the pauses", () => {
    const store = StateStore.inMemory();
    const until = new Date("2026-01-01T05:00:00.000Z");
    const pickup = new Date("2026-01-01T06:00:00.000Z");
    expect(
      store.setGovernor({ pausedUntil: until, pickupPausedUntil: pickup, backoffLevel: 2 }),
    ).toEqual({
      pausedUntil: until,
      pickupPausedUntil: pickup,
      backoffLevel: 2,
      manualPause: false,
    });
    expect(store.setGovernor({ pausedUntil: null })).toEqual({
      pausedUntil: null,
      pickupPausedUntil: pickup,
      backoffLevel: 2,
      manualPause: false,
    });
  });

  it("holds the dashboard's manual pause until it is cleared", () => {
    const store = StateStore.inMemory();
    expect(store.setGovernor({ manualPause: true }).manualPause).toBe(true);
    expect(store.setGovernor({ backoffLevel: 1 }).manualPause).toBe(true);
    expect(store.setGovernor({ manualPause: false }).manualPause).toBe(false);
  });
});

describe("instance lease", () => {
  it("lets one holder at a time own the database until its heartbeat goes stale", () => {
    const time = clock();
    const store = StateStore.inMemory({ now: time.now });

    expect(store.acquireLease("first", 60_000)).toEqual({ ok: true });
    expect(store.acquireLease("second", 60_000)).toEqual({ ok: false, holder: "first" });

    time.advance(30_000);
    expect(store.acquireLease("first", 60_000)).toEqual({ ok: true });
    time.advance(59_000);
    expect(store.acquireLease("second", 60_000)).toEqual({ ok: false, holder: "first" });

    time.advance(2_000);
    expect(store.acquireLease("second", 60_000)).toEqual({ ok: true });
    expect(store.acquireLease("first", 60_000)).toEqual({ ok: false, holder: "second" });
  });

  it("frees the lease on release, but only for its holder", () => {
    const store = StateStore.inMemory();
    store.acquireLease("first", 60_000);
    store.releaseLease("second");
    expect(store.acquireLease("second", 60_000).ok).toBe(false);
    store.releaseLease("first");
    expect(store.acquireLease("second", 60_000).ok).toBe(true);
  });
});

describe("settings", () => {
  it("round-trips the dashboard config overrides", () => {
    const store = StateStore.inMemory();
    expect(store.getConfigOverrides()).toEqual({});
    store.setConfigOverrides({ pollIntervalS: 90, routing: { phases: {} } });
    store.setConfigOverrides({ pollIntervalS: 120 });
    expect(store.getConfigOverrides()).toEqual({ pollIntervalS: 120 });
  });
});

describe("run history", () => {
  it("lists runs by filter and totals cost per day and model", () => {
    const clock = { now: new Date("2026-03-01T23:00:00Z") };
    const store = StateStore.inMemory({ now: () => clock.now });
    const a = store.startRun({ repo: "org/a", issue: 1, phase: "implement", model: "opus" });
    store.finishRun(a, { exit: "success", costUsd: 2, inputTokens: 10, outputTokens: 1 });
    clock.now = new Date("2026-03-02T01:00:00Z");
    const b = store.startRun({ repo: "org/a", issue: 1, phase: "fix-ci" });
    store.finishRun(b, { exit: "error", costUsd: 0.5, error: "boom" });
    store.startRun({ repo: "org/b", issue: 2, phase: "implement", model: "opus" });

    expect(store.listRuns().map((r) => r.id)).toEqual([3, 2, 1]);
    expect(store.listRuns({ repo: "org/a", issue: 1, exit: "error" }).map((r) => r.id)).toEqual([
      2,
    ]);
    expect(store.listRuns({ exit: "running" }).map((r) => r.id)).toEqual([3]);
    expect(store.listRuns({ model: "opus", before: 3 }).map((r) => r.id)).toEqual([1]);
    expect(store.listRuns({ limit: 1 }).map((r) => r.id)).toEqual([3]);

    expect(store.costByDay(new Date("2026-03-01T00:00:00Z"))).toEqual([
      { day: "2026-03-01", runs: 1, costUsd: 2, inputTokens: 10, outputTokens: 1 },
      { day: "2026-03-02", runs: 2, costUsd: 0.5, inputTokens: 0, outputTokens: 0 },
    ]);
    expect(store.costByModel()).toEqual([
      { model: "opus", runs: 2, costUsd: 2, inputTokens: 10, outputTokens: 1 },
      { model: null, runs: 1, costUsd: 0.5, inputTokens: 0, outputTokens: 0 },
    ]);
  });
});

describe("run log", () => {
  it("records runs from start to finish, newest first", () => {
    const { now, advance } = clock();
    const store = StateStore.inMemory({ now });
    const first = store.startRun({
      repo: REPO,
      issue: 4,
      phase: "implement",
      model: "opus",
      effort: "high",
      maxTurns: 50,
    });
    advance(60_000);
    store.finishRun(first, {
      exit: "success",
      sessionId: "s1",
      costUsd: 1.25,
      inputTokens: 1000,
      outputTokens: 200,
    });
    const second = store.startRun({
      repo: "org/other",
      issue: 5,
      phase: "fix-ci",
      sessionId: "s2",
    });
    store.finishRun(second, { exit: "rate_limited", error: "usage limit" });
    store.startRun({ repo: REPO, issue: 4, phase: "rebase" });

    const runs = store.recentRuns();
    expect(runs.map((run) => run.phase)).toEqual(["rebase", "fix-ci", "implement"]);
    expect(runs[0]).toMatchObject({ exit: null, endedAt: null });
    expect(runs[1]).toMatchObject({ exit: "rate_limited", sessionId: "s2", error: "usage limit" });
    expect(runs[2]).toEqual({
      id: first,
      repo: REPO,
      issue: 4,
      phase: "implement",
      model: "opus",
      effort: "high",
      maxTurns: 50,
      sessionId: "s1",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:01:00.000Z",
      exit: "success",
      costUsd: 1.25,
      inputTokens: 1000,
      outputTokens: 200,
      error: undefined,
    });
    expect(store.recentRuns(10, "org/other").map((run) => run.id)).toEqual([second]);
    expect(store.recentRuns(1)).toHaveLength(1);
  });

  it("sums cost and tokens per repo, optionally since a time", () => {
    const { now, advance } = clock();
    const store = StateStore.inMemory({ now });
    const first = store.startRun({ repo: "org/b", issue: 1, phase: "implement" });
    store.finishRun(first, { exit: "success", costUsd: 1.5, inputTokens: 100, outputTokens: 10 });
    advance(3_600_000);
    const second = store.startRun({ repo: "org/a", issue: 2, phase: "implement" });
    store.finishRun(second, { exit: "success", costUsd: 0.25, inputTokens: 50, outputTokens: 5 });
    store.startRun({ repo: "org/a", issue: 2, phase: "fix-ci" }); // still running, no cost yet

    expect(store.costSummary()).toEqual({
      runs: 3,
      costUsd: 1.75,
      inputTokens: 150,
      outputTokens: 15,
      byRepo: [
        { repo: "org/a", runs: 2, costUsd: 0.25, inputTokens: 50, outputTokens: 5 },
        { repo: "org/b", runs: 1, costUsd: 1.5, inputTokens: 100, outputTokens: 10 },
      ],
    });
    expect(
      store.costSummary(new Date("2026-01-01T00:30:00.000Z")).byRepo.map((r) => r.repo),
    ).toEqual(["org/a"]);
  });

  it("rejects finishing an unknown run", () => {
    expect(() => {
      StateStore.inMemory().finishRun(99, { exit: "error" });
    }).toThrow("no run with id 99");
  });
});
