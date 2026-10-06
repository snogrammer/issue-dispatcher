import { describe, expect, it } from "vitest";

import { createLogger } from "./log.js";

describe("createLogger", () => {
  it("writes JSON lines at or above the level, with bound and per-call fields", () => {
    const lines: string[] = [];
    const log = createLogger("info", { write: (line) => lines.push(line) }).child({
      repo: "org/a",
    });
    log.debug("hidden");
    log.info("picked up", { issue: 3 });
    log.error("failed", { error: new Error("boom") });

    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ level: "info", msg: "picked up", repo: "org/a", issue: 3 });
    expect(parsed[1]).toMatchObject({ level: "error", error: { name: "Error", message: "boom" } });
    expect(typeof parsed[0]?.time).toBe("string");
  });
});

describe("secret redaction", () => {
  it("replaces secret values anywhere in a line, including error messages", () => {
    const lines: string[] = [];
    const log = createLogger("info", {
      write: (line) => lines.push(line),
      secrets: ["gitea-token-123456", undefined, "short"],
    });
    log.error("push failed for gitea-token-123456", {
      error: new Error("401 with header token gitea-token-123456"),
      note: "short stays",
    });
    expect(lines[0]).not.toContain("gitea-token-123456");
    expect(lines[0]).toContain("push failed for [redacted]");
    expect(lines[0]).toContain("401 with header token [redacted]");
    expect(lines[0]).toContain("short stays");
  });
});
