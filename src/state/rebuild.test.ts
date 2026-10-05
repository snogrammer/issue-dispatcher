import { describe, expect, it } from "vitest";

import type { Issue, PullRequest } from "../gitea/types.js";
import { orderStack, rebuildFromGitea, type RebuildClient } from "./rebuild.js";
import { StateStore } from "./store.js";

const REPO = { owner: "org", name: "repo" };
const OPTIONS = { repos: [REPO], botUsername: "bot", labelPrefix: "claude" };

function issue(
  number: number,
  labels: string[],
  createdAt = `2026-01-0${String(number)}T00:00:00Z`,
  assignees = ["bot"],
) {
  return {
    number,
    labels: labels.map((name, id) => ({ id, name })),
    assignees: assignees.map((login, id) => ({ id, login })),
    created_at: createdAt,
  } as Issue;
}
function pull(number: number, head: string, base = "main") {
  return { number, head: { ref: head }, base: { ref: base } } as PullRequest;
}

function fakeClient(issues: Issue[], pulls: PullRequest[] = []) {
  const calls: unknown[] = [];
  const client: RebuildClient = {
    listIssues: (repo, filter) => {
      calls.push(["listIssues", repo, filter]);
      return Promise.resolve(issues);
    },
    listPulls: (repo, filter) => {
      calls.push(["listPulls", repo, filter]);
      return Promise.resolve(pulls);
    },
  };
  return { client, calls };
}

describe("rebuildFromGitea", () => {
  it("restores an empty store from labels and open PRs", async () => {
    const store = StateStore.inMemory();
    const { client, calls } = fakeClient(
      [issue(4, ["type:feature", "claude:in-review"])],
      [
        pull(12, "claude/4-x-part-2", "claude/4-x"),
        pull(11, "claude/4-x"),
        pull(13, "claude/9-other"),
      ],
    );

    const report = await rebuildFromGitea(store, client, OPTIONS);

    expect(calls[0]).toEqual([
      "listIssues",
      REPO,
      { assignee: "bot", labels: ["claude:working", "claude:in-review", "claude:blocked"] },
    ]);
    expect(report).toEqual({
      restored: [{ repo: "org/repo", issue: 4, state: "in-review", prStack: [11, 12] }],
      released: [],
      conflicts: [],
    });
    expect(store.getWork("org/repo", 4)).toMatchObject({
      state: "in-review",
      branch: "claude/4-x",
      prStack: [11, 12],
    });
  });

  it("ignores issues without a state label (Gitea drops unknown label filters)", async () => {
    const store = StateStore.inMemory();
    const { client } = fakeClient([issue(17, ["human", "type:docs"])]);

    const report = await rebuildFromGitea(store, client, OPTIONS);

    expect(report.restored).toEqual([]);
    expect(store.activeIssue("org/repo")).toBeNull();
  });

  it("ignores labeled issues not assigned to the bot even if the server returns them", async () => {
    const store = StateStore.inMemory();
    const { client } = fakeClient([issue(8, ["claude:working"], undefined, ["someone"])]);
    const report = await rebuildFromGitea(store, client, OPTIONS);
    expect(report.restored).toEqual([]);
    expect(store.activeIssue("org/repo")).toBeNull();
  });

  it("keeps the session and fix attempts of the same issue, with Gitea's state", async () => {
    const store = StateStore.inMemory();
    store.claim("org/repo", 4, { branch: "claude/4-mine" });
    store.updateWork("org/repo", 4, { sessionId: "s1", fixAttempts: 2, prStack: [11] });
    const { client } = fakeClient([issue(4, ["claude:blocked"])]);

    await rebuildFromGitea(store, client, OPTIONS);

    expect(store.getWork("org/repo", 4)).toMatchObject({
      state: "blocked",
      branch: "claude/4-mine",
      sessionId: "s1",
      fixAttempts: 2,
      prStack: [],
    });
  });

  it("releases the slot when the issue is no longer active in Gitea", async () => {
    const store = StateStore.inMemory();
    store.claim("org/repo", 4);
    const { client, calls } = fakeClient([]);

    const report = await rebuildFromGitea(store, client, OPTIONS);

    expect(report.released).toEqual([{ repo: "org/repo", issue: 4 }]);
    expect(store.activeIssue("org/repo")).toBeNull();
    expect(store.getWork("org/repo", 4)?.state).toBe("abandoned");
    expect(calls.some((call) => (call as unknown[])[0] === "listPulls")).toBe(false);
  });

  it("switches the slot to the issue Gitea shows as active", async () => {
    const store = StateStore.inMemory();
    store.claim("org/repo", 4);
    const { client } = fakeClient([issue(5, ["claude:working"])]);

    const report = await rebuildFromGitea(store, client, OPTIONS);

    expect(report.released).toEqual([{ repo: "org/repo", issue: 4 }]);
    expect(store.activeIssue("org/repo")).toBe(5);
  });

  it("keeps the oldest issue when several carry state labels", async () => {
    const store = StateStore.inMemory();
    const { client } = fakeClient([
      issue(7, ["claude:working"], "2026-03-01T00:00:00Z"),
      issue(6, ["claude:in-review"], "2026-02-01T00:00:00Z"),
    ]);

    const report = await rebuildFromGitea(store, client, OPTIONS);

    expect(report.conflicts).toEqual([{ repo: "org/repo", issues: [6, 7], kept: 6 }]);
    expect(store.activeIssue("org/repo")).toBe(6);
  });

  it("handles several repos independently", async () => {
    const store = StateStore.inMemory();
    store.claim("org/b", 1);
    const client: RebuildClient = {
      listIssues: (repo) =>
        Promise.resolve(repo.name === "a" ? [issue(3, ["claude:working"])] : []),
      listPulls: () => Promise.resolve([]),
    };

    const report = await rebuildFromGitea(store, client, {
      ...OPTIONS,
      repos: [
        { owner: "org", name: "a" },
        { owner: "org", name: "b" },
      ],
    });

    expect(report.restored.map((r) => r.repo)).toEqual(["org/a"]);
    expect(report.released).toEqual([{ repo: "org/b", issue: 1 }]);
  });
});

describe("orderStack", () => {
  it("orders PRs bottom-up by base/head chaining", () => {
    const stack = orderStack([pull(3, "c", "b"), pull(1, "a", "main"), pull(2, "b", "a")]);
    expect(stack.map((p) => p.number)).toEqual([1, 2, 3]);
  });

  it("appends PRs that don't chain, oldest first", () => {
    const stack = orderStack([pull(5, "x", "main"), pull(2, "a", "main"), pull(4, "b", "a")]);
    expect(stack.map((p) => p.number)).toEqual([2, 4, 5]);
  });

  it("returns an empty stack for no PRs", () => {
    expect(orderStack([])).toEqual([]);
  });
});
