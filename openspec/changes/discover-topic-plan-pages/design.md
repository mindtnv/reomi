# Design

## Context

See `proposal.md` for why this exists. The specs in `specs/topic-plan-page-discovery/spec.md` are the contract.

The root-only prompt fix ships in a separate pull request. This change starts after that. It does not edit that prompt.

The reference case is kubernetes.io/docs. English pages live at `https://kubernetes.io/docs/…`. Translations use prefixes such as `/zh-cn/` and `/ru/`. Older releases are other hosts, such as `v1-34.docs.kubernetes.io`. A Workloads module needs `/docs/concepts/workloads/` and the related `/docs/tasks/run-application/`. It does not need the generated API reference unless a selected page links to one API page.

Today the ingest worker claims `status = 'pending'`. `createInlineSource` enqueues immediately. `studyModule` treats anything that is not pending, parsing, or readable text as unavailable. `topic_module_sources` requires a source row. Draft locale is `en` or `ru`. Chain head is `0044_study_day.sql`. The in-flight topic-study plan still says one URL is one page and that saving a plan does not create flashcards. This change keeps that card rule.

## Goals / Non-Goals

**Goals:**

- Index a docs root by URL, title, and tree position.
- Attach related content subtrees inside a token budget.
- Confirm sections, then fetch only the current module and the next one.

**Non-Goals:**

- The root-only prompt fix.
- Page-count caps of 5, 20, 30, or 200.
- A model call for the index or for section choice.
- Flashcards, quizzes, or study guides.
- Following a version onto another host.

## Decisions

### Index fields

An entry is `{ url, title, treePosition, description?, estimatedTokens, kind }`. `treePosition` is the parent path under the seed prefix, so `/docs/concepts/workloads/pods/` sits at `/docs/concepts/workloads`. `kind` is `content`, `reference`, or `excluded`. No page body is stored in the index.

Read `{origin}/llms.txt`, then `{origin}/llms-full.txt`, at most 256 KiB each, through the existing guarded fetch. Parse inline `[label](url)` links and the same-line description, capped at 300 characters. Then read `{origin}/sitemap.xml` even when llms.txt had links. A short llms file is not a full tree. Sitemap URLs create entries. A matching llms URL sets the title and description. If the sitemap yields nothing, llms links are the tree. If both yield nothing, one GET of the seed page supplies `<a href>` values. Do not fetch those hrefs for more links.

Sitemap index children: at most 16, same host, skip a filename that names another locale. Stop at 8 MiB or 20,000 `loc` entries. At most 4 distinct seeds per proposal. `robots.txt` can name another host. Rejected.

`kind = reference` when a path segment is `reference`, `kubernetes-api`, `api-reference`, or `glossary`. `kind = excluded` when a segment is `blog`, `tags`, or `tag`, or the last segment is `index` or `index.html`, unless the module text names that class (`API reference`, `glossary`, `blog`, `tags`, `справочник`, `глоссарий`, `блог`, `теги`). Other pages are `content`.

### Token budget

`estimateTokens` is `ceil((title + description).length / 4)` when a description exists. Otherwise it is `TOPIC_PLAN_PAGE_TOKEN_ESTIMATE`, default 1200. `TOPIC_PLAN_MODULE_TOKEN_BUDGET` defaults to 32000. Both are optional `env.ai` values. Clamp the page estimate to 100..8000 and the module budget to 1000..200000. There is no page-count cap and no plan-wide page cap. The sitemap read bound is the only size guard on the index.

Primary subtree: deepest content prefix whose estimate fits and whose tokens overlap the module title and outcome. Related subtrees: other content prefixes whose page titles share tokens with the primary pages, highest overlap first. Add a related subtree only when its full estimate fits the remainder. If a prefix does not fit, offer child prefixes that fit. Do not keep an unmarked first N pages.

The fixture's Workloads titles (Pod, Deployment) overlap `tasks/run-application` titles that say Deployment. `services-networking` does not overlap enough, so it stays off that module.

### Versions and language

Same host and seed prefix only. Locale tags are the first path segment when it is a known language tag. Unprefixed `/docs/` is English. Draft locale `ru` keeps `/ru/…` when any exist. Otherwise keep English. `en` drops `/ru/` and `/zh-cn/`.

Path preference is `stable`, `latest`, `current`, highest numeric, then `next`, unless the goal or module names a version. Canonical grouping uses the sitemap `xhtml:link` when present. Do not fetch a page only to read its canonical link. Host `v1-34.docs.*` records `v1.34`. The apex kubernetes.io docs root records null.

### Confirm, then lazy ingest

The card groups content entries by tree position and shows the page count and estimated tokens. Reference groups are visible and unselected. Dropping a section removes its URLs. Apply does not build the index again.

Every selected URL becomes a source row and a `topic_module_sources` link, with `doc_version` set. Modules at position 0 and 1 are inserted as `pending` and enqueued with `enqueueSource`. Later modules are inserted as `planned` and are not enqueued. The worker claim stays `WHERE status = 'pending'`. `planned` is absent from the active operation index.

Opening module position `i` in the plan dock enqueues that module and position `i + 1` when they are still `planned`. It does not enqueue later modules. A failed page stays `error`. Siblings continue.

`studyModule` reports `planned` when every link is `planned`. It does not report `unavailable` for that case. `pending` and `parsing` still mean `ingesting`.

Linked reference pages are discovered from the fetched HTML of a selected page, resolved against the index, and inserted on that same module. If the module is already being fetched, the new page is enqueued. If the module is still `planned`, the new page is `planned` too. Remaining token budget includes these pages. Unlinked reference pages are never inserted.

Hand-entered module URLs that are not a discovery seed keep today's confirm path: they ingest on apply. Discovery does not change that path. Flashcards are not created on either path.

### Fixture

A checked-in sitemap stands in for kubernetes.io. It includes English workloads and services pages, tasks pages whose titles share Pod or Deployment, `/zh-cn/` and `/ru/` duplicates, the API reference, glossary, blog, tags, `index.html`, and one `v1-33.docs.kubernetes.io` URL. Tests drive the existing page-fetch seam. They do not request kubernetes.io.

## Risks / Trade-offs

- [A localized sitemap is huge] → Stop at 20,000 locs and 8 MiB, and skip other-locale children.
- [The token estimate is not the real page] → It is a budget for selection, computed from the title, the description, or the default. Fetching the body to count tokens would defeat the cheap index.
- [Related tasks share no title tokens] → That subtree is not added. The match is deterministic. A model is not a fallback.
- [`planned` is a new status] → Only the claim query and `studyModule` need to know it. Existing pending rows are unchanged.
- [An old client confirms four URLs] → Those URLs still ingest on apply. Ship the API before the web.

## Migration Plan

1. Add an additive migration after `0044_study_day.sql` for nullable `sources.doc_version`. Allow `planned` in the application status set. Do not add a check constraint that would reject older statuses. Edit `packages/db/src/schema/app.ts` in the same change. Apply with `db:migrate:apply`. Do not use schema push as a substitute.
2. Ship the API before the web. An old web build still confirms a hand-entered URL list. It ignores `doc_version` and `planned`.
3. Rollback the web first, then the API. Leave the column and any `planned` rows in place. Do not drop the column to roll back. A `planned` row is an ordinary library source that a later compatible API can enqueue.

## Open Questions

None. The index order, the token estimate, the related-subtree rule, and lazy ingest of the current and next module are fixed above.
