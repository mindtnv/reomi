---
name: verify-reomi
description: Drive the Reomi web app as a signed-in learner. Use before a pull request that changes UI or API behavior, and when checking sign-in, decks, cards, review, or statistics. Local runs use docker compose Postgres and bun. Production runs sign in at https://app.reomi.ru.
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
2. Open `Account: <name>` and choose `Sign out`. Expect `/auth/sign-in`.
3. Sign in with `Войти`.
4. If the garden heading is visible, choose `Build a deck`. Otherwise choose the `Decks` link.
5. Choose `New deck`, fill `Name` in the `New deck` dialog, and choose `Create`. Expect a treeitem named with the deck.
6. Open `Deck menu: <deck>`, choose `Add card`, fill the `Question` and `Answer` textboxes, and choose `Create`. Expect `/editor?card=` and the text `Card saved`.
7. Return to `Decks`, open the same deck menu, and choose `Study`. Expect the question, then `Show answer`, then the answer. Choose the button whose name contains `3` and `Good`.
8. Expect the heading `Your next review is coming up` and the text `Your answers have already been saved.`
9. Open `Stats`. Expect `Due forecast`, `Retention by interval`, `Per-deck performance`, and a row that contains the deck name and the exact text `1 own`.

Production uses the same steps from sign-in onward. It does not sign up and does not require the garden. Deck, question, and answer all start with `e2e-<time>-<entropy>`.

## Evidence

`bun run e2e` writes screenshots to `e2e/artifacts/` after the garden, sign-in, deck, saved card, review result, and statistics row. A failure also leaves Playwright's screenshot under `test-results/`. Capture the action and the resulting screen. A toast or a heading alone is not enough when the URL or the created row can be checked.

Production traces and video stay off so the test password is not recorded. Local traces stay only after a failure, under `test-results/`, and use the disposable password from that run.

## Cleanup

`bun run e2e` kills the dev process group recorded in `e2e/artifacts/dev.pid`. It does not kill by process name. It deletes `.env` only when this run created it. It runs `docker compose stop postgres` only when this run started Postgres. It does not run `docker compose down -v`.

The browser walk deletes only the deck it created, by the exact treeitem name, through `Deck menu` and the confirm button `Delete`. A missing treeitem is a no-op. Proof files in `e2e/artifacts/`, `test-results/`, and `playwright-report/` stay on disk.

## Helpers

- `bun run e2e` runs `scripts/verify-reomi.sh` against the local stack.
- `bun run e2e:prod` runs the same script with `E2E_TARGET=prod`.
- `bun run e2e:doctor` runs `scripts/verify-reomi-doctor.sh`.

When the map drifts from the product, run `/maintain-verification-skill`.
