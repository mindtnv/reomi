# Tasks

## 1. Credential and persistence boundary

- [ ] 1.1 Add failing integration tests for capture scope, revoked/foreign credentials, MCP rejection, quota/destination atomicity, replay and changed/deleted source reuse.
- [ ] 1.2 Implement the generated additive migration, capture-only API and library source transaction; pass those tests against the committed migration chain.
- [ ] 1.3 Expose capture credentials in bilingual Settings and verify creation/revocation with the existing token tests.

## 2. Capture and study workflow

- [ ] 2.1 Implement explicit page/selection extraction and test form exclusion, unsupported schemes, empty/large text and navigation races.
- [ ] 2.2 Build the styled popup, default/selected folders, saved result, reconnect/retry and context-menu/keyboard entry points; verify in an actual loaded Chromium extension.
- [ ] 2.3 Implement the owned reader handoff into the existing reviewed card editor; test source/version isolation and confirm a saved card retains its source backlink.

## 3. Distribution and release

- [ ] 3.1 Produce reproducible Chromium/Firefox zip packages and install/privacy documentation; validate manifests and record actual browser coverage.
- [ ] 3.2 Review normal/standalone UI screenshots, mobile/keyboard behavior, strict OpenSpec, types, lint, full migrated tests, real S3, builds and browser smoke.
- [ ] 3.3 Publish and attach the reviewed PR, merge green checks, verify the production release and reconcile issue #91 with delivered artifacts and remaining external signing/device checks.
