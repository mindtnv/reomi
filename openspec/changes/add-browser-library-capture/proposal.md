# Proposal

## Why

Saving a page currently requires switching to Reomi and the server may not see the rendered article or selected passage. Browser capture should feed the library first, so subsequent cards and notebooks retain an owned source.

## What Changes

- Add a browser extension with explicit page/selection capture, destination choice, a keyboard shortcut and a selection context menu.
- Add a revocable capture-only token and narrowly scoped capture API; existing MCP tokens keep their privileges.
- Save readable text and the original URL as ordinary library materials, defaulting to the existing browser folder. Retry receipts prevent duplicate writes; repeated unchanged captures reuse their material.
- Offer Save and Save + create card. The latter opens the existing Reomi card editor with the saved source, quote and deck picker; AI suggestions remain optional and review precedes saving.
- Build reproducible Chromium and Firefox packages and document manual installation. Store publication, silent browsing/history collection, background crawling and automatic card insertion are non-goals.

## Capabilities

### New Capabilities
- `browser-library-capture`: Explicit rendered-content capture, library persistence, scoped transport, retry recovery and source-aware card handoff.

### Modified Capabilities
- `personal-access-tokens`: Add capture-only credentials and reject them at the MCP boundary.

## Impact

New extension workspace and build packages; API capture routes, source chunks and capture receipts; token schema/check constraint; Settings and source-reader handoff. Additive generated migration follows documentation scheduling. Ordinary library reading works without AI. No cookie-sharing changes or broad REST bearer authentication.
