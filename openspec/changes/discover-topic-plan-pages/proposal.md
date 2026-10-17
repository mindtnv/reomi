# Proposal

## Why

A topic plan that only stores a documentation homepage does not teach the module. The draft prompt fix for that bug ships on its own. This change is the later discovery work. A fixed page count is the wrong budget for a site the size of kubernetes.io/docs: one module needs a concepts subtree and a related tasks subtree, not five links and not every reference page.

## What Changes

- Build one cheap index for a docs root. Read `/llms.txt`, then `/llms-full.txt`, then `sitemap.xml`, then navigation links on that one page. Each entry is a URL, a title, and a tree position. No model call, and no page body, is required to build it.
- Map each module to a content subtree and to related content subtrees. A Workloads module can take `/docs/concepts/workloads/` and `/docs/tasks/run-application/` when their titles connect. The budget is estimated tokens per module, not a page count. A subtree that does not fit is narrowed to a child subtree. It is not cut off at an unmarked page.
- Reference trees are not bulk-included. A reference page is added only when a selected page links to it, and only while the module still has token budget. Blog, tag, and index pages stay out unless the module asks for them.
- The confirm card still shows sections. The user confirms or drops a section and can expand it to pages. Language filtering and version filtering stay: one locale, one version, and no hop onto a versioned sibling host.
- Ingest is lazy. Confirm stores every selected page. Only the current module and the next module are fetched and extracted. Later pages stay planned sources. When the learner reaches a module, that module and the following one are fetched. One page's failure does not stop the others. This change does not create flashcards, quizzes, or study guides.

## Capabilities

### New Capabilities

- `topic-plan-page-discovery`: a cheap docs index, token-budgeted subtree selection, section confirm, and lazy ingest of the current and next module.

### Modified Capabilities

None. `topic-study-plan` is still an in-flight change and is not a main spec. The root-only prompt fix is not part of this change. Library ingest, SSRF guards, assistant confirmation, and the reader keep their current requirements.

## Impact

- API. Indexing runs while the plan card is still unsaved. It reuses the existing page-fetch SSRF guards. Confirm creates source rows for the selected pages and enqueues ingest for the first two modules only.
- Database. Nullable `sources.doc_version` records the chosen documentation version. Source status gains `planned`, which the ingest worker does not claim. No backfill. Rollback leaves both in place.
- Web. The plan card shows sections, page counts, and estimated tokens. The plan dock shows planned modules without treating them as failures. Copy ships in both locales.
- AI. Matching uses the index only. The draft completion that names modules is unchanged and is not added here.

### Non-goals

- Shipping the root-only prompt fix. That is the other pull request.
- A recursive crawl, a second hop through content links, or importing a whole site.
- Fetching another host, a parent path, or a private address.
- A model call to build the index, choose a section, or choose a version.
- Creating flashcards, quizzes, or study guides from a module.
- Raising ingest concurrency.
- A page-count cap. Token estimates replace the 5, 20, 30, and 200 page caps.
