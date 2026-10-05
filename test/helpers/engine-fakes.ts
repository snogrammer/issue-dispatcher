/**
 * Shared fakes for engine and lifecycle tests: a scripted Claude runner, a
 * workspace that records pushes (and moves branch heads in the fake Gitea),
 * and a `setup()` that wires them into an Engine with a controllable clock.
 */
import type { Report } from "../../src/claude/report.js";
import type { ClaudeRunResult, RunRequest } from "../../src/claude/runner.js";
import { loadConfig } from "../../src/config/load.js";
import { Engine } from "../../src/engine/engine.js";
import type { Lifecycle, WorkspaceLike } from "../../src/engine/lifecycle.js";
import { StateStore } from "../../src/state/store.js";
import { FakeGitea } from "./fake-gitea.js";

export const BOT = "bot";
export const REVIEWER = "human";
export const A = "org/a";
export const B = "org/b";

export type Script =
  | ClaudeRunResult["kind"]
  | "hold"
  | { report: Report }
  | ((request: RunRequest) => ClaudeRunResult);

/**
 * Scripted Claude runs. Each run takes the next script entry (default:
 * success with a one-branch report). "hold" keeps the run going until
 * `release()` or an abort.
 */
export class FakeRunner {
  readonly requests: RunRequest[] = [];
  private readonly scripts: Script[] = [];
  private readonly held: ((result: ClaudeRunResult) => void)[] = [];

  script(...entries: Script[]): this {
    this.scripts.push(...entries);
    return this;
  }

  release(kind: ClaudeRunResult["kind"] = "success"): void {
    const finish = this.held.shift();
    if (!finish) throw new Error("no held run");
    finish(this.result(kind, this.requests.at(-1)));
  }

  run = (request: RunRequest): Promise<ClaudeRunResult> => {
    this.requests.push(request);
    const script = this.scripts.shift() ?? "success";
    if (typeof script === "function") return Promise.resolve(script(request));
    if (typeof script === "object") {
      return Promise.resolve({ ...this.result("success", request), report: script.report });
    }
    if (script !== "hold") return Promise.resolve(this.result(script, request));
    return new Promise((resolve) => {
      this.held.push(resolve);
      request.signal?.addEventListener("abort", () => {
        resolve(this.result("aborted", request));
      });
    });
  };

  private result(kind: ClaudeRunResult["kind"], request?: RunRequest): ClaudeRunResult {
    const sessionId = request?.resumeSessionId ?? request?.sessionId ?? "s";
    const issue = request?.issue ?? 0;
    const base = { sessionId, stderrTail: "", costUsd: 0.1 };
    switch (kind) {
      case "success":
        return { ...base, kind, report: report(issue) };
      case "rate_limited":
        return {
          ...base,
          kind,
          error: "usage limit",
          rateLimit: { status: "rejected", resetsAt: new Date("2026-06-01T05:00:00Z") },
        };
      default:
        return { ...base, kind, error: `${kind} happened` };
    }
  }
}

export function report(issue: number, overrides: Partial<Report> = {}): Report {
  return {
    outcome: "completed",
    summary: "Did it.",
    branches: [{ name: `claude/${String(issue)}-x`, title: "T", body: "B" }],
    decisions: [],
    followups: [],
    ...overrides,
  };
}

/**
 * Records prepares and pushes. Each push gives the branch a new head SHA
 * (`sha-1`, `sha-2`, …) unless `stuck` is set, in which case the head stays
 * put (a round that committed nothing). Pushes are mirrored into the fake
 * Gitea so open PRs see their new head.
 */
export class FakeWorkspace implements WorkspaceLike {
  readonly dir = "/work";
  readonly prepared: [string, string][] = [];
  readonly pushed: [number, string[]][] = [];
  readonly heads = new Map<string, string>();
  failPrepare = false;
  stuck = false;
  private counter = 0;

  constructor(
    private readonly gitea?: FakeGitea,
    private readonly repo?: string,
  ) {}

  prepare(branch: string, base: string): Promise<string> {
    if (this.failPrepare) return Promise.reject(new Error("git fetch failed"));
    this.prepared.push([branch, base]);
    return Promise.resolve(this.heads.get(branch) ?? "base-sha");
  }

  push(issue: number, branches: string[]): Promise<Map<string, string>> {
    this.pushed.push([issue, branches]);
    const result = new Map<string, string>();
    for (const branch of branches) {
      const previous = this.heads.get(branch);
      const head = this.stuck && previous ? previous : `sha-${String(++this.counter)}`;
      this.heads.set(branch, head);
      if (this.gitea && this.repo) this.gitea.setBranchHead(this.repo, branch, head);
      result.set(branch, head);
    }
    return Promise.resolve(result);
  }

  isClean(): Promise<boolean> {
    return Promise.resolve(true);
  }

  commitsAhead(): Promise<number> {
    return Promise.resolve(1);
  }
}

export function setup(
  env: Record<string, string> = {},
  lifecycle?: (deps: {
    config: ReturnType<typeof loadConfig>;
    gitea: FakeGitea;
    now: () => Date;
  }) => Lifecycle,
) {
  const config = loadConfig({
    env: {
      GITEA_URL: "https://gitea.example.com",
      GITEA_TOKEN: "t",
      BOT_USERNAME: BOT,
      HUMAN_REVIEWER: REVIEWER,
      REPOS: `${A},${B}`,
      ...env,
    },
  });
  const gitea = new FakeGitea(BOT);
  gitea.addRepo(A);
  gitea.addRepo(B);
  const clock = { now: new Date("2026-06-01T00:00:00Z") };
  const now = () => clock.now;
  // The store timestamps work (e.g. when a PR head last changed) with the same clock.
  const store = StateStore.inMemory({ now });
  const runner = new FakeRunner();
  const workspaces = new Map<string, FakeWorkspace>();
  const workspace = (name: string) => {
    let ws = workspaces.get(name);
    if (!ws) workspaces.set(name, (ws = new FakeWorkspace(gitea, name)));
    return ws;
  };
  let sessions = 0;
  const make = () =>
    new Engine({
      config,
      gitea,
      store,
      workspace: (repo) => workspace(repo.fullName),
      runClaude: runner.run,
      now,
      newSessionId: () => `session-${String(++sessions)}`,
      ...(lifecycle ? { lifecycle: lifecycle({ config, gitea, now }) } : {}),
    });
  return { config, gitea, store, runner, workspace, clock, make, engine: make() };
}

/** Run one poll and let every started run finish. */
export async function cycle(engine: Engine): Promise<void> {
  await engine.tick();
  await engine.idle();
}
