# Design

## Context

See `proposal.md` for why this exists. The pieces this design reuses are already shipped.

- `POST /library/items` with `kind: 'url'` inserts one page and enqueues ingest. URL rows are not deduplicated. File dedup is a per-user byte hash.
- `createInlineSource` can attach the new row to a notebook in the same transaction. Notebook attach has `MAX_SOURCES_PER_NOTEBOOK`. The library has `MAX_LIBRARY_ITEMS_PER_USER`.
- Notebook overview already calls the non-streaming completion, returns `ai_disabled` when chat is off, and uses the shared cooldown helper. Artifact generation is a different worker and samples at most `ARTIFACT_CONTEXT_CHUNKS` chunks. This plan does not go through that worker.
- Home and Review redirect to the welcome screen when the account has no decks (`useEmptyRedirect`). Bootstrap loads decks, not notebooks.
- The archived assistant change excluded a curriculum and shell execution. Main specs never copied that exclusion, so this change adds a plan without revising those specs.

## Goals / Non-Goals

**Goals:**

- One notebook owns at most one plan.
- The model proposes modules and URLs. The user saves them. Only the add action inserts sources.
- Hand entry works when chat is off.
- Source links survive a module edit and do not own the library row.

**Non-Goals:**

- Design-level exclusions match the proposal. In particular, this design does not add a card batch, a home study mix, a crawler, or a deck to the first save.

## Decisions

### The plan is a child of a notebook

A new course root would need its own attach, chat scope, reader return, and deletion rules. A notebook already has those. The first save creates the notebook from the goal title and the plan row together. The user can also attach a plan to an empty owned notebook.

Alternative considered: store the plan as notebook overview JSON. That cache is regenerated from ready sources and is the wrong place for an ordered list the user edits before any source exists.

### The draft is not a row

`POST /notebooks/plan-drafts` returns JSON and writes nothing. The browser holds the draft until save. A bad completion therefore cannot leave an empty notebook behind.

Alternative considered: persist every draft. That makes cancellation and failed JSON into cleanup work, and it creates notebooks the user has not accepted.

The route calls the existing non-streaming completion once. The goal is wrapped as data, with an instruction to ignore directions inside it. The server validates the JSON and returns `generation_failed` when fewer than 4 modules survive validation. It does not invent replacement modules. URLs that fail normalization are dropped from that module. Each remaining URL is checked with HEAD, then GET when HEAD is not a success, through the existing page fetch and its SSRF guards. A failed check drops that URL. A module that loses its title or outcome fails the whole draft. A module that loses every URL stays in the draft.

Locale is `en` or `ru`, default `en`. The prompt asks for titles and outcomes in that language. Suggested URLs that survive the check stay as the model wrote them, after normalization.

Cooldown key is `plan-draft:<userId>` for 30 seconds through the existing cooldown helper. `NODE_ENV=test` keeps that helper disabled. A unit test with an injected clock covers the window.

### Three additive tables

`topic_plans` has `id`, `user_id`, `notebook_id` unique, `goal`, `level`, and timestamps. `topic_modules` has `id`, `plan_id`, `user_id`, `position`, `title`, and `outcome`. `topic_module_prerequisites` has `module_id` and `prerequisite_module_id`, both referencing `topic_modules` on delete cascade, unique as a pair. `topic_module_sources` has `module_id`, `source_id`, and `user_id`, unique on `(module_id, source_id)`.

Primary keys use PostgreSQL `uuidv7()`, consistent with other domain tables. `topic_plans.notebook_id` references `notebooks` on delete cascade. Module rows cascade from the plan. Link rows cascade from the module and from the source. There is no foreign key from a link to a card.

Indexes:

- unique `topic_plans.notebook_id`
- `topic_plans.user_id`
- unique `(topic_modules.plan_id, topic_modules.position)`
- unique `(topic_module_prerequisites.module_id, topic_module_prerequisites.prerequisite_module_id)`
- unique `(topic_module_sources.module_id, topic_module_sources.source_id)`
- `topic_module_sources.source_id` for the source-delete cascade lookup

No unique index on `sources.url`. A unique URL index would change the library dialog, which this change does not do. Lookup scans the owner's URL rows. The library cap is 300, so a dedicated URL index is not required for this action.

Save sends the full module list. Each module sends prerequisite indexes into that list, and each index must be lower than the module's own index. The server keeps rows whose ids were returned and are owned by that plan. New modules omit id. Missing modules are deleted, which cascades their links and prerequisite rows only. Library rows and `notebook_sources` stay. Position and prerequisite rows are rewritten from the submitted list inside the same transaction, after new ids exist.

A second plan insert for the same notebook conflicts on `notebook_id` and returns 409 `plan_exists`.

### Add sources reuses a URL only in this action

Normalization is a pure function. It trims, parses, allows only `http` and `https`, rejects userinfo, lowercases the scheme and host, drops the fragment and default port, and keeps the path and query. Invalid URLs are rejected per item and do not stop earlier items.

Match rule: among the caller's `kind = 'url'` rows whose status is not `deleting`, compare normalized URL. If several rows match, link the oldest. Attach it with the existing `ON CONFLICT DO NOTHING` notebook attach. If none match, call the existing inline URL insert and attach, then enqueue ingest after commit.

Before each insert, count remaining library room and remaining notebook-source room. Stop the batch when the next create would pass either cap. Reuse does not consume library room. Reuse still consumes notebook room when the source is not already attached. The response lists `linked`, `created`, or a machine code (`invalid_url`, `library_full`, `too_many_sources`).

Do not wrap the whole batch in one transaction that calls the model or the network. Each create commits, then enqueue runs, matching `createInlineSource`. A crash after the third URL leaves three sources. The client shows the response it got. A retry reuses those URLs.

### The notebook shows the plan and does not grade it

The dock gains a Plan tab. When a plan exists it is the selected tab on first open. Overview, notes, and studio stay. Status is computed in the GET plan response:

- `empty` when the module has no links
- `ingesting` when any link is `pending` or `parsing`
- `readable` when any link is in a state the current reader can open
- otherwise `unavailable`

`indexing` and parked embedding stay readable when the source text is already available, matching the source-study rule. The client does not store a mastered bit.

Welcome and the empty notebooks screen open one dialog. Generate is hidden when `chatEnabled` is false, and the blank-plan path stays. After the first save the client routes to `/notebooks/<id>`. It does not route to Home. Home's deck-empty redirect stays, because bootstrap does not know about notebooks and this change does not add a deck.

Both locales get the new strings. No other copy changes.

## Risks / Trade-offs

**The model will invent dead URLs.** The draft checks each suggested URL with HEAD, then GET when HEAD is not a success, through the existing page fetch and its SSRF guards, and drops the ones that fail before the user sees them. The check does not insert a source. A URL that is still live at draft time can fail later ingest. That failure stays on the source, and the module still lists it.

**One URL is one page.** A Kubernetes docs index does not import the rest of the site. The module cap of 4 URLs makes that limit visible. A crawler is a later change.

**A retried add can race two creates of the same new URL.** The match check and insert are not a global unique constraint. Two concurrent adds can both miss and insert. The library dialog already has this gap. The response still links whatever this request inserted. A unique URL index is rejected above.

**Saving a plan does not unlock Home.** Until the user creates a deck, Home and Review keep the welcome redirect. The plan screen is the next step, and the existing reader can create the deck with the first card.

**A 30 second cooldown blocks a legitimate second goal.** The same window is used for overview generation. The user can edit the draft they already have without another call.

## Migration Plan

1. Add `topic_plans`, `topic_modules`, `topic_module_prerequisites`, and `topic_module_sources` with the indexes above in a new versioned migration. Do not alter cards, reviews, sources, or notebooks except for the cascade from `notebooks`.
2. Ship the API before the web. An old web build never calls the new routes. A new web build treats a missing route as chat-off for the plan button's generate path and still allows a hand-built plan only after the API is current. If the GET route is missing, hide the plan tab rather than showing an error as an empty plan.
3. Rollback is web first, then the API. Drop `topic_module_sources`, `topic_module_prerequisites`, `topic_modules`, and `topic_plans` in that order if the tables must go. Leave notebooks and library sources created by an add. Those are ordinary user data. Do not delete them in the rollback migration.
4. Apply the chain with `db:migrate:apply`. Do not use `db:push` as a substitute. The tables are additive, so push would not drop a backfill, but the repository gate is still the committed chain.
