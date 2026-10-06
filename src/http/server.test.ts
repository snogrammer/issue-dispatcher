import { request as httpRequest } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildConfig, readConfigLayers } from "../config/load.js";
import { ConfigManager } from "../config/overrides.js";
import type { EngineSnapshot } from "../engine/engine.js";
import { LogBuffer } from "../log.js";
import { StateStore } from "../state/store.js";
import { health } from "../status.js";
import { startStatusServer, type ServerDeps, type StatusServer } from "./server.js";
import { staticFile } from "./static.js";

const TOKEN = "secret-gitea-token-9876";
const DASHBOARD_TOKEN = "dashboard-token-0123456789";
const T0 = new Date("2026-06-01T12:00:00Z");

const BASE_ENV = {
  GITEA_URL: "https://gitea.example.com",
  GITEA_TOKEN: TOKEN,
  BOT_USERNAME: "bot",
  HUMAN_REVIEWER: "human",
  REPOS: "org/a",
  POLL_INTERVAL_S: "60",
};

interface Options {
  snapshot?: Partial<EngineSnapshot>;
  dashboardToken?: string;
}

function deps(options: Options = {}) {
  const env =
    options.dashboardToken === undefined
      ? BASE_ENV
      : { ...BASE_ENV, DASHBOARD_TOKEN: options.dashboardToken };
  const layers = readConfigLayers({ env });
  const config = buildConfig(layers, {});
  const clock = { now: T0 };
  const store = StateStore.inMemory({ now: () => clock.now });
  const value: EngineSnapshot = {
    startedAt: T0,
    lastTickAt: T0,
    ciBusy: false,
    repos: ["org/a"],
    running: [],
    ...options.snapshot,
  };
  const control = { pollNow: vi.fn() };
  const onChange = vi.fn();
  const logs = new LogBuffer(10);
  const configManager = new ConfigManager({
    layers,
    live: config,
    overrides: {},
    save: (overrides) => {
      store.setConfigOverrides(overrides);
    },
    onChange,
  });
  const d: ServerDeps = {
    config,
    store,
    snapshot: () => value,
    version: "1.2.3",
    now: () => clock.now,
    configManager,
    control,
    logs,
  };
  return { d, store, clock, value, config, control, onChange, logs };
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
    const { d, clock, value } = deps({ snapshot: { lastTickAt: null } });
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

  function base(): string {
    if (!server) throw new Error("server not started");
    return `http://127.0.0.1:${String(server.port)}`;
  }

  async function call(
    path: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) {
    const headers: Record<string, string> = { ...init.headers };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${base()}${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { text };
    }
    return { code: response.status, body, headers: response.headers };
  }

  /** Log in and return headers that make a same-origin, cookie-authenticated request. */
  async function login(): Promise<Record<string, string>> {
    const result = await call("/api/login", {
      method: "POST",
      body: { token: DASHBOARD_TOKEN },
    });
    expect(result.code).toBe(200);
    const cookie = (result.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    return { cookie, origin: base() };
  }

  it("serves /healthz with 200 while alive and 503 when the loop is stale", async () => {
    const { d, clock } = deps();
    server = await startStatusServer(d, 0);
    expect(await call("/healthz")).toMatchObject({ code: 200, body: { ok: true } });
    clock.now = new Date(T0.getTime() + 600_000);
    expect(await call("/healthz")).toMatchObject({
      code: 503,
      body: { ok: false, staleSeconds: 600 },
    });
  });

  it("serves /status with work, pauses, costs and recent runs, and no secrets", async () => {
    const running = { repo: "org/a", issue: 4, phase: "fix-ci" as const, startedAt: T0 };
    const { d, store } = deps({ snapshot: { running: [running], ciBusy: true } });
    store.claim("org/a", 4, { branch: "claude/4-x" });
    store.updateWork("org/a", 4, { state: "in-review", prStack: [5], fixAttempts: 1 });
    store.setGovernor({ pickupPausedUntil: new Date("2026-06-01T15:00:00Z") });
    const run = store.startRun({ repo: "org/a", issue: 4, phase: "implement", model: "opus" });
    store.finishRun(run, { exit: "success", costUsd: 0.5, inputTokens: 10, outputTokens: 2 });
    server = await startStatusServer(d, 0);

    const { code, body } = await call("/status");

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
        manual: false,
        ciBusy: true,
      },
      costs: { last24h: { runs: 1, costUsd: 0.5 }, allTime: { runs: 1, costUsd: 0.5 } },
      recentRuns: [{ issue: 4, phase: "implement", model: "opus", exit: "success", costUsd: 0.5 }],
    });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it("answers 404 for unknown paths and 405 for writes to read-only endpoints", async () => {
    const { d } = deps();
    server = await startStatusServer(d, 0);
    expect((await call("/nope")).code).toBe(404);
    expect((await call("/api/nope")).code).toBe(404);
    expect((await call("/status", { method: "POST" })).code).toBe(405);
    expect((await call("/index.html", { method: "POST" })).code).toBe(405);
  });

  describe("dashboard files", () => {
    it("serves the app and brand assets with a restrictive CSP", async () => {
      const { d } = deps();
      server = await startStatusServer(d, 0);
      const page = await call("/");
      expect(page.code).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(String(page.body.text)).toContain("IssueDispatcher");
      expect((await call("/app.js")).headers.get("content-type")).toContain("javascript");
      expect((await call("/brand/favicon/favicon.svg")).code).toBe(200);
    });

    it("refuses paths that escape the served directories", async () => {
      expect(await staticFile("/../package.json")).toBeUndefined();
      expect(await staticFile("/%2e%2e/package.json")).toBeUndefined();
      expect(await staticFile("/brand/../../package.json")).toBeUndefined();
      expect(await staticFile("/brand/%2e%2e/%2e%2e/src/main.ts")).toBeUndefined();
      expect(await staticFile("/%E0%A4%A")).toBeUndefined();

      // Raw request, since fetch would normalise the dots away.
      const { d } = deps();
      server = await startStatusServer(d, 0);
      const port = server.port;
      const code = await new Promise<number | undefined>((resolve, reject) => {
        httpRequest({ host: "127.0.0.1", port, path: "/brand/../../package.json" }, (res) => {
          res.resume();
          resolve(res.statusCode);
        })
          .on("error", reject)
          .end();
      });
      expect(code).toBe(404);
    });
  });

  describe("auth", () => {
    it("turns writes off when DASHBOARD_TOKEN isn't set", async () => {
      const { d, store } = deps();
      server = await startStatusServer(d, 0);
      expect((await call("/api/session")).body).toMatchObject({
        authenticated: false,
        writesEnabled: false,
        giteaUrl: "https://gitea.example.com",
      });
      const action = await call("/api/actions/pause-pickups", {
        method: "POST",
        headers: { authorization: `Bearer ${DASHBOARD_TOKEN}` },
      });
      expect(action.code).toBe(403);
      expect(String(action.body.error)).toContain("DASHBOARD_TOKEN");
      expect((await call("/api/login", { method: "POST", body: { token: "x" } })).code).toBe(403);
      expect(store.getGovernor().manualPause).toBe(false);
    });

    it("needs a login, and a same-origin request, for cookie writes", async () => {
      const { d, store } = deps({ dashboardToken: DASHBOARD_TOKEN });
      server = await startStatusServer(d, 0);

      expect((await call("/api/actions/pause-pickups", { method: "POST" })).code).toBe(401);
      expect((await call("/api/login", { method: "POST", body: { token: "nope" } })).code).toBe(
        401,
      );

      const headers = await login();
      expect(headers.cookie).toMatch(/^idsession=/);
      expect(headers.cookie).not.toContain(DASHBOARD_TOKEN);
      expect((await call("/api/session", { headers })).body).toMatchObject({
        authenticated: true,
      });

      const crossSite = await call("/api/actions/pause-pickups", {
        method: "POST",
        headers: { ...headers, origin: "https://evil.example" },
      });
      expect(crossSite.code).toBe(403);
      const noOrigin = await call("/api/actions/pause-pickups", {
        method: "POST",
        headers: { cookie: headers.cookie ?? "" },
      });
      expect(noOrigin.code).toBe(403);
      expect(store.getGovernor().manualPause).toBe(false);

      const sameSite = await call("/api/actions/pause-pickups", { method: "POST", headers });
      expect(sameSite.code).toBe(200);
      expect(store.getGovernor().manualPause).toBe(true);

      const logout = await call("/api/logout", { method: "POST", headers });
      expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    });

    it("accepts a bearer token from scripts without an Origin", async () => {
      const { d, control } = deps({ dashboardToken: DASHBOARD_TOKEN });
      server = await startStatusServer(d, 0);
      const result = await call("/api/actions/poll-now", {
        method: "POST",
        headers: { authorization: `Bearer ${DASHBOARD_TOKEN}` },
      });
      expect(result.code).toBe(200);
      expect(control.pollNow).toHaveBeenCalledOnce();
      const wrong = await call("/api/actions/poll-now", {
        method: "POST",
        headers: { authorization: "Bearer wrong" },
      });
      expect(wrong.code).toBe(401);
    });
  });

  describe("actions", () => {
    it("pauses and resumes pickups and clears a usage-limit pause", async () => {
      const { d, store, control } = deps({ dashboardToken: DASHBOARD_TOKEN });
      store.setGovernor({
        pausedUntil: new Date("2026-06-01T13:00:00Z"),
        pickupPausedUntil: new Date("2026-06-01T14:00:00Z"),
        backoffLevel: 3,
      });
      server = await startStatusServer(d, 0);
      const headers = { authorization: `Bearer ${DASHBOARD_TOKEN}` };

      await call("/api/actions/pause-pickups", { method: "POST", headers });
      expect((await call("/status")).body).toMatchObject({ pauses: { manual: true } });
      await call("/api/actions/resume-pickups", { method: "POST", headers });
      expect(store.getGovernor().manualPause).toBe(false);

      await call("/api/actions/clear-usage-pause", { method: "POST", headers });
      expect(store.getGovernor()).toEqual({
        pausedUntil: null,
        pickupPausedUntil: null,
        backoffLevel: 0,
        manualPause: false,
      });
      expect(control.pollNow).toHaveBeenCalledTimes(2);
      expect((await call("/api/actions/explode", { method: "POST", headers })).code).toBe(404);
    });
  });

  describe("runs, costs and work", () => {
    function seed(store: StateStore) {
      const runs = [
        { repo: "org/a", issue: 1, phase: "implement" as const, model: "opus" },
        { repo: "org/a", issue: 1, phase: "fix-ci" as const, model: "sonnet" },
        { repo: "org/b", issue: 2, phase: "implement" as const, model: "opus" },
      ];
      for (const run of runs) {
        const id = store.startRun(run);
        store.finishRun(id, { exit: "success", costUsd: 1, inputTokens: 5, outputTokens: 1 });
      }
      store.startRun({ repo: "org/b", issue: 3, phase: "implement" });
    }

    it("filters and pages the run history", async () => {
      const { d, store } = deps();
      seed(store);
      server = await startStatusServer(d, 0);

      const all = await call("/api/runs");
      expect((all.body.runs as unknown[]).length).toBe(4);
      const page = await call("/api/runs?limit=2");
      expect((page.body.runs as { id: number }[]).map((r) => r.id)).toEqual([4, 3]);
      const next = await call(`/api/runs?limit=2&before=${String(page.body.next)}`);
      expect((next.body.runs as { id: number }[]).map((r) => r.id)).toEqual([2, 1]);

      const opus = await call("/api/runs?model=opus&repo=org/a");
      expect((opus.body.runs as { id: number }[]).map((r) => r.id)).toEqual([1]);
      const running = await call("/api/runs?exit=running");
      expect((running.body.runs as { issue: number }[]).map((r) => r.issue)).toEqual([3]);
      expect((await call("/api/runs?limit=lots")).code).toBe(400);
    });

    it("totals cost by day, repo and model", async () => {
      const { d, store } = deps();
      seed(store);
      server = await startStatusServer(d, 0);
      const { body } = await call("/api/costs?days=7");
      expect(body).toMatchObject({
        days: 7,
        since: "2026-05-26T00:00:00.000Z",
        byDay: [{ day: "2026-06-01", runs: 4, costUsd: 3 }],
        byRepo: [
          { repo: "org/a", costUsd: 2 },
          { repo: "org/b", costUsd: 1 },
        ],
        byModel: [
          { model: "opus", costUsd: 2 },
          { model: "sonnet", costUsd: 1 },
          { model: null, costUsd: 0 },
        ],
        total: { runs: 4, costUsd: 3 },
      });
    });

    it("shows one issue's work and runs", async () => {
      const { d, store } = deps();
      seed(store);
      store.claim("org/a", 1, { branch: "claude/1-x" });
      server = await startStatusServer(d, 0);
      const { code, body } = await call("/api/work/org/a/1");
      expect(code).toBe(200);
      expect(body).toMatchObject({ repo: "org/a", issue: 1, work: { branch: "claude/1-x" } });
      expect((body.runs as unknown[]).length).toBe(2);
      expect((await call("/api/work/org/a/99")).code).toBe(404);
    });
  });

  describe("config", () => {
    const write = { authorization: `Bearer ${DASHBOARD_TOKEN}` };

    it("shows each key's value and source, with secrets redacted", async () => {
      const { d } = deps({ dashboardToken: DASHBOARD_TOKEN });
      server = await startStatusServer(d, 0);
      const { body } = await call("/api/config");
      const text = JSON.stringify(body);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(DASHBOARD_TOKEN);
      const editable = body.editable as { key: string; value: unknown; source: string }[];
      expect(editable.find((e) => e.key === "pollIntervalS")).toMatchObject({
        value: 60,
        source: "env",
      });
      expect(editable.find((e) => e.key === "ciMaxQueue")).toMatchObject({
        value: 2,
        source: "default",
      });
      const readOnly = body.readOnly as { key: string; value: unknown; secret: boolean }[];
      expect(readOnly.find((r) => r.key === "gitea.token")).toMatchObject({
        value: "[redacted]",
        secret: true,
      });
    });

    it("applies valid overrides to the live config, saves them, and reports the change", async () => {
      const { d, config, store, onChange } = deps({ dashboardToken: DASHBOARD_TOKEN });
      const rateLimit = config.rateLimit;
      server = await startStatusServer(d, 0);
      const result = await call("/api/config", {
        method: "PUT",
        headers: write,
        body: {
          overrides: {
            pollIntervalS: 120,
            "rateLimit.backoffBaseMin": 20,
            routing: { phases: { rebase: { model: "haiku" } } },
          },
        },
      });
      expect(result.code).toBe(200);
      expect(result.body.changed).toEqual(["pollIntervalS", "rateLimit.backoffBaseMin", "routing"]);
      expect(config.pollIntervalS).toBe(120);
      expect(config.rateLimit).toBe(rateLimit); // same object the governor holds
      expect(config.rateLimit.backoffBaseMin).toBe(20);
      expect(config.routing.phases.rebase).toEqual({ model: "haiku" });
      expect(config.routing.default.maxTurns).toBe(100);
      expect(store.getConfigOverrides()).toMatchObject({ pollIntervalS: 120 });
      expect(onChange).toHaveBeenCalledWith([
        "pollIntervalS",
        "rateLimit.backoffBaseMin",
        "routing",
      ]);

      // Removing an override falls back to env.
      await call("/api/config", { method: "PUT", headers: write, body: { overrides: {} } });
      expect(config.pollIntervalS).toBe(60);
    });

    it("rejects read-only keys and invalid values without changing anything", async () => {
      const { d, config, store } = deps({ dashboardToken: DASHBOARD_TOKEN });
      server = await startStatusServer(d, 0);

      const readOnly = await call("/api/config", {
        method: "PUT",
        headers: write,
        body: { overrides: { "gitea.url": "https://evil.example", pollIntervalS: 30 } },
      });
      expect(readOnly.code).toBe(400);
      expect(String(readOnly.body.error)).toContain("gitea.url");

      const tooLow = await call("/api/config", {
        method: "PUT",
        headers: write,
        body: { overrides: { pollIntervalS: 5 } },
      });
      expect(tooLow.code).toBe(400);
      expect(String(tooLow.body.error)).toContain("pollIntervalS");

      const backwards = await call("/api/config", {
        method: "PUT",
        headers: write,
        body: { overrides: { "rateLimit.backoffMaxMin": 5 } },
      });
      expect(backwards.code).toBe(400);
      expect(String(backwards.body.error)).toContain("RATE_LIMIT_BACKOFF_MAX_MIN");

      expect(config.pollIntervalS).toBe(60);
      expect(store.getConfigOverrides()).toEqual({});
    });

    it("needs auth to change config", async () => {
      const { d, config } = deps({ dashboardToken: DASHBOARD_TOKEN });
      server = await startStatusServer(d, 0);
      const result = await call("/api/config", {
        method: "PUT",
        body: { overrides: { pollIntervalS: 120 } },
      });
      expect(result.code).toBe(401);
      expect(config.pollIntervalS).toBe(60);
    });
  });

  describe("logs", () => {
    it("returns recent lines and streams new ones", async () => {
      const { d, logs } = deps();
      logs.push('{"msg":"one"}');
      server = await startStatusServer(d, 0);
      expect((await call("/api/logs")).body).toEqual({ lines: ['{"msg":"one"}'] });

      const response = await fetch(`${base()}/api/logs/stream`);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const reader = response.body?.getReader();
      if (!reader) throw new Error("no stream body");
      const decoder = new TextDecoder();
      const next = async () =>
        decoder.decode((await reader.read()).value as Uint8Array | undefined);
      let received = await next();
      logs.push('{"msg":"two"}');
      while (!received.includes("two")) received += await next();
      expect(received).toContain('data: {"msg":"two"}');
      await reader.cancel();
    });
  });
});
