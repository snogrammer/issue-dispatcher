import type { ClaudeRunResult } from "../claude/runner.js";
import type { RateLimitInfo } from "../claude/stream.js";
import type { Config } from "../config/schema.js";
import { silentLogger, type Logger } from "../log.js";
import type { StateStore } from "../state/store.js";

/**
 * Keeps the dispatcher inside Claude's usage limits, which apply to the whole
 * account, so every decision here is global across repos.
 *
 * Two levels:
 * - **Hard pause** (a run was rejected for usage): no run of any kind starts
 *   until the limit resets. Work in progress keeps its state and session and
 *   resumes afterwards. With no reset time, back off exponentially
 *   (RATE_LIMIT_BACKOFF_BASE_MIN · 2^n, capped at RATE_LIMIT_BACKOFF_MAX_MIN);
 *   a successful run resets the backoff.
 * - **Pickup pause** (close to the limit): the CLI warned, or a usage window
 *   is at least RATE_LIMIT_PICKUP_THRESHOLD full. Issues already in progress
 *   continue (fix rounds, resumes), but no new issue is started until that
 *   window resets, so the remaining budget finishes work instead of starting
 *   more. Fresh "allowed" info under the threshold lifts it early.
 *
 * Limit info only arrives with runs, so both pauses end at the reported reset
 * time rather than waiting for news.
 */

export interface Observation {
  /** A hard pause started with this run (it wasn't already paused). */
  pauseStarted: boolean;
  pausedUntil?: Date;
}

export class Governor {
  constructor(
    private readonly store: StateStore,
    private readonly limits: Config["rateLimit"],
    private readonly now: () => Date = () => new Date(),
    private readonly log: Logger = silentLogger,
  ) {}

  /** No run may start. Clears an expired pause. */
  isPaused(): boolean {
    const { pausedUntil } = this.store.getGovernor();
    if (pausedUntil === null) return false;
    if (pausedUntil.getTime() > this.now().getTime()) return true;
    this.store.setGovernor({ pausedUntil: null });
    this.log.info("usage limit reset; resuming runs");
    return false;
  }

  /** No new issue may be picked up. Clears an expired pickup pause. */
  pickupsPaused(): boolean {
    if (this.isPaused()) return true;
    const { pickupPausedUntil, manualPause } = this.store.getGovernor();
    // Paused from the dashboard: held until someone resumes it.
    if (manualPause) return true;
    if (pickupPausedUntil === null) return false;
    if (pickupPausedUntil.getTime() > this.now().getTime()) return true;
    this.store.setGovernor({ pickupPausedUntil: null });
    this.log.info("usage window reset; picking up new issues again");
    return false;
  }

  /** Learn from a finished run. */
  observe(result: Pick<ClaudeRunResult, "kind" | "rateLimit">): Observation {
    if (result.kind === "rate_limited") return this.pause(result.rateLimit);
    // Credentials don't fix themselves on a schedule: back off until someone does.
    if (result.kind === "auth_failed") return this.pause(undefined);
    if (result.kind === "success" && this.store.getGovernor().backoffLevel > 0) {
      this.store.setGovernor({ backoffLevel: 0 });
    }
    if (result.rateLimit) this.watchUsage(result.rateLimit);
    return { pauseStarted: false };
  }

  private pause(info: RateLimitInfo | undefined): Observation {
    const now = this.now().getTime();
    const wasPaused = this.isPaused();
    const { backoffLevel } = this.store.getGovernor();
    let pausedUntil: Date;
    let level = backoffLevel;
    if (info?.resetsAt && info.resetsAt.getTime() > now) {
      pausedUntil = info.resetsAt;
    } else {
      const minutes = Math.min(
        this.limits.backoffBaseMin * 2 ** backoffLevel,
        this.limits.backoffMaxMin,
      );
      pausedUntil = new Date(now + minutes * 60_000);
      level = backoffLevel + 1;
    }
    this.store.setGovernor({ pausedUntil, backoffLevel: level });
    this.log.warn("usage limit reached; pausing all runs", {
      until: pausedUntil.toISOString(),
      knownReset: level === backoffLevel,
    });
    return { pauseStarted: !wasPaused, pausedUntil };
  }

  private watchUsage(info: RateLimitInfo): void {
    const now = this.now().getTime();
    const resets: Date[] = [];
    if (info.status === "allowed_warning") {
      resets.push(info.resetsAt ?? new Date(now + this.limits.backoffBaseMin * 60_000));
    }
    if (
      info.utilization !== undefined &&
      info.utilization >= this.limits.pickupThreshold &&
      info.resetsAt
    ) {
      resets.push(info.resetsAt);
    }
    for (const window of info.windows ?? []) {
      if (window.utilization >= this.limits.pickupThreshold) resets.push(window.resetsAt);
    }

    const future = resets.filter((date) => date.getTime() > now);
    const current = this.store.getGovernor().pickupPausedUntil;
    if (future.length > 0) {
      const until = new Date(Math.max(...future.map((date) => date.getTime())));
      if (current?.getTime() !== until.getTime()) {
        this.store.setGovernor({ pickupPausedUntil: until });
        this.log.warn("close to the usage limit; not picking up new issues", {
          until: until.toISOString(),
        });
      }
    } else if (info.status === "allowed" && current !== null) {
      this.store.setGovernor({ pickupPausedUntil: null });
      this.log.info("usage back under the threshold; picking up new issues again");
    }
  }
}
