import { and, count, desc, eq, ilike, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { conversations, db, messages, notebookNotes, notebooks, sources, type Citation } from '@reomi/db';
import { env } from '../env';
import { MAX_NOTES_PER_NOTEBOOK, NOTE_TITLE_MAX, NOTE_CONTENT_MAX, NOTE_CITATIONS_MAX_BYTES, NOTE_EXCERPT_MAX } from '@reomi/shared';

export type StudyOwner = { kind: 'notebook' | 'source'; id: string };
export class StudyError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 503, code: string) { super(code); }
}
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const scope = (owner: StudyOwner) => owner.kind === 'source'
  ? and(eq(notebookNotes.ownerKind, 'source'), eq(notebookNotes.sourceOriginId, owner.id))
  : and(eq(notebookNotes.ownerKind, 'notebook'), eq(notebookNotes.notebookId, owner.id));
async function ownerRow(tx: Tx, userId: string, owner: StudyOwner, lock: 'share' | 'update' = 'update') {
  const table = owner.kind === 'source' ? sources : notebooks;
  const [row] = await tx.select({ id: table.id, title: table.title }).from(table)
    .where(and(eq(table.userId, userId), eq(table.id, owner.id), owner.kind === 'source' ? ne(sources.status, 'deleting') : undefined)).for(lock).limit(1);
  if (!row) throw new StudyError(404, 'not_found');
  return row;
}
async function bump(tx: Tx, userId: string, owner: StudyOwner) {
  if (owner.kind === 'notebook') await tx.update(notebooks).set({ updatedAt: sql`GREATEST(now(), ${notebooks.updatedAt} + interval '1 millisecond')` })
    .where(and(eq(notebooks.userId, userId), eq(notebooks.id, owner.id)));
}
const excerpt = (content: string, notebook: boolean) => { const flat=content.replace(/\s+/g,' ').trim(); return notebook && flat.length>NOTE_EXCERPT_MAX ? `${flat.slice(0,NOTE_EXCERPT_MAX)}…` : flat.slice(0,notebook?NOTE_EXCERPT_MAX:200); };

export async function listStudyNotes(userId: string, owner?: StudyOwner, options: { q?: string; unavailable?: boolean; offset?: number; limit?: number } = {}) {
  return db.transaction(async tx => {
    if (owner) await ownerRow(tx, userId, owner, 'share');
    const limit = Math.max(1,Math.min(owner?.kind === 'notebook' ? env.ai.LIBRARY_PAGE : 50,Math.floor(options.limit ?? 50)));
    const q = options.q?.trim(), like = q ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : undefined;
    const rows = await tx.select().from(notebookNotes).where(and(eq(notebookNotes.userId, userId),
      owner ? scope(owner) : eq(notebookNotes.ownerKind, 'source'),
      options.unavailable ? isNull(notebookNotes.sourceId) : undefined,
      like ? or(ilike(notebookNotes.title, like), ilike(notebookNotes.content, like)) : undefined))
      .orderBy(desc(notebookNotes.pinned), desc(notebookNotes.updatedAt), desc(notebookNotes.id)).offset(options.offset ?? 0).limit(limit + 1);
    return { items: rows.slice(0, limit).map(row => ({ ...row, excerpt: excerpt(row.content,owner?.kind === 'notebook') })), nextOffset: rows.length > limit ? (options.offset ?? 0) + limit : null };
  });
}
export interface StudyNoteInput { title: string; content: string; kind?: string; citations?: unknown; messageId?: string }
export async function createStudyNote(userId: string, owner: StudyOwner, input: StudyNoteInput, transaction?: Tx) {
  const title = input.title.trim(), kind = input.kind ?? 'manual';
  if (!title || title.length > NOTE_TITLE_MAX || input.content.length > NOTE_CONTENT_MAX || !['manual', 'answer'].includes(kind)
    || (input.citations != null && JSON.stringify(input.citations).length > NOTE_CITATIONS_MAX_BYTES)) throw new StudyError(400, 'invalid_note');
  const run = async (tx: Tx) => {
    const parent = await ownerRow(tx, userId, owner);
    if (input.messageId) {
      const [message] = await tx.select().from(messages).where(and(eq(messages.userId, userId), eq(messages.id, input.messageId))).limit(1);
      if (!message || message.role !== 'assistant') throw new StudyError(400, 'invalid_message');
      const [turn] = await tx.select({ context: messages.context }).from(messages).where(and(eq(messages.userId, userId),
        eq(messages.conversationId, message.conversationId), eq(messages.role, 'user'), lte(messages.createdAt, message.createdAt)))
        .orderBy(desc(messages.createdAt), desc(messages.id)).limit(1);
      const context = message.context ?? turn?.context;
      if (owner.kind === 'source' && !context?.sourceIds.includes(owner.id)) throw new StudyError(400, 'invalid_message');
      if (owner.kind === 'notebook') {
        const [conversation] = await tx.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.userId, userId),
          eq(conversations.id, message.conversationId), eq(conversations.notebookId, owner.id))).limit(1);
        if (!conversation && !context?.refs.some(object => object.available && object.ref.kind === 'notebook' && object.ref.id === owner.id)) {
          throw new StudyError(400, 'invalid_message');
        }
      }
    }
    const [total] = await tx.select({ n: count() }).from(notebookNotes).where(and(eq(notebookNotes.userId, userId), scope(owner)));
    if (total!.n >= MAX_NOTES_PER_NOTEBOOK) throw new StudyError(409, 'too_many_notes');
    const [note] = await tx.insert(notebookNotes).values({ userId, ownerKind: owner.kind,
      ...(owner.kind === 'source' ? { sourceId: owner.id, sourceOriginId: owner.id, sourceOriginTitle: parent.title.trim().slice(0, 200) || 'Source' } : { notebookId: owner.id }),
      title, content: input.content, kind, citations: input.citations as Citation[] | undefined, messageId: input.messageId,
    }).returning();
    await bump(tx, userId, owner); return note!;
  };
  return transaction ? run(transaction) : db.transaction(run);
}
export async function getStudyNote(userId: string, id: string, owner?: StudyOwner) {
  return db.transaction(async tx => {
    if (owner) await ownerRow(tx,userId,owner,'share');
    const [row] = await tx.select().from(notebookNotes).where(and(eq(notebookNotes.userId,userId),eq(notebookNotes.id,id),owner?scope(owner):eq(notebookNotes.ownerKind,'source'))).limit(1);
    if(!row)throw new StudyError(404,'not_found');return row;
  });
}
export async function patchStudyNote(userId: string, id: string, patch: { title?: string; content?: string; pinned?: boolean }, owner?: StudyOwner, transaction?: Tx) {
  const run = async (tx: Tx) => {
    if (owner) await ownerRow(tx, userId, owner);
  if (Object.keys(patch).length === 0) throw new StudyError(400, 'nothing_to_update');
  const title = patch.title?.trim();
  if (title !== undefined && (!title || title.length > NOTE_TITLE_MAX) || patch.content !== undefined && patch.content.length > NOTE_CONTENT_MAX) throw new StudyError(400, 'invalid_note');

    const [row] = await tx.update(notebookNotes).set({ ...patch, ...(title !== undefined ? { title } : {}),
      ...(patch.title !== undefined || patch.content !== undefined ? { updatedAt: sql`GREATEST(now(), ${notebookNotes.updatedAt} + interval '1 millisecond')` } : {}),
    }).where(and(eq(notebookNotes.userId, userId), eq(notebookNotes.id, id), owner ? scope(owner) : eq(notebookNotes.ownerKind, 'source'))).returning();
    if (!row) throw new StudyError(404, 'not_found');
    if (owner) await bump(tx, userId, owner); return row;
  };
  return transaction ? run(transaction) : db.transaction(run);
}
export async function deleteStudyNote(userId: string, id: string, owner?: StudyOwner) {
  return db.transaction(async tx => {
    if (owner) await ownerRow(tx, userId, owner);
    const [row] = await tx.delete(notebookNotes).where(and(eq(notebookNotes.userId, userId), eq(notebookNotes.id, id), owner ? scope(owner) : eq(notebookNotes.ownerKind, 'source'))).returning({ id: notebookNotes.id });
    if (!row) throw new StudyError(404, 'not_found');
    if (owner) await bump(tx, userId, owner); return { ok: true };
  });
}

/** Parent-before-note lock order matches deletion and legacy notebook mutations. */
export async function lockStudyNote(tx: Tx, userId: string, id: string) {
  const [found] = await tx.select().from(notebookNotes).where(and(eq(notebookNotes.userId, userId), eq(notebookNotes.id, id))).limit(1);
  if (!found) throw new StudyError(404, 'not_found');
  const owner: StudyOwner | undefined = found.ownerKind === 'notebook' ? { kind: 'notebook', id: found.notebookId! }
    : found.sourceId ? { kind: 'source', id: found.sourceId } : undefined;
  if (owner) await ownerRow(tx, userId, owner);
  const [row] = await tx.select().from(notebookNotes).where(and(eq(notebookNotes.userId, userId), eq(notebookNotes.id, id))).for('update').limit(1);
  if (!row) throw new StudyError(404, 'not_found');
  return { row, owner };
}
