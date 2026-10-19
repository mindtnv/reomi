# Design

## Context

See proposal.md for motivation and issue #95. Sources already live independently of notebooks; `card_sources` and notebook joins refer to source IDs. Library list/search and source lifecycle helpers are shared. The screen uses session-scoped resources and navigation-journal fields. Existing metadata revisions are distinct from content `updatedAt`, which evidence validation relies on.

## Goals / Non-Goals

Preserve the source graph while adding folder placement and complete scoped discovery. Keep session REST authentication and existing MCP contracts. Browser capture itself and multi-folder memberships are outside this change.

## Decisions

### One source location and alphabetical siblings

Add `library_folders` with UUIDv7 id, owner, nullable parent, name, integer revision and optional `browser` purpose. Add nullable `sources.folder_id`. A source has one location; tags and notebook membership already cover overlapping thematic views. Normalize names with NFC and trim; reject blank/overlong names and duplicate case-folded sibling names. Alphabetical ordering avoids a second independent ordering workflow. Bound a user's tree to 1000 folders and depth 20.

### Serialize ownership-sensitive placement

Folder mutations and placement use a per-owner transaction advisory lock. Revalidate ownership and tree constraints after locking. Folder edits carry a revision. Batch source moves lock every selected source, verify the entire selection, then update only folder placement and metadata revision. Content timestamps, chunks, reading state and downstream links are untouched. Source creation validates its optional destination under the same owner lock. FKs use SET NULL for folder removal as a final content-preserving safeguard.

### Scope before pagination or retrieval

The folder listing returns direct/subtree counts calculated from complete source aggregates. The list accepts `folderId` (UUID or `unfiled`); omitted means All. Resolve the bounded owned subtree, then apply its predicate before all list filters and limits. Semantic search applies the same scope to its ready-source whitelist before vector retrieval. Stable sort-specific cursors handle added, title and last-read order, each with deterministic id ties.

### Preview safe subtree deletion

Preview hashes the sorted subtree (ids, parent ids, revisions) and its source placements. Confirmation re-locks and recomputes that state. A mismatch is 409. Move all subtree sources to the requested external destination (default Unfiled) and delete the subtree in one transaction. Counts include pending sources. Foreign destinations and destinations within the deleted subtree fail before any write.

### Ordinary default and additive creation inputs

A partial unique index on (owner,purpose) where purpose is set gives one browser default. Explicit ensure requests create it only when missing. Rename and move preserve its purpose; delete removes that designation with the folder. New URL/text and file presign inputs accept optional folderId. Existing callers omit it and remain unfiled. The future extension can ensure a default or choose a specific folder, then use the same placement contract.

### Screen-local hierarchy with accessible actions

Reuse the library screen and session resource cache. A folder navigation component provides All, Unfiled, nested folder links, breadcrumbs and named action buttons. Move and deletion destination pickers use the existing dialog system and searchable select. Material selection uses the DS Checkbox. Scope is a navigation-journal field. Selection clears on scope/filter changes; late results after account changes cannot repopulate another user's screen. Folder failures show a retry control and leave All browsing accessible. Search and adding materials stay visible in a compact toolbar; extra filters and sorting use a disclosure with an active-count indicator. The phone folder tree is collapsible, and toolbar actions wrap when needed rather than being clipped. A menu/dialog path works on touch and keyboard; drag-and-drop is not required for this release.

## Risks / Trade-offs

- Large trees: bound count/depth, aggregate counts before rendering and paginate material results.
- Stale dialogs: folder revisions and deletion-state confirmations reject obsolete mutations.
- Evidence drift: placement never updates source content timestamps or regenerates chunks.
- Rollout mismatch: deploy additive schema/API before the web; retain schema on rollback.

The existing source metadata trigger overwrites explicit revision assignments. Migration `0049_library_folder_metadata_revision.sql` therefore adds folder placement to its compared fields; placement increases metadata revision while the source content timestamp stays unchanged.

## Migration Plan

Generate and commit a Drizzle migration after the current journal head. Add the owned folders table, parent/owner indexes, normalized sibling/default uniqueness, nullable source FK and owner/folder index. Existing sources need no data rewrite. Apply the committed chain to fresh dev/test databases; never use schema push.

Ship API before web through the existing checked image deployment. Verify readiness, folder CRUD, safe deletion and existing source access. Roll back web then API to previous immutable tags; keep the additive table and column so placement survives. Any future schema removal must first preserve folder placement externally and drop the source FK/column before the folder table. No production source rows are deleted for rollback.
