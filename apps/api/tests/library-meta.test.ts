// Library metadata + covers + semantic search (L3, §8.2/§8.3).
//
//   * PATCH coverMediaId — foreign media → 400 invalid_media (NOT recorded);
//     verified=false media → 400; a verified own media id is set + surfaced as
//     coverUrl. pageCount/language validation (explicit field map).
//   * coverUrl in the list response and the item detail.
//   * GET /library/search — empty q → 400; embeddings disabled → reason; with a
//     scripted embed: grouping by source, group/hit ordering, ≤5 hits per source
//     cap; does NOT see another user's sources nor non-ready sources.
//
// Document fixtures inserted directly via db (mirror library.test.ts). The
// scripted fake embed flips embeddings on under NODE_ENV=test.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import {
  db,
  kbChunk,
  media as mediaTable,
  sourceChunks as sourceChunksTable,
  sources as sourcesTable,
} from '@reomi/db';
import { buildApp } from '../src/app.ts';
import {
  __resetAiClientForTests,
  __setAiClientForTests,
} from '../src/ai/openai-client.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();
const EMBED_DIM = 1536;

// Deterministic text → vector (mirror library.test.ts / notebook-chat.test.ts).
function vectorFor(text: string): number[] {
  const v = new Array<number>(EMBED_DIM).fill(0);
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  for (let i = 0; i < 8; i++) {
    const idx = (h + i * 131) % EMBED_DIM;
    v[idx] = ((h >>> (i * 3)) % 100) / 100 + 0.01;
  }
  return v;
}
function fakeEmbed(texts: string[]): Promise<number[][]> {
  return Promise.resolve(texts.map(vectorFor));
}

/** Seed a user-level source + doc chunks (kb_chunk + source_chunks). */
async function seedSource(
  userId: string,
  opts: {
    title?: string;
    kind?: 'pdf' | 'epub' | 'url' | 'text';
    author?: string;
    status?: string;
    coverMediaId?: string | null;
    chunks?: { text: string; page?: number; heading?: string }[];
  } = {},
): Promise<{ sourceId: string; chunkIds: string[] }> {
  const chunks = opts.chunks ?? [];
  const [src] = await db
    .insert(sourcesTable)
    .values({
      userId,
      kind: opts.kind ?? 'pdf',
      title: opts.title ?? 'Book',
      author: opts.author ?? null,
      status: opts.status ?? 'ready',
      verified: true,
      coverMediaId: opts.coverMediaId ?? null,
      chunkCount: chunks.length,
    })
    .returning({ id: sourcesTable.id });
  const sourceId = src!.id;
  const chunkIds: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    const [sc] = await db
      .insert(sourceChunksTable)
      .values({ userId, sourceId, position: i, text: c.text, page: c.page, heading: c.heading, embedded: true })
      .returning({ id: sourceChunksTable.id });
    chunkIds.push(sc!.id);
    await db.insert(kbChunk).values({
      userId,
      sourceType: 'document',
      sourceId,
      parentId: sourceId,
      position: i,
      text: c.text,
      embedding: vectorFor(c.text),
      embeddingModel: 'test-fixture',
      sourceHash: `fixture-${sourceId}-${i}`,
      cardId: null,
    });
  }
  return { sourceId, chunkIds };
}

/** Insert a media row (verified or not) for a user. */
async function seedMedia(userId: string, verified: boolean): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(mediaTable).values({
    id,
    userId,
    s3Key: `media/${id}`,
    mime: 'image/png',
    size: 100,
    verified,
  });
  return id;
}

describe('library — PATCH metadata + covers (§8.2)', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => __resetAiClientForTests());

  test('coverMediaId of ANOTHER user → 400 invalid_media + not recorded', async () => {
    const a = await signUpAndCookie(app, uniqueEmail());
    const b = await signUpAndCookie(app, uniqueEmail());
    const { sourceId } = await seedSource(a.userId);
    const foreignMedia = await seedMedia(b.userId, true);

    const res = await callApp(app, 'PATCH', `/library/items/${sourceId}`, {
      cookie: a.cookie,
      body: { coverMediaId: foreignMedia },
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_media');

    const [row] = await db
      .select({ coverMediaId: sourcesTable.coverMediaId })
      .from(sourcesTable)
      .where(eq(sourcesTable.id, sourceId));
    expect(row!.coverMediaId).toBeNull();
  });

  test('coverMediaId of an UNVERIFIED media row → 400 invalid_media', async () => {
    const a = await signUpAndCookie(app, uniqueEmail());
    const { sourceId } = await seedSource(a.userId);
    const pending = await seedMedia(a.userId, false);

    const res = await callApp(app, 'PATCH', `/library/items/${sourceId}`, {
      cookie: a.cookie,
      body: { coverMediaId: pending },
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_media');
  });

  test('coverMediaId of own verified media is set + surfaced as coverUrl', async () => {
    const a = await signUpAndCookie(app, uniqueEmail());
    const { sourceId } = await seedSource(a.userId);
    const ownMedia = await seedMedia(a.userId, true);

    const res = await callApp(app, 'PATCH', `/library/items/${sourceId}`, {
      cookie: a.cookie,
      body: { coverMediaId: ownMedia },
    });
    expect(res.status).toBe(200);

    const detail = await callApp(app, 'GET', `/library/items/${sourceId}`, { cookie: a.cookie });
    const d = await detail.json<{ coverMediaId: string; coverUrl: string }>();
    expect(d.coverMediaId).toBe(ownMedia);
    expect(d.coverUrl).toBe(`/m/${ownMedia}`);
  });

  test('pageCount/language validation (explicit field map)', async () => {
    const a = await signUpAndCookie(app, uniqueEmail());
    const { sourceId } = await seedSource(a.userId);

    // Non-positive pageCount → 400.
    let res = await callApp(app, 'PATCH', `/library/items/${sourceId}`, {
      cookie: a.cookie,
      body: { pageCount: 0 },
    });
    expect(res.status).toBe(400);

    // Over-long language → 400.
    res = await callApp(app, 'PATCH', `/library/items/${sourceId}`, {
      cookie: a.cookie,
      body: { language: 'x'.repeat(20) },
    });
    expect(res.status).toBe(400);

    // Valid values persist.
    res = await callApp(app, 'PATCH', `/library/items/${sourceId}`, {
      cookie: a.cookie,
      body: { pageCount: 42, language: 'ru' },
    });
    expect(res.status).toBe(200);
    const out = await res.json<{ pageCount: number; language: string }>();
    expect(out.pageCount).toBe(42);
    expect(out.language).toBe('ru');
  });

  test('coverUrl appears in the list response (null when no cover)', async () => {
    const a = await signUpAndCookie(app, uniqueEmail());
    const m = await seedMedia(a.userId, true);
    await seedSource(a.userId, { title: 'WithCover', coverMediaId: m });
    await seedSource(a.userId, { title: 'NoCover' });

    const res = await callApp(app, 'GET', '/library', { cookie: a.cookie });
    const { items } = await res.json<{ items: { title: string; coverUrl: string | null }[] }>();
    const withCover = items.find((i) => i.title === 'WithCover')!;
    const noCover = items.find((i) => i.title === 'NoCover')!;
    expect(withCover.coverUrl).toBe(`/m/${m}`);
    expect(noCover.coverUrl).toBeNull();
  });
});

describe('library — semantic search (§8.3)', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => __resetAiClientForTests());

  test('empty q → 400', async () => {
    const a = await signUpAndCookie(app, uniqueEmail());
    const res = await callApp(app, 'GET', '/library/search?q=%20%20', { cookie: a.cookie });
    expect(res.status).toBe(400);
  });

  test('embeddings disabled → 200 { groups: [], reason: embedding_disabled }', async () => {
    const a = await signUpAndCookie(app, uniqueEmail());
    await seedSource(a.userId, { chunks: [{ text: 'photosynthesis converts light' }] });
    // NO injected AI client → embeddings off under NODE_ENV=test.
    const res = await callApp(app, 'GET', '/library/search?q=light', { cookie: a.cookie });
    expect(res.status).toBe(200);
    const body = await res.json<{ groups: unknown[]; reason?: string }>();
    expect(body.groups).toEqual([]);
    expect(body.reason).toBe('embedding_disabled');
  });

  test('groups by source, sorts groups by max score, caps 5 hits/source', async () => {
    __setAiClientForTests({ embed: fakeEmbed });
    const a = await signUpAndCookie(app, uniqueEmail());

    // Source A: the query text appears verbatim (exact-vector hit) + filler.
    const query = 'mitochondria are the powerhouse';
    await seedSource(a.userId, {
      title: 'Cell Biology',
      chunks: [
        { text: query, page: 5 },
        { text: 'cytoplasm surrounds organelles', page: 6 },
        { text: 'ribosomes synthesize proteins', page: 7 },
        { text: 'golgi packages vesicles', page: 8 },
        { text: 'lysosomes digest waste', page: 9 },
        { text: 'nucleus holds dna', page: 10 },
      ],
    });
    // Source B: an unrelated source with one weakly-matching chunk.
    await seedSource(a.userId, {
      title: 'Cooking',
      chunks: [{ text: 'boil pasta in salted water', page: 1 }],
    });

    const res = await callApp(app, 'GET', `/library/search?q=${encodeURIComponent(query)}`, {
      cookie: a.cookie,
    });
    expect(res.status).toBe(200);
    const body = await res.json<{
      groups: { source: { title: string }; hits: { score: number; page: number | null }[] }[];
    }>();
    expect(body.groups.length).toBeGreaterThanOrEqual(1);
    // The exact-match source ranks first.
    expect(body.groups[0]!.source.title).toBe('Cell Biology');
    // ≤5 hits per source.
    for (const g of body.groups) expect(g.hits.length).toBeLessThanOrEqual(5);
    // Hits within a group are score-descending.
    const scores = body.groups[0]!.hits.map((h) => h.score);
    for (let i = 1; i < scores.length; i++) expect(scores[i]!).toBeLessThanOrEqual(scores[i - 1]!);
  });

  test('embed throws → 200 { groups: [], reason: embedding_failed } (degrade, never 5xx)', async () => {
    // A fake whose embed() rejects (gateway 5xx / network) flips embeddings ON
    // (isEmbeddingEnabled) but the paid call fails — the route must degrade to a
    // 200 with a machine reason, not surface a 500.
    __setAiClientForTests({
      embed: () => Promise.reject(new Error('embed_failed:503')),
    });
    const a = await signUpAndCookie(app, uniqueEmail());
    await seedSource(a.userId, { chunks: [{ text: 'photosynthesis converts light' }] });

    const res = await callApp(app, 'GET', '/library/search?q=light', { cookie: a.cookie });
    expect(res.status).toBe(200);
    const body = await res.json<{ groups: unknown[]; reason?: string }>();
    expect(body.groups).toEqual([]);
    expect(body.reason).toBe('embedding_failed');
  });

  test('does NOT see another user\'s sources nor non-ready ones', async () => {
    __setAiClientForTests({ embed: fakeEmbed });
    const a = await signUpAndCookie(app, uniqueEmail());
    const b = await signUpAndCookie(app, uniqueEmail());
    const query = 'quantum entanglement spooky action';

    // B owns a matching source — must NOT appear in A's search.
    await seedSource(b.userId, { title: 'Foreign', chunks: [{ text: query, page: 1 }] });
    // A owns a matching source but it's still indexing (non-ready) — excluded.
    await seedSource(a.userId, { title: 'NotReady', status: 'indexing', chunks: [{ text: query, page: 1 }] });

    const res = await callApp(app, 'GET', `/library/search?q=${encodeURIComponent(query)}`, {
      cookie: a.cookie,
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ groups: { source: { title: string } }[]; reason?: string }>();
    expect(body.groups.map((g) => g.source.title)).not.toContain('Foreign');
    expect(body.groups.map((g) => g.source.title)).not.toContain('NotReady');
    // A has zero ready sources ⇒ no_sources reason.
    expect(body.reason).toBe('no_sources');
  });
});
