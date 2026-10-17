## Purpose

Defines the observable recoverable study workspace guarantees added by the second spaced-repetition polish, preserving user content and predictable study behavior.

## ADDED Requirements

### Requirement: Recoverable writes and drafts
The system SHALL restore owner-scoped drafts and study context after reload or reauthentication and resolve retried writes without duplicate notes, grades or rewards.

#### Scenario: Recoverable writes and drafts in use
- **WHEN** a commit succeeds but the response is lost
- **THEN** retry or reconciliation returns the committed result and restores accurate session totals without another write

### Requirement: Intent-preserving authoring
The system SHALL support mapped note conversion, duplicate detection, repeated creation, copying and consistent tags while previewing changes that remove reviewed questions.

#### Scenario: Intent-preserving authoring in use
- **WHEN** an author changes fields so that an existing question disappears
- **THEN** the destructive impact is confirmed and unrelated content or history is preserved

### Requirement: Manageable collection
The system SHALL support complete scoped search counts, bulk impact and recovery, tag management, deck archive and merge, orphan recovery and keyboard navigation.

#### Scenario: Manageable collection in use
- **WHEN** a user performs an operation on a selection larger than the loaded page
- **THEN** the disclosed complete scope is processed once with user isolation and an actionable result

### Requirement: Bounded ongoing study
The system SHALL support pause, session targets, card inspection and a bounded history of completed sessions with consistent cross-tab results.

#### Scenario: Bounded ongoing study in use
- **WHEN** a long study session resumes after sleep or another client changes a card
- **THEN** time excludes pauses, stale versions are reconciled and the user retains their input

### Requirement: Isolated and recoverable operation
The system SHALL scope all data to the authenticated owner and preserve usable study and editing controls when an optional service fails.

#### Scenario: Foreign data or unavailable dependency
- **WHEN** a request references another user's resource or an optional dependency fails
- **THEN** no foreign data is exposed or modified and the user receives a recoverable result without losing unrelated work

### Requirement: Bounded local editor drafts
The note and note-type editors SHALL retain lossless local drafts scoped by authenticated owner and note/type identity, with a separate creation slot. The browser SHALL offer explicit restore or discard after reload, preserve the original source version for concurrency checks, and clear only the matching draft after a confirmed save or explicit discard.

#### Scenario: Interrupted editing or changed server content
- **WHEN** an author reloads an editor with unsaved source or the saved note/type changes while they are away
- **THEN** the draft is offered without replacing server content automatically, its original version is used for conflict handling, and fields not used by a newer definition remain accessible

#### Scenario: Leaving an edited note
- **WHEN** an author uses app navigation or changes the browser editor's selected card with unpublished changes
- **THEN** they can save to the server, keep a local draft, discard or stay; failed saves and failed local persistence keep the editor open

#### Scenario: Account and storage boundaries
- **WHEN** the active account changes, local persistence is unavailable, or storage limits are reached
- **THEN** another account cannot see the draft through the app, late receipts only clear their original matching slot, and storage failures are visible without truncating or evicting prior drafts

#### Scenario: Recovery without the original entity
- **WHEN** the original note/type is no longer available or the local collection reaches its draft limit
- **THEN** the owner can inspect and download saved draft text and explicitly discard selected drafts through the local draft list; the current in-memory draft remains downloadable if browser persistence fails

### Requirement: Bounded note text recovery
The system SHALL keep at most five pre-images of an existing note, each at most 256 KiB of canonical JSON. A pre-image stores field values, tags, accepted answers and note type. Restoring one SHALL return those fields and tags without rolling back the schedule of a surviving card. Account deletion SHALL remove the revisions. A schema version 2 study export SHALL include them, and a version 1 snapshot SHALL still apply.

#### Scenario: Restore earlier text without rolling back FSRS
- **WHEN** an author restores an earlier revision and the restored document still generates the same card
- **THEN** the fields and tags return to that revision while the card's due, stability, difficulty, reps, lapses and state stay unchanged

#### Scenario: Five revisions and 256 KiB bound
- **WHEN** a sixth distinct field document is saved, or the pre-image exceeds 256 KiB
- **THEN** the note still saves, only the five newest revisions for that note remain, and the oversized pre-image is not stored

#### Scenario: Stale expectedUpdatedAt
- **WHEN** restore is sent with a stale expectedUpdatedAt
- **THEN** the response is note_changed, nothing is written, and the current text remains

#### Scenario: Note type mismatch
- **WHEN** the stored revision belongs to a different note type than the current note
- **THEN** the response is note_type_changed and nothing is written

#### Scenario: Account deletion and export
- **WHEN** the account is deleted, or a study snapshot is exported and later applied
- **THEN** deletion removes the revision rows, a version 2 file contains them, a version 1 file still applies and inserts none, and a file that breaks the five-revision, per-user or byte caps is rejected
