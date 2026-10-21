# Acceptance

- Focused tests: 21 passed, including concurrent claims, expired-claim recovery, manual update races, disabling before and during discovery, stable source identities, actual run outcomes and discovery backoff.
- Full suite against the committed migration chain through generated 0051: 3574 passed, 0 failed, 18529 assertions. Real S3: 21 passed, 0 failed, 122 assertions.
- Workspace types, ESLint and production build passed. Strict OpenSpec: 35 items passed. Repository-contract tests passed after adding the optional manual production acceptance entry point.
- Browser verification is in progress. The initial run caught an incorrect role in the new test (NNSelect exposes a button with a listbox, not a combobox); corrected. Its replacement worker exhausted the ordinary local signup limit and the later signup check failed; the task-owned dev server was restarted before the clean final run. No production rate-limit settings changed.
- An opt-in production smoke imports at most two entirely new Kubernetes concepts pages from the real `/docs/home/` manifest, opens readable text, changes the schedule, refreshes with stable source IDs and removes only that run's connection/materials/folder. This is not yet claimed as executed.
- Publication, production schedule verification and screenshots will be recorded after their actual checks.
