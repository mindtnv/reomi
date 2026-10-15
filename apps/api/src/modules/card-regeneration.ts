import { createHash } from 'node:crypto';
import { and, asc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import { cards, type Db } from '@reomi/db';
import { fsrsResetColumns, isLegacyClozeCard, type generateCards } from '@reomi/shared';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type GeneratedCard = ReturnType<typeof generateCards>[number];
export type ExistingCard = typeof cards.$inferSelect & { reviewCount: number };
export interface RegenerationPlan {
  keep: { before: ExistingCard; after: GeneratedCard }[];
  create: GeneratedCard[];
  remove: ExistingCard[];
}

export class NoteWriteConflict extends Error {
  constructor(public readonly code: 'note_changed' | 'note_type_changed' | 'note_deck_required' | 'preview_changed' | 'card_removal_confirmation_required') {
    super(code); this.name = 'NoteWriteConflict';
  }
}

export async function loadRegenerationCards(tx: Tx, userId: string, noteIds: string[]): Promise<ExistingCard[]> {
  if (!noteIds.length) return [];
  return tx.select({ ...getTableColumns(cards),
    // Keep correlation explicitly qualified: Drizzle's single-table projection
    // de-qualifies interpolated columns, which would bind id to the inner row.
    reviewCount: sql<number>`(select count(*)::int from reviews as history where history.card_id = "cards"."id" and history.user_id = ${userId})`.mapWith(Number),
  }).from(cards).where(and(eq(cards.userId, userId), inArray(cards.noteId, noteIds)))
    .orderBy(asc(cards.id)).for('update');
}

export function planRegeneration(existing: ExistingCard[], generated: GeneratedCard[], ordMap?: Map<number, number>, retainHistoryFor?: Record<string, number>): RegenerationPlan {
  const key = (ord: number, cloze: number | null | undefined) => `${ord}:${cloze ?? 'plain'}`;
  const remaining = new Map(generated.map((card) => [key(card.templateOrd, card.clozeNumber), card]));
  const keep: RegenerationPlan['keep'] = [];
  const remove: ExistingCard[] = [];
  for (const before of existing) {
    const ord = ordMap ? ordMap.get(before.templateOrd) : before.templateOrd;
    const number = isLegacyClozeCard(before) ? retainHistoryFor?.[String(before.templateOrd)] ?? 0 : before.clozeNumber;
    const after = ord === undefined ? undefined : remaining.get(key(ord, number));
    if (after) { keep.push({ before, after }); remaining.delete(key(after.templateOrd, after.clozeNumber)); }
    else remove.push(before);
  }
  return { keep, create: [...remaining.values()], remove };
}

export function regenerationImpact(plans: RegenerationPlan[]) {
  const removed = plans.flatMap((plan) => plan.remove);
  return {
    willCreateCards: plans.reduce((n, plan) => n + plan.create.length, 0),
    willKeepCards: plans.reduce((n, plan) => n + plan.keep.length, 0),
    willDeleteCards: removed.length,
    willDeleteReviews: removed.reduce((n, card) => n + card.reviewCount, 0),
    removedCards: removed.slice(0, 50).map((card) => ({ id: card.id, front: card.renderFrontText.slice(0, 160), reviews: card.reviewCount })),
  };
}

/** Consistency token, not authorization: callers still authenticate and scope
 * every read/write. Bind consent to the actual input and current affected rows. */
export function regenerationToken(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest('hex');
}

export async function applyRegeneration(tx: Tx, input: {
  userId: string; noteId: string; deckId?: string; plan: RegenerationPlan; now: Date;
  moveToDeckId?: string;
  checkBudget?: () => void;
}): Promise<string[]> {
  const { plan, now } = input;
  input.checkBudget?.();
  if (plan.create.length && !input.deckId) throw new NoteWriteConflict('note_deck_required');
  // Confirmed removals happen first; changed ordinals temporarily vacate their
  // unique slots. Readers outside this transaction never observe these ords.
  if (plan.remove.length) await tx.delete(cards).where(and(eq(cards.userId, input.userId), inArray(cards.id, plan.remove.map((card) => card.id))));
  for (const { before, after } of plan.keep) {
    input.checkBudget?.();
    if (before.templateOrd !== after.templateOrd) await tx.update(cards).set({ templateOrd: -before.templateOrd - 1 }).where(eq(cards.id, before.id));
  }
  const indexIds: string[] = [];
  for (const { before, after } of plan.keep) {
    input.checkBudget?.();
    await tx.update(cards).set({ ...after,
      ...(input.moveToDeckId ? { deckId: input.moveToDeckId } : {}),
      updatedAt: sql`greatest(${cards.updatedAt} + interval '1 millisecond', ${now.toISOString()}::timestamptz)`,
    }).where(and(eq(cards.id, before.id), eq(cards.userId, input.userId)));
    if (before.renderText !== after.renderText) indexIds.push(before.id);
  }
  for (const generated of plan.create) {
    input.checkBudget?.();
    const [created] = await tx.insert(cards).values({ ...generated, userId: input.userId, noteId: input.noteId,
      deckId: input.deckId!, ...fsrsResetColumns(now),
    }).returning({ id: cards.id });
    indexIds.push(created!.id);
  }
  return indexIds;
}
