# Add a card

Add a card saves one Basic question and answer into the deck just created.

## Sub-features

- `open-editor` opens the editor for that deck.
- `save-card` stores the question and answer.

## How to get to it (user POV)

- On the deck row, open `Deck menu: <deck>` and choose `Add card`.
- Type the question and answer, then choose `Create`.

## Driving it with Playwright

Preconditions:

- The treeitem for this run's deck is visible.
- The question and answer are `<prefix> question` and `<prefix> answer`.

- **Open the editor.** Choose the button `Deck menu: <deck>`, then the menuitem `Add card`. The URL contains `/editor?deck=`.
- **Save.** Fill the textbox `Question` and the textbox `Answer`. Choose the button `Create`. The URL contains `/editor?card=` and the text `Card saved` is visible. Save `e2e/artifacts/04-card.png`.

## Gotchas

- The same button reads `Save` after the first successful save. This journey uses `Create` once.
- The menu closes before navigation. Wait for the editor URL after the menuitem click.
- `Card saved` disappears. The `card` query is the lasting proof.
