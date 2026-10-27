import type { IncomingMessage } from "node:http";

import { ConfigError } from "../config/load.js";
import type { ConfigManager } from "../config/overrides.js";
import type { Config } from "../config/schema.js";
import { silentLogger, type LogBuffer, type Logger } from "../log.js";
import type { StateStore } from "../state/store.js";
import { LOGIN_DISABLED, type DashboardAuth } from "./auth.js";

/**
 * The dashboard's JSON API under /api. Only the session check, login and
 * logout answer without a session (the landing page needs them); the server
 * refuses every other route before it gets here (see PUBLIC_API in
 * server.ts). Anything that changes state also goes through
 * `auth.authorizeWrite` and is logged with `dashboard: true` so the log shows
 * who-did-what alongside the engine's own lines.
 */

export interface DashboardControl {
  /** Start a poll now instead of waiting out the interval. */
  pollNow(): void;
}

export interface ApiDeps {
  config: Config;
  store: StateStore;
  version: string;
  auth: DashboardAuth;
  configManager?: ConfigManager | undefined;
  control?: DashboardControl | undefined;
  logs?: LogBuffer | undefined;
  log?: Logger | undefined;
  now?: (() => Date) | undefined;
}

export interface Reply {
  code: number;
  body: unknown;
  headers?: Record<string, string>;
}

export class HttpError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

const MAX_BODY_BYTES = 64 * 1024;
const DAY_MS = 24 * 60 * 60_000;

/** Control actions offered on the overview page. */
export const ACTIONS = [
  "pause-pickups",
  "resume-pickups",
  "clear-usage-pause",
  "poll-now",
] as const;

export const API_ENDPOINTS = [
  "/api/session",
  "/api/login",
  "/api/logout",
  "/api/runs",
  "/api/costs",
  "/api/work/:owner/:repo/:issue",
  "/api/config",
  ...ACTIONS.map((action) => `/api/actions/${action}`),
  "/api/logs",
  "/api/logs/stream",
];

/** Handle an /api request, or undefined if no route matches. */
export async function handleApi(
  deps: ApiDeps,
  request: IncomingMessage,
  url: URL,
): Promise<Reply | undefined> {
  const method = request.method ?? "GET";
  const path = url.pathname;
  const log = deps.log ?? silentLogger;

  if (path === "/api/session" && method === "GET") {
    const { homeUrl = null, plausibleScriptUrl, plausibleDomain } = deps.config.dashboard;
    const analytics =
      plausibleScriptUrl === undefined
        ? null
        : { src: plausibleScriptUrl, domain: plausibleDomain ?? null };
    // Logged out, say only what the landing page shows.
    if (!deps.auth.isAuthenticated(request)) {
      return ok({ authenticated: false, loginEnabled: deps.auth.loginEnabled, homeUrl, analytics });
    }
    return ok({
      authenticated: true,
      loginEnabled: true,
      homeUrl,
      analytics,
      configEditable: deps.configManager !== undefined,
      version: deps.version,
      giteaUrl: deps.config.gitea.url,
      botUsername: deps.config.gitea.botUsername,
      humanReviewer: deps.config.humanReviewer,
    });
  }

  if (path === "/api/login" && method === "POST") {
    if (!deps.auth.loginEnabled) throw new HttpError(403, LOGIN_DISABLED);
    const body = await readJson(request);
    const result = deps.auth.login(isObject(body) ? body.token : undefined);
    if (result === undefined) throw new HttpError(429, "too many failed logins; wait a minute");
    if (!result) {
      log.warn("dashboard login failed", { dashboard: true });
      throw new HttpError(401, "wrong token");
    }
    log.info("dashboard login", { dashboard: true });
    return ok({ authenticated: true }, { "set-cookie": deps.auth.sessionCookie(request) });
  }

  if (path === "/api/logout" && method === "POST") {
    return ok({ authenticated: false }, { "set-cookie": deps.auth.clearCookie(request) });
  }

  if (path === "/api/runs" && method === "GET") {
    const q = url.searchParams;
    const runs = deps.store.listRuns({
      repo: param(q, "repo"),
      issue: intParam(q, "issue"),
      phase: param(q, "phase"),
      exit: param(q, "exit"),
      model: param(q, "model"),
      before: intParam(q, "before"),
      limit: Math.min(intParam(q, "limit") ?? 50, 500),
    });
    return ok({ runs, next: runs.length > 0 ? (runs.at(-1)?.id ?? null) : null });
  }

  if (path === "/api/costs" && method === "GET") {
    const days = Math.min(Math.max(intParam(url.searchParams, "days") ?? 30, 1), 365);
    const now = (deps.now ?? (() => new Date()))();
    // From midnight UTC `days - 1` days ago, so the chart has exactly `days` bars.
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    since.setTime(since.getTime() - (days - 1) * DAY_MS);
    return ok({
      days,
      since: since.toISOString(),
      byDay: deps.store.costByDay(since),
      byRepo: deps.store.costSummary(since).byRepo,
      byModel: deps.store.costByModel(since),
      total: deps.store.costSummary(since),
    });
  }

  const work = /^\/api\/work\/([\w.-]+)\/([\w.-]+)\/(\d+)$/.exec(path);
  if (work !== null && method === "GET") {
    const [, owner = "", name = "", number = ""] = work;
    const repo = `${owner}/${name}`;
    const issue = Number(number);
    const record = deps.store.getWork(repo, issue) ?? null;
    const runs = deps.store.listRuns({ repo, issue, limit: 500 });
    if (record === null && runs.length === 0) {
      throw new HttpError(404, `nothing recorded for ${repo}#${number}`);
    }
    return ok({ repo, issue, work: record, runs });
  }

  if (path === "/api/config") {
    const manager = deps.configManager;
    if (manager === undefined) throw new HttpError(404, "config editing is not available");
    if (method === "GET") return ok(manager.view());
    if (method === "PUT") {
      requireWrite(deps, request);
      const body = await readJson(request);
      const overrides = isObject(body) ? body.overrides : undefined;
      let changed: string[];
      try {
        changed = manager.update(overrides);
      } catch (error) {
        if (error instanceof ConfigError) throw new HttpError(400, error.message);
        throw error;
      }
      log.info("config updated from the dashboard", { dashboard: true, changed });
      return ok({ changed, config: manager.view() });
    }
  }

  const action = /^\/api\/actions\/([\w-]+)$/.exec(path)?.[1];
  if (action !== undefined && method === "POST") {
    if (!(ACTIONS as readonly string[]).includes(action)) return undefined;
    requireWrite(deps, request);
    runAction(deps, action as (typeof ACTIONS)[number]);
    log.info("dashboard action", { dashboard: true, action });
    return ok({ ok: true, governor: deps.store.getGovernor() });
  }

  if (path === "/api/logs" && method === "GET") {
    const limit = Math.min(intParam(url.searchParams, "limit") ?? 500, 1000);
    return ok({ lines: deps.logs?.recent(limit) ?? [] });
  }

  return undefined;
}

function runAction(deps: ApiDeps, action: (typeof ACTIONS)[number]): void {
  switch (action) {
    case "pause-pickups":
      deps.store.setGovernor({ manualPause: true });
      return;
    case "resume-pickups":
      deps.store.setGovernor({ manualPause: false });
      deps.control?.pollNow();
      return;
    case "clear-usage-pause":
      deps.store.setGovernor({
        pausedUntil: null,
        pauseReason: null,
        pickupPausedUntil: null,
        backoffLevel: 0,
      });
      deps.control?.pollNow();
      return;
    case "poll-now":
      deps.control?.pollNow();
      return;
  }
}

function requireWrite(deps: ApiDeps, request: IncomingMessage): void {
  const result = deps.auth.authorizeWrite(request);
  if (!result.ok) throw new HttpError(result.code, result.error);
}

function ok(body: unknown, headers?: Record<string, string>): Reply {
  return headers === undefined ? { code: 200, body } : { code: 200, body, headers };
}

export async function readJson(request: IncomingMessage): Promise<unknown> {
  const type = request.headers["content-type"] ?? "";
  if (!type.startsWith("application/json")) throw new HttpError(415, "send application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

function param(query: URLSearchParams, name: string): string | undefined {
  const value = query.get(name)?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function intParam(query: URLSearchParams, name: string): number | undefined {
  const value = param(query, name);
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) throw new HttpError(400, `${name} must be a whole number`);
  return Number(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
