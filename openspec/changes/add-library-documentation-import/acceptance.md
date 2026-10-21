# Acceptance: library documentation import

Implementation branch: `feat/library-documentation-import`.

Pull request: [#99](https://github.com/mindtnv/reomi/pull/99).

## Contract and behavior

- Explicit section preview and confirmation, ordinary library source identity, hierarchy, quotas and capacity reservations.
- Durable import jobs with cancellation, restart recovery, retry and content-preserving disconnect.
- Manual rediscovery and synchronization; no scheduled sync or automatic cards.
- Atomic successful-fetch replacement, unchanged chunk identities, preserved notes, card schedules/evidence, reading state and notebook links.
- Canonical URL reuse, deletion tombstones, missing-page attention, private/off-origin/version-changing redirect rejection.
- Account-bound list/dialog/action state; late outgoing-account details cannot render in another account.

## Browser evidence

The complete local application smoke passed **7 scenarios**, with **1 expected live-AI skip** because no local chat provider is configured. This includes the original library quick actions/folders and the new documentation journey. Secret scanning completed successfully.

The final dedicated documentation journey passed again after UI hardening. Reviewed normal-browser and standalone PWA screenshots cover light/dark themes, English/Russian, desktop, 390 px and 320 px. See [the screenshot index](../../../docs/library-documentation/README.md).

Documentation browser endpoints are deterministic UI fixtures; ordinary source/folder creation, folder navigation, source reading and preservation are real application calls. The API suite exercises the real durable worker with deterministic guarded-fetch responses. A live Kubernetes import is not claimed from this network-restricted execution environment.

## Migration and release checks

Migration 0050 is additive and has been applied from the committed chain to a fresh `reomi_documentation_final_test` database. Legacy chain/backfill tests remain in place and now include the new chain head.

Final local gates passed: **3,556 tests, 0 failures**, across **339 files**; then the mandatory real-S3 suite passed **21 tests, 0 failures**. Typecheck across all workspaces, ESLint, production API/web builds, strict OpenSpec validation (**33 items**) and diff checks passed. The final full run includes the nested-capacity, version-redirect, account-boundary and uncertain-response regressions. PR CI is verified against the published head and recorded in the PR checks/description. Deployment order and rollback limits are documented in [library-documentation.md](../../../docs/library-documentation.md).
