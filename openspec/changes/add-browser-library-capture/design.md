# Design

## Context

The library already owns normal sources, chunks, a browser-default folder and card evidence. Existing personal tokens authorize MCP read/write scopes; general REST uses cookie sessions. Reuse these boundaries and the source quick-card dialog rather than introducing a second card writer in the extension.

## Goals / Non-Goals

Deliver explicit capture into the ordinary library and one reviewed card per Create card action. Page capture and selection capture are visible modes. Bulk AI generation, automatic scheduling, history collection, cookie extraction, stores/signing accounts and background page access are outside this MVP. The extension never receives an AI key or a Reomi session cookie.

## Decisions

1. **Capture-only token.** Add `capture` to personal-token scope, display/revoke it in Settings, and reject it before MCP session initialization. Only `/extension` endpoints accept it: connection metadata/folders and capture submission/receipt. Cookie-only requests, MCP scopes and URL tokens fail there. No general REST authentication changes. Fixed official API origin in release packages; explicit localhost origin only in development builds. Browser host permissions authorize extension-origin fetches without broadening website CORS.
2. **Explicit isolated capture.** MV3 `activeTab`, `scripting`, `storage`, `contextMenus` and the official API host; no all-site host permission, content-script watcher, history or cookies permission. A bundled Readability script operates on a sanitized cloned document after a user click. Remove forms, input/textarea values, scripts, hidden/editable fields. Selection mode accepts only visible non-editable text. Reject unsupported schemes, empty/unreadable content and over-limit text (200k characters) without silently truncating. Show title, original URL, mode and size before upload. Never fetch the captured URL on the server.
3. **Library snapshots and retry receipts.** A new owner-scoped receipt table records client request key, request digest, content key, source ID (SET NULL on delete), saved quote and source fingerprint. Lock the same owner/folder boundary as library creation; validate destination and capacity in the transaction. Missing destination fails; omitted destination uses the ordinary browser-default folder. Same request key/body replays its receipt, changed body conflicts. Repeated identical content reuses a live unchanged captured source, without moving or replacing it. A later explicit save after deletion creates a new source; retry of the deleted receipt reports unavailable. Changed captures create a new snapshot rather than overwrite studied text. Source/chunks commit together and derived embeddings are queued afterward.
4. **Card handoff.** Save succeeds before opening an owned source route. A receipt ID in the URL carries no content or credential. The signed-in web reader retrieves its own receipt, verifies the live source/version and opens the existing QuickCard dialog; manual edit, deck selection and optional AI suggestion stay there. A capture from another account fails closed. Whole-page mode opens the reader/card workflow without claiming an arbitrary excerpt covers the whole page. Selection mode supplies the captured quote. Nothing auto-saves a card.
5. **Browser packages.** One TypeScript source with generated Chromium MV3 service-worker and Firefox MV3 background-script manifests. Produce deterministic zip artifacts and document Chrome/Edge/Yandex developer-mode installation and Firefox temporary loading. Validate Chromium with the actual loaded extension. Firefox store signing and actual browser/device acceptance remain separately recorded if unavailable.

## Risks / Trade-offs

- Token stored locally → trusted extension contexts only where supported, never sync storage, content scripts, web URLs or logs; revoke in Settings.
- Authenticated pages may contain private text → explicit preview/save only; selection mode excludes forms/editors and can save a narrow passage.
- Navigation during capture → bind capture to the selected tab and captured URL; return clear failure rather than saving a different page.
- Readability misses application content → offer selection mode, preserve the page URL, and show empty/unsupported errors.
- Uncertain server response → preserve request key/body for Retry; never report success before a receipt.
- Existing source changes after capture → verify fingerprint before reuse/handoff; no silent update or invented quote evidence.
- AI costs → no AI call on capture; an explicit suggestion uses existing per-source cooldown and source-length limits, and manual cards work without AI.

## Migration Plan

Generate the next additive migration after documentation scheduling: expand the scope constraint, create receipt ownership/source foreign keys and owner/request-key uniqueness plus owner/content-key lookup index. Deploy API/schema before web and extension. Roll back web/extension first; retain receipts, sources and scope values. An older API must not accept capture tokens as MCP read credentials, so server rollback requires disabling/revoking capture tokens or keeping the capture-scope rejection patch.

## Delivery Estimate

MVP engineering estimate: 4–7 days for capture/token/source transaction, popup/handoff, packaging and cross-browser acceptance. Store review/signing is external lead time. This task implements and verifies the available scope now; the estimate is planning context, not a completion claim.
