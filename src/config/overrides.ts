import { ENV_VARS } from "./env.js";
import { buildConfig, ConfigError, getAt, isTree, type ConfigLayers, type Tree } from "./load.js";
import { EFFORT_LEVELS, type Config } from "./schema.js";

/**
 * Config changes made from the dashboard. They are stored in the state
 * database as a flat map of key → value (`"rateLimit.backoffBaseMin": 20`)
 * and layered over the YAML file and env, so a value set in the UI wins.
 *
 * Only runtime knobs are editable, and every one of them is applied to the
 * running process without a restart: the engine, PR lifecycle and governor
 * read the shared config object on every use, so `applyConfig` updates it in
 * place. Identity (Gitea URL, bot, reviewer, label prefix), paths, the status
 * server, the Claude binary and permission mode, and secrets stay env/file
 * only: changing those safely means restarting, and some of them are exactly
 * what a stolen dashboard session must not be able to touch.
 */

export type Overrides = Record<string, unknown>;

export type EditableType = "int" | "number" | "bool" | "enum" | "list" | "json";

export interface EditableKey {
  key: string;
  type: EditableType;
  group: "Polling" | "Merging" | "Rate limits" | "Claude runs" | "Repos" | "Logging";
  help: string;
  options?: readonly string[];
  min?: number;
  max?: number;
  /** Can be cleared (null) to fall back to its default. */
  nullable?: true;
}

const MERGE_STYLES = ["merge", "rebase", "rebase-merge", "squash", "fast-forward-only"] as const;
const LOG_LEVELS = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

export const EDITABLE_KEYS: readonly EditableKey[] = [
  {
    key: "pollIntervalS",
    type: "int",
    group: "Polling",
    min: 10,
    help: "Seconds between reconcile passes",
  },
  {
    key: "maxConcurrentSessions",
    type: "int",
    group: "Polling",
    min: 1,
    help: "Claude sessions running at once, across all repos. Lowering it never stops a run.",
  },
  {
    key: "ciMaxQueue",
    type: "int",
    group: "Polling",
    min: 1,
    help: "Don't start runs while this many Actions runs are queued or running",
  },
  {
    key: "maxFixAttempts",
    type: "int",
    group: "Merging",
    min: 0,
    help: "CI/review fix rounds before asking the human",
  },
  {
    key: "requireCi",
    type: "bool",
    group: "Merging",
    help: "Never auto-merge a PR that reports no CI status",
  },
  {
    key: "mergeStyle",
    type: "enum",
    group: "Merging",
    options: MERGE_STYLES,
    nullable: true,
    help: "Unset uses each repo's default merge style",
  },
  {
    key: "ciNoStatusTimeoutMin",
    type: "int",
    group: "Merging",
    min: 1,
    help: "Minutes without any CI status before filing a question issue",
  },
  {
    key: "rateLimit.backoffBaseMin",
    type: "int",
    group: "Rate limits",
    min: 1,
    help: "Pause after a usage limit with no reset time, doubling each time",
  },
  {
    key: "rateLimit.backoffMaxMin",
    type: "int",
    group: "Rate limits",
    min: 1,
    help: "Cap for that backoff (at least the base)",
  },
  {
    key: "rateLimit.pickupThreshold",
    type: "number",
    group: "Rate limits",
    min: 0,
    max: 1,
    help: "Stop picking up new issues once a usage window is this full",
  },
  {
    key: "claude.timeoutMin",
    type: "int",
    group: "Claude runs",
    min: 1,
    help: "Wall-clock limit per Claude run (applies to runs started afterwards)",
  },
  {
    key: "claude.maxBudgetUsd",
    type: "number",
    group: "Claude runs",
    min: 0,
    nullable: true,
    help: "Per-run spending cap (API-key billing); unset for none",
  },
  {
    key: "routing",
    type: "json",
    group: "Claude runs",
    help: `Model/effort/turn routing: default, phases, repos, modelLabels. Efforts: ${EFFORT_LEVELS.join(", ")}`,
  },
  {
    key: "repos",
    type: "list",
    group: "Repos",
    help: "owner/repo names to watch",
  },
  { key: "orgs", type: "list", group: "Repos", help: "Orgs whose repos are discovered" },
  { key: "logLevel", type: "enum", group: "Logging", options: LOG_LEVELS, help: "Log threshold" },
];

const EDITABLE = new Map(EDITABLE_KEYS.map((entry) => [entry.key, entry]));

export function isEditable(key: string): boolean {
  return EDITABLE.has(key);
}

/**
 * Check the shape of an override document: an object whose keys are all
 * editable, with `null` only where a key can be cleared. Values are checked
 * by the config schema when the document is applied.
 */
export function validateOverrides(input: unknown): Overrides {
  if (!isTree(input)) throw new ConfigError("overrides must be a JSON object");
  for (const [key, value] of Object.entries(input)) {
    const entry = EDITABLE.get(key);
    if (entry === undefined) {
      throw new ConfigError(
        `${key} can't be changed from the dashboard; set it in env or the file`,
      );
    }
    if (value === null && entry.nullable !== true) {
      throw new ConfigError(`${key} can't be cleared; remove the override to use env/file`);
    }
  }
  return input;
}

export type Source = "default" | "file" | "env" | "dashboard";

/** Where the effective value at `key` came from: the highest layer that sets it. */
export function sourceOf(layers: ConfigLayers, overrides: Overrides, key: string): Source {
  if (Object.hasOwn(overrides, key)) return "dashboard";
  const path = key.split(".");
  if (getAt(layers.env, path) !== undefined) return "env";
  if (getAt(layers.file, path) !== undefined) return "file";
  return "default";
}

/**
 * Copy every editable value from `next` into `live` in place, keeping nested
 * objects (e.g. `rateLimit`, which the governor holds) the same instances.
 * Returns the keys whose value changed.
 */
export function applyConfig(live: Config, next: Config): string[] {
  const changed: string[] = [];
  for (const { key } of EDITABLE_KEYS) {
    const path = key.split(".");
    const before = getAt(live, path);
    const after = getAt(next, path);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    const parent = getAt(live, path.slice(0, -1)) ?? live;
    const last = path.at(-1);
    if (!isTree(parent) || last === undefined) continue;
    if (after === undefined) Reflect.deleteProperty(parent, last);
    else parent[last] = structuredClone(after);
    changed.push(key);
  }
  return changed;
}

export interface EditableView extends EditableKey {
  value: unknown;
  source: Source;
  /** The env var that also sets this key, if any. */
  env?: string;
}

export interface ReadOnlyView {
  key: string;
  env: string;
  value: unknown;
  source: Source;
  secret: boolean;
}

export interface ConfigView {
  configFile: string | null;
  editable: EditableView[];
  readOnly: ReadOnlyView[];
  overrides: Overrides;
}

export interface ConfigManagerOptions {
  layers: ConfigLayers;
  /** The config object the rest of the process holds; updated in place. */
  live: Config;
  overrides: Overrides;
  save: (overrides: Overrides) => void;
  onChange?: (changed: string[]) => void;
}

/** Owns the dashboard overrides: shows where each value comes from, validates and applies edits. */
export class ConfigManager {
  private overrides: Overrides;

  constructor(private readonly options: ConfigManagerOptions) {
    this.overrides = structuredClone(options.overrides);
  }

  view(): ConfigView {
    const { layers, live } = this.options;
    const tree = live as unknown as Tree;
    const envFor = (key: string) => ENV_VARS.find((v) => v.path.join(".") === key)?.name;
    const editable = EDITABLE_KEYS.map((entry) => {
      const env = envFor(entry.key);
      return {
        ...entry,
        value: getAt(tree, entry.key.split(".")) ?? null,
        source: sourceOf(layers, this.overrides, entry.key),
        ...(env === undefined ? {} : { env }),
      };
    });
    const readOnly = ENV_VARS.filter(
      (v) => !EDITABLE.has(v.path.join(".")) && v.path[0] !== "routing",
    ).map((v) => {
      const key = v.path.join(".");
      const value = getAt(tree, v.path);
      return {
        key,
        env: v.name,
        value: v.secret === true ? (value === undefined ? null : "[redacted]") : (value ?? null),
        source: sourceOf(layers, {}, key),
        secret: v.secret === true,
      };
    });
    return {
      configFile: layers.configFile ?? null,
      editable,
      readOnly,
      overrides: structuredClone(this.overrides),
    };
  }

  /**
   * Replace the override document. Nothing is saved or applied unless the
   * resulting config is valid. Returns the keys whose effective value changed.
   */
  update(input: unknown): string[] {
    const overrides = validateOverrides(input);
    const next = buildConfig(this.options.layers, overrides);
    this.options.save(overrides);
    this.overrides = structuredClone(overrides);
    const changed = applyConfig(this.options.live, next);
    if (changed.length > 0) this.options.onChange?.(changed);
    return changed;
  }
}
