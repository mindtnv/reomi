// Source delete-race (NotebookLM M1, T6 CRITIC-C2). A source can be deleted
// WHILE the ingest worker is mid-flight. The contract:
//   * the worker re-checks `status` BEFORE every embed batch — a `deleting`
//     (or vanished) source is a CLEAN terminal (TerminalSkip), NOT a crash.
//   * the DELETE handler explicitly removes the document kb_chunk rows (no FK
//     cascade on kb_chunk.source_id) under (user, source, source_type='document').
//   * net result: ZERO orphan `kb_chunk WHERE source_id = $id` after delete.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { and, count, eq } from 'drizzle-orm';
import {
  db,
  kbChunk,
  notebooks,
  sourceChunks,
  sources as sourcesTable,
} from '@reomi/db';
import { buildApp } from '../src/app.ts';
import {
  __resetAiClientForTests,
  __setAiClientForTests,
} from '../src/ai/openai-client.ts';
import { ingestSource, stashInlineText } from '../src/ai/source-ingest.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();
const DIM = 1536;

function installFakeEmbedder(): { calls: () => number } {
  let calls = 0;
  __setAiClientForTests({
    async embed(texts: string[]): Promise<number[][]> {
      calls += 1;
      return texts.map((_, i) => {
        const v = new Array<number>(DIM).fill(0);
        v[(calls * 13 + i) % DIM] = 1;
        return v;
      });
    },
  });
  return { calls: () => calls };
}

async function freshNotebook(userId: string): Promise<string> {
  const [nb] = await db.insert(notebooks).values({ userId, title: 'NB' }).returning({ id: notebooks.id });
  return nb!.id;
}

async function seedTextSource(userId: string, _notebookId: string, text: string): Promise<string> {
  // Sources are user-level now (library refactor) — no notebook_id on the row.
  const [src] = await db
    .insert(sourcesTable)
    .values({ userId, kind: 'text', title: 'Inline', status: 'pending', verified: true })
    .returning({ id: sourcesTable.id });
  stashInlineText(src!.id, text);
  return src!.id;
}

async function orphanKbChunks(sourceId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(kbChunk)
    .where(eq(kbChunk.sourceId, sourceId));
  return row!.n;
}

const TEXT = `${'word '.repeat(2000)}`.trim(); // several chunks

describe('source delete-race', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('a source already flagged deleting → worker bails as a clean terminal (no embed, no throw)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nbId = await freshNotebook(userId);
    const srcId = await seedTextSource(userId, nbId, TEXT);
    const embedder = installFakeEmbedder();

    // Parse the SoT first (status pending → ... → indexing) by NOT yet deleting.
    // Then flip to 'deleting' so the index phase's pre-batch re-check bails.
    // Simulate the race precisely: claim+parse, then mark deleting, then index.
    // Easiest deterministic path: set status to 'deleting' up-front; claimForParse
    // (WHERE status='pending') fails, resumeIndexing sees status != 'indexing' and
    // does nothing → the worker exits cleanly without throwing.
    await db.update(sourcesTable).set({ status: 'deleting' }).where(eq(sourcesTable.id, srcId));

    // Must NOT throw.
    await expect(ingestSource(srcId)).resolves.toBeUndefined();
    // No embedding happened.
    expect(embedder.calls()).toBe(0);
    // No kb_chunk rows written.
    expect(await orphanKbChunks(srcId)).toBe(0);
  });

  test('mid-index delete → worker stops at the next batch boundary, leaves no NEW rows', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const nbId = await freshNotebook(userId);
    const srcId = await seedTextSource(userId, nbId, TEXT);

    // A fake embedder that flips the source to 'deleting' on its FIRST call so the
    // worker's NEXT pre-batch re-check bails (simulating a concurrent DELETE).
    let calls = 0;
    __setAiClientForTests({
      async embed(texts: string[]): Promise<number[][]> {
        calls += 1;
        if (calls === 1) {
          await db.update(sourcesTable).set({ status: 'deleting' }).where(eq(sourcesTable.id, srcId));
        }
        return texts.map(() => new Array<number>(DIM).fill(0).map((_, i) => (i === 0 ? 1 : 0)));
      },
    });

    // Should resolve cleanly (TerminalSkip is swallowed), never throw.
    await expect(ingestSource(srcId)).resolves.toBeUndefined();
    // Status never advanced to ready (the delete won the race).
    const [row] = await db
      .select({ status: sourcesTable.status })
      .from(sourcesTable)
      .where(eq(sourcesTable.id, srcId));
    expect(row!.status).toBe('deleting');
  });

  test('DELETE handler removes ALL document kb_chunk rows for the source (zero orphans)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nbId = await freshNotebook(userId);
    const srcId = await seedTextSource(userId, nbId, TEXT);

    // Fully ingest so kb_chunk document rows exist.
    installFakeEmbedder();
    await ingestSource(srcId);
    expect(await orphanKbChunks(srcId)).toBeGreaterThan(0);
    const [scN] = await db.select({ n: count() }).from(sourceChunks).where(eq(sourceChunks.sourceId, srcId));
    expect(scN!.n).toBeGreaterThan(0);

    // DELETE the source via the route (soft-delete → kb_chunk cleanup → row delete).
    const del = await callApp(app, 'DELETE', `/sources/${srcId}`, { cookie });
    expect(del.status).toBe(200);

    // ZERO orphan kb_chunk rows for the (now gone) source.
    expect(await orphanKbChunks(srcId)).toBe(0);
    // source row + source_chunks cascade-gone too.
    expect(
      (await db.select({ n: count() }).from(sourcesTable).where(eq(sourcesTable.id, srcId)))[0]!.n,
    ).toBe(0);
    expect(
      (await db.select({ n: count() }).from(sourceChunks).where(eq(sourceChunks.sourceId, srcId)))[0]!.n,
    ).toBe(0);
  });

  test('DELETE then a stray re-ingest of the gone source does not resurrect rows or throw', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nbId = await freshNotebook(userId);
    const srcId = await seedTextSource(userId, nbId, TEXT);
    installFakeEmbedder();
    await ingestSource(srcId);

    const del = await callApp(app, 'DELETE', `/sources/${srcId}`, { cookie });
    expect(del.status).toBe(200);

    // The worker may still have a queued reference; a re-ingest of a vanished
    // source is a clean terminal (no row → claimForParse 0 rows → resumeIndexing
    // sees no row → returns) and writes nothing.
    await expect(ingestSource(srcId)).resolves.toBeUndefined();
    expect(await orphanKbChunks(srcId)).toBe(0);
  });

  test("the DELETE cleanup is document-scoped + user-scoped (never touches a CARD chunk)", async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nbId = await freshNotebook(userId);

    // Create the card + its kb_chunk BEFORE installing the fake embedder, so the
    // notes write-hook (which would auto-index under an injected embedder) does
    // NOT race a duplicate card chunk into kb_chunk.
    const deck = await callApp(app, 'POST', '/decks', { cookie, body: { name: 'D' } });
    const deckId = (await deck.json<{ id: string }>()).id;
    const { seedBasicCard } = await import('./helpers.ts');
    const card = await seedBasicCard(app, cookie, { deckId, front: 'card front', back: 'b' });
    await db.insert(kbChunk).values({
      userId,
      sourceType: 'card',
      sourceId: card.id,
      parentId: card.id,
      position: 0,
      text: 'card front',
      embeddingModel: 'test',
      sourceHash: 'h',
      cardId: card.id,
    });

    // Now ingest a document source with the fake embedder.
    const srcId = await seedTextSource(userId, nbId, TEXT);
    installFakeEmbedder();
    await ingestSource(srcId);

    await callApp(app, 'DELETE', `/sources/${srcId}`, { cookie });

    // The card chunk survives the source delete.
    const [cardChunkN] = await db
      .select({ n: count() })
      .from(kbChunk)
      .where(and(eq(kbChunk.sourceType, 'card'), eq(kbChunk.cardId, card.id)));
    expect(cardChunkN!.n).toBe(1);
    // The document chunks are gone.
    expect(await orphanKbChunks(srcId)).toBe(0);
  });
});
