import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';
import { db, sources, sourceChunks, sourceTextMarks } from '@reomi/db';

const PAGE_SIZE = 4;
const cap = (text: string, limit: number) => {
  const normalized = text.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized;
};

/** Reader selections use offsets in rendered text. A matching raw chunk hash
 * proves the location still exists, not that an arbitrary saved quote is source
 * evidence. Return markup as user data and direct the agent to read_source. */
export async function readTextMarkedPassages(userId: string, sourceIds: string[], offset: number) {
  if (!sourceIds.length) return '';
  const rows = await db.select({ mark: sourceTextMarks, title: sources.title })
    .from(sourceTextMarks).innerJoin(sources, and(eq(sources.id, sourceTextMarks.sourceId), eq(sources.userId, userId), ne(sources.status, 'deleting')))
    .where(and(eq(sourceTextMarks.userId, userId), inArray(sourceTextMarks.sourceId, sourceIds)))
    .orderBy(asc(sourceTextMarks.createdAt), asc(sourceTextMarks.id)).offset(offset).limit(PAGE_SIZE + 1);
  if (!rows.length) return '';
  const page = rows.slice(0, PAGE_SIZE);
  const ids = [...new Set(page.flatMap(({ mark }) => mark.selection.chunks.map(chunk => chunk.chunkId)))];
  const chunks = ids.length ? await db.select({ id: sourceChunks.id, sourceId: sourceChunks.sourceId, position: sourceChunks.position, text: sourceChunks.text })
    .from(sourceChunks).where(and(eq(sourceChunks.userId, userId), inArray(sourceChunks.sourceId, sourceIds), inArray(sourceChunks.id, ids))) : [];
  const lines = page.map(({ mark, title }) => {
    const selected = mark.selection.chunks.map(segment => chunks.find(chunk => chunk.id === segment.chunkId && chunk.sourceId === mark.sourceId));
    const live = selected.length > 0 && selected.every((chunk, index) => chunk
      && createHash('sha256').update(chunk.text).digest('hex') === mark.selection.chunks[index]!.textHash
      && (index === 0 || chunk.position > selected[index - 1]!.position));
    const location = live ? `read_source sourceId=${mark.sourceId} position=${selected[0]!.position}`
      : mark.selection.chunks.length ? 'original location unavailable' : 'quote-only; no verified location';
    return JSON.stringify({ markId: mark.id, sourceId: mark.sourceId, title: cap(title, 100), kind: mark.kind,
      quote: cap(mark.selection.quote, 300), ...(mark.note ? { note: cap(mark.note, 160) } : {}), location });
  });
  // Keep the continuation visible even when JSON escaping expands the quotes.
  const visible: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (visible.length && used + line.length + 1 > 3000) break;
    visible.push(line); used += line.length + 1;
  }
  return ['Text-reader markup (user-supplied quotes and notes, not verified source citations). Read the source before citing it or selecting card evidence.',
    ...visible, rows.length > visible.length ? `More text markup: call list_marked_passages with textOffset=${offset + visible.length} and the same sourceId filter.` : 'End of text markup.',
  ].join('\n');
}
