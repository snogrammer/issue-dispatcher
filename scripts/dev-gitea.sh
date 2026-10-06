#!/usr/bin/env bash
# A throwaway local Gitea for trying the dispatcher without touching a real
# instance: an admin, a non-admin bot user with a bot-owned token, and a demo
# repo the bot can write to. Writes stack.env for `docker compose`.
#
#   scripts/dev-gitea.sh up      # Gitea + users/repo + stack.env + the dispatcher stack
#   docker compose -p cd-dev logs -f dispatcher
#   scripts/dev-gitea.sh down    # remove Gitea, the compose stack and stack.env
#
# Gitea is reachable on http://127.0.0.1:13000 (log in as dev-admin; the
# password is printed by `up`). Claude credentials are not set: add
# CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY to stack.env for real runs.
set -euo pipefail

NAME=cd-dev-gitea
PORT=13000
API="http://127.0.0.1:${PORT}/api/v1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

up() {
  docker run -d --name "$NAME" -p "127.0.0.1:${PORT}:3000" \
    -e GITEA__security__INSTALL_LOCK=true \
    -e GITEA__database__DB_TYPE=sqlite3 \
    -e GITEA__server__ROOT_URL="http://${NAME}:3000/" \
    -e GITEA__service__DISABLE_REGISTRATION=true \
    gitea/gitea:1.27 >/dev/null
  for _ in $(seq 1 60); do
    curl -fs "${API}/version" >/dev/null && break
    sleep 2
  done

  local admin_pw bot_pw admin_token bot_token
  admin_pw="$(openssl rand -base64 18)"
  bot_pw="$(openssl rand -base64 18)"
  docker exec -u git "$NAME" gitea admin user create --admin --username dev-admin \
    --password "$admin_pw" --email admin@dev.test --must-change-password=false >/dev/null
  docker exec -u git "$NAME" gitea admin user create --username claude-bot \
    --password "$bot_pw" --email bot@dev.test --must-change-password=false >/dev/null
  admin_token="$(docker exec -u git "$NAME" gitea admin user generate-access-token \
    --username dev-admin --token-name dev --scopes all --raw)"
  bot_token="$(docker exec -u git "$NAME" gitea admin user generate-access-token \
    --username claude-bot --token-name dispatcher \
    --scopes write:repository,write:issue,read:user --raw)"

  local auth="Authorization: token ${admin_token}"
  curl -fs -X POST -H "$auth" -H "Content-Type: application/json" \
    -d '{"username":"dev","visibility":"private"}' "${API}/orgs" >/dev/null
  curl -fs -X POST -H "$auth" -H "Content-Type: application/json" \
    -d '{"name":"demo","auto_init":true,"default_branch":"main"}' "${API}/orgs/dev/repos" >/dev/null
  curl -fs -X PUT -H "$auth" -H "Content-Type: application/json" \
    -d '{"permission":"write"}' "${API}/repos/dev/demo/collaborators/claude-bot" >/dev/null

  umask 077
  cat >"${ROOT}/stack.env" <<ENV
GITEA_URL=http://${NAME}:3000
GITEA_TOKEN=${bot_token}
BOT_USERNAME=claude-bot
HUMAN_REVIEWER=dev-admin
REPOS=dev/demo
POLL_INTERVAL_S=15
CLAUDE_CODE_OAUTH_TOKEN=
ANTHROPIC_API_KEY=
ENV
  # Create the stack, put Gitea on its network, then start the dispatcher.
  (cd "$ROOT" && docker compose -p cd-dev up --build --no-start --quiet-pull >/dev/null)
  docker network connect cd-dev_dispatcher "$NAME"
  (cd "$ROOT" && docker compose -p cd-dev start >/dev/null)

  echo "Gitea: http://127.0.0.1:${PORT}  (dev-admin / ${admin_pw})"
  echo "Dispatcher running (stack cd-dev). Assign issues in dev/demo to claude-bot."
}

down() {
  (cd "$ROOT" && docker compose -p cd-dev down -v 2>/dev/null) || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -f "${ROOT}/stack.env"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *) echo "usage: $0 up|down" >&2; exit 2 ;;
esac
