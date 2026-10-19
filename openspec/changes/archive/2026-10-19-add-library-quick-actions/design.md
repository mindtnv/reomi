# Design

## Context

The library has nested span-buttons in source buttons and separate folder buttons above each cover. CardActionsMenu already provides portal positioning, viewport clamping, arrow-key navigation and transient-layer dismissal. Saved study work already lives under the app shell but its body bypasses PageSurface; sidebar visibility is a user preference and must remain so.

## Goals / Non-Goals

**Goals:** Reuse the existing menu and mutation safeguards, improve source action discoverability, and repair saved-work page hierarchy.

**Non-Goals:** New API capabilities, data migration, folder context menus, source generation flows or overriding the learner's sidebar preference.

## Decisions

- Reuse CardActionsMenu with the existing mobile sheet; avoid a second custom popup implementation.
- Render primary, overflow and selection controls as siblings; avoid nested interactive elements. Put grid selection in the cover corner and move into the menu.
- Bind the menu to account, collection key and source presence. Fetch current metadata before rename/delete, preserve revision-aware edits and notebook-aware delete confirmation, and ignore stale account receipts.
- Give saved work PageSurface, descriptive copy, design-system tabs and an explicitly labelled filter for retained work with unavailable sources. Retain notes/artifact deep links and draft recovery.

## Risks / Trade-offs

- Menu dismissal can race a dialog → close through the shared layer before starting an action; restore focus only when appropriate.
- Moving removes the current item → refresh existing library/folder resources and close the menu.
- Touch lacks right click → keep a visible touch-sized overflow button and the shared action sheet.

## Migration Plan

Web-only deploy with existing owner-scoped endpoints. No schema, index or API changes. Roll back the web image if needed; no data rollback required.
