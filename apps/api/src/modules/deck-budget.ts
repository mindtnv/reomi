// Per-deck daily budgets. A deck's own limit is its nearest preset, or the
// 20/200 default. Every ancestor caps that deck too, so a parent budget
// constrains its children and study-all is the sum of those trees. Spend is
// the reviews committed in the open study epoch. Learning steps are outside
// this budget. Callers that already hold the profile lock can reject a grade
// when the path has no room left; nothing is reserved ahead of the grade.

import { reviews, db } from '@reomi/db';
import { sql, type SQL } from 'drizzle-orm';
import { DEFAULT_NEW_PER_DAY, DEFAULT_REVIEWS_PER_DAY, resolveDeckConfig, type DeckConfigSnapshot } from './deck-config.ts';
import type { SqlExecutor } from './study-day.ts';

export interface BudgetDeck {
  id: string;
  parentId: string | null;
  position: number;
  name: string;
  newPerDay: number;
  reviewsPerDay: number;
}

export interface DeckSpend {
  introduced: number;
  reviewed: number;
}

export interface DeckSupply {
  newCards: number;
  reviews: number;
}

export type BudgetKind = 'new' | 'review';

export interface BudgetAllocation {
  order: string[];
  newRemaining: number;
  reviewRemaining: number;
  newByDeck: Map<string, number>;
  reviewByDeck: Map<string, number>;
}

interface IndexedDecks {
  byId: Map<string, BudgetDeck>;
  children: Map<string | null, BudgetDeck[]>;
}

function compareDeck(a: BudgetDeck, b: BudgetDeck): number {
  return a.position - b.position || a.name.localeCompare(b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function indexDecks(decks: readonly BudgetDeck[]): IndexedDecks {
  const byId = new Map(decks.map((deck) => [deck.id, deck]));
  const children = new Map<string | null, BudgetDeck[]>();
  for (const deck of decks) {
    const parent = deck.parentId && byId.has(deck.parentId) ? deck.parentId : null;
    const list = children.get(parent) ?? [];
    list.push(deck);
    children.set(parent, list);
  }
  for (const list of children.values()) list.sort(compareDeck);
  return { byId, children };
}

function spendOf(spend: ReadonlyMap<string, DeckSpend>, deckId: string, kind: BudgetKind): number {
  const row = spend.get(deckId);
  return kind === 'new' ? row?.introduced ?? 0 : row?.reviewed ?? 0;
}

function limitOf(deck: BudgetDeck, kind: BudgetKind): number {
  return kind === 'new' ? deck.newPerDay : deck.reviewsPerDay;
}

function supplyOf(supply: ReadonlyMap<string, DeckSupply>, deckId: string, kind: BudgetKind): number {
  const row = supply.get(deckId);
  return kind === 'new' ? row?.newCards ?? 0 : row?.reviews ?? 0;
}

function subtreeSpend(
  deckId: string,
  kind: BudgetKind,
  indexed: IndexedDecks,
  spend: ReadonlyMap<string, DeckSpend>,
  seen = new Set<string>(),
): number {
  if (seen.has(deckId)) return 0;
  seen.add(deckId);
  let total = spendOf(spend, deckId, kind);
  for (const child of indexed.children.get(deckId) ?? []) {
    total += subtreeSpend(child.id, kind, indexed, spend, seen);
  }
  return total;
}

function gather(indexed: IndexedDecks, scopeId: string | null): BudgetDeck[] {
  const out: BudgetDeck[] = [];
  const visit = (deck: BudgetDeck, seen: Set<string>) => {
    if (seen.has(deck.id)) return;
    seen.add(deck.id);
    out.push(deck);
    for (const child of indexed.children.get(deck.id) ?? []) visit(child, seen);
  };
  const seen = new Set<string>();
  const roots = scopeId ? (indexed.byId.has(scopeId) ? [indexed.byId.get(scopeId)!] : []) : indexed.children.get(null) ?? [];
  for (const root of roots) visit(root, seen);
  return out;
}

export function pathRemaining(
  decks: readonly BudgetDeck[],
  spend: ReadonlyMap<string, DeckSpend>,
  deckId: string,
  kind: BudgetKind,
): number {
  const indexed = indexDecks(decks);
  if (!indexed.byId.has(deckId)) return 0;
  let room = Number.POSITIVE_INFINITY;
  const seen = new Set<string>();
  let current = indexed.byId.get(deckId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    room = Math.min(room, Math.max(0, limitOf(current, kind) - subtreeSpend(current.id, kind, indexed, spend)));
    current = current.parentId ? indexed.byId.get(current.parentId) : undefined;
  }
  return Number.isFinite(room) ? room : 0;
}

function copySpend(spend: ReadonlyMap<string, DeckSpend>): Map<string, DeckSpend> {
  return new Map([...spend].map(([id, row]) => [id, { introduced: row.introduced, reviewed: row.reviewed }]));
}

function addSpend(spend: Map<string, DeckSpend>, deckId: string, kind: BudgetKind, amount: number) {
  const row = spend.get(deckId) ?? { introduced: 0, reviewed: 0 };
  if (kind === 'new') row.introduced += amount;
  else row.reviewed += amount;
  spend.set(deckId, row);
}

function takeKind(
  indexed: IndexedDecks,
  order: readonly BudgetDeck[],
  spend: ReadonlyMap<string, DeckSpend>,
  supply: ReadonlyMap<string, DeckSupply>,
  kind: BudgetKind,
  finite: boolean,
  include: (deckId: string) => boolean,
): Map<string, number> {
  const local = copySpend(spend);
  const takes = new Map<string, number>();
  for (const deck of order) {
    const room = pathRemaining(indexedToList(indexed), local, deck.id, kind);
    const take = include(deck.id) ? Math.min(room, finite ? supplyOf(supply, deck.id, kind) : room) : 0;
    takes.set(deck.id, take);
    if (take > 0) addSpend(local, deck.id, kind, take);
  }
  return takes;
}

function indexedToList(indexed: IndexedDecks): BudgetDeck[] {
  return [...indexed.byId.values()];
}

function clampTail(order: readonly string[], takes: Map<string, number>, cap: number | undefined): Map<string, number> {
  if (cap === undefined) return takes;
  let extra = 0;
  for (const value of takes.values()) extra += value;
  extra -= cap;
  if (extra <= 0) return takes;
  const next = new Map(takes);
  for (let i = order.length - 1; i >= 0 && extra > 0; i--) {
    const id = order[i]!;
    const have = next.get(id) ?? 0;
    const drop = Math.min(have, extra);
    next.set(id, have - drop);
    extra -= drop;
  }
  return next;
}

function total(takes: ReadonlyMap<string, number>): number {
  let sum = 0;
  for (const value of takes.values()) sum += value;
  return sum;
}

export function allocateDeckBudgets(
  decks: readonly BudgetDeck[],
  spend: ReadonlyMap<string, DeckSpend>,
  supply: ReadonlyMap<string, DeckSupply>,
  scopeId: string | null,
  include: (deckId: string) => boolean = () => true,
  clamp: { newCards?: number; reviews?: number } = {},
): BudgetAllocation {
  const indexed = indexDecks(decks);
  const visited = gather(indexed, scopeId);
  const order = visited.map((deck) => deck.id);
  const newByDeck = clampTail(order, takeKind(indexed, visited, spend, supply, 'new', true, include), clamp.newCards);
  const reviewByDeck = clampTail(order, takeKind(indexed, visited, spend, supply, 'review', true, include), clamp.reviews);
  const newSlots = clampTail(order, takeKind(indexed, visited, spend, supply, 'new', false, include), clamp.newCards);
  const reviewSlots = clampTail(order, takeKind(indexed, visited, spend, supply, 'review', false, include), clamp.reviews);
  return {
    order,
    newRemaining: total(newSlots),
    reviewRemaining: total(reviewSlots),
    newByDeck,
    reviewByDeck,
  };
}

export function budgetDecksFromSnapshot(snapshot: DeckConfigSnapshot): BudgetDeck[] {
  return snapshot.userDecks.map((deck) => {
    const config = resolveDeckConfig(deck.id, snapshot);
    return {
      id: deck.id,
      parentId: deck.parentId,
      position: deck.position,
      name: deck.name,
      newPerDay: config.newPerDay ?? DEFAULT_NEW_PER_DAY,
      reviewsPerDay: config.reviewsPerDay ?? DEFAULT_REVIEWS_PER_DAY,
    };
  });
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

/** Introductions and mature reviews committed during the open epoch, by deck. */
export async function loadDeckSpend(
  userId: string,
  start: Date,
  end: Date,
  executor: SqlExecutor = db,
): Promise<Map<string, DeckSpend>> {
  const query: SQL = sql`
    SELECT ${reviews.deckId} AS "deckId",
      count(*) FILTER (
        WHERE ${reviews.undoSnapshot}->'card'->>'state' = 'new'
          AND coalesce(${reviews.undoSnapshot}->>'countsTowardBudget', 'true') <> 'false'
      )::int AS "introduced",
      count(*) FILTER (
        WHERE ${reviews.undoSnapshot}->'card'->>'state' = 'review'
          AND coalesce(${reviews.undoSnapshot}->>'countsTowardBudget', 'true') <> 'false'
      )::int AS "reviewed"
    FROM ${reviews}
    WHERE ${reviews.userId} = ${userId}
      AND ${reviews.reviewedAt} >= ${start.toISOString()}
      AND ${reviews.reviewedAt} < ${end.toISOString()}
      AND ${reviews.deckId} IS NOT NULL
    GROUP BY ${reviews.deckId}
  `;
  const rows = rowsOf<{ deckId: string; introduced: number | string; reviewed: number | string }>(
    await executor.execute(query),
  );
  return new Map(rows.map((row) => [row.deckId, {
    introduced: Number(row.introduced),
    reviewed: Number(row.reviewed),
  }]));
}
