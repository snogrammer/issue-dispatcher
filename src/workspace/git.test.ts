import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { authEnv, GitError, Workspace } from "./git.js";

const TOKEN = "secret-token-123";
const repo = { owner: "org", name: "repo" };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();
}

/** A bare "remote" with one commit on main, plus a workspace pointed at it. */
function setup() {
  const root = mkdtempSync(path.join(tmpdir(), "dispatcher-git-"));
  dirs.push(root);
  const remote = path.join(root, "remote.git");
  git(root, "init", "--quiet", "--bare", "--initial-branch=main", remote);
  const seed = path.join(root, "seed");
  git(root, "clone", "--quiet", remote, seed);
  writeFileSync(path.join(seed, "README.md"), "hello\n");
  git(seed, "add", ".");
  git(seed, "commit", "--quiet", "-m", "initial");
  git(seed, "push", "--quiet", "origin", "HEAD:main");

  const workspace = new Workspace(
    {
      root: path.join(root, "workspaces"),
      giteaUrl: "https://gitea.example.com",
      token: TOKEN,
      userName: "Bot",
      userEmail: "bot@example.com",
      labelPrefix: "claude",
      cloneUrl: () => remote,
    },
    repo,
  );
  return { root, remote, seed, workspace };
}

/** What Claude does during a run: edit and commit locally. */
function commitFile(dir: string, file: string, content: string, message = `add ${file}`) {
  writeFileSync(path.join(dir, file), content);
  execFileSync("git", ["add", file], { cwd: dir });
  execFileSync("git", ["commit", "--quiet", "-m", message], { cwd: dir });
}

describe("Workspace", () => {
  it("clones once into <root>/<owner>/<name>", async () => {
    const { root, workspace } = setup();
    expect(workspace.dir).toBe(path.join(root, "workspaces", "org", "repo"));
    await workspace.ensureClone();
    await workspace.ensureClone();
    expect(existsSync(path.join(workspace.dir, "README.md"))).toBe(true);
  });

  it("starts a new branch from the base and sets the commit identity", async () => {
    const { seed, workspace } = setup();
    const head = await workspace.prepare("claude/7-x", "main");
    expect(head).toBe(git(seed, "rev-parse", "HEAD"));
    expect(git(workspace.dir, "branch", "--show-current")).toBe("claude/7-x");
    expect(git(workspace.dir, "config", "user.name")).toBe("Bot");
    expect(git(workspace.dir, "config", "user.email")).toBe("bot@example.com");
  });

  it("pushes the issue's branches and continues from them on the next run", async () => {
    const { remote, workspace } = setup();
    await workspace.prepare("claude/7-x", "main");
    commitFile(workspace.dir, "a.txt", "a\n");
    expect(await workspace.commitsAhead("claude/7-x", "main")).toBe(1);

    const pushed = await workspace.push(7, ["claude/7-x"]);
    expect(pushed.get("claude/7-x")).toBe(git(remote, "rev-parse", "claude/7-x"));

    // A later run (e.g. fixing CI) picks up where the branch is on the remote.
    await workspace.prepare("claude/7-x", "main");
    expect(readFileSync(path.join(workspace.dir, "a.txt"), "utf8")).toBe("a\n");
  });

  it("discards leftovers from a previous run but keeps ignored files", async () => {
    const { workspace } = setup();
    await workspace.prepare("claude/7-x", "main");
    writeFileSync(path.join(workspace.dir, ".gitignore"), "cache/\n");
    commitFile(workspace.dir, ".gitignore", "cache/\n");
    await workspace.push(7, ["claude/7-x"]);

    execFileSync("mkdir", ["-p", path.join(workspace.dir, "cache")]);
    writeFileSync(path.join(workspace.dir, "cache", "keep"), "1");
    writeFileSync(path.join(workspace.dir, "stray.txt"), "junk");
    writeFileSync(path.join(workspace.dir, "README.md"), "modified\n");
    expect(await workspace.isClean()).toBe(false);

    await workspace.prepare("claude/7-x", "main");
    expect(await workspace.isClean()).toBe(true);
    expect(existsSync(path.join(workspace.dir, "stray.txt"))).toBe(false);
    expect(readFileSync(path.join(workspace.dir, "README.md"), "utf8")).toBe("hello\n");
    expect(existsSync(path.join(workspace.dir, "cache", "keep"))).toBe(true);
  });

  it("force-pushes a rebased branch but never clobbers someone else's push", async () => {
    const { root, remote, workspace } = setup();
    await workspace.prepare("claude/7-x", "main");
    commitFile(workspace.dir, "a.txt", "a\n");
    await workspace.push(7, ["claude/7-x"]);

    // Rewritten history (as after a rebase) is pushed with a lease.
    git(workspace.dir, "commit", "--quiet", "--amend", "-m", "reworded");
    await expect(workspace.push(7, ["claude/7-x"])).resolves.toBeDefined();

    // Someone else pushes to the branch after our last fetch: the lease fails.
    const other = path.join(root, "other");
    git(root, "clone", "--quiet", "--branch", "claude/7-x", remote, other);
    commitFile(other, "b.txt", "b\n");
    git(other, "push", "--quiet", "origin", "claude/7-x");
    git(workspace.dir, "commit", "--quiet", "--amend", "-m", "again");
    await expect(workspace.push(7, ["claude/7-x"])).rejects.toThrow(GitError);
  });

  it("refuses to push branches that don't belong to the issue", async () => {
    const { workspace } = setup();
    await workspace.prepare("claude/7-x", "main");
    await expect(workspace.push(7, ["claude/7-x", "main", "claude/8-y"])).rejects.toThrow(
      "refusing to push branches not owned by #7: main, claude/8-y",
    );
  });

  it("keeps the token out of the repository config", async () => {
    const { workspace } = setup();
    await workspace.prepare("claude/7-x", "main");
    commitFile(workspace.dir, "a.txt", "a\n");
    await workspace.push(7, ["claude/7-x"]);
    const config = readFileSync(path.join(workspace.dir, ".git", "config"), "utf8");
    expect(config).not.toContain(TOKEN);
    expect(config).not.toContain("extraHeader");
  });

  it("reports git failures without leaking the token", async () => {
    const { workspace } = setup();
    await workspace.ensureClone();
    const error = await workspace.prepare("claude/7-x", "no-such-base").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitError);
    expect((error as Error).message).toMatch(/^git checkout failed: /);
    expect((error as Error).message).not.toContain(TOKEN);
  });
});

describe("authEnv", () => {
  it("scopes the header to the Gitea URL and disables credential helpers", () => {
    expect(authEnv("https://gitea.example.com/", "t")).toEqual({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "http.https://gitea.example.com/.extraHeader",
      GIT_CONFIG_VALUE_0: "Authorization: token t",
      GIT_CONFIG_KEY_1: "credential.helper",
      GIT_CONFIG_VALUE_1: "",
    });
  });
});
