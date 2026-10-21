# Proposal

## Why

Connected documentation currently grows only when the learner presses Check for updates. An explicit schedule should keep selected sections current and make the result of each check visible without disturbing saved study work.

## What Changes

- Add off/daily/weekly schedules per owned connection, persisted in PostgreSQL; existing connections default to off.
- Check due connections in bounded background work, preserving existing discovery scope, quotas, source identities and deletion tombstones.
- Fence overlapping checks and settings changes, recover expired claims, retry failures with backoff, and show next check, last outcome and added/updated/unchanged/error counts.

## Capabilities

### New Capabilities

- `documentation-schedules`: opt-in scheduled synchronization and persistent change summaries.

### Modified Capabilities

None; manual import/synchronization and source-study preservation remain unchanged.

## Impact

Library documentation API, worker, shared DTOs, collection controls, additive migration and tests. Non-goals: notifications, automatic flashcards/notebooks, recursive crawling, authenticated sites, silently changing section selection or raising quotas.
