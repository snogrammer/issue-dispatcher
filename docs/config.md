# Configuration

The dispatcher reads environment variables and, optionally, a YAML file named by
`CONFIG_FILE`. Env values override the file. Everything is validated at startup;
an invalid value stops the process with a message naming the key and the
variable it came from.

Secrets (currently `GITEA_TOKEN`) are accepted **only** from env. Putting them in
the YAML file is an error. Empty variables count as unset.

## Environment variables

| Variable                   | Config key                 | Default        | Notes                                                                                       |
| -------------------------- | -------------------------- | -------------- | ------------------------------------------------------------------------------------------- |
| `GITEA_URL`                | `gitea.url`                | required       | `http(s)://` base URL of the Gitea instance; trailing slash removed                         |
| `GITEA_TOKEN`              | `gitea.token`              | required       | Token owned by the bot account. Secret: env only                                            |
| `BOT_USERNAME`             | `gitea.botUsername`        | required       | Issues assigned to this user are picked up                                                  |
| `HUMAN_REVIEWER`           | `humanReviewer`            | required       | Assignee for follow-up and question issues                                                  |
| `REPOS`                    | `repos`                    | `[]`           | Comma-separated `owner/repo` list                                                           |
| `ORGS`                     | `orgs`                     | `[]`           | Comma-separated orgs whose repos are discovered. At least one of `REPOS`/`ORGS` is required |
| `CONFIG_FILE`              | —                          | unset          | Path to an optional YAML config file                                                        |
| `LABEL_PREFIX`             | `labelPrefix`              | `claude`       | Prefix for state labels (`claude:working`, …)                                               |
| `POLL_INTERVAL_S`          | `pollIntervalS`            | `60`           | Seconds between reconcile passes (min 10)                                                   |
| `MAX_CONCURRENT_SESSIONS`  | `maxConcurrentSessions`    | `1`            | Claude sessions running at once, across all repos                                           |
| `MAX_FIX_ATTEMPTS`         | `maxFixAttempts`           | `3`            | CI/review fix rounds before asking the human                                                |
| `REQUIRE_CI`               | `requireCi`                | `true`         | Never auto-merge a PR that reports no CI status. Accepts `true/false/1/0/yes/no/on/off`     |
| `CI_MAX_QUEUE`             | `ciMaxQueue`               | `2`            | Defer pushes while queued + running Actions runs exceed this                                |
| `CI_NO_STATUS_TIMEOUT_MIN` | `ciNoStatusTimeoutMin`     | `15`           | Minutes without any CI status before filing a question issue                                |
| `CLAUDE_BIN`               | `claude.bin`               | `claude`       | Claude Code executable                                                                      |
| `CLAUDE_TIMEOUT_MIN`       | `claude.timeoutMin`        | `60`           | Wall-clock limit per Claude run                                                             |
| `CLAUDE_MODEL`             | `routing.default.model`    | CLI default    | Global default model (alias or full ID)                                                     |
| `CLAUDE_EFFORT`            | `routing.default.effort`   | CLI default    | One of `low`, `medium`, `high`, `xhigh`, `max`                                              |
| `CLAUDE_MAX_TURNS`         | `routing.default.maxTurns` | `100`          | Global default turn limit per run                                                           |
| `WORKSPACE_DIR`            | `paths.workspaceDir`       | `./workspaces` | Repo checkouts; resolved to an absolute path                                                |
| `DATA_DIR`                 | `paths.dataDir`            | `./data`       | SQLite state; resolved to an absolute path                                                  |
| `LOG_LEVEL`                | `logLevel`                 | `info`         | `trace`, `debug`, `info`, `warn`, `error`, `fatal`                                          |

Claude Code authentication (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`) is
not part of the dispatcher's config; it is inherited by the `claude` process.

## YAML file

Any config key can be set in the file using the keys above (camelCase, nested).
Unknown keys are rejected so typos fail at startup. Routing rules can only be
expressed in the file:

```yaml
pollIntervalS: 120
routing:
  default: # global fallback (CLAUDE_MODEL / CLAUDE_EFFORT / CLAUDE_MAX_TURNS override these)
    model: sonnet
    maxTurns: 100
  phases: # per phase of work: implement, fix-ci, address-review, rebase
    implement: { model: opus, effort: high }
    rebase: { model: haiku, effort: low }
  repos: # per repository
    example-org/critical-service: { model: opus, effort: max }
```

Each route entry accepts `model`, `effort` and `maxTurns`, all optional. How the
layers combine with issue labels at run time is described with the routing
feature.
