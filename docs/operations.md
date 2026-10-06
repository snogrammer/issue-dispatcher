# Operating the dispatcher

## Dashboard

The same server hosts a web dashboard at `/`: health, held work, runs and
costs, live logs, and the runtime config, which can be edited without a
restart. See [dashboard.md](dashboard.md).

## Health and status

A small HTTP server (`STATUS_PORT`, default `8080`, bound to `STATUS_HOST`,
default `127.0.0.1`; `STATUS_PORT=0` turns it off) answers two read-only
endpoints:

- `GET /healthz`: `200` while the poll loop is alive, `503` once it hasn't
  finished a pass in 3 × `POLL_INTERVAL_S`. Use it as the container
  healthcheck; a restart is safe, because in-flight work resumes from Gitea
  labels and the saved Claude session.
- `GET /status`: JSON with the watched repos, each held issue (state, branch,
  PRs, fix rounds), runs in progress and the session cap, pauses (usage limit,
  pickups, CI backpressure), cost totals for the last 24 hours, 7 days and all
  time (per repo), and the 20 most recent runs with model, effort, outcome and
  cost.

`/status` shows repo names, issue numbers and costs, never tokens. Set
`STATUS_HOST=0.0.0.0` only if it should be reachable from outside the
container.

## Logs

One JSON object per line on stdout (`LOG_LEVEL`, default `info`). Each run
logs its repo, issue, phase, model, effort, outcome and cost. The Gitea token,
the dashboard token and Claude credentials are replaced with `[redacted]`
wherever they appear, including inside error messages. The last 1,000 lines
are also kept in memory for the dashboard's Logs page. Every change made from
the dashboard is logged with `"dashboard": true`.

## Startup failures

Bad configuration, a wrong `BOT_USERNAME`, an unreachable Gitea, or a
`STATUS_PORT` already in use stop the process with a one-line
`startup failed: …` message and exit code 1.
