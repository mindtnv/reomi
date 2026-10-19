# Library quick actions and saved work

The material overflow button opens a compact anchored menu. Right-click and ContextMenu / Shift+F10 open the same actions in grid and list views: Open, Move to folder, Rename, Details and Delete. The primary button still opens the reader; selection and menu controls are separate siblings. Touch retains a visible overflow control and the shared action sheet. Standalone per-material folder icons have been removed.

Move reuses the existing folder destination dialog. Rename loads current metadata and uses the revision-aware small-action editor. Delete loads current notebook impact and requires explicit confirmation. Menus discard targets on account, collection, view, entry changes or disappearance. Late metadata responses from a previous account cannot open a dialog. Deleting a selected item clears its obsolete selection.

`/library/study` is the existing collection of source notes and generated documents, including retained work after source deletion. It now uses the standard app page surface with clear explanatory copy and an explicitly labelled unavailable-source filter. It preserves the user's sidebar preference. Note/document deep links and draft recovery remain supported.

No schema, endpoint, dependency or data migration changes. Roll back the web image to revert presentation. Existing owner-scoped source mutations and data-retention semantics remain authoritative.

## Verification and visual evidence

`e2e/library-actions.e2e.ts` covers overflow/right-click/keyboard activation, focus restoration, rename, list actions, canceled and confirmed deletion, selection cleanup, saved-work page structure, retained-note deep links after source deletion, the unavailable-source filter, light/dark modes, Russian copy and narrow/standalone layouts. `e2e/library-folders.e2e.ts` verifies single movement through the menu and the existing batch/tree preservation flow. Unit regressions cover nested-interactive removal, account changes, late metadata receipts and removed menu targets.

The serial library journeys share one local learner, keeping the complete browser walk within the normal signup limit; authentication and production rate limits are unchanged.

Old UI was checked with the new regressions: the saved-page surface and action entry point failed; the unit scenario also caught the nested span-button. Final screenshots are inspected, not just generated.

| Surface | Browser | Standalone / narrow |
| --- | --- | --- |
| Material menu | [Light](desktop-menu.png), [dark](dark-desktop-menu.png), [list](desktop-list.png) | [Desktop](standalone-desktop-menu.png), [mobile action sheet](standalone-mobile-menu.png) |
| Saved work | [Russian desktop](saved-ru-desktop.png), [retained-note deep link](retained-note.png), [retained-only filter](retained-filter.png) | [Mobile](saved-standalone-mobile.png), [Russian 320px](saved-ru-small.png) |
