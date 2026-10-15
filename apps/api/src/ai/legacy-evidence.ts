import { createHash } from 'node:crypto';
import type { ChunkCardEvidenceSnapshot, QuotedCardEvidenceSnapshot } from '@reomi/shared';

/** UTF-16 budget, without leaving a lone surrogate in PostgreSQL JSONB. */
export function evidenceExcerpt(text: string, limit: number): string {
  let end = Math.min(text.length, limit);
  if (end > 0 && end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!) && /[\uDC00-\uDFFF]/.test(text[end]!)) end--;
  return text.slice(0, end);
}
export const cardEvidenceFingerprint = (row: { text: string; sourceHash: string | null; position: number; page: number | null }) =>
  createHash('sha256').update(JSON.stringify([row.text, row.sourceHash, row.position, row.page])).digest('hex');

export function legacyChunkEvidence(source: { id: string; title: string }, chunk: { id: string; text: string; sourceHash: string | null; position: number; page: number | null }): ChunkCardEvidenceSnapshot {
  return { version: 1, kind: 'chunk', sourceId: source.id, sourceTitle: evidenceExcerpt(source.title, 200),
    chunkId: chunk.id, position: chunk.position, ...(chunk.page === null ? {} : { page: chunk.page }),
    quote: evidenceExcerpt(chunk.text, 320), textHash: cardEvidenceFingerprint(chunk) };
}
export function legacySourceEvidence(source: { id: string; title: string; updatedAt: Date }): QuotedCardEvidenceSnapshot {
  return { version: 1, kind: 'user_quote', sourceId: source.id, sourceTitle: evidenceExcerpt(source.title, 200),
    sourceVersion: source.updatedAt.toISOString(), quote: '' };
}
