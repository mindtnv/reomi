import { Elysia, t } from 'elysia';
import { createHash } from 'node:crypto';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import { db, sources, sourceChunks, sourceTextMarks } from '@reomi/db';
import { parseSourceTextSelection, type SourceTextSelection } from '@reomi/shared';
import { authPlugin } from '../auth-plugin';
import { StudyError } from './study-notes';
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const textHash = (text: string) => createHash('sha256').update(text).digest('hex');
async function owned(tx: Tx, userId: string, sourceId: string) {
  const [source] = await tx.select({ id: sources.id, status: sources.status }).from(sources)
    .where(and(eq(sources.userId, userId), eq(sources.id, sourceId))).for('update').limit(1);
  if (!source || source.status === 'deleting') throw new StudyError(404, 'not_found');
}
async function anchorStatus(tx: Tx, userId: string, sourceId: string, selection: SourceTextSelection, admission = false) {
  if (!selection.chunks.length) return 'quote_only' as const;
  const chunks = await tx.select({ id: sourceChunks.id, text: sourceChunks.text, position: sourceChunks.position }).from(sourceChunks)
    .where(and(eq(sourceChunks.userId, userId), eq(sourceChunks.sourceId, sourceId), inArray(sourceChunks.id, selection.chunks.map(chunk => chunk.chunkId))));
  const ordered = selection.chunks.map(segment => chunks.find(chunk => chunk.id === segment.chunkId));
  if (ordered.some((chunk,index) => !chunk || index > 0 && chunk.position <= ordered[index - 1]!.position)) {
    if (admission) throw new StudyError(400, 'invalid_text_selection');
    return 'unavailable' as const;
  }
  if (ordered.some((chunk,index) => textHash(chunk!.text) !== selection.chunks[index]!.textHash)) {
    if (admission) throw new StudyError(409, 'text_selection_stale');
    return 'unavailable' as const;
  }
  return 'anchored' as const;
}
const params = t.Object({ id: t.String({ format: 'uuid' }) });
const markParams = t.Object({ id: t.String({ format: 'uuid' }), markId: t.String({ format: 'uuid' }) });
const color = t.Union(['yellow','green','blue','pink','violet'].map(value => t.Literal(value)));
export const sourceTextMarksModule = new Elysia().use(authPlugin)
  .get('/sources/:id/text-marks', ({ user, params, query }) => db.transaction(async tx => {
    await owned(tx, user.id, params.id);
    const rows = await tx.select().from(sourceTextMarks).where(and(eq(sourceTextMarks.userId, user.id), eq(sourceTextMarks.sourceId, params.id)))
      .orderBy(asc(sourceTextMarks.createdAt), asc(sourceTextMarks.id)).offset(query.offset ?? 0).limit(51);
    const items = await Promise.all(rows.slice(0,50).map(async row => ({ ...row, anchorStatus: await anchorStatus(tx, user.id, params.id, row.selection) })));
    return { items, nextOffset: rows.length > 50 ? (query.offset ?? 0) + 50 : null };
  }), { auth: true, params, query: t.Object({ offset: t.Optional(t.Numeric({ minimum: 0, maximum: 10000, multipleOf: 1 })) }) })
  .post('/sources/:id/text-marks', ({ user, params, body }) => db.transaction(async tx => {
    await owned(tx, user.id, params.id);
    let selection: SourceTextSelection;
    try { selection = parseSourceTextSelection(body.selection); } catch { throw new StudyError(400, 'invalid_text_selection'); }
    const status = await anchorStatus(tx, user.id, params.id, selection, true);
    const [total] = await tx.select({ n: count() }).from(sourceTextMarks).where(and(eq(sourceTextMarks.userId, user.id), eq(sourceTextMarks.sourceId, params.id)));
    if (total!.n >= 2000) throw new StudyError(409, 'too_many_text_marks');
    const [row] = await tx.insert(sourceTextMarks).values({ userId: user.id, sourceId: params.id, kind: body.kind, color: body.color,
      selection, note: body.note ?? null }).returning();
    return { ...row!, anchorStatus: status };
  }), { auth: true, params, body: t.Object({ kind: t.Union([t.Literal('highlight'),t.Literal('note')]), selection: t.Unknown(), color: t.Optional(color), note: t.Optional(t.String({ maxLength: 2000 })) }) })
  .patch('/sources/:id/text-marks/:markId', ({ user, params, body }) => db.transaction(async tx => {
    await owned(tx, user.id, params.id);
    if (!Object.keys(body).length) throw new StudyError(400, 'nothing_to_update');
    const [row] = await tx.update(sourceTextMarks).set({ ...body, updatedAt: sql`GREATEST(now(), ${sourceTextMarks.updatedAt} + interval '1 millisecond')` })
      .where(and(eq(sourceTextMarks.userId, user.id), eq(sourceTextMarks.sourceId, params.id), eq(sourceTextMarks.id, params.markId))).returning();
    if (!row) throw new StudyError(404, 'not_found');
    return { ...row, anchorStatus: await anchorStatus(tx, user.id, params.id, row.selection) };
  }), { auth: true, params: markParams, body: t.Object({ color: t.Optional(color), note: t.Optional(t.String({ maxLength: 2000 })) }) })
  .delete('/sources/:id/text-marks/:markId', ({ user, params }) => db.transaction(async tx => {
    await owned(tx, user.id, params.id);
    const [row] = await tx.delete(sourceTextMarks).where(and(eq(sourceTextMarks.userId, user.id), eq(sourceTextMarks.sourceId, params.id), eq(sourceTextMarks.id, params.markId))).returning({ id: sourceTextMarks.id });
    if (!row) throw new StudyError(404, 'not_found'); return { ok: true };
  }), { auth: true, params: markParams });
