# Proposal

## Why

Reomi can store a page, chat about what is already in the library, and review cards. It cannot turn "I want to learn Kubernetes" into an ordered set of modules and pages. The user has to invent that sequence and add each page by hand before the notebook and the reader are useful.

## What Changes

- The entry is the existing assistant chat. The user writes the goal in that chat. The assistant answers with a structured plan card that lists modules and http(s) URLs. The user changes the plan by sending another message. There is no new screen and no new dialog. The welcome screen stays as it is.
- A plan card checks each suggested URL before the user sees it, and drops a URL that fails that check. The check does not insert a library item.
- Confirmation uses the existing assistant confirm step. On apply, the assistant creates one ordinary notebook, stores the plan as that notebook's child, and ingests each accepted URL through the existing URL ingest. The page text is stored in the library, and each source is attached to the notebook. Reject creates nothing.
- The notebook may show the saved plan on a tab. That tab opens a linked source in the existing reader. It does not collect the goal and it does not ask for URLs.
- Storage stays the plan tables that already belong to one notebook. This revision adds no table.

## Capabilities

### New Capabilities

- `topic-study-plan`: an owned notebook plan that the assistant proposes in chat, confirms, and fills with ingested library pages.

### Modified Capabilities

None. Library URL ingest, notebook membership, the reader, assistant confirmation, and the FSRS queue keep their current requirements.

## Impact

- API and database. The additive plan tables from this change stay. The assistant gains a proposal and a confirmed write. Apply the existing migration and ship the API before the web. An old web build never opens a plan screen. Rollback drops only the plan tables. Notebooks, sources, cards, and reviews stay.
- Web. The chat transcript renders the plan card inside the existing assistant. The notebook dock may gain a Plan tab. Copy ships in both locales. The welcome screen is unchanged.
- AI. One non-streaming completion proposes the first card. A later message can revise that card without a second completion. Confirmation does not call the model again. Chat disabled means the assistant cannot propose a plan.

### Non-goals

- A welcome action, a plan dialog, or a hand-entry form.
- A new course root, a draft row, or any table beyond the plan that belongs to the notebook.
- Generating cards, quizzes, or study guides from a module.
- A home path that mixes unread material with due reviews.
- Crawling a site, following links, or importing video.
- Running commands, labs, or code.
- Changing FSRS order, daily limits, or grades.
- Making the existing library URL dialog reject duplicate URLs.
- Changing the home and review redirect that still depends on having a deck. After confirmation, the client opens the notebook. The existing reader can create a deck with the first card.
- Replacing notebook overview, study-guide artifacts, coverage, or the concept map.
