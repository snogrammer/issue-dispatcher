# Dashboard

IssueDispatcher serves a web dashboard from the same server as `/healthz` and
`/status` (`STATUS_PORT`, default `8080`). Open `http://<host>:8080/`.

It binds to `STATUS_HOST`, `127.0.0.1` by default, so it's only reachable
from inside the container. The Coolify and Portainer compose files set
`STATUS_HOST=0.0.0.0` for their proxies (see [deploy.md](deploy.md#status)); for the
local compose stack, set it in `.env` and publish the port yourself. If it's reachable beyond localhost, put it
behind a reverse proxy with HTTPS. The session cookie gets `Secure` when the
proxy sends `X-Forwarded-Proto: https`.

## Pages

| Page             | What it shows                                                                                                                                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Overview**     | Health and last poll, sessions in use, pause banners (usage limit, near-limit, manual pause, CI backed up), runs in progress, held work, the queue of assigned tickets still waiting, cost tiles, recent runs, repos |
| **Work**         | Each issue the bot holds: state, branch, PR stack, fix rounds. Click an issue for its run timeline, with model, effort, outcome, cost, tokens and errors                                                             |
| **Runs & costs** | Daily cost chart, cost by repo and by model for 7/30/90 days, and the full run history filtered by repo, phase, outcome or model                                                                                     |
| **Config**       | Every runtime setting with its current value and where it comes from (default, file, env, dashboard), editable. Read-only settings are listed below                                                                  |
| **Logs**         | The last 1,000 log lines, then live as they're written. Filter by level or text, pause, clear                                                                                                                        |

Overview and Work refresh every 5 seconds. Issue, PR and repo names link to
Gitea.

## Logging in

Everything on the dashboard needs a login. A visitor without a session gets a
landing page with the logo, a token field and, if `DASHBOARD_HOME_URL` is set,
a link back to it (your blog, GitHub profile, …). Nothing else answers: other
pages redirect to the landing page, `/status` and the API answer `401`. Only
`/healthz` stays open, for the container healthcheck.

- `DASHBOARD_TOKEN` unset (the default): the dashboard is locked. The landing
  page says login is disabled.
- Set (16+ characters, e.g. `openssl rand -hex 24`): enter the token on the
  landing page. The browser gets an HttpOnly, `SameSite=Strict` cookie derived
  from the token (not the token itself), valid for 30 days, and lands on the
  page it asked for (`/#/runs` stays `/#/runs`). Rotating the token logs
  everyone out; an open dashboard goes back to the landing page on its next
  request.

Scripts can send `Authorization: Bearer <token>` instead, for reads and
writes alike:

```sh
curl -H "Authorization: Bearer $DASHBOARD_TOKEN" http://127.0.0.1:8080/status
curl -X POST -H "Authorization: Bearer $DASHBOARD_TOKEN" http://127.0.0.1:8080/api/actions/poll-now
```

Writes made with the cookie must come from the dashboard's own origin. Ten
failed logins in a minute lock logins for the rest of that minute. Every change
is logged with `"dashboard": true`.

## Analytics

Off by default. Set `PLAUSIBLE_SCRIPT_URL` to a [Plausible](https://plausible.io/)
tracking script, from plausible.io or a self-hosted Community Edition, and
every dashboard page, the landing page included, loads it:

- the per-site script from the site's installation settings, e.g.
  `https://plausible.example.com/js/pa-XXXXXXXX.js`; or
- the classic `https://plausible.example.com/js/script.js`, with
  `PLAUSIBLE_DOMAIN` set to the site's domain in Plausible.

The page's Content-Security-Policy then allows that script's origin for
scripts and requests, and nothing else. Plausible's snippet normally includes
an inline script, which the CSP forbids, so the dashboard sets up the same
`window.plausible` queue from its own code instead. Paste only the script URL,
not the snippet. The dashboard's pages are hash routes (`/#/runs`); to count
them apart, turn on hash-based routing in the site's script settings (or use
the classic `script.hash.js`).

## Actions

On the overview:

- **Pause pickups / Resume pickups**: a kill switch. While paused, no new
  issue is started. Work already in progress (runs, CI fixes, review rounds,
  merges) carries on. The pause is saved and survives restarts.
- **Poll now**: start a reconcile pass without waiting for `POLL_INTERVAL_S`.
- **Clear pause** (shown on the usage-limit and "Claude Code can't
  authenticate" banners): lift a usage-limit, near-limit or auth pause early
  and reset the backoff, e.g. after topping up credits or fixing credentials.
  If the problem is still there, the next run hits it and pauses again.

## Config

The Config page edits these settings, which apply to the running dispatcher
**without a restart**:

| Key                                                                                | Takes effect                                              |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `pollIntervalS`                                                                    | immediately (a poll starts, then the new interval)        |
| `maxConcurrentSessions`, `ciMaxQueue`                                              | next poll. Lowering the cap never stops a run in progress |
| `maxFixAttempts`, `requireCi`, `mergeStyle`, `ciNoStatusTimeoutMin`                | next poll                                                 |
| `rateLimit.backoffBaseMin`, `rateLimit.backoffMaxMin`, `rateLimit.pickupThreshold` | next run that reports usage                               |
| `claude.timeoutMin`, `claude.maxBudgetUsd`                                         | runs started afterwards                                   |
| `routing` (default, phases, repos, modelLabels) as JSON                            | runs started afterwards; new `model:` labels are created  |
| `repos`, `orgs`                                                                    | immediately (repos are rediscovered)                      |
| `logLevel`                                                                         | immediately                                               |

Values saved here are stored in the state database (`DATA_DIR`) and **override
env and the config file** (file < env < dashboard). Each one replaces the
whole value at its key: a saved `routing` replaces the file's routing table and
`CLAUDE_MODEL`. **Reset** removes an override so the key falls back to env, the
file or its default. A save is validated with the same rules as startup, and
nothing is saved or applied unless the whole config is valid.

These stay env/file-only and need a restart to change: the Gitea URL, bot,
token and human reviewer, the label prefix, paths, the status server, the
Claude binary and permission mode, the commit identity, and all secrets. They
change who the bot is, where its data lives, or how much it may do unattended,
which a dashboard session shouldn't be able to change.

If saved overrides stop being valid (for example, env changed underneath them),
the dispatcher logs a warning and starts without them. Saving from the
dashboard again replaces them.

## API

The dashboard uses a small JSON API, which is also usable from scripts with a
bearer token. Only the session, login and logout endpoints answer without one:

| Endpoint                                                                      | Notes                                                                                      |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /api/session`                                                            | Public. Logged out: whether login is enabled, home URL. Logged in: Gitea URL, bot, version |
| `POST /api/login` `{"token": …}`, `POST /api/logout`                          | Public. Session cookie                                                                     |
| `GET /api/runs?repo&phase&exit&model&limit&before`                            | Run history, newest first; `exit=running` for unfinished runs. Page with `before=<next>`   |
| `GET /api/costs?days=30`                                                      | Totals per day, repo and model                                                             |
| `GET /api/work/<owner>/<repo>/<issue>`                                        | One issue's work record and runs                                                           |
| `GET /api/config`, `PUT /api/config` `{"overrides": {…}}`                     | Config view; replace the override document                                                 |
| `POST /api/actions/{pause-pickups,resume-pickups,clear-usage-pause,poll-now}` | Control actions                                                                            |
| `GET /api/logs?limit`, `GET /api/logs/stream`                                 | Recent lines; live lines as server-sent events                                             |
