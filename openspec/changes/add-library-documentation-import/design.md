# Design

## Context

See proposal.md. `docs-index.ts` already builds guarded llms/sitemap/navigation indexes for topic plans. Library URL creation is single-page. Sources own text, study work, and notebook links. Existing destructive reingest clears chunks before refetch, so it cannot implement failure-preserving documentation sync.

## Goals / Non-Goals

**Goals:** reuse discovery without topic-module scoring, retain explicit scope, and persist every accepted page job in PostgreSQL. Keep embedding a separate derived step.

**Non-Goals:** a general crawler, scheduler, extra model calls, or changing legacy reingest semantics.

## Decisions

### Discovery and selection

Expose a narrow library discovery adapter over the existing bounded index reader. Normalize `home` and `index` landing paths to their parent and display the result before confirmation. Keep canonical normalized URLs, one origin/path, locale and preferred version. A fresh lookup bypasses the topic-plan index cache. Build section prefixes from page parent paths; selection of an ancestor includes its descendants. Reference trees are available but initially unselected. Store the immutable preview manifest in an owned draft collection, expiring after ten minutes. No page bodies are fetched during discovery and no source/folder is created. Section summaries avoid returning every page body or URL in UI responses.

### Durable data and limits

Add `library_documentation` (owner, root, locale, title, destination folder, state, manifest, selected prefixes, run ID, error and timestamps) and `library_documentation_pages` (owner, collection, canonical URL, section, source link, imported flag, content hash, state/error). Owner/root/locale and collection/URL unique indexes prevent duplicate connections and page jobs. Source/folder FKs use SET NULL: deleting saved content or folders never deletes study work through collection ownership. The imported flag distinguishes a deleted source from an unfinished page.

Confirm serializes with the owner folder lock, checks the current source/folder capacities, creates a collision-free root and selected-section folders, and queues page rows in one transaction. Existing owned URL sources are reused without moving them. Confirmation retries return the same collection. Current 300-source default is respected and disclosed, with no silent first-N truncation.

### Worker and safe replacement

One bounded worker processes persistent queued collections and pending pages. A run UUID fences all page commits; cancellation and a later run invalidate old work. On startup, interrupted running collections receive a new queued run. Fetch outside transactions through DirectPageReader with a scope checked before every redirect and the existing DNS/size/time guards. On success, chunk using existing source chunk options and enforce chunk limits. In a short transaction, take owner folder lock, current run lock, then source/page locks; reuse/create the ordinary source, compare its current chunk text, and replace changed chunks plus disposable vectors atomically. Retain the source's metadata, reading state and all study relationships. Queue only embedding after commit. Failed or empty fetch leaves old chunks intact. Source IDs survive refresh; historical card evidence already has snapshots for superseded chunks.

Update is explicit: rediscover first, then persist new selected page jobs and queue existing non-deleted pages atomically. Missing index pages are marked for attention without deletion. Deleted sources are tombstones, not import candidates. Folder deletion stops further commits. Capacity exhaustion is visible and retryable, never a partial invisible truncation. Drain stops claims and aborts current fetch; pending work remains durable. Integrate worker snapshot with readiness and shutdown.

### Web

Add a documentation entry to the library add dialog. The dedicated preview dialog shows root, editable title, locale, hierarchical section checkboxes, capacity and an explicit Import button. Connected documentation rows show state and counts with Open folder, Check for updates/resume, Cancel and confirmed Disconnect. Disconnect deletes only collection/page metadata; materials and folders remain. Selection rules support nested exclusions and re-inclusions; the most specific prefix wins. Active queued imports reserve capacity so concurrent confirmations cannot oversubscribe it. Poll only while work is active; discard late account/unmount results. Opening its folder switches to the existing compact library list. Use existing transient-layer dialogs and design-system controls; add both locales and responsive CSS.

## Risks / Trade-offs

- [Large documentation exceeds the normal library limit] → show capacity before confirm and select smaller branches; no hidden quota increase.
- [Navigation-only indexes are incomplete] → show the discovered tree honestly; no promise of exhaustive arbitrary-site crawling.
- [Updated text invalidates old text locators] → retain historical card evidence and source-level work; never relabel old excerpts as current text.
- [A site is unavailable] → preserve saved chunks and show per-page failures; retry is explicit.

## Migration Plan

Generate an additive migration after 0049 with UUIDv7 defaults, owner/run indexes, uniqueness and FKs. Test from a fresh migration-built database. Deploy API/schema before web. Web rollback is compatible; leave collection/page tables and source text in place. An old API ignores queued import jobs, which resume with the compatible worker. No destructive backfill or schema push.
