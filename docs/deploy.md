# Deploying with Docker

The image bundles Node 22, git, the Claude Code CLI, the dispatcher, and
[project toolchains](#project-toolchains) (asdf with Python and Ruby, uv). It
runs as a non-root user (uid 10001) with `tini` as PID 1 (so processes left
behind by a timed-out Claude run are reaped) and has a healthcheck on `/healthz`.

There are three compose files:

| File                           | For                                | Image                    | Config                  | State            |
| ------------------------------ | ---------------------------------- | ------------------------ | ----------------------- | ---------------- |
| `docker-compose.yml`           | local development                  | built from the checkout  | `.env`                  | named volumes    |
| `docker-compose.coolify.yml`   | a Coolify resource (the default)   | pulled from the registry | the resource's env vars | host bind mounts |
| `docker-compose.portainer.yml` | a Portainer stack (an alternative) | pulled from the registry | `stack.env`             | host bind mounts |

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
apply inside the container. State lives in named volumes: `dispatcher-data`
(SQLite), `dispatcher-workspaces` (repo checkouts) and `dispatcher-toolchains`
(language versions). All can be deleted: state is rebuilt from Gitea labels,
checkouts are re-cloned, and toolchains are re-seeded from the image and
reinstalled on demand.

Postgres and Redis for test suites start with it (see
[Test services](#test-services)).

### Trying it against a throwaway Gitea

`scripts/dev-gitea.sh up` starts a Gitea on `127.0.0.1:13000` with a bot user
and a `dev/demo` repo, writes `.dev-gitea.env` (your `.env` is left alone) and
starts the dispatcher against it. Add Claude credentials to `.dev-gitea.env`
and run `scripts/dev-gitea.sh restart` for real runs.
`scripts/dev-gitea.sh down` removes everything.

## Coolify

1. Create the network the dispatcher shares with Gitea, once per host:
   `docker network create gitea_internal` (or another name, set as
   `GITEA_NETWORK`). If Gitea runs in Coolify on the same host, add it to that
   network with the alias `gitea` so `GITEA_URL` can stay at its default,
   `http://gitea:3000`. If Gitea runs elsewhere, leave the network empty and
   set `GITEA_URL` to its public URL.
2. Add a **Docker Compose (Empty)** resource and paste
   [`docker-compose.coolify.yml`](../docker-compose.coolify.yml) into it.
3. Set its environment variables from
   [`coolify.env.example`](../coolify.env.example) (the Developer view takes
   the whole file). Generate `TEST_POSTGRES_PASSWORD` with
   `openssl rand -hex 16`.
4. Set the `dispatcher` service's domain to `https://<host>:8080`. Coolify's
   proxy routes the domain to the container's port 8080; nothing is published
   on the host.
5. Deploy. For redeploys from CI, note the resource's UUID (in its URL) and
   create an API token under _Keys & Tokens_ (see [Publishing](#publishing)).

Besides the dispatcher's own settings, the compose file needs:

| Variable                     | Purpose                                                          |
| ---------------------------- | ---------------------------------------------------------------- |
| `DISPATCHER_IMAGE`           | registry path, e.g. `registry.example.com/org/claude-dispatcher` |
| `DISPATCHER_TAG`             | tag to run (default `latest`; pin `v1.2.3` or a commit SHA)      |
| `DISPATCHER_DATA_PATH`       | host directory for state (SQLite)                                |
| `DISPATCHER_WORKSPACES_PATH` | host directory for repo checkouts                                |
| `DISPATCHER_CPUS`            | CPU limit (default `2`)                                          |
| `DISPATCHER_MEMORY_LIMIT`    | memory limit (default `4g`)                                      |
| `GITEA_NETWORK`              | existing network shared with Gitea (default `gitea_internal`)    |
| `TEST_POSTGRES_PASSWORD`     | password of the test Postgres                                    |

The dispatcher also gets a low CPU weight, a raised OOM score and
`no-new-privileges`, so a heavy run gives way to other services on the host.
The [test services](#test-services) are named `dispatcher-postgres` and
`dispatcher-redis`, reachable from the dispatcher as `postgres` and `redis`.

If the registry is private, add its credentials to the Coolify server
(`docker login` on the host) so it can pull the image.

## Portainer

The alternative to Coolify. Create a **git-backed stack** pointing at this repository with compose path
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

Language versions live in a named volume (`toolchains`), not a bind mount:
Docker seeds a new named volume from the image's preloaded versions, and
compiled Python and Ruby only work at the path they were built for.

The dispatcher runs as uid 10001. The container starts as root only long
enough to take ownership of `/data`, `/workspaces` and `/toolchains` (so host directories
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
`main`, and for `v*` tags. After a push from `main` it also redeploys, picked
by `DEPLOY_TARGET`:

- `coolify` (the default): `deploy/coolify-redeploy.sh` restarts the resource
  with freshly pulled images, then, if `COOLIFY_HEALTH_URL` is set, waits until
  `/healthz` reports the pushed commit three times in a row.
- `portainer`: `deploy/portainer-redeploy.sh` redeploys the git-backed stack
  and waits for the `claude-dispatcher` container to be healthy on the new
  image.
- `none`: push the image only.

Pull requests never publish.

Configure it on the repository (or organisation):

| Kind   | Name                      | Purpose                                                              |
| ------ | ------------------------- | -------------------------------------------------------------------- |
| var    | `REGISTRY`                | registry host; without it nothing is built                           |
| var    | `IMAGE`                   | image path (default `claude-dispatcher`)                             |
| var    | `IMAGE_PLATFORMS`         | e.g. `linux/amd64 linux/arm64` (default `linux/amd64`)               |
| var    | `CLAUDE_CODE_VERSION`     | Claude Code dist-tag or version to bake in (default `stable`)        |
| var    | `CLAUDE_PLUGINS`          | Claude Code plugins to bake in, or `none` ([plugins](plugins.md))    |
| var    | `CLAUDE_MARKETPLACES`     | marketplaces those plugins come from                                 |
| var    | `DEPLOY_TARGET`           | `coolify` (default), `portainer` or `none`                           |
| var    | `COOLIFY_URL`             | e.g. `https://coolify.example.com`; without it there's no redeploy   |
| var    | `COOLIFY_SERVICE_UUID`    | the resource's UUID (from its URL); without it there's no redeploy   |
| var    | `COOLIFY_HEALTH_URL`      | e.g. `https://dispatcher.example.com/healthz`; unset: don't wait     |
| var    | `PORTAINER_URL`           | e.g. `https://portainer.example.com`; without it there's no redeploy |
| var    | `PORTAINER_STACK_ID`      | the stack's ID (from its URL); without it there's no redeploy        |
| var    | `PORTAINER_ENDPOINT_ID`   | Portainer environment ID (default `1`)                               |
| secret | `REGISTRY_USERNAME`       | registry login; also used for Portainer's git pull of the stack      |
| secret | `REGISTRY_PASSWORD`       | registry password or token                                           |
| secret | `COOLIFY_TOKEN`           | Coolify API token (API access enabled in Coolify's settings)         |
| secret | `CF_ACCESS_CLIENT_ID`     | optional Cloudflare Access service token for Coolify and the health  |
| secret | `CF_ACCESS_CLIENT_SECRET` | URL, if they sit behind Access                                       |
| secret | `PORTAINER_API_KEY`       | Portainer access token                                               |

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
- **Plugins**: the image installs the TypeScript and Python
  language-server plugins, which have no hooks. `CLAUDE_PLUGINS` changes the
  list; see [plugins.md](plugins.md).
- **Settings**: the image has no user-level Claude Code settings or hooks. A
  repo's own `.claude/` settings and `CLAUDE.md` still apply.

## Project toolchains

Claude must run each repo's checks (tests, linters, type checks) before the
dispatcher pushes anything, so the container needs each repo's toolchain. A
run whose checks failed or couldn't run is blocked, not pushed (see
[workflow.md](workflow.md)).

- **Node**: the image's Node 22, with pnpm/npm/yarn through corepack.
- **Python and Ruby**: installed with [asdf](https://asdf-vm.com) at build
  time. `ASDF_PRELOAD` picks the versions (default
  `python latest:3.12 ruby latest:3.3`; `latest:<prefix>` means the newest
  matching release). These are the defaults for repos that pin nothing. `uv`
  is included too.
- **Per-repo versions**: before each run the dispatcher reads the checkout's
  `.tool-versions`, `.python-version`, `.ruby-version`, `.node-version` and
  `.nvmrc`, installs those versions with asdf (any asdf plugin works in
  `.tool-versions`), and passes the exact versions to Claude's run as
  `ASDF_<TOOL>_VERSION`. A short pin like `3.12` resolves to its newest
  release. The first install of a version compiles it (a few minutes for
  Python or Ruby, limited by `TOOLCHAIN_INSTALL_TIMEOUT_MIN`). After that it's
  cached in the toolchains volume, across restarts and image upgrades. If an
  install fails, Claude is told which one, and the checks it can't run block
  the issue. `TOOLCHAIN_AUTO_INSTALL=false` turns this off.
- **System libraries**: the image has the usual build dependencies (OpenSSL,
  libffi, SQLite, libyaml, libxml2, Postgres and MySQL client headers) for
  native gems and wheels. Add more with
  `EXTRA_APT_PACKAGES="libvips-dev imagemagick" docker compose build`, or
  build your own image `FROM` this one and set `image:` in compose (or
  `DISPATCHER_IMAGE` for Portainer).

Preloading costs image size (about 1 GB) and build time (a few minutes per
version), once per build. For published images, set the `ASDF_PRELOAD` repo
variable (see `.gitea/workflows/publish.yml`).

## Test services

Test suites often need a database or cache, which CI provides as `services:`
containers. Both compose files run throwaway ones next to the dispatcher:
`postgres:17-alpine` (user and password `postgres`, or
`TEST_POSTGRES_PASSWORD`) and `redis:8-alpine`. They're reachable as
`postgres:5432` and `redis:6379`, the hostnames CI service containers
usually get. Data lives in memory and is lost when they restart.

`TEST_SERVICES` lists them as URLs, and Claude is told to point the repo's
tests at them. The compose files set it; Claude shares them across runs, so
it's told to create its own databases rather than reuse shared ones. In the
Portainer stack they're only on a network private to the stack, because on
the shared network the hostnames could resolve to another stack's real
database.

For another service (MySQL, Elasticsearch, …), add a container to the stack
on the same network and append its URL to `TEST_SERVICES`. To run without
them, remove the two services and set `TEST_SERVICES=` (empty); Claude then
reports checks that need them as not run.

## Security

Claude runs project commands without approval prompts
(`CLAUDE_PERMISSION_MODE=bypassPermissions`), so the container is the sandbox:

- **No Docker socket.** Don't mount it; it would give Claude control of the host.
- A memory limit (`DISPATCHER_MEMORY_LIMIT`, default `4g`), and on Coolify a
  CPU limit and `no-new-privileges` too. Claude can reach every container on
  the networks the dispatcher joins: the Gitea network on Coolify
  (`GITEA_NETWORK`), the shared Caddy network on Portainer (`SHARED_NETWORK`,
  default `caddy_net`). Keep those networks to services that are safe to
  expose to it.
- The Gitea token is never in Claude's environment or in `.git/config`; git
  gets it only while the dispatcher fetches or pushes.
- Issue and comment text is treated as untrusted input to Claude, but a
  determined prompt injection could still run commands in the container. Keep
  it free of credentials beyond the bot token and Claude's own.

## Status

`/healthz`, `/status` and the [dashboard](dashboard.md) are served on port
8080 (see [operations.md](operations.md)). Both deploy compose files set
`STATUS_HOST=0.0.0.0`. On Coolify, its proxy routes the resource's domain to
port 8080 and nothing is published on the host. The Portainer compose file publishes the port on
`${DISPATCHER_BIND_ADDR}:${DISPATCHER_HOST_PORT}` (default `127.0.0.1:8080`).
A Caddy container on the shared network proxies to `claude-dispatcher:8080`; a
Caddy on the host proxies to `127.0.0.1:8080`. Without a session, visitors
see only a landing page (and `/healthz`); set `DASHBOARD_TOKEN` to be able to
log in, optionally `DASHBOARD_HOME_URL` for the landing page's link, and put it
behind HTTPS (a reverse proxy) if it's reachable beyond localhost.
