# Labels

On startup the dispatcher makes sure every watched repo has the labels below.
It only adds labels: one that already exists with the same name is left as
the repo owner configured it (color, description). Names match exactly.

`claude` stands for `LABEL_PREFIX`.

## State (set by the dispatcher)

| Label              | Meaning                                               |
| ------------------ | ----------------------------------------------------- |
| `claude:working`   | Claude is implementing the issue                      |
| `claude:in-review` | PRs are open; waiting on CI or review                 |
| `claude:blocked`   | Waiting on a human answer; the repo's slot stays held |

These labels are how the dispatcher's state survives restarts: on startup it
rebuilds from them. Avoid adding or removing them by hand on an issue the bot
is working on. To stop work, unassign the bot instead.

## Questions (set by the dispatcher)

| Label             | Meaning                                                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude:question` | The one questions issue per worked issue: questions, follow-ups and decisions to confirm, for `HUMAN_REVIEWER` (see [workflow.md](workflow.md#questions)). Never picked up as work |

## Routing (set by you)

| Label            | Meaning                                                                                                            |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| `model:<name>`   | Run Claude on this issue with that model. One label per model in `MODEL_LABELS` plus models named in routing rules |
| `effort:<level>` | Run with that effort: `low`, `medium`, `high`, `xhigh`, `max`                                                      |

## Priority (set by you)

| Label           | Meaning                                |
| --------------- | -------------------------------------- |
| `priority:high` | Picked up before other assigned issues |
| `priority:low`  | Picked up after other assigned issues  |

Issues without a priority label are picked up oldest first, between the two.
