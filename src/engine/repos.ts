import type { Config } from "../config/schema.js";
import { parseRepo, type GiteaClient } from "../gitea/client.js";
import type { MergeStyle, RepoRef, Repository } from "../gitea/types.js";

/**
 * The concrete repos to watch: every repo listed in REPOS plus every repo in
 * the ORGS, minus archived and empty ones (nothing to work on) and ones with
 * issues turned off (nothing to be assigned).
 */

export interface WatchedRepo {
  ref: RepoRef;
  fullName: string;
  defaultBranch: string;
  /** From MERGE_STYLE, else the repo's own default, else "merge". */
  mergeStyle: MergeStyle;
}

export interface SkippedRepo {
  name: string;
  reason: string;
  /** Set when the repo itself was readable (archived or empty), not for lookup errors. */
  ref?: RepoRef;
}

export interface ResolvedRepos {
  repos: WatchedRepo[];
  skipped: SkippedRepo[];
}

export type RepoClient = Pick<GiteaClient, "getRepo" | "listOrgRepos" | "listUserRepos">;

export async function resolveRepos(
  config: Pick<Config, "repos" | "orgs" | "mergeStyle">,
  client: RepoClient,
): Promise<ResolvedRepos> {
  const found = new Map<string, Repository>();
  const skipped: ResolvedRepos["skipped"] = [];

  for (const name of config.repos) {
    if (name.endsWith("/*")) {
      const owner = name.slice(0, -2);
      try {
        for (const repo of await listOwnerRepos(owner, client)) found.set(repo.full_name, repo);
      } catch (error) {
        skipped.push({ name, reason: error instanceof Error ? error.message : String(error) });
      }
      continue;
    }
    try {
      const repo = await client.getRepo(parseRepo(name));
      found.set(repo.full_name, repo);
    } catch (error) {
      skipped.push({ name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const org of config.orgs) {
    try {
      for (const repo of await client.listOrgRepos(org)) found.set(repo.full_name, repo);
    } catch (error) {
      skipped.push({
        name: `${org}/*`,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const repos: WatchedRepo[] = [];
  for (const repo of found.values()) {
    const ref = { owner: repo.owner.login, name: repo.name };
    if (repo.archived) skipped.push({ name: repo.full_name, reason: "archived", ref });
    else if (repo.empty) skipped.push({ name: repo.full_name, reason: "empty", ref });
    else if (repo.has_issues === false) {
      skipped.push({ name: repo.full_name, reason: "issues disabled", ref });
    } else {
      repos.push({
        ref,
        fullName: repo.full_name,
        defaultBranch: repo.default_branch,
        mergeStyle: config.mergeStyle ?? mergeStyleOf(repo),
      });
    }
  }
  repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return { repos, skipped };
}

/** An owner is an org or a plain user; Gitea has a separate endpoint for each. */
async function listOwnerRepos(owner: string, client: RepoClient): Promise<Repository[]> {
  try {
    return await client.listOrgRepos(owner);
  } catch {
    return client.listUserRepos(owner);
  }
}

const MERGE_STYLES: readonly MergeStyle[] = [
  "merge",
  "rebase",
  "rebase-merge",
  "squash",
  "fast-forward-only",
];

function mergeStyleOf(repo: Repository): MergeStyle {
  return MERGE_STYLES.find((style) => style === repo.default_merge_style) ?? "merge";
}
