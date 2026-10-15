# Operations and recoverable actions

The release adds a shell Operations list and receipt-backed saves for a bounded set of small actions. Source and artifact rows remain authoritative; the list is a projection, not another job queue. Card, note-type and written-note editors retain their existing explicit Save semantics.

## Deployment

1. Run the committed migration chain, including `0037_special_loners.sql` `0038_fancy_yellowjacket.sql`, `0039_daily_ken_ellis.sql`, and `0040_note_operations.sql`. Do not use schema push for acceptance or production. The final index aligns the tenant/session offer ordering and avoids scanning unrelated recent receipts. These migrations add nullable operation metadata, receipts, metadata revisions and hierarchy triggers; they do not rewrite existing IDs or content. Historical terminal jobs with no run metadata are not fabricated as recent results.
2. Stop and verify the old API process has exited before starting the migration-bearing replacement, as the production workflow already does. New and old workers must not concurrently own the same job rows. The compatible API applies migrations at startup and exposes `/operations/v1` and `/ui-actions/v1` before the new web image is released.
3. Keep the additive schema, receipts and compatible API through a web rollback. The new API supports old REST callers; SQL revisions also observe their writes. API readiness must be healthy before web rollout. Verify the immutable image SHA and public `/ready`, not just a completed image build.
4. Verify one accepted source after navigation, one exact result link, a retry, and a safe save/Undo through the web. Watch bounded request/failure/readiness events; never log operation arguments, note/card/source bodies, provider payloads or receipt inverse values.

A full rollback to an API without these protocols requires maintenance and quiesced writers/workers. Do not leave the new web pointed at it. Do not drop the additive schema or receipts, and do not run old workers against active jobs created under run fencing. Prefer restoring the compatible API and rolling back only web. Any work accepted by an old binary must be reconciled before re-enabling the new operation protocol; legacy binaries cannot provide its run/receipt guarantees.

## Contracts and limits

- Operations covers accepted source ingest/reingest and source/notebook artifacts, including quizzes. It excludes upload transfer, overview generation, global reindex and chat turns. It shows the latest run per extant object, active work without an age cutoff, and attention/recent work for seven days. Each group pages 20 rows (maximum 50) with opaque cursors.
- Reading and search are separate capabilities. Original PDF bytes can be readable before parsing; parsed text can be readable during indexing or an index failure. Disabled/degraded embeddings are attention, not active processing. Partial progress uses actual indexed/total counts; generation does not invent a percentage.
- `/operations/v1/retry` requires the observed run and a UUIDv7 request ID. Receipt and replacement run commit together; dispatch follows commit. Matching replies/replays never enqueue twice. Missing input, changed arguments, unavailable AI and cooldown remain explicit. Startup reconciliation exposes interrupted artifacts instead of automatically paying for another attempt.
- `/ui-actions/v1` owns receipt-backed card-note and note-type saves, written study-note create/edit/pin, source title/author/description/tags, notebook title, deck name/color/icon and deck movement. Existing card/type previews, versions and confirmation tokens still apply. Routes are cookie-authenticated; PAT/MCP writes do not bypass confirmation.
- Undo is limited to source metadata, notebook title, deck metadata/placement and written-note pinning. It does not undo content creation/editing, card scheduling, generation or deletion. The inverse is stored by the server and checks post-write revisions; later ABA writes, a changed hierarchy, missing targets and expiry cannot be overwritten. Generic content receipts store hashes and resulting identity/version, not copied bodies.
- Saves remain reconcilable for seven days; advertised Undo lasts ten minutes, enforced by server time. A lost Undo response is reconciled by reading its receipt. Only an explicit action replays a mutation. Expired create identities cannot become fresh creates after cleanup. Hourly maintenance processes bounded batches of 500 expired rows per receipt table and drains during API shutdown.
- Recent actions are filtered by an opaque server-issued, owner-bound tab session ID. It is a filter, not authentication. Session storage enables same-tab reload; denial keeps the scope in memory and discloses the reload limitation. Timed toasts do not remove valid offers. Saves do not increase the long-operation count.
- Written-note drafts extend the existing owner-scoped recovery format: 10 drafts, 256 KiB each and 1 MiB per owner, with export and visible capacity/storage failures. Metadata forms keep their mounted input and a leave guard; they do not promise persistent metadata drafts. An old acknowledgement never clears newer input. An expired unconfirmed request retains its identity across reload and asks the user to inspect saved work before creating another item. Reload/restore does not create an object or automatically resend an uncertain mutation.

## UI ownership

One account-keyed observer supplies source/artifact status invalidation: 2.5 seconds while active, 30 seconds while idle, bounded failure backoff, focus/wake refresh and hidden-tab suspension. Slow detail reads coalesce; full artifact content streaming remains a separate visible-view read. Observation failure retains the last known rows with a stale notice.

Operations is reachable from expanded/compact navigation, mobile tabs and a small control when the desktop sidebar is hidden. `GET /operations/v1/artifacts/:id` resolves only owned destination metadata, without returning generated content; opening a source-owned result revalidates its live source link, so a stale feed still reaches retained work. Result links use guarded navigation, retain the exact identity and expose an origin return inside the artifact reader. Retained source work uses the saved-work route when its original source has been deleted.

Transient layers share Escape/outside/focus handling, owner isolation and nested portal ownership. Mobile uses opaque same-route markers through the existing pre-Next bridge; route navigation waits for temporary entries to drain. Forward/reload cannot restore stale layer DOM. Query-only cleanup retains the current editor. Stable desktop rails do not acquire mobile entries; the desktop floating assistant survives navigation while its popups close. Dismissal never confirms an assistant write or stops its owned stream. PDF comments and reader tab/handoff paths use the same dirty-close decisions.

## Reproducible checks

The ordinary release gates remain `spec:validate`, `typecheck`, `db:migrate:apply:test`, `test:ci`, `build`, and required real-storage `test:s3:ci`.

Additional local proofs (never target production):

```sh
NODE_ENV=test bun --env-file=.env packages/db/scripts/actions-upgrade-proof.ts
NODE_ENV=test OPERATIONS_PROOF_DATABASE=neuronexus_operations_test bun --env-file=.env apps/api/scripts/operations-query-proof.ts
NAVIGATION_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node apps/web/scripts/navigation-browser-proof.mjs
```

The upgrade proof creates and removes its own local database, seeds pre-change rows at migration 0036, applies the full chain and checks revisions, preservation and idempotency. The query proof requires an explicitly named matching local test database, creates two synthetic owners, exercises 70,001 job/source rows and 48,000 receipt rows and removes only those owners. Neither script uses schema push.

Browser evidence and final command results are recorded with the two OpenSpec changes. Browser fixtures use local deterministic AI and a separate local MinIO bucket; they are not tests of any external AI provider. The missing-endpoint compatibility check simulates an older API returning 404 and verifies no fallback mutation.
