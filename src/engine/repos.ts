import type { Config } from "../config/schema.js";
import { parseRepo, type GiteaClient } from "../gitea/client.js";
import type { RepoRef, Repository } from "../gitea/types.js";

/**
 * The concrete repos to watch: every repo listed in REPOS plus every repo in
 * the ORGS, minus archived and empty ones (nothing to work on).
 */

export interface WatchedRepo {
  ref: RepoRef;
  fullName: string;
  defaultBranch: string;
}

export interface ResolvedRepos {
  repos: WatchedRepo[];
  skipped: { name: string; reason: string }[];
}

export type RepoClient = Pick<GiteaClient, "getRepo" | "listOrgRepos">;

export async function resolveRepos(
  config: Pick<Config, "repos" | "orgs">,
  client: RepoClient,
): Promise<ResolvedRepos> {
  const found = new Map<string, Repository>();
  const skipped: ResolvedRepos["skipped"] = [];

  for (const name of config.repos) {
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
    if (repo.archived) skipped.push({ name: repo.full_name, reason: "archived" });
    else if (repo.empty) skipped.push({ name: repo.full_name, reason: "empty" });
    else {
      repos.push({
        ref: { owner: repo.owner.login, name: repo.name },
        fullName: repo.full_name,
        defaultBranch: repo.default_branch,
      });
    }
  }
  repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return { repos, skipped };
}
