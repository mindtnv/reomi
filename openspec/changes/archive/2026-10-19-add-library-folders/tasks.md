# Tasks

## 1. Hierarchy and placement

- [x] 1.1 Add failing API scenarios for nested CRUD, isolation, cycles and stale revisions; implement the owned hierarchy and generated additive migration, then pass those scenarios on the committed migration chain.
- [x] 1.2 Add source-identity and mixed-ownership batch tests; implement single/batch placement and optional new-material destinations, then verify unchanged content versions, reading state and downstream links.
- [x] 1.3 Add stale-preview and safe-delete scenarios; implement confirmed subtree deletion with external destination and verify atomic preservation of sources and relationships.
- [x] 1.4 Add concurrent browser-default and recreation scenarios; verify idempotent default acquisition and rejection of stale explicit destinations.

## 2. Scoped discovery and interface

- [x] 2.1 Add scoped title/content retrieval, complete-count and multi-page tests; implement subtree/unfiled filters and stable cursors for every supported sort, then pass the API scenarios.
- [x] 2.2 Implement translated folder hierarchy, breadcrumbs, create/rename/move/delete dialogs and single/batch source movement with DS controls; verify keyboard actions, scope restoration, stale selection clearing and error states in component/browser checks.
- [x] 2.3 Capture and inspect desktop/mobile and standalone screenshots of the changed library; exercise real folder/source persistence and deletion in the local browser with assertions.

## 3. Release and closure

- [x] 3.1 Update CLAUDE.md then mirror AGENTS.md and record migration/rollback; after final edits pass strict OpenSpec, typecheck, lint, fresh migration-faithful test:ci, required S3 round trips, production build and existing browser smoke.
- [x] 3.2 Open and review the PR with browser evidence, resolve findings and merge only after required checks pass; record the PR and release commit.
- [x] 3.3 Verify the production deployment and API/web health plus the folder workflow, then archive this change with its durable spec, publish the archive and close #95 with release evidence.
