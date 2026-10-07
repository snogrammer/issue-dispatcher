import path from "node:path";

import Database from "better-sqlite3";

import type { ActiveState } from "../conventions.js";
import type { Phase } from "../config/schema.js";
import { ensureWritableDir } from "../fs.js";
import { MIGRATIONS } from "./migrations.js";

/**
 * Local, durable memory for things Gitea can't hold: which issue holds each
 * repo's slot, the Claude session to resume, fix-attempt counters, the global
 * rate-limit pause, and a log of runs with their cost.
 *
 * Invariant: a repo slot only ever points at an issue in an active state.
 * Terminal states (done, abandoned) are reached only through `release`, which
 * clears the slot in the same transaction.
 */

export type WorkState = ActiveState | "done" | "abandoned";

export interface IssueWork {
  repo: string;
  issue: number;
  state: WorkState;
  branch: string | null;
  /** Open PR numbers, bottom of the stack first. */
  prStack: number[];
  sessionId: string | null;
  fixAttempts: number;
  lastSha: string | null;
  /** When `lastSha` last changed. */
  headSince: string | null;
  /** The merged stack base still to be rebased away from the bottom PR. */
  rebaseFrom: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkPatch {
  state?: ActiveState;
  branch?: string | null;
  prStack?: number[];
  sessionId?: string | null;
  fixAttempts?: number;
  /** Also records `headSince` when the SHA actually changes. */
  lastSha?: string | null;
  rebaseFrom?: string | null;
}

export interface Governor {
  /** No run of any kind starts before this time (the usage limit was hit). */
  pausedUntil: Date | null;
  /** No new issue is picked up before this time (close to the limit). */
  pickupPausedUntil: Date | null;
  /** Consecutive rate limits without a known reset time; drives backoff. */
  backoffLevel: number;
  /** Set from the dashboard: no new issue is picked up until it's cleared. */
  manualPause: boolean;
}

export type RunExit = "success" | "error" | "timeout" | "rate_limited" | "aborted";

export interface RunStart {
  repo: string;
  issue: number;
  phase: Phase;
  model?: string | undefined;
  effort?: string | undefined;
  maxTurns?: number | undefined;
  sessionId?: string | undefined;
}

export interface RunResult {
  exit: RunExit;
  sessionId?: string | undefined;
  costUsd?: number | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  error?: string | undefined;
}

export interface RunRecord extends RunStart, Omit<RunResult, "exit"> {
  id: number;
  startedAt: string;
  /** Null while the run is still going (or if the process died mid-run). */
  endedAt: string | null;
  exit: RunExit | null;
}

export interface CostTotals {
  runs: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CostSummary extends CostTotals {
  byRepo: (CostTotals & { repo: string })[];
}

export interface RunFilter {
  repo?: string | undefined;
  issue?: number | undefined;
  phase?: string | undefined;
  /** A run exit, or "running" for runs that haven't ended. */
  exit?: string | undefined;
  model?: string | undefined;
  /** Only runs with a smaller id (the next page). */
  before?: number | undefined;
  limit?: number | undefined;
}

export interface DailyCost extends CostTotals {
  /** UTC date, YYYY-MM-DD. */
  day: string;
}

export interface ModelCost extends CostTotals {
  /** Null when the run used the CLI's default model. */
  model: string | null;
}

export class SlotOccupiedError extends Error {
  override name = "SlotOccupiedError";

  constructor(
    readonly repo: string,
    readonly heldBy: number,
  ) {
    super(`${repo} is already working on #${String(heldBy)}`);
  }
}

export interface StoreOptions {
  now?: () => Date;
}

interface WorkRow {
  repo: string;
  issue: number;
  state: WorkState;
  branch: string | null;
  pr_stack: string;
  session_id: string | null;
  fix_attempts: number;
  last_sha: string | null;
  head_since: string | null;
  rebase_from: string | null;
  created_at: string;
  updated_at: string;
}

interface RunRow {
  id: number;
  repo: string;
  issue: number;
  phase: Phase;
  model: string | null;
  effort: string | null;
  max_turns: number | null;
  session_id: string | null;
  started_at: string;
  ended_at: string | null;
  exit: RunExit | null;
  cost_usd: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  error: string | null;
}

const DB_FILE = "dispatcher.db";

/** Aggregate columns shared by the cost queries. */
const TOTALS = `COUNT(*) AS runs, COALESCE(SUM(cost_usd), 0) AS cost_usd,
  COALESCE(SUM(input_tokens), 0) AS input_tokens,
  COALESCE(SUM(output_tokens), 0) AS output_tokens`;

interface TotalsRow {
  runs: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
}

function toTotals(row: TotalsRow): CostTotals {
  return {
    runs: row.runs,
    costUsd: row.cost_usd,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
  };
}

export class StateStore {
  private readonly now: () => Date;

  private constructor(
    private readonly db: Database.Database,
    options: StoreOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    migrate(db);
  }

  /** Open (creating if needed) the database under `dataDir`. */
  static open(dataDir: string, options: StoreOptions = {}): StateStore {
    ensureWritableDir(dataDir, "Data directory");
    const file = path.join(dataDir, DB_FILE);
    let db: Database.Database;
    try {
      db = new Database(file);
    } catch (error) {
      throw new Error(`Unable to open state database ${file}`, { cause: error });
    }
    db.pragma("journal_mode = WAL");
    return new StateStore(db, options);
  }

  static inMemory(options: StoreOptions = {}): StateStore {
    return new StateStore(new Database(":memory:"), options);
  }

  close(): void {
    this.db.close();
  }

  // --- Repo slots and issue work --------------------------------------------

  /** The issue currently holding `repo`'s slot, if any. */
  activeIssue(repo: string): number | null {
    const row = this.db.prepare("SELECT active_issue FROM repo_slot WHERE repo = ?").get(repo) as
      { active_issue: number | null } | undefined;
    return row?.active_issue ?? null;
  }

  /** Work for every repo whose slot is held. */
  activeWork(): IssueWork[] {
    const rows = this.db
      .prepare(
        `SELECT w.* FROM repo_slot s
         JOIN issue_work w ON w.repo = s.repo AND w.issue = s.active_issue
         ORDER BY s.repo`,
      )
      .all() as WorkRow[];
    return rows.map(toWork);
  }

  getWork(repo: string, issue: number): IssueWork | undefined {
    const row = this.db
      .prepare("SELECT * FROM issue_work WHERE repo = ? AND issue = ?")
      .get(repo, issue) as WorkRow | undefined;
    return row && toWork(row);
  }

  /**
   * Take `repo`'s slot for `issue`. Idempotent for the issue already holding
   * it (its progress is kept). Re-claiming an issue that previously finished or
   * was abandoned starts it fresh. Throws SlotOccupiedError if another issue
   * holds the slot.
   */
  claim(
    repo: string,
    issue: number,
    initial: { state?: ActiveState; branch?: string } = {},
  ): IssueWork {
    return this.db.transaction(() => {
      const held = this.activeIssue(repo);
      if (held !== null && held !== issue) throw new SlotOccupiedError(repo, held);

      const now = this.timestamp();
      const existing = this.getWork(repo, issue);
      if (existing === undefined) {
        this.db
          .prepare(
            `INSERT INTO issue_work (repo, issue, state, branch, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(repo, issue, initial.state ?? "working", initial.branch ?? null, now, now);
      } else if (held === null) {
        // Not holding the slot means the previous attempt ended; start over.
        this.db
          .prepare(
            `UPDATE issue_work SET state = ?, branch = ?, pr_stack = '[]', session_id = NULL,
               fix_attempts = 0, last_sha = NULL, head_since = NULL, rebase_from = NULL, updated_at = ?
             WHERE repo = ? AND issue = ?`,
          )
          .run(initial.state ?? "working", initial.branch ?? null, now, repo, issue);
      } else if (initial.state !== undefined || initial.branch !== undefined) {
        this.patchWork(repo, issue, {
          ...(initial.state === undefined ? {} : { state: initial.state }),
          ...(initial.branch === undefined ? {} : { branch: initial.branch }),
        });
      }

      this.db
        .prepare(
          `INSERT INTO repo_slot (repo, active_issue, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (repo) DO UPDATE SET active_issue = excluded.active_issue,
             updated_at = excluded.updated_at`,
        )
        .run(repo, issue, now);
      return this.requireWork(repo, issue);
    })();
  }

  /** Free `repo`'s slot, recording how the held issue ended. No-op if free. */
  release(repo: string, outcome: "done" | "abandoned"): IssueWork | undefined {
    return this.db.transaction(() => {
      const held = this.activeIssue(repo);
      if (held === null) return undefined;
      const now = this.timestamp();
      this.db
        .prepare("UPDATE issue_work SET state = ?, updated_at = ? WHERE repo = ? AND issue = ?")
        .run(outcome, now, repo, held);
      this.db
        .prepare("UPDATE repo_slot SET active_issue = NULL, updated_at = ? WHERE repo = ?")
        .run(now, repo);
      return this.getWork(repo, held);
    })();
  }

  /** Update progress on an issue that holds its repo's slot. */
  updateWork(repo: string, issue: number, patch: WorkPatch): IssueWork {
    return this.db.transaction(() => {
      if (this.activeIssue(repo) !== issue) {
        throw new Error(`#${String(issue)} does not hold the ${repo} slot`);
      }
      this.patchWork(repo, issue, patch);
      return this.requireWork(repo, issue);
    })();
  }

  // --- Governor -------------------------------------------------------------

  getGovernor(): Governor {
    const rows = this.db.prepare("SELECT key, value FROM governor").all() as {
      key: string;
      value: string;
    }[];
    const values = new Map(rows.map((row) => [row.key, row.value]));
    const date = (key: string) => {
      const value = values.get(key);
      return value === undefined ? null : new Date(value);
    };
    return {
      pausedUntil: date("paused_until"),
      pickupPausedUntil: date("pickup_paused_until"),
      backoffLevel: Number(values.get("backoff_level") ?? 0),
      manualPause: values.get("manual_pause") === "1",
    };
  }

  setGovernor(patch: Partial<Governor>): Governor {
    this.db.transaction(() => {
      const dates: [keyof Governor, string][] = [
        ["pausedUntil", "paused_until"],
        ["pickupPausedUntil", "pickup_paused_until"],
      ];
      for (const [field, key] of dates) {
        const value = patch[field];
        if (value === undefined) continue;
        if (value === null) this.db.prepare("DELETE FROM governor WHERE key = ?").run(key);
        else if (value instanceof Date) this.setGovernorValue(key, value.toISOString());
      }
      if (patch.backoffLevel !== undefined) {
        this.setGovernorValue("backoff_level", String(patch.backoffLevel));
      }
      if (patch.manualPause === true) this.setGovernorValue("manual_pause", "1");
      if (patch.manualPause === false) {
        this.db.prepare("DELETE FROM governor WHERE key = 'manual_pause'").run();
      }
    })();
    return this.getGovernor();
  }

  // --- Run log --------------------------------------------------------------

  startRun(run: RunStart): number {
    const result = this.db
      .prepare(
        `INSERT INTO runs (repo, issue, phase, model, effort, max_turns, session_id, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.repo,
        run.issue,
        run.phase,
        run.model ?? null,
        run.effort ?? null,
        run.maxTurns ?? null,
        run.sessionId ?? null,
        this.timestamp(),
      );
    return Number(result.lastInsertRowid);
  }

  finishRun(id: number, result: RunResult): void {
    const info = this.db
      .prepare(
        `UPDATE runs SET ended_at = ?, exit = ?, session_id = COALESCE(?, session_id),
           cost_usd = ?, input_tokens = ?, output_tokens = ?, error = ?
         WHERE id = ?`,
      )
      .run(
        this.timestamp(),
        result.exit,
        result.sessionId ?? null,
        result.costUsd ?? null,
        result.inputTokens ?? null,
        result.outputTokens ?? null,
        result.error ?? null,
        id,
      );
    if (info.changes === 0) throw new Error(`no run with id ${String(id)}`);
  }

  /** Most recent runs first. */
  recentRuns(limit = 20, repo?: string): RunRecord[] {
    const rows = (
      repo === undefined
        ? this.db.prepare("SELECT * FROM runs ORDER BY id DESC LIMIT ?").all(limit)
        : this.db
            .prepare("SELECT * FROM runs WHERE repo = ? ORDER BY id DESC LIMIT ?")
            .all(repo, limit)
    ) as RunRow[];
    return rows.map(toRun);
  }

  /** Runs matching `filter`, most recent first; page with `before` = the last id seen. */
  listRuns(filter: RunFilter = {}): RunRecord[] {
    const where: string[] = [];
    const values: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      where.push(clause);
      values.push(value);
    };
    if (filter.repo !== undefined) add("repo = ?", filter.repo);
    if (filter.issue !== undefined) add("issue = ?", filter.issue);
    if (filter.phase !== undefined) add("phase = ?", filter.phase);
    if (filter.exit === "running") where.push("ended_at IS NULL");
    else if (filter.exit !== undefined) add("exit = ?", filter.exit);
    if (filter.model !== undefined) add("model = ?", filter.model);
    if (filter.before !== undefined) add("id < ?", filter.before);
    const sql = `SELECT * FROM runs ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY id DESC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...values, filter.limit ?? 50) as RunRow[];
    return rows.map(toRun);
  }

  /** Totals per UTC day for runs started at or after `since`, oldest first. */
  costByDay(since: Date): DailyCost[] {
    const rows = this.db
      .prepare(
        `SELECT substr(started_at, 1, 10) AS day, ${TOTALS}
         FROM runs WHERE started_at >= ? GROUP BY day ORDER BY day`,
      )
      .all(since.toISOString()) as (TotalsRow & { day: string })[];
    return rows.map((row) => ({ day: row.day, ...toTotals(row) }));
  }

  /** Totals per model for runs started at or after `since` (all time if omitted), costliest first. */
  costByModel(since?: Date): ModelCost[] {
    const rows = this.db
      .prepare(
        `SELECT model, ${TOTALS}
         FROM runs WHERE started_at >= ? GROUP BY model ORDER BY cost_usd DESC`,
      )
      .all(since?.toISOString() ?? "") as (TotalsRow & { model: string | null })[];
    return rows.map((row) => ({ model: row.model, ...toTotals(row) }));
  }

  // --- Settings -------------------------------------------------------------

  /** Config overrides saved from the dashboard (see config/overrides.ts). */
  getConfigOverrides(): Record<string, unknown> {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = 'config_overrides'")
      .get() as { value: string } | undefined;
    return row === undefined ? {} : (JSON.parse(row.value) as Record<string, unknown>);
  }

  setConfigOverrides(overrides: Record<string, unknown>): void {
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES ('config_overrides', ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(JSON.stringify(overrides));
  }

  /** Runs, cost and tokens per repo for runs started at or after `since` (all time if omitted). */
  costSummary(since?: Date): CostSummary {
    const rows = this.db
      .prepare(
        `SELECT repo, COUNT(*) AS runs, COALESCE(SUM(cost_usd), 0) AS cost_usd,
           COALESCE(SUM(input_tokens), 0) AS input_tokens,
           COALESCE(SUM(output_tokens), 0) AS output_tokens
         FROM runs WHERE started_at >= ? GROUP BY repo ORDER BY repo`,
      )
      .all(since?.toISOString() ?? "") as {
      repo: string;
      runs: number;
      cost_usd: number;
      input_tokens: number;
      output_tokens: number;
    }[];
    const byRepo = rows.map((row) => ({
      repo: row.repo,
      runs: row.runs,
      costUsd: row.cost_usd,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
    }));
    return {
      runs: byRepo.reduce((sum, r) => sum + r.runs, 0),
      costUsd: byRepo.reduce((sum, r) => sum + r.costUsd, 0),
      inputTokens: byRepo.reduce((sum, r) => sum + r.inputTokens, 0),
      outputTokens: byRepo.reduce((sum, r) => sum + r.outputTokens, 0),
      byRepo,
    };
  }

  // --- Internals ------------------------------------------------------------

  private patchWork(repo: string, issue: number, patch: WorkPatch): void {
    const columns: Record<keyof WorkPatch, string> = {
      state: "state",
      branch: "branch",
      prStack: "pr_stack",
      sessionId: "session_id",
      fixAttempts: "fix_attempts",
      lastSha: "last_sha",
      rebaseFrom: "rebase_from",
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const key of Object.keys(columns) as (keyof WorkPatch)[]) {
      if (patch[key] === undefined) continue;
      sets.push(`${columns[key]} = ?`);
      values.push(key === "prStack" ? JSON.stringify(patch[key]) : patch[key]);
    }
    if (patch.lastSha !== undefined && patch.lastSha !== this.getWork(repo, issue)?.lastSha) {
      sets.push("head_since = ?");
      values.push(patch.lastSha === null ? null : this.timestamp());
    }
    sets.push("updated_at = ?");
    values.push(this.timestamp(), repo, issue);
    this.db
      .prepare(`UPDATE issue_work SET ${sets.join(", ")} WHERE repo = ? AND issue = ?`)
      .run(...values);
  }

  private requireWork(repo: string, issue: number): IssueWork {
    const work = this.getWork(repo, issue);
    if (work === undefined) throw new Error(`no work recorded for ${repo}#${String(issue)}`);
    return work;
  }

  private setGovernorValue(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO governor (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function migrate(db: Database.Database): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > MIGRATIONS.length) {
    throw new Error(
      `database schema version ${String(current)} is newer than this build supports (${String(MIGRATIONS.length)}); refusing to downgrade`,
    );
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version] ?? "");
      db.pragma(`user_version = ${String(version + 1)}`);
    })();
  }
}

function toWork(row: WorkRow): IssueWork {
  return {
    repo: row.repo,
    issue: row.issue,
    state: row.state,
    branch: row.branch,
    prStack: JSON.parse(row.pr_stack) as number[],
    sessionId: row.session_id,
    fixAttempts: row.fix_attempts,
    lastSha: row.last_sha,
    headSince: row.head_since,
    rebaseFrom: row.rebase_from,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    repo: row.repo,
    issue: row.issue,
    phase: row.phase,
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    maxTurns: row.max_turns ?? undefined,
    sessionId: row.session_id ?? undefined,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    exit: row.exit,
    costUsd: row.cost_usd ?? undefined,
    inputTokens: row.input_tokens ?? undefined,
    outputTokens: row.output_tokens ?? undefined,
    error: row.error ?? undefined,
  };
}
