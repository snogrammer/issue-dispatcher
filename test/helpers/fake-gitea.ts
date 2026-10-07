/**
 * In-memory Gitea covering the endpoints the engine uses. Issues, labels,
 * comments and dependencies behave like the real API closely enough for
 * state-machine tests; every mutating call is also appended to `calls` so
 * tests can assert ordering (e.g. label added before the slot is claimed).
 */
import type { EngineGitea } from "../../src/engine/engine.js";
import { GiteaError } from "../../src/gitea/http.js";
import type { MergePullInput } from "../../src/gitea/client.js";
import type {
  CombinedStatus,
  Comment,
  CommitStatus,
  Issue,
  Label,
  PullRequest,
  PullReview,
  RepoRef,
  Repository,
  ReviewComment,
  RunStatus,
  StatusState,
  User,
  WorkflowJob,
  WorkflowRun,
} from "../../src/gitea/types.js";

export interface IssueSeed {
  number: number;
  title?: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
  createdAt?: string;
  state?: "open" | "closed";
  blockedBy?: number[];
}

const user = (login: string): User => ({ id: login.length, login });

export class FakeGitea implements EngineGitea {
  readonly repos = new Map<string, Repository>();
  readonly issues = new Map<string, Map<number, Issue>>();
  readonly labels = new Map<string, Label[]>();
  readonly comments: { repo: string; issue: number; author: string; body: string }[] = [];
  readonly dependencies = new Map<string, number[]>();
  readonly calls: string[] = [];
  readonly pulls = new Map<string, PullRequest[]>();
  /** Commit statuses by SHA. */
  readonly statuses = new Map<string, CommitStatus[]>();
  readonly reviews = new Map<string, (PullReview & { comments: ReviewComment[] })[]>();
  readonly runs: (WorkflowRun & { repo: string; jobs: (WorkflowJob & { log: string })[] })[] = [];
  readonly deletedBranches: string[] = [];
  readonly merges: { repo: string; pull: number; input: MergePullInput }[] = [];
  /** Make the next merge fail with this HTTP status and message. */
  mergeFailure: { status: number; message: string } | undefined;
  /** Make countWorkflowRuns fail. */
  countFailure = false;
  /** Repos whose label calls fail (e.g. a token without push access). */
  readonly labelFailures = new Set<string>();
  private nextId = 1;

  constructor(private readonly botLogin: string) {}

  addRepo(
    fullName: string,
    options: {
      archived?: boolean;
      empty?: boolean;
      hasIssues?: boolean;
      defaultBranch?: string;
      mergeStyle?: string;
    } = {},
  ): void {
    const [owner = "", name = ""] = fullName.split("/");
    this.repos.set(fullName, {
      id: this.nextId++,
      name,
      full_name: fullName,
      owner: user(owner),
      default_branch: options.defaultBranch ?? "main",
      default_merge_style: options.mergeStyle ?? "merge",
      archived: options.archived ?? false,
      empty: options.empty ?? false,
      has_issues: options.hasIssues ?? true,
    });
    this.issues.set(fullName, new Map());
    this.labels.set(fullName, []);
  }

  addIssue(repo: string, seed: IssueSeed): Issue {
    const issue: Issue = {
      id: this.nextId++,
      number: seed.number,
      title: seed.title ?? `Issue ${String(seed.number)}`,
      body: seed.body ?? "",
      state: seed.state ?? "open",
      user: user("human"),
      labels: [],
      assignees: (seed.assignees ?? [this.botLogin]).map(user),
      html_url: `https://gitea.example.com/${repo}/issues/${String(seed.number)}`,
      created_at: seed.createdAt ?? `2026-01-${String(seed.number).padStart(2, "0")}T00:00:00Z`,
      updated_at: "2026-01-01T00:00:00Z",
      pull_request: null,
    };
    this.repoIssues(repo).set(seed.number, issue);
    for (const name of seed.labels ?? []) issue.labels.push(this.labelByName(repo, name, true));
    if (seed.blockedBy) this.dependencies.set(`${repo}#${String(seed.number)}`, seed.blockedBy);
    return issue;
  }

  issue(repo: string, number: number): Issue {
    const issue = this.repoIssues(repo).get(number);
    if (!issue) throw new Error(`no issue ${repo}#${String(number)}`);
    return issue;
  }

  labelNames(repo: string, number: number): string[] {
    return this.issue(repo, number)
      .labels.map((label) => label.name)
      .sort();
  }

  commentsOn(repo: string, number: number): string[] {
    return this.comments.filter((c) => c.repo === repo && c.issue === number).map((c) => c.body);
  }

  /** A push moved `branch`; open PRs from it now have that head. */
  setBranchHead(repo: string, branch: string, sha: string): void {
    this.branchHeads.set(`${repo}:${branch}`, sha);
    for (const pull of this.pulls.get(repo) ?? []) {
      if (pull.head.ref === branch && pull.state === "open") pull.head.sha = sha;
    }
  }

  pull(repo: string, number: number): PullRequest {
    const pull = (this.pulls.get(repo) ?? []).find((p) => p.number === number);
    if (!pull) throw new Error(`no PR ${repo}#${String(number)}`);
    return pull;
  }

  setStatus(sha: string, ...states: StatusState[]): void {
    this.statuses.set(
      sha,
      states.map((status, i) => ({
        id: i,
        context: `CI / check ${String(i)}`,
        status,
        description: `check ${status}`,
        target_url: `https://ci.example.com/${sha}/${String(i)}`,
        created_at: "",
        updated_at: "",
      })),
    );
  }

  addReview(
    repo: string,
    pull: number,
    review: Partial<PullReview> & { comments?: ReviewComment[] },
  ): void {
    const key = `${repo}#${String(pull)}`;
    const list = this.reviews.get(key) ?? [];
    list.push({
      id: this.nextId++,
      state: "REQUEST_CHANGES",
      body: "",
      user: user(REVIEWER_DEFAULT),
      commit_id: this.pull(repo, pull).head.sha,
      stale: false,
      dismissed: false,
      submitted_at: "",
      comments: [],
      ...review,
    });
    this.reviews.set(key, list);
  }

  /** An Actions run that's queued or running (or done, with a conclusion). */
  addRun(repo: string, sha: string, status: RunStatus, conclusion: string | null = null): void {
    const id = this.nextId++;
    this.runs.push({
      repo,
      id,
      status,
      conclusion,
      event: "pull_request",
      head_branch: null,
      head_sha: sha,
      html_url: `https://gitea.example.com/${repo}/actions/runs/${String(id)}`,
      started_at: null,
      completed_at: null,
      jobs: [],
    });
  }

  countWorkflowRuns(ref: RepoRef, status: RunStatus): Promise<number> {
    if (this.countFailure)
      return Promise.reject(new GiteaError("GET", "/actions/runs", 500, "boom"));
    return Promise.resolve(
      this.runs.filter((run) => run.repo === key(ref) && run.status === status).length,
    );
  }

  addFailedRun(repo: string, sha: string, jobName: string, log: string): void {
    const id = this.nextId++;
    this.runs.push({
      repo,
      id,
      status: "completed",
      conclusion: "failure",
      event: "pull_request",
      head_branch: null,
      head_sha: sha,
      html_url: `https://gitea.example.com/${repo}/actions/runs/${String(id)}`,
      started_at: null,
      completed_at: null,
      jobs: [
        {
          id: this.nextId++,
          run_id: id,
          name: jobName,
          status: "completed",
          conclusion: "failure",
          html_url: `https://gitea.example.com/${repo}/actions/runs/${String(id)}/jobs/0`,
          log,
        },
      ],
    });
  }

  // --- EngineGitea ------------------------------------------------------------

  getCurrentUser(): Promise<User> {
    return Promise.resolve(user(this.botLogin));
  }

  getRepo(ref: RepoRef): Promise<Repository> {
    const repo = this.repos.get(key(ref));
    return repo ? Promise.resolve(repo) : Promise.reject(notFound("GET", `/repos/${key(ref)}`));
  }

  listOrgRepos(org: string): Promise<Repository[]> {
    return Promise.resolve([...this.repos.values()].filter((repo) => repo.owner.login === org));
  }

  listIssues(
    ref: RepoRef,
    filter: { state?: "open" | "closed" | "all"; labels?: string[]; assignee?: string } = {},
  ): Promise<Issue[]> {
    if (this.repos.get(key(ref))?.has_issues === false) {
      return Promise.reject(notFound("GET", `/repos/${key(ref)}/issues`));
    }
    const state = filter.state ?? "open";
    const issues = [...this.repoIssues(key(ref)).values()]
      .filter((issue) => state === "all" || issue.state === state)
      .filter(
        (issue) =>
          filter.assignee === undefined ||
          (issue.assignees ?? []).some((a) => a.login === filter.assignee),
      )
      .filter(
        (issue) =>
          filter.labels === undefined ||
          issue.labels.some((label) => filter.labels?.includes(label.name)),
      )
      // Gitea returns newest first.
      .sort((a, b) => b.number - a.number);
    return Promise.resolve(issues.map((issue) => structuredClone(issue)));
  }

  getIssue(ref: RepoRef, index: number): Promise<Issue> {
    const issue = this.repoIssues(key(ref)).get(index);
    return issue
      ? Promise.resolve(structuredClone(issue))
      : Promise.reject(notFound("GET", `/repos/${key(ref)}/issues/${String(index)}`));
  }

  listComments(ref: RepoRef, index: number): Promise<Comment[]> {
    return Promise.resolve(
      this.comments
        .filter((c) => c.repo === key(ref) && c.issue === index)
        .map((c, i) => ({
          id: i,
          body: c.body,
          user: user(c.author),
          html_url: "",
          created_at: "",
          updated_at: "",
        })),
    );
  }

  createComment(ref: RepoRef, index: number, body: string): Promise<Comment> {
    this.calls.push(`comment ${key(ref)}#${String(index)}`);
    this.comments.push({ repo: key(ref), issue: index, author: this.botLogin, body });
    return Promise.resolve({
      id: this.comments.length,
      body,
      user: user(this.botLogin),
      html_url: "",
      created_at: "",
      updated_at: "",
    });
  }

  listDependencies(ref: RepoRef, index: number): Promise<Issue[]> {
    const blockers = this.dependencies.get(`${key(ref)}#${String(index)}`) ?? [];
    return Promise.resolve(blockers.map((n) => structuredClone(this.issue(key(ref), n))));
  }

  listLabels(ref: RepoRef): Promise<Label[]> {
    if (this.labelFailures.has(key(ref))) {
      return Promise.reject(new GiteaError("GET", `/repos/${key(ref)}/labels`, 403, "forbidden"));
    }
    return Promise.resolve([...(this.labels.get(key(ref)) ?? [])]);
  }

  createLabel(
    ref: RepoRef,
    input: { name: string; color: string; description?: string },
  ): Promise<Label> {
    const label: Label = {
      id: this.nextId++,
      name: input.name,
      color: input.color.replace(/^#/, ""),
      description: input.description ?? "",
      exclusive: false,
    };
    this.labels.get(key(ref))?.push(label);
    return Promise.resolve(label);
  }

  addLabels(ref: RepoRef, index: number, labels: (string | number)[]): Promise<Label[]> {
    const issue = this.issue(key(ref), index);
    for (const wanted of labels) {
      this.calls.push(`addLabel ${key(ref)}#${String(index)} ${String(wanted)}`);
      const label =
        typeof wanted === "number"
          ? this.labels.get(key(ref))?.find((l) => l.id === wanted)
          : this.labelByName(key(ref), wanted, false);
      if (!label) throw new GiteaError("POST", "/labels", 422, `unknown label ${String(wanted)}`);
      if (!issue.labels.some((l) => l.id === label.id)) issue.labels.push(label);
    }
    return Promise.resolve([...issue.labels]);
  }

  removeLabel(ref: RepoRef, index: number, labelId: number): Promise<void> {
    const issue = this.issue(key(ref), index);
    const label = issue.labels.find((l) => l.id === labelId);
    this.calls.push(`removeLabel ${key(ref)}#${String(index)} ${label?.name ?? String(labelId)}`);
    issue.labels = issue.labels.filter((l) => l.id !== labelId);
    return Promise.resolve();
  }

  listPulls(
    ref: RepoRef,
    filter: { state?: "open" | "closed" | "all" } = {},
  ): Promise<PullRequest[]> {
    const state = filter.state ?? "open";
    return Promise.resolve(
      (this.pulls.get(key(ref)) ?? [])
        .filter((pull) => state === "all" || pull.state === state)
        .map((pull) => structuredClone(pull)),
    );
  }

  getPull(ref: RepoRef, index: number): Promise<PullRequest> {
    return Promise.resolve(structuredClone(this.pull(key(ref), index)));
  }

  createPull(
    ref: RepoRef,
    input: { head: string; base: string; title: string; body?: string },
  ): Promise<PullRequest> {
    const repo = key(ref);
    const number = this.nextNumber(repo);
    this.calls.push(`createPull ${repo} ${input.head} -> ${input.base}`);
    const pull: PullRequest = {
      id: this.nextId++,
      number,
      title: input.title,
      body: input.body ?? "",
      state: "open",
      draft: false,
      merged: false,
      mergeable: true,
      merge_commit_sha: null,
      html_url: `https://gitea.example.com/${repo}/pulls/${String(number)}`,
      user: user(this.botLogin),
      labels: [],
      head: { label: input.head, ref: input.head, sha: this.headOf(repo, input.head) },
      base: { label: input.base, ref: input.base, sha: "base-sha" },
      updated_at: "",
    };
    this.pulls.set(repo, [...(this.pulls.get(repo) ?? []), pull]);
    return Promise.resolve(structuredClone(pull));
  }

  retargetPull(ref: RepoRef, index: number, base: string): Promise<PullRequest> {
    const pull = this.pull(key(ref), index);
    this.calls.push(`retarget ${key(ref)}#${String(index)} -> ${base}`);
    pull.base = { label: base, ref: base, sha: "base-sha" };
    return Promise.resolve(structuredClone(pull));
  }

  mergePull(ref: RepoRef, index: number, input: MergePullInput): Promise<void> {
    if (this.mergeFailure) {
      const { status, message } = this.mergeFailure;
      return Promise.reject(new GiteaError("POST", "/merge", status, message));
    }
    const pull = this.pull(key(ref), index);
    this.calls.push(`merge ${key(ref)}#${String(index)}`);
    this.merges.push({ repo: key(ref), pull: index, input });
    pull.merged = true;
    pull.state = "closed";
    if (input.deleteBranch) this.deletedBranches.push(pull.head.ref);
    return Promise.resolve();
  }

  listPullReviews(ref: RepoRef, index: number): Promise<PullReview[]> {
    return Promise.resolve(
      (this.reviews.get(`${key(ref)}#${String(index)}`) ?? []).map(({ comments: _, ...r }) => r),
    );
  }

  listReviewComments(ref: RepoRef, index: number, reviewId: number): Promise<ReviewComment[]> {
    const review = (this.reviews.get(`${key(ref)}#${String(index)}`) ?? []).find(
      (r) => r.id === reviewId,
    );
    return Promise.resolve(review?.comments ?? []);
  }

  getCombinedStatus(_ref: RepoRef, sha: string): Promise<CombinedStatus> {
    const statuses = this.statuses.get(sha) ?? [];
    const states = statuses.map((s) => s.status);
    const state: StatusState = states.some((s) => s === "failure" || s === "error")
      ? "failure"
      : states.includes("pending") || states.length === 0
        ? "pending"
        : "success";
    return Promise.resolve({ sha, state, total_count: statuses.length, statuses });
  }

  listWorkflowRuns(ref: RepoRef, filter: { headSha?: string } = {}): Promise<WorkflowRun[]> {
    return Promise.resolve(
      this.runs
        .filter(
          (run) => run.repo === key(ref) && (!filter.headSha || run.head_sha === filter.headSha),
        )
        .map(({ repo: _, jobs: __, ...run }) => run),
    );
  }

  listRunJobs(_ref: RepoRef, runId: number): Promise<WorkflowJob[]> {
    const run = this.runs.find((r) => r.id === runId);
    return Promise.resolve((run?.jobs ?? []).map(({ log: _, ...job }) => job));
  }

  getJobLogs(_ref: RepoRef, jobId: number): Promise<string> {
    const job = this.runs.flatMap((r) => r.jobs).find((j) => j.id === jobId);
    return Promise.resolve(job?.log ?? "");
  }

  deleteBranch(ref: RepoRef, branch: string): Promise<void> {
    this.calls.push(`deleteBranch ${key(ref)} ${branch}`);
    this.deletedBranches.push(branch);
    return Promise.resolve();
  }

  closeIssue(ref: RepoRef, index: number): Promise<Issue> {
    const issue = this.issue(key(ref), index);
    this.calls.push(`closeIssue ${key(ref)}#${String(index)}`);
    issue.state = "closed";
    return Promise.resolve(structuredClone(issue));
  }

  createIssue(
    ref: RepoRef,
    input: { title: string; body?: string; assignees?: string[]; labelIds?: number[] },
  ): Promise<Issue> {
    const repo = key(ref);
    const issue = this.addIssue(repo, {
      number: this.nextNumber(repo),
      title: input.title,
      body: input.body ?? "",
      assignees: input.assignees ?? [],
      createdAt: "2026-06-01T00:00:00Z",
    });
    issue.user = user(this.botLogin);
    issue.labels = (this.labels.get(repo) ?? []).filter((l) => input.labelIds?.includes(l.id));
    this.calls.push(`createIssue ${repo}#${String(issue.number)}`);
    return Promise.resolve(structuredClone(issue));
  }

  addDependency(
    ref: RepoRef,
    index: number,
    blocker: { repo: RepoRef; index: number },
  ): Promise<void> {
    const dependencyKey = `${key(ref)}#${String(index)}`;
    const blockers = this.dependencies.get(dependencyKey) ?? [];
    if (blockers.includes(blocker.index)) {
      // Gitea rejects a duplicate dependency.
      return Promise.reject(new GiteaError("POST", "/dependencies", 422, "dependency exists"));
    }
    this.calls.push(`addDependency ${dependencyKey} blockedBy #${String(blocker.index)}`);
    this.dependencies.set(dependencyKey, [...blockers, blocker.index]);
    return Promise.resolve();
  }

  /** Issues the bot filed (e.g. questions), newest last. */
  filedIssues(repo: string): Issue[] {
    return [...this.repoIssues(repo).values()].filter((i) => i.user.login === this.botLogin);
  }

  /** Comment as someone other than the bot (e.g. the reviewer typing /merge). */
  commentAs(repo: string, index: number, author: string, body: string): void {
    this.comments.push({ repo, issue: index, author, body });
  }

  // --- Internals --------------------------------------------------------------

  private repoIssues(repo: string): Map<number, Issue> {
    const issues = this.issues.get(repo);
    if (!issues) throw new Error(`no repo ${repo}`);
    return issues;
  }

  private labelByName(repo: string, name: string, create: boolean): Label {
    const labels = this.labels.get(repo) ?? [];
    let label = labels.find((l) => l.name === name);
    if (!label && create) {
      label = { id: this.nextId++, name, color: "ededed", description: "", exclusive: false };
      labels.push(label);
    }
    if (!label) throw new GiteaError("POST", "/labels", 422, `unknown label ${name}`);
    return label;
  }

  private readonly branchHeads = new Map<string, string>();

  /** PRs and issues share numbers in Gitea. */
  private nextNumber(repo: string): number {
    return (
      Math.max(
        0,
        ...this.repoIssues(repo).keys(),
        ...(this.pulls.get(repo) ?? []).map((p) => p.number),
      ) + 1
    );
  }

  private headOf(repo: string, branch: string): string {
    return this.branchHeads.get(`${repo}:${branch}`) ?? `${branch}-head`;
  }
}

const REVIEWER_DEFAULT = "human";

function key(ref: RepoRef): string {
  return `${ref.owner}/${ref.name}`;
}

function notFound(method: string, path: string): GiteaError {
  return new GiteaError(method, path, 404, "not found");
}
