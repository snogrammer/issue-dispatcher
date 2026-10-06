import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { Config } from "./config/schema.js";
import type { EngineSnapshot } from "./engine/engine.js";
import type { StateStore } from "./state/store.js";

/**
 * A tiny read-only HTTP server for operating the dispatcher:
 *
 * - `GET /healthz`: 200 while the poll loop is alive, 503 once it hasn't
 *   finished a pass in 3× POLL_INTERVAL_S (a hung API call or a wedged loop).
 *   A container healthcheck can restart it; in-flight work resumes on start.
 * - `GET /status`: what it's doing: watched repos, each held issue and its
 *   state, runs in progress, usage-limit and CI pauses, recent runs and cost.
 *
 * It exposes repo names, issue numbers and costs, never tokens, and binds to
 * 127.0.0.1 unless STATUS_HOST says otherwise.
 */

export interface StatusDeps {
  config: Pick<Config, "pollIntervalS" | "maxConcurrentSessions" | "status">;
  store: StateStore;
  snapshot: () => EngineSnapshot;
  version: string;
  now?: () => Date;
}

export interface Health {
  ok: boolean;
  lastTickAt: string | null;
  /** Seconds since the last finished poll (or since start, before the first). */
  staleSeconds: number;
}

const DAY_MS = 24 * 60 * 60_000;

export function health(deps: StatusDeps, processStartedAt: Date): Health {
  const now = (deps.now ?? (() => new Date()))().getTime();
  const { lastTickAt, startedAt } = deps.snapshot();
  const since = (lastTickAt ?? startedAt ?? processStartedAt).getTime();
  const staleSeconds = Math.max(0, Math.round((now - since) / 1000));
  return {
    ok: staleSeconds <= 3 * deps.config.pollIntervalS,
    lastTickAt: lastTickAt?.toISOString() ?? null,
    staleSeconds,
  };
}

export function status(deps: StatusDeps, processStartedAt: Date): Record<string, unknown> {
  const now = (deps.now ?? (() => new Date()))();
  const snapshot = deps.snapshot();
  const governor = deps.store.getGovernor();
  return {
    version: deps.version,
    health: health(deps, processStartedAt),
    startedAt: snapshot.startedAt?.toISOString() ?? null,
    repos: snapshot.repos,
    work: deps.store.activeWork().map((work) => ({
      repo: work.repo,
      issue: work.issue,
      state: work.state,
      branch: work.branch,
      pullRequests: work.prStack,
      fixAttempts: work.fixAttempts,
      updatedAt: work.updatedAt,
    })),
    running: snapshot.running.map((run) => ({
      ...run,
      startedAt: run.startedAt.toISOString(),
    })),
    sessions: { running: snapshot.running.length, max: deps.config.maxConcurrentSessions },
    pauses: {
      usageLimitUntil: governor.pausedUntil?.toISOString() ?? null,
      pickupsUntil: governor.pickupPausedUntil?.toISOString() ?? null,
      backoffLevel: governor.backoffLevel,
      ciBusy: snapshot.ciBusy,
    },
    costs: {
      last24h: deps.store.costSummary(new Date(now.getTime() - DAY_MS)),
      last7d: deps.store.costSummary(new Date(now.getTime() - 7 * DAY_MS)),
      allTime: deps.store.costSummary(),
    },
    recentRuns: deps.store.recentRuns(20).map((run) => ({
      id: run.id,
      repo: run.repo,
      issue: run.issue,
      phase: run.phase,
      model: run.model ?? null,
      effort: run.effort ?? null,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      exit: run.exit,
      costUsd: run.costUsd ?? null,
      error: run.error ?? null,
    })),
  };
}

export interface StatusServer {
  /** The port actually bound (tests ask for 0 to get a free one). */
  port: number;
  close(): Promise<void>;
}

/** Start the server; resolves once listening. `port` overrides the configured one (tests). */
export async function startStatusServer(
  deps: StatusDeps,
  port: number = deps.config.status.port,
): Promise<StatusServer> {
  const processStartedAt = (deps.now ?? (() => new Date()))();
  const server: Server = createServer((request, response) => {
    const send = (code: number, body: unknown) => {
      response.writeHead(code, { "content-type": "application/json; charset=utf-8" });
      response.end(`${JSON.stringify(body, null, 2)}\n`);
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      send(405, { error: "method not allowed" });
      return;
    }
    const path = (request.url ?? "/").split("?")[0];
    try {
      if (path === "/healthz") {
        const result = health(deps, processStartedAt);
        send(result.ok ? 200 : 503, result);
      } else if (path === "/status") {
        send(200, status(deps, processStartedAt));
      } else {
        send(404, { error: "not found", endpoints: ["/healthz", "/status"] });
      }
    } catch (error) {
      send(500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, deps.config.status.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
