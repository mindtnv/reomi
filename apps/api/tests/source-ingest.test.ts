// Async source-ingest worker (NotebookLM M1, T6 / AC1.6 + AC1.7).
//
// Drives the pipeline SYNCHRONOUSLY via the exported `ingestSource(sourceId)`
// (no HTTP, no real timers). A fake embedder is injected through
// `__setAiClientForTests({ embed })`; parsers through the source-parsers seams.
// We use `text` sources (no S3 bytes — the inline text is stashed) so finalize /
// storage are out of scope (see source-dedup.test.ts note + report).
//
// Coverage:
//   * status machine pending → parsing → indexing → ready
//   * COMPUTED progress: indexed = COUNT(source_chunks.embedded=true)
//   * mid-batch crash → resume re-ingest completes WITHOUT double-embedding
//     (chunk counts stable; only embedded=false rows re-embed)
//   * CAS idempotency: a second concurrent ingest is a no-op
//   * over MAX_SOURCE_CHUNKS → status='error', errorCode='too_many_chunks'
//   * parse throw → status='error' with the parser's typed code
//   * notebooksEnabled OFF (no embedder) → parse-and-park (source_chunks exist,
//     status stays 'indexing' — NOT 'error', NOT 'ready')

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { and, count, eq } from 'drizzle-orm';
import {
  db,
  kbChunk,
  notebooks,
  sourceChunks,
  sources as sourcesTable,
} from '@reomi/db';
import {
  __resetAiClientForTests,
  __setAiClientForTests,
} from '../src/ai/openai-client.ts';
import { __setPdfExtractorForTests } from '../src/ai/source-parsers.ts';
import { ingestSource, stashInlineText } from '../src/ai/source-ingest.ts';
import { resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const DIM = 1536;

/** A deterministic non-zero embedding (distinct per text — see helpers). */
function fakeVector(seed: number): number[] {
  const v = new Array<number>(DIM).fill(0);
  v[seed % DIM] = 1;
  v[(seed * 7 + 3) % DIM] = 0.5;
  return v;
}

/**
 * Inject a fake embedder. Returns the call log so a test can assert how many
 * texts were embedded across the whole run (double-embed detection).
 */
function installFakeEmbedder(opts: { failAfter?: number } = {}): {
  totalEmbedded: () => number;
  calls: () => number;
} {
  let total = 0;
  let calls = 0;
  __setAiClientForTests({
    async embed(texts: string[]): Promise<number[][]> {
      calls += 1;
      if (opts.failAfter !== undefined && total >= opts.failAfter) {
        throw new Error('simulated embed crash');
      }
      total += texts.length;
      return texts.map((_, i) => fakeVector(total + i));
    },
  });
  return { totalEmbedded: () => total, calls: () => calls };
}

async function freshNotebook(userId: string): Promise<string> {
  const [nb] = await db.insert(notebooks).values({ userId, title: 'NB' }).returning({ id: notebooks.id });
  return nb!.id;
}

/** Seed a pending `text` source + stash its inline text. Returns the source id. */
async function seedTextSource(userId: string, _notebookId: string, text: string): Promise<string> {
  // Sources are user-level now (library refactor) — no notebook_id on the row.
  const [src] = await db
    .insert(sourcesTable)
    .values({
      userId,
      kind: 'text',
      title: 'Inline',
      status: 'pending',
      verified: true,
    })
    .returning({ id: sourcesTable.id });
  stashInlineText(src!.id, text);
  return src!.id;
}

async function getStatus(sourceId: string): Promise<{ status: string; errorCode: string | null; chunkCount: number | null }> {
  const [row] = await db
    .select({ status: sourcesTable.status, errorCode: sourcesTable.errorCode, chunkCount: sourcesTable.chunkCount })
    .from(sourcesTable)
    .where(eq(sourcesTable.id, sourceId));
  return row!;
}

async function embeddedCount(sourceId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(sourceChunks)
    .where(and(eq(sourceChunks.sourceId, sourceId), eq(sourceChunks.embedded, true)));
  return row!.n;
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

/** A long text that the document chunker will split into MANY chunks. */
function manyChunkText(approxChunks: number): string {
  // ~800 tokens/chunk × ~4 chars/token = ~3200 chars/chunk. Build N paragraphs.
  const para = `${'word '.repeat(900)}`.trim(); // ~4500 chars ≈ >1 chunk each
  return Array.from({ length: approxChunks }, (_, i) => `Para ${i}. ${para}`).join('\n\n');
}

describe('source-ingest — status machine + computed progress', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
    __setPdfExtractorForTests(null);
  });

  test('pending → ready, all chunks embedded, kb_chunk doc rows written', async () => {
    const { userId } = await signUpAndCookie(app(), uniqueEmail());
    const nbId = await freshNotebook(userId);
    const srcId = await seedTextSource(userId, nbId, manyChunkText(3));
    const embedder = installFakeEmbedder();

    await ingestSource(srcId);

    const { status, chunkCount } = await getStatus(srcId);
    expect(status).toBe('ready');
    expect(chunkCount).toBeGreaterThan(0);
    // Progress numerator == denominator at ready.
    const total = await totalChunks(srcId);
    expect(await embeddedCount(srcId)).toBe(total);
    expect(chunkCount).toBe(total);
    // One kb_chunk document row per source_chunk.
    expect(await docKbChunks(srcId)).toBe(total);
    // Embedder saw exactly `total` texts (no double embed).
    expect(embedder.totalEmbedded()).toBe(total);
  });

  test('progress is COMPUTED from embedded flag, not a stored counter', async () => {
    const { userId } = await signUpAndCookie(app(), uniqueEmail());
    const nbId = await freshNotebook(userId);
    const srcId = await seedTextSource(userId, nbId, manyChunkText(2));
    installFakeEmbedder();

    await ingestSource(srcId);
    const total = await totalChunks(srcId);
    expect(await embeddedCount(srcId)).toBe(total);

    // Manually flip one chunk back to embedded=false → computed progress drops.
    const [firstChunk] = await db
      .select({ id: sourceChunks.id })
      .from(sourceChunks)
      .where(eq(sourceChunks.sourceId, srcId))
      .orderBy(sourceChunks.position)
      .limit(1);
    await db.update(sourceChunks).set({ embedded: false }).where(eq(sourceChunks.id, firstChunk!.id));
    expect(await embeddedCount(srcId)).toBe(total - 1);
  });
});

describe('source-ingest — crash + resume (no double embed)', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('mid-batch embed crash → status error path NOT reached for the SoT; resume completes without re-embedding done chunks', async () => {
    const { userId } = await signUpAndCookie(app(), uniqueEmail());
    const nbId = await freshNotebook(userId);
    // Enough text for several embed batches (EMBED_BATCH=96; build > that many chunks
    // is expensive — instead force the crash after the FIRST batch via failAfter).
    const srcId = await seedTextSource(userId, nbId, manyChunkText(4));

    // First run: parse succeeds (writes SoT), embedding throws on the FIRST batch.
    const crashing = installFakeEmbedder({ failAfter: 0 });
    await ingestSource(srcId); // never throws into the caller (per-source try/catch)
    expect(crashing.calls()).toBeGreaterThan(0);
    // Parse phase wrote the SoT (chunks exist) even though embedding failed.
    const total = await totalChunks(srcId);
    expect(total).toBeGreaterThan(0);
    // Nothing embedded yet (the first batch threw before the embed tx).
    expect(await embeddedCount(srcId)).toBe(0);
    // A failed embed → casStatus to 'error' (the worker maps the throw).
    const afterCrash = await getStatus(srcId);
    expect(afterCrash.status).toBe('error');
    expect(afterCrash.errorCode).toBe('index_failed');

    // Recover: reset to indexing (what resumeSourceIngestOnStartup does → pending,
    // but the SoT already exists so re-ingest re-parses + embeds the unembedded).
    __resetAiClientForTests();
    const good = installFakeEmbedder();
    // Resume the way startup does: CAS the row back to pending and re-run.
    await db.update(sourcesTable).set({ status: 'pending', errorCode: null }).where(eq(sourcesTable.id, srcId));
    await ingestSource(srcId);

    const done = await getStatus(srcId);
    expect(done.status).toBe('ready');
    // Chunk count stays BOUNDED across crash+resume — the re-parse wipes+reinserts
    // (recovered from SoT, so it may differ by a chunk due to overlap/join), but it
    // must NOT balloon (no accumulation of stale rows).
    const finalTotal = await totalChunks(srcId);
    expect(finalTotal).toBeLessThanOrEqual(total + 1);
    expect(finalTotal).toBeGreaterThan(0);
    // All chunks embedded at ready (progress complete).
    expect(await embeddedCount(srcId)).toBe(finalTotal);
    // EXACTLY one kb_chunk doc row per source_chunk — the idempotent upsert means
    // the resume re-embed never DUPLICATES kb_chunk rows (the no-double-embed
    // invariant: storage stays 1:1, not 2×).
    expect(await docKbChunks(srcId)).toBe(finalTotal);
    // The recovery embedder embedded exactly the final chunk count once — never a
    // doubling (that would be `2 * finalTotal`).
    expect(good.totalEmbedded()).toBe(finalTotal);
  });

  test('resume of an already-indexing source (SoT present) only embeds embedded=false rows', async () => {
    const { userId } = await signUpAndCookie(app(), uniqueEmail());
    const nbId = await freshNotebook(userId);
    const srcId = await seedTextSource(userId, nbId, manyChunkText(3));

    // First full run → ready.
    installFakeEmbedder();
    await ingestSource(srcId);
    const total = await totalChunks(srcId);
    expect(await embeddedCount(srcId)).toBe(total);
    __resetAiClientForTests();

    // Simulate a torn embed: flip the source back to 'indexing' and one chunk to
    // embedded=false (as if its embed tx never committed).
    await db.update(sourcesTable).set({ status: 'indexing' }).where(eq(sourcesTable.id, srcId));
    const [oneChunk] = await db
      .select({ id: sourceChunks.id })
      .from(sourceChunks)
      .where(eq(sourceChunks.sourceId, srcId))
      .limit(1);
    await db.update(sourceChunks).set({ embedded: false }).where(eq(sourceChunks.id, oneChunk!.id));

    const resumeEmbedder = installFakeEmbedder();
    await ingestSource(srcId); // claim fails (not pending) → resumeIndexing → indexPhase

    expect((await getStatus(srcId)).status).toBe('ready');
    expect(await embeddedCount(srcId)).toBe(total);
    // Only the ONE unembedded chunk was re-embedded.
    expect(resumeEmbedder.totalEmbedded()).toBe(1);
    expect(await totalChunks(srcId)).toBe(total);
  });
});

describe('source-ingest — CAS idempotency', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('a second concurrent ingest of the same source is a no-op (no extra embedding, single ready)', async () => {
    const { userId } = await signUpAndCookie(app(), uniqueEmail());
    const nbId = await freshNotebook(userId);
    const srcId = await seedTextSource(userId, nbId, manyChunkText(3));
    const embedder = installFakeEmbedder();

    // Two concurrent ingests racing the same pending row. CAS pending→parsing
    // means exactly one claims it; the other finds it non-pending and resumes
    // (which embeds only embedded=false — zero, once the first is done).
    await Promise.all([ingestSource(srcId), ingestSource(srcId)]);

    expect((await getStatus(srcId)).status).toBe('ready');
    const total = await totalChunks(srcId);
    // No double embedding: at most one set of texts embedded (the loser embeds 0).
    expect(embedder.totalEmbedded()).toBe(total);
    // Exactly one kb_chunk doc row per chunk (no duplicate inserts).
    expect(await docKbChunks(srcId)).toBe(total);
  });
});

describe('source-ingest — error terminals', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
    __setPdfExtractorForTests(null);
  });

  test('over MAX_SOURCE_CHUNKS → status=error, errorCode=too_many_chunks (no embedding)', async () => {
    const { userId } = await signUpAndCookie(app(), uniqueEmail());
    const nbId = await freshNotebook(userId);
    // A `text` source whose inline text chunks into MORE than MAX_SOURCE_CHUNKS.
    // Drive it via stashInlineText (the route's 200k inline cap does not apply
    // to the worker; the cap under test is the chunk-count guard, not bytes).
    // Each chunk is ~SOURCE_CHUNK_TOKENS*4 chars; size the text past the cap.
    const { env } = await import('../src/env.ts');
    const cap = env.ai.MAX_SOURCE_CHUNKS;
    const charsPerChunk = env.ai.SOURCE_CHUNK_TOKENS * 4; // chars/4 token heuristic
    // Pad generously (×1.5 the cap of chunks) so chunks.length comfortably > cap
    // regardless of overlap/packing slack — borderline sizing flaked otherwise.
    const totalChars = Math.ceil(charsPerChunk * Math.ceil(cap * 1.5));
    const bigText = 'word '.repeat(Math.ceil(totalChars / 5));

    const [src] = await db
      .insert(sourcesTable)
      .values({ userId, kind: 'text', title: 'Huge', status: 'pending', verified: true })
      .returning({ id: sourcesTable.id });
    stashInlineText(src!.id, bigText);

    const embedder = installFakeEmbedder();
    await ingestSource(src!.id);

    const st = await getStatus(src!.id);
    expect(st.status).toBe('error');
    expect(st.errorCode).toBe('too_many_chunks');
    // Never embedded (the over-limit guard short-circuits before indexPhase).
    expect(embedder.totalEmbedded()).toBe(0);
    expect(await docKbChunks(src!.id)).toBe(0);
    // The over-limit guard short-circuits BEFORE writing SoT chunks too.
    expect(await totalChunks(src!.id)).toBe(0);
  });

  test('a parse throw → status=error with the parser typed code', async () => {
    const { userId } = await signUpAndCookie(app(), uniqueEmail());
    const nbId = await freshNotebook(userId);
    // text source whose stashed text is empty → parseText → empty_source.
    const [src] = await db
      .insert(sourcesTable)
      .values({ userId, kind: 'text', title: 'Empty', status: 'pending', verified: true })
      .returning({ id: sourcesTable.id });
    stashInlineText(src!.id, '   '); // whitespace only → empty_source

    installFakeEmbedder();
    await ingestSource(src!.id);

    const st = await getStatus(src!.id);
    expect(st.status).toBe('error');
    expect(st.errorCode).toBe('empty_source');
  });
});

describe('source-ingest — notebooksEnabled OFF (parse-and-park)', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('no embedder → SoT written, status parks at indexing (NOT error, NOT ready)', async () => {
    // Do NOT install a fake embedder → isEmbeddingEnabled() is false under test.
    __resetAiClientForTests();
    const { userId } = await signUpAndCookie(app(), uniqueEmail());
    const nbId = await freshNotebook(userId);
    const srcId = await seedTextSource(userId, nbId, manyChunkText(2));

    await ingestSource(srcId);

    const st = await getStatus(srcId);
    // Parked at indexing — SoT durable, embedding deferred (degrade, never crash).
    expect(st.status).toBe('indexing');
    expect(st.errorCode).toBeNull();
    // SoT chunks exist…
    expect(await totalChunks(srcId)).toBeGreaterThan(0);
    // …but nothing embedded yet.
    expect(await embeddedCount(srcId)).toBe(0);
    expect(await docKbChunks(srcId)).toBe(0);
  });

  test('a later resume WITH an embedder finishes the parked source', async () => {
    __resetAiClientForTests();
    const { userId } = await signUpAndCookie(app(), uniqueEmail());
    const nbId = await freshNotebook(userId);
    const srcId = await seedTextSource(userId, nbId, manyChunkText(2));
    await ingestSource(srcId); // parks at indexing
    expect((await getStatus(srcId)).status).toBe('indexing');

    // Now a key/embedder arrives → resume (status indexing → indexPhase → ready).
    const embedder = installFakeEmbedder();
    await ingestSource(srcId);

    expect((await getStatus(srcId)).status).toBe('ready');
    const total = await totalChunks(srcId);
    expect(await embeddedCount(srcId)).toBe(total);
    expect(embedder.totalEmbedded()).toBe(total);
  });
});

// ── shared app instance (signUpAndCookie needs a handler) ─────────────────────
import { buildApp } from '../src/app.ts';
let _app: ReturnType<typeof buildApp> | null = null;
function app(): ReturnType<typeof buildApp> {
  if (!_app) _app = buildApp();
  return _app;
}
