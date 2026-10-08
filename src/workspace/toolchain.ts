import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

/**
 * Language versions for a run, installed with asdf before Claude starts.
 * Without them Claude can't run a repo's checks, guesses, and leaves the
 * checking to CI (#52). Installing here, outside the run, keeps it
 * deterministic and out of Claude's budget. Installs are cached in
 * ASDF_DATA_DIR (a volume in Docker), so each version is built once.
 *
 * The exact versions are also returned as ASDF_<TOOL>_VERSION variables for
 * the run. asdf can't match a short pin like `3.12` in `.python-version` to
 * the installed `3.12.7` on its own, but the variables make every shim
 * resolve to the version that was installed.
 */

const exec = promisify(execFile);

/** Version files and the tool each pins; `.tool-versions` names its tools itself. */
const LEGACY_FILES: readonly (readonly [file: string, tool: string])[] = [
  [".python-version", "python"],
  [".ruby-version", "ruby"],
  [".node-version", "nodejs"],
  [".nvmrc", "nodejs"],
];

export interface ToolPin {
  tool: string;
  /** An exact version, or `latest:<prefix>` for a short pin. */
  version: string;
  /** The file it came from. */
  source: string;
}

export interface ToolchainResult {
  /** ASDF_<TOOL>_VERSION for each installed tool, for the run's environment. */
  env: Record<string, string>;
  /** What couldn't be installed, for Claude's prompt. */
  problems: string[];
}

/** Runs asdf with `args` in `cwd`, resolving to stdout. */
export type AsdfRunner = (args: string[], cwd: string) => Promise<string>;

export interface ToolchainOptions {
  /** Per asdf command; Ruby and Python compile from source. */
  timeoutMs: number;
  bin?: string;
  /** Replace the asdf process (tests). */
  run?: AsdfRunner;
}

/**
 * The versions a checkout pins. `.tool-versions` wins over the single-tool
 * files; pins asdf can't install (`system`, `lts/*`, `ref:…`) are skipped.
 */
export function readPins(dir: string): ToolPin[] {
  const pins = new Map<string, ToolPin>();
  const toolVersions = readFile(dir, ".tool-versions");
  for (const line of toolVersions?.split("\n") ?? []) {
    const [tool, raw] = line.replace(/#.*/, "").trim().split(/\s+/);
    if (!tool || !raw || pins.has(tool)) continue;
    const version = normalizeVersion(raw);
    if (version) pins.set(tool, { tool, version, source: ".tool-versions" });
  }
  for (const [file, tool] of LEGACY_FILES) {
    if (pins.has(tool)) continue;
    const raw = readFile(dir, file)?.trim().split(/\s+/)[0];
    const version = raw ? normalizeVersion(raw) : undefined;
    if (version) pins.set(tool, { tool, version, source: file });
  }
  return [...pins.values()];
}

/**
 * `3.12.7` stays as is; `v22`, `3.12` and `ruby-3.3` become `latest:22`,
 * `latest:3.12` and `latest:3.3`. Anything else asdf can't install by number
 * (`system`, `lts/*`, `ref:…`) is undefined.
 */
export function normalizeVersion(raw: string): string | undefined {
  const version = raw.replace(/^(?:v|ruby-|python-|node-)/, "");
  if (!/^\d+(\.\d+)*$/.test(version)) return undefined;
  return version.split(".").length >= 3 ? version : `latest:${version}`;
}

export function versionEnvName(tool: string): string {
  return `ASDF_${tool.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_VERSION`;
}

/**
 * Install every version the checkout in `dir` pins. Never throws: what fails
 * is reported in `problems`, so the run still starts and Claude can say which
 * checks couldn't run (the dispatcher then won't push).
 */
export async function ensureToolchain(
  dir: string,
  options: ToolchainOptions,
): Promise<ToolchainResult> {
  const result: ToolchainResult = { env: {}, problems: [] };
  const pins = readPins(dir);
  if (pins.length === 0) return result;
  const run = options.run ?? asdfRunner(options.bin ?? "asdf", options.timeoutMs);

  for (const pin of pins) {
    const wanted = `${pin.tool} ${pin.version} (from ${pin.source})`;
    try {
      // Fails harmlessly when the plugin is already there.
      await run(["plugin", "add", pin.tool], dir).catch(() => "");
      try {
        await run(["install", pin.tool, pin.version], dir);
      } catch {
        // A cached plugin may not know newer releases yet.
        await run(["plugin", "update", pin.tool], dir).catch(() => "");
        await run(["install", pin.tool, pin.version], dir);
      }
      const exact = pin.version.startsWith("latest:")
        ? (await run(["latest", pin.tool, pin.version.slice("latest:".length)], dir)).trim()
        : pin.version;
      result.env[versionEnvName(pin.tool)] = exact;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        result.problems.push(`asdf isn't installed here, so ${wanted} couldn't be installed.`);
        return result;
      }
      result.problems.push(`Installing ${wanted} failed: ${errorTail(error)}`);
    }
  }
  return result;
}

function asdfRunner(bin: string, timeoutMs: number): AsdfRunner {
  return async (args, cwd) => {
    const { stdout } = await exec(bin, args, {
      cwd,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  };
}

function readFile(dir: string, name: string): string | undefined {
  const file = path.join(dir, name);
  return existsSync(file) ? readFileSync(file, "utf8") : undefined;
}

/** The last lines of a failed command's output: compile errors are at the end. */
function errorTail(error: unknown): string {
  const { stderr, killed, message } = error as {
    stderr?: string;
    killed?: boolean;
    message?: string;
  };
  if (killed) return "timed out";
  const text = (stderr ?? "").trim() || (message ?? String(error));
  return text.split("\n").slice(-5).join("\n");
}
