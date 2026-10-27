import { describe, expect, it } from "vitest";

import { A, BOT, cycle, REVIEWER, setup } from "../../test/helpers/engine-fakes.js";
import { prLifecycle } from "../engine/pr-lifecycle.js";
import { BugsinkDesk, FROZEN_LABEL, type BugsinkApi } from "./intake.js";

const ISSUE_ID = "ceb3928f-76a2-45cb-9b24-a3a96a4503d7";

const BUGSINK_ENV = {
  BUGSINK_URL: "https://bugsink.example.com",
  BUGSINK_API_TOKEN: "bugsink-token",
  BUGSINK_WEBHOOK_SECRET: "s".repeat(32),
  BUGSINK_PROJECTS: `4=${A}`,
};

function alert(reason: string, overrides: Record<string, unknown> = {}) {
  return {
    id: ISSUE_ID,
    friendly_id: "MOONEXT-1",
    project: 4,
    project_name: "moonext",
    title: "Error: EACCES: permission denied, mkdir",
    url: "https://bugsink.example.com/issues/issue/ceb3928f/",
    calculated_type: "Error",
    calculated_value: "EACCES: permission denied, mkdir",
    transaction: "GET /_next/image",
    first_seen: "2026-10-25T22:37:13Z",
    last_seen: "2026-10-26T00:15:48Z",
    digested_event_count: 2,
    alert_reason: reason,
    ...overrides,
  };
}

class FakeBugsink implements BugsinkApi {
  readonly calls: string[] = [];
  readonly comments: string[] = [];
  failResolve = false;
  stacktrace: string | undefined = "# Error\nEACCES: permission denied, mkdir";

  resolve(id: string): Promise<void> {
    if (this.failResolve) return Promise.reject(new Error("bugsink down"));
    this.calls.push(`resolve ${id}`);
    return Promise.resolve();
  }

  mute(id: string): Promise<void> {
    this.calls.push(`mute ${id}`);
    return Promise.resolve();
  }

  comment(id: string, text: string): Promise<void> {
    this.comments.push(text);
    return Promise.resolve();
  }

  latestStacktrace(): Promise<string | undefined> {
    return Promise.resolve(this.stacktrace);
  }
}

/** The engine with the real PR lifecycle, plus the desk sweeping every poll. */
function withDesk(env: Record<string, string> = {}) {
  const fixture = setup({ REPOS: A, ...BUGSINK_ENV, ...env }, (deps) => prLifecycle(deps));
  const bugsink = new FakeBugsink();
  const desk = new BugsinkDesk({
    config: fixture.config,
    gitea: fixture.gitea,
    bugsink,
    store: fixture.store,
    now: () => fixture.clock.now,
  });
  const engine = fixture.make({ sweeps: [() => desk.sweep()] });
  const later = () => {
    fixture.clock.now = new Date(fixture.clock.now.getTime() + 60_000);
  };
  const send = async (payload: unknown) => {
    const receipt = desk.receive(payload);
    await desk.idle();
    return receipt;
  };
  return { ...fixture, engine, bugsink, desk, later, send };
}

/** Engine picks up `issue`, opens a PR whose head is `sha`, CI passes, it merges. */
async function fixAndMerge(fixture: ReturnType<typeof withDesk>, sha: string) {
  fixture.later();
  await cycle(fixture.engine);
  fixture.gitea.setStatus(sha, "success");
  fixture.later();
  await cycle(fixture.engine);
}

describe("filing", () => {
  it("files a new Bugsink issue as a Gitea issue assigned to the bot", async () => {
    const fixture = withDesk();
    expect(await fixture.send(alert("NEW"))).toBe("queued");

    const [issue] = fixture.gitea.filedIssues(A);
    expect(issue?.title).toBe("Bugsink: Error: EACCES: permission denied, mkdir");
    expect(issue?.assignees?.map((user) => user.login)).toEqual([BOT]);
    expect(issue?.body).toContain(
      "[MOONEXT-1](https://bugsink.example.com/issues/issue/ceb3928f/)",
    );
    expect(issue?.body).toContain("~~~~text\n# Error\nEACCES");
    expect(issue?.body).toContain(`<!-- bugsink:${ISSUE_ID} -->`);
    expect(fixture.gitea.labelNames(A, issue?.number ?? 0)).toEqual(["bugsink"]);
    expect(fixture.store.getBugsinkLink(ISSUE_ID)).toMatchObject({
      repo: A,
      issue: issue?.number,
      state: "open",
    });
    expect(fixture.bugsink.comments[0]).toContain(issue?.html_url);
  });

  it("files only once per Bugsink issue", async () => {
    const fixture = withDesk();
    await fixture.send(alert("NEW"));
    await fixture.send(alert("NEW"));
    await fixture.send(alert("UNMUTED"));
    expect(fixture.gitea.filedIssues(A)).toHaveLength(1);
  });

  it("still files when the stacktrace can't be read", async () => {
    const fixture = withDesk();
    fixture.bugsink.latestStacktrace = () => Promise.reject(new Error("timeout"));
    await fixture.send(alert("NEW"));
    expect(fixture.gitea.filedIssues(A)[0]?.body).not.toContain("Latest stacktrace");
  });

  it.each([
    ["a test alert", {}, alert("TEST")],
    ["an unmapped project", {}, alert("NEW", { project: 9 })],
    ["intake switched off", { BUGSINK_ENABLED: "false" }, alert("NEW")],
  ])("ignores %s", async (_name, env, payload) => {
    const fixture = withDesk(env);
    expect(await fixture.send(payload)).toBe("queued");
    expect(fixture.gitea.filedIssues(A)).toEqual([]);
  });

  it("rejects a payload that isn't a Bugsink issue", async () => {
    const fixture = withDesk();
    expect(await fixture.send({ hello: "world" })).toBe("invalid");
    expect(fixture.gitea.filedIssues(A)).toEqual([]);
  });
});

describe("fix, regression and freeze", () => {
  it("resolves in Bugsink once the bot's fix merges", async () => {
    const fixture = withDesk();
    await fixture.send(alert("NEW"));
    await fixAndMerge(fixture, "sha-1");

    expect(fixture.gitea.merges).toHaveLength(1);
    expect(fixture.gitea.issue(A, 1).state).toBe("closed");
    expect(fixture.bugsink.calls).toEqual([`resolve ${ISSUE_ID}`]);
    expect(fixture.store.getBugsinkLink(ISSUE_ID)?.state).toBe("resolved");
  });

  it("retries the resolve next poll when Bugsink is down", async () => {
    const fixture = withDesk();
    await fixture.send(alert("NEW"));
    fixture.bugsink.failResolve = true;
    await fixAndMerge(fixture, "sha-1");
    expect(fixture.store.getBugsinkLink(ISSUE_ID)?.state).toBe("open");

    fixture.bugsink.failResolve = false;
    await cycle(fixture.engine);
    expect(fixture.bugsink.calls).toEqual([`resolve ${ISSUE_ID}`]);
    expect(fixture.store.getBugsinkLink(ISSUE_ID)?.state).toBe("resolved");
  });

  it("doesn't resolve an issue closed without a bot fix", async () => {
    const fixture = withDesk();
    await fixture.send(alert("NEW"));
    await fixture.gitea.closeIssue({ owner: "org", name: "a" }, 1);
    fixture.later();
    await cycle(fixture.engine);
    expect(fixture.bugsink.calls).toEqual([]);
  });

  it("reopens for one more attempt on a regression, then freezes", async () => {
    const fixture = withDesk();
    await fixture.send(alert("NEW"));
    await fixAndMerge(fixture, "sha-1");

    // First regression: reopened and assigned to the bot again.
    fixture.later();
    await fixture.send(alert("REGRESSED"));
    const reopened = fixture.gitea.issue(A, 1);
    expect(reopened.state).toBe("open");
    expect(reopened.assignees?.map((user) => user.login)).toEqual([BOT]);
    expect(fixture.gitea.commentsOn(A, 1).at(-1)).toContain("regression 1 of 1 allowed");
    expect(fixture.store.getBugsinkLink(ISSUE_ID)).toMatchObject({
      state: "open",
      regressions: 1,
    });
    // The first fix's finished work doesn't count as fixing the regression.
    fixture.later();
    await fixture.desk.sweep();
    expect(fixture.bugsink.calls).toEqual([`resolve ${ISSUE_ID}`]);

    // The bot works it again; the second fix resolves it again.
    await fixAndMerge(fixture, "sha-2");
    expect(fixture.gitea.merges).toHaveLength(2);
    expect(fixture.bugsink.calls).toEqual([`resolve ${ISSUE_ID}`, `resolve ${ISSUE_ID}`]);

    // Second regression: frozen for a human.
    fixture.later();
    await fixture.send(alert("REGRESSED"));
    const frozen = fixture.gitea.issue(A, 1);
    expect(frozen.state).toBe("open");
    expect(frozen.assignees).toEqual([]);
    expect(fixture.gitea.labelNames(A, 1)).toContain(FROZEN_LABEL);
    expect(fixture.gitea.commentsOn(A, 1).at(-1)).toContain(`@${REVIEWER}`);
    expect(fixture.bugsink.calls.at(-1)).toBe(`mute ${ISSUE_ID}`);
    expect(fixture.store.getBugsinkLink(ISSUE_ID)).toMatchObject({
      state: "frozen",
      regressions: 2,
    });

    // Not picked up while frozen, and further alerts change nothing.
    fixture.later();
    await cycle(fixture.engine);
    await fixture.send(alert("REGRESSED"));
    expect(fixture.store.getWork(A, 1)?.state).toBe("done");
    expect(fixture.store.getBugsinkLink(ISSUE_ID)?.regressions).toBe(2);
  });

  it("freezes on the first regression with BUGSINK_MAX_REGRESSIONS=0", async () => {
    const fixture = withDesk({ BUGSINK_MAX_REGRESSIONS: "0" });
    await fixture.send(alert("NEW"));
    await fixAndMerge(fixture, "sha-1");
    fixture.later();
    await fixture.send(alert("REGRESSED"));
    expect(fixture.store.getBugsinkLink(ISSUE_ID)?.state).toBe("frozen");
    expect(fixture.gitea.commentsOn(A, 1).at(-1)).toContain("after 1 fix,");
  });
});
