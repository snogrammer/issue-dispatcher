# Operating the dispatcher

## Dashboard

The same server hosts a web dashboard at `/`: health, held work, runs and
costs, live logs, and the runtime config, which can be edited without a
restart. See [dashboard.md](dashboard.md).

## Health and status

A small HTTP server (`STATUS_PORT`, default `8080`, bound to `STATUS_HOST`,
default `127.0.0.1`; `STATUS_PORT=0` turns it off) answers two read-only
endpoints, alongside the [dashboard](dashboard.md):

- `GET /healthz`: `200` while the poll loop is alive, `503` once it hasn't
  finished a pass in 3 × `POLL_INTERVAL_S`. Use it as the container
  healthcheck; a restart is safe, because in-flight work resumes from Gitea
  labels and the saved Claude session.
- `GET /status`: JSON with the watched repos, the configured repos it
  isn't watching and why (`skippedRepos`), each held issue (state, branch,
  PRs, fix rounds), runs in progress and the session cap, pauses (usage limit,
  pickups, CI backpressure), cost totals for the last 24 hours, 7 days and all
  time (per repo), and the 20 most recent runs with model, effort, outcome and
  cost.

`/healthz` is open, for healthchecks. `/status` needs the dashboard token
(`Authorization: Bearer $DASHBOARD_TOKEN`) or a dashboard session, and answers
`401` otherwise; it shows repo names, issue numbers and costs, never tokens.
Set `STATUS_HOST=0.0.0.0` only if it should be reachable from outside the
container.

```sh
curl -H "Authorization: Bearer $DASHBOARD_TOKEN" http://127.0.0.1:8080/status
```

## Logs

One JSON object per line on stdout (`LOG_LEVEL`, default `info`). Each run
logs its repo, issue, phase, model, effort, outcome and cost. The Gitea token,
the dashboard token and Claude credentials are replaced with `[redacted]`
wherever they appear, including inside error messages. The last 1,000 lines
are also kept in memory for the dashboard's Logs page. Every change made from
the dashboard is logged with `"dashboard": true`.

Portainer's log viewer re-formats JSON lines and can show the same timestamp
and message many times over. `docker logs <container>` shows the raw lines.

## Error reporting

Set `SENTRY_DSN` to send errors to Sentry; without it the SDK isn't loaded.
What gets sent:

- every `error` and `fatal` log line, as an exception when it carries one
  (reconcile and run failures, Claude auth problems, dashboard 500s), with
  `repo`, `issue`, `pr` and `phase` as tags and the rest of the line as the
  `log` context;
- uncaught exceptions, unhandled rejections and startup failures;
- `warn` lines, as breadcrumbs on the next event rather than events of their own.

Every event identifies its sender, so several services can share one Sentry
org or project:

| Field                    | Value                                                        |
| ------------------------ | ------------------------------------------------------------ |
| `environment`            | `SENTRY_ENVIRONMENT` (default `NODE_ENV`, else `production`) |
| `release`                | `<SENTRY_SERVICE_NAME>@<package version>`                    |
| `dist`, tag `commit`     | the image's `GIT_SHA`                                        |
| `server_name`            | `SENTRY_INSTANCE` (default: hostname)                        |
| tag `service`            | `SENTRY_SERVICE_NAME` (default `claude-dispatcher`)          |
| tags `bot`, `gitea_host` | `BOT_USERNAME` and the host of `GITEA_URL`                   |

The same secret values the logs redact (and the DSN) are scrubbed from every
event and breadcrumb, and request headers, bodies, cookies, query strings and
user data are not collected. No performance tracing is sent.

## The bot ignores an assigned issue

Check the dashboard's "Not watching" list (or `skippedRepos` in `/status`).
Repos are rediscovered every 5 minutes, and these are skipped:

- **empty** (no commits): there is no branch to work from. The bot comments
  once on each issue assigned to it there. Push an initial commit and the
  issue is picked up at the next rediscovery.
- **archived**: read-only, so nothing can be pushed or commented.
- **issues disabled**: the repo's issue tracker is turned off, so nothing can
  be assigned. Turn issues on in the repo's settings if the bot should work there.
- **label setup failed: …**: the bot couldn't create its labels (usually no
  write access). Fix the access; the repo is retried at the next rediscovery.
- **a lookup error** (e.g. `404`): the bot account can't see the repo; add it
  as a collaborator. A `403 ... required=[read:organization]` on `<org>/*`
  means the token lacks that scope: create a new token that includes it.

Each skip is logged once as `not watching repo`, and `repo no longer skipped`
when it clears. One unusable repo never stops the bot watching the others.

## An issue is blocked: "what comes after it failed"

The run did its work, but pushing the branch, opening the PR or filing
questions failed afterwards. The most common cause is that the bot can't push:
it needs **write** access to code, issues and pull requests in each repo it
works in. For org repos, that means a team with `Code: Write` (read-only code
lets it comment and label, but the push is rejected). Fix the access, then
remove the `claude:blocked` label to start the issue over.

An issue left `working` after a successful run (e.g. the dispatcher stopped
between the run and its push) is blocked the same way on the next poll rather
than run again, so a successful session is never repeated and re-billed.

## An issue is blocked: "checks didn't pass locally"

Claude's report listed checks that failed or couldn't run, so nothing was
pushed (CI is the confirmation, not the place to find failures). The comment
lists each check with Claude's note.

- **not run** usually means a missing toolchain. Pin the version in the repo
  (`.tool-versions`, `.python-version`, `.ruby-version`, `.node-version`); it's
  installed before the next run. Look for `toolchain install failed` in the
  logs if a pinned version didn't install (a compile error, or
  `TOOLCHAIN_INSTALL_TIMEOUT_MIN` too short). System libraries go in
  `EXTRA_APT_PACKAGES` (see [deploy.md](deploy.md#project-toolchains)).
- **failed** means Claude couldn't get it green. Look at the branch locally,
  or comment on the issue with guidance.

Then remove the `claude:blocked` label to start the issue over.

## An issue is blocked with a "Help needed" ticket

A PR used up its `MAX_FIX_ATTEMPTS` fix rounds (CI, review or rebase) on the
same problem. Rather than guess again, the dispatcher filed a
`claude:question` issue assigned to `HUMAN_REVIEWER`, with the failing jobs.
Reply there (work continues with your answer and fresh rounds) or close it
(Claude tries again on its own).

## "another dispatcher is using this data directory"

Each dispatcher holds a lease on its database, renewed every poll, so two
processes can never work the same issues. A second process sharing the data
directory (a second container, or `pnpm dev` pointed at the same `DATA_DIR`)
waits until the first stops. After a crash the lease goes stale and is taken
over after 5 polls (5 minutes by default). A running dispatcher whose lease was
taken over logs `another dispatcher took over this data directory` and stops
polling until it gets it back.

## Startup failures

Bad configuration, a wrong `BOT_USERNAME`, an unreachable Gitea, or a
`STATUS_PORT` already in use stop the process with a one-line
`startup failed: …` message and exit code 1.

With `restart: unless-stopped` that turns into a restart loop. Behind Caddy it
shows up as 502s with `lookup claude-dispatcher on 127.0.0.11:53: server
misbehaving`: Docker's DNS has no entry for a container that isn't running.
The proxy is fine; check `docker logs claude-dispatcher` for the startup error.
