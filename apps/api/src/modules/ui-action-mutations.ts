import { and, asc, eq, sql } from 'drizzle-orm';
import { db, deckHierarchyRevisions, decks, notebookNotes, notebooks, sources, uiActionReceipts } from '@reomi/db';
import { compareDeckOrder, DECK_COLORS, NOTEBOOK_TITLE_MAX, type DeckPlacement, type UiActionInverse, type UiActionTarget } from '@reomi/shared';
import { lockStudyNote, patchStudyNote, StudyError } from './study-notes';
import { actionReceipt, reconcileAction, type ActionMutation, type ActionTx } from './ui-action-receipts';

export function requireRevision(actual: number, expected: number) {
  if (!Number.isSafeInteger(expected) || expected < 0 || actual !== expected) throw new StudyError(409, 'object_changed');
}
const target = (kind: UiActionTarget['kind'], row: { id: string; metadataRevision: number }): UiActionTarget => ({ kind, id: row.id, revision: String(row.metadataRevision) });
function oldFields(row: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(patch).map(key => [key, row[key]]));
}
function inverse(kind: 'source' | 'notebook' | 'deck' | 'study-note', row: Record<string, unknown>, patch: Record<string, unknown>): UiActionInverse | undefined {
  return Object.entries(patch).some(([key, value]) => JSON.stringify(row[key]) !== JSON.stringify(value)) ? { kind, patch: oldFields(row, patch) } : undefined;
}
function keys(patch: object, allowed: string[]) {
  if (!Object.keys(patch).length || Object.keys(patch).some(key => !allowed.includes(key))) throw new StudyError(400, 'invalid_patch');
}

export async function editStudyNoteAction(tx: ActionTx, userId: string, id: string, expected: number,
  patch: { title?: string; content?: string; pinned?: boolean }): Promise<ActionMutation> {
  keys(patch, ['title', 'content', 'pinned']);
  const { row: before, owner } = await lockStudyNote(tx, userId, id);
  requireRevision(before.metadataRevision, expected);
  const row = await patchStudyNote(userId, id, patch, owner, tx);
  return { result: row, target: target('study-note', row), label: row.title,
    inverse: Object.keys(patch).length === 1 && patch.pinned !== undefined ? inverse('study-note', before, patch) : undefined };
}

export async function editSourceAction(tx: ActionTx, userId: string, id: string, expected: number,
  input: { title?: string; author?: string | null; description?: string | null; tags?: string[] }): Promise<ActionMutation> {
  keys(input, ['title', 'author', 'description', 'tags']);
  const [before] = await tx.select().from(sources).where(and(eq(sources.userId, userId), eq(sources.id, id))).for('update').limit(1);
  if (!before || before.status === 'deleting') throw new StudyError(404, 'not_found');
  requireRevision(before.metadataRevision, expected);
  const patch = { ...input };
  if (patch.title !== undefined) { patch.title = patch.title.trim(); if (!patch.title || patch.title.length > 300) throw new StudyError(400, 'invalid_metadata'); }
  if (patch.author !== undefined) { if (patch.author && patch.author.length > 500) throw new StudyError(400, 'invalid_metadata'); patch.author = patch.author || null; }
  if (patch.description !== undefined) { if (patch.description && patch.description.length > 2000) throw new StudyError(400, 'invalid_metadata'); patch.description = patch.description || null; }
  if (patch.tags) {
    if (patch.tags.length > 32 || patch.tags.some(tag => typeof tag !== 'string' || tag.length > 64)) throw new StudyError(400, 'invalid_metadata');
    patch.tags = [...new Set(patch.tags.map(tag => tag.trim()).filter(Boolean))];
  }
  const [row] = await tx.update(sources).set({ ...patch, updatedAt: sql`GREATEST(now(), ${sources.updatedAt} + interval '1 millisecond')` })
    .where(and(eq(sources.userId, userId), eq(sources.id, id))).returning();
  return { result: row, target: target('source', row!), label: row!.title, inverse: inverse('source', before, patch) };
}

export async function editNotebookAction(tx: ActionTx, userId: string, id: string, expected: number, title: string): Promise<ActionMutation> {
  title = title.trim();
  if (!title || title.length > NOTEBOOK_TITLE_MAX) throw new StudyError(400, 'invalid_title');
  const [before] = await tx.select().from(notebooks).where(and(eq(notebooks.userId, userId), eq(notebooks.id, id))).for('update').limit(1);
  if (!before) throw new StudyError(404, 'not_found');
  requireRevision(before.metadataRevision, expected);
  const [row] = await tx.update(notebooks).set({ title, updatedAt: sql`GREATEST(now(), ${notebooks.updatedAt} + interval '1 millisecond')` })
    .where(and(eq(notebooks.userId, userId), eq(notebooks.id, id))).returning();
  return { result: row, target: target('notebook', row!), label: title, inverse: inverse('notebook', before, { title }) };
}

export async function editDeckAction(tx: ActionTx, userId: string, id: string, expected: number,
  input: { name?: string; color?: string; icon?: string | null }): Promise<ActionMutation> {
  keys(input, ['name', 'color', 'icon']);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 73))`);
  const [before] = await tx.select().from(decks).where(and(eq(decks.userId, userId), eq(decks.id, id))).for('update').limit(1);
  if (!before) throw new StudyError(404, 'not_found');
  requireRevision(before.metadataRevision, expected);
  const patch = { ...input };
  if (patch.name !== undefined) { patch.name = patch.name.trim(); if (!patch.name || patch.name.length > 100) throw new StudyError(400, 'invalid_name'); }
  if (patch.color !== undefined && !(DECK_COLORS as readonly string[]).includes(patch.color)) throw new StudyError(400, 'invalid_color');
  if (patch.icon && patch.icon.length > 100) throw new StudyError(400, 'invalid_icon');
  const [row] = await tx.update(decks).set({ ...patch, color: patch.color as typeof decks.$inferSelect.color | undefined }).where(and(eq(decks.userId, userId), eq(decks.id, id))).returning();
  return { result: row, target: target('deck', row!), label: row!.name, inverse: inverse('deck', before, patch) };
}

export async function hierarchyRevision(tx: ActionTx, userId: string) {
  const [row] = await tx.select().from(deckHierarchyRevisions).where(eq(deckHierarchyRevisions.userId, userId));
  return row?.revision ?? 0;
}

/** Shared move transaction, also used by the legacy route. */
export async function moveDeckInTransaction(tx: ActionTx, userId: string, id: string, input: { targetId: string | null; placement: DeckPlacement }, expected?: number): Promise<ActionMutation> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 73))`);
  const all = await tx.select().from(decks).where(eq(decks.userId, userId)).orderBy(asc(decks.id)).for('update');
  if (expected !== undefined) requireRevision(await hierarchyRevision(tx, userId), expected);
  const source = all.find(deck => deck.id === id), destination = input.targetId ? all.find(deck => deck.id === input.targetId) : null;
  if (!source || input.targetId && !destination) throw new StudyError(404, 'not_found');
  if (!destination && input.placement !== 'inside') throw new StudyError(400, 'invalid_placement');
  if (source.id === destination?.id) throw new StudyError(400, 'cycle');
  const parentId = !destination ? null : input.placement === 'inside' ? destination.id : destination.parentId;
  let cursor = parentId;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor === source.id || seen.has(cursor)) throw new StudyError(400, 'cycle');
    seen.add(cursor); cursor = all.find(deck => deck.id === cursor)?.parentId ?? null;
  }
  const siblings = all.filter(deck => deck.id !== source.id && deck.parentId === parentId).sort(compareDeckOrder);
  const position = !destination || input.placement === 'inside' ? siblings.length
    : siblings.findIndex(deck => deck.id === destination.id) + (input.placement === 'after' ? 1 : 0);
  siblings.splice(position, 0, source);
  const changed = siblings.filter((deck, index) => deck.parentId !== parentId || deck.position !== index);
  const before = changed.map(deck => ({ id: deck.id, parentId: deck.parentId, position: deck.position }));
  const order = [...new Set([source.parentId, parentId])].map(parentId => ({ parentId,
    ids: all.filter(row => row.parentId === parentId).sort(compareDeckOrder).map(row => row.id) }));
  for (const [position, deck] of siblings.entries()) {
    if (deck.position === position && deck.parentId === parentId) continue;
    await tx.update(decks).set({ parentId, position }).where(and(eq(decks.userId, userId), eq(decks.id, deck.id)));
  }
  const rows = await tx.select().from(decks).where(eq(decks.userId, userId));
  return { result: rows, target: { kind: 'deck-tree', id, revision: String(await hierarchyRevision(tx, userId)) }, label: source.name,
    inverse: before.length ? { kind: 'deck-tree', rows: before, order } : undefined };
}

export async function undoUiAction(userId: string, receiptId: string) {
  return db.transaction(async tx => {
    const [receipt] = await tx.select().from(uiActionReceipts).where(and(eq(uiActionReceipts.userId, userId), eq(uiActionReceipts.id, receiptId))).for('update').limit(1);
    if (!receipt) throw new StudyError(404, 'receipt_not_found');
    if (receipt.consumedAt) return reconcileAction(tx, userId, receipt, true);
    if (!receipt.inverse || !receipt.undoUntil || receipt.undoUntil.getTime() <= Date.now()) throw new StudyError(409, 'undo_expired');
    const previous = receipt.inverse, expected = Number(receipt.target.revision), id = receipt.target.id;
    let undone: ActionMutation;
    switch (previous.kind) {
      case 'source': undone = await editSourceAction(tx, userId, id, expected, previous.patch); break;
      case 'notebook': undone = await editNotebookAction(tx, userId, id, expected, previous.patch.title as string); break;
      case 'deck': undone = await editDeckAction(tx, userId, id, expected, previous.patch); break;
      case 'study-note': undone = await editStudyNoteAction(tx, userId, id, expected, { pinned: previous.patch.pinned as boolean }); break;
      case 'deck-tree': {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 73))`);
        const all = await tx.select().from(decks).where(eq(decks.userId, userId)).orderBy(asc(decks.id)).for('update');
        requireRevision(await hierarchyRevision(tx, userId), expected);
        if (!all.some(row => row.id === id) || previous.rows.some(row => !all.some(live => live.id === row.id)
          || row.parentId && !all.some(live => live.id === row.parentId))) throw new StudyError(409, 'object_changed');
        // Names break historical position ties. Preserve newer names, but do
        // not claim exact order restoration when a rename changed that order.
        const hypothetical = all.map(row => ({ ...row, ...previous.rows.find(before => before.id === row.id) }));
        if (previous.order.some(group => JSON.stringify(hypothetical.filter(row => row.parentId === group.parentId)
          .sort(compareDeckOrder).map(row => row.id)) !== JSON.stringify(group.ids))) throw new StudyError(409, 'object_changed');
        for (const row of previous.rows) await tx.update(decks).set({ parentId: row.parentId, position: row.position }).where(and(eq(decks.userId, userId), eq(decks.id, row.id)));
        undone = { target: { kind: 'deck-tree', id, revision: String(await hierarchyRevision(tx, userId)) }, label: receipt.label,
          result: await tx.select().from(decks).where(eq(decks.userId, userId)) };
        break;
      }
    }
    const [consumed] = await tx.update(uiActionReceipts).set({ consumedAt: new Date(), undoTarget: undone.target })
      .where(and(eq(uiActionReceipts.userId, userId), eq(uiActionReceipts.id, receipt.id))).returning();
    return { receipt: actionReceipt(consumed!), result: undone.result, outcome: 'undone' as const, replayed: false, serverTime: new Date().toISOString() };
  });
}
