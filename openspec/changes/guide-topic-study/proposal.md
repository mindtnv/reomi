# Proposal

## Why

Reomi can store a PDF, read one web page, chat about what is already in the library, and review cards with FSRS. It cannot take the sentence "I want to learn Kubernetes from scratch" and produce an ordered set of modules and pages. A new user has to invent that sequence, add each page through the library, and only then reach the reader, notebook, and review queue.

## What Changes

- Add a topic study plan. One owned notebook holds at most one plan, and a plan is an ordered list of modules for a goal the user typed.
- When chat is enabled, generate an unsaved draft from the goal and an optional level. The draft contains module titles, outcomes, earlier-module prerequisites, and suggested http(s) URLs. Generation does not fetch those URLs.
- Let the user edit the draft and save it. The first save creates the notebook and the plan together. A later save replaces that notebook's modules and leaves existing library sources in place.
- Add an explicit per-module action that turns accepted URLs into library sources, attaches them to the notebook, and records the module link. An owned URL source with the same normalized URL is reused.
- Show the plan on the notebook. Each module's status is derived from the linked sources. Opening a source uses the existing reader.

## Capabilities

### New Capabilities

- `topic-study-plan`: an owned notebook plan that turns one learning goal into editable modules and explicitly accepted library sources.

### Modified Capabilities

None. Library ingest, notebook membership, the reader, assistant confirmation, and the FSRS queue keep their current requirements.

## Impact

- API and database. Additive plan tables, a draft route, a save route, and a per-module source action. Apply the migration and ship the API before the web. Rollback drops the new tables. Notebooks, sources, cards, and reviews stay.
- Web. The welcome screen, the empty notebooks screen, and a notebook with no plan gain the plan flow. Copy ships in both locales.
- AI. One non-streaming completion, with the same disabled and failure behavior as notebook overview. No new provider and no embedding requirement for the draft.

### Non-goals

- Generating cards, quizzes, or study guides from a module.
- A home path that mixes unread material with due reviews.
- Crawling a site, following links, or importing video.
- Running commands, labs, or code.
- Changing FSRS order, daily limits, or grades.
- Making the existing library URL dialog reject duplicate URLs.
- Changing the home and review redirect that still depends on having a deck. After save, the client opens the notebook. The existing reader can create a deck with the first card.
- Replacing notebook overview, study-guide artifacts, coverage, or the concept map.
