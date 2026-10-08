import { loadConfig } from "./config/load.js";
import { questionLabel } from "./conventions.js";
import { QuestionDesk } from "./engine/questions.js";
import { squashLegacyQuestions } from "./engine/legacy-questions.js";
import { GiteaClient, parseRepo } from "./gitea/client.js";
import { createLogger } from "./log.js";

/**
 * One-off: fold the per-question issues filed before #53 into one questions
 * issue per source. Uses the dispatcher's own config, so run it where the
 * dispatcher runs:
 *
 *   node dist/squash-questions.js owner/repo           # dry run
 *   node dist/squash-questions.js owner/repo --apply
 */

const args = process.argv.slice(2);
const fullName = args.find((arg) => !arg.startsWith("--"));
if (fullName === undefined) {
  process.stderr.write("usage: squash-questions <owner/repo> [--apply]\n");
  process.exit(2);
}

const config = loadConfig();
const log = createLogger(config.logLevel, { secrets: [config.gitea.token] });
const gitea = new GiteaClient({ baseUrl: config.gitea.url, token: config.gitea.token });
await squashLegacyQuestions({
  repo: { ref: parseRepo(fullName), fullName },
  questionLabel: questionLabel(config.labelPrefix),
  reviewer: config.humanReviewer,
  gitea,
  desk: new QuestionDesk(config, gitea, log),
  log,
  apply: args.includes("--apply"),
});
