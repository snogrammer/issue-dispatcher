import { describe, expect, it } from "vitest";

import { FakeGitea } from "../../test/helpers/fake-gitea.js";
import { resolveRepos } from "./repos.js";

describe("resolveRepos", () => {
  it("combines explicit repos and org repos, deduplicated and sorted", async () => {
    const gitea = new FakeGitea("bot");
    gitea.addRepo("team/b", { defaultBranch: "develop", mergeStyle: "squash" });
    gitea.addRepo("team/a");
    gitea.addRepo("other/x");

    const { repos, skipped } = await resolveRepos(
      { repos: ["team/b", "other/x"], orgs: ["team"] },
      gitea,
    );

    expect(repos).toEqual([
      {
        ref: { owner: "other", name: "x" },
        fullName: "other/x",
        defaultBranch: "main",
        mergeStyle: "merge",
      },
      {
        ref: { owner: "team", name: "a" },
        fullName: "team/a",
        defaultBranch: "main",
        mergeStyle: "merge",
      },
      {
        ref: { owner: "team", name: "b" },
        fullName: "team/b",
        defaultBranch: "develop",
        mergeStyle: "squash",
      },
    ]);
    expect(skipped).toEqual([]);
  });

  it("lets MERGE_STYLE override each repo's default", async () => {
    const gitea = new FakeGitea("bot");
    gitea.addRepo("team/b", { mergeStyle: "squash" });
    const { repos } = await resolveRepos(
      { repos: ["team/b"], orgs: [], mergeStyle: "rebase" },
      gitea,
    );
    expect(repos[0]?.mergeStyle).toBe("rebase");
  });

  it("reports missing, archived and empty repos instead of failing", async () => {
    const gitea = new FakeGitea("bot");
    gitea.addRepo("team/old", { archived: true });
    gitea.addRepo("team/new", { empty: true });

    const { repos, skipped } = await resolveRepos(
      { repos: ["team/gone", "team/old"], orgs: ["team"] },
      gitea,
    );

    expect(repos).toEqual([]);
    expect(skipped).toEqual([
      { name: "team/gone", reason: "GET /repos/team/gone failed (404): not found" },
      { name: "team/old", reason: "archived", ref: { owner: "team", name: "old" } },
      { name: "team/new", reason: "empty", ref: { owner: "team", name: "new" } },
    ]);
  });

  it("skips repos with issues turned off, since nothing can be assigned there", async () => {
    const gitea = new FakeGitea("bot");
    gitea.addRepo("team/code-only", { hasIssues: false });
    gitea.addRepo("team/live");

    const { repos, skipped } = await resolveRepos({ repos: [], orgs: ["team"] }, gitea);

    expect(repos.map((repo) => repo.fullName)).toEqual(["team/live"]);
    expect(skipped).toEqual([
      {
        name: "team/code-only",
        reason: "issues disabled",
        ref: { owner: "team", name: "code-only" },
      },
    ]);
  });
});
