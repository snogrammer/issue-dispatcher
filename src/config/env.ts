/**
 * The environment variables the dispatcher reads, and where each one lands in
 * the config object. This table is the single source of truth: the loader uses
 * it to build config from env, error messages use it to name the variable a bad
 * value came from, and a test checks that every entry is documented.
 */

export type EnvKind = "string" | "int" | "bool" | "list";

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
  { name: "CI_MAX_QUEUE", path: ["ciMaxQueue"], kind: "int" },
  { name: "CI_NO_STATUS_TIMEOUT_MIN", path: ["ciNoStatusTimeoutMin"], kind: "int" },
  { name: "CLAUDE_BIN", path: ["claude", "bin"], kind: "string" },
  { name: "CLAUDE_TIMEOUT_MIN", path: ["claude", "timeoutMin"], kind: "int" },
  { name: "CLAUDE_MODEL", path: ["routing", "default", "model"], kind: "string" },
  { name: "CLAUDE_EFFORT", path: ["routing", "default", "effort"], kind: "string" },
  { name: "CLAUDE_MAX_TURNS", path: ["routing", "default", "maxTurns"], kind: "int" },
  { name: "WORKSPACE_DIR", path: ["paths", "workspaceDir"], kind: "string" },
  { name: "DATA_DIR", path: ["paths", "dataDir"], kind: "string" },
  { name: "LOG_LEVEL", path: ["logLevel"], kind: "string" },
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
