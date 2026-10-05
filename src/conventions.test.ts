import { describe, expect, it } from "vitest";

import {
  branchName,
  issueFromBranch,
  stateFromLabels,
  stateLabel,
  stateLabels,
} from "./conventions.js";

describe("state labels", () => {
  it("prefixes state names", () => {
    expect(stateLabel("claude", "in-review")).toBe("claude:in-review");
    expect(stateLabels("bot")).toEqual(["bot:working", "bot:in-review", "bot:blocked"]);
  });

  it("reads the most cautious state from an issue's labels", () => {
    expect(stateFromLabels("claude", ["bug", "claude:working"])).toBe("working");
    expect(stateFromLabels("claude", ["claude:working", "claude:blocked"])).toBe("blocked");
    expect(stateFromLabels("claude", ["claude:in-review", "claude:working"])).toBe("in-review");
    expect(stateFromLabels("claude", ["other:working"])).toBeUndefined();
  });
});

describe("branch names", () => {
  it("builds a slug from the issue title", () => {
    expect(branchName("claude", 42, "Fix: login redirect (SSO)!")).toBe(
      "claude/42-fix-login-redirect-sso",
    );
  });

  it("caps the slug length without trailing dashes", () => {
    const name = branchName("claude", 7, "a".repeat(39) + " tail that is cut");
    expect(name).toBe(`claude/7-${"a".repeat(39)}`);
  });

  it("falls back to the bare number when the title has no usable characters", () => {
    expect(branchName("claude", 3, "🚀🚀")).toBe("claude/3");
  });

  it("parses the issue number back", () => {
    expect(issueFromBranch("claude", "claude/42-fix-login")).toBe(42);
    expect(issueFromBranch("claude", "claude/42")).toBe(42);
    expect(issueFromBranch("claude", "claude/42abc")).toBeUndefined();
    expect(issueFromBranch("claude", "feature/42-x")).toBeUndefined();
    expect(issueFromBranch("claude", "claude-bot/42-x")).toBeUndefined();
  });
});
