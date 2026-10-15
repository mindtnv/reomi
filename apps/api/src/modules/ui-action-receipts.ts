import { createHash } from 'node:crypto';
import { and, eq, gt, lt, isNull, sql } from 'drizzle-orm';
import { db, cards, deckHierarchyRevisions, decks, notebookNotes, notebooks, notes, noteTypes, sources, uiActionReceipts } from '@reomi/db';
import type { UiActionEnvelope, UiActionInverse, UiActionKind, UiActionOffers, UiActionReceipt, UiActionResult, UiActionTarget } from '@reomi/shared';
import { StudyError } from './study-notes';

export type ActionTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type StoredReceipt = typeof uiActionReceipts.$inferSelect;
export const ACTION_RECEIPT_MS = 7 * 86400_000;
export const ACTION_UNDO_MS = 10 * 60_000;

/** Existing domain handlers can carry structured validation/budget feedback. */
export class ActionDomainError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 413 | 503, readonly payload: unknown) { super('action_rejected'); }
}

export function actionHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)).digest('hex');
}
export function actionReceipt(row: StoredReceipt): UiActionReceipt {
  return { id: row.id, requestId: row.requestId, kind: row.kind, target: row.target, label: row.label,
    createdAt: row.createdAt.toISOString(), undoUntil: row.undoUntil?.toISOString() ?? null, consumedAt: row.consumedAt?.toISOString() ?? null };
}
export async function readActionTarget(tx: ActionTx, userId: string, target: UiActionTarget): Promise<{ row: unknown; revision: string } | null> {
  if (target.kind === 'card-note') {
    const [row] = await tx.select({ note: notes, typeVersion: noteTypes.updatedAt }).from(notes)
      .innerJoin(noteTypes, eq(noteTypes.id, notes.noteTypeId)).where(and(eq(notes.userId, userId), eq(notes.id, target.id))).limit(1);
    if (!row) return null;
    const generated = await tx.select().from(cards).where(and(eq(cards.userId, userId), eq(cards.noteId, target.id)));
    return { row: { note: row.note, cards: generated }, revision: `${row.note.updatedAt.toISOString()}_${row.typeVersion.toISOString()}` };
  }
  if (target.kind === 'deck-tree') {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 73))`);
    const [version] = await tx.select().from(deckHierarchyRevisions).where(eq(deckHierarchyRevisions.userId, userId));
    const rows = await tx.select().from(decks).where(eq(decks.userId, userId));
    if (!rows.some(row => row.id === target.id)) return null;
    return { row: rows, revision: String(version?.revision ?? 0) };
  }
  // A fixed allow-list; no request-provided table, field or SQL identifier.
  const table = target.kind === 'study-note' ? notebookNotes : target.kind === 'source' ? sources
    : target.kind === 'notebook' ? notebooks : target.kind === 'deck' ? decks : noteTypes;
  const [row] = await tx.select().from(table).where(and(eq(table.userId, userId), eq(table.id, target.id))).limit(1);
  if (!row) return null;
  return { row, revision: 'metadataRevision' in row ? String(row.metadataRevision) : row.updatedAt.toISOString() };
}
export async function reconcileAction(tx: ActionTx, userId: string, stored: StoredReceipt, replayed: boolean): Promise<UiActionResult> {
  const target = stored.undoTarget ?? stored.target;
  const current = await readActionTarget(tx, userId, target);
  return { receipt: actionReceipt(stored), result: current?.row ?? null, replayed, serverTime: new Date().toISOString(),
    outcome: !current ? 'unavailable' : current.revision !== target.revision ? 'changed' : stored.consumedAt ? 'undone' : 'applied' };
}

export interface ActionMutation {
  target: UiActionTarget;
  label: string;
  result: unknown;
  inverse?: UiActionInverse;
}

/** Transactional receipt wrapper. Replays are handled before preview tokens are consumed again. */
export async function performUiAction(userId: string, identity: UiActionEnvelope, kind: UiActionKind, args: unknown,
  mutate: (tx: ActionTx) => Promise<ActionMutation>,
): Promise<UiActionResult> {
  const hash = actionHash({ kind, args });
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${identity.requestId}`}, 942))`);
    const [existing] = await tx.select().from(uiActionReceipts).where(and(eq(uiActionReceipts.userId, userId), eq(uiActionReceipts.requestId, identity.requestId))).limit(1);
    if (existing) {
      if (existing.requestHash !== hash) throw new StudyError(409, 'request_changed');
      return reconcileAction(tx, userId, existing, true);
    }
    // Expired creates cannot be replayed after receipt cleanup. UUIDv7 encodes
    // request time; retries preserve this identity instead of minting a fresh one.
    const timestamp = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(identity.requestId)
      ? Number.parseInt(identity.requestId.slice(0, 8) + identity.requestId.slice(9, 13), 16) : NaN;
    const now = new Date();
    if (!Number.isFinite(timestamp) || timestamp < now.getTime() - ACTION_RECEIPT_MS || timestamp > now.getTime() + 300_000) throw new StudyError(409, 'request_expired');
    const mutation = await mutate(tx);
    const [stored] = await tx.insert(uiActionReceipts).values({ userId, requestId: identity.requestId, sessionId: identity.sessionId,
      requestHash: hash, kind, target: mutation.target, label: mutation.label.slice(0, 200).replace(/[\uD800-\uDBFF]$/, ''),
      inverse: mutation.inverse ?? null, expiresAt: new Date(now.getTime() + ACTION_RECEIPT_MS),
      undoUntil: mutation.inverse ? new Date(now.getTime() + ACTION_UNDO_MS) : null }).returning();
    return { receipt: actionReceipt(stored!), result: mutation.result, outcome: 'applied', replayed: false, serverTime: now.toISOString() };
  });
}

export async function getUiAction(userId: string, requestId: string) {
  return db.transaction(async tx => {
    const [row] = await tx.select().from(uiActionReceipts).where(and(eq(uiActionReceipts.userId, userId), eq(uiActionReceipts.requestId, requestId))).limit(1);
    if (!row) throw new StudyError(404, 'receipt_not_found');
    return reconcileAction(tx, userId, row, true);
  });
}
export async function listUiActions(userId: string, sessionId: string, cursor?: string): Promise<UiActionOffers> {
  // Match the session-order index; id is NOT NULL, so cursor ordering is unchanged.
  const rows = await db.select().from(uiActionReceipts).where(and(eq(uiActionReceipts.userId, userId), eq(uiActionReceipts.sessionId, sessionId),
    gt(uiActionReceipts.undoUntil, new Date()), isNull(uiActionReceipts.consumedAt), cursor ? lt(uiActionReceipts.id, cursor) : undefined))
    .orderBy(sql`${uiActionReceipts.id} DESC NULLS LAST`).limit(21);
  return { items: rows.slice(0, 20).map(actionReceipt), nextCursor: rows.length > 20 ? rows[19]!.id : null, serverTime: new Date().toISOString() };
}
export async function cleanupUiActionReceipts() {
  await db.execute(sql`DELETE FROM ui_action_receipts WHERE id IN
    (SELECT id FROM ui_action_receipts WHERE expires_at < now() ORDER BY expires_at LIMIT 500)`);
}
