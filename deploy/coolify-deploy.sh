#!/usr/bin/env bash
# Deploy the Coolify resource onto a freshly pushed image, then wait for
# /healthz to answer from the new build. Called by .gitea/workflows/publish.yml
# after a push from main.
#
# Coolify deploys docker-compose.coolify.yml from this repo (a Gitea App
# source) with auto-deploy off: a push to main would deploy before the image
# exists, so CI calls the resource's deploy webhook once it has pushed.
#
# Required env:
#   COOLIFY_DEPLOY_WEBHOOK  the resource's Webhooks > Deploy Webhook URL,
#                           e.g. https://coolify.example.com/api/v1/deploy?uuid=<uuid>&force=false
#   COOLIFY_TOKEN           Coolify API token with deploy permission (API access enabled)
# Optional env:
#   HEALTH_URL              e.g. https://dispatcher.example.com/healthz (unset: deploy, don't wait)
#   GIT_SHA                 the pushed commit; /healthz must report it before the deploy counts
#   CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET
#                           Cloudflare Access service token, sent with every request
#   MAX_WAIT_SECONDS (600)  a deploy clones the repo and pulls the image first
set -euo pipefail

: "${COOLIFY_DEPLOY_WEBHOOK:?}" "${COOLIFY_TOKEN:?}"
HEALTH_URL="${HEALTH_URL:-}"
GIT_SHA="${GIT_SHA:-}"
MAX_WAIT_SECONDS="${MAX_WAIT_SECONDS:-600}"

access=()
if [[ -n "${CF_ACCESS_CLIENT_ID:-}" && -n "${CF_ACCESS_CLIENT_SECRET:-}" ]]; then
  access=(-H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET")
fi

# Trigger the deploy; fail loudly on non-2xx. Never echoes credentials or the
# webhook URL (it names the resource).
echo "🔄 Triggering the Coolify deploy webhook…"
out=$(curl -sS -m 60 -w $'\n%{http_code}' ${access[@]+"${access[@]}"} \
      -H "Authorization: Bearer $COOLIFY_TOKEN" -H "Accept: application/json" \
      "$COOLIFY_DEPLOY_WEBHOOK")
code="${out##*$'\n'}"
out="${out%$'\n'*}"
if [[ ! "$code" =~ ^2[0-9][0-9]$ ]]; then
  echo "❌ Deploy webhook failed (HTTP $code): ${out:0:300}" >&2
  exit 1
fi
echo "✅ Deploy queued (HTTP $code): ${out:0:300}"

if [[ -z "$HEALTH_URL" ]]; then
  echo "ℹ️  HEALTH_URL not set: deploy queued, not waiting."
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

echo "🎉 Deploy complete: ${GIT_SHA:-unknown}"
