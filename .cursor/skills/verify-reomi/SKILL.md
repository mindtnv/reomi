---
name: verify-reomi
description: Drive the Reomi web app as a signed-in learner. Use before a pull request that changes UI or API behavior, and when checking sign-in, decks, cards, review, statistics, chat, and settings. Local runs use docker compose Postgres and bun. Production runs sign in at https://app.reomi.ru.
---

# Verify Reomi

Reomi's primary surface is the Next.js web app. The API on port 3000 and personal MCP are secondary. This skill drives the web UI with Playwright. Two runs cannot share ports 3000, 3001, or 5432. If either web port is taken, stop and report the port. Do not kill a process you did not start.

## Launch

From the repo root, with Bun 1.4.2 and Docker available:

```bash
bun run e2e
```

That command copies `.env.example` to `.env` only when `.env` is missing, starts `docker compose up -d --wait postgres` when Postgres is not already running, applies `bun run db:migrate:apply`, installs Playwright Chromium, and starts `bun run dev`. Ready means both of these succeed:

- `curl -fsS -o /dev/null http://localhost:3000/ready`
- `curl -fsS -o /dev/null http://localhost:3001/auth/sign-in`

The API log line `api.listening` is written to `e2e/artifacts/dev-server.log`. Open the app at `http://localhost:3001`. Do not use `127.0.0.1`. The session cookie is bound to `WEB_ORIGIN`.

A production walk does not start local servers:

```bash
E2E_EMAIL=... E2E_PASSWORD=... bun run e2e:prod
```

If either secret is empty, the command prints `::warning::E2E_EMAIL or E2E_PASSWORD is unset. Skipping production smoke.` and exits 0. It never signs up on production.

## Doctor

While a local instance is up:

```bash
bun run e2e:doctor
```

Require HTTP 200 from `http://localhost:3000/ready` and `http://localhost:3001/auth/sign-in`. If `e2e/artifacts/dev.pid` exists, that pid must still be alive. Doctor does not click, write, or restart anything. `bun run e2e` runs doctor after ready and before the browser walk.

## Drive

Read `.cursor/skills/verify-reomi/features/README.md`, then the feature file for the journey. The scripted walk is `e2e/smoke.e2e.ts`. It uses one Chromium page at 1280×800 with locale `en-US`.

Auth copy stays Russian. Everything else stays English under `en-US`.

Local walk:

1. Open `/auth/sign-up`. Fill `Имя`, `Email`, and `Пароль`. Choose `Зарегистрироваться`. Expect the heading `A quiet garden.`
2. Open the account control labelled `Account: <name>` and choose `Sign out`. Expect `/auth/sign-in`.
3. Sign in with `Войти`.
4. If the garden heading is visible, choose `Build a deck`. Otherwise choose the `Decks` link.
5. Choose `New deck`, fill `Name` in the `New deck` dialog, and choose `Create`. Expect a treeitem named with the deck.
6. Open `Deck menu: <deck>`, choose `Add card`, fill the `Question` and `Answer` textboxes, and choose `Create`. Expect `/editor?card=` and the text `Card saved`.
7. Return to `Decks`, open the same deck menu, and choose `Study`. Expect the question, then `Show answer`, then the answer. Choose the button whose name contains `3` and `Good`.
8. Expect the heading `Your next review is coming up` and the text `Your answers have already been saved.`
9. Open `Stats`. Expect `Due forecast`, `Retention by interval`, and `Per-deck performance`. Scroll the row that contains the deck name and the exact text `1 own` into the viewport.

Production uses the same steps from sign-in onward. It does not sign up and does not require the garden. Deck, question, and answer all start with `e2e-<time>-<entropy>`.

Settings and the live assistant are `e2e/assistant-settings.e2e.ts`. That file creates or signs in its own learner and does not depend on the deck walk. Production uses `E2E_EMAIL` and `E2E_PASSWORD`. The Playwright smoke also opens Settings and expects the Notifications heading, then checks cookie-authenticated GET /ai/chat-probe.

1. Open `/settings`. Expect the heading `Notifications`. The page must not crash. A switch may be present.
2. Read cookie-authenticated GET /ai/chat-probe with the page's credentialed fetch. Local is `http://localhost:3000`. Production is `https://api.reomi.ru`. Parse the JSON with `parseChatProbe`.
3. When the probe is `{ ok: false, state: 'disabled' }` and the mode is not production, skip only that live assertion with the reason `CHAT_API_KEY unset; skipping live assistant assertion`. Production never skips. A null probe or a probe that is not ok fails the test.
4. Open `/chat` and send `Reply with the single word ok.`. Fail if `The assistant needs attention`, `The AI service is temporarily unavailable.`, or `Something went wrong. Please try again.` is visible. Wait up to 90s for a non-empty assistant reply.

e2e-prod sends a chat message and fails when the assistant shows the attention or unavailable state. Pull-request CI skips that live assertion with a clear reason when chat is disabled.

A pull request that changes user-visible UI attaches screenshots of each changed screen in a normal browser and in an installed or standalone PWA. Display-mode emulation counts. The reviewer looks at those screenshots before approve. Raw or unstyled HTML forms are a request for changes.

## Evidence

`bun run e2e` writes screenshots to `e2e/artifacts/` after the garden, sign-in, deck, saved card, review result, and statistics row. Capture the action and the resulting screen. A toast or a heading alone is not enough when the URL or the created row can be checked.

Traces, video, and page snapshots stay off. A failed sign-in used to copy the password into `error-context.md` and a trace used to keep the session cookie. The password field is cleared before the next assertion. After the walk, the run greps `e2e/artifacts`, `test-results`, and `playwright-report` for that password and fails if it appears. Pull-request CI uploads the screenshots only. `.github/workflows/e2e-prod.yml` runs the production walk after the `deploy` workflow completes on `main` with conclusion `success`. It checks out `github.event.workflow_run.head_sha`, uses concurrency group `e2e-prod` with `cancel-in-progress: true`, masks `E2E_PASSWORD`, and uploads nothing.

## Cleanup

`bun run e2e` kills the dev process group recorded in `e2e/artifacts/dev.pid`. It does not kill by process name. It deletes `.env` only when this run created it. It runs `docker compose stop postgres` only when this run started Postgres. It does not run `docker compose down -v`.

The browser walk deletes only the deck it created, by the exact treeitem name, through `Deck menu` and the confirm button `Delete`. A missing treeitem is a no-op. Proof files in `e2e/artifacts/`, `test-results/`, and `playwright-report/` stay on disk.

## Helpers

- `bun run e2e` runs `scripts/verify-reomi.sh` against the local stack.
- `bun run e2e:prod` runs the same script with `E2E_TARGET=prod`.
- `bun run e2e:doctor` runs `scripts/verify-reomi-doctor.sh`.

When the map drifts from the product, run `/maintain-verification-skill`.
