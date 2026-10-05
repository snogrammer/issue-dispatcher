import { issueFromBranch, stateFromLabels, stateLabels, type ActiveState } from "../conventions.js";
import type { GiteaClient } from "../gitea/client.js";
import type { PullRequest, RepoRef } from "../gitea/types.js";
import type { StateStore } from "./store.js";

/**
 * Reconcile the local store with Gitea, which is the source of truth for
 * which issue each repo is working on. Run at startup (so a lost or stale
 * database heals itself) and on each reconcile pass.
 *
 * From Gitea: the active issue (open, assigned to the bot, carrying a state
 * label), its state, and its open PR stack. From the store, kept when the same
 * issue is still active: the Claude session ID and fix-attempt count, which
 * Gitea has no record of. If the database was lost those reset, and the next
 * run starts a fresh Claude session.
 *
 * Ordering rule for the engine: add the state label in Gitea *before* claiming
 * the slot locally, and release locally *before* removing the label, so a
 * rebuild running in between never drops live work.
 */

export type RebuildClient = Pick<GiteaClient, "listIssues" | "listPulls">;

export interface RebuildOptions {
  repos: RepoRef[];
  botUsername: string;
  labelPrefix: string;
}

export interface RebuildReport {
  restored: { repo: string; issue: number; state: ActiveState; prStack: number[] }[];
  /** Slots freed because Gitea no longer shows the issue as active. */
  released: { repo: string; issue: number }[];
  /** Repos where several issues carry state labels; only `kept` holds the slot. */
  conflicts: { repo: string; issues: number[]; kept: number }[];
}

export async function rebuildFromGitea(
  store: StateStore,
  client: RebuildClient,
  options: RebuildOptions,
): Promise<RebuildReport> {
  const report: RebuildReport = { restored: [], released: [], conflicts: [] };
  const labels = stateLabels(options.labelPrefix);

  for (const repoRef of options.repos) {
    const repo = `${repoRef.owner}/${repoRef.name}`;
    const issues = await client.listIssues(repoRef, {
      assignee: options.botUsername,
      labels,
    });
    // Re-check labels locally: Gitea drops label names that don't exist from the
    // filter, and with none left it returns every assigned issue (seen on 1.27).
    const active = issues
      .map((issue) => ({
        issue,
        state: stateFromLabels(
          options.labelPrefix,
          issue.labels.map((label) => label.name),
        ),
      }))
      .filter((entry): entry is typeof entry & { state: ActiveState } => entry.state !== undefined)
      .sort((a, b) => a.issue.created_at.localeCompare(b.issue.created_at));

    const kept = active[0];
    const held = store.activeIssue(repo);

    if (held !== null && held !== kept?.issue.number) {
      store.release(repo, "abandoned");
      report.released.push({ repo, issue: held });
    }
    if (kept === undefined) continue;

    if (active.length > 1) {
      report.conflicts.push({
        repo,
        issues: active.map((entry) => entry.issue.number),
        kept: kept.issue.number,
      });
    }

    const pulls = await client.listPulls(repoRef, { state: "open" });
    const stack = orderStack(
      pulls.filter(
        (pull) => issueFromBranch(options.labelPrefix, pull.head.ref) === kept.issue.number,
      ),
    );

    const work = store.claim(repo, kept.issue.number);
    const bottom = stack[0];
    store.updateWork(repo, kept.issue.number, {
      state: kept.state,
      prStack: stack.map((pull) => pull.number),
      ...(work.branch === null && bottom !== undefined ? { branch: bottom.head.ref } : {}),
    });
    report.restored.push({
      repo,
      issue: kept.issue.number,
      state: kept.state,
      prStack: stack.map((pull) => pull.number),
    });
  }

  return report;
}

/**
 * Order an issue's PRs bottom-up: the bottom PR targets a branch outside the
 * stack (normally the default branch), and each next PR targets the head of
 * the one below it. PRs that don't chain are appended oldest first.
 */
export function orderStack(pulls: PullRequest[]): PullRequest[] {
  const byNumber = [...pulls].sort((a, b) => a.number - b.number);
  const heads = new Set(byNumber.map((pull) => pull.head.ref));
  const ordered: PullRequest[] = [];
  let next = byNumber.find((pull) => !heads.has(pull.base.ref));
  while (next !== undefined && !ordered.includes(next)) {
    ordered.push(next);
    const below: PullRequest = next;
    next = byNumber.find((pull) => pull.base.ref === below.head.ref);
  }
  return [...ordered, ...byNumber.filter((pull) => !ordered.includes(pull))];
}
