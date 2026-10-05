import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

import { ENV_VARS } from "../config/env.js";
import type { Config, Phase, RouteSpec } from "../config/schema.js";
import { checkReport, reportJsonSchema, type Report } from "./report.js";
import {
  applyStreamLine,
  emptyStreamState,
  type RateLimitInfo,
  type StreamState,
} from "./stream.js";

/**
 * Runs one headless Claude Code session (`claude -p`) in a workspace and turns
 * what happened into a single outcome the engine can act on.
 *
 * The process gets its own process group so a timeout or abort kills Claude
 * and everything it started (test runners, dev servers). It inherits the
 * dispatcher's environment minus the dispatcher's own secrets.
 */

export type RunKind =
  "success" | "rate_limited" | "max_turns" | "max_budget" | "timeout" | "aborted" | "error";

export interface ClaudeRunResult {
  kind: RunKind;
  /** Session to `--resume` for follow-up rounds. */
  sessionId: string;
  report?: Report;
  rateLimit?: RateLimitInfo;
  error?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  numTurns?: number;
  stderrTail: string;
}

export interface RunnerOptions {
  bin: string;
  timeoutMs: number;
  permissionMode: Config["claude"]["permissionMode"];
  maxBudgetUsd?: number | undefined;
  labelPrefix: string;
  /** Base environment for the child; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** How long to wait after SIGTERM before SIGKILL. */
  killGraceMs?: number;
}

export interface RunRequest {
  phase: Phase;
  issue: number;
  cwd: string;
  prompt: string;
  systemPrompt: string;
  route: RouteSpec & { maxTurns: number };
  /** Continue this session instead of starting a new one. */
  resumeSessionId?: string | undefined;
  signal?: AbortSignal | undefined;
}

const STDERR_TAIL_BYTES = 8 * 1024;
const USAGE_LIMIT_TEXT = /(usage|rate) limit|rate limited/i;

export function runnerOptionsFromConfig(config: Config): RunnerOptions {
  return {
    bin: config.claude.bin,
    timeoutMs: config.claude.timeoutMin * 60_000,
    permissionMode: config.claude.permissionMode,
    maxBudgetUsd: config.claude.maxBudgetUsd,
    labelPrefix: config.labelPrefix,
  };
}

export function buildArgs(
  options: RunnerOptions,
  request: RunRequest,
  sessionId: string,
): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    ...(request.resumeSessionId === undefined
      ? ["--session-id", sessionId]
      : ["--resume", request.resumeSessionId]),
    "--max-turns",
    String(request.route.maxTurns),
    "--permission-mode",
    options.permissionMode,
    "--json-schema",
    reportJsonSchema(),
    "--append-system-prompt",
    request.systemPrompt,
  ];
  if (request.route.model !== undefined) args.push("--model", request.route.model);
  if (request.route.effort !== undefined) args.push("--effort", request.route.effort);
  if (options.maxBudgetUsd !== undefined) {
    args.push("--max-budget-usd", String(options.maxBudgetUsd));
  }
  return args;
}

/** The child's environment: everything except the dispatcher's secrets. */
export function childEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const secrets = new Set(ENV_VARS.filter((v) => v.secret).map((v) => v.name));
  return Object.fromEntries(Object.entries(base).filter(([name]) => !secrets.has(name)));
}

export function runClaude(options: RunnerOptions, request: RunRequest): Promise<ClaudeRunResult> {
  const sessionId = request.resumeSessionId ?? randomUUID();
  const state = emptyStreamState();
  let stderrTail = "";
  let timedOut = false;

  return new Promise((resolve) => {
    const child = spawn(options.bin, buildArgs(options, request, sessionId), {
      cwd: request.cwd,
      env: childEnv(options.env ?? process.env),
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // Group already gone.
      }
    };
    const stop = () => {
      killGroup("SIGTERM");
      setTimeout(() => {
        killGroup("SIGKILL");
      }, options.killGraceMs ?? 10_000).unref();
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);
    const onAbort = () => {
      stop();
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      applyStreamLine(state, line);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
    });
    // The prompt goes over stdin: no argv length limit, and not visible in `ps`.
    child.stdin.on("error", () => {
      // Ignore EPIPE if the process exits before reading its prompt.
    });
    child.stdin.end(request.prompt);

    // Resolve once the process has exited *and* every stdout line was parsed
    // (the two events can arrive in either order). A spawn failure may never
    // emit "close", so it finishes on its own.
    let exitCode: number | null = null;
    let exited = false;
    let drained = false;
    let settled = false;
    const finish = (spawnError?: Error) => {
      if (settled || (!spawnError && !(exited && drained))) return;
      settled = true;
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onAbort);
      // Don't leave anything Claude started running after it exits.
      killGroup("SIGKILL");
      resolve(
        classify(state, {
          sessionId,
          exitCode,
          timedOut,
          aborted: request.signal?.aborted === true,
          spawnError,
          stderrTail,
          labelPrefix: options.labelPrefix,
          issue: request.issue,
        }),
      );
    };
    lines.on("close", () => {
      drained = true;
      finish();
    });
    child.on("error", (error) => {
      finish(error);
    });
    child.on("close", (code) => {
      exitCode = code;
      exited = true;
      finish();
    });
  });
}

interface ExitFacts {
  sessionId: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  spawnError: Error | undefined;
  stderrTail: string;
  labelPrefix: string;
  issue: number;
}

/** Decide what a finished run means. Exported for tests. */
export function classify(state: StreamState, facts: ExitFacts): ClaudeRunResult {
  const result = state.result;
  const base: ClaudeRunResult = {
    kind: "error",
    sessionId: state.sessionId ?? facts.sessionId,
    stderrTail: facts.stderrTail,
    ...(state.rateLimit ? { rateLimit: state.rateLimit } : {}),
    ...(result?.costUsd === undefined ? {} : { costUsd: result.costUsd }),
    ...(result?.inputTokens === undefined ? {} : { inputTokens: result.inputTokens }),
    ...(result?.outputTokens === undefined ? {} : { outputTokens: result.outputTokens }),
    ...(result?.numTurns === undefined ? {} : { numTurns: result.numTurns }),
  };

  if (facts.spawnError) {
    return { ...base, error: `could not start Claude: ${facts.spawnError.message}` };
  }
  if (facts.aborted) return { ...base, kind: "aborted", error: "run aborted" };
  if (facts.timedOut) return { ...base, kind: "timeout", error: "run exceeded its time limit" };

  if (result?.subtype === "success" && !result.isError) {
    const check = checkReport(result.structuredOutput, facts.labelPrefix, facts.issue);
    return check.ok
      ? { ...base, kind: "success", report: check.report }
      : { ...base, error: check.error };
  }

  const message = result
    ? [...result.errors, result.resultText ?? ""].filter((text) => text !== "").join("; ")
    : "";
  if (state.rateLimit?.status === "rejected" || USAGE_LIMIT_TEXT.test(message)) {
    return { ...base, kind: "rate_limited", error: message || "rate limited" };
  }
  if (result?.subtype === "error_max_turns") return { ...base, kind: "max_turns", error: message };
  if (result?.subtype === "error_max_budget_usd") {
    return { ...base, kind: "max_budget", error: message };
  }
  const lastStderrLine = facts.stderrTail.trim().split("\n").at(-1) ?? "";
  const fallback = result
    ? `run ended with ${result.subtype}`
    : `Claude exited with code ${String(facts.exitCode)} without a result${
        state.malformedLines > 0 ? ` (${String(state.malformedLines)} unparseable lines)` : ""
      }${lastStderrLine === "" ? "" : `: ${lastStderrLine}`}`;
  return { ...base, error: message || fallback };
}
