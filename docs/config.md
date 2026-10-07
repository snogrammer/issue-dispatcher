# Configuration

The dispatcher reads environment variables and, optionally, a YAML file named by
`CONFIG_FILE`. Env values override the file, and values saved from the
[dashboard](dashboard.md#config) override both (file < env < dashboard).
Everything is validated at startup; an invalid value stops the process with a
message naming the key and the variable it came from.

Secrets (`GITEA_TOKEN`, `DASHBOARD_TOKEN`, `SENTRY_DSN`) are accepted **only** from env. Putting them in
the YAML file is an error. Empty variables count as unset.

## Environment variables

| Variable                      | Config key                  | Default                       | Notes                                                                                                                      |
| ----------------------------- | --------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `GITEA_URL`                   | `gitea.url`                 | required                      | `http(s)://` base URL of the Gitea instance; trailing slash removed                                                        |
| `GITEA_TOKEN`                 | `gitea.token`               | required                      | Token owned by the bot account. Secret: env only                                                                           |
| `BOT_USERNAME`                | `gitea.botUsername`         | required                      | Issues assigned to this user are picked up                                                                                 |
| `HUMAN_REVIEWER`              | `humanReviewer`             | required                      | Assignee for follow-up and question issues                                                                                 |
| `REPOS`                       | `repos`                     | `[]`                          | Comma-separated `owner/repo` list                                                                                          |
| `ORGS`                        | `orgs`                      | `[]`                          | Orgs whose repos are discovered; token needs `read:organization`. At least one of `REPOS`/`ORGS` is required               |
| `CONFIG_FILE`                 | —                           | unset                         | Path to an optional YAML config file                                                                                       |
| `LABEL_PREFIX`                | `labelPrefix`               | `claude`                      | Prefix for state labels (`claude:working`, …)                                                                              |
| `POLL_INTERVAL_S`             | `pollIntervalS`             | `60`                          | Seconds between reconcile passes (min 10)                                                                                  |
| `MAX_CONCURRENT_SESSIONS`     | `maxConcurrentSessions`     | `1`                           | Claude sessions running at once, across all repos                                                                          |
| `MAX_FIX_ATTEMPTS`            | `maxFixAttempts`            | `3`                           | CI/review fix rounds before asking the human                                                                               |
| `REQUIRE_CI`                  | `requireCi`                 | `true`                        | Never auto-merge a PR that reports no CI status. Accepts `true/false/1/0/yes/no/on/off`                                    |
| `MERGE_STYLE`                 | `mergeStyle`                | repo default                  | `merge`, `rebase`, `rebase-merge`, `squash` or `fast-forward-only`; unset uses each repo's default merge style             |
| `CI_MAX_QUEUE`                | `ciMaxQueue`                | `2`                           | Don't start Claude runs while this many Actions runs are queued or running across the watched repos                        |
| `CI_NO_STATUS_TIMEOUT_MIN`    | `ciNoStatusTimeoutMin`      | `15`                          | Minutes without any CI status before filing a question issue                                                               |
| `RATE_LIMIT_BACKOFF_BASE_MIN` | `rateLimit.backoffBaseMin`  | `15`                          | Pause after a usage limit with no reset time: this many minutes, doubling each time                                        |
| `RATE_LIMIT_BACKOFF_MAX_MIN`  | `rateLimit.backoffMaxMin`   | `300`                         | Cap for that backoff (must be ≥ the base)                                                                                  |
| `RATE_LIMIT_PICKUP_THRESHOLD` | `rateLimit.pickupThreshold` | `0.9`                         | Stop picking up new issues once a usage window is this full (0–1]; work in progress continues                              |
| `CLAUDE_BIN`                  | `claude.bin`                | `claude`                      | Claude Code executable                                                                                                     |
| `CLAUDE_TIMEOUT_MIN`          | `claude.timeoutMin`         | `60`                          | Wall-clock limit per Claude run                                                                                            |
| `CLAUDE_PERMISSION_MODE`      | `claude.permissionMode`     | `bypassPermissions`           | `bypassPermissions`, `acceptEdits`, `auto` or `dontAsk`. The default relies on the container being the sandbox (see below) |
| `CLAUDE_MAX_BUDGET_USD`       | `claude.maxBudgetUsd`       | unset                         | Per-run spending cap passed to `--max-budget-usd` (API-key billing)                                                        |
| `GIT_USER_NAME`               | `git.userName`              | `BOT_USERNAME`                | Commit author name in workspaces                                                                                           |
| `GIT_USER_EMAIL`              | `git.userEmail`             | `<bot>@noreply.<gitea host>`  | Commit author email in workspaces                                                                                          |
| `CLAUDE_MODEL`                | `routing.default.model`     | CLI default                   | Global default model (alias or full ID)                                                                                    |
| `CLAUDE_EFFORT`               | `routing.default.effort`    | CLI default                   | One of `low`, `medium`, `high`, `xhigh`, `max`                                                                             |
| `CLAUDE_MAX_TURNS`            | `routing.default.maxTurns`  | `100`                         | Global default turn limit per run                                                                                          |
| `MODEL_LABELS`                | `routing.modelLabels`       | `opus,sonnet,haiku`           | Models offered as `model:<name>` issue labels, plus any model named in routing rules                                       |
| `WORKSPACE_DIR`               | `paths.workspaceDir`        | `./workspaces`                | Repo checkouts; resolved to an absolute path                                                                               |
| `DATA_DIR`                    | `paths.dataDir`             | `./data`                      | SQLite state; resolved to an absolute path                                                                                 |
| `LOG_LEVEL`                   | `logLevel`                  | `info`                        | `trace`, `debug`, `info`, `warn`, `error`, `fatal`                                                                         |
| `STATUS_PORT`                 | `status.port`               | `8080`                        | Port for `/healthz` and `/status`; `0` turns the server off                                                                |
| `STATUS_HOST`                 | `status.host`               | `127.0.0.1`                   | Address to bind; use `0.0.0.0` to reach `/status` from outside the container                                               |
| `DASHBOARD_TOKEN`             | `dashboard.token`           | unset                         | Logs in to the [dashboard](dashboard.md) and `/status` (16+ characters). Unset: locked. Secret: env only                   |
| `DASHBOARD_HOME_URL`          | `dashboard.homeUrl`         | unset                         | http(s) link shown on the dashboard's landing page and sidebar (a blog, GitHub profile, …)                                 |
| `SENTRY_DSN`                  | `sentry.dsn`                | unset                         | Turns on [error reporting](operations.md#error-reporting) to Sentry. Secret: env only                                      |
| `SENTRY_ENVIRONMENT`          | `sentry.environment`        | `NODE_ENV`, else `production` | Sentry environment, e.g. `prod`, `staging`                                                                                 |
| `SENTRY_SERVICE_NAME`         | `sentry.serviceName`        | `claude-dispatcher`           | `service` tag and release prefix (`<name>@<version>`), to tell services apart in a shared org                              |
| `SENTRY_INSTANCE`             | `sentry.instance`           | hostname                      | Sentry server name; tells hosts or replicas apart (in Docker the hostname is the container ID)                             |

Claude Code authentication (`CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`) is
not part of the dispatcher's config; it is inherited by the `claude` process.
Dispatcher secrets (`GITEA_TOKEN`) are removed from that process's environment,
and the workspace holds no Git credentials while Claude runs: the dispatcher
fetches before and pushes after each run.

`CLAUDE_PERMISSION_MODE=bypassPermissions` lets Claude run commands (tests,
builds, git) without approval. That is only reasonable because the dispatcher
is meant to run in an isolated container with no Docker socket and no
credentials beyond Claude's own. Use `acceptEdits` or `dontAsk` with an
allow-list in the repo's `.claude/settings.json` if that doesn't hold.

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
  modelLabels: [opus, sonnet, haiku] # offered as model:<name> labels (MODEL_LABELS)
```

Each route entry accepts `model`, `effort` and `maxTurns`, all optional.

### How a run's model, effort and turn limit are chosen

Each layer overrides the ones before it, field by field:

1. `routing.default` (and `CLAUDE_MODEL` / `CLAUDE_EFFORT` / `CLAUDE_MAX_TURNS`)
2. `routing.phases.<phase>`: `implement`, `fix-ci`, `address-review` or `rebase`
3. `routing.repos.<owner/repo>`
4. Issue labels: `model:<name>` and `effort:<level>`

With the example above:

| Run                                      | Model    | Effort      | Why                                                        |
| ---------------------------------------- | -------- | ----------- | ---------------------------------------------------------- |
| CI fix in another repo                   | `sonnet` | CLI default | global default; no phase rule for `fix-ci`                 |
| Rebase in another repo                   | `haiku`  | `low`       | phase rule                                                 |
| CI fix in `example-org/critical-service` | `opus`   | `max`       | repo rule                                                  |
| Same, issue labeled `model:haiku`        | `haiku`  | `max`       | label overrides the model; effort still from the repo rule |

A `model:` label only applies if the model is configured (in `MODEL_LABELS`
or named somewhere in `routing`), and an `effort:` label only with a level the
CLI accepts. Unknown values, or two different labels of the same kind, are
ignored and logged as a warning, so the run falls back to the layers below.
Anything left unset uses the Claude Code CLI's own default. The chosen model,
effort and turn limit are recorded with each run.

The labels these settings produce are listed in [labels.md](labels.md).
