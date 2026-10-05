import { z } from "zod";

import { issueFromBranch } from "../conventions.js";

/**
 * The structured report every Claude run ends with. It is passed to the CLI
 * as `--json-schema`, so Claude must produce it as its final answer, and it is
 * validated again here before the dispatcher acts on it (pushing branches,
 * opening PRs, filing follow-up issues).
 */

export const reportSchema = z.strictObject({
  outcome: z
    .enum(["completed", "no_changes", "needs_human"])
    .describe(
      "completed: the work for this phase is committed. no_changes: nothing needed changing. needs_human: you cannot proceed safely without an answer (list it in followups with blocking: true).",
    ),
  summary: z
    .string()
    .min(1)
    .describe("What you did and why, in a few sentences of Markdown. Used in PR descriptions."),
  branches: z
    .array(
      z.strictObject({
        name: z.string().min(1).describe("Local branch holding the commits."),
        title: z.string().min(1).describe("PR title for this branch."),
        body: z.string().describe("PR description for this branch (Markdown)."),
      }),
    )
    .describe(
      "Branches with your commits, bottom of the stack first. Usually one. Each later branch must be based on the previous one.",
    ),
  decisions: z
    .array(
      z.strictObject({
        question: z.string().min(1),
        chosen: z.string().min(1).describe("The option you went with."),
        alternatives: z.array(z.string()),
        rationale: z.string(),
        needsConfirmation: z
          .boolean()
          .describe("true if a human should confirm this choice after the fact."),
      }),
    )
    .describe("Open questions you resolved yourself by taking the recommended option."),
  followups: z
    .array(
      z.strictObject({
        title: z.string().min(1),
        body: z.string(),
        blocking: z
          .boolean()
          .describe("true only if the work cannot continue until a human answers."),
      }),
    )
    .describe("Questions or follow-up work for a human, filed as new issues."),
});

export type Report = z.infer<typeof reportSchema>;

/**
 * JSON Schema for `claude --json-schema`. The CLI's validator rejects the
 * draft 2020-12 `$schema` zod emits by default ("no schema with key or ref"),
 * so emit draft-07 and drop the `$schema` key.
 */
export function reportJsonSchema(): string {
  const schema: Record<string, unknown> = z.toJSONSchema(reportSchema, { target: "draft-7" });
  return JSON.stringify({ ...schema, $schema: undefined });
}

export type ReportCheck = { ok: true; report: Report } | { ok: false; error: string };

/**
 * Validate a run's structured output. Beyond the schema, every branch must
 * belong to the issue being worked on, so a confused or manipulated run can
 * never get the dispatcher to push to `main` or another issue's branch.
 */
export function checkReport(output: unknown, prefix: string, issue: number): ReportCheck {
  const parsed = reportSchema.safeParse(output);
  if (!parsed.success) {
    return { ok: false, error: `invalid report: ${z.prettifyError(parsed.error)}` };
  }
  const foreign = parsed.data.branches
    .map((branch) => branch.name)
    .filter((name) => issueFromBranch(prefix, name) !== issue);
  if (foreign.length > 0) {
    return {
      ok: false,
      error: `report lists branches outside ${prefix}/${String(issue)}-*: ${foreign.join(", ")}`,
    };
  }
  const report = parsed.data;
  if (report.outcome === "completed" && report.branches.length === 0) {
    return { ok: false, error: "report says completed but lists no branches" };
  }
  if (report.outcome === "needs_human" && !report.followups.some((f) => f.blocking)) {
    return { ok: false, error: "report says needs_human but has no blocking followup" };
  }
  return { ok: true, report };
}
