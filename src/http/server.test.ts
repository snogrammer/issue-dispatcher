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

const BEARER = { authorization: `Bearer ${DASHBOARD_TOKEN}` };

interface Options {
  snapshot?: Partial<EngineSnapshot>;
  /** `null` leaves DASHBOARD_TOKEN unset. */
  dashboardToken?: string | null;
  homeUrl?: string;
  /** Extra env, e.g. the Plausible settings. */
  env?: Record<string, string>;
}

function deps(options: Options = {}) {
  const token = options.dashboardToken === undefined ? DASHBOARD_TOKEN : options.dashboardToken;
  const env = {
    ...BASE_ENV,
    ...(token === null ? {} : { DASHBOARD_TOKEN: token }),
    ...(options.homeUrl === undefined ? {} : { DASHBOARD_HOME_URL: options.homeUrl }),
    ...options.env,
  };
  const layers = readConfigLayers({ env });
  const config = buildConfig(layers, {});
  const clock = { now: T0 };
  const store = StateStore.inMemory({ now: () => clock.now });
  const value: EngineSnapshot = {
    startedAt: T0,
    lastTickAt: T0,
    ciBusy: false,
    repos: ["org/a"],
    skipped: [],
    running: [],
    queue: [],
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
    expect(health(d, T0)).toEqual({
      ok: true,
      lastTickAt: T0.toISOString(),
      staleSeconds: 180,
      commit: null,
    });
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

  it("names the running commit, but not a build that wasn't stamped", () => {
    const { d } = deps();
    expect(health({ ...d, commit: "abc1234" }, T0).commit).toBe("abc1234");
    expect(health({ ...d, commit: "unknown" }, T0).commit).toBeNull();
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

  /** `auth` sends the dashboard token as a bearer, like a script would. */
  async function call(
    path: string,
    init: {
      method?: string;
      body?: unknown;
      headers?: Record<string, string>;
      auth?: boolean;
    } = {},
  ) {
    const headers: Record<string, string> = { ...(init.auth ? BEARER : {}), ...init.headers };
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${base()}${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      redirect: "manual",
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

  describe("bugsink webhook", () => {
    const SECRET = "w".repeat(40);
    const BUGSINK = {
      BUGSINK_URL: "https://bugsink.example.com",
      BUGSINK_API_TOKEN: "bugsink-token",
      BUGSINK_WEBHOOK_SECRET: SECRET,
    };

    async function withHook(env: Record<string, string> = BUGSINK) {
      const { d } = deps({ env });
      const received: unknown[] = [];
      const bugsink = {
        receive: (payload: unknown) => {
          received.push(payload);
          return "queued";
        },
      };
      server = await startStatusServer({ ...d, bugsink }, 0);
      return received;
    }

    it("accepts alerts at the secret path without a dashboard session", async () => {
      const received = await withHook();
      const result = await call(`/hooks/bugsink/${SECRET}`, {
        method: "POST",
        body: { id: "x", project: 1, alert_reason: "TEST" },
      });
      expect(result).toMatchObject({ code: 202, body: { received: "queued" } });
      expect(received).toEqual([{ id: "x", project: 1, alert_reason: "TEST" }]);
    });

    it("answers 404 for a wrong secret or other hook paths, and receives nothing", async () => {
      const received = await withHook();
      for (const path of [`/hooks/bugsink/${SECRET}x`, "/hooks/bugsink/", "/hooks/other"]) {
        expect(await call(path, { method: "POST", body: {}, auth: true })).toMatchObject({
          code: 404,
          body: { error: "not found" },
        });
      }
      expect(received).toEqual([]);
    });

    it("answers 404 when intake isn't configured", async () => {
      await withHook({});
      expect((await call(`/hooks/bugsink/${SECRET}`, { method: "POST", body: {} })).code).toBe(404);
    });

    it("wants a JSON POST", async () => {
      await withHook();
      expect((await call(`/hooks/bugsink/${SECRET}`)).code).toBe(405);
      const text = await call(`/hooks/bugsink/${SECRET}`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
      });
      expect(text.code).toBe(415);
    });
  });

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
    const { d, store } = deps({
      snapshot: {
        running: [running],
        ciBusy: true,
        skipped: [{ name: "org/new", reason: "empty" }],
        queue: [
          { repo: "org/a", number: 9, title: "Next", pullRequest: false, priority: "high" },
          { repo: "org/a", number: 11, title: "Fix PR", pullRequest: true, priority: "normal" },
        ],
      },
    });
    store.claim("org/a", 4, { branch: "claude/4-x" });
    store.updateWork("org/a", 4, { state: "in-review", prStack: [5], fixAttempts: 1 });
    store.setGovernor({ pickupPausedUntil: new Date("2026-06-01T15:00:00Z") });
    const run = store.startRun({ repo: "org/a", issue: 4, phase: "implement", model: "opus" });
    store.finishRun(run, { exit: "success", costUsd: 0.5, inputTokens: 10, outputTokens: 2 });
    server = await startStatusServer(d, 0);

    const { code, body } = await call("/status", { auth: true });

    expect(code).toBe(200);
    expect(body).toMatchObject({
      version: "1.2.3",
      repos: ["org/a"],
      skippedRepos: [{ name: "org/new", reason: "empty" }],
      queue: {
        total: 3,
        waiting: 2,
        items: [
          { number: 9, priority: "high" },
          { number: 11, pullRequest: true },
        ],
      },
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
    expect((await call("/nope", { auth: true })).code).toBe(404);
    expect((await call("/api/nope", { auth: true })).code).toBe(404);
    expect((await call("/status", { method: "POST" })).code).toBe(405);
    expect((await call("/index.html", { method: "POST" })).code).toBe(405);
  });

  describe("dashboard files", () => {
    it("serves the app and brand assets with a restrictive CSP", async () => {
      const { d } = deps();
      server = await startStatusServer(d, 0);
      const page = await call("/", { auth: true });
      expect(page.code).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
      expect(page.headers.get("vary")).toBe("cookie");
      expect(String(page.body.text)).toContain('class="nav"');
      const app = await call("/app.js", { auth: true });
      expect(app.headers.get("content-type")).toContain("javascript");
      expect((await call("/brand/favicon/favicon.svg")).code).toBe(200);
    });

    it("allows Plausible's origin and hands its script to every visitor when analytics is on", async () => {
      const { d } = deps({
        env: {
          PLAUSIBLE_SCRIPT_URL: "https://stats.example.com/js/script.js",
          PLAUSIBLE_DOMAIN: "dispatcher.example.com",
        },
      });
      server = await startStatusServer(d, 0);
      const analytics = {
        src: "https://stats.example.com/js/script.js",
        domain: "dispatcher.example.com",
      };
      for (const auth of [false, true]) {
        const page = await call("/", { auth });
        const policy = page.headers.get("content-security-policy");
        expect(policy).toContain("script-src 'self' https://stats.example.com;");
        expect(policy).toContain("connect-src 'self' https://stats.example.com;");
        expect((await call("/api/session", { auth })).body).toMatchObject({ analytics });
      }
      expect((await call("/analytics.js")).code).toBe(200);
      // JSON responses keep the plain policy.
      const json = await call("/healthz");
      expect(json.headers.get("content-security-policy")).not.toContain("stats.example.com");
    });

    it("keeps the CSP to its own files when analytics is off", async () => {
      const { d } = deps();
      server = await startStatusServer(d, 0);
      const policy = (await call("/")).headers.get("content-security-policy");
      expect(policy).toContain("script-src 'self';");
      expect(policy).toContain("connect-src 'self';");
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
        httpRequest(
          { host: "127.0.0.1", port, path: "/brand/../../package.json", headers: BEARER },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        )
          .on("error", reject)
          .end();
      });
      expect(code).toBe(404);
    });
  });

  describe("auth", () => {
    it("shows a logged-out visitor the landing page and nothing else", async () => {
      const { d } = deps({ homeUrl: "https://blog.example.com" });
      server = await startStatusServer(d, 0);

      const page = await call("/");
      expect(page.code).toBe(200);
      expect(page.headers.get("content-type")).toContain("text/html");
      expect(String(page.body.text)).toContain("landing.js");
      expect(String(page.body.text)).not.toContain('class="nav"');
      for (const path of ["/landing.js", "/app.css", "/brand/favicon/favicon.svg"]) {
        expect((await call(path)).code, path).toBe(200);
      }
      for (const path of ["/index.html", "/app.js", "/landing.html", "/nope"]) {
        const result = await call(path);
        expect(result.code, path).toBe(302);
        expect(result.headers.get("location")).toBe("/");
      }

      for (const path of [
        "/status",
        "/api/runs",
        "/api/costs",
        "/api/config",
        "/api/logs",
        "/api/logs/stream",
        "/api/work/org/a/1",
        "/api/nope",
      ]) {
        const result = await call(path);
        expect(result.code, path).toBe(401);
        expect(result.body, path).toEqual({ error: "log in first" });
      }
      expect((await call("/healthz")).code).toBe(200);

      // Only what the landing page shows: no Gitea URL, bot, version or endpoint list.
      expect((await call("/api/session")).body).toEqual({
        authenticated: false,
        loginEnabled: true,
        homeUrl: "https://blog.example.com",
        analytics: null,
      });
      expect((await call("/api/login")).body).toEqual({ error: "not found" });
    });

    it("links to Gitea's public URL when one is set", async () => {
      const { d } = deps({ env: { GITEA_PUBLIC_URL: "https://git.example.org/" } });
      server = await startStatusServer(d, 0);
      const headers = await login();
      expect((await call("/api/session", { headers })).body).toMatchObject({
        giteaUrl: "https://git.example.org",
      });
    });

    it("lets a cookie session or a bearer token see everything", async () => {
      const { d } = deps();
      server = await startStatusServer(d, 0);
      const headers = await login();
      expect(String((await call("/", { headers })).body.text)).toContain('class="nav"');
      expect((await call("/app.js", { headers })).code).toBe(200);
      expect((await call("/status", { headers })).code).toBe(200);
      expect((await call("/api/runs", { headers })).code).toBe(200);
      expect((await call("/api/session", { headers })).body).toMatchObject({
        authenticated: true,
        homeUrl: null,
        giteaUrl: "https://gitea.example.com",
        version: "1.2.3",
      });
      expect((await call("/status", { auth: true })).code).toBe(200);
      expect((await call("/api/costs", { auth: true })).code).toBe(200);
      expect(
        (await call("/status", { headers: { authorization: "Bearer wrong-token-0123456789" } }))
          .code,
      ).toBe(401);
    });

    it("locks everything when DASHBOARD_TOKEN isn't set", async () => {
      const { d, store } = deps({ dashboardToken: null });
      server = await startStatusServer(d, 0);
      expect((await call("/api/session")).body).toEqual({
        authenticated: false,
        loginEnabled: false,
        homeUrl: null,
        analytics: null,
      });
      expect(String((await call("/")).body.text)).toContain("landing.js");
      expect((await call("/status", { auth: true })).code).toBe(401);
      const action = await call("/api/actions/pause-pickups", { method: "POST", auth: true });
      expect(action.code).toBe(401);
      const login = await call("/api/login", { method: "POST", body: { token: "x" } });
      expect(login.code).toBe(403);
      expect(String(login.body.error)).toContain("DASHBOARD_TOKEN");
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
        pauseReason: "auth",
        pickupPausedUntil: new Date("2026-06-01T14:00:00Z"),
        backoffLevel: 3,
      });
      server = await startStatusServer(d, 0);
      const headers = { authorization: `Bearer ${DASHBOARD_TOKEN}` };

      await call("/api/actions/pause-pickups", { method: "POST", headers });
      expect((await call("/status", { headers })).body).toMatchObject({
        pauses: { manual: true, reason: "auth" },
      });
      await call("/api/actions/resume-pickups", { method: "POST", headers });
      expect(store.getGovernor().manualPause).toBe(false);

      await call("/api/actions/clear-usage-pause", { method: "POST", headers });
      expect(store.getGovernor()).toEqual({
        pausedUntil: null,
        pauseReason: null,
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

      const all = await call("/api/runs", { auth: true });
      expect((all.body.runs as unknown[]).length).toBe(4);
      const page = await call("/api/runs?limit=2", { auth: true });
      expect((page.body.runs as { id: number }[]).map((r) => r.id)).toEqual([4, 3]);
      const next = await call(`/api/runs?limit=2&before=${String(page.body.next)}`, { auth: true });
      expect((next.body.runs as { id: number }[]).map((r) => r.id)).toEqual([2, 1]);

      const opus = await call("/api/runs?model=opus&repo=org/a", { auth: true });
      expect((opus.body.runs as { id: number }[]).map((r) => r.id)).toEqual([1]);
      const running = await call("/api/runs?exit=running", { auth: true });
      expect((running.body.runs as { issue: number }[]).map((r) => r.issue)).toEqual([3]);
      expect((await call("/api/runs?limit=lots", { auth: true })).code).toBe(400);
    });

    it("totals cost by day, repo and model", async () => {
      const { d, store } = deps();
      seed(store);
      server = await startStatusServer(d, 0);
      const { body } = await call("/api/costs?days=7", { auth: true });
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
      const { code, body } = await call("/api/work/org/a/1", { auth: true });
      expect(code).toBe(200);
      expect(body).toMatchObject({ repo: "org/a", issue: 1, work: { branch: "claude/1-x" } });
      expect((body.runs as unknown[]).length).toBe(2);
      expect((await call("/api/work/org/a/99", { auth: true })).code).toBe(404);
    });
  });

  describe("config", () => {
    const write = { authorization: `Bearer ${DASHBOARD_TOKEN}` };

    it("shows each key's value and source, with secrets redacted", async () => {
      const { d } = deps({ dashboardToken: DASHBOARD_TOKEN });
      server = await startStatusServer(d, 0);
      const { body } = await call("/api/config", { auth: true });
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
      expect((await call("/api/logs", { auth: true })).body).toEqual({ lines: ['{"msg":"one"}'] });

      const response = await fetch(`${base()}/api/logs/stream`, { headers: BEARER });
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
