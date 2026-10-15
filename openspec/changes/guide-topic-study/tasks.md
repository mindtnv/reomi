# Tasks

Each numbered section is one pull request. Land them in order. A later section starts from the previous section's merged result.

## 1. Persist an owned plan

- [ ] 1.1 Add failing API tests for a first save, a hand-built module with no URLs, a 13-module reject, a forward prerequisite reject, a second save that keeps one module's identity and does not rename the notebook, a second save that drops a module without deleting its library source, a 409 when the notebook already has a plan, and a foreign or missing notebook. Verify the new test file fails before the schema exists.
- [ ] 1.2 Add `topic_plans`, `topic_modules`, `topic_module_prerequisites`, and `topic_module_sources` to the Drizzle schema and generate the next versioned migration. Verify `bun run db:migrate:apply:test` applies it on an empty test database and on a database that already has the previous chain head.
- [ ] 1.3 Implement save and read for `POST /notebooks/plans`, `PUT /notebooks/:id/plan`, and `GET /notebooks/:id/plan` inside one transaction per save. Verify 1.1 passes, a save creates no card rows, and deleting the notebook removes the plan while library sources remain.

## 2. Generate an unsaved draft

- [ ] 2.1 Add failing tests that a chat-enabled draft returns 4 to 8 parsed modules, writes no notebook or source, sends the goal as delimited data, and names locale `ru` when requested. Verify invalid JSON and fewer than 4 valid modules return `generation_failed` with no writes, chat disabled returns `ai_disabled` without a model call, and a suggested URL that fails the secure HEAD/GET check or the SSRF guard is absent from the draft.
- [ ] 2.2 Add a failing unit test that `cooldownCheck` rejects a second `plan-draft:<userId>` call inside 30 seconds when the clock is injected. Verify the route test still runs with the existing test-mode cooldown disable.
- [ ] 2.3 Implement `POST /notebooks/plan-drafts` on the non-streaming completion. Verify 2.1 and 2.2 pass and the route does not enqueue ingest.

## 3. Add accepted URLs

- [ ] 3.1 Add failing tests for URL normalization, reuse of the oldest owned non-deleting match, create-and-attach of a new URL, a batch that stops at the library cap and the notebook source cap, a later ingest error that keeps the module link, and a foreign module that writes nothing. Verify no test creates a card.
- [ ] 3.2 Implement `POST /notebooks/:id/plan/modules/:moduleId/sources` with the pure normalizer, the existing inline URL insert, and after-commit enqueue. Verify 3.1 passes, a retry of the same URL does not insert a second row, and a crash-shaped partial batch leaves the earlier rows reusable.

## 4. Open the plan from an empty account

- [ ] 4.1 Add failing web tests that the welcome screen shows the learn-a-topic action plus the existing deck, library, and chat actions, that generate is unavailable when chat is off, and that a blank save routes to the new notebook. Verify both locale catalogs contain the new strings.
- [ ] 4.2 Build the shared dialog for the welcome screen, the empty notebooks screen, and a notebook that has no plan. Verify 4.1 passes, a failed save keeps the typed modules, and cancelling a draft does not create a notebook.

## 5. Show the plan on the notebook

- [ ] 5.1 Add failing tests for empty, ingesting, readable, and unavailable module status, and for opening a linked source in the existing reader. Verify the tests fail while the dock has no Plan tab.
- [ ] 5.2 Add the Plan tab, select it on first open when a plan exists, and wire the add-sources action to the response codes from section 3. Verify 5.1 passes, overview and studio still render, and neither opening the tab nor adding a URL creates a card.
- [ ] 5.3 Update `CLAUDE.md` with the plan route, the four tables, and the API-before-web rollback, then mirror the body into `AGENTS.md`. Verify the files differ only by the Codex header.

## 6. Fresh verification after the last edit

- [ ] 6.1 Run `bun run spec:validate`, `bun run typecheck`, `bun run db:migrate:apply:test`, and `bun run test:ci`. Verify each command exits 0 on the merged sections.
- [ ] 6.2 Run `bun run build` and the learner smoke in `.cursor/skills/verify-reomi/SKILL.md` against the local stack. Verify a new account can save a hand-built plan, add one URL, open it from the plan, and still reach the existing deck, library, and chat actions from the welcome screen.
