import { describe, expect, it } from "vitest";

import { GiteaClient, parseRepo } from "./client.js";
import { fakeFetch, jsonResponse, type RecordedRequest } from "../../test/helpers/fake-fetch.js";

const repo = { owner: "org", name: "repo" };
const PAGE = "page=1&limit=50";

function client(reply: (request: RecordedRequest) => Response = () => jsonResponse([])) {
  const fake = fakeFetch(reply);
  const gitea = new GiteaClient({
    baseUrl: "https://gitea.example.com",
    token: "t",
    fetch: fake.fetch,
    sleep: () => Promise.resolve(),
  });
  return { gitea, requests: fake.requests };
}

type Case = [string, (gitea: GiteaClient) => Promise<unknown>, string, string, unknown?];

// [description, call, method, path?query, body]
const CASES: Case[] = [
  ["current user", (g) => g.getCurrentUser(), "GET", "/user"],
  ["repo", (g) => g.getRepo(repo), "GET", "/repos/org/repo"],
  ["user repos", (g) => g.listUserRepos("me"), "GET", `/users/me/repos?${PAGE}`],
  ["org repos", (g) => g.listOrgRepos("org"), "GET", `/orgs/org/repos?${PAGE}`],
  [
    "assigned open issues with labels",
    (g) => g.listIssues(repo, { assignee: "bot", labels: ["a", "b"] }),
    "GET",
    `/repos/org/repo/issues?type=issues&state=open&labels=a%2Cb&assigned_by=bot&${PAGE}`,
  ],
  ["issue", (g) => g.getIssue(repo, 4), "GET", "/repos/org/repo/issues/4"],
  [
    "create issue",
    (g) => g.createIssue(repo, { title: "T", body: "B", assignees: ["me"], labelIds: [1] }),
    "POST",
    "/repos/org/repo/issues",
    { title: "T", body: "B", assignees: ["me"], labels: [1] },
  ],
  [
    "edit issue",
    (g) => g.editIssue(repo, 4, { body: "new" }),
    "PATCH",
    "/repos/org/repo/issues/4",
    { body: "new" },
  ],
  [
    "close issue",
    (g) => g.closeIssue(repo, 4),
    "PATCH",
    "/repos/org/repo/issues/4",
    { state: "closed" },
  ],
  [
    "comments since",
    (g) => g.listComments(repo, 4, "2026-01-01T00:00:00Z"),
    "GET",
    "/repos/org/repo/issues/4/comments?since=2026-01-01T00%3A00%3A00Z",
  ],
  [
    "create comment",
    (g) => g.createComment(repo, 4, "hi"),
    "POST",
    "/repos/org/repo/issues/4/comments",
    { body: "hi" },
  ],
  [
    "add dependency",
    (g) => g.addDependency(repo, 5, { repo: { owner: "o2", name: "r2" }, index: 3 }),
    "POST",
    "/repos/org/repo/issues/5/dependencies",
    { owner: "o2", repo: "r2", index: 3 },
  ],
  [
    "remove dependency",
    (g) => g.removeDependency(repo, 5, { repo: { owner: "o2", name: "r2" }, index: 3 }),
    "DELETE",
    "/repos/org/repo/issues/5/dependencies",
    { owner: "o2", repo: "r2", index: 3 },
  ],
  [
    "list dependencies",
    (g) => g.listDependencies(repo, 5),
    "GET",
    `/repos/org/repo/issues/5/dependencies?${PAGE}`,
  ],
  ["labels", (g) => g.listLabels(repo), "GET", `/repos/org/repo/labels?${PAGE}`],
  [
    "create label adds # to color",
    (g) => g.createLabel(repo, { name: "claude:working", color: "fbca04" }),
    "POST",
    "/repos/org/repo/labels",
    { name: "claude:working", color: "#fbca04", description: "", exclusive: false },
  ],
  [
    "add labels by name",
    (g) => g.addLabels(repo, 4, ["claude:working"]),
    "POST",
    "/repos/org/repo/issues/4/labels",
    { labels: ["claude:working"] },
  ],
  [
    "remove label",
    (g) => g.removeLabel(repo, 4, 12),
    "DELETE",
    "/repos/org/repo/issues/4/labels/12",
  ],
  [
    "open pulls into base",
    (g) => g.listPulls(repo, { baseBranch: "main" }),
    "GET",
    `/repos/org/repo/pulls?state=open&base_branch=main&${PAGE}`,
  ],
  ["pull", (g) => g.getPull(repo, 9), "GET", "/repos/org/repo/pulls/9"],
  [
    "create pull",
    (g) => g.createPull(repo, { head: "claude/4-x", base: "main", title: "T", body: "Closes #4" }),
    "POST",
    "/repos/org/repo/pulls",
    { head: "claude/4-x", base: "main", title: "T", body: "Closes #4" },
  ],
  [
    "retarget pull",
    (g) => g.retargetPull(repo, 9, "main"),
    "PATCH",
    "/repos/org/repo/pulls/9",
    { base: "main" },
  ],
  [
    "merge pull",
    (g) => g.mergePull(repo, 9, { style: "squash", headCommitId: "abc", deleteBranch: true }),
    "POST",
    "/repos/org/repo/pulls/9/merge",
    { do: "squash", head_commit_id: "abc", delete_branch_after_merge: true },
  ],
  ["reviews", (g) => g.listPullReviews(repo, 9), "GET", `/repos/org/repo/pulls/9/reviews?${PAGE}`],
  [
    "delete branch",
    (g) => g.deleteBranch(repo, "claude/4-x"),
    "DELETE",
    "/repos/org/repo/branches/claude%2F4-x",
  ],
  [
    "review comments",
    (g) => g.listReviewComments(repo, 9, 2),
    "GET",
    "/repos/org/repo/pulls/9/reviews/2/comments",
  ],
  [
    "combined status of a branch",
    (g) => g.getCombinedStatus(repo, "claude/4-x"),
    "GET",
    "/repos/org/repo/commits/claude%2F4-x/status?limit=50",
  ],
];

describe("GiteaClient endpoints", () => {
  it.each(CASES)("%s", async (_name, call, method, target, body) => {
    const { gitea, requests } = client();
    await call(gitea);
    expect(requests).toHaveLength(1);
    const request = requests[0] as RecordedRequest;
    expect(request.method).toBe(method);
    expect(request.url.pathname + request.url.search).toBe(`/api/v1${target}`);
    expect(request.body).toEqual(body);
  });
});

describe("GiteaClient Actions helpers", () => {
  it("lists runs with filters and unwraps the envelope", async () => {
    const run = { id: 1, status: "in_progress", head_sha: "abc" };
    const { gitea, requests } = client(() =>
      jsonResponse({ total_count: 1, workflow_runs: [run] }),
    );
    expect(await gitea.listWorkflowRuns(repo, { headSha: "abc", event: "pull_request" })).toEqual([
      run,
    ]);
    expect(requests[0]?.url.search).toBe("?head_sha=abc&event=pull_request&limit=20");
  });

  it("treats a null run list as empty", async () => {
    const { gitea } = client(() => jsonResponse({ total_count: 0, workflow_runs: null }));
    expect(await gitea.listWorkflowRuns(repo)).toEqual([]);
  });

  it("counts runs in a status from total_count", async () => {
    const { gitea, requests } = client(() => jsonResponse({ total_count: 3, workflow_runs: [{}] }));
    expect(await gitea.countWorkflowRuns(repo, "queued")).toBe(3);
    expect(requests[0]?.url.search).toBe("?status=queued&limit=1");
  });

  it("lists jobs of a run and fetches job logs as text", async () => {
    const { gitea, requests } = client((request) =>
      request.url.pathname.endsWith("/logs")
        ? new Response("step 1\nerror: boom\n")
        : jsonResponse({ total_count: 1, jobs: [{ id: 5, name: "check" }] }),
    );
    expect(await gitea.listRunJobs(repo, 1)).toEqual([{ id: 5, name: "check" }]);
    expect(await gitea.getJobLogs(repo, 5)).toBe("step 1\nerror: boom\n");
    expect(requests[1]?.url.pathname).toBe("/api/v1/repos/org/repo/actions/jobs/5/logs");
    expect(requests[1]?.headers.Accept).toBe("text/plain");
  });
});

describe("parseRepo", () => {
  it("splits owner/repo", () => {
    expect(parseRepo("org/repo")).toEqual({ owner: "org", name: "repo" });
  });

  it.each(["repo", "org/", "/repo", "a/b/c"])("rejects %s", (value) => {
    expect(() => parseRepo(value)).toThrow("expected owner/repo");
  });
});
