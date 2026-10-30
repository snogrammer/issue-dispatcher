import { PRIORITIES, priorityLabel, questionLabel, stateFromLabels } from "../conventions.js";
import type { Issue } from "../gitea/types.js";

/**
 * Which assigned issue a free repo picks up next: `priority:high` first, then
 * unlabeled, then `priority:low`; oldest first within each. Issues already
 * carrying a state label (held elsewhere or mid-conflict) and question issues
 * meant for a human are never candidates. Blocking dependencies are checked
 * by the engine, which needs the API for that.
 */
export function orderCandidates(issues: Issue[], prefix: string): Issue[] {
  return rank(
    issues.filter((issue) => issue.pull_request === null),
    prefix,
  );
}

/**
 * Pull requests assigned to the bot, in pickup order. Same rules as issues,
 * and PRs already in a work item's stack (`taken`) are left to that item.
 */
export function orderPullCandidates(
  pulls: Issue[],
  prefix: string,
  taken: ReadonlySet<number> = new Set(),
): Issue[] {
  return rank(
    pulls.filter((issue) => issue.pull_request !== null && !taken.has(issue.number)),
    prefix,
  );
}

function rank(issues: Issue[], prefix: string): Issue[] {
  return issues
    .filter((issue) => {
      const names = issue.labels.map((label) => label.name);
      return stateFromLabels(prefix, names) === undefined && !names.includes(questionLabel(prefix));
    })
    .sort(
      (a, b) =>
        priorityRank(a) - priorityRank(b) ||
        a.created_at.localeCompare(b.created_at) ||
        a.number - b.number,
    );
}

export function priorityRank(issue: Issue): number {
  const names = new Set(issue.labels.map((label) => label.name));
  if (names.has(priorityLabel(PRIORITIES[0]))) return 0;
  if (names.has(priorityLabel(PRIORITIES[1]))) return 2;
  return 1;
}
