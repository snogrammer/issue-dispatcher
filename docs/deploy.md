# Deploying with Docker

The image bundles Node 22, git, the Claude Code CLI and the dispatcher. It
runs as a non-root user with `tini` as PID 1 (so processes left behind by a
timed-out Claude run are reaped) and has a healthcheck on `/healthz`.

## Run it

```sh
cp stack.env.example stack.env   # fill in Gitea, bot token, repos, Claude auth
docker compose up -d --build
docker compose logs -f dispatcher
```

`stack.env` holds secrets and is gitignored. Before the first run, set up the
bot account in Gitea (a non-admin user with write access to the watched repos,
a token it owns with `write:repository`, `write:issue` and `read:user`, and
branch protection that lets it merge on green CI without an approval).

State lives in two named volumes: `dispatcher-data` (SQLite) and
`dispatcher-workspaces` (repo checkouts). Both can be deleted: state is rebuilt
from Gitea labels and checkouts are re-cloned.

## Claude Code

- **Auth**: set `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`, uses a
  Claude subscription) or `ANTHROPIC_API_KEY` in `stack.env`. If neither
  works, the dispatcher pauses all runs and says so on the issue instead of
  failing them.
- **Version**: the image installs the `stable` release. Pin or upgrade with
  `CLAUDE_CODE_VERSION=2.1.285 docker compose build`. The CLI's self-updater
  is disabled; rebuild to upgrade.
- **Settings**: the image has no user-level Claude Code settings, plugins or
  hooks. A repo's own `.claude/` settings and `CLAUDE.md` still apply.

## Project toolchains

Claude runs each repo's tests inside this container, so it needs the repo's
toolchain. Node and pnpm/npm/yarn (via corepack) are included. For more:

- small additions: `EXTRA_APT_PACKAGES="python3 python3-venv make" docker compose build`
- anything bigger: build your own image `FROM claude-dispatcher:local` and set
  `image:` in compose.

Throwaway Postgres and Redis for test suites are available on the same
network (`postgres:5432`, `redis:6379`):

```sh
docker compose --profile test-services up -d
```

## Security

Claude runs project commands without approval prompts
(`CLAUDE_PERMISSION_MODE=bypassPermissions`), so the container is the sandbox:

- **No Docker socket.** Don't mount it; it would give Claude control of the host.
- Its own bridge network, a memory limit (`DISPATCHER_MEMORY_LIMIT`, default `4g`).
- The Gitea token is never in Claude's environment or in `.git/config`; git
  gets it only while the dispatcher fetches or pushes.
- Issue and comment text is treated as untrusted input to Claude, but a
  determined prompt injection could still run commands in the container. Keep
  it free of credentials beyond the bot token and Claude's own.

## Status

`/healthz` and `/status` listen on `127.0.0.1:8080` inside the container (see
[operations.md](operations.md)). To reach `/status` from the host, set
`STATUS_HOST=0.0.0.0` and uncomment the `ports:` entry in `docker-compose.yml`.

## Trying it locally

`scripts/dev-gitea.sh up` starts a throwaway Gitea on `127.0.0.1:13000` with a
bot user and a `dev/demo` repo, writes `stack.env` and starts the dispatcher
against it. `scripts/dev-gitea.sh down` removes everything.
