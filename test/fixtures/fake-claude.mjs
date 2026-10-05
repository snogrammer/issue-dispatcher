#!/usr/bin/env node
// Stand-in for the `claude` CLI in runner tests. Behavior is chosen with
// FAKE_CLAUDE_SCENARIO; argv, stdin and selected env vars are written to
// FAKE_CLAUDE_RECORD (JSON) so tests can assert how the CLI was invoked.
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";

const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? "success";
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const sessionId = flag("--resume") ?? flag("--session-id") ?? "no-session";

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (stdin += chunk));
process.stdin.on("end", run);

function emit(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

const report = {
  outcome: "completed",
  summary: "Did the thing.",
  branches: [{ name: "claude/7-runner", title: "Runner", body: "Adds the runner." }],
  decisions: [],
  followups: [],
};

function result(extra) {
  emit({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 4,
    session_id: sessionId,
    total_cost_usd: 0.42,
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 1000,
      output_tokens: 50,
    },
    ...extra,
  });
}

function run() {
  if (process.env.FAKE_CLAUDE_RECORD) {
    writeFileSync(
      process.env.FAKE_CLAUDE_RECORD,
      JSON.stringify({
        args,
        stdin,
        cwd: process.cwd(),
        env: { GITEA_TOKEN: process.env.GITEA_TOKEN ?? null, KEEP_ME: process.env.KEEP_ME ?? null },
      }),
    );
  }
  emit({ type: "system", subtype: "init", session_id: sessionId });
  switch (scenario) {
    case "success":
      emit({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "allowed_warning",
          resetsAt: 1800000000,
          rateLimitType: "five_hour",
          utilization: 0.91,
        },
        session_id: sessionId,
      });
      emit({ type: "assistant", message: { content: [{ type: "text", text: "working" }] } });
      result({ structured_output: report });
      return;
    case "invalid-report":
      result({
        structured_output: { ...report, branches: [{ name: "main", title: "x", body: "" }] },
      });
      return;
    case "max-turns":
      result({
        subtype: "error_max_turns",
        is_error: true,
        errors: ["Reached maximum number of turns (3)"],
      });
      process.exitCode = 1;
      return;
    case "rate-limited":
      emit({
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", resetsAt: 1800000000, rateLimitType: "five_hour" },
        session_id: sessionId,
      });
      result({ is_error: true, result: "Claude AI usage limit reached" });
      process.exitCode = 1;
      return;
    case "malformed":
      process.stdout.write('this is not json\n{"half":\n');
      process.stderr.write("boom: something broke\n");
      process.exitCode = 2;
      return;
    case "hang": {
      // A grandchild that would outlive us if the process group weren't killed.
      const child = spawn("sleep", ["300"], { stdio: "ignore" });
      writeFileSync(process.env.FAKE_CLAUDE_PIDFILE ?? "/dev/null", String(child.pid));
      setInterval(() => {}, 1000);
      return;
    }
    default:
      process.stderr.write(`unknown scenario ${scenario}\n`);
      process.exitCode = 3;
  }
}
