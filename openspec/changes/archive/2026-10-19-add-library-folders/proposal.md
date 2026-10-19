# Proposal

## Why

The library is Reomi's source of materials for reading, notebooks and cards, but it has no folders. Issue #95 requires a persistent hierarchy that organizes those sources while preserving their identity and every downstream link.

## What Changes

- Add owned, nested folders with create, rename, move and safe subtree deletion.
- A material belongs to one folder or is unfiled. Existing sources start unfiled; All materials continues to include everything.
- Move individual materials or an explicitly selected batch without copying sources, changing content versions, or altering cards, notebook membership and reading state.
- Browse the hierarchy with breadcrumbs, alphabetical sibling order and complete subtree counts. Folder listing and both search modes cover the selected subtree; Unfiled covers only unfiled sources.
- Preview subtree deletion and require confirmation of its current state. Move the subtree's materials to Unfiled or another owned folder before removing folders.
- Let new library uploads, URLs and text choose a folder. Define an idempotent ordinary browser-default folder for the future extension in #91; a deleted default is recreated only on an explicit default-folder request.
- Ship responsive, keyboard-accessible controls in English and Russian using existing design-system primitives.

## Capabilities

### New Capabilities

- `library-folders`: owned source hierarchy, scoped discovery, identity-preserving placement and safe deletion.

### Modified Capabilities

None. Existing source, card, notebook and MCP authorization contracts remain intact.

## Impact

- Database: additive folders table and nullable source placement, with indexes and a versioned migration. Existing source and evidence IDs remain unchanged.
- API: session-authenticated library folder routes; additive folder filters and optional create/upload placement. No general bearer REST access.
- Web: library folder navigation, breadcrumbs, folder actions, explicit material selection and move dialogs; folder scope retained in navigation state.
- Deployment: API before web. On rollback keep the additive schema and folder data; old clients continue to list all sources.

### Non-goals

- Implementing the browser extension, changing its authentication, or collecting page text.
- Multiple folder memberships, collaboration, arbitrary drag-and-drop ordering, or automatic reorganization of existing materials.
- Deleting source content through folder deletion, modifying notebook membership, or changing card content or FSRS schedules.
- Changing unrelated material ingestion or generation workflows.
