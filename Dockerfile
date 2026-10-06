# syntax=docker/dockerfile:1

# claude-dispatcher: Node, git, the Claude Code CLI and the dispatcher itself.
# The container is the sandbox Claude works in (CLAUDE_PERMISSION_MODE defaults
# to bypassPermissions), so it runs as a non-root user, holds no credentials
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
# Extension point for project toolchains, e.g. "python3 python3-venv make".
# For anything bigger, build FROM this image and install what you need.
ARG EXTRA_APT_PACKAGES=""

# tini: PID 1 that reaps the orphans left when a timed-out Claude run's
# process group is killed (otherwise they stay zombies).
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates tini ${EXTRA_APT_PACKAGES} \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && npm cache clean --force \
  && corepack enable

RUN useradd --create-home --uid 10001 --shell /bin/bash dispatcher \
  && mkdir -p /data /workspaces \
  && chown dispatcher:dispatcher /data /workspaces

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

ENV NODE_ENV=production \
    DATA_DIR=/data \
    WORKSPACE_DIR=/workspaces \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    # The image is rebuilt to upgrade Claude Code; it must not update itself.
    DISABLE_AUTOUPDATER=1

USER dispatcher
VOLUME ["/data", "/workspaces"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.STATUS_PORT || 8080) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# Set by the publish workflow; declared last so it doesn't bust the layer cache.
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.revision=$GIT_SHA

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/main.js"]
