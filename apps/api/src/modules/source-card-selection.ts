import { evidenceExcerpt } from '../ai/legacy-evidence';
import { createHash } from 'node:crypto';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { db, sources, sourceChunks } from '@reomi/db';
import { ASSISTANT_CONTEXT_LIMITS, parseSourceTextSelection, type CardEvidenceSnapshot } from '@reomi/shared';
import { cardEvidenceFingerprint } from '../ai/card-evidence';
import { StudyError } from './study-notes';
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function captureManualTextSelection(tx: Tx, userId: string, sourceId: string, input: unknown): Promise<CardEvidenceSnapshot[]> {
  let selection;
  try { selection = parseSourceTextSelection(input); } catch { throw new StudyError(400, 'invalid_text_selection'); }
  const [source] = await tx.select().from(sources)
    .where(and(eq(sources.userId, userId), eq(sources.id, sourceId), ne(sources.status, 'deleting'))).for('share').limit(1);
  if (!source) throw new StudyError(404, 'not_found');
  const origin = { version: 1 as const, sourceId, sourceTitle: evidenceExcerpt(source.title, 200), quote: selection.quote };
  if (!selection.chunks.length) return [{ ...origin, kind: 'user_quote', sourceVersion: source.updatedAt.toISOString() }];
  const chunks = await tx.select().from(sourceChunks)
    .where(and(eq(sourceChunks.userId, userId), eq(sourceChunks.sourceId, sourceId), inArray(sourceChunks.id, selection.chunks.map(chunk => chunk.chunkId))))
    .orderBy(sourceChunks.id).for('share');
  const ordered = selection.chunks.map(segment => chunks.find(chunk => chunk.id === segment.chunkId));
  if (ordered.some((chunk, index) => !chunk || index > 0 && chunk.position <= ordered[index - 1]!.position)) throw new StudyError(400, 'invalid_text_selection');
  if (ordered.some((chunk, index) => createHash('sha256').update(chunk!.text).digest('hex') !== selection.chunks[index]!.textHash)) throw new StudyError(409, 'text_selection_stale');
  return ordered.map(chunk => ({ ...origin, kind: 'user_selection', chunkId: chunk!.id, position: chunk!.position,
    textHash: cardEvidenceFingerprint(chunk!), ...(chunk!.page === null ? {} : { page: chunk!.page }), selection }));
}

export async function captureManualPdfSelection(tx: Tx, userId: string, sourceId: string, input: unknown): Promise<CardEvidenceSnapshot[]> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new StudyError(400, 'invalid_pdf_selection');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => !['version', 'page', 'quote', 'sourceVersion'].includes(key))
    || value.version !== 1 || !Number.isInteger(value.page) || Number(value.page) < 1 || Number(value.page) > 10000
    || typeof value.quote !== 'string' || value.quote.length > ASSISTANT_CONTEXT_LIMITS.excerptChars
    || typeof value.sourceVersion !== 'string' || !Number.isFinite(Date.parse(value.sourceVersion))) throw new StudyError(400, 'invalid_pdf_selection');
  const [source] = await tx.select().from(sources)
    .where(and(eq(sources.userId, userId), eq(sources.id, sourceId), ne(sources.status, 'deleting'))).for('share').limit(1);
  if (!source) throw new StudyError(404, 'not_found');
  if (source.kind !== 'pdf' || !source.pageCount || Number(value.page) > source.pageCount) throw new StudyError(400, 'invalid_pdf_selection');
  if (source.updatedAt.toISOString() !== value.sourceVersion) throw new StudyError(409, 'pdf_selection_stale');
  return [{ version: 1, kind: 'user_quote', sourceId, sourceTitle: evidenceExcerpt(source.title, 200),
    sourceVersion: value.sourceVersion, quote: value.quote, page: Number(value.page) }];
}
