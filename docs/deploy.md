# Deploying with Docker

The image bundles Node 22, git, the Claude Code CLI and the dispatcher. It
runs as a non-root user (uid 10001) with `tini` as PID 1 (so processes left
behind by a timed-out Claude run are reaped) and has a healthcheck on `/healthz`.

There are two compose files:

| File                           | For               | Image                    | Config      | State            |
| ------------------------------ | ----------------- | ------------------------ | ----------- | ---------------- |
| `docker-compose.yml`           | local development | built from the checkout  | `.env`      | named volumes    |
| `docker-compose.portainer.yml` | a Portainer stack | pulled from the registry | `stack.env` | host bind mounts |

Before the first run anywhere, set up the bot account in Gitea: a non-admin
user with write access to the watched repos, a token it owns with
`write:repository`, `write:issue` and `read:user`, and branch protection that
lets it merge on green CI without an approval.

## Local development

```sh
cp .env.example .env   # fill in Gitea, bot token, repos, Claude auth
docker compose up -d --build
docker compose logs -f dispatcher
```

This uses the same `.env` as `pnpm dev`. The compose file pins `DATA_DIR` and
`WORKSPACE_DIR` to the container's volumes, so the host paths in `.env` don't
apply inside the container. State lives in two named volumes:
`dispatcher-data` (SQLite) and `dispatcher-workspaces` (repo checkouts). Both
can be deleted: state is rebuilt from Gitea labels and checkouts are re-cloned.

Throwaway Postgres and Redis (alpine images, data in tmpfs) for test suites are
available on the same network (`postgres:5432`, `redis:6379`):

```sh
docker compose --profile test-services up -d
```

### Trying it against a throwaway Gitea

`scripts/dev-gitea.sh up` starts a Gitea on `127.0.0.1:13000` with a bot user
and a `dev/demo` repo, writes `.dev-gitea.env` (your `.env` is left alone) and
starts the dispatcher against it. Add Claude credentials to `.dev-gitea.env`
and run `scripts/dev-gitea.sh restart` for real runs.
`scripts/dev-gitea.sh down` removes everything.

## Portainer

Create a **git-backed stack** pointing at this repository with compose path
`docker-compose.portainer.yml`. Set the stack's environment variables from
[`stack.env.example`](../stack.env.example); Portainer writes them to the
`stack.env` the compose file reads. Besides the dispatcher's own settings, the
compose file needs:

| Variable                     | Purpose                                                          |
| ---------------------------- | ---------------------------------------------------------------- |
| `DISPATCHER_IMAGE`           | registry path, e.g. `registry.example.com/org/claude-dispatcher` |
| `DISPATCHER_TAG`             | tag to run (default `latest`; pin `v1.2.3` or a commit SHA)      |
| `DISPATCHER_DATA_PATH`       | host directory for state (SQLite)                                |
| `DISPATCHER_WORKSPACES_PATH` | host directory for repo checkouts                                |
| `DISPATCHER_MEMORY_LIMIT`    | container memory limit (default `4g`)                            |
| `SHARED_NETWORK`             | existing Docker network shared with Caddy (default `caddy_net`)  |
| `DISPATCHER_BIND_ADDR`       | host address for the dashboard port (default `127.0.0.1`)        |
| `DISPATCHER_HOST_PORT`       | host port for the dashboard (default `8080`)                     |

The dispatcher runs as uid 10001. The container starts as root only long
enough to take ownership of `/data` and `/workspaces` (so host directories
Docker creates owned by root just work), then drops to uid 10001.

If the registry is private, add it under Portainer's registries so the host can
pull the image.

Images before this change ran as uid 10001 from the start and exited with
`Data directory /data is not writable by uid 10001` (or, older still,
`SqliteError: unable to open database file`) on root-owned directories. If you
still see that, the host is running an old image. Check which build is
running: the `IssueDispatcher starting` log line has a `commit` field, or

```sh
docker inspect claude-dispatcher \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'
```

Then re-pull `:latest` and recreate the container (Portainer: the stack's
_Pull and redeploy_, with _Re-pull image_ on).

## Publishing

`.gitea/workflows/publish.yml` builds and pushes the image after CI passes on
`main`, and for `v*` tags. After a push from `main` it also redeploys the
Portainer stack (`deploy/portainer-redeploy.sh`) and waits for the
`claude-dispatcher` container to be healthy on the new image. Pull requests
never publish.

Configure it on the repository (or organisation):

| Kind   | Name                    | Purpose                                                              |
| ------ | ----------------------- | -------------------------------------------------------------------- |
| var    | `REGISTRY`              | registry host; without it nothing is built                           |
| var    | `IMAGE`                 | image path (default `claude-dispatcher`)                             |
| var    | `IMAGE_PLATFORMS`       | e.g. `linux/amd64 linux/arm64` (default `linux/amd64`)               |
| var    | `CLAUDE_CODE_VERSION`   | Claude Code dist-tag or version to bake in (default `stable`)        |
| var    | `PORTAINER_URL`         | e.g. `https://portainer.example.com`; without it there's no redeploy |
| var    | `PORTAINER_STACK_ID`    | the stack's ID (from its URL); without it there's no redeploy        |
| var    | `PORTAINER_ENDPOINT_ID` | Portainer environment ID (default `1`)                               |
| secret | `REGISTRY_USERNAME`     | registry login; also used for Portainer's git pull of the stack      |
| secret | `REGISTRY_PASSWORD`     | registry password or token                                           |
| secret | `PORTAINER_API_KEY`     | Portainer access token                                               |

Tags pushed: `:<sha>` (a multi-arch index), `:<sha>-<arch>` per platform, plus
`:latest` from `main` or `:<tag>` from a version tag. Layers are pushed with
`regctl` in 50 MiB chunks so a registry behind Cloudflare's 100 MB request cap
accepts them.

A redeploy restarts the dispatcher, possibly mid-run. That is safe: shutdown
stops in-flight Claude runs, and on startup the dispatcher rebuilds its state
from issue labels and resumes them.

## Claude Code

- **Auth**: set `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`, uses a
  Claude subscription) or `ANTHROPIC_API_KEY`. If neither works, the
  dispatcher pauses all runs and says so on the issue instead of failing them.
- **Version**: the image installs the `stable` release. Locally, pin or
  upgrade with `CLAUDE_CODE_VERSION=2.1.285 docker compose build`; for
  published images set the `CLAUDE_CODE_VERSION` var. The CLI's self-updater
  is disabled; rebuild to upgrade.
- **Settings**: the image has no user-level Claude Code settings, plugins or
  hooks. A repo's own `.claude/` settings and `CLAUDE.md` still apply.

## Project toolchains

Claude runs each repo's tests inside this container, so it needs the repo's
toolchain. Node and pnpm/npm/yarn (via corepack) are included. For more:

- small additions: `EXTRA_APT_PACKAGES="python3 python3-venv make" docker compose build`
- anything bigger: build your own image `FROM` this one and set `image:` in
  compose (or `DISPATCHER_IMAGE` for Portainer).

## Security

Claude runs project commands without approval prompts
(`CLAUDE_PERMISSION_MODE=bypassPermissions`), so the container is the sandbox:

- **No Docker socket.** Don't mount it; it would give Claude control of the host.
- A memory limit (`DISPATCHER_MEMORY_LIMIT`, default `4g`). The Portainer
  stack joins the shared Caddy network (`SHARED_NETWORK`, default `caddy_net`),
  so Claude can reach other containers on it; keep that network to services
  that are safe to expose to it.
- The Gitea token is never in Claude's environment or in `.git/config`; git
  gets it only while the dispatcher fetches or pushes.
- Issue and comment text is treated as untrusted input to Claude, but a
  determined prompt injection could still run commands in the container. Keep
  it free of credentials beyond the bot token and Claude's own.

## Status

`/healthz`, `/status` and the [dashboard](dashboard.md) are served on port
8080 (see [operations.md](operations.md)). The Portainer compose file sets
`STATUS_HOST=0.0.0.0` and publishes the port on
`${DISPATCHER_BIND_ADDR}:${DISPATCHER_HOST_PORT}` (default `127.0.0.1:8080`).
A Caddy container on the shared network proxies to `claude-dispatcher:8080`; a
Caddy on the host proxies to `127.0.0.1:8080`. Without a session, visitors
see only a landing page (and `/healthz`); set `DASHBOARD_TOKEN` to be able to
log in, optionally `DASHBOARD_HOME_URL` for the landing page's link, and put it
behind HTTPS (a reverse proxy) if it's reachable beyond localhost.
