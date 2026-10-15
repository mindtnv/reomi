// Repair disposable search columns without rewriting note source or schedules.
// bun --env-file=../../.env src/ai/rebuild-card-text.ts <userId> [--reindex]
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { cards, closeDb, db, notes, noteTypes } from '@reomi/db';
import { generateCards, isLegacyClozeCard } from '@reomi/shared';
import { defFromRow } from '../modules/note-types';
import { assertEmbeddingDim, indexCards } from './index-queue';
import { rootLogger, safeError } from '../logger';

export async function rebuildCardTextBatch(userId: string, cursor?: string, reindex = false) {
  const rows = await db.select({ card: cards, fields: notes.fieldValues, type: noteTypes })
    .from(cards).innerJoin(notes, eq(notes.id, cards.noteId))
    .innerJoin(noteTypes, eq(noteTypes.id, notes.noteTypeId))
    .where(and(eq(cards.userId, userId), eq(notes.userId, userId), cursor ? gt(cards.id, cursor) : undefined))
    .orderBy(asc(cards.id)).limit(200);
  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    const generated = generateCards(defFromRow(row.type), row.fields, { legacyCloze: isLegacyClozeCard(row.card) })
      .find((card) => card.templateOrd === row.card.templateOrd && card.clozeNumber === (isLegacyClozeCard(row.card) ? 0 : row.card.clozeNumber));
    if (!generated) { skipped += 1; continue; }
    if (generated.renderText === row.card.renderText && generated.renderFrontText === row.card.renderFrontText &&
      generated.renderBackText === row.card.renderBackText && generated.renderKind === row.card.renderKind) continue;
    const changed = await db.update(cards).set({
      renderText: generated.renderText, renderFrontText: generated.renderFrontText,
      renderBackText: generated.renderBackText, renderKind: generated.renderKind,
    }).where(and(eq(cards.id, row.card.id), eq(cards.userId, userId),
      sql`date_trunc('milliseconds', ${cards.updatedAt}) = ${row.card.updatedAt.toISOString()}::timestamptz`))
      .returning({ id: cards.id });
    if (!changed.length) { skipped += 1; continue; }
    updated += 1;
  }
  // Await the actual batch before the CLI closes its DB connection. Include
  // unchanged text so retry also repairs a previously failed embedding batch.
  if (reindex) await indexCards(rows.map((row) => row.card.id));
  return { scanned: rows.length, updated, skipped, nextCursor: rows.length === 200 ? rows.at(-1)!.card.id : null };
}

if (import.meta.main) {
  const userId = process.argv[2];
  const run = async () => {
    if (!userId || userId.startsWith('--')) throw new Error('A userId is required');
    if (process.argv.includes('--reindex')) await assertEmbeddingDim();
    let cursor: string | undefined;
    do {
      const result = await rebuildCardTextBatch(userId, cursor, process.argv.includes('--reindex'));
      // Counts only, no IDs or content.
      rootLogger.info({ scanned: result.scanned, updated: result.updated, skipped: result.skipped }, 'cards.text_rebuild');
      cursor = result.nextCursor ?? undefined;
    } while (cursor);
  };
  void run().catch((error) => { rootLogger.error({ err: safeError(error) }, 'cards.text_rebuild.failed'); process.exitCode = 1; })
    .finally(() => closeDb());
}
