import { describe, expect, it } from "vitest";

import type { Issue } from "../gitea/types.js";
import { orderCandidates, priorityRank } from "./pickup.js";

function issue(number: number, labels: string[] = [], createdAt = "2026-01-01T00:00:00Z"): Issue {
  return {
    number,
    labels: labels.map((name, id) => ({ id, name })),
    created_at: createdAt,
    pull_request: null,
  } as Issue;
}

describe("orderCandidates", () => {
  it("orders by priority, then oldest, then number", () => {
    const ordered = orderCandidates(
      [
        issue(1, ["priority:low"], "2026-01-01T00:00:00Z"),
        issue(2, [], "2026-02-01T00:00:00Z"),
        issue(3, [], "2026-01-15T00:00:00Z"),
        issue(4, ["priority:high"], "2026-03-01T00:00:00Z"),
        issue(6, [], "2026-01-15T00:00:00Z"),
        issue(5, [], "2026-01-15T00:00:00Z"),
      ],
      "claude",
    );
    expect(ordered.map((i) => i.number)).toEqual([4, 3, 5, 6, 2, 1]);
  });

  it("drops pull requests, issues with a state label and question issues", () => {
    const pr = { ...issue(1), pull_request: { merged: false } } as Issue;
    const ordered = orderCandidates(
      [pr, issue(2, ["claude:blocked"]), issue(3, ["claude:question"]), issue(4, ["bot:working"])],
      "claude",
    );
    expect(ordered.map((i) => i.number)).toEqual([4]);
  });
});

describe("priorityRank", () => {
  it("ranks high < none < low", () => {
    expect(
      [issue(1, ["priority:high"]), issue(2), issue(3, ["priority:low"])].map(priorityRank),
    ).toEqual([0, 1, 2]);
  });
});
