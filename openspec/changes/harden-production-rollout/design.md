# Design

## Context

See proposal.md. Coolify 4.4.6 supports service CRUD/start but has no public server pull command. Docker-image deployment pulls again at startup. Existing API entrypoints apply migrations, so ordinary rolling replacement can overlap an old writer.

## Goals / Non-Goals

Preserve the existing API and web UUIDs, runtime secrets, domains, serialized main workflow and mandatory checks. No DB migration, index, persistent helper, Docker socket mount or SSH credential is needed.

## Decisions

- A Bun coordinator uses the supported Coolify HTTP API. Before mutations it validates immutable SHA tags, application health, same destination/server, and no in-flight application deployments.
- Create a unique temporary Compose service in the existing project/environment/destination. Two services use the exact target API/web images but override entrypoints with `/bin/sh -c 'sleep 1800'`, a harmless command healthcheck, read-only filesystems, dropped capabilities, no ports or volumes, and no app environment. Healthy component status proves the server pulled and can run both images. Retry service startup up to three bounded attempts; it never stops production during preparation.
- Capture previous tags before preparation. Stop old API retaining Docker resources; await stopped state; PATCH and deploy API, verify completion/health, then PATCH and deploy web. On a failure, cancel unfinished deployment and wait terminal before restoring tags and redeploying. An uncertain deployment request is reconciled through the application's deployment list; never queue competing replacements blindly.
- Recovery starts immediately, uses bounded retries and records each failed component; the workflow exits nonzero even after successful recovery. Preserve compatibility responsibility: additive migrations are not reverted; incompatible schema releases require their own documented forward recovery.
- Remove only the known temporary service with Docker cleanup and volume deletion disabled, preserving prepared images. An explicit preparation-only mode validates the mechanism against already-published tags without touching production app configuration.

## Risks / Trade-offs

- [Coolify pulls again during the real rollout] → preparation avoids the known cold-pull outage; immediate bounded recovery addresses later failures. A persistent registry/control-plane outage can also block recovery and remains an explicit operator failure.
- [Runner is forcibly terminated] → keep deploy concurrency non-cancelling, leave workflow time for recovery, handle termination signals, and log the preparation UUID/previous tags for manual recovery. No claim of recovery after SIGKILL.
- [Temporary-service startup reports stale state] → require both named component statuses healthy on a newly created unique service, not the top-level status alone.

## Migration Plan

No schema migration. Verify failure scenarios against a fake Coolify server, run preparation-only on production's current immutable release, then merge. The new workflow itself uses the new coordinator on its first release. If reverting tooling, keep the safer coordinator until an equivalent mechanism exists; do not restore stop-before-pull.
