import { apiPath as p, GiteaHttp, type HttpOptions } from "./http.js";
import type {
  CombinedStatus,
  Comment,
  Issue,
  IssueState,
  Label,
  MergeStyle,
  PullRequest,
  PullReview,
  RepoRef,
  Repository,
  ReviewComment,
  RunStatus,
  User,
  WorkflowJob,
  WorkflowRun,
} from "./types.js";

/**
 * Typed methods for the Gitea endpoints the dispatcher uses. Each method is a
 * thin mapping onto one REST call; policy (what to do with the result) lives in
 * the engine, not here.
 */

export function parseRepo(fullName: string): RepoRef {
  const [owner, name, ...rest] = fullName.split("/");
  if (owner === undefined || name === undefined || owner === "" || name === "" || rest.length) {
    throw new Error(`expected owner/repo, got "${fullName}"`);
  }
  return { owner, name };
}

export interface ListIssuesFilter {
  state?: IssueState | "all";
  /** Label names; matches issues having any of them. */
  labels?: string[];
  /** Only issues assigned to this username. */
  assignee?: string;
}

export interface CreateIssueInput {
  title: string;
  body?: string;
  assignees?: string[];
  labelIds?: number[];
}

export interface EditIssueInput {
  title?: string;
  body?: string;
  state?: IssueState;
  assignees?: string[];
}

export interface CreateLabelInput {
  name: string;
  /** Hex color with or without the leading #. */
  color: string;
  description?: string;
  /** Exclusive labels sharing a scope (`scope/name`) replace each other. */
  exclusive?: boolean;
}

export interface CreatePullInput {
  head: string;
  base: string;
  title: string;
  body?: string;
  labelIds?: number[];
  assignees?: string[];
}

export interface EditPullInput {
  title?: string;
  body?: string;
  base?: string;
  state?: IssueState;
}

export interface MergePullInput {
  style: MergeStyle;
  /** Refuse to merge if the head moved since this SHA was checked. */
  headCommitId?: string;
  deleteBranch?: boolean;
  title?: string;
  message?: string;
}

export interface ListRunsFilter {
  status?: RunStatus;
  headSha?: string;
  branch?: string;
  event?: string;
}

export class GiteaClient {
  private readonly http: GiteaHttp;

  constructor(options: HttpOptions | GiteaHttp) {
    this.http = options instanceof GiteaHttp ? options : new GiteaHttp(options);
  }

  // --- Users and repositories ---------------------------------------------

  getCurrentUser(): Promise<User> {
    return this.http.request("GET", "/user");
  }

  getRepo({ owner, name }: RepoRef): Promise<Repository> {
    return this.http.request("GET", p`/repos/${owner}/${name}`);
  }

  listOrgRepos(org: string): Promise<Repository[]> {
    return this.http.paginate(p`/orgs/${org}/repos`);
  }

  // --- Issues ---------------------------------------------------------------

  listIssues({ owner, name }: RepoRef, filter: ListIssuesFilter = {}): Promise<Issue[]> {
    return this.http.paginate(p`/repos/${owner}/${name}/issues`, {
      type: "issues",
      state: filter.state ?? "open",
      labels: filter.labels?.join(","),
      // Despite the name, Gitea's `assigned_by` filters by assignee.
      assigned_by: filter.assignee,
    });
  }

  getIssue({ owner, name }: RepoRef, index: number): Promise<Issue> {
    return this.http.request("GET", p`/repos/${owner}/${name}/issues/${index}`);
  }

  createIssue({ owner, name }: RepoRef, input: CreateIssueInput): Promise<Issue> {
    return this.http.request("POST", p`/repos/${owner}/${name}/issues`, {
      body: {
        title: input.title,
        body: input.body,
        assignees: input.assignees,
        labels: input.labelIds,
      },
    });
  }

  editIssue({ owner, name }: RepoRef, index: number, input: EditIssueInput): Promise<Issue> {
    return this.http.request("PATCH", p`/repos/${owner}/${name}/issues/${index}`, { body: input });
  }

  closeIssue(repo: RepoRef, index: number): Promise<Issue> {
    return this.editIssue(repo, index, { state: "closed" });
  }

  listComments({ owner, name }: RepoRef, index: number, since?: string): Promise<Comment[]> {
    // Not paginated by Gitea; `since` (RFC 3339) narrows to new comments.
    return this.http.request("GET", p`/repos/${owner}/${name}/issues/${index}/comments`, {
      query: { since },
    });
  }

  createComment({ owner, name }: RepoRef, index: number, body: string): Promise<Comment> {
    return this.http.request("POST", p`/repos/${owner}/${name}/issues/${index}/comments`, {
      body: { body },
    });
  }

  /** Record that `index` is blocked by `blocker` (Gitea issue dependency). */
  async addDependency(
    { owner, name }: RepoRef,
    index: number,
    blocker: { repo: RepoRef; index: number },
  ): Promise<void> {
    await this.http.request("POST", p`/repos/${owner}/${name}/issues/${index}/dependencies`, {
      body: { owner: blocker.repo.owner, repo: blocker.repo.name, index: blocker.index },
    });
  }

  /** Undo addDependency: `index` is no longer blocked by `blocker`. */
  async removeDependency(
    { owner, name }: RepoRef,
    index: number,
    blocker: { repo: RepoRef; index: number },
  ): Promise<void> {
    await this.http.request("DELETE", p`/repos/${owner}/${name}/issues/${index}/dependencies`, {
      body: { owner: blocker.repo.owner, repo: blocker.repo.name, index: blocker.index },
    });
  }

  /** Issues that block `index`. */
  listDependencies({ owner, name }: RepoRef, index: number): Promise<Issue[]> {
    return this.http.paginate(p`/repos/${owner}/${name}/issues/${index}/dependencies`);
  }

  // --- Labels ---------------------------------------------------------------

  listLabels({ owner, name }: RepoRef): Promise<Label[]> {
    return this.http.paginate(p`/repos/${owner}/${name}/labels`);
  }

  createLabel({ owner, name }: RepoRef, input: CreateLabelInput): Promise<Label> {
    return this.http.request("POST", p`/repos/${owner}/${name}/labels`, {
      body: {
        name: input.name,
        color: input.color.startsWith("#") ? input.color : `#${input.color}`,
        description: input.description ?? "",
        exclusive: input.exclusive ?? false,
      },
    });
  }

  /** Add labels by name or ID; returns the issue's full label set afterwards. */
  addLabels(
    { owner, name }: RepoRef,
    index: number,
    labels: (string | number)[],
  ): Promise<Label[]> {
    return this.http.request("POST", p`/repos/${owner}/${name}/issues/${index}/labels`, {
      body: { labels },
    });
  }

  async removeLabel({ owner, name }: RepoRef, index: number, labelId: number): Promise<void> {
    await this.http.request("DELETE", p`/repos/${owner}/${name}/issues/${index}/labels/${labelId}`);
  }

  // --- Pull requests --------------------------------------------------------

  listPulls(
    { owner, name }: RepoRef,
    filter: { state?: IssueState | "all"; baseBranch?: string } = {},
  ): Promise<PullRequest[]> {
    return this.http.paginate(p`/repos/${owner}/${name}/pulls`, {
      state: filter.state ?? "open",
      base_branch: filter.baseBranch,
    });
  }

  getPull({ owner, name }: RepoRef, index: number): Promise<PullRequest> {
    return this.http.request("GET", p`/repos/${owner}/${name}/pulls/${index}`);
  }

  createPull({ owner, name }: RepoRef, input: CreatePullInput): Promise<PullRequest> {
    return this.http.request("POST", p`/repos/${owner}/${name}/pulls`, {
      body: {
        head: input.head,
        base: input.base,
        title: input.title,
        body: input.body,
        labels: input.labelIds,
        assignees: input.assignees,
      },
    });
  }

  editPull({ owner, name }: RepoRef, index: number, input: EditPullInput): Promise<PullRequest> {
    return this.http.request("PATCH", p`/repos/${owner}/${name}/pulls/${index}`, { body: input });
  }

  /** Point a PR at a new base branch, e.g. after the PR below it in a stack merged. */
  retargetPull(repo: RepoRef, index: number, base: string): Promise<PullRequest> {
    return this.editPull(repo, index, { base });
  }

  async mergePull({ owner, name }: RepoRef, index: number, input: MergePullInput): Promise<void> {
    await this.http.request("POST", p`/repos/${owner}/${name}/pulls/${index}/merge`, {
      body: {
        do: input.style,
        head_commit_id: input.headCommitId,
        delete_branch_after_merge: input.deleteBranch ?? false,
        merge_title_field: input.title,
        merge_message_field: input.message,
      },
    });
  }

  async deleteBranch({ owner, name }: RepoRef, branch: string): Promise<void> {
    await this.http.request("DELETE", p`/repos/${owner}/${name}/branches/${branch}`);
  }

  listPullReviews({ owner, name }: RepoRef, index: number): Promise<PullReview[]> {
    return this.http.paginate(p`/repos/${owner}/${name}/pulls/${index}/reviews`);
  }

  listReviewComments(
    { owner, name }: RepoRef,
    index: number,
    reviewId: number,
  ): Promise<ReviewComment[]> {
    return this.http.request(
      "GET",
      p`/repos/${owner}/${name}/pulls/${index}/reviews/${reviewId}/comments`,
    );
  }

  // --- CI -------------------------------------------------------------------

  /** Aggregate commit status for a SHA or branch. */
  getCombinedStatus({ owner, name }: RepoRef, ref: string): Promise<CombinedStatus> {
    return this.http.request("GET", p`/repos/${owner}/${name}/commits/${ref}/status`, {
      query: { limit: 50 },
    });
  }

  async listWorkflowRuns(
    { owner, name }: RepoRef,
    filter: ListRunsFilter = {},
    limit = 20,
  ): Promise<WorkflowRun[]> {
    const response = await this.http.request<{ workflow_runs: WorkflowRun[] | null }>(
      "GET",
      p`/repos/${owner}/${name}/actions/runs`,
      { query: { ...runQuery(filter), limit } },
    );
    return response.workflow_runs ?? [];
  }

  /** Count runs in a status without fetching them (used for CI backpressure). */
  async countWorkflowRuns({ owner, name }: RepoRef, status: RunStatus): Promise<number> {
    const response = await this.http.request<{ total_count: number }>(
      "GET",
      p`/repos/${owner}/${name}/actions/runs`,
      { query: { status, limit: 1 } },
    );
    return response.total_count;
  }

  async listRunJobs({ owner, name }: RepoRef, runId: number): Promise<WorkflowJob[]> {
    const response = await this.http.request<{ jobs: WorkflowJob[] | null }>(
      "GET",
      p`/repos/${owner}/${name}/actions/runs/${runId}/jobs`,
    );
    return response.jobs ?? [];
  }

  getJobLogs({ owner, name }: RepoRef, jobId: number): Promise<string> {
    return this.http.request("GET", p`/repos/${owner}/${name}/actions/jobs/${jobId}/logs`, {
      text: true,
    });
  }
}

function runQuery(filter: ListRunsFilter) {
  return {
    status: filter.status,
    head_sha: filter.headSha,
    branch: filter.branch,
    event: filter.event,
  };
}
