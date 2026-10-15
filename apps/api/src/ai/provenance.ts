// Auto-provenance writer (NotebookLM M3). After a notebook-mode `create_card`
// is applied, the created cards are LINKED to the source passages the turn was
// grounded on — one `card_sources` edge per (card × distinct source chunk).
//
// The grounding chunk ids come from the turn's `messages.grounding` snapshot
// (stamped on the pending assistant tool_calls row at suspend time — see ai.ts).
// They are source_chunk ids; we resolve each (user-scoped) to its source so the
// edge carries the full provenance chain. The `notebookId` is the CONVERSATION's
// notebook (passed by the caller — sources are user-level now and no longer
// carry a notebook), i.e. "the notebook in which the card was born". We cap the
// DISTINCT chunks per card at `CARD_SOURCE_LINK_CAP` (preserving accumulation
// order — the first-read passages are the most relevant). `onConflictDoNothing`
// makes a double-apply idempotent (the partial unique `card_sources_card_chunk_uq`
// on live edges is the storage backstop). Foreign/missing chunk ids are silently
// dropped (the source may have been deleted between read and apply).

import { legacyChunkEvidence } from './legacy-evidence';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { cardSources, sourceChunks, sources, type Db } from '@reomi/db';
import { env } from '../env.ts';

/** A Drizzle transaction handle (the arg passed to `db.transaction`). */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const CARD_SOURCE_LINK_CAP = env.ai.CARD_SOURCE_LINK_CAP;

/**
 * Write provenance edges linking each created card to the (capped, distinct)
 * source chunks the turn read. Runs inside the CALLER's transaction (the resume
 * apply tx) so the edges commit atomically with the card creation + role:tool
 * insert. No-op when there are no chunk ids or no card ids.
 *
 * @returns the number of edge rows inserted (best-effort — onConflictDoNothing).
 */
export async function writeCardProvenance(
  tx: Tx,
  args: {
    userId: string;
    cardIds: string[];
    chunkIds: string[];
    notebookId: string | null;
    conversationId: string;
    messageId: string | null;
  },
): Promise<number> {
  const { userId, cardIds, chunkIds, notebookId, conversationId, messageId } = args;
  if (cardIds.length === 0 || chunkIds.length === 0) return 0;

  // Distinct, accumulation-order-preserving, capped.
  const distinct: string[] = [];
  for (const id of chunkIds) {
    if (distinct.length >= CARD_SOURCE_LINK_CAP) break;
    if (!distinct.includes(id)) distinct.push(id);
  }

  // Resolve the chunks to their source (user-scoped — the sole cross-tenant
  // boundary). Foreign/missing ids drop out of this select. The notebook comes
  // from the caller (the conversation's notebook), not the chunk.
  const rows = await tx
    .select({
      id: sourceChunks.id,
      sourceId: sourceChunks.sourceId,
      sourceTitle: sources.title, text: sourceChunks.text, sourceHash: sourceChunks.sourceHash,
      position: sourceChunks.position, page: sourceChunks.page, startSeconds: sourceChunks.startSeconds,
    })
    .from(sourceChunks)
    .innerJoin(sources, and(eq(sources.id, sourceChunks.sourceId), eq(sources.userId, userId)))
    .where(and(eq(sourceChunks.userId, userId), inArray(sourceChunks.id, distinct)));
  if (rows.length === 0) return 0;
  // Preserve the accumulation order of `distinct` (the select returns arbitrary
  // order); a deleted chunk simply has no row.
  const byId = new Map(rows.map((r) => [r.id, r]));

  const values: (typeof cardSources.$inferInsert)[] = [];
  for (const cardId of cardIds) {
    for (const chunkId of distinct) {
      const chunk = byId.get(chunkId);
      if (!chunk) continue;
      values.push({
        userId,
        cardId,
        sourceChunkId: chunk.id,
        sourceId: chunk.sourceId,
        sourceSnapshot: legacyChunkEvidence({ id: chunk.sourceId, title: chunk.sourceTitle }, chunk),
        notebookId,
        conversationId,
        messageId,
      });
    }
  }
  if (values.length === 0) return 0;

  // Idempotent: a re-apply (or a card already linked to this chunk) hits the
  // partial unique `card_sources_card_chunk_uq` and is skipped. The index is
  // PARTIAL (`WHERE source_chunk_id IS NOT NULL`), so the ON CONFLICT arbiter
  // MUST carry the same predicate or Postgres rejects it ("no unique or
  // exclusion constraint matching the ON CONFLICT specification"). Every row
  // we insert here carries a non-null source_chunk_id, so the predicate holds.
  // The conflict arbiter MUST carry the partial index's predicate or Postgres
  // rejects it ("no unique or exclusion constraint matching the ON CONFLICT
  // specification"). For `onConflictDoNothing` the partial-index predicate is
  // passed via `where` (NOT `targetWhere`, which only `onConflictDoUpdate`
  // honors) — matching `card_sources_card_chunk_uq` (cols + WHERE) exactly.
  await tx
    .insert(cardSources)
    .values(values)
    .onConflictDoNothing({
      target: [cardSources.cardId, cardSources.sourceChunkId],
      where: sql`source_chunk_id IS NOT NULL`,
    });
  return values.length;
}
