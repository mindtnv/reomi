## Purpose

Keep explicitly selected documentation sections current on an owned schedule while preserving library sources and showing the outcome of each synchronization.

## ADDED Requirements

### Requirement: Scheduling is explicit and owned
Each confirmed connection SHALL offer off, daily and weekly synchronization. Existing connections SHALL default to off. Settings SHALL be owned, durable and visible with the next scheduled check. Turning scheduling off or disconnecting SHALL fence unfinished discovery so that it cannot queue new work afterward. Already accepted page imports SHALL retain their explicit cancel control.

#### Scenario: Enable and disable
- **WHEN** an owner enables daily checks and later disables them
- **THEN** a due time is saved and displayed, and disabled or stale discovery cannot queue a later import

#### Scenario: Another account
- **WHEN** a caller changes another owner's schedule
- **THEN** the request returns not found and no schedule changes

### Requirement: Due checks are durable and bounded
Due checks SHALL run without an open browser, use bounded claims and exclude active or cancelled imports. Simultaneous workers and manual checks SHALL not queue competing runs. An expired claim SHALL become recoverable after restart. Failures SHALL preserve content, expose an actionable error and retry with bounded backoff rather than a tight loop. Existing scope and library quotas SHALL apply without silent truncation.

#### Scenario: Restart and competing checks
- **WHEN** a worker restarts after claiming a check or another worker/manual request races it
- **THEN** the claim expires or completes and only one current run can commit its discovered page set

#### Scenario: Remote failure or full library
- **WHEN** scheduled discovery fails or new pages exceed capacity
- **THEN** existing sources and study work remain intact and the connection exposes the failure and its later retry time

### Requirement: Synchronization results explain changes
Each completed run SHALL persist counts of newly saved sources, updated sources, unchanged sources, failed pages and remote-missing pages with its completion time. Counts SHALL reflect committed outcomes, survive restart and distinguish reused sources from newly created sources. Russian and English collection controls SHALL remain keyboard-accessible and usable on narrow and standalone surfaces.

#### Scenario: Mixed outcomes
- **WHEN** a run creates one source, updates one, retains one unchanged and fails to fetch another
- **THEN** its saved summary reports those outcomes and the failed page keeps its previous content
