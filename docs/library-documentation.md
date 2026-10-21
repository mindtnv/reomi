# Documentation in the library

Use Library → Add → Connect documentation. Paste a documentation URL, find sections, inspect the normalized root and language, name the folder, and choose branches. Expanding a branch lets you exclude children without losing siblings. The preview shows discovered and selected page counts, new-material count, and available library capacity; it never creates materials or folders.

Confirm starts a background import. Each page is an ordinary URL source, organized under the collection folder and section folders, with the same reader, source notes, notebook memberships and card evidence as other library materials. Opening the collection folder selects the compact list view. Existing matching canonical URL sources are reused in their current location. Importing never creates a notebook, card or artifact.

The collection row shows progress, failures, Open folder, Check for updates, Stop/Resume and Disconnect. Stop preserves completed pages. Resume checks the index again and retries incomplete pages. Disconnect requires a UI confirmation and removes only the import relationship; sources, folders and study work remain. If a destination folder is deleted, further import stops instead of silently using Unfiled.

## Synchronization

Each connection supports Off (the default), Daily or Weekly automatic checks, alongside Check for updates. The library shows the next and last checks and the last completed run's added, updated and unchanged counts. Failed discovery keeps saved text and retries with bounded exponential backoff, from 15 minutes to six hours. Stop pauses the import until explicit Resume; a schedule never resumes a stopped import. Turning the schedule off fences in-flight discovery; already queued page work can be stopped separately.

Discovery uses the guarded llms/sitemap/navigation index, not recursive page crawling. A pasted `/docs/home/` or `/docs/index.html` offers `/docs/` in the preview. Scope stays on one origin, subtree, language and preferred version. English fallback is displayed as EN rather than falsely labelling English text as Russian.

New selected pages are added once. Existing pages are fetched before any saved content is replaced. Unchanged chunks retain their identities. Changed text replaces chunks and disposable vectors atomically, retaining the source ID, metadata, reading state, notebook links, source notes, cards and historical evidence snapshots. Superseded chunk links can detach; the old evidence quote stays historical. Failed or empty fetches leave saved text intact. Pages absent from the current index receive an attention state, and explicitly deleted sources are not recreated.

Imports share the existing library quota (default 300 sources) and folder limits. Accepted active imports reserve capacity across concurrent connections. Up to 20 documentation connections and 10 unexpired previews are allowed per owner. A preview expires after ten minutes. Oversized selections fail without silently importing a first subset; choose smaller branches.

## API and recovery

Cookie-authenticated routes under `/library/documentation` provide list, preview, owned detail/error detail, confirm, updates, cancel, schedule and disconnect. Preview stores an owned draft manifest; confirmation is idempotent for the same title and selection. Each collection/page mutation is owner-scoped. Stored include/exclude prefix rules use the most-specific match during both initial import and synchronization. Scheduled discovery uses persisted expiring claims, short row locks and commit fencing; only one check can claim a due connection, including after restarts. Manual checks reject live automatic claims.

`library_documentation` owns durable run identity and selection; `library_documentation_pages` owns each URL job and deletion tombstone. The single worker fetches outside transactions, checks scope before every redirect, and fences commits against the live collection run. Cancellation/disconnect abort the active fetch and invalidate later commits. Interrupted running collections are queued with new run identities at compatible startup. `/ready` exposes only aggregate documentation-worker state; graceful shutdown stops claims and drains/aborts work.

Parsing and reading do not depend on AI keys. After a successful text commit, the existing source ingest worker handles derived embeddings; when embeddings are disabled, text remains readable in the normal parked state.

## Rollout and rollback

Migration `0050_deep_young_avengers.sql` adds collection/page tables, ownership/source/folder FKs and queue/uniqueness indexes. `0051_lame_matthew_murdock.sql` adds default-off schedules, persisted claims, retry state and run outcomes. Source and folder deletion SET NULL preserves import tombstones; disconnect cascades only its page-job metadata. Build the database through committed migrations.

Deploy schema/API before web. The previous web and API continue to understand the ordinary source/folder rows. Prefer web rollback; retain the additive tables and saved source chunks. An older API leaves import jobs alone; restart the compatible worker to recover interrupted work. Do not drop imported materials or restore old text as a release rollback.

## Verification

- Discovery tests cover landing normalization, section rules, locale/origin filtering and redirects rejected before an external fetch.
- API tests exercise the real persistent worker with deterministic guarded-fetch fixtures: ownership, confirmation, quotas, canonical reuse, changed/unchanged text, notes/card history, fetch failure, missing pages, tombstones, cancellation, recovery and disconnect.
- The browser journey uses deterministic documentation API fixtures and real library/folder/source endpoints for collection navigation and reading. This makes UI proof independent of public-site availability; it does not claim a live Kubernetes crawl.
- Reviewed browser and standalone evidence: [screenshots](library-documentation/README.md). The full repository smoke and migration-faithful release gates are recorded in the OpenSpec change acceptance file.
