/**
 * Naming conventions shared between the dispatcher and Gitea: which labels
 * mark an issue's state and how work branches are named. Gitea is the source
 * of truth, so these names are how state survives a lost database.
 */

/** States of an issue the bot is actively holding a repo slot for. */
export const ACTIVE_STATES = ["working", "in-review", "blocked"] as const;
export type ActiveState = (typeof ACTIVE_STATES)[number];

/** When an issue carries several state labels, the most cautious one wins. */
const STATE_PRECEDENCE: readonly ActiveState[] = ["blocked", "in-review", "working"];

export function stateLabel(prefix: string, state: ActiveState): string {
  return `${prefix}:${state}`;
}

export function stateLabels(prefix: string): string[] {
  return ACTIVE_STATES.map((state) => stateLabel(prefix, state));
}

export function stateFromLabels(
  prefix: string,
  labelNames: Iterable<string>,
): ActiveState | undefined {
  const names = new Set(labelNames);
  return STATE_PRECEDENCE.find((state) => names.has(stateLabel(prefix, state)));
}

/** Follow-up issues the dispatcher files for the human reviewer. */
export function questionLabel(prefix: string): string {
  return `${prefix}:question`;
}

/**
 * Routing and priority labels are unprefixed so they read naturally on an
 * issue (`model:opus`, `effort:high`, `priority:high`).
 */
export function modelLabel(model: string): string {
  return `model:${model}`;
}

export function effortLabel(effort: string): string {
  return `effort:${effort}`;
}

/** Issues without a priority label sit between these two. */
export const PRIORITIES = ["high", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export function priorityLabel(priority: Priority): string {
  return `priority:${priority}`;
}

/** `claude/42-fix-login-redirect`: issue number first so it can be parsed back. */
export function branchName(prefix: string, issue: number, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return slug === "" ? `${prefix}/${String(issue)}` : `${prefix}/${String(issue)}-${slug}`;
}

export function issueFromBranch(prefix: string, branch: string): number | undefined {
  if (!branch.startsWith(`${prefix}/`)) return undefined;
  const match = /^(\d+)(?:-|$)/.exec(branch.slice(prefix.length + 1));
  return match?.[1] === undefined ? undefined : Number(match[1]);
}
