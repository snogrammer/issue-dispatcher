import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { issueFromBranch } from "../conventions.js";
import type { RepoRef } from "../gitea/types.js";
import { ensureToolchain, type ToolchainResult } from "./toolchain.js";

/**
 * One git checkout per watched repo, reused across runs. The dispatcher does
 * all network git here (clone, fetch, push); Claude only commits locally.
 *
 * Credentials never touch disk: the Gitea token is passed to the git process
 * as an `http.<url>.extraHeader` through GIT_CONFIG_* environment variables,
 * and only for clone/fetch/push, so nothing in `.git/config`, remotes or
 * process arguments contains it, and it is absent while Claude runs.
 */

const exec = promisify(execFile);

export interface WorkspaceOptions {
  /** WORKSPACE_DIR; each repo lives at <root>/<owner>/<name>. */
  root: string;
  giteaUrl: string;
  token: string;
  userName: string;
  userEmail: string;
  labelPrefix: string;
  /** Override the clone URL (tests use local bare repos). */
  cloneUrl?: (repo: RepoRef) => string;
  /** Install pinned language versions before runs; omitted means don't. */
  toolchain?: { timeoutMs: number };
}

export class GitError extends Error {
  override name = "GitError";
}

export class Workspace {
  readonly dir: string;

  constructor(
    private readonly options: WorkspaceOptions,
    private readonly repo: RepoRef,
  ) {
    this.dir = path.join(options.root, repo.owner, repo.name);
  }

  /** Clone the repo if this workspace doesn't have it yet. */
  async ensureClone(): Promise<void> {
    if (existsSync(path.join(this.dir, ".git"))) return;
    mkdirSync(path.dirname(this.dir), { recursive: true });
    await this.git(["clone", "--quiet", this.cloneUrl(), this.dir], {
      auth: true,
      cwd: path.dirname(this.dir),
    });
  }

  /**
   * Fetch, discard any leftovers from a previous run, and check out `branch`:
   * continuing from the remote branch if it exists, otherwise starting it from
   * `base`. Ignored files (dependency caches) are kept to save reinstalls.
   * Returns the checked-out commit.
   */
  async prepare(branch: string, base: string): Promise<string> {
    await this.ensureClone();
    await this.git(["fetch", "--quiet", "--prune", "origin"], { auth: true });
    await this.git(["config", "user.name", this.options.userName]);
    await this.git(["config", "user.email", this.options.userEmail]);
    await this.git(["rebase", "--abort"]).catch(() => undefined);
    await this.git(["reset", "--quiet", "--hard"]);
    await this.git(["clean", "-fdq"]);
    const start = (await this.remoteBranchExists(branch)) ? `origin/${branch}` : `origin/${base}`;
    await this.git(["checkout", "--quiet", "-B", branch, start]);
    return this.head(branch);
  }

  /** Install the language versions the checkout pins (see toolchain.ts). */
  async ensureToolchain(): Promise<ToolchainResult> {
    const { toolchain } = this.options;
    if (toolchain === undefined) return { env: {}, problems: [] };
    return ensureToolchain(this.dir, toolchain);
  }

  /**
   * Push the issue's branches. Refuses any branch that doesn't belong to
   * `issue`, and uses --force-with-lease so a rebased branch can be updated
   * but a branch someone else pushed to since our fetch is never clobbered.
   * Returns each branch's pushed commit.
   */
  async push(issue: number, branches: string[]): Promise<Map<string, string>> {
    const foreign = branches.filter(
      (branch) => issueFromBranch(this.options.labelPrefix, branch) !== issue,
    );
    if (foreign.length > 0) {
      throw new GitError(
        `refusing to push branches not owned by #${String(issue)}: ${foreign.join(", ")}`,
      );
    }
    const pushed = new Map<string, string>();
    for (const branch of branches) {
      await this.git(
        [
          "push",
          "--quiet",
          "--force-with-lease",
          "origin",
          `refs/heads/${branch}:refs/heads/${branch}`,
        ],
        { auth: true },
      );
      pushed.set(branch, await this.head(branch));
    }
    return pushed;
  }

  /**
   * Replay `branch`'s own commits (those after `upstream`) onto the remote
   * `onto` branch. Used after the PR below it in a stack merged: with squash
   * or rebase merges, `upstream`'s commits now exist in `onto` under new SHAs.
   * On conflicts the rebase is aborted and the branch left as it was.
   */
  async rebaseOnto(
    branch: string,
    onto: string,
    upstream: string,
  ): Promise<"rebased" | "conflict"> {
    await this.git(["fetch", "--quiet", "--prune", "origin"], { auth: true });
    await this.git(["checkout", "--quiet", branch]);
    try {
      await this.git(["rebase", "--quiet", "--onto", `origin/${onto}`, upstream, branch]);
      return "rebased";
    } catch {
      await this.git(["rebase", "--abort"]).catch(() => undefined);
      return "conflict";
    }
  }

  /** True if `commit` is in `ref`'s history (e.g. a stack's merged base not yet rebased away). */
  async isAncestor(commit: string, ref: string): Promise<boolean> {
    try {
      await this.git(["merge-base", "--is-ancestor", commit, ref]);
      return true;
    } catch {
      return false;
    }
  }

  async head(ref = "HEAD"): Promise<string> {
    return (await this.git(["rev-parse", ref])).trim();
  }

  /** Commits on `branch` that aren't on the remote `base`. */
  async commitsAhead(branch: string, base: string): Promise<number> {
    return Number((await this.git(["rev-list", "--count", `origin/${base}..${branch}`])).trim());
  }

  async isClean(): Promise<boolean> {
    return (await this.git(["status", "--porcelain"])).trim() === "";
  }

  private async remoteBranchExists(branch: string): Promise<boolean> {
    try {
      await this.git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  private cloneUrl(): string {
    const { owner, name } = this.repo;
    return (
      this.options.cloneUrl?.(this.repo) ??
      `${this.options.giteaUrl.replace(/\/+$/, "")}/${owner}/${name}.git`
    );
  }

  private async git(
    args: string[],
    { auth = false, cwd = this.dir }: { auth?: boolean; cwd?: string } = {},
  ): Promise<string> {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    if (auth) Object.assign(env, authEnv(this.options.giteaUrl, this.options.token));
    try {
      const { stdout } = await exec("git", args, { cwd, env, maxBuffer: 16 * 1024 * 1024 });
      return stdout;
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? "";
      const detail = (stderr.trim() || (error as Error).message).replaceAll(
        this.options.token,
        "[redacted]",
      );
      throw new GitError(`git ${args[0] ?? ""} failed: ${detail}`);
    }
  }
}

/**
 * Environment that makes git send the token to the Gitea host only, via
 * `http.<url>.extraHeader`, without writing it anywhere.
 */
export function authEnv(giteaUrl: string, token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: `http.${giteaUrl.replace(/\/+$/, "")}/.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: token ${token}`,
    // An empty helper resets the list, so a host keychain is never consulted.
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: "",
  };
}
