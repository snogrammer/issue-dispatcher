/**
 * Schema migrations, applied in order. The database's `PRAGMA user_version`
 * records how many have run. Append new migrations; never edit a shipped one.
 */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE repo_slot (
    repo         TEXT PRIMARY KEY,
    active_issue INTEGER,
    updated_at   TEXT NOT NULL
  );

  CREATE TABLE issue_work (
    repo         TEXT NOT NULL,
    issue        INTEGER NOT NULL,
    state        TEXT NOT NULL
                 CHECK (state IN ('working', 'in-review', 'blocked', 'done', 'abandoned')),
    branch       TEXT,
    pr_stack     TEXT NOT NULL DEFAULT '[]',
    session_id   TEXT,
    fix_attempts INTEGER NOT NULL DEFAULT 0,
    last_sha     TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    PRIMARY KEY (repo, issue)
  );

  CREATE TABLE governor (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    repo          TEXT NOT NULL,
    issue         INTEGER NOT NULL,
    phase         TEXT NOT NULL,
    model         TEXT,
    effort        TEXT,
    max_turns     INTEGER,
    session_id    TEXT,
    started_at    TEXT NOT NULL,
    ended_at      TEXT,
    exit          TEXT,
    cost_usd      REAL,
    input_tokens  INTEGER,
    output_tokens INTEGER,
    error         TEXT
  );

  CREATE INDEX runs_by_issue ON runs (repo, issue);
  `,
  `
  -- When last_sha last changed: how long a PR head has waited for CI.
  ALTER TABLE issue_work ADD COLUMN head_since TEXT;
  `,
  `
  -- Set when the PR below this one in a stack merged and this branch still
  -- carries that PR's original commits (up to this SHA) and needs a rebase.
  ALTER TABLE issue_work ADD COLUMN rebase_from TEXT;
  `,
  `
  -- Small documents the dispatcher keeps for itself, e.g. dashboard config overrides.
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Run history and cost charts filter by start time.
  CREATE INDEX runs_by_start ON runs (started_at);
  `,
];
