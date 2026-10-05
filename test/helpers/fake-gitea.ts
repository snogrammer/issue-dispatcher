/**
 * In-memory Gitea covering the endpoints the engine uses. Issues, labels,
 * comments and dependencies behave like the real API closely enough for
 * state-machine tests; every mutating call is also appended to `calls` so
 * tests can assert ordering (e.g. label added before the slot is claimed).
 */
import type { EngineGitea } from "../../src/engine/engine.js";
import { GiteaError } from "../../src/gitea/http.js";
import type {
  Comment,
  Issue,
  Label,
  PullRequest,
  RepoRef,
  Repository,
  User,
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
  private nextId = 1;

  constructor(private readonly botLogin: string) {}

  addRepo(
    fullName: string,
    options: { archived?: boolean; empty?: boolean; defaultBranch?: string } = {},
  ): void {
    const [owner = "", name = ""] = fullName.split("/");
    this.repos.set(fullName, {
      id: this.nextId++,
      name,
      full_name: fullName,
      owner: user(owner),
      default_branch: options.defaultBranch ?? "main",
      archived: options.archived ?? false,
      empty: options.empty ?? false,
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

  listPulls(): Promise<PullRequest[]> {
    return Promise.resolve([]);
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
}

function key(ref: RepoRef): string {
  return `${ref.owner}/${ref.name}`;
}

function notFound(method: string, path: string): GiteaError {
  return new GiteaError(method, path, 404, "not found");
}
