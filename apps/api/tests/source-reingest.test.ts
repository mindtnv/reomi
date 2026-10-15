// Reingest a library item (L4 §4.1) — re-run ingest through the existing CAS
// state machine. POST /library/items/:id/reingest:
//   * 409 `not_terminal` when the source is mid-flight (pending/parsing/indexing)
//     — incl. a SECOND reingest racing the first (CAS guard updates 0 rows).
//   * 400 `not_reingestable` for `text` (no external carrier — the raw text only
//     lives in the wiped source_chunks).
//   * 404 for a foreign/missing id.
//   * happy path: ready → reingest wipes chunks + document kb_chunk vectors, the
//     worker re-parses + re-embeds back to ready (driven via the url page-reader
//     seam + a fake embedder — no S3, no network).
//
// Drives the worker SYNCHRONOUSLY via `ingestSource(sourceId)` (the same kick the
// route's `enqueueSource` performs) so the test is deterministic.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { and, count, eq } from 'drizzle-orm';
import {
  db,
  kbChunk,
  sourceChunks,
  sources as sourcesTable,
} from '@reomi/db';
import { buildApp } from '../src/app.ts';
import {
  __resetAiClientForTests,
  __setAiClientForTests,
} from '../src/ai/openai-client.ts';
import {
  __resetPageReaderForTests,
  __setPageReaderForTests,
} from '../src/ai/page-reader.ts';
import {
  drainSourceIngest,
  ingestSource,
  reconcileDocumentsOnStartup,
} from '../src/ai/source-ingest.ts';
import { reingestSource } from '../src/modules/sources-shared.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();
const DIM = 1536;

function installFakeEmbedder(): { totalEmbedded: () => number } {
  let total = 0;
  __setAiClientForTests({
    async embed(texts: string[]): Promise<number[][]> {
      total += texts.length;
      return texts.map((_, i) => {
        const v = new Array<number>(DIM).fill(0);
        v[(total + i) % DIM] = 1;
        return v;
      });
    },
  });
  return { totalEmbedded: () => total };
}

/** Inject a fake URL reader returning a fixed page (re-callable each ingest). */
function installFakeReader(text: string): void {
  __setPageReaderForTests({
    async read(url: string) {
      return { url, title: 'Page', text, links: [] };
    },
  });
}

/** Seed a verified `url` source in `pending` (no S3 — bytes are fetched via the
 * reader seam). Returns the source id. */
async function seedUrlSource(userId: string): Promise<string> {
  const [src] = await db
    .insert(sourcesTable)
    .values({
      userId,
      kind: 'url',
      title: 'Doc',
      url: 'https://example.com/doc',
      status: 'pending',
      verified: true,
    })
    .returning({ id: sourcesTable.id });
  return src!.id;
}

async function getStatus(sourceId: string): Promise<{
  status: string;
  errorCode: string | null;
  chunkCount: number | null;
  charCount: number | null;
}> {
  const [row] = await db
    .select({
      status: sourcesTable.status,
      errorCode: sourcesTable.errorCode,
      chunkCount: sourcesTable.chunkCount,
      charCount: sourcesTable.charCount,
    })
    .from(sourcesTable)
    .where(eq(sourcesTable.id, sourceId));
  return row!;
}

async function totalChunks(sourceId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(sourceChunks)
    .where(eq(sourceChunks.sourceId, sourceId));
  return row!.n;
}

async function docKbChunks(sourceId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(kbChunk)
    .where(and(eq(kbChunk.sourceId, sourceId), eq(kbChunk.sourceType, 'document')));
  return row!.n;
}

const longText = `${'word '.repeat(2000)}`.trim();

describe('reingest — guards', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
    __resetPageReaderForTests();
  });

  test('text source → 400 not_reingestable', async () => {
    const { userId, cookie } = await signUpAndCookie(app, uniqueEmail());
    const [src] = await db
      .insert(sourcesTable)
      .values({ userId, kind: 'text', title: 'Note', status: 'ready', verified: true })
      .returning({ id: sourcesTable.id });

    const res = await callApp(app, 'POST', `/library/items/${src!.id}/reingest`, { cookie });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('not_reingestable');
  });

  test('foreign source → 404', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const { cookie: otherCookie } = await signUpAndCookie(app, uniqueEmail());
    const [src] = await db
      .insert(sourcesTable)
      .values({ userId, kind: 'url', url: 'https://x', title: 'Doc', status: 'ready', verified: true })
      .returning({ id: sourcesTable.id });

    const res = await callApp(app, 'POST', `/library/items/${src!.id}/reingest`, { cookie: otherCookie });
    expect(res.status).toBe(404);
  });

  test('non-terminal (indexing) → 409 not_terminal', async () => {
    const { userId, cookie } = await signUpAndCookie(app, uniqueEmail());
    const [src] = await db
      .insert(sourcesTable)
      .values({ userId, kind: 'url', url: 'https://x', title: 'Doc', status: 'indexing', verified: true })
      .returning({ id: sourcesTable.id });

    const res = await callApp(app, 'POST', `/library/items/${src!.id}/reingest`, { cookie });
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toBe('not_terminal');
  });

  test('a pending (mid-flight) source → 409 not_terminal (CAS-loss semantics)', async () => {
    // Exactly the state a second reingest sees after the first won the CAS:
    // the row is already 'pending' → not terminal → 409.
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const [src] = await db
      .insert(sourcesTable)
      .values({ userId, kind: 'url', url: 'https://x', title: 'Doc', status: 'pending', verified: true })
      .returning({ id: sourcesTable.id });

    const res = await reingestSource(userId, src!.id);
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe('not_terminal');
  });

  test('embeddings ON → reingest response carries parked: false', async () => {
    const { userId, cookie } = await signUpAndCookie(app, uniqueEmail());
    installFakeReader(longText);
    installFakeEmbedder(); // isEmbeddingEnabled() → true under test
    const srcId = await seedUrlSource(userId);
    await ingestSource(srcId);
    expect((await getStatus(srcId)).status).toBe('ready');

    const res = await callApp(app, 'POST', `/library/items/${srcId}/reingest`, { cookie });
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; parked: boolean }>();
    expect(body.ok).toBe(true);
    expect(body.parked).toBe(false);
    await drainSourceIngest({ timeoutMs: 5000 });
  });

  test('embeddings OFF → reingest response carries parked: true (re-parses, defers embed)', async () => {
    // Seed a ready url source WITH the embedder on (so ingest can populate it),
    // then turn the embedder OFF before reingesting. The worker re-parses + parks
    // (no embed); the route reports parked: true.
    const { userId, cookie } = await signUpAndCookie(app, uniqueEmail());
    installFakeReader(longText);
    installFakeEmbedder();
    const srcId = await seedUrlSource(userId);
    await ingestSource(srcId);
    expect((await getStatus(srcId)).status).toBe('ready');

    __resetAiClientForTests(); // isEmbeddingEnabled() → false under test

    const res = await callApp(app, 'POST', `/library/items/${srcId}/reingest`, { cookie });
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; parked: boolean }>();
    expect(body.ok).toBe(true);
    expect(body.parked).toBe(true);
    await drainSourceIngest({ timeoutMs: 5000 });
  });

  test('two concurrent reingests of a ready source → exactly one wins (CAS)', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    installFakeReader(longText);
    installFakeEmbedder();
    const srcId = await seedUrlSource(userId);
    await ingestSource(srcId);
    expect((await getStatus(srcId)).status).toBe('ready');

    // Race two reingests directly on the helper. The transactional CAS
    // (status IN ('ready','error')) means exactly one updates the row; the
    // other sees 0 rows / a non-ready status → 409.
    const [a, b] = await Promise.all([
      reingestSource(userId, srcId),
      reingestSource(userId, srcId),
    ]);
    const oks = [a, b].filter((r) => r.ok).length;
    expect(oks).toBe(1);
    await drainSourceIngest({ timeoutMs: 5000 });
    expect((await getStatus(srcId)).status).toBe('ready');
  });
});

describe('reingest — cleanup + re-index to ready', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
    __resetPageReaderForTests();
  });

  test('ready → reingest wipes chunks/vectors then re-embeds back to ready', async () => {
    const { userId, cookie } = await signUpAndCookie(app, uniqueEmail());
    installFakeReader(longText);
    installFakeEmbedder();

    const srcId = await seedUrlSource(userId);
    await ingestSource(srcId);
    expect((await getStatus(srcId)).status).toBe('ready');
    const beforeChunks = await totalChunks(srcId);
    const beforeVectors = await docKbChunks(srcId);
    expect(beforeChunks).toBeGreaterThan(0);
    expect(beforeVectors).toBe(beforeChunks);

    // Reingest: route wipes chunks + document vectors + CAS ready → pending in
    // ONE tx, then enqueues the worker (fire-and-forget).
    const res = await callApp(app, 'POST', `/library/items/${srcId}/reingest`, { cookie });
    expect(res.status).toBe(200);

    // Drain the worker the route enqueued → re-parsed + re-embedded back to ready.
    await drainSourceIngest({ timeoutMs: 5000 });
    expect((await getStatus(srcId)).status).toBe('ready');
    const finalChunks = await totalChunks(srcId);
    expect(finalChunks).toBeGreaterThan(0);
    // Exactly one document kb_chunk per chunk (idempotent upsert — no doubling).
    expect(await docKbChunks(srcId)).toBe(finalChunks);
  });

  test('reingest helper wipes SoT chunks + document vectors + resets metadata', async () => {
    // Seed a "ready" source with chunks + document vectors directly (no worker),
    // so the helper's wipe is observed in isolation. The enqueued worker is
    // PARKED on a gated reader while we assert — the old "unreachable host
    // fails fast" trick RACED the worker (on slower CI runners it stamped
    // errorCode='fetch_failed' before the assertions ran).
    let releaseReader: () => void = () => {};
    const readerGate = new Promise<void>((resolve) => {
      releaseReader = resolve;
    });
    __setPageReaderForTests({
      async read(): Promise<never> {
        await readerGate;
        throw new Error('gated reader: deliberate post-assert failure');
      },
    });
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const [src] = await db
      .insert(sourcesTable)
      .values({
        userId,
        kind: 'url',
        // Any url — the gated reader above intercepts the worker's fetch.
        url: 'https://nope.localhost/x',
        title: 'Doc',
        status: 'ready',
        verified: true,
        chunkCount: 2,
        charCount: 1234,
      })
      .returning({ id: sourcesTable.id });
    const srcId = src!.id;
    await db.insert(sourceChunks).values([
      { userId, sourceId: srcId, position: 0, text: 'a', embedded: true, sourceHash: 'h0' },
      { userId, sourceId: srcId, position: 1, text: 'b', embedded: true, sourceHash: 'h1' },
    ]);
    await db.insert(kbChunk).values([
      {
        userId,
        sourceType: 'document',
        sourceId: srcId,
        parentId: srcId,
        position: 0,
        text: 'a',
        embedding: new Array<number>(DIM).fill(0),
        embeddingModel: 'm',
        sourceHash: 'h0',
        cardId: null,
      },
    ]);
    expect(await totalChunks(srcId)).toBe(2);
    expect(await docKbChunks(srcId)).toBe(1);

    const out = await reingestSource(userId, srcId);
    expect(out.ok).toBe(true);
    // The wipe + metadata reset are committed in the helper's tx.
    expect(await totalChunks(srcId)).toBe(0);
    expect(await docKbChunks(srcId)).toBe(0);
    const st = await getStatus(srcId);
    expect(st.chunkCount).toBeNull();
    expect(st.charCount).toBeNull();
    expect(st.errorCode).toBeNull();
    releaseReader();
    await drainSourceIngest({ timeoutMs: 5000 });
  });
});

describe('document-reconcile — re-embed on model change (L4 §5)', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
    __resetPageReaderForTests();
  });

  test('model change re-embeds the document (SoT hash updated, kb_chunk rewritten, embedded stays true)', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    installFakeReader(longText);
    installFakeEmbedder();

    const srcId = await seedUrlSource(userId);
    await ingestSource(srcId);
    expect((await getStatus(srcId)).status).toBe('ready');

    // Snapshot the SoT hashes + kb_chunk model BEFORE the model swap.
    const before = await db
      .select({ id: sourceChunks.id, hash: sourceChunks.sourceHash, embedded: sourceChunks.embedded })
      .from(sourceChunks)
      .where(eq(sourceChunks.sourceId, srcId))
      .orderBy(sourceChunks.position);
    const [kbBefore] = await db
      .select({ model: kbChunk.embeddingModel })
      .from(kbChunk)
      .where(and(eq(kbChunk.sourceId, srcId), eq(kbChunk.sourceType, 'document')))
      .limit(1);
    const totalBefore = before.length;
    expect(totalBefore).toBeGreaterThan(0);

    // Simulate an EMBEDDING_MODEL change by forcing the stored hashes/model stale
    // (the reconcile detects staleness via hash + kb_chunk.embedding_model).
    await db
      .update(sourceChunks)
      .set({ sourceHash: 'STALE-OLD-MODEL-HASH' })
      .where(eq(sourceChunks.sourceId, srcId));
    await db
      .update(kbChunk)
      .set({ embeddingModel: 'old-model' })
      .where(and(eq(kbChunk.sourceId, srcId), eq(kbChunk.sourceType, 'document')));

    const n = await reconcileDocumentsOnStartup({ userId });
    expect(n).toBe(1);

    // SoT hashes refreshed (no longer the stale sentinel), embedded still true.
    const after = await db
      .select({ id: sourceChunks.id, hash: sourceChunks.sourceHash, embedded: sourceChunks.embedded })
      .from(sourceChunks)
      .where(eq(sourceChunks.sourceId, srcId))
      .orderBy(sourceChunks.position);
    expect(after.length).toBe(totalBefore);
    for (const c of after) {
      expect(c.hash).not.toBe('STALE-OLD-MODEL-HASH');
      expect(c.embedded).toBe(true);
    }
    // kb_chunk re-stamped to the current model (no longer 'old-model').
    const [kbAfter] = await db
      .select({ model: kbChunk.embeddingModel })
      .from(kbChunk)
      .where(and(eq(kbChunk.sourceId, srcId), eq(kbChunk.sourceType, 'document')))
      .limit(1);
    expect(kbAfter!.model).not.toBe('old-model');
    expect(kbAfter!.model).toBe(kbBefore!.model); // back to the real model
    // No vector duplication.
    expect(await docKbChunks(srcId)).toBe(totalBefore);

    // Idempotent: a second pass finds nothing stale (0 re-embedded).
    expect(await reconcileDocumentsOnStartup({ userId })).toBe(0);
  });

  test('embeddings off → reconcile parks (no changes)', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    installFakeReader(longText);
    installFakeEmbedder();

    const srcId = await seedUrlSource(userId);
    await ingestSource(srcId);
    expect((await getStatus(srcId)).status).toBe('ready');

    // Make the chunks look stale, then turn the embedder OFF.
    await db
      .update(sourceChunks)
      .set({ sourceHash: 'STALE' })
      .where(eq(sourceChunks.sourceId, srcId));
    __resetAiClientForTests(); // isEmbeddingEnabled() → false under test

    const n = await reconcileDocumentsOnStartup({ userId });
    expect(n).toBe(0);
    // Nothing changed — the stale sentinel survives (parked, never churned).
    const [row] = await db
      .select({ hash: sourceChunks.sourceHash })
      .from(sourceChunks)
      .where(eq(sourceChunks.sourceId, srcId))
      .limit(1);
    expect(row!.hash).toBe('STALE');
  });
});
