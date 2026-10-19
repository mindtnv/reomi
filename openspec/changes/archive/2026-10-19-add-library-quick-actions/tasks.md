# Tasks

## 1. Material action menu

- [x] 1.1 Add browser regressions for overflow/right-click/keyboard entry, correct target, cancellation and move through the menu; observe the old UI failing the new entry assertion.
- [x] 1.2 Implement shared quick actions with separate primary/menu/selection controls and account/scope guards; verify the browser regressions pass in grid and list.

## 2. Saved study presentation

- [x] 2.1 Add browser assertions for saved-study page surface, sidebar continuity, tabs and clear filter copy; observe the old page failing the surface assertion.
- [x] 2.2 Repair the page with existing design-system components and RU/EN explanatory copy, retaining deep links/draft recovery; verify browser assertions and responsive screenshots.

## 3. Release

- [x] 3.1 Update canonical agent guidance and mirror it; run strict specs, typecheck, lint, migration-faithful tests, S3 and production builds after final edits.
- [x] 3.2 Inspect browser/PWA and narrow-screen evidence and prepare the release PR/acceptance artifacts; verify reviewed screenshots and test results are linked. Archive the implementation after repository gates pass; track deployment and production smoke as the release follow-up in acceptance.md.
