## Purpose

Let a learner explicitly save visible browser material into an owned library source and continue studying it with preserved origin and reviewed cards.

## ADDED Requirements

### Requirement: Explicit browser capture
The extension SHALL capture a rendered page or selected visible passage only after a user action. The preview SHALL identify title, URL, mode and destination. Form values, password fields and editable content SHALL NOT be collected. Unsupported schemes, unreadable pages and excessive content SHALL produce an actionable error without an upload. Release permissions SHALL NOT enable silent browsing-history collection.

#### Scenario: Save a rendered article
- **WHEN** a learner opens the extension on a readable page and confirms Save
- **THEN** the displayed text is sent once with its original URL and chosen destination

#### Scenario: Protected or unsupported content
- **WHEN** capture targets an internal browser page, editor field or empty article
- **THEN** no material is uploaded and the extension explains how to choose readable text

### Requirement: Scoped library persistence
Capture SHALL require an unexpired unrevoked capture credential and derive ownership from it. It SHALL create ordinary readable library sources without a server refetch or AI dependency, using the browser-default folder when no destination is supplied. Foreign/deleted destinations and library limits SHALL reject the whole write. Capture credentials SHALL NOT authorize arbitrary library reads, MCP or account administration.

#### Scenario: Save without AI
- **WHEN** a valid capture is saved while AI is unavailable
- **THEN** the material remains readable and can be attached to a notebook or studied manually

#### Scenario: Invalid authorization or destination
- **WHEN** a request uses a revoked token, cookie-only authentication or another owner's destination
- **THEN** it creates no source or receipt and exposes no private material

### Requirement: Recoverable capture writes
Retries of the same request SHALL resolve to the same receipt and source, while changed arguments with that request identity SHALL conflict. Repeated identical captures SHALL reuse a live unchanged captured material without moving it. Changed content SHALL preserve earlier studied snapshots. Deleting a material SHALL invalidate old receipt links; retrying an old request SHALL NOT recreate it.

#### Scenario: Lost save response
- **WHEN** the save commits but the extension loses its response and retries
- **THEN** it receives the original receipt without creating a duplicate

#### Scenario: Changed or deleted saved material
- **WHEN** the learner explicitly saves content again after the old material changed or was deleted
- **THEN** a new valid snapshot can be saved while prior study work remains intact

### Requirement: Library-first reviewed card handoff
Save + create card SHALL first persist the material, then open an owned Reomi card workflow retaining the source and available selected quote. The learner SHALL be able to choose a deck, edit content and request an optional AI suggestion before explicit card save. A different signed-in account or stale/deleted source SHALL not receive captured private text or fabricate current evidence. Saving a source alone SHALL never generate or insert cards.

#### Scenario: Create a card from a passage
- **WHEN** the learner saves a selected passage and chooses Create card
- **THEN** the editor opens with its saved source, exposes the draft and destination, and only an explicit save creates the card and backlink

#### Scenario: Account mismatch
- **WHEN** the browser token and signed-in web account belong to different people
- **THEN** the handoff returns unavailable and no private captured quote is disclosed

### Requirement: Installable and recoverable extension
The project SHALL provide reproducible Chromium and Firefox packages and installation instructions. Popup, selection context menu and keyboard entry points SHALL converge on the same preview/save flow. Network failures SHALL retain a retryable draft; token rejection SHALL allow reconnecting without exposing the credential to the page. Actual browser compatibility SHALL be distinguished from manifest-only or emulated checks.

#### Scenario: Retry after reconnecting
- **WHEN** a capture fails because its credential expired
- **THEN** the learner can replace the token and retry through a visible save action
