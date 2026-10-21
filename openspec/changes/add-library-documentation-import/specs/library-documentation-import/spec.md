# Spec Delta

## Purpose

Let a learner connect selected documentation sections to the library as independent readable sources, then explicitly synchronize their content without losing saved study work.

## ADDED Requirements

### Requirement: Documentation scope is previewed before import
The library SHALL offer distinct single-page and documentation imports. Documentation discovery SHALL show the normalized root, locale, selectable hierarchical sections, page counts, and library capacity before confirmation. A landing URL such as `/docs/home/` SHALL offer `/docs/` explicitly. Discovery SHALL remain on the chosen origin and documentation subtree, use one language and version, reject private destinations, and avoid recursive content crawling. Preview alone SHALL create no library material or folder. Empty or unavailable discovery SHALL expose a retryable error.

#### Scenario: Preview Kubernetes
- **WHEN** the learner previews `https://kubernetes.io/docs/home/`
- **THEN** the displayed root is `/docs/`, Concepts and Tasks can be selected separately, and no source or folder has been created

#### Scenario: Invalid scope
- **WHEN** a link or redirect points at another origin, a private destination, another locale, or outside the selected documentation subtree
- **THEN** it is not imported

### Requirement: Confirmation creates ordinary library materials
Confirmation SHALL bind to an owned, unexpired discovery preview and explicit section selection. It SHALL preserve normal library and folder limits, reject unknown sections and over-capacity selections without partial writes, and create a named ordinary folder with section subfolders. Each selected canonical page SHALL resolve to at most one active owned URL source; existing sources SHALL retain their identity and placement. Replaying confirmation SHALL not create duplicates. No notebook, card, or study artifact SHALL be generated automatically.

#### Scenario: Confirm selected sections
- **WHEN** the learner confirms only the Workloads section
- **THEN** its pages become normal URL sources in the documentation hierarchy, unrelated sections are excluded, and existing matching sources are reused

#### Scenario: Expired or oversized selection
- **WHEN** a preview expires or the selected pages exceed current capacity
- **THEN** confirmation fails clearly without creating folders or materials

### Requirement: Background import is durable and controllable
Accepted imports SHALL expose persistent total, completed, failed, and remaining page counts. Work SHALL resume after an API restart. Cancellation SHALL stop new page commits while preserving completed materials. An explicit resume or update SHALL retry incomplete pages; one page failure SHALL not prevent siblings from importing. A deleted destination folder SHALL stop further writes with a visible error rather than redirecting materials. Stale work from a cancelled or replaced run SHALL not overwrite current results.

#### Scenario: Partial failure and restart
- **WHEN** a page fails and the API restarts during another page
- **THEN** completed pages remain, remaining work resumes, the failed page is visible, and retry does not duplicate sources

#### Scenario: Cancel during a fetch
- **WHEN** a learner cancels while a page is being fetched
- **THEN** that late fetch cannot commit and previously completed pages remain readable

### Requirement: Manual synchronization preserves source identity and study work
Check for updates SHALL rediscover only the confirmed scope, add new selected pages within current capacity, and check saved pages for changed readable content. Unchanged content SHALL retain its chunks. Successful changed content SHALL replace text atomically while retaining source identity, user metadata, placement, reading state, notebook memberships, saved notes, and cards with historical evidence. Failed or empty fetches and pages absent from the new index SHALL preserve saved content and expose attention states. Explicitly deleted sources SHALL not be recreated by synchronization.

#### Scenario: Changed and unchanged pages
- **WHEN** synchronization finds one changed page, one unchanged page, and one new selected page
- **THEN** the changed source retains its identity and study links, unchanged chunks retain their identities, and the new page is added once

#### Scenario: Remote failure or explicit deletion
- **WHEN** a remote page disappears or an imported source was explicitly deleted
- **THEN** a remote failure preserves existing text and synchronization does not resurrect the explicitly deleted source

### Requirement: Disconnect preserves imported work
The learner SHALL be able to explicitly disconnect an owned documentation collection after a clear UI confirmation. Disconnect SHALL stop further import commits and remove its import relationship while preserving all library sources, folders, notes, notebook memberships, and cards.

#### Scenario: Disconnect an imported collection
- **WHEN** the learner confirms disconnecting documentation
- **THEN** it disappears from connected documentation and its previously imported materials remain in their existing folders

### Requirement: Documentation controls are isolated and accessible
Every preview, collection, page, and control SHALL be scoped to the authenticated owner. Another account SHALL not read or mutate it. Import and collection controls SHALL use the project design system with Russian and English copy, keyboard access, mobile layout, and standalone PWA support. Connected collections SHALL expose compact progress, an Open folder action, Check for updates, and cancellation while running. Folder browsing SHALL offer a compact list suitable for documentation. Discovery, import, and reading SHALL remain available without AI credentials; unrelated library operations SHALL remain usable on import failure.

#### Scenario: Another account
- **WHEN** a caller supplies another owner's preview or collection ID
- **THEN** the route returns not found and changes nothing

#### Scenario: No AI and a narrow viewport
- **WHEN** AI credentials are absent and the learner imports documentation using keyboard controls on a phone-width or standalone surface
- **THEN** discovery, progress, folder navigation, and ordinary source reading remain usable
