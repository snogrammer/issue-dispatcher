import { describe, expect, it } from "vitest";

import { A, B, cycle, report, REVIEWER, setup } from "../../test/helpers/engine-fakes.js";
import { logTail, prLifecycle } from "./pr-lifecycle.js";

/** An engine using the PR lifecycle, with issue #1 assigned in org/a. */
function withPrs(env: Record<string, string> = {}) {
  const fixture = setup({ REPOS: A, ...env }, (deps) => prLifecycle(deps));
  fixture.gitea.addIssue(A, { number: 1, title: "Add login" });
  return fixture;
}

/** Pick up #1 and run implement: PR #2 opens with head sha-1. */
async function toReview(fixture: ReturnType<typeof withPrs>) {
  await cycle(fixture.engine);
  expect(fixture.store.getWork(A, 1)?.state).toBe("in-review");
}

describe("opening pull requests", () => {
  it("opens a PR that closes the issue and lists Claude's decisions", async () => {
    const fixture = withPrs();
    fixture.runner.script({
      report: report(1, {
        decisions: [
          {
            question: "Session store?",
            chosen: "cookies",
            alternatives: ["redis"],
            rationale: "No new infra.",
            needsConfirmation: true,
          },
        ],
      }),
    });
    await toReview(fixture);

    // The decision to confirm was filed as question #2, so the PR is #3.
    expect(fixture.gitea.issue(A, 2).body).toContain(
      "### Decision to confirm: Session store?\n\n**Why:** No new infra.\n\n- [x] cookies (chosen)\n- [ ] redis",
    );
    const pull = fixture.gitea.pull(A, 3);
    expect(pull).toMatchObject({
      title: "T",
      head: { ref: "claude/1-x", sha: "sha-1" },
      base: { ref: "main" },
    });
    expect(pull.body).toContain("Closes #1");
    expect(pull.body).toContain(
      "- **Session store?** → cookies. No new infra. (Alternatives: redis.) _Needs confirmation._",
    );
    expect(fixture.store.getWork(A, 1)).toMatchObject({ prStack: [3], lastSha: "sha-1" });
    expect(fixture.gitea.labelNames(A, 1)).toEqual(["claude:in-review"]);
    expect(fixture.gitea.commentsOn(A, 1).at(-1)).toContain("Opened #3.");
  });

  it("owns the issue link: strips Claude's closing keywords for this issue only", async () => {
    const fixture = withPrs();
    fixture.runner.script({
      report: report(1, {
        branches: [
          {
            name: "claude/1-x",
            title: "Part 1",
            body: "one\n\nCloses #1\n\nAlso fixes #12 and resolves #1.",
          },
          { name: "claude/1-x-part-2", title: "Part 2", body: "two\n\nFixes #1" },
        ],
      }),
    });
    await toReview(fixture);

    const lower = fixture.gitea.pull(A, 2).body;
    expect(lower).not.toMatch(/closes #1\b/i);
    expect(lower).not.toMatch(/resolves #1\b/i);
    expect(lower).toContain("fixes #12");
    expect(lower).toContain("Part of #1 (1 of 2 in a stack).");
    const top = fixture.gitea.pull(A, 3).body;
    expect(top).not.toMatch(/fixes #1\b/i);
    expect(top.match(/Closes #1/g)).toHaveLength(1);
  });

  it("has exactly one Closes line on a single PR", async () => {
    const fixture = withPrs();
    fixture.runner.script({
      report: report(1, {
        branches: [{ name: "claude/1-x", title: "T", body: "Done.\n\nCloses #1" }],
      }),
    });
    await toReview(fixture);
    expect(fixture.gitea.pull(A, 2).body.match(/Closes #1/g)).toHaveLength(1);
  });

  it("opens a stack where only the top PR closes the issue", async () => {
    const fixture = withPrs();
    fixture.runner.script({
      report: report(1, {
        branches: [
          { name: "claude/1-x", title: "Part 1", body: "one" },
          { name: "claude/1-x-part-2", title: "Part 2", body: "two" },
        ],
      }),
    });
    await toReview(fixture);

    expect(fixture.gitea.pull(A, 2)).toMatchObject({ base: { ref: "main" } });
    expect(fixture.gitea.pull(A, 2).body).toContain("Part of #1 (1 of 2 in a stack).");
    expect(fixture.gitea.pull(A, 2).body).not.toContain("Closes #1");
    expect(fixture.gitea.pull(A, 3)).toMatchObject({ base: { ref: "claude/1-x" } });
    expect(fixture.gitea.pull(A, 3).body).toContain("Closes #1");
    expect(fixture.store.getWork(A, 1)?.prStack).toEqual([2, 3]);
  });
});

describe("merging on green CI", () => {
  it("waits while CI is pending, then merges, closes the issue and moves on", async () => {
    const fixture = withPrs();
    const { gitea, engine, store, runner } = fixture;
    await toReview(fixture);
    gitea.setStatus("sha-1", "pending");
    await cycle(engine);
    expect(gitea.merges).toEqual([]);

    gitea.setStatus("sha-1", "success", "success");
    gitea.addIssue(A, { number: 9 });
    await cycle(engine);

    expect(gitea.merges).toEqual([
      {
        repo: A,
        pull: 2,
        input: { style: "merge", headCommitId: "sha-1", deleteBranch: true },
      },
    ]);
    expect(gitea.issue(A, 1).state).toBe("closed");
    expect(gitea.labelNames(A, 1)).toEqual([]);
    expect(store.getWork(A, 1)?.state).toBe("done");
    expect(gitea.commentsOn(A, 1).at(-1)).toBe("Merged #2. Done.");
    expect(runner.requests).toHaveLength(1);

    // The next assigned issue is picked up on the following poll.
    await engine.tick();
    expect(store.activeIssue(A)).toBe(9);
  });

  it("uses MERGE_STYLE when set", async () => {
    const fixture = withPrs({ MERGE_STYLE: "squash" });
    await toReview(fixture);
    fixture.gitea.setStatus("sha-1", "success");
    await cycle(fixture.engine);
    expect(fixture.gitea.merges[0]?.input.style).toBe("squash");
  });

  it("merges a stack bottom-up, retargeting the next PR before deleting the merged branch", async () => {
    const fixture = withPrs();
    const { gitea, engine, store } = fixture;
    fixture.runner.script({
      report: report(1, {
        branches: [
          { name: "claude/1-x", title: "Part 1", body: "" },
          { name: "claude/1-x-part-2", title: "Part 2", body: "" },
        ],
      }),
    });
    await toReview(fixture);
    gitea.setStatus("sha-1", "success");
    await cycle(engine);

    expect(gitea.merges[0]).toMatchObject({ pull: 2, input: { deleteBranch: false } });
    const retarget = gitea.calls.indexOf(`retarget ${A}#3 -> main`);
    const deleted = gitea.calls.indexOf(`deleteBranch ${A} claude/1-x`);
    expect(retarget).toBeGreaterThan(-1);
    expect(deleted).toBeGreaterThan(retarget);
    // The next branch is rebased onto main, dropping the merged PR's commits.
    expect(fixture.workspace(A).rebases).toEqual([["claude/1-x-part-2", "main", "sha-1"]]);
    const rebased = fixture.workspace(A).heads.get("claude/1-x-part-2");
    expect(gitea.pull(A, 3).head.sha).toBe(rebased);
    expect(store.getWork(A, 1)).toMatchObject({
      prStack: [3],
      lastSha: rebased,
      rebaseFrom: null,
      state: "in-review",
    });
    expect(gitea.issue(A, 1).state).toBe("open");
    expect(gitea.commentsOn(A, 1).at(-1)).toContain("Next in the stack: #3, now targeting `main`.");
    expect(gitea.commentsOn(A, 3).at(-1)).toBe(
      "Rebased onto `main` now that the PR below it merged.",
    );

    gitea.setStatus(rebased ?? "", "success");
    await cycle(engine);
    expect(gitea.merges[1]).toMatchObject({ pull: 3, input: { deleteBranch: true } });
    expect(store.getWork(A, 1)?.state).toBe("done");
  });

  it("finishes when a human merged the PR", async () => {
    const fixture = withPrs();
    await toReview(fixture);
    Object.assign(fixture.gitea.pull(A, 2), { merged: true, state: "closed" });
    await cycle(fixture.engine);
    expect(fixture.store.getWork(A, 1)?.state).toBe("done");
    expect(fixture.gitea.merges).toEqual([]);
  });
});

describe("fixing CI", () => {
  it("runs fix-ci with the failing job's log, then merges once green", async () => {
    const fixture = withPrs();
    const { gitea, engine, runner, store } = fixture;
    await toReview(fixture);
    gitea.setStatus("sha-1", "failure");
    gitea.addFailedRun(
      A,
      "sha-1",
      "check",
      "2026-06-01T00:00:00.1234Z \u001b[31mFAIL\u001b[0m src/a.test.ts\n2026-06-01T00:00:01Z expected 2, got 3",
    );

    await cycle(engine);

    const fix = runner.requests.at(-1);
    expect(fix).toMatchObject({ phase: "fix-ci", issue: 1, resumeSessionId: "session-1" });
    expect(fix?.prompt).toContain("FAIL src/a.test.ts\nexpected 2, got 3");
    expect(store.getWork(A, 1)).toMatchObject({ fixAttempts: 1, lastSha: "sha-2" });
    expect(gitea.commentsOn(A, 2).at(-1)).toContain("Pushed sha-2 (fix-ci, round 1 of 2).");

    gitea.setStatus("sha-2", "success");
    await cycle(engine);
    expect(gitea.merges[0]).toMatchObject({ pull: 2, input: { headCommitId: "sha-2" } });
  });

  it("falls back to commit status descriptions when there are no Actions logs", async () => {
    const fixture = withPrs();
    await toReview(fixture);
    fixture.gitea.setStatus("sha-1", "failure");
    await cycle(fixture.engine);
    expect(fixture.runner.requests.at(-1)?.prompt).toContain(
      "https://ci.example.com/sha-1/0\ncheck failure",
    );
  });

  it("files a ticket for the human after MAX_FIX_ATTEMPTS rounds (default 2)", async () => {
    const fixture = withPrs();
    const { gitea, engine, store } = fixture;
    await toReview(fixture);
    for (const sha of ["sha-1", "sha-2"]) {
      gitea.setStatus(sha, "failure");
      await cycle(engine);
    }
    gitea.setStatus("sha-3", "failure");
    gitea.addFailedRun(A, "sha-3", "lint", "ruff: E501 line too long");
    await cycle(engine);

    expect(fixture.runner.requests.filter((r) => r.phase === "fix-ci")).toHaveLength(2);
    expect(store.getWork(A, 1)?.state).toBe("blocked");
    const [ticket] = gitea.filedIssues(A);
    expect(ticket).toMatchObject({
      number: 3,
      title: "Questions for #1: Add login",
      assignees: [{ login: REVIEWER }],
    });
    expect(ticket?.body).toContain(
      "### 🛑 Blocking: Help needed on #1: CI is still failing on #2 after 2 rounds",
    );
    expect(ticket?.labels.map((l) => l.name)).toEqual(["claude:question"]);
    expect(ticket?.body).toContain("(head sha-3)");
    expect(ticket?.body).toMatch(/Failing jobs:\n\n- \[lint\]\(.+\)/);
    expect(gitea.dependencies.get(`${A}#1`)).toEqual([3]);
    expect(gitea.commentsOn(A, 1).at(-1)).toContain(
      `@${REVIEWER} Help needed on #1: CI is still failing on #2 after 2 rounds. See #3`,
    );

    // Still blocked on the next poll: no third round, no second ticket.
    await cycle(engine);
    expect(fixture.runner.requests.filter((r) => r.phase === "fix-ci")).toHaveLength(2);
    expect(gitea.filedIssues(A)).toHaveLength(1);
  });

  it("continues with the human's answer and fresh fix rounds", async () => {
    const fixture = withPrs({ MAX_FIX_ATTEMPTS: "1" });
    const { gitea, engine, store, runner } = fixture;
    await toReview(fixture);
    gitea.setStatus("sha-1", "failure");
    await cycle(engine);
    gitea.setStatus("sha-2", "failure");
    await cycle(engine);
    expect(store.getWork(A, 1)).toMatchObject({ state: "blocked", fixAttempts: 1 });

    gitea.commentAs(A, 3, REVIEWER, "The test fixture is stale; regenerate it.");
    await cycle(engine);

    const resumed = runner.requests.at(-1);
    expect(resumed?.phase).toBe("address-review");
    expect(resumed?.prompt).toContain("regenerate it");
    expect(store.getWork(A, 1)).toMatchObject({ state: "in-review", fixAttempts: 0 });
    // Answered: no longer blocking #1, but kept open for anything else on it.
    expect(gitea.issue(A, 3).state).toBe("open");
    expect(gitea.dependencies.get(`${A}#1`)).toEqual([]);

    // The next red CI gets a fix round again instead of another ticket.
    gitea.setStatus("sha-3", "failure");
    await cycle(engine);
    expect(runner.requests.at(-1)?.phase).toBe("fix-ci");
    expect(gitea.filedIssues(A)).toHaveLength(1);
  });

  it("waits for every CI run on the head to finish before a fix round", async () => {
    const fixture = withPrs();
    const { gitea, engine, runner } = fixture;
    await toReview(fixture);
    gitea.setStatus("sha-1", "failure");
    gitea.addFailedRun(A, "sha-1", "lint", "E501");
    gitea.addRun(A, "sha-1", "in_progress");

    await cycle(engine);
    expect(runner.requests.map((r) => r.phase)).toEqual(["implement"]);

    for (const run of gitea.runs) {
      if (run.status === "in_progress")
        Object.assign(run, { status: "completed", conclusion: "success" });
    }
    await cycle(engine);
    expect(runner.requests.map((r) => r.phase)).toEqual(["implement", "fix-ci"]);
  });

  it("blocks when a fix round pushes no new commit", async () => {
    const fixture = withPrs();
    await toReview(fixture);
    fixture.workspace(A).stuck = true;
    fixture.gitea.setStatus("sha-1", "failure");
    await cycle(fixture.engine);
    expect(fixture.store.getWork(A, 1)?.state).toBe("blocked");
    expect(fixture.gitea.commentsOn(A, 1).at(-1)).toContain(
      "The fix-ci round on #2 made no new commits",
    );
  });
});

describe("without CI", () => {
  it("waits for a status, then blocks after CI_NO_STATUS_TIMEOUT_MIN", async () => {
    const fixture = withPrs({ CI_NO_STATUS_TIMEOUT_MIN: "15" });
    const { gitea, engine, store, clock } = fixture;
    await toReview(fixture);

    clock.now = new Date("2026-06-01T00:14:00Z");
    await cycle(engine);
    expect(store.getWork(A, 1)?.state).toBe("in-review");

    clock.now = new Date("2026-06-01T00:16:00Z");
    await cycle(engine);
    expect(store.getWork(A, 1)?.state).toBe("blocked");
    expect(gitea.commentsOn(A, 1).at(-1)).toContain("No CI status was reported for sha-1 on #2");
    expect(gitea.merges).toEqual([]);
  });

  it("treats a queued run with no commit status yet as pending, not missing CI", async () => {
    const fixture = withPrs({ CI_NO_STATUS_TIMEOUT_MIN: "15" });
    const { gitea, engine, store, clock } = fixture;
    await toReview(fixture);
    gitea.addRun(A, "sha-1", "queued");

    clock.now = new Date("2026-06-01T03:00:00Z");
    await cycle(engine);
    expect(store.getWork(A, 1)?.state).toBe("in-review");
    expect(gitea.merges).toEqual([]);
  });

  it("waits on CI that stays pending for hours instead of failing it", async () => {
    const fixture = withPrs();
    const { gitea, engine, store, clock, runner } = fixture;
    await toReview(fixture);
    gitea.setStatus("sha-1", "pending");

    clock.now = new Date("2026-06-01T08:00:00Z");
    await cycle(engine);
    expect(store.getWork(A, 1)?.state).toBe("in-review");
    expect(runner.requests.map((r) => r.phase)).toEqual(["implement"]);

    gitea.setStatus("sha-1", "success");
    await cycle(engine);
    expect(gitea.merges).toHaveLength(1);
  });

  it("merges without CI when REQUIRE_CI is off", async () => {
    const fixture = withPrs({ REQUIRE_CI: "false" });
    await toReview(fixture);
    await cycle(fixture.engine);
    expect(fixture.gitea.merges).toHaveLength(1);
  });
});

describe("humans on the PR", () => {
  it("merges on /merge from the reviewer, even with failing CI", async () => {
    const fixture = withPrs();
    await toReview(fixture);
    fixture.gitea.setStatus("sha-1", "failure");
    fixture.gitea.commentAs(A, 2, REVIEWER, "Looks fine to me.\n/merge");
    await cycle(fixture.engine);
    expect(fixture.gitea.merges).toHaveLength(1);
    expect(fixture.runner.requests.map((r) => r.phase)).toEqual(["implement"]);
  });

  it("ignores /merge from anyone else", async () => {
    const fixture = withPrs();
    await toReview(fixture);
    fixture.gitea.setStatus("sha-1", "failure");
    fixture.gitea.commentAs(A, 2, "someone", "/merge");
    await cycle(fixture.engine);
    expect(fixture.gitea.merges).toEqual([]);
  });

  it("addresses changes requested on the current head", async () => {
    const fixture = withPrs();
    const { gitea, engine, runner } = fixture;
    await toReview(fixture);
    gitea.setStatus("sha-1", "success");
    gitea.addReview(A, 2, {
      body: "A couple of things.",
      comments: [
        {
          id: 1,
          body: "Rename this.",
          path: "src/a.ts",
          user: { id: 1, login: REVIEWER },
          diff_hunk: "",
          created_at: "",
        },
      ],
    });

    await cycle(engine);

    expect(gitea.merges).toEqual([]);
    const round = runner.requests.at(-1);
    expect(round?.phase).toBe("address-review");
    expect(round?.prompt).toContain("A couple of things.");
    expect(round?.prompt).toContain('<untrusted source="review human on src/a.ts">');

    // The review was on sha-1; the new head sha-2 is green, so it merges.
    gitea.setStatus("sha-2", "success");
    await cycle(engine);
    expect(gitea.merges[0]?.input.headCommitId).toBe("sha-2");
  });

  it("blocks when the PR is closed without merging", async () => {
    const fixture = withPrs();
    await toReview(fixture);
    fixture.gitea.pull(A, 2).state = "closed";
    await cycle(fixture.engine);
    expect(fixture.store.getWork(A, 1)?.state).toBe("blocked");
    expect(fixture.gitea.commentsOn(A, 1).at(-1)).toContain("#2 was closed without being merged.");
  });
});

describe("stack rebases", () => {
  function stack() {
    const fixture = withPrs();
    fixture.runner.script({
      report: report(1, {
        branches: [
          { name: "claude/1-x", title: "Part 1", body: "" },
          { name: "claude/1-x-part-2", title: "Part 2", body: "" },
        ],
      }),
    });
    return fixture;
  }

  it("hands conflicts to a Claude rebase round with the merged base, then clears it", async () => {
    const fixture = stack();
    const { gitea, engine, runner, store, workspace } = fixture;
    await toReview(fixture);
    workspace(A).rebaseConflicts = true;
    runner.script({
      report: report(1, {
        branches: [{ name: "claude/1-x-part-2", title: "Part 2", body: "" }],
      }),
    });
    gitea.setStatus("sha-1", "success");

    await cycle(engine);

    const round = runner.requests.at(-1);
    expect(round).toMatchObject({ phase: "rebase", resumeSessionId: "session-1" });
    expect(round?.prompt).toContain("git rebase --onto origin/main sha-1 claude/1-x-part-2");
    // The round worked on the next PR's branch, not the merged one.
    expect(workspace(A).prepared.at(-1)).toEqual(["claude/1-x-part-2", "main"]);
    expect(store.getWork(A, 1)).toMatchObject({
      prStack: [3],
      branch: "claude/1-x-part-2",
      rebaseFrom: null,
      fixAttempts: 1,
    });
  });

  it("files a question when Claude can't resolve the conflicts", async () => {
    const fixture = stack();
    const { gitea, engine, runner, store, workspace } = fixture;
    await toReview(fixture);
    workspace(A).rebaseConflicts = true;
    runner.script({
      report: report(1, {
        outcome: "needs_human",
        branches: [],
        followups: [
          {
            title: "Which version of the login form wins?",
            body: "main changed the same lines.",
            blocking: true,
            options: ["Keep main's form", "Keep ours"],
          },
        ],
      }),
    });
    gitea.setStatus("sha-1", "success");

    await cycle(engine);

    expect(store.getWork(A, 1)).toMatchObject({ state: "blocked", rebaseFrom: "sha-1" });
    const question = gitea.filedIssues(A).at(-1);
    expect(question?.title).toBe("Questions for #1: Add login");
    expect(question?.body).toContain("- [x] Keep main's form (recommended)\n- [ ] Keep ours");
    expect(gitea.dependencies.get(`${A}#1`)).toEqual([question?.number]);
  });

  it("waits for a session before a conflicted rebase, keeping it pending", async () => {
    const fixture = withPrs({ REPOS: `${A},${B}` });
    const { gitea, engine, runner, store, workspace } = fixture;
    fixture.runner.script({
      report: report(1, {
        branches: [
          { name: "claude/1-x", title: "Part 1", body: "" },
          { name: "claude/1-x-part-2", title: "Part 2", body: "" },
        ],
      }),
    });
    await toReview(fixture);
    workspace(A).rebaseConflicts = true;
    gitea.addIssue(B, { number: 9 });
    runner.script("hold");
    await engine.tick(); // B takes the only session while A's CI is pending

    gitea.setStatus("sha-1", "success");
    await engine.tick(); // A merges #2; its rebase conflicts but can't start yet
    expect(store.getWork(A, 1)).toMatchObject({ rebaseFrom: "sha-1", fixAttempts: 0 });

    runner.release();
    await engine.idle();
    await cycle(engine);
    expect(runner.requests.at(-1)).toMatchObject({ issue: 1, phase: "rebase" });
  });

  it("clears a pending rebase that already happened", async () => {
    const fixture = stack();
    const { gitea, engine, store, workspace } = fixture;
    await toReview(fixture);
    workspace(A).rebasedAway.add("sha-1");
    gitea.setStatus("sha-1", "success");
    await cycle(engine);
    expect(workspace(A).rebases).toEqual([]);
    expect(store.getWork(A, 1)?.rebaseFrom).toBeNull();
  });
});

describe("follow-up rounds", () => {
  it("blocks clearly when a round doesn't report the PR's branch", async () => {
    const fixture = withPrs();
    const { gitea, engine, runner, store } = fixture;
    await toReview(fixture);
    runner.script({
      report: report(1, { branches: [{ name: "claude/1-other", title: "T", body: "" }] }),
    });
    gitea.setStatus("sha-1", "failure");
    await cycle(engine);
    expect(store.getWork(A, 1)?.state).toBe("blocked");
    expect(gitea.commentsOn(A, 1).at(-1)).toContain(
      "The fix-ci round on #2 didn't report its branch `claude/1-x`",
    );
  });
});

describe("merge problems", () => {
  it("sends a conflicted PR to a Claude rebase round, then asks the human after the cap", async () => {
    const fixture = withPrs({ MAX_FIX_ATTEMPTS: "1" });
    const { gitea, engine, runner, store } = fixture;
    await toReview(fixture);
    gitea.pull(A, 2).mergeable = false;
    gitea.setStatus("sha-1", "success");

    await cycle(engine);
    const round = runner.requests.at(-1);
    expect(round).toMatchObject({ phase: "rebase", resumeSessionId: "session-1" });
    expect(round?.prompt).toContain("claude/1-x conflicts with main. Rebase it onto origin/main");
    expect(fixture.workspace(A).prepared.at(-1)).toEqual(["claude/1-x", "main"]);
    expect(store.getWork(A, 1)?.fixAttempts).toBe(1);

    // Still conflicting after the round (sha-2): the cap is reached.
    gitea.setStatus("sha-2", "success");
    await cycle(engine);
    expect(store.getWork(A, 1)?.state).toBe("blocked");
    expect(gitea.commentsOn(A, 1).at(-1)).toContain(
      "Help needed on #1: #2 still conflicts with `main` after 1 rounds.",
    );
  });

  it("blocks with Gitea's reason when the merge is refused", async () => {
    const fixture = withPrs();
    await toReview(fixture);
    fixture.gitea.setStatus("sha-1", "success");
    fixture.gitea.mergeFailure = { status: 405, message: "Not all required status checks passed" };
    await cycle(fixture.engine);
    // The first refusal may be transient (seen live), so it retries once.
    expect(fixture.store.getWork(A, 1)?.state).toBe("in-review");
    await cycle(fixture.engine);
    expect(fixture.store.getWork(A, 1)?.state).toBe("blocked");
    expect(fixture.gitea.commentsOn(A, 1).at(-1)).toContain(
      "Merging #2 failed: Not all required status checks passed",
    );
  });
});

describe("transient merge refusals", () => {
  it("merges on the next poll when the first attempt is refused", async () => {
    const fixture = withPrs();
    await toReview(fixture);
    fixture.gitea.setStatus("sha-1", "success");
    fixture.gitea.mergeFailure = { status: 405, message: "Please try again later" };
    await cycle(fixture.engine);
    expect(fixture.gitea.merges).toEqual([]);

    fixture.gitea.mergeFailure = undefined;
    await cycle(fixture.engine);
    expect(fixture.gitea.merges).toHaveLength(1);
    expect(fixture.store.getWork(A, 1)?.state).toBe("done");
  });
});

describe("logTail", () => {
  it("keeps the last lines without timestamps or color codes", () => {
    const log = Array.from(
      { length: 200 },
      (_, i) => `2026-06-01T00:00:00.5Z \u001b[32mline ${String(i)}\u001b[0m`,
    ).join("\n");
    const tail = logTail(log).split("\n");
    expect(tail).toHaveLength(150);
    expect(tail[0]).toBe("line 50");
    expect(tail.at(-1)).toBe("line 199");
  });
});

describe("pull requests assigned to the bot", () => {
  function assigned(options: { mergeable?: boolean } = {}) {
    const fixture = setup({ REPOS: A }, (deps) => prLifecycle(deps));
    fixture.gitea.addAssignedPull(A, { number: 7, head: "feature/x", ...options });
    return fixture;
  }

  it("takes the PR into review and merges it once CI passes", async () => {
    const { gitea, engine, store, runner } = assigned();

    await cycle(engine);

    expect(store.getWork(A, 7)).toMatchObject({
      state: "in-review",
      branch: "feature/x",
      prStack: [7],
    });
    expect(gitea.labelNames(A, 7)).toEqual(["claude:in-review"]);
    expect(gitea.commentsOn(A, 7)[0]).toContain("Picked up by bot.");
    expect(runner.requests).toEqual([]);

    gitea.setStatus(gitea.pull(A, 7).head.sha, "success");
    await cycle(engine);

    expect(gitea.merges.map((merge) => merge.pull)).toEqual([7]);
    expect(store.activeIssue(A)).toBeNull();
    expect(gitea.labelNames(A, 7)).toEqual([]);
  });

  it("hands a conflicting PR to a rebase round on its own branch", async () => {
    const { gitea, engine, runner, workspace } = assigned({ mergeable: false });
    runner.script({
      report: report(7, { branches: [{ name: "feature/x", title: "Pull 7", body: "" }] }),
    });

    await cycle(engine);
    await cycle(engine);

    expect(runner.requests.at(-1)).toMatchObject({ phase: "rebase" });
    expect(workspace(A).prepared.at(-1)).toEqual(["feature/x", "main"]);
    expect(gitea.merges).toEqual([]);
  });

  it("works on assigned PRs before issues, and lists the rest in the queue", async () => {
    const { gitea, engine, store } = assigned();
    gitea.addIssue(A, { number: 3 });
    gitea.addIssue(A, { number: 4, labels: ["priority:high"] });

    await engine.tick();
    await engine.idle();

    expect(store.activeIssue(A)).toBe(7);
    expect(engine.snapshot().queue).toEqual([
      { repo: A, number: 4, title: "Issue 4", pullRequest: false, priority: "high" },
      { repo: A, number: 3, title: "Issue 3", pullRequest: false, priority: "normal" },
    ]);
  });

  it("restores the PR after a restart instead of picking it up again", async () => {
    const { gitea, make, store } = assigned();
    await cycle(make());
    const comments = gitea.commentsOn(A, 7).length;
    store.release(A, "abandoned");
    store.claim(A, 99);
    store.release(A, "abandoned");

    const restarted = make();
    await restarted.start();
    await restarted.stop();

    expect(store.getWork(A, 7)).toMatchObject({ state: "in-review", prStack: [7] });
    expect(gitea.commentsOn(A, 7)).toHaveLength(comments);
  });
});
