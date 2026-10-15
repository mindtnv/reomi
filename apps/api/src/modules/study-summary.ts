import { cards, db, decks, deckOptionsPreset, profile } from '@reomi/db';
import { eq, sql } from 'drizzle-orm';
import { todayISO, type StudyCounts, type StudySummary, type StudyOverview } from '@reomi/shared';
import { resolveDeckConfig } from './deck-config';

/** One aggregate per deck; never fetches card contents or embeds vectors. */
export async function loadStudyCounts(userId: string, now: Date): Promise<Map<string, StudyCounts>> {
  const nowIso = now.toISOString();
  const active = sql`${cards.suspended} = false`;
  const learning = sql`${cards.state} in ('learning', 'relearning')`;
  const rows = await db.select({
    deckId: cards.deckId,
    total: sql<number>`count(*)`.mapWith(Number),
    newCount: sql<number>`count(*) filter (where ${active} and ${cards.state} = 'new')`.mapWith(Number),
    learningCount: sql<number>`count(*) filter (where ${active} and ${learning})`.mapWith(Number),
    reviewCount: sql<number>`count(*) filter (where ${active} and ${cards.state} = 'review')`.mapWith(Number),
    suspendedCount: sql<number>`count(*) filter (where ${cards.suspended})`.mapWith(Number),
    dueNew: sql<number>`count(*) filter (where ${active} and ${cards.state} = 'new' and ${cards.due} <= ${nowIso})`.mapWith(Number),
    dueLearning: sql<number>`count(*) filter (where ${active} and ${learning} and ${cards.due} <= ${nowIso})`.mapWith(Number),
    dueReview: sql<number>`count(*) filter (where ${active} and ${cards.state} = 'review' and ${cards.due} <= ${nowIso})`.mapWith(Number),
    nextLearningAt: sql<string | null>`min(${cards.due}) filter (where ${active} and ${learning} and ${cards.due} > ${nowIso})`,
    nextDueAt: sql<string | null>`min(${cards.due}) filter (where ${active} and ${cards.due} > ${nowIso})`,
  }).from(cards).where(eq(cards.userId, userId)).groupBy(cards.deckId);
  return new Map(rows.map(({ deckId, ...counts }) => [deckId, {
    ...counts,
    nextLearningAt: counts.nextLearningAt ? new Date(counts.nextLearningAt).toISOString() : null,
    nextDueAt: counts.nextDueAt ? new Date(counts.nextDueAt).toISOString() : null,
  }]));
}

export function sumStudyCounts(rows: Iterable<StudyCounts>): StudyCounts {
  const total: StudyCounts = {
    total: 0, newCount: 0, learningCount: 0, reviewCount: 0, suspendedCount: 0,
    dueNew: 0, dueLearning: 0, dueReview: 0, nextLearningAt: null, nextDueAt: null,
  };
  for (const row of rows) {
    for (const key of ['total', 'newCount', 'learningCount', 'reviewCount', 'suspendedCount', 'dueNew', 'dueLearning', 'dueReview'] as const) {
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

export async function loadStudyOverview(userId: string, now = new Date()): Promise<StudyOverview> {
  const [userDecks, presets, profiles, direct] = await Promise.all([
    db.select().from(decks).where(eq(decks.userId, userId)),
    db.select().from(deckOptionsPreset).where(eq(deckOptionsPreset.userId, userId)),
    db.select().from(profile).where(eq(profile.userId, userId)),
    loadStudyCounts(userId, now),
  ]);
  const snapshot = { userDecks, presetsById: new Map(presets.map((p) => [p.id, p])), profile: profiles[0] ?? null };
  const today = todayISO(now);
  const usedNew = snapshot.profile?.dailyCountsDate === today ? snapshot.profile.newIntroducedToday : 0;
  const usedReviews = snapshot.profile?.dailyCountsDate === today ? snapshot.profile.reviewsDoneToday : 0;
  const availability = (counts: StudyCounts, deckId: string | null) => {
    const config = resolveDeckConfig(deckId, snapshot);
    return studyAvailability(counts, Math.max(0, config.newPerDay - usedNew), Math.max(0, config.reviewsPerDay - usedReviews), now);
  };
  const byId = new Map(userDecks.map((deck) => [deck.id, deck]));
  const aggregated = new Map(userDecks.map((deck) => [deck.id, sumStudyCounts([])]));
  for (const [deckId, counts] of direct) {
    let id: string | null = deckId;
    const seen = new Set<string>();
    while (id && byId.has(id) && !seen.has(id)) {
      seen.add(id);
      aggregated.set(id, sumStudyCounts([aggregated.get(id)!, counts]));
      id = byId.get(id)!.parentId;
    }
  }
  return {
    overall: availability(sumStudyCounts(direct.values()), null),
    decks: Object.fromEntries([...aggregated].map(([id, counts]) => [id, availability(counts, id)])),
    direct: Object.fromEntries(userDecks.map((deck) => [deck.id, direct.get(deck.id) ?? sumStudyCounts([])])),
  };
}
