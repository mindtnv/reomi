# Implementation acceptance — 2026-10-19

## User-visible result

- Material overflow opens an anchored dropdown; right-click and ContextMenu / Shift+F10 expose the same actions in grid and list. Primary activation still opens the reader.
- Move lives in the menu with a directional folder icon; redundant folder buttons above the covers are removed. Grid selection is overlaid in the cover corner.
- The existing saved-study collection of source notes and documents uses the app page surface, explanatory RU/EN copy and an explicitly labelled unavailable-source filter. Sidebar visibility remains the user's preference.
- The browser scenario renames a source, cancels deletion, then confirms deletion of a selected fixture and verifies the source note still opens by deep link and through the unavailable-source filter.

## Verification

- Regression baseline: new browser expectations fail against the original missing surface/menu; the unit regression catches the nested span-button.
- Focused final unit checks: 16 passed, including account change, late metadata, disappeared target, focus dismissal and canceled deletion.
- Workspace typecheck and web lint: passed.
- API and Next.js production builds: passed.
- Complete local browser walk: 6 passed, 1 expected skip (`CHAT_API_KEY unset; skipping live assistant assertion`); artifact secret scan passed. Library journeys share one learner and keep the normal signup quota unchanged.
- Final migration-built repository suite: 3537 passed, 0 failed, 18330 assertions across 335 files (437.84 s), using fresh `reomi_actions_final_test` built through migration 0049.
- Mandatory real-S3 round trips after the repository suite: 21 passed, 0 failed, 122 assertions (5.99 s).
- Strict OpenSpec: 32 items passed; final diff validation passed. Revalidated after syncing/archiving.

## Visual review

Ten inspected screenshots live in `docs/library-actions/`: desktop grid menu in light/dark, list presentation, desktop and mobile standalone menu, saved work on desktop/Russian 320px/standalone mobile, retained note deep link and retained-only filter. Both changed surfaces use existing palette, panel and control tokens. No horizontal document overflow was observed at 320px.

## Release follow-up

The implementation archive is prepared after local gates. Publish the reviewed PR, require its current-head CI, merge, and follow the normal immutable-SHA main deployment. Verify both applications healthy on the merged SHA and the production smoke (including the live assistant and the new menu/retained-work scenario). Record run links and final production results in the PR so deployment status is not guessed before release. No API/schema migration is required; presentation rollback selects the previous web image.
