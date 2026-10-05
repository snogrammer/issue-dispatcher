import path from "node:path";

import { z } from "zod";

/**
 * Shape and validation of the dispatcher's configuration. Objects are strict so
 * a typo in the YAML file fails at startup instead of being silently ignored.
 */

/** Effort levels accepted by `claude --effort`. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Phases of work on an issue; each can be routed to its own model/effort. */
export const PHASES = ["implement", "fix-ci", "address-review", "rebase"] as const;

/**
 * `claude --permission-mode` values usable unattended. `manual` and `plan`
 * would stall or never edit, so they're not offered.
 */
export const PERMISSION_MODES = ["bypassPermissions", "acceptEdits", "auto", "dontAsk"] as const;
export type Phase = (typeof PHASES)[number];

const REPO_PATTERN = /^[\w.-]+\/[\w.-]+$/;
const NAME_PATTERN = /^[\w.-]+$/;

const absolutePath = z
  .string()
  .min(1)
  .transform((value) => path.resolve(value));

/** A partial model/effort/turn-limit choice; layers are merged by precedence at run time. */
const routeSpec = z.strictObject({
  model: z.string().min(1).optional(),
  effort: z.enum(EFFORT_LEVELS).optional(),
  maxTurns: z.int().min(1).optional(),
});
export type RouteSpec = z.infer<typeof routeSpec>;

const routing = z.strictObject({
  default: z
    .strictObject({
      model: z.string().min(1).optional(),
      effort: z.enum(EFFORT_LEVELS).optional(),
      maxTurns: z.int().min(1).default(100),
    })
    .prefault({}),
  phases: z.partialRecord(z.enum(PHASES), routeSpec).default({}),
  repos: z.record(z.string().regex(REPO_PATTERN, "expected owner/repo"), routeSpec).default({}),
  /**
   * Models offered as `model:<name>` labels, in addition to any model named in
   * the routing rules above. Defaults to the Claude Code CLI aliases.
   */
  modelLabels: z
    .array(z.string().regex(/^[\w.-]+$/, "expected a model alias or ID"))
    .default(["opus", "sonnet", "haiku"]),
});

export const configSchema = z
  .strictObject({
    // Parse an absent block as {} so each missing field is reported with its env var.
    gitea: z.preprocess(
      (value) => value ?? {},
      z.strictObject({
        url: z.url({ protocol: /^https?$/ }).transform((value) => value.replace(/\/+$/, "")),
        token: z.string().min(1),
        botUsername: z.string().regex(NAME_PATTERN),
      }),
    ),
    humanReviewer: z.string().regex(NAME_PATTERN),
    repos: z.array(z.string().regex(REPO_PATTERN, "expected owner/repo")).default([]),
    orgs: z.array(z.string().regex(NAME_PATTERN)).default([]),
    labelPrefix: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/i)
      .default("claude"),
    pollIntervalS: z.int().min(10).default(60),
    maxConcurrentSessions: z.int().min(1).default(1),
    maxFixAttempts: z.int().min(0).default(3),
    requireCi: z.boolean().default(true),
    /** Overrides each repo's default merge style when set. */
    mergeStyle: z
      .enum(["merge", "rebase", "rebase-merge", "squash", "fast-forward-only"])
      .optional(),
    ciMaxQueue: z.int().min(1).default(2),
    ciNoStatusTimeoutMin: z.int().min(1).default(15),
    claude: z
      .strictObject({
        bin: z.string().min(1).default("claude"),
        timeoutMin: z.int().min(1).default(60),
        permissionMode: z.enum(PERMISSION_MODES).default("bypassPermissions"),
        maxBudgetUsd: z.number().positive().optional(),
      })
      .prefault({}),
    /** Commit identity in workspaces; defaults derive from the bot account. */
    git: z
      .strictObject({
        userName: z.string().min(1).optional(),
        userEmail: z.email().optional(),
      })
      .prefault({}),
    routing: routing.prefault({}),
    paths: z
      .strictObject({
        workspaceDir: absolutePath.prefault("./workspaces"),
        dataDir: absolutePath.prefault("./data"),
      })
      .prefault({}),
    logLevel: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),
  })
  .refine((config) => config.repos.length + config.orgs.length > 0, {
    message: "set at least one repo (REPOS) or org (ORGS) to watch",
    path: ["repos"],
  })
  .transform((config) => ({
    ...config,
    git: {
      userName: config.git.userName ?? config.gitea.botUsername,
      // Gitea's default no-reply domain is `noreply.<host>`.
      userEmail:
        config.git.userEmail ??
        `${config.gitea.botUsername}@noreply.${new URL(config.gitea.url).hostname}`,
    },
  }));

export type Config = z.infer<typeof configSchema>;
