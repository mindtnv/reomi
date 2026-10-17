import { cards, db, decks, deckOptionsPreset, profile } from '@reomi/db';
import { eq, sql } from 'drizzle-orm';
import { STUDY_COUNT_KEYS, type StudyCounts, type StudySummary, type StudyOverview } from '@reomi/shared';
import { excludeActiveHolds } from './card-holds.ts';
import {
  allocateDeckBudgets,
  budgetDecksFromSnapshot,
  loadDeckSpend,
  type BudgetAllocation,
  type DeckSpend,
  type DeckSupply,
} from './deck-budget.ts';
import type { DeckConfigSnapshot } from './deck-config.ts';
import { readAccountStudyDay, studyDaySnapshot } from './study-day.ts';

/** One aggregate per deck; never fetches card contents or embeds vectors. */
export async function loadStudyCounts(userId: string, now: Date): Promise<Map<string, StudyCounts>> {
  const nowIso = now.toISOString();
  const free = excludeActiveHolds(cards.id, now);
  const studying = sql`${cards.suspended} = false and ${free}`;
  const buried = sql`${cards.suspended} = false and not (${free})`;
  const learning = sql`${cards.state} in ('learning', 'relearning')`;
  const rows = await db.select({
    deckId: cards.deckId,
    total: sql<number>`count(*)`.mapWith(Number),
    newCount: sql<number>`count(*) filter (where ${studying} and ${cards.state} = 'new')`.mapWith(Number),
    learningCount: sql<number>`count(*) filter (where ${studying} and ${learning})`.mapWith(Number),
    reviewCount: sql<number>`count(*) filter (where ${studying} and ${cards.state} = 'review')`.mapWith(Number),
    suspendedCount: sql<number>`count(*) filter (where ${cards.suspended})`.mapWith(Number),
    buriedCount: sql<number>`count(*) filter (where ${buried})`.mapWith(Number),
    dueBuried: sql<number>`count(*) filter (where ${buried} and ${cards.due} <= ${nowIso})`.mapWith(Number),
    dueNew: sql<number>`count(*) filter (where ${studying} and ${cards.state} = 'new' and ${cards.due} <= ${nowIso})`.mapWith(Number),
    dueLearning: sql<number>`count(*) filter (where ${studying} and ${learning} and ${cards.due} <= ${nowIso})`.mapWith(Number),
    dueReview: sql<number>`count(*) filter (where ${studying} and ${cards.state} = 'review' and ${cards.due} <= ${nowIso})`.mapWith(Number),
    nextLearningAt: sql<string | null>`min(${cards.due}) filter (where ${studying} and ${learning} and ${cards.due} > ${nowIso})`,
    nextDueAt: sql<string | null>`min(${cards.due}) filter (where ${studying} and ${cards.due} > ${nowIso})`,
  }).from(cards).where(eq(cards.userId, userId)).groupBy(cards.deckId);
  return new Map(rows.map(({ deckId, ...counts }) => [deckId, {
    ...counts,
    nextLearningAt: counts.nextLearningAt ? new Date(counts.nextLearningAt).toISOString() : null,
    nextDueAt: counts.nextDueAt ? new Date(counts.nextDueAt).toISOString() : null,
  }]));
}

export function sumStudyCounts(rows: Iterable<StudyCounts>): StudyCounts {
  const total = { nextLearningAt: null, nextDueAt: null } as StudyCounts;
  for (const key of STUDY_COUNT_KEYS) total[key] = 0;
  for (const row of rows) {
    for (const key of STUDY_COUNT_KEYS) {
      total[key] += row[key];
    }
    for (const key of ['nextLearningAt', 'nextDueAt'] as const) {
      if (row[key] && (!total[key] || row[key] < total[key])) total[key] = row[key];
    }
  }
  return total;
}

export function studyAvailability(counts: StudyCounts, newRemaining: number, reviewRemaining: number, now: Date): StudySummary {
  const availableNew = Math.min(counts.dueNew, newRemaining);
  const availableReview = Math.min(counts.dueReview, reviewRemaining);
  return {
    ...counts, newRemaining, reviewRemaining, availableNew, availableReview,
    totalAvailable: counts.dueLearning + availableNew + availableReview,
    limitedNew: counts.dueNew - availableNew,
    limitedReview: counts.dueReview - availableReview,
    serverNow: now.toISOString(),
  };
}

export function supplyFromCounts(counts: Iterable<[string, StudyCounts]>): Map<string, DeckSupply> {
  return new Map([...counts].map(([id, row]) => [id, { newCards: row.dueNew, reviews: row.dueReview }]));
}

/** Slot totals follow the tree budget. Offered cards follow the same walk with the cards each deck actually has. */
export function summarizeAllocation(counts: StudyCounts, allocation: BudgetAllocation, now: Date): StudySummary {
  let offeredNew = 0;
  let offeredReview = 0;
  for (const value of allocation.newByDeck.values()) offeredNew += value;
  for (const value of allocation.reviewByDeck.values()) offeredReview += value;
  const summary = studyAvailability(counts, allocation.newRemaining, allocation.reviewRemaining, now);
  return {
    ...summary,
    availableNew: offeredNew,
    availableReview: offeredReview,
    totalAvailable: counts.dueLearning + offeredNew + offeredReview,
    limitedNew: counts.dueNew - offeredNew,
    limitedReview: counts.dueReview - offeredReview,
  };
}

export function allocateStudyScope(
  snapshot: DeckConfigSnapshot,
  spend: ReadonlyMap<string, DeckSpend>,
  countsByDeck: Map<string, StudyCounts>,
  scopeId: string | null,
  now: Date,
  options: { include?: (deckId: string) => boolean; clampNew?: number; clampReview?: number } = {},
): { allocation: BudgetAllocation; summary: StudySummary } {
  const nodes = budgetDecksFromSnapshot(snapshot);
  const scopeIds = scopeId ? [scopeId, ...descendantIdsOf(scopeId, nodes)] : nodes.map((deck) => deck.id);
  const visible = options.include ? scopeIds.filter((id) => options.include!(id)) : scopeIds;
  const allocation = allocateDeckBudgets(
    nodes,
    spend,
    supplyFromCounts(countsByDeck),
    scopeId,
    (id) => visible.includes(id),
    { newCards: options.clampNew, reviews: options.clampReview },
  );
  const counts = sumStudyCounts(visible.flatMap((id) => {
    const row = countsByDeck.get(id);
    return row ? [row] : [];
  }));
  return { allocation, summary: summarizeAllocation(counts, allocation, now) };
}

function descendantIdsOf(deckId: string, decks: { id: string; parentId: string | null }[], seen = new Set<string>()): string[] {
  if (seen.has(deckId)) return [];
  seen.add(deckId);
  return decks.filter((deck) => deck.parentId === deckId).flatMap((deck) => [deck.id, ...descendantIdsOf(deck.id, decks, seen)]);
}

export async function loadStudyOverview(userId: string, now = new Date()): Promise<StudyOverview> {
  const [userDecks, presets, profiles, direct] = await Promise.all([
    db.select().from(decks).where(eq(decks.userId, userId)),
    db.select().from(deckOptionsPreset).where(eq(deckOptionsPreset.userId, userId)),
    db.select().from(profile).where(eq(profile.userId, userId)),
    loadStudyCounts(userId, now),
  ]);
  const snapshot = { userDecks, presetsById: new Map(presets.map((p) => [p.id, p])), profile: profiles[0] ?? null };
  const { read } = await readAccountStudyDay(userId, profiles[0] ?? null, now);
  const spend = await loadDeckSpend(userId, read.startsAt, read.endsAt);
  return {
    overall: allocateStudyScope(snapshot, spend, direct, null, now).summary,
    decks: Object.fromEntries(userDecks.map((deck) => [deck.id, allocateStudyScope(snapshot, spend, direct, deck.id, now).summary])),
    direct: Object.fromEntries(userDecks.map((deck) => [deck.id, direct.get(deck.id) ?? sumStudyCounts([])])),
    studyDay: studyDaySnapshot(read),
  };
}
