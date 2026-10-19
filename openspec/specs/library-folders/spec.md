# Library folders Specification

## Purpose

Let each learner organize their library sources in a persistent folder hierarchy while preserving source identity and every reading, notebook and card relationship.

## Requirements

### Requirement: Owned folder hierarchy
The system SHALL let a signed-in user create, rename and move nested folders. Folder names SHALL be trimmed, nonempty, at most 100 characters, and unique without case distinctions among siblings. Siblings SHALL be ordered alphabetically. The hierarchy SHALL reject cycles and references to another user's folders and SHALL persist across reloads and devices.

#### Scenario: Reorganize a hierarchy
- **WHEN** the learner creates a child folder, renames it and moves it to another owned parent
- **THEN** its identity and descendants remain intact and the changed hierarchy is returned on a new session

#### Scenario: Concurrent cycle or stale edit
- **WHEN** concurrent moves would form a cycle or an edit supplies an obsolete folder revision
- **THEN** the conflicting mutation is rejected without partially changing the hierarchy

### Requirement: Identity-preserving material placement
Each source SHALL occupy at most one folder. The system SHALL support single and bounded batch moves, optional folder placement on new library materials, All materials and Unfiled. Moving SHALL preserve source IDs, text and evidence versions, original files, reading state, notebook links, cards and schedules. A batch with any missing or foreign source or destination SHALL change nothing.

#### Scenario: Move linked materials
- **WHEN** the learner moves sources with reading history, notebook membership and card evidence into a folder
- **THEN** those same sources appear there with all prior relationships unchanged

#### Scenario: Existing sources and unauthorized placement
- **WHEN** folders are introduced or a caller supplies a foreign destination
- **THEN** existing sources remain available as unfiled and unauthorized placement is rejected

### Requirement: Complete scoped discovery
Folder views, material counts, title search and content search SHALL cover the selected folder and its descendants. Unfiled SHALL match only sources without a folder. All materials SHALL include every owned active source. Listing SHALL retain stable pagination for every supported sort and SHALL apply folder scope before limiting search results. Counts SHALL cover the complete corpus, not the loaded page.

#### Scenario: Search a large subtree
- **WHEN** more sources than one page exist across a folder and its children
- **THEN** scoped counts include them all, pagination reaches every match and neither search mode returns another subtree's materials

#### Scenario: Search unavailable
- **WHEN** semantic search is unavailable or folder loading fails
- **THEN** the UI presents the appropriate unavailable or retry state and ordinary library browsing remains usable

### Requirement: Confirmed content-preserving folder deletion
The system SHALL preview the full affected folder and source counts before deleting a subtree. Explicit confirmation SHALL bind to the current subtree state. Deletion SHALL move every affected source to Unfiled by default or an explicitly selected owned folder outside the subtree before removing folders. A stale preview SHALL be rejected. Deleting folders SHALL NOT delete source content, files, reading state, notebook links, cards or study history.

#### Scenario: Delete a populated subtree
- **WHEN** the learner confirms a current preview with an owned destination outside that subtree
- **THEN** all affected sources are moved atomically, the subtree is removed and the previewed source identities survive

#### Scenario: Contents changed after preview
- **WHEN** a source enters or leaves the subtree, or its hierarchy changes, after preview
- **THEN** the old confirmation is rejected and the learner can request a new preview

### Requirement: Ordinary browser-default folder
The system SHALL expose an idempotent way to obtain or create one browser-default folder per user. It SHALL be an ordinary renameable and movable folder. Deleting it SHALL preserve its materials; a later explicit default-folder request SHALL create a replacement. An explicitly selected deleted or foreign destination SHALL fail instead of silently redirecting a save.

#### Scenario: Repeated initialization and deleted default
- **WHEN** concurrent default requests occur, followed later by deletion and another default request
- **THEN** initialization produces one folder, deletion preserves sources, and only the later request creates a replacement

### Requirement: Accessible bilingual folder controls
The library SHALL expose hierarchy navigation, breadcrumbs, folder actions and material selection/movement through design-system controls usable with keyboard and at phone widths. Copy SHALL be available in Russian and English. Selected folder scope SHALL survive navigation away and back; changing scope SHALL clear obsolete material selections.

#### Scenario: Mobile and keyboard organization
- **WHEN** a learner navigates folders and moves a selected material using the keyboard or a narrow viewport
- **THEN** all actions are reachable through named controls and dialogs, and the resulting folder and material can be verified after reload
