// One-time historical backfill / ops script. Indexes every card (or per-user)
// via the same `indexCards` batch worker used by the write-hook / reconcile, so
// behavior (sourceHash skip, batched embed, idempotent upsert) is identical.
//
// Run from the api workspace root:
//   bun --env-file=../../.env src/ai/backfill.ts            # all cards
//   bun --env-file=../../.env src/ai/backfill.ts <userId>   # one user
//
// Degrades to a no-op when embeddings are unconfigured (no OPENAI_API_KEY).

import { closeDb, cards, db } from '@reomi/db';
import { eq } from 'drizzle-orm';
import { rootLogger } from '../logger.ts';
import { isEmbeddingEnabled } from './openai-client.ts';
import { assertEmbeddingDim, EMBED_BATCH, embeddingDegraded, indexCards } from './index-queue.ts';

async function main(): Promise<void> {
  if (!isEmbeddingEnabled()) {
    rootLogger.warn('ai.backfill — embeddings not configured; nothing to do');
    return;
  }
  await assertEmbeddingDim();
  if (embeddingDegraded()) {
    rootLogger.error('ai.backfill — embedding column dim mismatch; aborting');
    return;
  }

  const userId = process.argv[2];
  const rows = await db
    .select({ id: cards.id })
    .from(cards)
    .where(userId ? eq(cards.userId, userId) : undefined);
  const ids = rows.map((r) => r.id);

  rootLogger.info({ count: ids.length, userId: userId ?? 'all' }, 'ai.backfill.start');
  for (let i = 0; i < ids.length; i += EMBED_BATCH) {
    await indexCards(ids.slice(i, i + EMBED_BATCH));
    rootLogger.info({ done: Math.min(i + EMBED_BATCH, ids.length), total: ids.length }, 'ai.backfill.progress');
  }
  rootLogger.info({ count: ids.length }, 'ai.backfill.done');
}

main()
  .catch((err) => {
    rootLogger.error({ err }, 'ai.backfill.failed');
    process.exitCode = 1;
  })
  .finally(() => closeDb());
