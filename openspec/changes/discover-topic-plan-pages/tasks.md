# Tasks

## 1. Seed, language, and version

- [x] 1.1 Add a failing unit test that `/`, `/docs/`, and `https://kubernetes.io/docs/` are discovery seeds, and that a leaf page is not. Implement the classifier and verify the test passes.
- [x] 1.2 Add a failing unit test for path labels and for host `v1-34.docs.example`, including preference order and a named version. Verify `v1-34` records `v1.34` and an apex docs host records null.
- [x] 1.3 Add a failing unit test that locale `en` drops `/zh-cn/` and `/ru/`, and that locale `ru` keeps `/ru/` when those pages exist. Implement the filter and verify the test passes.

## 2. Cheap index

- [x] 2.1 Add a failing test that `/llms.txt` sets titles and descriptions, a body over 256 KiB ignores a later link, and a readable sitemap is still merged in as the tree. Drive it through the existing page-fetch seams. Implement the merge and verify the test passes.
- [x] 2.2 Add a failing test that a missing sitemap uses llms links, and that both misses use one seed page's links and do not fetch those links onward. Verify the fallback passes.
- [x] 2.3 Add a failing test that off-host locs, a versioned sibling host, a private redirect, and a seventeenth sitemap child or another locale's child are dropped. Implement the 8 MiB and 20,000-entry caps and verify the test passes.
- [x] 2.4 Add a failing test that a fifth distinct seed contributes no entries. Implement the four-seed cap and verify the test passes.

## 3. Subtrees, tokens, and the kubernetes fixture

- [x] 3.1 Add a checked-in sitemap fixture shaped like kubernetes.io/docs, with English workloads, services, and tasks pages, shared Pod and Deployment titles, locale duplicates, API reference, glossary, blog, tags, `index.html`, and one `v1-33.docs.kubernetes.io` URL. Do not fetch the live site.
- [x] 3.2 Add a failing draft test that a Workloads module offers `/docs/concepts/workloads/` and `/docs/tasks/run-application/` when both fit the token budget, omits services and the API reference, and writes no notebook or source. Implement matching with `TOPIC_PLAN_MODULE_TOKEN_BUDGET` and `TOPIC_PLAN_PAGE_TOKEN_ESTIMATE` and verify the test passes.
- [x] 3.3 Add a failing test that a related subtree over the remaining budget is omitted, and that an ancestor over the budget offers a child subtree that fits. Verify there is no page-count cutoff.
- [x] 3.4 Add a failing test that an explicit module list with `https://kubernetes.io/docs/` expands without a model call, and that a leaf page is unchanged. Verify the revision path passes.
- [x] 3.5 Add a failing test that a fetched workloads page which links to one API page adds that page only, and that an unlinked API page is not stored. Verify the link step uses the remaining token budget.

## 4. Version column and lazy ingest

- [x] 4.1 Add nullable `sources.doc_version` after `0044_study_day.sql`, with no index and no backfill, and the matching Drizzle column. Apply it with `db:migrate:apply:test` and verify a fresh test database accepts the column.
- [x] 4.2 Add a failing confirm test that three confirmed modules enqueue only the first two, the third stays `planned`, reject writes nothing, and the worker claim does not select `planned`. Implement the status and verify the test passes.
- [x] 4.3 Add a failing test that opening the third module enqueues it and the fourth, leaves a fifth planned, stores `v1.34` only for a versioned host, and a failed page does not stop its sibling. Verify `studyModule` reports `planned` rather than `unavailable`.
- [x] 4.4 Add a failing test that a hand-entered list of four URLs still ingests on confirm and creates no flashcards. Verify that path passes.

## 5. Section confirm

- [ ] 5.1 Show each content section with its page count and estimated tokens, show reference sections as unselected, and allow dropping a section or a page, in both locales. Verify a focused web test covers the workloads count, a dropped tasks section, and a planned third module.

## 6. Fresh verification

- [ ] 6.1 Run `bun run spec:validate`, the fixture tests, `topic-plan-draft`, `topic-plan-proposal`, `topic-plan-confirm`, and `topic-plan-sources`. Update `CLAUDE.md` first, then mirror the body into `AGENTS.md` while preserving each header. Verify the guide names the cheap index, related subtrees, the token budget, lazy ingest, and `doc_version`.
