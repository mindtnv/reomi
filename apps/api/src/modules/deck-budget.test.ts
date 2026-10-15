import { describe, expect, test } from 'bun:test';
import { allocateDeckBudgets, pathRemaining, type BudgetDeck, type DeckSpend, type DeckSupply } from './deck-budget.ts';

function deck(id: string, parentId: string | null, newPerDay: number, reviewsPerDay = 200, position = 0): BudgetDeck {
  return { id, parentId, position, name: id, newPerDay, reviewsPerDay };
}

function supply(entries: Record<string, number>): Map<string, DeckSupply> {
  return new Map(Object.entries(entries).map(([id, newCards]) => [id, { newCards, reviews: 0 }]));
}

function spend(entries: Record<string, number>): Map<string, DeckSpend> {
  return new Map(Object.entries(entries).map(([id, introduced]) => [id, { introduced, reviewed: 0 }]));
}

describe('deck budget allocation', () => {
  test('sibling limits add on study-all and stay separate after one deck is spent', () => {
    const decks = [deck('A', null, 10, 200, 0), deck('B', null, 10, 200, 1)];
    const cards = supply({ A: 12, B: 12 });
    const before = allocateDeckBudgets(decks, new Map(), cards, null);
    expect(before.newByDeck.get('A')).toBe(10);
    expect(before.newByDeck.get('B')).toBe(10);
    expect(before.newRemaining).toBe(20);
    expect(allocateDeckBudgets(decks, new Map(), cards, 'A').newByDeck.get('A')).toBe(10);
    const after = allocateDeckBudgets(decks, spend({ A: 10 }), cards, null);
    expect(after.newByDeck.get('A')).toBe(0);
    expect(after.newByDeck.get('B')).toBe(10);
    expect(allocateDeckBudgets(decks, spend({ A: 10 }), cards, 'B').newRemaining).toBe(10);
  });

  test('a parent of 15 lets the first child take 10 and the second take 5', () => {
    const decks = [deck('P', null, 15), deck('A', 'P', 10, 200, 0), deck('B', 'P', 10, 200, 1)];
    const cards = supply({ A: 12, B: 12 });
    const parent = allocateDeckBudgets(decks, new Map(), cards, 'P');
    expect(parent.newByDeck.get('A')).toBe(10);
    expect(parent.newByDeck.get('B')).toBe(5);
    expect(parent.newRemaining).toBe(15);
    expect(allocateDeckBudgets(decks, new Map(), cards, 'B').newByDeck.get('B')).toBe(10);
    const spent = allocateDeckBudgets(decks, spend({ A: 10 }), cards, 'P');
    expect(spent.newByDeck.get('A')).toBe(0);
    expect(spent.newByDeck.get('B')).toBe(5);
    expect(pathRemaining(decks, spend({ A: 10 }), 'B', 'new')).toBe(5);
  });

  test('a missing preset is the default cap, and a top-level preset is not capped again', () => {
    const nested = [deck('P', null, 20), deck('C', 'P', 50)];
    expect(allocateDeckBudgets(nested, new Map(), supply({ C: 80 }), 'C').newByDeck.get('C')).toBe(20);
    const raised = [deck('Solo', null, 50)];
    expect(allocateDeckBudgets(raised, new Map(), supply({ Solo: 80 }), null).newRemaining).toBe(50);
  });

  test('short supply does not move leftover parent slots onto a full sibling', () => {
    const decks = [deck('P', null, 15), deck('A', 'P', 10, 200, 0), deck('B', 'P', 10, 200, 1)];
    const allocated = allocateDeckBudgets(decks, new Map(), supply({ A: 3, B: 12 }), 'P');
    expect(allocated.newByDeck.get('A')).toBe(3);
    expect(allocated.newByDeck.get('B')).toBe(10);
    expect(allocated.newRemaining).toBe(15);
  });

  test('an explicit response cap keeps the front of gather order', () => {
    const decks = [deck('A', null, 10, 200, 0), deck('B', null, 10, 200, 1)];
    const allocated = allocateDeckBudgets(decks, new Map(), supply({ A: 12, B: 12 }), null, () => true, { newCards: 5 });
    expect(allocated.newByDeck.get('A')).toBe(5);
    expect(allocated.newByDeck.get('B')).toBe(0);
    expect(allocated.newRemaining).toBe(5);
  });

  test('one spent introduction leaves no room on that path', () => {
    const decks = [deck('Solo', null, 1)];
    expect(pathRemaining(decks, spend({ Solo: 1 }), 'Solo', 'new')).toBe(0);
    expect(pathRemaining(decks, new Map(), 'missing', 'new')).toBe(0);
  });
});
