import type { Config } from "./config/schema.js";
import type { EngineSnapshot } from "./engine/engine.js";
import type { StateStore } from "./state/store.js";

/**
 * What the status server (src/http/server.ts) reports for operating the
 * dispatcher:
 *
 * - `GET /healthz`: 200 while the poll loop is alive, 503 once it hasn't
 *   finished a pass in 3× POLL_INTERVAL_S (a hung API call or a wedged loop).
 *   A container healthcheck can restart it; in-flight work resumes on start.
 *   It also names the running commit, so a redeploy can wait for the new image.
 * - `GET /status`: what it's doing: watched repos (and skipped ones, with
 *   why), each held issue and its
 *   state, runs in progress, usage-limit and CI pauses, recent runs and cost.
 *
 * It exposes repo names, issue numbers and costs, never tokens. The
 * dashboard's overview page is built from the same `/status` document.
 */

export interface StatusDeps {
  config: Pick<Config, "pollIntervalS" | "maxConcurrentSessions" | "status">;
  store: StateStore;
  snapshot: () => EngineSnapshot;
  version: string;
  /** The image's GIT_SHA; `/healthz` reports it so a redeploy can tell the new container answered. */
  commit?: string;
  now?: () => Date;
}

export interface Health {
  ok: boolean;
  lastTickAt: string | null;
  /** Seconds since the last finished poll (or since start, before the first). */
  staleSeconds: number;
  /** The running build's commit, or null when it wasn't stamped (local runs). */
  commit: string | null;
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
    commit: deps.commit === undefined || deps.commit === "unknown" ? null : deps.commit,
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
    skippedRepos: snapshot.skipped,
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
      manual: governor.manualPause,
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
