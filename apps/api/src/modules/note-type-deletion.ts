import { status } from 'elysia';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { db, noteTypes, profile, type Db } from '@reomi/db';
import type { NoteTypeDeletionPreview } from '@reomi/shared';
import { regenerationToken } from './card-regeneration';
import { startNoteTypeBudget, noteTypeBudgetFailure } from './note-type-budget';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
class DeletionError extends Error {
  constructor(readonly code: string, readonly status: 404 | 409) { super(code); }
}

// Aggregate in PostgreSQL: all rows contribute, but neither source nor an
// unbounded ID list leaves the database. Row hashes retain microsecond versions.
async function aggregate(tx: Tx, rows: SQL) {
  const [result] = await tx.execute<{ n: number; stamp: string }>(sql`
    select count(*)::int as n,
      coalesce(md5(string_agg(md5(row_to_json(scoped)::text), '' order by scoped.id)), '') as stamp
    from (${rows}) as scoped`);
  return result!;
}

export async function removeNoteType(userId: string, id: string, previewOnly: boolean, token?: string) {
  try {
    return await db.transaction(async tx => {
      const checkBudget = await startNoteTypeBudget(tx);
      // Grade/undo take profile before card/review locks. A preview instead
      // uses one read-only repeatable snapshot and holds no study row locks.
      if (!previewOnly) await tx.select({ id: profile.userId }).from(profile).where(eq(profile.userId, userId)).for('update');
      const query = tx.select().from(noteTypes).where(and(eq(noteTypes.userId, userId), eq(noteTypes.id, id), eq(noteTypes.isBuiltin, false)));
      const [type] = await (previewOnly ? query : query.for('update'));
      if (!type) throw new DeletionError('not_found', 404);
      if (!previewOnly && !token) throw new DeletionError('type_deletion_confirmation_required', 409);
      const noteLock = previewOnly ? sql`` : sql`for update of n`;
      const cardLock = previewOnly ? sql`` : sql`for update of c`;
      const reviewLock = previewOnly ? sql`` : sql`for update of r`;
      const noteScope = sql`select n.* from notes n where n.user_id = ${userId} and n.note_type_id = ${id}::uuid`;
      const cardScope = sql`select c.* from cards c inner join notes n on n.id = c.note_id
        where c.user_id = ${userId} and n.user_id = ${userId} and n.note_type_id = ${id}::uuid`;
      const noteState = await aggregate(tx, sql`${noteScope} order by n.id ${noteLock}`);
      checkBudget();
      const cardState = await aggregate(tx, sql`${cardScope} order by c.id ${cardLock}`);
      checkBudget();
      const reviewState = await aggregate(tx, sql`select r.id, r.reviewed_at, r.rating, r.next_due from reviews r
        inner join cards c on c.id = r.card_id inner join notes n on n.id = c.note_id
        where r.user_id = ${userId} and c.user_id = ${userId} and n.user_id = ${userId} and n.note_type_id = ${id}::uuid
        order by r.id ${reviewLock}`);
      checkBudget();
      const [orphanState] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from notes n
        where n.user_id = ${userId} and n.note_type_id = ${id}::uuid
        and not exists (select 1 from cards c where c.user_id = ${userId} and c.note_id = n.id)`);
      checkBudget();
      const preview: NoteTypeDeletionPreview = {
        noteTypeId: id, name: type.name, sourceVersion: type.updatedAt.toISOString(),
        notes: noteState.n, cards: cardState.n, reviews: reviewState.n, notesWithoutCards: orphanState!.n,
        confirmationToken: regenerationToken({ operation: 'delete_note_type', userId, type, noteState, cardState, reviewState }),
      };
      if (previewOnly) return preview;
      if (token !== preview.confirmationToken) throw new DeletionError('preview_changed', 409);
      await tx.delete(noteTypes).where(and(eq(noteTypes.id, id), eq(noteTypes.userId, userId)));
      checkBudget();
      return { ok: true as const };
    }, { isolationLevel: previewOnly ? 'repeatable read' : 'read committed', accessMode: previewOnly ? 'read only' : 'read write' });
  } catch (error) {
    if (error instanceof DeletionError) return status(error.status, { error: error.code });
    const code = noteTypeBudgetFailure(error);
    if (code) return status(503, { error: code });
    throw error;
  }
}
