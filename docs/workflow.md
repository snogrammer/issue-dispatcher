# How work flows

1. **Assign an issue to the bot.** Each watched repo works on one issue at a
   time: `priority:high` first, then unlabeled, then `priority:low`, oldest
   first. Issues blocked by an open Gitea dependency wait.
2. **Claude implements it** on `claude/<n>-<slug>` and commits. The dispatcher
   pushes and opens a PR (or a stack of PRs for larger work; only the top one
   says `Closes #n`). PR descriptions list the decisions Claude made on its own.
3. **CI decides.** When the bottom PR's CI is green it is merged with the
   repo's default merge style (or `MERGE_STYLE`). Red CI starts a fix round
   with the failing job logs; requested changes start a review round. Rounds
   are capped by `MAX_FIX_ATTEMPTS` per PR, and a round that commits nothing
   stops instead of looping.
4. **Done.** After the last PR merges the issue is closed and the next
   assigned issue is picked up.

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
questions, and the dispatcher files each one as an issue labeled
`claude:question`, assigned to `HUMAN_REVIEWER`:

- **Decisions to confirm** (`Confirm decision on #n: …`): work continued with
  Claude's choice. Reply if it should change.
- **Follow-ups** (`Question from #n: …`): things noticed but out of scope.
- **Blocking questions**: Claude can't continue safely. The issue becomes
  `claude:blocked` and depends on the question. Work resumes, in the same
  Claude session with your answer, as soon as you comment on the question
  (as `HUMAN_REVIEWER`) or close it. Closing without a reply means "go with
  your recommendation". Comments from anyone else are not passed to Claude.

The same question is never filed twice for an issue.

## Steering

| You want to…                       | Do this                                                       |
| ---------------------------------- | ------------------------------------------------------------- |
| Merge a PR now, whatever CI says   | Comment `/merge` on the PR (as `HUMAN_REVIEWER`)              |
| Ask for changes                    | Submit a "request changes" review on the PR's latest commit   |
| Stop work on an issue              | Unassign the bot or close the issue (open PRs are left alone) |
| Answer a blocking question         | Comment on the question issue, or close it                    |
| Retry a blocked issue from scratch | Remove the `claude:blocked` label                             |
| Prioritize                         | Add `priority:high` or `priority:low`                         |

When the bot needs you it labels the issue `claude:blocked` and mentions
`HUMAN_REVIEWER` in a comment explaining why.
