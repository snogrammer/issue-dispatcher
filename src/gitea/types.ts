/**
 * The subset of Gitea API response fields the dispatcher reads. These are
 * deliberately partial: Gitea returns much more, and declaring only what we use
 * keeps the dependency surface visible.
 */

export interface RepoRef {
  owner: string;
  name: string;
}

export interface User {
  id: number;
  login: string;
}

export interface Repository {
  id: number;
  name: string;
  full_name: string;
  owner: User;
  default_branch: string;
  /** The repo's configured default for the merge button. */
  default_merge_style?: string;
  archived: boolean;
  empty: boolean;
  permissions?: { admin: boolean; push: boolean; pull: boolean };
}

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
  exclusive: boolean;
}

export type IssueState = "open" | "closed";

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  user: User;
  labels: Label[];
  assignees: User[] | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  pull_request: { merged: boolean } | null;
}

export interface Comment {
  id: number;
  body: string;
  user: User;
  html_url: string;
  created_at: string;
  updated_at: string;
}

export interface Branch {
  label: string;
  ref: string;
  sha: string;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  draft: boolean;
  merged: boolean;
  mergeable: boolean;
  merge_commit_sha: string | null;
  html_url: string;
  user: User;
  labels: Label[];
  head: Branch;
  base: Branch;
  updated_at: string;
}

export type ReviewState = "APPROVED" | "PENDING" | "COMMENT" | "REQUEST_CHANGES" | "REQUEST_REVIEW";

export interface PullReview {
  id: number;
  state: ReviewState;
  body: string;
  user: User | null;
  commit_id: string;
  stale: boolean;
  dismissed: boolean;
  submitted_at: string;
}

export interface ReviewComment {
  id: number;
  body: string;
  path: string;
  user: User;
  diff_hunk: string;
  created_at: string;
}

export type StatusState = "pending" | "success" | "error" | "failure" | "warning" | "skipped";

export interface CommitStatus {
  id: number;
  context: string;
  status: StatusState;
  description: string;
  target_url: string;
  created_at: string;
  updated_at: string;
}

export interface CombinedStatus {
  sha: string;
  /** Aggregate of `statuses`; Gitea reports "pending" when there are none. */
  state: StatusState;
  total_count: number;
  statuses: CommitStatus[] | null;
}

/** Gitea Actions run statuses as reported by the runs API. */
export type RunStatus =
  | "pending"
  | "queued"
  | "waiting"
  | "in_progress"
  | "completed"
  | "failure"
  | "success"
  | "skipped";

export interface WorkflowRun {
  id: number;
  status: RunStatus;
  conclusion: string | null;
  event: string;
  head_branch: string | null;
  head_sha: string;
  html_url: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface WorkflowJob {
  id: number;
  run_id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
}

export type MergeStyle = "merge" | "rebase" | "rebase-merge" | "squash" | "fast-forward-only";
