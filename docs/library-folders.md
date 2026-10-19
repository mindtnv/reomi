# Library folders

Issue: [#95](https://github.com/mindtnv/reomi/issues/95).

The library stores sources. Folders organize those sources; notebooks reference them and cards retain their evidence. Moving a source never changes its identity or its content timestamp. Existing sources start in Unfiled, and All materials includes every active source.

## Behavior

Folders can be nested, renamed and moved. Siblings are shown alphabetically and names are unique without case distinctions inside one parent. A source has one folder location. Folder views and both search modes include descendants. The compact toolbar keeps search and adding material visible, with extra filters and sorting behind a named disclosure and an active-filter count. On phones the folder tree also collapses so materials remain visible. The UI provides single and explicit batch moves, counts over the complete corpus and breadcrumbs; the current scope survives leaving and returning to the library.

Deleting a folder previews its complete subtree and material counts, asks where materials should go, and confirms the current state. Unfiled is the default destination. The operation removes folders after moving their sources; original files, notebook links, reading positions, card evidence and schedules remain intact. A changed preview returns `folder_changed` without writing.

The browser-default folder is ordinary: it can be renamed, moved and deleted. An explicit ensure request returns it or creates one. Removing it does not create an immediate replacement. A future extension (#91) can ensure the default or choose a specific owned folder. An explicitly chosen unavailable folder returns an error.

## API

All endpoints use the existing session authentication and derive ownership from it.

| Method | Path | Contract |
| --- | --- | --- |
| GET | `/library/folders` | Folder rows, direct/subtree counts, total and unfiled counts |
| POST | `/library/folders` | `name`, optional nullable `parentId` |
| PATCH | `/library/folders/:id` | Current `revision`, optional `name` / nullable `parentId` |
| GET | `/library/folders/:id/delete-preview` | `folderCount`, `materialCount`, `confirmationToken` |
| DELETE | `/library/folders/:id` | Current confirmation token, optional nullable `destinationId` outside the subtree |
| POST | `/library/folders/move-items` | 1–1000 `sourceIds`, nullable `folderId`; the batch is atomic |
| POST | `/library/folders/browser-default` | Optional `name`; explicit idempotent default acquisition |

Library list/search accept optional `folderId`: a UUID scopes the subtree; `unfiled` scopes unfiled sources; omission means All. Inline material creation and upload presign accept an optional destination. Library cursors are opaque and must be replayed unchanged. Their timestamp keys retain SQL microseconds, including equal timestamps from bulk additions. Older added-sort cursors remain accepted.

Limits are 1000 folders per owner, depth 20, and 100 characters per normalized folder name. Mutations serialize per owner, edits check revisions and subtree deletion revalidates the preview inside its transaction. Material placement advances metadata revision only, preserving evidence content versions.

## Migration and rollout

`0048_outgoing_starhawk.sql` adds the folders table, a nullable `sources.folder_id`, ownership/placement indexes, sibling-name uniqueness and one designated browser folder per user. `0049_library_folder_metadata_revision.sql` extends the existing metadata revision trigger to include folder placement; explicit revision assignments alone would be overwritten by that trigger. Neither migration rewrites or deletes existing sources. Build local and test databases through the committed migration chain; schema push is not a substitute.

Deploy the API before the web through the checked immutable-image workflow. Verify both application's health, folder CRUD, scoped listing and content-preserving deletion. The browser regression creates uniquely owned fixtures and cleans only its own IDs; production uses the established smoke account.

Rollback the web and then API to the previous immutable image tags. Keep the additive migration and placement data. Old clients continue to see all sources. Do not drop folders or sources as a release rollback.

## Evidence

- `apps/api/tests/library-folders.test.ts`: nested CRUD, conflicts, ownership, concurrency, placement, unchanged reading/notebook/card state, safe deletion, default-folder lifecycle and complete scoped discovery.
- `e2e/library-folders.e2e.ts`: real create/rename, single/batch movement, hierarchy movement, reload persistence and safe deletion; browser/standalone screenshots at desktop and phone widths.
- `apps/web/src/components/screens/library-navigation.test.tsx`: restored folder scope is included in the first library query.

Reviewed browser evidence is under [`docs/library-folders/`](library-folders/): normal and standalone desktop/mobile views, expanded filters and hierarchy, and Russian views at 390px and 320px. The browser asserts a collapsed phone toolbar below 120px at 390px and that every toolbar button remains inside its container at every captured width.

## Release

[PR #96](https://github.com/mindtnv/reomi/pull/96) shipped as `8a123fdb29564fe74fb14316f44ba9fe481c0219`. Both applications were healthy on that tag; [deployment](https://github.com/mindtnv/reomi/actions/runs/39271528418), [production smoke](https://github.com/mindtnv/reomi/actions/runs/39272673026) and read-only catalog verification passed. The production folder scenario retained its source IDs through movement and populated subtree deletion.

Durable contract: [`library-folders`](../openspec/specs/library-folders/spec.md). Full acceptance evidence: [`2026-10-19-add-library-folders`](../openspec/changes/archive/2026-10-19-add-library-folders/acceptance.md).
