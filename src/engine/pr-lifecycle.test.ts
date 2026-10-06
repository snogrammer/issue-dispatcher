import { describe, expect, it } from "vitest";

import { A, cycle, report, REVIEWER, setup } from "../../test/helpers/engine-fakes.js";
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
    expect(fixture.gitea.issue(A, 2).title).toBe("Confirm decision on #1: Session store?");
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
    expect(store.getWork(A, 1)).toMatchObject({
      prStack: [3],
      lastSha: "sha-2",
      state: "in-review",
    });
    expect(gitea.issue(A, 1).state).toBe("open");
    expect(gitea.commentsOn(A, 1).at(-1)).toContain("Next in the stack: #3, now targeting `main`.");

    gitea.setStatus("sha-2", "success");
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
    expect(gitea.commentsOn(A, 2).at(-1)).toContain("Pushed sha-2 (fix-ci, round 1 of 3).");

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

  it("blocks after MAX_FIX_ATTEMPTS rounds", async () => {
    const fixture = withPrs({ MAX_FIX_ATTEMPTS: "2" });
    const { gitea, engine, store } = fixture;
    await toReview(fixture);
    for (const sha of ["sha-1", "sha-2", "sha-3"]) {
      gitea.setStatus(sha, "failure");
      await cycle(engine);
    }
    expect(store.getWork(A, 1)?.state).toBe("blocked");
    expect(gitea.commentsOn(A, 1).at(-1)).toContain(
      `@${REVIEWER} CI is still failing on #2 after 2 rounds.`,
    );
    expect(fixture.runner.requests.filter((r) => r.phase === "fix-ci")).toHaveLength(2);
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

describe("merge problems", () => {
  it("blocks when the PR has conflicts", async () => {
    const fixture = withPrs();
    await toReview(fixture);
    fixture.gitea.pull(A, 2).mergeable = false;
    fixture.gitea.setStatus("sha-1", "success");
    await cycle(fixture.engine);
    expect(fixture.gitea.commentsOn(A, 1).at(-1)).toContain(
      "#2 can't be merged automatically (it conflicts with `main`).",
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
