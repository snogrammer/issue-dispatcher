import { describe, expect, it } from "vitest";

import { BOT, REVIEWER } from "../../test/helpers/engine-fakes.js";
import { FakeGitea } from "../../test/helpers/fake-gitea.js";
import { parseRepo } from "../gitea/client.js";
import { silentLogger } from "../log.js";
import { legacyQuestion, squashLegacyQuestions } from "./legacy-questions.js";
import { parseIssueMarker, parseItems, QuestionDesk } from "./questions.js";

// Shapes as the pre-#53 dispatcher filed them.
const DECISION = {
  number: 128,
  title: "Confirm decision on #54: How is 'same unit' decided for a candidate?",
  body: `While working on #54 (Alternatives finder job on approval), Claude made this decision on its own and work continued with it. Please confirm it, or say what should change.

**Question:** How is 'same unit' decided for a candidate?
**Chosen:** Reuse the grouping \`score_pair\` with the \`GROUPING_*\` thresholds (address, distance, title, description, pHash)
**Why:** One definition of 'same unit' stays consistent with grouping.
**Alternatives:** A separate scoring model with its own thresholds

<!-- claude-dispatcher:question source=54 key=c37eb7efe74a blocking=false -->`,
};

const FOLLOWUP = {
  number: 126,
  title: "Question from #54: Show alternatives on the property detail page and in the API",
  body: `While working on #54 (Alternatives finder job on approval), Claude raised this follow-up:

\`enrichment_results\` is now filled for approved properties, but nothing displays it.

Add them to \`/properties/{id}\`.

Work on #54 continues; this is for later.

<!-- claude-dispatcher:question source=54 key=97a31b21a8b4 blocking=false -->`,
};

const BLOCKING = {
  number: 142,
  title: "Question from #57: Need failing test output for #57 CI test job",
  body: `While working on #57 (Enrichment UI), Claude raised this blocking question:

The \`CI / test (pull_request)\` job failed, but the log has no failing test names.

Work on #57 is paused until this is answered. Reply here as @snogrammer, or close this issue to let Claude continue with its recommended option.

<!-- claude-dispatcher:question source=57 key=e14a35ad04c0 blocking=true -->`,
};

describe("legacyQuestion", () => {
  it("reads a decision to confirm", () => {
    expect(legacyQuestion(DECISION)).toEqual({
      number: 128,
      source: 54,
      item: {
        key: "c37eb7efe74a",
        kind: "decision",
        title: "How is 'same unit' decided for a candidate?",
        body: "**Why:** One definition of 'same unit' stays consistent with grouping.",
        options: [
          "Reuse the grouping `score_pair` with the `GROUPING_*` thresholds (address, distance, title, description, pHash)",
          "A separate scoring model with its own thresholds",
        ],
      },
    });
  });

  it("reads a follow-up and a blocking question", () => {
    expect(legacyQuestion(FOLLOWUP)?.item).toEqual({
      key: "97a31b21a8b4",
      kind: "followup",
      title: "Show alternatives on the property detail page and in the API",
      body: "`enrichment_results` is now filled for approved properties, but nothing displays it.\n\nAdd them to `/properties/{id}`.",
      options: [],
    });
    expect(legacyQuestion(BLOCKING)).toMatchObject({
      source: 57,
      item: {
        kind: "blocking",
        title: "Need failing test output for #57 CI test job",
        body: "The `CI / test (pull_request)` job failed, but the log has no failing test names.",
      },
    });
  });

  it("ignores other issues", () => {
    expect(legacyQuestion({ number: 1, title: "Bug", body: "Broken." })).toBeUndefined();
  });
});

describe("squashLegacyQuestions", () => {
  const R = "org/r";

  function fixture() {
    const gitea = new FakeGitea(BOT);
    gitea.addRepo(R);
    gitea.addIssue(R, { number: 54, title: "Alternatives finder", state: "closed" });
    gitea.addIssue(R, { number: 57, title: "Enrichment UI", blockedBy: [142] });
    for (const legacy of [FOLLOWUP, DECISION, BLOCKING]) {
      gitea.addIssue(R, { ...legacy, labels: ["claude:question"], assignees: [REVIEWER] });
    }
    const config = { labelPrefix: "claude", humanReviewer: REVIEWER };
    const output: string[] = [];
    const run = (apply: boolean) =>
      squashLegacyQuestions({
        repo: { ref: parseRepo(R), fullName: R },
        questionLabel: "claude:question",
        reviewer: REVIEWER,
        gitea,
        desk: new QuestionDesk(config, gitea),
        log: silentLogger,
        apply,
        write: (text) => output.push(text),
      });
    return { gitea, run, output };
  }

  it("changes nothing on a dry run", async () => {
    const { gitea, run, output } = fixture();
    await run(false);
    expect(gitea.calls).toEqual([]);
    expect(output).toHaveLength(2);
    expect(output[0]).toContain("----- Questions for #54: Alternatives finder");
    expect(output[1]).toContain("### 🛑 Blocking: Need failing test output for #57 CI test job");
  });

  it("files one questions issue per source and closes the old ones", async () => {
    const { gitea, run } = fixture();
    await run(true);

    const [for54, for57] = gitea.filedIssues(R);
    expect(for54?.title).toBe("Questions for #54: Alternatives finder");
    expect(parseItems(for54?.body ?? "").map((i) => i.key)).toEqual([
      "97a31b21a8b4",
      "c37eb7efe74a",
    ]);
    expect(for57?.title).toBe("Questions for #57: Enrichment UI");
    expect(parseIssueMarker(for57?.body ?? "")?.pending).toEqual(["e14a35ad04c0"]);
    expect(gitea.dependencies.get(`${R}#57`)).toEqual([for57?.number]);
    expect(gitea.dependencies.get(`${R}#54`) ?? []).toEqual([]);

    for (const legacy of [126, 128, 142]) {
      expect(gitea.issue(R, legacy).state).toBe("closed");
    }
    expect(gitea.commentsOn(R, 142)).toEqual([
      `Merged into #${String(for57?.number)}, which collects every question about #57.`,
    ]);

    // Nothing left to squash the second time.
    await run(true);
    expect(gitea.filedIssues(R)).toHaveLength(2);
  });
});
