# Acceptance evidence

Issue: [#95](https://github.com/mindtnv/reomi/issues/95). Implementation PR: [#96](https://github.com/mindtnv/reomi/pull/96).

## Repository verification — 2026-10-19

- A new disposable database, `reomi95rc_test`, was built through the complete committed migration chain including `0048_outgoing_starhawk.sql` and `0049_library_folder_metadata_revision.sql`.
- `bun run test:ci`: 3530 passed, 0 failed, 18311 assertions across 334 files.
- Required real-S3 round trips: 21 passed, 0 failed, 122 assertions against local MinIO.
- Workspace typecheck, web lint, strict OpenSpec (31 items) and final API/web production build passed.
- Focused folder API and UI checks cover ownership, conflicts, concurrent cycle/default requests, stable scoped pagination for all sorts, semantic candidate scoping, optional new-source placement, atomic batch moves and safe subtree deletion.
- Identity tests retain source content timestamps, reading position, notebook edges, card evidence and the complete card/schedule row across placement and folder deletion.
- Navigation checks restore scope, clear selected materials and reject a late page from the previous folder.

The disposable PostgreSQL instance used shorter checkpoint intervals after a migration fixture waited on `IPC/CheckpointDone`. No test assertions or migration-test deadlines were changed.

The final [CI run](https://github.com/mindtnv/reomi/actions/runs/39270458955) passed all three jobs for `f9583603cb2dd0b08d50f19e90b1da10edf567b1`. Review reproduced and fixed two regressions: the old metadata trigger overwrote explicit placement revision updates, and millisecond cursor keys skipped bulk-created sources with identical microsecond timestamps. The regression suite now verifies both.

## Browser verification

The existing complete local browser suite passed (5 passes; one explicit live-AI assertion skipped because a provider key was not configured). The final folder walk passed after the UI refinements and scans its artifacts for secrets.

The walk creates/renames nested folders, adds three real text sources, performs individual and batch moves, moves the hierarchy, reloads the chosen scope and safely deletes the populated subtree. It verifies the same source IDs survive unfiled. Production fixtures have unique names and only their own IDs are cleaned.

Nine screenshots under `docs/library-folders/` were inspected: desktop and phone, normal and standalone display modes, expanded filter and folder panels, and Russian at 390px and 320px. Assertions check no document overflow, every toolbar control inside its container, and the default 390px phone toolbar below 120px.

Semantic search is unavailable locally without an embedding provider; scoped retrieval is separately exercised with fixture vectors. This does not block ordinary reading or organization.

## Closure hardening

PR #97 also preserves literal folder names in the typed client. The existing client's automatic date revival converted names such as `2026-10-19` into Date objects and could crash the tree. The folder API now uses the existing text-preserving client. A regression unit test covers date-only and ISO timestamp names; the real browser workflow creates and displays a date-named folder before renaming it. Empty folder and unfiled scopes use their own messages and an explicit add-file action. The browser asserts the folder-specific empty heading. Its additional inspected screenshot is `docs/library-folders/date-name.png`.

The closure PR's required CI verifies this final tree in addition to the original release evidence above.

## Release

The implementation was merged in [PR #96](https://github.com/mindtnv/reomi/pull/96) as `8a123fdb29564fe74fb14316f44ba9fe481c0219`.

- [Deployment 39271528418](https://github.com/mindtnv/reomi/actions/runs/39271528418) succeeded. Both Coolify applications reported `running:healthy` on that immutable tag.
- A read-only production catalog check confirmed the folder table, source placement column, placement-aware revision trigger and applied migration 0049. It selected no application records; temporary helper tasks were cleaned after confirmation.
- [Production smoke 39272673026](https://github.com/mindtnv/reomi/actions/runs/39272673026) passed: 5 passes, one local-only accessibility evidence skip. The live assistant replied. The folder workflow passed in 21.9 seconds, exercising real create/rename, individual/batch placement, hierarchy movement, reload and safe deletion under the established smoke account.
- Six added requirements were synced into `openspec/specs/library-folders/spec.md` and compared with the delta before archive. The archive closure commit publishes this evidence and closes #95 through its pull request.

The prior immutable application tag was `f603b17d377efeac670ebd0314613d1f361df1d3`. Rollback retains migrations 0048/0049 and all placement/source data.
