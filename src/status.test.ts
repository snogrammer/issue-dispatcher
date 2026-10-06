import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "./config/load.js";
import type { EngineSnapshot } from "./engine/engine.js";
import { StateStore } from "./state/store.js";
import { health, startStatusServer, type StatusDeps, type StatusServer } from "./status.js";

const TOKEN = "secret-gitea-token-9876";
const T0 = new Date("2026-06-01T12:00:00Z");

const config = loadConfig({
  env: {
    GITEA_URL: "https://gitea.example.com",
    GITEA_TOKEN: TOKEN,
    BOT_USERNAME: "bot",
    HUMAN_REVIEWER: "human",
    REPOS: "org/a",
    POLL_INTERVAL_S: "60",
  },
});

function deps(snapshot: Partial<EngineSnapshot> = {}, now = T0) {
  const clock = { now };
  const store = StateStore.inMemory({ now: () => clock.now });
  const value: EngineSnapshot = {
    startedAt: T0,
    lastTickAt: T0,
    ciBusy: false,
    repos: ["org/a"],
    running: [],
    ...snapshot,
  };
  const d: StatusDeps = {
    config,
    store,
    snapshot: () => value,
    version: "1.2.3",
    now: () => clock.now,
  };
  return { d, store, clock, value };
}

describe("health", () => {
  it("is ok within 3× the poll interval of the last finished poll", () => {
    const { d, clock } = deps();
    clock.now = new Date(T0.getTime() + 180_000);
    expect(health(d, T0)).toEqual({ ok: true, lastTickAt: T0.toISOString(), staleSeconds: 180 });
    clock.now = new Date(T0.getTime() + 181_000);
    expect(health(d, T0).ok).toBe(false);
  });

  it("measures from engine start, then process start, before the first poll", () => {
    const { d, clock, value } = deps({ lastTickAt: null });
    clock.now = new Date(T0.getTime() + 100_000);
    expect(health(d, T0)).toMatchObject({ ok: true, lastTickAt: null, staleSeconds: 100 });
    value.startedAt = null;
    clock.now = new Date(T0.getTime() + 400_000);
    expect(health(d, T0).ok).toBe(false);
  });
});

describe("status server", () => {
  let server: StatusServer | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function get(path: string, method = "GET") {
    if (!server) throw new Error("server not started");
    const response = await fetch(`http://127.0.0.1:${String(server.port)}${path}`, { method });
    return { code: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it("serves /healthz with 200 while alive and 503 when the loop is stale", async () => {
    const { d, clock } = deps();
    server = await startStatusServer(d, 0);
    expect(await get("/healthz")).toMatchObject({ code: 200, body: { ok: true } });
    clock.now = new Date(T0.getTime() + 600_000);
    expect(await get("/healthz")).toMatchObject({
      code: 503,
      body: { ok: false, staleSeconds: 600 },
    });
  });

  it("serves /status with work, pauses, costs and recent runs, and no secrets", async () => {
    const running = { repo: "org/a", issue: 4, phase: "fix-ci" as const, startedAt: T0 };
    const { d, store } = deps({ running: [running], ciBusy: true });
    store.claim("org/a", 4, { branch: "claude/4-x" });
    store.updateWork("org/a", 4, { state: "in-review", prStack: [5], fixAttempts: 1 });
    store.setGovernor({ pickupPausedUntil: new Date("2026-06-01T15:00:00Z") });
    const run = store.startRun({ repo: "org/a", issue: 4, phase: "implement", model: "opus" });
    store.finishRun(run, { exit: "success", costUsd: 0.5, inputTokens: 10, outputTokens: 2 });
    server = await startStatusServer(d, 0);

    const { code, body } = await get("/status");

    expect(code).toBe(200);
    expect(body).toMatchObject({
      version: "1.2.3",
      repos: ["org/a"],
      work: [
        {
          repo: "org/a",
          issue: 4,
          state: "in-review",
          branch: "claude/4-x",
          pullRequests: [5],
          fixAttempts: 1,
        },
      ],
      running: [{ repo: "org/a", issue: 4, phase: "fix-ci", startedAt: T0.toISOString() }],
      sessions: { running: 1, max: 1 },
      pauses: {
        usageLimitUntil: null,
        pickupsUntil: "2026-06-01T15:00:00.000Z",
        backoffLevel: 0,
        ciBusy: true,
      },
      costs: { last24h: { runs: 1, costUsd: 0.5 }, allTime: { runs: 1, costUsd: 0.5 } },
      recentRuns: [{ issue: 4, phase: "implement", model: "opus", exit: "success", costUsd: 0.5 }],
    });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it("answers 404 for unknown paths and 405 for writes", async () => {
    const { d } = deps();
    server = await startStatusServer(d, 0);
    expect((await get("/nope")).code).toBe(404);
    expect((await get("/status", "POST")).code).toBe(405);
  });
});
