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
    expect(StateStore.inMemory().getGovernor()).toEqual({ pausedUntil: null, backoffLevel: 0 });
  });

  it("stores and clears the pause", () => {
    const store = StateStore.inMemory();
    const until = new Date("2026-01-01T05:00:00.000Z");
    expect(store.setGovernor({ pausedUntil: until, backoffLevel: 2 })).toEqual({
      pausedUntil: until,
      backoffLevel: 2,
    });
    expect(store.setGovernor({ pausedUntil: null })).toEqual({
      pausedUntil: null,
      backoffLevel: 2,
    });
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

  it("rejects finishing an unknown run", () => {
    expect(() => {
      StateStore.inMemory().finishRun(99, { exit: "error" });
    }).toThrow("no run with id 99");
  });
});
