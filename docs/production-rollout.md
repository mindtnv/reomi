# Production rollout

The `deploy` workflow gates on migrated tests, mandatory real-S3 tests and both image builds. Its serialized, non-cancelling deploy job runs `scripts/deploy-coolify.ts` with the existing Coolify token and application UUIDs. The coordinator records the previous immutable API/web tags in the job log; it does not read or print application environment variables.

## Before stopping the API

Both applications must be healthy, use immutable 40-character commit tags and share one Docker destination. Active deployments, multiple servers or changed tags abort preparation without stopping production.

Coolify 4.4.6 has no server-side image-pull endpoint. The coordinator creates a temporary `reomi-prepare-<run>-<attempt>` Compose service on the application's actual server. Its two containers use the exact release images with entrypoints overridden to a bounded sleep, harmless command healthchecks, read-only filesystems and dropped capabilities. They have no application secrets, published ports, public domains, volumes or Docker socket. This downloads and exercises both images on the server without starting the API, web or migrations. Both component statuses must become healthy. Service startup has three bounded attempts. Failure leaves the serving release unchanged.

Preparation-only rehearsal uses already-published tags:

```sh
GITHUB_SHA=<full-published-commit> bun scripts/deploy-coolify.ts --prepare-only
```

The temporary service is deleted in cleanup with image cleanup and volume deletion disabled. Only its recorded UUID is deleted. If cleanup fails, its UUID is printed for manual removal. No production app is created or renamed.

## Replacement and recovery

After rechecking tags and deployment queues, the old API is stopped with Docker cleanup disabled. The coordinator waits for stopped state, deploys the new API and verifies completion and health before deploying web. Old writers never overlap migration startup. An uncertain deployment response is reconciled using the application's deployment history before another operation is submitted.

On failure after drain, unfinished deployments are cancelled and awaited before restoration. Previous tags are restored and the previous API, then any changed web, are redeployed with bounded retries and health verification. If the web was changed, it is stopped before API rollback. Recovery runs immediately and does not depend on production browser smoke. A recovered failed release still fails the workflow. An unrecovered release emits an explicit error naming the affected applications. Forward work has a 20-minute ceiling, recovery 12 minutes, and the workflow reserves 40 minutes; each HTTP request is capped at 15 seconds. SIGTERM/SIGINT request recovery, while SIGKILL or a lost runner cannot guarantee it.

Coolify still pulls again during replacement. Preparation eliminates the known cold-pull-before-stop failure, but a persistent registry or control-plane outage can also block recovery. Inspect the job and Coolify deployment status immediately in that case; restore the recorded tags and start the previous applications. Do not wait for e2e-prod.

## Compatibility

This changes no database schema or application protocol. Database migrations are never rolled back automatically. Every release must document compatibility with its previous API/web version. Additive tables and columns stay in place during rollback; incompatible schema or data changes require a separate forward-recovery plan before release. Never redeploy an incompatible old writer merely to obtain a green healthcheck.
