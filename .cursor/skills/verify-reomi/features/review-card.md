# Review a card

Review a card shows the saved question, reveals the answer, and records a Good grade.

## Sub-features

- `open-study` starts a deck-scoped review.
- `reveal` shows the answer that was hidden.
- `grade-good` saves the grade and shows the next-step state.

## How to get to it (user POV)

- On the deck row, open `Deck menu: <deck>` and choose `Study`.
- Choose `Show answer`, read the answer, then choose `Good`.

## Driving it with Playwright

Preconditions:

- The card from this run is saved in the deck.
- Study starts from the deck menu, not from a count badge.

- **Open study.** Choose the link `Decks`, then `Deck menu: <deck>`, then the menuitem `Study`. The URL contains `/review?deck=`. The question text is visible and the answer text is not.
- **Reveal.** Choose the button whose name contains `Show answer`. The answer text is visible.
- **Grade.** Choose the button whose name contains `3` and `Good`. The heading `Your next review is coming up` is visible, and the page contains `Your answers have already been saved.` Save `e2e/artifacts/05-review.png`.

## Gotchas

- The row link `Review →` appears only after the study summary counts the new card. The menu item `Study` does not wait for that count.
- A new card's Good grade schedules a one-minute learning step, so the queue waits instead of showing `Session complete`.
- If a run shows `Session complete` instead, record the heading that actually appeared. Do not treat the waiting copy as optional before a run has shown the other screen.
