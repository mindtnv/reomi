# Proposal

## Why

Issue #94 records an outage caused by stopping the production API before Coolify could pull its replacement. Registry failures must leave the current release serving, and failures after draining must immediately trigger bounded recovery.

## What Changes

- Prepare both immutable release images on the target Docker server before stopping any application, with bounded retries and no application entrypoints or credentials.
- Snapshot previous tags, preserve API-before-web ordering, cancel unfinished deployments before recovery, and restore the previous release automatically on failure.
- Clean only preparation resources created by the current run; report recovery failures explicitly and keep deployment concurrency serialized.

## Capabilities

### New Capabilities

- `production-rollout`: preparation before drain and immediate bounded release recovery.

### Modified Capabilities

None. Existing migration gates and readiness contracts remain in force.

## Impact

GitHub deploy workflow, a tested Coolify rollout coordinator, rollout documentation. No application API, schema, credential, or public-domain changes. Non-goals: zero downtime, automatic database rollback, changing Coolify, or redesigning migration compatibility. Releases must remain compatible with their recorded rollback version.
