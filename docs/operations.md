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
  labels and the saved Claude session. It also reports the running build's
  `commit` (the image's `GIT_SHA`, `null` for unstamped builds), which the
  Coolify deploy waits on.
- `GET /status`: JSON with the watched repos, the configured repos it
  isn't watching and why (`skippedRepos`), each held issue (state, branch,
  PRs, fix rounds), runs in progress and the session cap, pauses (usage limit or
  failed auth, told apart by `pauses.reason`; pickups; CI backpressure), cost totals for the last 24 hours, 7 days and all
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

Coolify's and Portainer's log viewers re-format JSON lines (Portainer's can
show the same timestamp and message many times over). `docker logs <container>`
on the host shows the raw lines.

## Error reporting

Set `SENTRY_DSN` to send errors to Sentry, or to any server that accepts the
Sentry SDK's events, such as self-hosted [Bugsink](https://www.bugsink.com/)
(use the DSN of a Bugsink project). Without it the SDK isn't loaded.
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
user data are not collected. No performance tracing is sent, which suits
Bugsink: it stores errors only and drops other event types.

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

## "Claude Code can't authenticate"

Claude Code rejected its credentials: the token is missing, expired or revoked,
or it didn't survive a move to a new server (`Failed to authenticate. API
Error: 401 OAuth access token is invalid.`). That is never the issue's fault,
so the dispatcher doesn't block it. It pauses **all** runs, keeps the issue's
state and session, comments `Paused: Claude Code can't authenticate…` on it
once, and shows a "Claude Code can't authenticate" banner on the dashboard. The
pause backs off like a usage limit with no reset time (`RATE_LIMIT_BACKOFF_*`).

To fix it, run `claude setup-token` somewhere you can log in, put the new token
in `CLAUDE_CODE_OAUTH_TOKEN` (on Coolify: the resource's environment), and
redeploy. A restart lifts an auth pause straight away, so the paused issue
resumes on the first poll instead of waiting out the backoff. **Clear pause**
on the dashboard retries without a restart.

Before #66, the `401 OAuth access token is invalid` wording wasn't recognised,
and the issue was blocked with `The implement run failed (error): Failed to
authenticate…`. Once the token works, remove `claude:blocked` from those issues
to start them over.

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
  A check that needs a database or cache (Postgres, Redis) needs it running
  and listed in `TEST_SERVICES` (see [deploy.md](deploy.md#test-services)).
- **failed** means Claude couldn't get it green. Look at the branch locally,
  or comment on the issue with guidance.

Then remove the `claude:blocked` label to start the issue over.

## An issue is blocked with a "Help needed" ticket

A PR used up its `MAX_FIX_ATTEMPTS` fix rounds (CI, review or rebase) on the
same problem. Rather than guess again, the dispatcher added a blocking item
with the failing jobs to the issue's `Questions for #n` issue, assigned to
`HUMAN_REVIEWER`. Reply there (work continues with your answer and fresh
rounds) or close it (Claude tries again on its own).

## Old per-question issues

Before the questions issue, the dispatcher filed one `claude:question` issue
per question (`Question from #n: …`, `Confirm decision on #n: …`). To fold the
open ones into one questions issue per ticket, run this where the dispatcher
runs (it uses the same config):

```sh
node dist/squash-questions.js owner/repo          # dry run: prints the issues it would file
node dist/squash-questions.js owner/repo --apply  # files them, closes the old ones
```

An open blocking question carries over: the new issue blocks the ticket in
its place, and replying there resumes work as usual.

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
