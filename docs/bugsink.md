# Bugsink auto-fix

The dispatcher can take error alerts from [Bugsink](https://www.bugsink.com/)
and turn each new Bugsink issue into a Gitea issue assigned to the bot. From
there it is ordinary work: the bot picks it up, opens a PR, and merges once CI
passes. When the fix merges, the dispatcher marks the Bugsink issue resolved.
If the error comes back, the issue is reopened once for another attempt. If it
comes back a second time, auto-fix for that issue is frozen and handed to
`HUMAN_REVIEWER`.

## Setup

1. Create a Bugsink API token with `issues:read`, `issues:triage` and
   `issues:comment`, and generate a webhook secret:

   ```sh
   openssl rand -hex 32
   ```

2. Set these on the dispatcher (see [configuration](config.md)) and redeploy:

   ```sh
   BUGSINK_URL=https://bugsink.example.com
   BUGSINK_API_TOKEN=...
   BUGSINK_WEBHOOK_SECRET=<the hex string>
   # <bugsink project id>=owner/repo, comma-separated
   BUGSINK_PROJECTS=5=VibeCo/claude-dispatcher,4=VibeCo/moonext
   ```

   The project ID is the number in the project's URL
   (`/projects/<id>/…`), or `id` in `GET /api/canonical/0/projects/`. The
   repos don't have to be in `REPOS`/`ORGS`, but the bot only works issues in
   repos it watches.

3. For each project, add an alert in Bugsink: **Project → Alerts → Add
   service → Custom webhook**, with the URL

   ```text
   https://<dispatcher host>/hooks/bugsink/<BUGSINK_WEBHOOK_SECRET>
   ```

   Bugsink must reach that URL over the public internet: by default it refuses
   webhook targets on private addresses. Use **Send test message**; the
   dispatcher logs `bugsink test alert`. Keep the project's "alert on new
   issue" and "alert on regression" switches on.

Bugsink can't sign its webhooks or add headers, so the secret path segment is
the only authentication. Treat the URL as a secret. A wrong secret answers 404,
just like a path that doesn't exist.

## What happens

| Bugsink says                                                           | Dispatcher does                                                                                                                                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New issue                                                              | Files `Bugsink: <title>` in the mapped repo with the error, the latest stacktrace and a link, labeled `bugsink` and assigned to the bot. Comments the Gitea link on the Bugsink issue |
| (the bot's fix PR merges)                                              | Resolves the Bugsink issue, retrying each poll until Bugsink answers                                                                                                                  |
| Regressed, up to `BUGSINK_MAX_REGRESSIONS` times (default 1)           | Reopens the Gitea issue, assigns the bot again and comments the new stacktrace                                                                                                        |
| Regressed again                                                        | **Freezes**: labels the issue `bugsink:frozen`, unassigns the bot, mutes the Bugsink issue and asks `HUMAN_REVIEWER`                                                                  |
| Anything else (an alert while a fix is in progress, an unmute, a test) | Nothing                                                                                                                                                                               |

Only a fix the bot merged resolves the Bugsink issue. If someone closes the
Gitea issue by hand, Bugsink is left alone.

To **unfreeze** an issue, remove `bugsink:frozen` and assign the bot again.
When that fix merges, the issue is resolved in Bugsink and the regression count
starts over. Unmute it in Bugsink as well, so that a later regression alerts
again.

To pause intake everywhere, set `BUGSINK_ENABLED=false` or switch it off on the
dashboard's Config page. Alerts are then acknowledged and ignored, and nothing
is filed for them later. Fixes already in progress still resolve their Bugsink
issues when they merge.

Links between Bugsink and Gitea issues live in the state database
(`bugsink_link`). Each filed issue's body also ends with a hidden
`<!-- bugsink:<uuid> -->` marker.
