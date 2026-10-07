import { describe, expect, it } from "vitest";

import { createLogger, LogBuffer } from "./log.js";

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

describe("runtime level and log buffer", () => {
  it("changes the level for loggers handed out earlier", () => {
    const lines: string[] = [];
    const root = createLogger("info", { write: (line) => lines.push(line) });
    const child = root.child({ repo: "org/a" });
    child.debug("hidden");
    root.setLevel("debug");
    child.debug("shown");
    root.setLevel("error");
    child.warn("hidden too");
    expect(lines.map((line) => (JSON.parse(line) as { msg: string }).msg)).toEqual(["shown"]);
  });

  it("feeds the buffer redacted lines and keeps only the newest", () => {
    const buffer = new LogBuffer(2);
    const seen: string[] = [];
    const unsubscribe = buffer.subscribe((line) => seen.push(line));
    const log = createLogger("info", {
      write: () => undefined,
      sink: (line) => {
        buffer.push(line);
      },
      secrets: ["dashboard-secret-abc"],
    });
    log.info("one");
    log.info("token dashboard-secret-abc");
    unsubscribe();
    log.info("three");

    const recent = buffer.recent();
    expect(recent).toHaveLength(2);
    expect(recent.join("\n")).not.toContain("dashboard-secret-abc");
    expect(recent[1]).toContain("three");
    expect(seen).toHaveLength(2);
  });
});

describe("report", () => {
  it("receives warn-or-worse lines above the threshold, with bound fields", () => {
    const reported: [string, string, Record<string, unknown>][] = [];
    const error = new Error("boom");
    const log = createLogger("info", {
      write: () => undefined,
      report: (level, message, fields) => reported.push([level, message, fields]),
    }).child({ repo: "org/a" });
    log.debug("hidden");
    log.info("not reported");
    log.warn("slow", { issue: 3 });
    log.error("failed", { error });
    expect(reported).toEqual([
      ["warn", "slow", { repo: "org/a", issue: 3 }],
      ["error", "failed", { repo: "org/a", error }],
    ]);
  });

  it("is skipped when the level filters the line out", () => {
    const reported: string[] = [];
    const log = createLogger("error", {
      write: () => undefined,
      report: (level) => reported.push(level),
    });
    log.warn("quiet");
    expect(reported).toEqual([]);
  });
});
