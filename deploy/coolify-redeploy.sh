#!/usr/bin/env bash
# Redeploy a Coolify Docker Compose resource onto a freshly pushed image, then
# wait for /healthz to answer from the new build. Called by
# .gitea/workflows/publish.yml after a push from main.
#
# Required env:
#   COOLIFY_URL            e.g. https://coolify.example.com
#   COOLIFY_TOKEN          Coolify API token (Keys & Tokens > API tokens; API access enabled)
#   COOLIFY_SERVICE_UUID   the resource's UUID (in its URL in the Coolify UI)
# Optional env:
#   HEALTH_URL             e.g. https://dispatcher.example.com/healthz (unset: restart, don't wait)
#   GIT_SHA                the pushed commit; /healthz must report it before the deploy counts
#   CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET
#                          Cloudflare Access service token, sent with every request
#   MAX_WAIT_SECONDS (300)
#
# Restarting with latest=true pulls the newest images before recreating the
# containers. (A force-deploy has been reported to restart without pulling.)
set -euo pipefail

: "${COOLIFY_URL:?}" "${COOLIFY_TOKEN:?}" "${COOLIFY_SERVICE_UUID:?}"
COOLIFY_URL="${COOLIFY_URL%/}"
HEALTH_URL="${HEALTH_URL:-}"
GIT_SHA="${GIT_SHA:-}"
MAX_WAIT_SECONDS="${MAX_WAIT_SECONDS:-300}"

access=()
if [[ -n "${CF_ACCESS_CLIENT_ID:-}" && -n "${CF_ACCESS_CLIENT_SECRET:-}" ]]; then
  access=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
fi

# Run a request; print its body, fail loudly on non-2xx. Never echoes credentials.
call() {
  local step="$1"; shift
  local out code
  out=$(curl -sS -m 60 -w $'\n%{http_code}' ${access[@]+"${access[@]}"} \
        -H "Authorization: Bearer $COOLIFY_TOKEN" -H "Accept: application/json" "$@")
  code="${out##*$'\n'}"
  out="${out%$'\n'*}"
  if [[ ! "$code" =~ ^2[0-9][0-9]$ ]]; then
    echo "❌ $step failed (HTTP $code): ${out:0:300}" >&2
    exit 1
  fi
  echo "✅ $step (HTTP $code)" >&2
  printf '%s' "$out"
}

echo "🔄 Redeploying Coolify resource ${COOLIFY_SERVICE_UUID:0:8}…"
call "Restart with latest images" -X POST \
  "$COOLIFY_URL/api/v1/services/$COOLIFY_SERVICE_UUID/restart?latest=true" >/dev/null

if [[ -z "$HEALTH_URL" ]]; then
  echo "ℹ️  HEALTH_URL not set: restart requested, not waiting."
  exit 0
fi

# The old container keeps answering until it's replaced, so a 200 only counts
# once it names the pushed commit (any 200 when GIT_SHA isn't known).
echo "⏳ Waiting for $HEALTH_URL to report ${GIT_SHA:-a healthy build}…"
START=$(date +%s); ok=0
while true; do
  body=$(curl -s -m 10 -w $'\n%{http_code}' ${access[@]+"${access[@]}"} "$HEALTH_URL" || true)
  code="${body##*$'\n'}"
  body="${body%$'\n'*}"
  commit=$(jq -r '.commit // ""' <<<"$body" 2>/dev/null || true)
  if [[ "$code" == "200" && ( -z "$GIT_SHA" || "$commit" == "$GIT_SHA" ) ]]; then
    ok=$((ok + 1))
  else
    ok=0
  fi
  echo "  healthz HTTP ${code:-000} commit=${commit:0:7} (consecutive passes: $ok/3)"
  if (( ok >= 3 )); then break; fi
  if (( $(date +%s) - START >= MAX_WAIT_SECONDS )); then
    echo "❌ Timed out after ${MAX_WAIT_SECONDS}s waiting for $HEALTH_URL"
    exit 1
  fi
  sleep 5
done

echo "🎉 Redeploy complete: ${GIT_SHA:-unknown}"
