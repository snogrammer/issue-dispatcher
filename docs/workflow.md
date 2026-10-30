# How work flows

1. **Assign an issue to the bot.** Each watched repo works on one issue at a
   time: `priority:high` first, then unlabeled, then `priority:low`, oldest
   first. Issues blocked by an open Gitea dependency wait. The dashboard
   lists the assigned tickets still waiting their turn.

   **Assigning a pull request** works too: the bot takes it straight to
   review, rebases it when it conflicts, fixes failing CI and review notes,
   and merges it once CI passes. Useful for a quick fix when you're away from
   a computer. Pull requests are picked up before issues.

2. **Claude implements it** on `claude/<n>-<slug>` and commits, after running
   the repo's checks (whatever its CI runs) locally. The repo's pinned
   language versions are installed first (see
   [deploy.md](deploy.md#project-toolchains)). The dispatcher pushes only if
   every check Claude reports passed; otherwise the issue is blocked with the
   list of checks. Then it opens a PR (or a stack of PRs for larger work; only
   the top one says `Closes #n`). PR descriptions list the decisions Claude
   made on its own.
3. **CI decides.** When the bottom PR's CI is green it is merged with the
   repo's default merge style (or `MERGE_STYLE`). Red CI starts a fix round
   with the failing job logs, once every CI run on that commit has finished;
   requested changes start a review round. Fix rounds follow the same rule:
   checks must pass locally before the fix is pushed. Rounds are capped by
   `MAX_FIX_ATTEMPTS` (default 2) per PR; after that the dispatcher files a
   "Help needed" ticket for you (see Questions). A round that commits nothing
   stops instead of looping.
4. **Stacks move up.** When the bottom PR of a stack merges, the next PR is
   retargeted to the default branch, the merged branch is deleted, and the
   next branch is rebased onto the default branch (dropping the merged PR's
   commits, which a squash or rebase merge rewrote). A clean rebase is done
   by the dispatcher; conflicts go to Claude as a rebase round. A PR that
   conflicts because the default branch moved gets a rebase round too.
   Rebase rounds count toward `MAX_FIX_ATTEMPTS`; if Claude can't resolve a
   conflict it asks you (see Questions).
5. **Done.** After the last PR merges the issue is closed and the next
   assigned issue is picked up.

CI runners are shared and few, so while `CI_MAX_QUEUE` or more Actions runs
are queued or running across the watched repos, no new Claude run starts
(new issues, fix rounds and resumes all wait). CI that is merely queued or
pending is never treated as failed.

PRs merge without human review, so CI is the safety net. With `REQUIRE_CI`
(the default) a PR that never reports a CI status is not merged; after
`CI_NO_STATUS_TIMEOUT_MIN` the issue is blocked for a human.

## Usage limits

Claude's usage limits apply to the whole account, so the dispatcher handles
them globally:

- **Close to the limit** (the CLI warns, or a usage window is at least
  `RATE_LIMIT_PICKUP_THRESHOLD` full): no new issues are picked up until that
  window resets. Issues already in progress keep going.
- **Limit reached**: no runs at all until the reported reset time. The issue
  whose run was cut off gets a comment, keeps its state and session, and
  resumes afterwards; a cut-off fix or review round isn't counted as a round.
  Without a reset time the pause starts at `RATE_LIMIT_BACKOFF_BASE_MIN`
  minutes and doubles each time (up to `RATE_LIMIT_BACKOFF_MAX_MIN`) until a
  run succeeds.

## Questions

Claude doesn't stop to ask when it can pick a sensible option: it takes the
option it recommends and records the decision. Its report can still raise
questions. The dispatcher collects them all in **one issue per ticket**,
`Questions for #n: <title>`, labeled `claude:question` and assigned to
`HUMAN_REVIEWER`. Later rounds add to the same issue and never ask the same
question twice. Each question is a section with checkboxes, like plan mode:

- **Decisions to confirm**: work continued with Claude's choice, which is
  ticked. Claude won't revisit it on its own: if it should change, open an
  issue for the change.
- **Follow-ups**: things noticed but out of scope. Tick "Handled" once dealt
  with.
- **🛑 Blocking**: Claude can't continue safely. Its recommended option is
  ticked. The ticket becomes `claude:blocked` and depends on the questions
  issue. Work resumes, in the same Claude session, as soon as you comment on
  the questions issue (as `HUMAN_REVIEWER`) or close it. Claude gets your
  ticks and your reply; closing without a reply means "go with the ticked
  options". Comments from anyone else are not passed to Claude.

Once answered, the questions issue stops blocking the ticket but stays open
for anything else in it; close it when you're done. A later blocking question
reopens it, and only replies written after that question count as answers.

The dispatcher adds one more kind itself: **Help needed** (`Help needed on
#n: CI is still failing on #pr after 2 rounds`), when a PR runs out of fix
rounds. It lists the failing jobs, blocks the ticket, and works like a
blocking question. Your reply is passed to Claude, which continues on the PR
with fresh fix rounds; closing the issue lets Claude try again on its own.

## Steering

| You want to…                          | Do this                                                                                                               |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Merge a PR now, whatever CI says      | Comment `/merge` on the PR (as `HUMAN_REVIEWER`)                                                                      |
| Ask for changes                       | Submit a "request changes" review on the PR's latest commit                                                           |
| Stop work on an issue                 | Unassign the bot or close the issue (open PRs are left alone)                                                         |
| Answer a blocking question            | Tick an option and comment on the questions issue, or close it                                                        |
| Retry a blocked issue from scratch    | Remove the `claude:blocked` label                                                                                     |
| Prioritize                            | Add `priority:high` or `priority:low`                                                                                 |
| Pick the model or effort for an issue | Add `model:<name>` or `effort:<level>` (see [config.md](config.md#how-a-runs-model-effort-and-turn-limit-are-chosen)) |

When the bot needs you it labels the issue `claude:blocked` and mentions
`HUMAN_REVIEWER` in a comment explaining why.
