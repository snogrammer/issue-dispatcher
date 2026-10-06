import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildArgs, childEnv, runClaude, type RunnerOptions, type RunRequest } from "./runner.js";

const FAKE = path.resolve(import.meta.dirname, "../../test/fixtures/fake-claude.mjs");

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dispatcher-runner-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup(scenario: string, overrides: Partial<RunnerOptions> = {}) {
  const dir = tempDir();
  const record = path.join(dir, "record.json");
  const options: RunnerOptions = {
    bin: FAKE,
    timeoutMs: 20_000,
    permissionMode: "bypassPermissions",
    labelPrefix: "claude",
    killGraceMs: 200,
    env: {
      ...process.env,
      FAKE_CLAUDE_SCENARIO: scenario,
      FAKE_CLAUDE_RECORD: record,
      FAKE_CLAUDE_PIDFILE: path.join(dir, "grandchild.pid"),
      GITEA_TOKEN: "must-not-leak",
      KEEP_ME: "yes",
    },
    ...overrides,
  };
  const request: RunRequest = {
    phase: "implement",
    issue: 7,
    cwd: dir,
    prompt: "Implement issue #7",
    systemPrompt: "Rules",
    route: { model: "opus", effort: "high", maxTurns: 30 },
  };
  const recorded = () =>
    JSON.parse(readFileSync(record, "utf8")) as {
      args: string[];
      stdin: string;
      cwd: string;
      env: Record<string, string | null>;
    };
  return { dir, options, request, recorded };
}

/**
 * True if `pid` is running. A killed process whose parent already exited can
 * linger as a zombie until something reaps it (in containers without an init,
 * nothing does), so zombies count as dead.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
    return state.trim() !== "" && !state.trim().startsWith("Z");
  } catch {
    return false;
  }
}

async function eventually(check: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

function argAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe("runClaude", () => {
  it("runs a session and returns the validated report", async () => {
    const { options, request, recorded, dir } = setup("success");
    const result = await runClaude(options, request);

    expect(result).toMatchObject({
      kind: "success",
      costUsd: 0.42,
      inputTokens: 1110,
      outputTokens: 50,
      numTurns: 4,
      rateLimit: { status: "allowed_warning", type: "five_hour", utilization: 0.91 },
      report: { outcome: "completed", branches: [{ name: "claude/7-runner" }] },
    });
    const call = recorded();
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(argAfter(call.args, "--session-id")).toBe(result.sessionId);
    expect(call.args.slice(0, 4)).toEqual(["-p", "--output-format", "stream-json", "--verbose"]);
    expect(argAfter(call.args, "--max-turns")).toBe("30");
    expect(argAfter(call.args, "--model")).toBe("opus");
    expect(argAfter(call.args, "--effort")).toBe("high");
    expect(argAfter(call.args, "--permission-mode")).toBe("bypassPermissions");
    expect(argAfter(call.args, "--append-system-prompt")).toBe("Rules");
    expect(JSON.parse(argAfter(call.args, "--json-schema") ?? "")).toMatchObject({
      type: "object",
    });
    expect(call.stdin).toBe("Implement issue #7");
    expect(call.cwd).toBe(await import("node:fs").then((fs) => fs.realpathSync(dir)));
    expect(call.env).toEqual({ GITEA_TOKEN: null, KEEP_ME: "yes" });
  });

  it("uses a caller-chosen ID for a new session", async () => {
    const { options, request, recorded } = setup("success");
    const result = await runClaude(options, { ...request, sessionId: "chosen-id" });
    expect(result.sessionId).toBe("chosen-id");
    expect(argAfter(recorded().args, "--session-id")).toBe("chosen-id");
  });

  it("resumes an existing session", async () => {
    const { options, request, recorded } = setup("success");
    const result = await runClaude(options, { ...request, resumeSessionId: "old-session" });
    expect(result.sessionId).toBe("old-session");
    const { args } = recorded();
    expect(argAfter(args, "--resume")).toBe("old-session");
    expect(args).not.toContain("--session-id");
  });

  it("reports an invalid report as an error", async () => {
    const { options, request } = setup("invalid-report");
    const result = await runClaude(options, request);
    expect(result.kind).toBe("error");
    expect(result.error).toBe("report lists branches outside claude/7-*: main");
  });

  it("recognizes the turn limit", async () => {
    const { options, request } = setup("max-turns");
    expect(await runClaude(options, request)).toMatchObject({
      kind: "max_turns",
      error: "Reached maximum number of turns (3)",
    });
  });

  it("recognizes rate limits with their reset time", async () => {
    const { options, request } = setup("rate-limited");
    const result = await runClaude(options, request);
    expect(result).toMatchObject({
      kind: "rate_limited",
      rateLimit: { status: "rejected", resetsAt: new Date(1800000000_000) },
    });
  });

  it("recognizes a resume of a session the CLI doesn't have", async () => {
    const { options, request } = setup("session-missing");
    const result = await runClaude(options, { ...request, resumeSessionId: "gone" });
    expect(result).toMatchObject({
      kind: "session_not_found",
      sessionId: "gone",
      error: "No conversation found with session ID: gone",
    });
  });

  it("recognizes unusable credentials", async () => {
    const { options, request } = setup("not-logged-in");
    expect(await runClaude(options, request)).toMatchObject({
      kind: "auth_failed",
      error: "Not logged in · Please run /login",
    });
  });

  it("fails clearly on malformed output", async () => {
    const { options, request } = setup("malformed");
    const result = await runClaude(options, request);
    expect(result.kind).toBe("error");
    expect(result.error).toBe(
      "Claude exited with code 2 without a result (2 unparseable lines): boom: something broke",
    );
    expect(result.stderrTail).toContain("boom: something broke");
  });

  it("fails clearly when the binary can't start", async () => {
    const { options, request } = setup("success", { bin: "/nonexistent/claude" });
    const result = await runClaude(options, request);
    expect(result.kind).toBe("error");
    expect(result.error).toMatch(/^could not start Claude: /);
  });

  it("kills the whole process group on timeout", async () => {
    const { options, request, dir } = setup("hang", { timeoutMs: 1000 });
    const result = await runClaude(options, request);
    expect(result.kind).toBe("timeout");

    const grandchild = Number(readFileSync(path.join(dir, "grandchild.pid"), "utf8"));
    expect(await eventually(() => !isAlive(grandchild))).toBe(true);
  });

  it("stops when aborted", async () => {
    const { options, request } = setup("hang");
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 500);
    expect((await runClaude(options, { ...request, signal: controller.signal })).kind).toBe(
      "aborted",
    );
  });
});

describe("buildArgs", () => {
  it("omits unset route values and adds the budget cap", () => {
    const { options, request } = setup("success", { maxBudgetUsd: 2.5 });
    const args = buildArgs(options, { ...request, route: { maxTurns: 10 } }, "sid");
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--effort");
    expect(argAfter(args, "--max-budget-usd")).toBe("2.5");
  });
});

describe("childEnv", () => {
  it("drops dispatcher secrets and keeps everything else", () => {
    expect(childEnv({ GITEA_TOKEN: "x", ANTHROPIC_API_KEY: "k", PATH: "/bin" })).toEqual({
      ANTHROPIC_API_KEY: "k",
      PATH: "/bin",
    });
  });
});
