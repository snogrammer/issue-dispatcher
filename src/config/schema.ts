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
    maxFixAttempts: z.int().min(0).default(2),
    requireCi: z.boolean().default(true),
    /** Overrides each repo's default merge style when set. */
    mergeStyle: z
      .enum(["merge", "rebase", "rebase-merge", "squash", "fast-forward-only"])
      .optional(),
    ciMaxQueue: z.int().min(1).default(2),
    ciNoStatusTimeoutMin: z.int().min(1).default(15),
    rateLimit: z
      .strictObject({
        /** Pause after a rate limit with no reset time: base · 2^n minutes, capped at max. */
        backoffBaseMin: z.int().min(1).default(15),
        backoffMaxMin: z.int().min(1).default(300),
        /** Stop picking up new issues once a usage window is this full (0–1]. */
        pickupThreshold: z.number().gt(0).max(1).default(0.9),
      })
      .refine((limits) => limits.backoffMaxMin >= limits.backoffBaseMin, {
        message: "RATE_LIMIT_BACKOFF_MAX_MIN must be at least RATE_LIMIT_BACKOFF_BASE_MIN",
        path: ["backoffMaxMin"],
      })
      .prefault({}),
    claude: z
      .strictObject({
        bin: z.string().min(1).default("claude"),
        timeoutMin: z.int().min(1).default(60),
        permissionMode: z.enum(PERMISSION_MODES).default("bypassPermissions"),
        maxBudgetUsd: z.number().positive().optional(),
      })
      .prefault({}),
    /**
     * Install the language versions a repo pins (asdf) before each run, so
     * Claude can run the repo's checks locally.
     */
    toolchain: z
      .strictObject({
        autoInstall: z.boolean().default(true),
        /** Per install; Python and Ruby compile from source. */
        installTimeoutMin: z.int().min(1).default(20),
        /**
         * Services running next to the dispatcher for repos' tests, as URLs
         * (postgres://…, redis://…). Claude is told about them; none by default.
         */
        testServices: z.array(z.url()).default([]),
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
    /** The /healthz and /status HTTP server; port 0 turns it off. */
    status: z
      .strictObject({
        port: z.int().min(0).max(65535).default(8080),
        host: z.string().min(1).default("127.0.0.1"),
      })
      .prefault({}),
    /**
     * The web dashboard served by the status server. Everything but the
     * landing page needs the token; without one it stays locked.
     */
    dashboard: z
      .strictObject({
        token: z.string().min(16, "use at least 16 characters").optional(),
        /** Where the landing page's "back" link goes (a blog, GitHub profile, …). */
        homeUrl: z.url({ protocol: /^https?$/ }).optional(),
        /**
         * Plausible's tracking script (a self-hosted CE instance's or plausible.io's).
         * Set, every dashboard page loads it and the CSP allows its origin.
         */
        plausibleScriptUrl: z.url({ protocol: /^https$/ }).optional(),
        /** `data-domain` for the classic `script.js`; per-site `pa-*.js` scripts don't need it. */
        plausibleDomain: z.string().min(1).optional(),
      })
      .prefault({}),
    /**
     * Error reporting; off unless a DSN is set. The service name and instance
     * tell this dispatcher's events apart from other services in the same org.
     */
    sentry: z
      .strictObject({
        dsn: z.url({ protocol: /^https?$/ }).optional(),
        /** Defaults to NODE_ENV, else "production". */
        environment: z.string().min(1).optional(),
        serviceName: z.string().regex(NAME_PATTERN).default("claude-dispatcher"),
        /** Sentry's server name; defaults to the hostname (the container ID in Docker). */
        instance: z.string().min(1).optional(),
      })
      .prefault({}),
    /**
     * Bugsink alert intake (docs/bugsink.md): each new Bugsink issue becomes a
     * Gitea issue assigned to the bot, resolved in Bugsink once the fix merges.
     * Off unless the URL, token and webhook secret are all set.
     */
    bugsink: z
      .strictObject({
        url: z
          .url({ protocol: /^https?$/ })
          .transform((value) => value.replace(/\/+$/, ""))
          .optional(),
        token: z.string().min(1).optional(),
        /** The last path segment of the webhook URL; Bugsink can't sign its posts. */
        webhookSecret: z.string().min(32, "use at least 32 characters").optional(),
        /** Bugsink project ID → Gitea repo. Env gives `id=owner/repo` pairs. */
        projects: z
          .preprocess(
            (value) => (Array.isArray(value) ? Object.fromEntries(value.map(projectPair)) : value),
            z
              .record(z.string(), z.string().regex(REPO_PATTERN, "expected owner/repo"))
              .refine((projects) => Object.keys(projects).every((id) => /^\d+$/.test(id)), {
                message: "expected <bugsink project id>=owner/repo",
              }),
          )
          .default({}),
        /** Global switch: off, alerts are acknowledged and ignored. */
        enabled: z.boolean().default(true),
        /** Regressions after a bot fix that get another attempt before the issue is frozen. */
        maxRegressions: z.int().min(0).default(1),
      })
      .prefault({}),
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

/** `5=owner/repo` → ["5", "owner/repo"]; anything else fails the key check above. */
function projectPair(item: unknown): [string, unknown] {
  const text = String(item);
  const at = text.indexOf("=");
  return at === -1 ? [text, ""] : [text.slice(0, at).trim(), text.slice(at + 1).trim()];
}

/** Whether Bugsink intake has what it needs to run. */
export function bugsinkConfigured(
  bugsink: Config["bugsink"],
): bugsink is Config["bugsink"] & { url: string; token: string; webhookSecret: string } {
  return (
    bugsink.url !== undefined && bugsink.token !== undefined && bugsink.webhookSecret !== undefined
  );
}
