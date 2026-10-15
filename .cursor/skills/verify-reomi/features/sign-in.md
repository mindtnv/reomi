# Sign in

Sign in lets a learner create an account, leave it, and enter again at `/auth/sign-in`.

## Sub-features

- `sign-up` creates an account and opens an empty library.
- `sign-out` returns to the sign-in page.
- `sign-in` restores the same account.

## How to get to it (user POV)

- Open `/auth/sign-up` and submit the account form.
- Open the account control and choose `Sign out`.
- Open `/auth/sign-in` and submit email and password.

## Driving it with Playwright

Preconditions:

- Local web is `http://localhost:3001` and `bun run e2e:doctor` passes.
- The browser locale is `en-US`.
- Production already has `E2E_EMAIL` and `E2E_PASSWORD`. Do not open sign-up there.

- **Sign up.** Open `/auth/sign-up`. Fill the textbox `Имя`, the textbox `Email`, and the textbox `Пароль`. Choose the button `Зарегистрироваться`. The heading `A quiet garden.` is visible. Save `e2e/artifacts/01-garden.png`.
- **Sign out.** Choose the control labelled `Account: <name>`, then the button `Sign out`. The URL is `/auth/sign-in`.
- **Sign in.** Open `/auth/sign-in`. Fill `Email` and `Пароль`. Choose the button `Войти`. A control whose label starts with `Account:` is visible. Save `e2e/artifacts/02-signed-in.png`.
- **Production.** Skip sign-up and sign-out. Start at sign-in. A garden heading means the account has no decks. Its absence means the account already has data. Continue from whichever screen is showing.

## Gotchas

- The account control is a disclosure labelled `Account: <name>`. Chromium exposes it as a generic, so a button role does not find it. Use the label.
- The auth form stays Russian when the rest of the UI is English.
- `127.0.0.1` does not match `WEB_ORIGIN`, so the session cookie is dropped.
- Sign-up allows 5 attempts per hour per IP. Sign-in allows 5 per minute. A second local loop can lock the walk.
- Production never creates an account. Missing secrets skip the job with a warning.
