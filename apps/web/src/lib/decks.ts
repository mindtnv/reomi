import { compareDeckOrder } from '@reomi/shared';
import type { Card, Deck } from './types';

export interface DeckNode {
  deck: Deck;
  depth: number;
  children: DeckNode[];
}

/** Build a tree of DeckNodes from a flat list. Orphans (missing parents) become roots. */
export function buildDeckTree(decks: Deck[]): DeckNode[] {
  const byParent = new Map<string | null, Deck[]>();
  const known = new Set(decks.map((d) => d.id));
  for (const d of decks) {
    const key = d.parentId && known.has(d.parentId) ? d.parentId : null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(d);
  }
  const build = (parentId: string | null, depth: number): DeckNode[] =>
    (byParent.get(parentId) ?? [])
      .slice()
      .sort(compareDeckOrder)
      .map((deck) => ({ deck, depth, children: build(deck.id, depth + 1) }));
  return build(null, 0);
}

/** Flatten a tree to an array of nodes (used when a flat list of indented rows is wanted). */
export function flattenTree(nodes: DeckNode[], expanded: Set<string>): DeckNode[] {
  const out: DeckNode[] = [];
  const walk = (ns: DeckNode[]) => {
    for (const n of ns) {
      out.push(n);
      if (expanded.has(n.deck.id)) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** All descendants (children, grandchildren, …) of a deck. */
export function getDescendantIds(decks: Deck[], deckId: string): string[] {
  const children = decks.filter((d) => d.parentId === deckId).map((d) => d.id);
  return children.flatMap((id) => [id, ...getDescendantIds(decks, id)]);
}

/** Path from root to the given deck (inclusive). Empty if deck not found. */
export function getDeckPath(decks: Deck[], deckId: string | undefined): Deck[] {
  if (!deckId) return [];
  const byId = new Map(decks.map((d) => [d.id, d]));
  const path: Deck[] = [];
  let current = byId.get(deckId);
  // Prevent infinite loops from corrupted cycles.
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

/** Aggregate counts over a deck and its descendants. */
export function aggregateCounts(
  decks: Deck[],
  cards: Card[],
  deckId: string,
  now: number = Date.now(),
): { total: number; due: number } {
  const ids = new Set([deckId, ...getDescendantIds(decks, deckId)]);
  let total = 0;
  let due = 0;
  for (const c of cards) {
    if (!ids.has(c.deckId)) continue;
    total += 1;
    if (new Date(c.fsrs.due).getTime() <= now) due += 1;
  }
  return { total, due };
}

/** Prevent placing a deck under one of its descendants (would form a cycle). */
export function canBeParentOf(decks: Deck[], deckId: string, proposedParentId: string | undefined): boolean {
  if (!proposedParentId) return true;
  if (proposedParentId === deckId) return false;
  const descendants = new Set(getDescendantIds(decks, deckId));
  return !descendants.has(proposedParentId);
}

/** Human-readable path like "Languages / German vocab / B1". */
export function deckPathLabel(decks: Deck[], deckId: string | undefined, sep = ' / '): string {
  return getDeckPath(decks, deckId)
    .map((d) => d.name)
    .join(sep);
}

/**
 * Decide what a whole-row tap on the decks launcher should do.
 * Parent-with-children → toggle collapse; leaf → open the cards browser
 * pre-filtered to this deck (quoting the name + escaping embedded quotes so
 * names with spaces parse as one `deck:` term). Mirrors decks.tsx escaping.
 */
export function deckRowTarget(node: DeckNode): { kind: 'toggle' } | { kind: 'cards'; query: string } {
  if (node.children.length > 0) return { kind: 'toggle' };
  const escaped = node.deck.name.replace(/"/g, '\\"');
  return { kind: 'cards', query: encodeURIComponent(`deck:"${escaped}"`) };
}
