# Create a deck

Create a deck adds one named deck and shows it in the deck list.

## Sub-features

- `open-decks` reaches the deck list from the garden or the sidebar.
- `create-deck` submits a name and shows the new row.

## How to get to it (user POV)

- On `A quiet garden.`, choose `Build a deck`.
- Otherwise choose `Decks` in the sidebar.
- Choose `New deck`, type a name, and choose `Create`.

## Driving it with Playwright

Preconditions:

- The learner is signed in and the account button is visible.
- The deck name is the unique `e2e-` prefix for this run.

- **Open the list.** If the heading `A quiet garden.` is visible, choose the link `Build a deck`. Otherwise choose the link `Decks`. The URL contains `/decks`.
- **Create.** Choose the button `New deck`. In the dialog named `New deck`, fill the textbox `Name` and choose `Create`. A treeitem with that exact name is visible. Save `e2e/artifacts/03-deck.png`.

## Gotchas

- The header and the empty state can both expose `New deck`. Choose the first button.
- Confirm the treeitem. A closed dialog is not proof that the deck was saved.
- Production accounts already contain other decks. Match the exact new name.
