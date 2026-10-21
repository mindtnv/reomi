# Proposal

## Why

Saving a documentation homepage imports only its landing text. A learner should be able to connect Kubernetes documentation once, choose its sections, and receive separate readable library sources without adding every URL manually.

## What Changes

- Add a documentation import entry to the library alongside single-page URL import.
- Preview the detected root, locale, section tree, page counts, and available library capacity before confirmation. Recognize documentation landing paths such as `/docs/home/` without silently extending a single-page import.
- Save selected sections into an ordinary library folder hierarchy. Every page is a normal owned URL source usable by the reader, notebooks, notes, and card provenance.
- Persist background import progress with cancellation, retry, and restart recovery. A failed page does not block siblings.
- Disconnect a collection without removing any imported material or folder.
- Offer an explicit Check for updates action. Add newly discovered selected pages, refresh changed text without duplicate sources, and preserve old content on fetch failure. Never delete saved pages or resurrect explicitly deleted materials automatically.
- Present connected documentation as compact, bilingual collection rows with progress and folder navigation, including mobile and standalone PWA layouts.

## Capabilities

### New Capabilities

- `library-documentation-import`: confirmed section import, durable progress, identity-preserving manual synchronization, and library controls.

### Modified Capabilities

None. Existing folder organization and independently usable source study remain the foundation.

## Impact

- Additive collection/page tables and indexes; compatible API before web. Existing source and folder contracts remain valid.
- Reuse guarded documentation discovery and the existing embedding pipeline; implement successful-fetch-before-replacement for documentation text.
- Add authenticated library documentation routes, an owned background worker with shutdown drain, and library import/management UI.
- No new dependency or required secret. Parsing and reading work without AI credentials.

### Non-goals

- Scheduled synchronization, arbitrary recursive crawling, authenticated sites, or automatic flashcard generation.
- Importing translations, old releases, external sites, or unselected sections implicitly.
- Increasing existing library capacity, deleting remote-missing pages, or moving already saved sources during sync.
