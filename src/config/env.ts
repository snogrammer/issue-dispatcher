/**
 * The environment variables the dispatcher reads, and where each one lands in
 * the config object. This table is the single source of truth: the loader uses
 * it to build config from env, error messages use it to name the variable a bad
 * value came from, and a test checks that every entry is documented.
 */

export type EnvKind = "string" | "int" | "number" | "bool" | "list";

export interface EnvVar {
  readonly name: string;
  readonly path: readonly string[];
  readonly kind: EnvKind;
  /** Secrets may only come from env, never from the config file, and are redacted for logging. */
  readonly secret?: true;
}

export const ENV_VARS: readonly EnvVar[] = [
  { name: "GITEA_URL", path: ["gitea", "url"], kind: "string" },
  { name: "GITEA_TOKEN", path: ["gitea", "token"], kind: "string", secret: true },
  { name: "BOT_USERNAME", path: ["gitea", "botUsername"], kind: "string" },
  { name: "HUMAN_REVIEWER", path: ["humanReviewer"], kind: "string" },
  { name: "REPOS", path: ["repos"], kind: "list" },
  { name: "ORGS", path: ["orgs"], kind: "list" },
  { name: "LABEL_PREFIX", path: ["labelPrefix"], kind: "string" },
  { name: "POLL_INTERVAL_S", path: ["pollIntervalS"], kind: "int" },
  { name: "MAX_CONCURRENT_SESSIONS", path: ["maxConcurrentSessions"], kind: "int" },
  { name: "MAX_FIX_ATTEMPTS", path: ["maxFixAttempts"], kind: "int" },
  { name: "REQUIRE_CI", path: ["requireCi"], kind: "bool" },
  { name: "MERGE_STYLE", path: ["mergeStyle"], kind: "string" },
  { name: "CI_MAX_QUEUE", path: ["ciMaxQueue"], kind: "int" },
  { name: "CI_NO_STATUS_TIMEOUT_MIN", path: ["ciNoStatusTimeoutMin"], kind: "int" },
  { name: "RATE_LIMIT_BACKOFF_BASE_MIN", path: ["rateLimit", "backoffBaseMin"], kind: "int" },
  { name: "RATE_LIMIT_BACKOFF_MAX_MIN", path: ["rateLimit", "backoffMaxMin"], kind: "int" },
  { name: "RATE_LIMIT_PICKUP_THRESHOLD", path: ["rateLimit", "pickupThreshold"], kind: "number" },
  { name: "CLAUDE_BIN", path: ["claude", "bin"], kind: "string" },
  { name: "CLAUDE_TIMEOUT_MIN", path: ["claude", "timeoutMin"], kind: "int" },
  { name: "CLAUDE_PERMISSION_MODE", path: ["claude", "permissionMode"], kind: "string" },
  { name: "CLAUDE_MAX_BUDGET_USD", path: ["claude", "maxBudgetUsd"], kind: "number" },
  { name: "TOOLCHAIN_AUTO_INSTALL", path: ["toolchain", "autoInstall"], kind: "bool" },
  {
    name: "TOOLCHAIN_INSTALL_TIMEOUT_MIN",
    path: ["toolchain", "installTimeoutMin"],
    kind: "int",
  },
  { name: "TEST_SERVICES", path: ["toolchain", "testServices"], kind: "list" },
  { name: "GIT_USER_NAME", path: ["git", "userName"], kind: "string" },
  { name: "GIT_USER_EMAIL", path: ["git", "userEmail"], kind: "string" },
  { name: "CLAUDE_MODEL", path: ["routing", "default", "model"], kind: "string" },
  { name: "CLAUDE_EFFORT", path: ["routing", "default", "effort"], kind: "string" },
  { name: "CLAUDE_MAX_TURNS", path: ["routing", "default", "maxTurns"], kind: "int" },
  { name: "MODEL_LABELS", path: ["routing", "modelLabels"], kind: "list" },
  { name: "WORKSPACE_DIR", path: ["paths", "workspaceDir"], kind: "string" },
  { name: "DATA_DIR", path: ["paths", "dataDir"], kind: "string" },
  { name: "LOG_LEVEL", path: ["logLevel"], kind: "string" },
  { name: "STATUS_PORT", path: ["status", "port"], kind: "int" },
  { name: "STATUS_HOST", path: ["status", "host"], kind: "string" },
  { name: "DASHBOARD_TOKEN", path: ["dashboard", "token"], kind: "string", secret: true },
  { name: "DASHBOARD_HOME_URL", path: ["dashboard", "homeUrl"], kind: "string" },
  { name: "PLAUSIBLE_SCRIPT_URL", path: ["dashboard", "plausibleScriptUrl"], kind: "string" },
  { name: "PLAUSIBLE_DOMAIN", path: ["dashboard", "plausibleDomain"], kind: "string" },
  { name: "SENTRY_DSN", path: ["sentry", "dsn"], kind: "string", secret: true },
  { name: "SENTRY_ENVIRONMENT", path: ["sentry", "environment"], kind: "string" },
  { name: "SENTRY_SERVICE_NAME", path: ["sentry", "serviceName"], kind: "string" },
  { name: "SENTRY_INSTANCE", path: ["sentry", "instance"], kind: "string" },
];

/** Path to an optional YAML file merged underneath env values. */
export const CONFIG_FILE_VAR = "CONFIG_FILE";

const TRUE_WORDS = new Set(["true", "1", "yes", "on"]);
const FALSE_WORDS = new Set(["false", "0", "no", "off"]);

/**
 * Convert a raw env string to its declared kind. Values that don't parse are
 * returned unchanged so schema validation reports them against the right key,
 * instead of this layer silently guessing.
 */
export function parseEnvValue(kind: EnvKind, raw: string): unknown {
  switch (kind) {
    case "string":
      return raw;
    case "int":
      return /^-?\d+$/.test(raw) ? Number(raw) : raw;
    case "number":
      return /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
    case "bool": {
      const word = raw.toLowerCase();
      if (TRUE_WORDS.has(word)) return true;
      if (FALSE_WORDS.has(word)) return false;
      return raw;
    }
    case "list":
      return raw
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item !== "");
  }
}
