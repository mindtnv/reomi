# Proposal

## Why

Library overflow buttons open an oversized details panel instead of a quick menu, while separate move icons add ambiguous clutter. Saved study work lacks the standard page surface and labels an optional filter as if it were an error.

## What Changes

- Offer the same quick actions from an anchored overflow menu, right-click and keyboard context-menu access in grid and list views.
- Keep opening the reader as the primary action; use separate accessible sibling controls for menus and selection.
- Put moving, renaming, details and confirmed deletion in the menu; remove the redundant per-item move icon.
- Present saved notes/documents inside the existing app page surface with explanatory copy and a clearly named unavailable-source filter.

## Capabilities

### New Capabilities

- `library-item-actions`: accessible quick actions on library materials with identical pointer and keyboard behavior.

### Modified Capabilities

None. The saved-study presentation repairs existing behavior without changing its data contract.

## Impact

Web library cards/list, shared menu primitive, saved-study page, RU/EN copy and browser verification. Reuses existing owner-scoped APIs and revision-aware edits. No schema, API, storage or migration changes; rollback is a web image rollback. Existing notes, documents and source relationships remain intact.
