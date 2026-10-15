# Design

## Context

See `proposal.md` for why this exists. Sections 1 to 3 of `tasks.md` already shipped the plan tables, the unsaved draft generator, and the per-module URL action. This revision changes the entry and the confirmation. It does not add a table.

The pieces this design reuses are already shipped.

- The assistant pauses every write tool for a dry-run preview and runs it only after an explicit apply. Reject writes a tool result and continues the turn. A pending confirmation holds the next typed message until the turn settles.
- `POST /notebooks/plan-drafts` already returns 4 to 8 modules, wraps the goal as data, and drops URLs that fail the secure HEAD then GET check. It writes nothing.
- `POST /notebooks/plans` creates the notebook and the plan. `POST /notebooks/:id/plan/modules/:moduleId/sources` reuses or creates a URL source through `createInlineSource`, which enqueues the existing URL ingest after commit. That ingest stores the page text.
- The notebook dock already has Overview, Notes, and Studio. A tab is an existing surface.
- The welcome screen offers deck, library, and chat. Home and Review still redirect there when the account has no decks.

## Goals / Non-Goals

**Goals:**

- The user asks in the existing assistant and sees a plan card there.
- Another chat message replaces that card.
- Apply creates one notebook, one plan, and ingested library pages attached to that notebook.
- Reject creates nothing.
- The notebook can show the saved plan on a tab.

**Non-Goals:**

- A welcome action, a dialog, or a form for modules and URLs.
- A draft table, a course root, or any table beyond `topic_plans`, `topic_modules`, `topic_module_prerequisites`, and `topic_module_sources`.
- Editing a saved plan from the tab. A later save still exists on the API for the tests already written.

## Decisions

### The proposal is a read tool, and the create is a write tool

Two shapes were possible.

The first shape pauses on the first proposal. The card is the existing confirm card. A word edit has to reject that card before the user can talk, because a pending confirmation holds the composer. That fights "change it with another message."

The shape this design uses keeps the first card as a read. `propose_topic_plan` runs in the existing global assistant registry, and in the notebook registry so the same assistant can propose from either place. A call with a goal uses the existing draft completion and the existing URL probe. A call that already includes the module list does not call the model. It validates the bounds and probes the URLs, then returns the card. The web renders that tool result as a plan card in the transcript. The user keeps typing. When the user agrees, the model calls `create_topic_plan` with the same modules. That write pauses on the existing confirm card, which renders the same modules and URLs. Apply is the confirmation.

`create_topic_plan` does not take a notebook id from the model. Apply creates a new notebook from the goal. The existing save route can still attach a plan to an owned notebook for the tests from section 1. The chat tool does not use that path.

Parsing a fenced block out of assistant prose was the other candidate. The client would guess which message is the plan. A tool result is already structured, and the confirm loop already knows how to pause a write.

### Confirmation reuses the save and the URL action

Apply calls the existing plan save, then the existing per-module URL action for every URL on the card. The URL action inserts the source row first and enqueues ingest after commit, so the page text is stored by the existing URL parser. The proposal probe is a different step and still inserts nothing.

The confirm preview lists modules and URLs. It is not a field editor. Word edits happen before this pause, on the read-tool card. Reject writes nothing. Apply does not call the model.

An old web build that does not know the plan preview still has Apply and Reject on an unknown write tool. Apply still creates the notebook. The old welcome screen never calls these tools.

### No new table

The chat card is the tool arguments and the tool result. It is not a row. The four tables from `0042_bent_jean_grey` remain the plan, and the plan remains a child of one notebook. One notebook still holds at most one plan.

### The notebook tab is a view

The dock gains a Plan tab when a plan exists. It is the selected tab on first open. Overview, notes, and studio stay. Status is computed on the GET plan response.

- `empty` when the module has no links
- `ingesting` when any link is `pending` or `parsing`
- `readable` when any link is in a state the current reader can open
- otherwise `unavailable`

`indexing` and parked embedding stay readable when the source text is already available, matching the source-study rule. The client does not store a mastered bit. The tab opens the existing reader. It has no goal field and no URL field.

The welcome screen is not modified.

### Bounds, cooldown, and ownership stay

The draft bounds, the save bounds, prerequisite direction, URL normalization, library and notebook caps, and the 30 second cooldown on a repeated model proposal stay as sections 1 to 3 implemented them. A revision that sends an explicit module list does not consume that cooldown and does not call the model. `user_id` comes from the session on every write.

## Risks / Trade-offs

**The model will invent dead URLs.** The proposal checks each suggested URL with HEAD, then GET when HEAD is not a success, through the existing page fetch and its SSRF guards, and drops the ones that fail before the user sees them. The check does not insert a source. A URL that is still live at proposal time can fail later ingest. That failure stays on the source, and the module still lists it.

**One URL is one page.** A Kubernetes docs index does not import the rest of the site. The card shows at most 4 URLs on a module. A crawler is a later change.

**A repeated confirm can race two creates of the same new URL.** The match check and insert are not a global unique constraint. Two concurrent confirms can both miss and insert. The library dialog already has this gap. A unique URL index is out of scope.

**A 30 second cooldown blocks a second model proposal.** A word edit that sends the revised module list does not call the model, so the cooldown does not block that edit. A second "plan something else" request inside the window still waits.

**Saying yes still needs Apply.** The write tool pauses, because every assistant mutation confirms before it writes. The extra click is the existing confirm card, not a new dialog.

**Saving a plan does not unlock Home.** Until the user creates a deck, Home and Review keep the welcome redirect. The notebook is the next step.

## Migration Plan

1. Keep `topic_plans`, `topic_modules`, `topic_module_prerequisites`, and `topic_module_sources` as added in `0042_bent_jean_grey`. Do not add a migration for the chat entry.
2. Ship the API before the web. An old web build does not render the plan card and does not add a welcome action. If the user applies an unknown write tool, the existing confirm control still applies or rejects it.
3. Rollback is web first, then the API. Drop `topic_module_sources`, `topic_module_prerequisites`, `topic_modules`, and `topic_plans` in that order if the tables must go. Leave notebooks and library sources created by a confirmation. Those are ordinary user data.
4. Apply the chain with `db:migrate:apply`. Do not use `db:push` as a substitute.

## Open Questions

None. The entry, the confirmation, and the table set are fixed by the revision.
