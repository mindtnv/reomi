# Reomi verification map

This directory is the maintained source for the learner walk through Reomi. Read the index, then use the matching feature file.

## Baseline preconditions

- Local launch is `bun run e2e` from the repo root. It owns Postgres, migrations, and `bun run dev`.
- Drive `http://localhost:3001` only. Do not substitute `127.0.0.1`.
- `bun run e2e:doctor` reports both ready URLs before extra manual driving.
- Production launch is `bun run e2e:prod` with `E2E_EMAIL` and `E2E_PASSWORD`. It signs in at `https://app.reomi.ru` and does not create an account.
- One local sign-up and one sign-in stay inside the rate limits. Do not repeat them in a loop.
- Refuse to start when port 3000 or 3001 is already taken.

## Driving conventions

- Playwright locale is `en-US`, viewport 1280×800, one worker.
- Prefer role and accessible name. The scripted walk is `e2e/smoke.e2e.ts`.
- Auth controls keep their Russian names. The rest of the shell uses English.
- Created deck, question, and answer share the prefix `e2e-<time>-<entropy>`.
- Delete that deck at the end. Leave screenshots in `e2e/artifacts/`.

## Proof and skip reporting

- Record the click and the next screen, URL, or row.
- A production skip because secrets are missing is a warning and exit 0, not a passed walk.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 and one paragraph, then exactly four H2 sections in this order.

1. `Sub-features`
2. `How to get to it (user POV)`
3. `Driving it with Playwright`
4. `Gotchas`

## Features

- [Sign in](./sign-in.md) covers sign-up, sign-out, and sign-in.
- [Create a deck](./create-deck.md) covers the new-deck dialog and the deck row.
- [Add a card](./add-card.md) covers the editor save.
- [Review a card](./review-card.md) covers reveal and a Good grade.
- [Statistics](./statistics.md) covers the forecast, retention, and the new deck row.
