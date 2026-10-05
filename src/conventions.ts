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
