# Library item actions Specification

## Purpose

Let learners act on library materials through a consistent compact menu without interrupting browsing or losing the source context.

## Requirements

### Requirement: Equivalent quick-action entry points
The library SHALL offer open, move to folder, rename, details and delete actions for a material through its overflow button and a context menu in grid and list views. Ordinary primary activation SHALL continue to open the reader. Menu activation SHALL NOT open the reader or change the current selection. Menu and primary controls SHALL be separately keyboard accessible.

#### Scenario: Overflow and right click
- **WHEN** a learner activates a material's overflow button or right-clicks that material
- **THEN** the same actions appear for that material and the reader remains closed

#### Scenario: Keyboard and narrow screens
- **WHEN** a learner opens the menu with keyboard context-menu commands or the overflow button on a phone
- **THEN** actions are reachable by keyboard, dismissal restores usable focus and the menu stays inside the viewport

### Requirement: Safe current-account actions
Quick actions SHALL use the current account's existing source mutations and revision-aware rename workflow. Deletion SHALL require explicit confirmation explaining attached-notebook impact. Menu state SHALL be discarded when the account or collection scope changes or the target disappears. Failures SHALL display actionable feedback without crashing or claiming success.

#### Scenario: Confirmed deletion
- **WHEN** a learner chooses Delete and cancels the confirmation
- **THEN** the material and its existing relationships remain unchanged

#### Scenario: Changed owner or missing source
- **WHEN** the account changes, the collection scope changes or the material disappears while its menu is open
- **THEN** the old menu is no longer actionable

#### Scenario: Transient action failure
- **WHEN** loading the current material or applying a quick action fails
- **THEN** the library remains usable and displays failure feedback
