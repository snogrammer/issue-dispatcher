# syntax=docker/dockerfile:1

# IssueDispatcher (claude-dispatcher): Node, git, the Claude Code CLI and the dispatcher itself.
# The container is the sandbox Claude works in (CLAUDE_PERMISSION_MODE defaults
# to bypassPermissions), so the dispatcher runs as a non-root user (uid 10001;
# the entrypoint starts as root only to take ownership of /data and
# /workspaces, then drops privileges), holds no credentials
# beyond Claude's own and the bot's Gitea token, and never gets the Docker
# socket.

ARG NODE_VERSION=22

# --- Build: compile TypeScript and collect production dependencies ----------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

# --- Runtime -----------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim

# Claude Code version: a dist-tag (stable, latest) or an exact version.
ARG CLAUDE_CODE_VERSION=stable
# Extra system packages a project's checks need (e.g. "libvips-dev imagemagick").
ARG EXTRA_APT_PACKAGES=""
# Language versions installed with asdf at build time, as "tool version" pairs.
# `latest:<prefix>` picks the newest matching release. Each repo's own pins
# (.tool-versions, .python-version, .ruby-version, .node-version, .nvmrc) are
# installed on demand before a run and kept in the toolchains volume. Node
# defaults to the image's own (system) Node.
ARG ASDF_PRELOAD="python latest:3.12 ruby latest:3.3"
ARG ASDF_VERSION=0.20.2
ARG ASDF_SHA256_AMD64=6d45e6fab12f50a259b5643adf06a2e77af30a87300b4402440eda09af467a6d
ARG ASDF_SHA256_ARM64=356e135a608bdfba34038c1f18c4b82434d7b6d546e30dbf372c61baaa2f442c
ARG TARGETARCH
# Claude Code plugins installed for the dispatcher's runs (plugin@marketplace,
# space-separated; "none" for none), and the marketplaces they come from.
# The LSP plugins use the language servers installed below. See docs/plugins.md.
ARG CLAUDE_PLUGINS="typescript-lsp@claude-plugins-official pyright-lsp@claude-plugins-official"
ARG CLAUDE_MARKETPLACES="anthropics/claude-plugins-official"

# tini: PID 1 that reaps the orphans left when a timed-out Claude run's
# process group is killed (otherwise they stay zombies). The rest lets asdf
# build Python and Ruby, and covers the native gems and wheels most Rails and
# Python projects need (Postgres, MySQL, SQLite, YAML, XML).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates tini curl unzip xz-utils \
     build-essential pkg-config libssl-dev zlib1g-dev libbz2-dev libreadline-dev \
     libsqlite3-dev libffi-dev liblzma-dev libyaml-dev libgdbm-dev libncurses-dev \
     tk-dev uuid-dev libxml2-dev libxslt1-dev libpq-dev default-libmysqlclient-dev \
     ${EXTRA_APT_PACKAGES} \
  && rm -rf /var/lib/apt/lists/*

# asdf manages per-project language versions; uv is the usual Python runner.
RUN case "${TARGETARCH:-amd64}" in \
      amd64) sum="${ASDF_SHA256_AMD64}" ;; \
      arm64) sum="${ASDF_SHA256_ARM64}" ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
  && curl -fsSL -o /tmp/asdf.tgz \
     "https://github.com/asdf-vm/asdf/releases/download/v${ASDF_VERSION}/asdf-v${ASDF_VERSION}-linux-${TARGETARCH:-amd64}.tar.gz" \
  && echo "${sum}  /tmp/asdf.tgz" | sha256sum -c - \
  && tar -xzf /tmp/asdf.tgz -C /usr/local/bin asdf \
  && rm /tmp/asdf.tgz
COPY --from=ghcr.io/astral-sh/uv:0.12.23 /uv /uvx /usr/local/bin/
# typescript-language-server and pyright back the typescript-lsp and
# pyright-lsp plugins.
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
     typescript-language-server typescript pyright \
  && npm cache clean --force \
  && corepack enable

RUN useradd --create-home --uid 10001 --shell /bin/bash dispatcher \
  && mkdir -p /data /workspaces /toolchains \
  && chown dispatcher:dispatcher /data /workspaces /toolchains

# Toolchains live in /toolchains (a named volume in compose: Docker seeds it
# from this image on first use, and versions installed later survive
# upgrades). Builds are prefix-bound, so they're built in place.
ENV ASDF_DATA_DIR=/toolchains \
    ASDF_CONFIG_FILE=/etc/asdfrc \
    ASDF_NODEJS_AUTO_ENABLE_COREPACK=1 \
    PATH=/toolchains/shims:$PATH
COPY docker/asdfrc /etc/asdfrc
COPY --chmod=755 docker/asdf-preload.sh /usr/local/bin/asdf-preload
COPY --chmod=755 docker/claude-plugins.sh /usr/local/bin/claude-plugins
USER dispatcher
RUN HOME=/home/dispatcher asdf-preload ${ASDF_PRELOAD}
# In the image, not a volume: rebuilding upgrades them along with the CLI.
RUN HOME=/home/dispatcher CLAUDE_MARKETPLACES="${CLAUDE_MARKETPLACES}" claude-plugins ${CLAUDE_PLUGINS}
USER root

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# The dashboard: static files served as-is, plus the brand assets it uses.
COPY web ./web
COPY assets/brand/web ./assets/brand/web
COPY assets/brand/svg ./assets/brand/svg
COPY assets/brand/favicon ./assets/brand/favicon
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/dispatcher-entrypoint

ENV NODE_ENV=production \
    DATA_DIR=/data \
    WORKSPACE_DIR=/workspaces \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    # The image is rebuilt to upgrade Claude Code; it must not update itself.
    DISABLE_AUTOUPDATER=1

# No USER: dispatcher-entrypoint fixes volume ownership as root, then runs
# the dispatcher as uid 10001.
VOLUME ["/data", "/workspaces", "/toolchains"]

# The image's Node by path: healthchecks run as root, whose asdf has no
# default, so once a repo installs a Node into /toolchains the `node` shim
# fails for root ("No version is set for command node") and the container
# shows unhealthy for good (#66).
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD /usr/local/bin/node -e "fetch('http://127.0.0.1:' + (process.env.STATUS_PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# Set by the publish workflow; declared last so it doesn't bust the layer cache.
ARG GIT_SHA=unknown
# Logged at startup, so the running build is visible in the container logs.
ENV GIT_SHA=$GIT_SHA
LABEL org.opencontainers.image.title=IssueDispatcher \
      org.opencontainers.image.revision=$GIT_SHA

ENTRYPOINT ["tini", "--", "dispatcher-entrypoint"]
# The image's own Node, whatever version a project pins through asdf.
CMD ["/usr/local/bin/node", "dist/main.js"]
