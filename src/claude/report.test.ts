import { describe, expect, it } from "vitest";

import { checkReport, reportJsonSchema, type Report } from "./report.js";

const REPORT: Report = {
  outcome: "completed",
  summary: "Added the thing.",
  branches: [
    { name: "claude/7-runner", title: "Runner", body: "Part 1" },
    { name: "claude/7-runner-part-2", title: "Runner 2", body: "Part 2" },
  ],
  decisions: [
    {
      question: "Which library?",
      chosen: "none",
      alternatives: ["a", "b"],
      rationale: "smaller",
      needsConfirmation: false,
    },
  ],
  followups: [{ title: "Later", body: "...", blocking: false }],
};

describe("checkReport", () => {
  it("accepts a valid report for the issue", () => {
    expect(checkReport(REPORT, "claude", 7)).toEqual({ ok: true, report: REPORT });
  });

  it("rejects schema violations with a readable message", () => {
    const result = checkReport({ ...REPORT, outcome: "done", extra: 1 }, "claude", 7);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/invalid report[\s\S]*outcome/);
  });

  it("rejects missing output", () => {
    expect(checkReport(undefined, "claude", 7).ok).toBe(false);
  });

  it.each(["main", "claude/8-other", "feature/7-x"])("refuses foreign branch %s", (name) => {
    const result = checkReport(
      { ...REPORT, branches: [{ name, title: "t", body: "" }] },
      "claude",
      7,
    );
    expect(result).toEqual({
      ok: false,
      error: `report lists branches outside claude/7-*: ${name}`,
    });
  });

  it("requires branches when completed and a blocking followup when asking for a human", () => {
    expect(checkReport({ ...REPORT, branches: [] }, "claude", 7)).toMatchObject({ ok: false });
    expect(checkReport({ ...REPORT, outcome: "no_changes", branches: [] }, "claude", 7).ok).toBe(
      true,
    );
    expect(checkReport({ ...REPORT, outcome: "needs_human" }, "claude", 7)).toMatchObject({
      ok: false,
      error: "report says needs_human but has no blocking followup",
    });
    const blocking = {
      ...REPORT,
      outcome: "needs_human",
      followups: [{ title: "?", body: "", blocking: true }],
    };
    expect(checkReport(blocking, "claude", 7).ok).toBe(true);
  });
});

describe("reportJsonSchema", () => {
  it("produces a strict JSON Schema for the CLI, without a $schema the CLI rejects", () => {
    const schema = JSON.parse(reportJsonSchema()) as Record<string, unknown>;
    expect(schema).not.toHaveProperty("$schema");
    expect(schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["outcome", "summary", "branches", "decisions", "followups"],
    });
  });
});
