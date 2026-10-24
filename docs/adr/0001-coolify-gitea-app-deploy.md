# 0001. Coolify deploys from the repo; CI triggers the deploy

- Status: accepted
- Date: 2026-10-23
- Issue: #60 (follow-up to #61)

## Context

#61 made Coolify the default deployment as a pasted **Docker Compose (Empty)**
service, which CI restarted through Coolify's services API
(`deploy/coolify-redeploy.sh`, with `COOLIFY_URL`, `COOLIFY_SERVICE_UUID` and
`COOLIFY_HEALTH_URL`).

The deployment has since moved to Coolify v4.5.0's **Gitea App** source:
Coolify clones this repository and deploys `docker-compose.coolify.yml` from
it, so the compose file in `main` is what runs. The image still comes from the
package CI builds and pushes to the Gitea registry.

Coolify's compose validator also limits what that file may contain: no
variables in volume sources or network names, environment as a quoted list,
no `container_name`, published ports or `network_mode`, no YAML anchors,
merge keys or `x-` blocks, and no dollar-brace sequence in comments.

## Decision

- Coolify deploys the resource from the repository, with **auto-deploy off**.
- The publish workflow triggers the deploy itself: after pushing `:latest` it
  calls the resource's **deploy webhook** (`deploy/coolify-deploy.sh`, with
  `COOLIFY_DEPLOY_WEBHOOK` and `COOLIFY_TOKEN`), then optionally waits on
  `/healthz` (`DEPLOY_HEALTH_URL`) for the pushed commit.
- The services-API restart path is removed. Portainer stays available behind
  `DEPLOY_TARGET=portainer`.
- The compose file follows Coolify's constraints: state at the literal paths
  `/srv/claude-dispatcher/data` and `/srv/claude-dispatcher/workspaces`, no
  shared Gitea network (Gitea is reached by its public URL, or through
  Coolify's _Connect to Predefined Network_ option), a healthcheck on every
  service, and `pull_policy: always` so a deploy picks up the new `:latest`.
  `test/coolify-compose.test.ts` enforces the constraints.

### Amendment (2026-10-24, #63)

The "no shared Gitea network" point was wrong in practice. Coolify rejects a
_variable_ in a network name, not an external network with a literal name, and
_Connect to Predefined Network_ joins Coolify's own network rather than the
Gitea resource's, so the dispatcher could not resolve `gitea` and restart-looped.
The compose file now declares `gitea_internal` as a literal external network
that only the `dispatcher` service joins, and `GITEA_URL` defaults to
`http://gitea:3000` in the example environment. The network must exist on the
host before the first deploy.

## Alternatives considered

- **Coolify's own auto-deploy on push.** The Gitea webhook fires on the merge,
  before CI has built and pushed the image, so Coolify would redeploy the
  previous `:latest`.
- **Keep restarting through the services API.** It targets the pasted-compose
  service resource, which no longer exists, and would be a second deploy path
  to maintain.

## Consequences

- One Coolify deploy path, ordered after the image push.
- The host paths are fixed; another location means editing the compose file.
- `GITEA_URL` has no default, and the `GITEA_NETWORK` setting is gone.
- `TEST_SERVICES` can no longer be overridden on Coolify (it would need a
  nested variable default); it always points at the bundled test services.
