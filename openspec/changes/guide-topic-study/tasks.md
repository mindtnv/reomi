# Tasks

Each numbered section is one pull request. Land them in order. A later section starts from the previous section's branch tip.

## 1. Persist an owned plan

- [x] 1.1 Add failing API tests for a first save, a hand-built module with no URLs, a 13-module reject, a forward prerequisite reject, a second save that keeps one module's identity and does not rename the notebook, a second save that drops a module without deleting its library source, a 409 when the notebook already has a plan, and a foreign or missing notebook. Verify the new test file fails before the schema exists.
- [x] 1.2 Add `topic_plans`, `topic_modules`, `topic_module_prerequisites`, and `topic_module_sources` to the Drizzle schema and generate the next versioned migration. Verify `bun run db:migrate:apply:test` applies it on an empty test database and on a database that already has the previous chain head.
- [x] 1.3 Implement save and read for `POST /notebooks/plans`, `PUT /notebooks/:id/plan`, and `GET /notebooks/:id/plan` inside one transaction per save. Verify 1.1 passes, a save creates no card rows, and deleting the notebook removes the plan while library sources remain.

## 2. Generate an unsaved draft

- [x] 2.1 Add failing tests that a chat-enabled draft returns 4 to 8 parsed modules, writes no notebook or source, sends the goal as delimited data, and names locale `ru` when requested. Verify invalid JSON and fewer than 4 valid modules return `generation_failed` with no writes, chat disabled returns `ai_disabled` without a model call, and a suggested URL that fails the secure HEAD/GET check or the SSRF guard is absent from the draft.
- [x] 2.2 Add a failing unit test that `cooldownCheck` rejects a second `plan-draft:<userId>` call inside 30 seconds when the clock is injected. Verify the route test still runs with the existing test-mode cooldown disable.
- [x] 2.3 Implement `POST /notebooks/plan-drafts` on the non-streaming completion. Verify 2.1 and 2.2 pass and the route does not enqueue ingest.

## 3. Add accepted URLs

- [x] 3.1 Add failing tests for URL normalization, reuse of the oldest owned non-deleting match, create-and-attach of a new URL, a batch that stops at the library cap and the notebook source cap, a later ingest error that keeps the module link, and a foreign module that writes nothing. Verify no test creates a card.
- [x] 3.2 Implement `POST /notebooks/:id/plan/modules/:moduleId/sources` with the pure normalizer, the existing inline URL insert, and after-commit enqueue. Verify 3.1 passes, a retry of the same URL does not insert a second row, and a crash-shaped partial batch leaves the earlier rows reusable.

## 4. Propose the plan in the existing assistant

- [ ] 4.1 Add failing tests that `propose_topic_plan` is offered in the global assistant registry and the notebook registry, that a goal call returns 4 to 8 modules and writes no notebook or source, that a call which already includes a module list does not call the model, that a dead or private URL is absent, and that chat disabled makes no model call. Verify the welcome screen source does not gain a learn-a-topic action.
- [ ] 4.2 Render the proposal tool result as a plan card in the existing transcript, with both locales. Verify 4.1 passes, a second explicit module list replaces the card data without a completion, and cancelling or leaving the chat creates no notebook.

## 5. Confirm the plan and ingest the pages

- [ ] 5.1 Add failing tests that applying `create_topic_plan` creates one notebook and one plan, ingests each accepted URL through the existing URL ingest, attaches those sources to the notebook, and links them to the modules. Verify reject writes nothing, a fetch is not started before the source row exists, a later ingest error keeps the link, a cap stops the rest of the batch, the user id comes from the session, and no card row is created.
- [ ] 5.2 Implement the write tool on the existing confirm path, using the plan save and the per-module URL action. Render the same modules and URLs on the existing confirm card. Verify 5.1 passes and Apply does not call the model.

## 6. Show the plan on the notebook

- [ ] 6.1 Add failing tests for empty, ingesting, readable, and unavailable module status, and for opening a linked source in the existing reader. Verify the tests fail while the dock has no Plan tab, and verify the tab is not a goal or URL form.
- [ ] 6.2 Add the Plan tab and select it on first open when a plan exists. Verify 6.1 passes, overview and studio still render, and neither opening the tab nor reading the plan creates a card.
- [ ] 6.3 Update `CLAUDE.md` with the chat proposal, the confirm ingest, the four tables, and the API-before-web rollback, then mirror the body into `AGENTS.md`. Verify the files differ only by the Codex header.

## 7. Fresh verification after the last edit

- [ ] 7.1 Run `bun run spec:validate`, `bun run typecheck`, `bun run db:migrate:apply:test`, and `bun run test:ci`. Verify each command exits 0.
- [ ] 7.2 Run `bun run build` and the learner smoke in `.cursor/skills/verify-reomi/SKILL.md` against the local stack. Verify a new account still reaches the existing deck, library, and chat actions from the welcome screen, and that the welcome screen has no plan dialog.
