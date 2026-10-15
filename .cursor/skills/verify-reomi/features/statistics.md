# Statistics

Statistics shows the forecast, interval retention, and the deck that just received a card.

## Sub-features

- `open-stats` opens the statistics page.
- `deck-row` shows the new deck with one own card.
- `delete-deck` removes only that deck.

## How to get to it (user POV)

- Choose `Stats` in the sidebar.
- Read the forecast and the per-deck row.
- Return to `Decks` and delete the deck created for this walk.

## Driving it with Playwright

Preconditions:

- The Good grade from this run has been saved.
- The deck name is still the unique prefix.

- **Open statistics.** Choose the link `Stats`. The URL contains `/stats`. The texts `Due forecast`, `Retention by interval`, and `Per-deck performance` are visible.
- **Find the row.** The visible row that contains the exact deck name and the exact text `1 own` is on screen. Save `e2e/artifacts/06-stats.png`.
- **Delete the deck.** Open `/decks`, open `Deck menu: <deck>`, choose the menuitem `Delete`, and choose `Delete` in the dialog that names the deck. The treeitem count for that name is 0.

## Gotchas

- Do not assert a global Good count of 1. Other decks on a production account already have reviews.
- Match `1 own` exactly. The text `11 own` contains `1 own` as a substring.
- Use the last container that contains both the deck name and `1 own`, so a parent that also lists other decks is not the row.
- Delete failure after a successful walk fails the run. Delete failure after a failed walk still rethrows the original walk error.
- A second delete is a no-op when the treeitem is already gone. Cleanup does not remove `e2e/artifacts/`.
