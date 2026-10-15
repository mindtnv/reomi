## Purpose

Defines the observable study scheduling controls guarantees added by the second spaced-repetition polish, preserving user content and predictable study behavior.

## ADDED Requirements

### Requirement: Explicit day and budgets
The system SHALL use one configurable study-day boundary and explain collection, ancestor and deck budgets consistently. Existing users SHALL retain UTC defaults until changed.

#### Scenario: Explicit day and budgets in use
- **WHEN** a user studies across midnight, a timezone transition or concurrent tabs
- **THEN** budget usage and day statistics follow the selected policy without an accidental reset or hidden overrun

#### Scenario: Legacy UTC midnight
- **WHEN** the account has no `study_day_policy` row and a grade is recorded at `2026-10-15T23:00:00.000Z`
- **THEN** the open epoch is `[2026-10-15T00:00:00.000Z, 2026-10-16T00:00:00.000Z)` and the review study day is `2026-10-15`

#### Scenario: DST fall fold
- **WHEN** the policy is `America/New_York` with rollover minute 90 and the instant is `2026-11-01T05:30:00.000Z`
- **THEN** the epoch starts at the earlier instant `2026-11-01T05:30:00.000Z` and ends at `2026-11-02T06:30:00.000Z`
- **AND** `2026-11-01T06:00:00.000Z` stays inside that same epoch

#### Scenario: Zone save during an open epoch
- **WHEN** the open UTC epoch is `[2026-10-15T00:00:00.000Z, 2026-10-16T00:00:00.000Z)` and the user saves `Asia/Tokyo` at midnight rollover while `now` is `2026-10-15T23:00:00.000Z`
- **THEN** the start, the end, and the counters stay unchanged
- **AND** the saved zone takes effect at `2026-10-16T00:00:00.000Z`

#### Scenario: Later rollover after the stored end
- **WHEN** the open UTC midnight epoch labeled `2026-10-15` has ended and the saved rollover is minute 90
- **THEN** `2026-10-16T00:30:00.000Z` and `2026-10-16T02:00:00.000Z` share one budget labeled `2026-10-16` from `2026-10-16T00:00:00.000Z` until `2026-10-17T01:30:00.000Z`
- **AND** yesterday's goal credit stays on `2026-10-15`, a grade in the stub and a later grade the same morning increment the streak once, and skipping the stub does not spend a freeze

### Requirement: Reversible scheduling controls
The system SHALL distinguish daily bury, sibling bury, suspension, reset and set-due, provide predictable learning and new-card ordering, and disclose preset effects.

#### Scenario: Reversible scheduling controls in use
- **WHEN** a user modifies scheduling or returns a leech to study
- **THEN** the resulting state and next availability are explained, retained across reload and compatible with undo

### Requirement: Separate practice mode
The system SHALL provide practice without schedule changes separately from rescheduling filtered study, with previewed bounded selection and stable session order.

#### Scenario: Separate practice mode in use
- **WHEN** a user starts non-rescheduling practice from a deck or search
- **THEN** only the selected available cards appear and normal FSRS and daily counters remain unchanged

### Requirement: Isolated and recoverable operation
The system SHALL scope all data to the authenticated owner and preserve usable study and editing controls when an optional service fails.

#### Scenario: Foreign data or unavailable dependency
- **WHEN** a request references another user's resource or an optional dependency fails
- **THEN** no foreign data is exposed or modified and the user receives a recoverable result without losing unrelated work
