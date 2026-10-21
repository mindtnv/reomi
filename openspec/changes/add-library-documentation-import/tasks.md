# Tasks

## 1. Discovery and durable schema

- [x] 1.1 Add failing discovery/scope/section-selection tests, implement the reusable library discovery adapter and scoped redirects, and verify focused tests pass.
- [x] 1.2 Add collection/page schema and generated migration; verify a fresh disposable database migrates and ownership/uniqueness tests pass.

## 2. Import and synchronization

- [x] 2.1 Add failing API tests for preview, confirmation, capacity, idempotency and ownership; implement authenticated routes and verify them.
- [x] 2.2 Add failing worker tests for ordinary sources, atomic changed/unchanged refresh, failure preservation, new pages and deletion tombstones; implement and verify the complete lifecycle.
- [x] 2.3 Test cancellation, stale-run rejection, missing folders and interrupted-run recovery; wire startup, readiness and shutdown and verify targeted runtime tests.

## 3. Library interface

- [x] 3.1 Implement design-system import preview, hierarchical selection, progress and collection actions with both locales; verify typecheck, lint and focused UI tests.
- [x] 3.2 Add a browser journey for selected-section import, ordinary reading, refresh/cancel and compact folder navigation; inspect desktop/mobile and standalone PWA screenshots in both themes.

## 4. Acceptance and delivery

- [x] 4.1 Update canonical project documentation and rollout/rollback guidance; verify AGENTS mirrors CLAUDE and strict OpenSpec validation succeeds.
- [x] 4.2 Run fresh migration-faithful full tests, separate mandatory real-S3 tests, typecheck, lint, production builds and browser smoke after the final change; record acceptance evidence.
- [x] 4.3 Review the final diff, commit the feature and create/attach a pull request with validation and screenshots; record the PR URL in acceptance evidence.
