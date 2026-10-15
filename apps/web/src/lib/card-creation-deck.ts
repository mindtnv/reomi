import { parseCardQuery, type CardQueryNode } from '@reomi/shared';
import { deckPathLabel } from './decks';
import type { Deck } from './types';

/** Only an unambiguous positive deck filter can choose a creation destination. */
export function cardCreationDeck(query: string, decks: Deck[]): Deck | undefined {
  try {
    const values: string[] = [];
    const visit = (node: CardQueryNode): boolean => {
      if (node.kind === 'or') return false;
      if (node.kind === 'group') return visit(node.child);
      if (node.kind === 'and') return node.children.every(visit);
      if (node.kind === 'term' && node.field === 'deck') values.push(node.value.toLowerCase());
      return true;
    };
    if (!visit(parseCardQuery(query)) || new Set(values).size !== 1) return undefined;
    const matches = decks.filter(deck => deck.id.toLowerCase() === values[0] || deck.name.toLowerCase() === values[0] || deckPathLabel(decks, deck.id).toLowerCase() === values[0]);
    return matches.length === 1 ? matches[0] : undefined;
  } catch { return undefined; }
}
