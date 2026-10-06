import { readFileSync } from "node:fs";

import { parse as parseYaml } from "yaml";
import type { z } from "zod";

import { CONFIG_FILE_VAR, ENV_VARS, parseEnvValue } from "./env.js";
import { configSchema, type Config } from "./schema.js";

/**
 * Builds the validated config from an optional YAML file (CONFIG_FILE) with
 * environment variables layered on top. Env wins so deployments can override a
 * shared file per environment; secrets are only accepted from env.
 */

export class ConfigError extends Error {
  override name = "ConfigError";
}

export type Tree = Record<string, unknown>;

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  readFile?: (path: string) => string;
  /** Dashboard overrides (see overrides.ts), applied on top of env. */
  overrides?: Readonly<Record<string, unknown>>;
}

/** The raw inputs config is built from, kept so it can be rebuilt with new overrides. */
export interface ConfigLayers {
  configFile: string | undefined;
  file: Tree;
  env: Tree;
}

export function loadConfig(options: LoadConfigOptions = {}): Config {
  return buildConfig(readConfigLayers(options), options.overrides ?? {});
}

export function readConfigLayers(options: LoadConfigOptions = {}): ConfigLayers {
  const env = options.env ?? process.env;
  const readFile = options.readFile ?? ((file: string) => readFileSync(file, "utf8"));

  const configFile = nonEmpty(env[CONFIG_FILE_VAR]);
  const fromFile = configFile === undefined ? {} : readConfigFile(configFile, readFile);
  rejectSecretsInFile(fromFile, configFile ?? "");
  return { configFile, file: fromFile, env: configFromEnv(env) };
}

/**
 * Validate file < env < overrides. Each override replaces the whole value at
 * its key (so an edited routing table or repo list is taken as a whole), and
 * `null` unsets an optional key.
 */
export function buildConfig(
  layers: ConfigLayers,
  overrides: Readonly<Record<string, unknown>>,
): Config {
  // A copy: deepMerge shares unmerged subtrees with the layers, which must stay intact.
  const tree = structuredClone(deepMerge(layers.file, layers.env));
  for (const [key, value] of Object.entries(overrides)) {
    const path = key.split(".");
    if (value === null) deleteAt(tree, path);
    else setAt(tree, path, structuredClone(value));
  }
  const result = configSchema.safeParse(tree);
  if (!result.success) {
    throw new ConfigError(formatIssues(result.error.issues, layers.configFile));
  }
  return result.data;
}

/** A copy of the config that is safe to log: secret values are replaced. */
export function redactConfig(config: Config): Tree {
  const copy = structuredClone(config) as unknown as Tree;
  for (const { path } of ENV_VARS.filter((v) => v.secret)) {
    const parent = getAt(copy, path.slice(0, -1));
    const key = path.at(-1);
    if (isTree(parent) && key !== undefined && parent[key] !== undefined) {
      parent[key] = "[redacted]";
    }
  }
  return copy;
}

function configFromEnv(env: NodeJS.ProcessEnv): Tree {
  const tree: Tree = {};
  for (const { name, path, kind } of ENV_VARS) {
    const raw = nonEmpty(env[name]);
    if (raw !== undefined) setAt(tree, path, parseEnvValue(kind, raw));
  }
  return tree;
}

function readConfigFile(file: string, readFile: (path: string) => string): Tree {
  let text: string;
  try {
    text = readFile(file);
  } catch (error) {
    throw new ConfigError(`cannot read ${CONFIG_FILE_VAR} ${file}: ${errorMessage(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch (error) {
    throw new ConfigError(`invalid YAML in ${file}: ${errorMessage(error)}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isTree(parsed))
    throw new ConfigError(`${file} must contain a YAML mapping at the top level`);
  return parsed;
}

function rejectSecretsInFile(fromFile: Tree, file: string): void {
  for (const { name, path, secret } of ENV_VARS) {
    if (secret && getAt(fromFile, path) !== undefined) {
      throw new ConfigError(`${path.join(".")} must be set with ${name}, not in ${file}`);
    }
  }
}

function formatIssues(issues: readonly z.core.$ZodIssue[], configFile: string | undefined): string {
  const lines = issues.map((issue) => {
    const key = issue.path.map(String).join(".") || "(root)";
    // Prefix match so list entries (`repos.0`) still point at their variable.
    const envVar = ENV_VARS.find((v) => {
      const varKey = v.path.join(".");
      return key === varKey || key.startsWith(`${varKey}.`);
    });
    const source = envVar ? ` (${envVar.name})` : "";
    return `  - ${key}${source}: ${issue.message}`;
  });
  const fileNote = configFile === undefined ? "" : ` (env + ${configFile})`;
  return `invalid configuration${fileNote}:\n${lines.join("\n")}`;
}

/** Objects merge recursively; arrays and scalars from `over` replace `base`. */
function deepMerge(base: Tree, over: Tree): Tree {
  const out: Tree = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const existing = out[key];
    out[key] = isTree(existing) && isTree(value) ? deepMerge(existing, value) : value;
  }
  return out;
}

export function setAt(tree: Tree, path: readonly string[], value: unknown): void {
  let node = tree;
  for (const key of path.slice(0, -1)) {
    const next = node[key];
    node = isTree(next) ? next : (node[key] = {});
  }
  const last = path.at(-1);
  if (last !== undefined) node[last] = value;
}

export function getAt(tree: Tree, path: readonly string[]): unknown {
  let node: unknown = tree;
  for (const key of path) {
    if (!isTree(node)) return undefined;
    node = node[key];
  }
  return node;
}

function deleteAt(tree: Tree, path: readonly string[]): void {
  const parent = getAt(tree, path.slice(0, -1));
  const key = path.at(-1);
  if (isTree(parent) && key !== undefined) Reflect.deleteProperty(parent, key);
}

export function isTree(value: unknown): value is Tree {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === "" ? undefined : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
