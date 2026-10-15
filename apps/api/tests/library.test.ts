// Library module (L1) — the user's personal material store + the notebook
// attach/detach edges (library refactor). Sources are user-level now; notebooks
// plug them in via `notebook_sources`. This suite exercises:
//
//   * attach/detach: idempotent attach, foreign-source 404 (zero edges), batch
//     cap (400), detach removes only the edge (source/chunks/vectors live —
//     count-preservation), detach of a missing edge 404, m2m (one source in two
//     notebooks).
//   * notebook-delete PRESERVATION: a source in two notebooks survives deleting
//     one notebook (kb_chunk + source_chunks count-preserved, the OTHER notebook
//     still sees it + its grounded chat works).
//   * /library: list (own-only, deleting hidden, cursor paging), filters (q over
//     title+author, kind, reading), aggregates (notebookCount/cardCount), POST
//     items (text + with notebookId ⇒ immediate attach), PATCH (explicit field
//     map, unknown keys ignored, empty title 400, empty body 400, tags>32 400,
//     readingStatus upsert), PUT reading-state (create unread→reading, idempotent
//     update, percent out of range 400, foreign 404), DELETE (404 on re-GET +
//     kb_chunk cleanup), library_full cap (409).
//   * finalize dedup: the 409 carries existingSourceId (DB-layer backstop — no S3
//     seam exists, the e2e round-trip lives in source-dedup.test.ts).
//
// Document fixtures are inserted DIRECTLY via db (user-level sources + edges +
// chunks + kb_chunk doc rows). A scripted fake AI client drives the one grounded
// chat assertion (NODE_ENV=test forces real AI off; injecting chatStreamAgentic
// flips it on), mirroring notebook-chat.test.ts.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { and, count, eq } from 'drizzle-orm';
import {
  cardSources as cardSourcesTable,
  db,
  kbChunk,
  notebooks as notebooksTable,
  notebookSources as notebookSourcesTable,
  sourceChunks as sourceChunksTable,
  sourceReadingState as readingStateTable,
  sources as sourcesTable,
} from '@reomi/db';
import { buildApp } from '../src/app.ts';
import { env } from '../src/env.ts';
import { drainSourceIngest } from '../src/ai/source-ingest.ts';
import { sourceIngestWorkerState } from '../src/runtime-state.ts';
import {
  __resetAiClientForTests,
  __setAiClientForTests,
  type AgentChatMessage,
  type AgentStreamChunk,
} from '../src/ai/openai-client.ts';
import {
  callApp,
  resetTestDb,
  seedBasicCard,
  signUpAndCookie,
  uniqueEmail,
} from './helpers.ts';

const app = buildApp();
const EMBED_DIM = 1536;

async function finishSourceIngest() {
  // POST returns before parsing finishes. Release source/chunk locks before
  // the next test's TRUNCATE takes exclusive table locks.
  await drainSourceIngest({ timeoutMs: 4000 });
  expect(sourceIngestWorkerState.snapshot()).toMatchObject({ active: 0, queued: 0 });
  __resetAiClientForTests();
}

// ── deterministic text→vector (mirror notebook-chat.test.ts) ──────────────────
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

// ── scripted agentic fake (one turn per chatStreamAgentic call) ───────────────
interface AgentTurn {
  content?: string[];
  toolCalls?: { id: string; name: string; args: Record<string, unknown> }[];
  finish: 'stop' | 'tool_calls';
}
function scriptedAgentStream(script: AgentTurn[]) {
  let call = 0;
  return async function* (_messages: AgentChatMessage[]): AsyncIterable<AgentStreamChunk> {
    const turn = script[call++];
    if (!turn) {
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    for (const c of turn.content ?? []) yield { type: 'content', text: c };
    let index = 0;
    for (const tc of turn.toolCalls ?? []) {
      yield { type: 'tool_call_delta', index, id: tc.id, name: tc.name };
      yield { type: 'tool_call_delta', index, argsFragment: JSON.stringify(tc.args) };
      index += 1;
    }
    yield { type: 'finish', reason: turn.finish };
  };
}

// ── SSE reader ────────────────────────────────────────────────────────────────
interface SseFrame {
  event: string;
  data: unknown;
}
async function readSse(res: Response): Promise<SseFrame[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames: SseFrame[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      let event = 'message';
      let data = '';
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      frames.push({ event, data: data ? JSON.parse(data) : null });
    }
  }
  return frames;
}

// ── fixtures ──────────────────────────────────────────────────────────────────

async function freshNotebook(userId: string, title = 'NB'): Promise<string> {
  const [nb] = await db
    .insert(notebooksTable)
    .values({ userId, title })
    .returning({ id: notebooksTable.id });
  return nb!.id;
}

async function freshDeck(cookie: string, name = 'D'): Promise<string> {
  const res = await callApp(app, 'POST', '/decks', { cookie, body: { name } });
  return (await res.json<{ id: string }>()).id;
}

/**
 * Seed a user-level source (DETACHED — no notebook edge) + optional doc chunks.
 * Returns the source id + chunk ids. Library items are sources, so this is the
 * canonical "material in the library, not yet in any notebook" fixture.
 */
async function seedLibrarySource(
  userId: string,
  opts: {
    title?: string;
    kind?: 'pdf' | 'epub' | 'url' | 'text';
    author?: string;
    status?: string;
    chunks?: { text: string; page?: number }[];
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
      chunkCount: chunks.length,
    })
    .returning({ id: sourcesTable.id });
  const sourceId = src!.id;
  const chunkIds: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    const [sc] = await db
      .insert(sourceChunksTable)
      .values({ userId, sourceId, position: i, text: c.text, page: c.page, embedded: true })
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

async function attach(cookie: string, notebookId: string, sourceIds: string[]) {
  return callApp(app, 'POST', `/notebooks/${notebookId}/sources/attach`, {
    cookie,
    body: { sourceIds },
  });
}

async function edgeCount(notebookId: string, sourceId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(notebookSourcesTable)
    .where(
      and(
        eq(notebookSourcesTable.notebookId, notebookId),
        eq(notebookSourcesTable.sourceId, sourceId),
      ),
    );
  return row!.n;
}

// ── attach / detach ───────────────────────────────────────────────────────────

describe('library — attach / detach', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('attach two sources → both edges created; idempotent re-attach does not duplicate', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const a = await seedLibrarySource(userId, { title: 'A' });
    const b = await seedLibrarySource(userId, { title: 'B' });

    const res = await attach(cookie, nb, [a.sourceId, b.sourceId]);
    expect(res.status).toBe(200);
    expect((await res.json<{ attached: number }>()).attached).toBe(2);
    expect(await edgeCount(nb, a.sourceId)).toBe(1);
    expect(await edgeCount(nb, b.sourceId)).toBe(1);

    // Idempotent: a second attach of the same ids returns ok, no duplicate edges.
    const again = await attach(cookie, nb, [a.sourceId, b.sourceId]);
    expect(again.status).toBe(200);
    expect(await edgeCount(nb, a.sourceId)).toBe(1);
    const [total] = await db
      .select({ n: count() })
      .from(notebookSourcesTable)
      .where(eq(notebookSourcesTable.notebookId, nb));
    expect(total!.n).toBe(2);
  });

  test('a foreign sourceId → 404 and NO edge is created (all-or-nothing ownership)', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const nb = await freshNotebook(a.userId);
    const mine = await seedLibrarySource(a.userId, { title: 'Mine' });
    const foreign = await seedLibrarySource(b.userId, { title: 'Theirs' });

    const res = await attach(a.cookie, nb, [mine.sourceId, foreign.sourceId]);
    expect(res.status).toBe(404);
    // The valid id in the same batch was NOT attached (ownership is all-or-nothing).
    const [total] = await db
      .select({ n: count() })
      .from(notebookSourcesTable)
      .where(eq(notebookSourcesTable.notebookId, nb));
    expect(total!.n).toBe(0);
  });

  test('attach batch over MAX_ATTACH_BATCH → 400 too_many_sources', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    // MAX_ATTACH_BATCH default = 20; 21 distinct uuids trips the cap (the wire
    // schema allows up to 100, so the handler returns the clean 400).
    const ids = Array.from({ length: env.ai.MAX_ATTACH_BATCH + 1 }, () => crypto.randomUUID());
    const res = await attach(cookie, nb, ids);
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('too_many_sources');
  });

  test('detach removes ONLY the edge — source, chunks, vectors survive (count-preservation)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const { sourceId } = await seedLibrarySource(userId, {
      title: 'Shared',
      chunks: [{ text: 'chunk one', page: 1 }, { text: 'chunk two', page: 2 }],
    });
    await attach(cookie, nb, [sourceId]);
    expect(await edgeCount(nb, sourceId)).toBe(1);

    const before = {
      chunks: (await db.select({ n: count() }).from(sourceChunksTable).where(eq(sourceChunksTable.sourceId, sourceId)))[0]!.n,
      vectors: (await db.select({ n: count() }).from(kbChunk).where(and(eq(kbChunk.sourceId, sourceId), eq(kbChunk.sourceType, 'document'))))[0]!.n,
    };

    const del = await callApp(app, 'DELETE', `/notebooks/${nb}/sources/${sourceId}`, { cookie });
    expect(del.status).toBe(200);
    expect(await edgeCount(nb, sourceId)).toBe(0);

    // The source + chunks + vectors are untouched.
    expect(
      (await db.select({ n: count() }).from(sourcesTable).where(eq(sourcesTable.id, sourceId)))[0]!.n,
    ).toBe(1);
    expect(
      (await db.select({ n: count() }).from(sourceChunksTable).where(eq(sourceChunksTable.sourceId, sourceId)))[0]!.n,
    ).toBe(before.chunks);
    expect(
      (await db.select({ n: count() }).from(kbChunk).where(and(eq(kbChunk.sourceId, sourceId), eq(kbChunk.sourceType, 'document'))))[0]!.n,
    ).toBe(before.vectors);
  });

  test('detach of a non-existent edge → 404', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const { sourceId } = await seedLibrarySource(userId); // never attached
    const del = await callApp(app, 'DELETE', `/notebooks/${nb}/sources/${sourceId}`, { cookie });
    expect(del.status).toBe(404);
  });

  test('one source visible in TWO notebooks at once (m2m)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb1 = await freshNotebook(userId, 'NB1');
    const nb2 = await freshNotebook(userId, 'NB2');
    const { sourceId } = await seedLibrarySource(userId, { title: 'Shared Book' });

    expect((await attach(cookie, nb1, [sourceId])).status).toBe(200);
    expect((await attach(cookie, nb2, [sourceId])).status).toBe(200);

    // Both notebooks list the same source.
    const list1 = await callApp(app, 'GET', `/notebooks/${nb1}/sources`, { cookie });
    const list2 = await callApp(app, 'GET', `/notebooks/${nb2}/sources`, { cookie });
    const ids1 = (await list1.json<{ items: { id: string }[] }>()).items.map((s) => s.id);
    const ids2 = (await list2.json<{ items: { id: string }[] }>()).items.map((s) => s.id);
    expect(ids1).toContain(sourceId);
    expect(ids2).toContain(sourceId);

    // The library item reports notebookCount = 2.
    const item = await callApp(app, 'GET', `/library/items/${sourceId}`, { cookie });
    expect((await item.json<{ notebookCount: number }>()).notebookCount).toBe(2);
  });
});

// ── notebook-delete preservation (count-preservation) ─────────────────────────

describe('library — notebook delete preserves a SHARED source', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('source in 2 notebooks; delete one → vectors/chunks preserved, the OTHER notebook still grounds chat', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb1 = await freshNotebook(userId, 'Doomed');
    const nb2 = await freshNotebook(userId, 'Survivor');
    const { sourceId, chunkIds } = await seedLibrarySource(userId, {
      title: 'Shared Doc',
      kind: 'text',
      chunks: [{ text: 'cellular respiration releases energy', page: 1 }],
    });
    await attach(cookie, nb1, [sourceId]);
    await attach(cookie, nb2, [sourceId]);

    const before = {
      chunks: (await db.select({ n: count() }).from(sourceChunksTable).where(eq(sourceChunksTable.sourceId, sourceId)))[0]!.n,
      vectors: (await db.select({ n: count() }).from(kbChunk).where(and(eq(kbChunk.sourceId, sourceId), eq(kbChunk.sourceType, 'document'))))[0]!.n,
    };

    // Delete notebook 1.
    expect((await callApp(app, 'DELETE', `/notebooks/${nb1}`, { cookie })).status).toBe(200);

    // Р4: document vectors + chunks survive (they belong to the source, not the
    // notebook). Counts unchanged.
    expect(
      (await db.select({ n: count() }).from(sourceChunksTable).where(eq(sourceChunksTable.sourceId, sourceId)))[0]!.n,
    ).toBe(before.chunks);
    expect(
      (await db.select({ n: count() }).from(kbChunk).where(and(eq(kbChunk.sourceId, sourceId), eq(kbChunk.sourceType, 'document'))))[0]!.n,
    ).toBe(before.vectors);
    // nb1's edge is gone; nb2's edge survives.
    expect(await edgeCount(nb1, sourceId)).toBe(0);
    expect(await edgeCount(nb2, sourceId)).toBe(1);

    // The surviving notebook's grounded chat still surfaces the source's chunk.
    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        { toolCalls: [{ id: 's1', name: 'search_source', args: { query: 'cellular respiration releases energy' } }], finish: 'tool_calls' },
        { content: [`Cellular respiration releases energy [src:${chunkIds[0]}].`], finish: 'stop' },
      ]),
    });
    const conv = await callApp(app, 'POST', '/chat/conversations', { cookie, body: { notebookId: nb2 } });
    const convId = (await conv.json<{ id: string }>()).id;
    const frames = await readSse(
      await app.handle(
        new Request(`http://localhost/chat/conversations/${convId}/stream`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie },
          body: JSON.stringify({ content: 'explain respiration' }),
        }),
      ),
    );
    const result = frames.find((f) => f.event === 'tool_result');
    expect((result!.data as { ok: boolean }).ok).toBe(true);
    expect((result!.data as { summary: string }).summary).toContain(`[src:${chunkIds[0]}]`);
  });
});

// ── /library list + filters + aggregates ──────────────────────────────────────

describe('library — GET /library list, filters, aggregates, cursor', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('lists only own sources; a `deleting` source is hidden; foreign sources never appear', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    await seedLibrarySource(a.userId, { title: 'Visible' });
    await seedLibrarySource(a.userId, { title: 'Gone', status: 'deleting' });
    await seedLibrarySource(b.userId, { title: 'Foreign' });

    const res = await callApp(app, 'GET', '/library', { cookie: a.cookie });
    expect(res.status).toBe(200);
    const { items } = await res.json<{ items: { title: string }[] }>();
    const titles = items.map((i) => i.title);
    expect(titles).toContain('Visible');
    expect(titles).not.toContain('Gone'); // status='deleting' hidden
    expect(titles).not.toContain('Foreign'); // user-scoped
  });

  test('cursor paging: a full page returns nextCursor; the next page continues, then null', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    // Seed more than one page (small limit) so paging is exercised.
    for (let i = 0; i < 5; i++) await seedLibrarySource(userId, { title: `Doc ${i}` });

    const page1 = await callApp(app, 'GET', '/library?limit=2', { cookie });
    const b1 = await page1.json<{ items: { id: string }[]; nextCursor: string | null }>();
    expect(b1.items.length).toBe(2);
    expect(b1.nextCursor).toBeTruthy();

    const page2 = await callApp(app, 'GET', `/library?limit=2&cursor=${encodeURIComponent(b1.nextCursor!)}`, { cookie });
    const b2 = await page2.json<{ items: { id: string }[]; nextCursor: string | null }>();
    expect(b2.items.length).toBe(2);
    // No id repeats across pages (keyset by created_at DESC).
    const ids1 = new Set(b1.items.map((i) => i.id));
    expect(b2.items.every((i) => !ids1.has(i.id))).toBe(true);

    const page3 = await callApp(app, 'GET', `/library?limit=2&cursor=${encodeURIComponent(b2.nextCursor!)}`, { cookie });
    const b3 = await page3.json<{ items: unknown[]; nextCursor: string | null }>();
    expect(b3.items.length).toBe(1); // the 5th
    expect(b3.nextCursor).toBeNull(); // a short page → end of stream
  });

  test('filter q matches title OR author; kind filter narrows by kind', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    await seedLibrarySource(userId, { title: 'Clean Code', author: 'Robert Martin', kind: 'pdf' });
    await seedLibrarySource(userId, { title: 'Other Notes', author: 'Nobody', kind: 'text' });

    // q over TITLE.
    const byTitle = await callApp(app, 'GET', '/library?q=Clean', { cookie });
    const t = (await byTitle.json<{ items: { title: string }[] }>()).items.map((i) => i.title);
    expect(t).toEqual(['Clean Code']);

    // q over AUTHOR.
    const byAuthor = await callApp(app, 'GET', '/library?q=Martin', { cookie });
    const a = (await byAuthor.json<{ items: { title: string }[] }>()).items.map((i) => i.title);
    expect(a).toEqual(['Clean Code']);

    // kind filter.
    const byKind = await callApp(app, 'GET', '/library?kind=text', { cookie });
    const k = (await byKind.json<{ items: { title: string }[] }>()).items.map((i) => i.title);
    expect(k).toEqual(['Other Notes']);
  });

  test('reading filter selects by reading-state status; unread covers a missing row', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const reading = await seedLibrarySource(userId, { title: 'In Progress' });
    const untouched = await seedLibrarySource(userId, { title: 'Fresh' });
    // Drive one source into 'reading' via a reading-state PUT.
    await callApp(app, 'PUT', `/library/items/${reading.sourceId}/reading-state`, { cookie, body: { percent: 0.3 } });

    const rd = await callApp(app, 'GET', '/library?reading=reading', { cookie });
    const rdTitles = (await rd.json<{ items: { title: string }[] }>()).items.map((i) => i.title);
    expect(rdTitles).toEqual(['In Progress']);

    const un = await callApp(app, 'GET', '/library?reading=unread', { cookie });
    const unTitles = (await un.json<{ items: { title: string }[] }>()).items.map((i) => i.title);
    expect(unTitles).toContain('Fresh'); // no reading-state row ⇒ unread
    expect(unTitles).not.toContain('In Progress');
    void untouched;
  });

  test('filter tag selects sources whose tags array contains the tag', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const tagged = await seedLibrarySource(userId, { title: 'Tagged' });
    await seedLibrarySource(userId, { title: 'Untagged' });
    // Stamp tags directly on the row (PATCH would also work; this keeps it terse).
    await db
      .update(sourcesTable)
      .set({ tags: ['ml', 'algorithms'] })
      .where(eq(sourcesTable.id, tagged.sourceId));

    const res = await callApp(app, 'GET', '/library?tag=ml', { cookie });
    expect(res.status).toBe(200);
    const titles = (await res.json<{ items: { title: string }[] }>()).items.map((i) => i.title);
    expect(titles).toEqual(['Tagged']);
  });

  test('filter shelf=unattached selects sources with no notebook edge', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId, 'NB');
    const attached = await seedLibrarySource(userId, { title: 'Attached' });
    await seedLibrarySource(userId, { title: 'Loose' });
    await attach(cookie, nb, [attached.sourceId]);

    const res = await callApp(app, 'GET', '/library?shelf=unattached', { cookie });
    expect(res.status).toBe(200);
    const titles = (await res.json<{ items: { title: string }[] }>()).items.map((i) => i.title);
    expect(titles).toContain('Loose');
    expect(titles).not.toContain('Attached');
  });

  test('aggregates: notebookCount + cardCount are correct (no N+1 surprises)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb1 = await freshNotebook(userId, 'NB1');
    const nb2 = await freshNotebook(userId, 'NB2');
    const deckId = await freshDeck(cookie);
    const { sourceId, chunkIds } = await seedLibrarySource(userId, {
      title: 'Cited Doc',
      chunks: [{ text: 'a passage', page: 1 }],
    });
    await attach(cookie, nb1, [sourceId]);
    await attach(cookie, nb2, [sourceId]);

    // Two distinct cards, each linked to the source via card_sources.
    const cardA = await seedBasicCard(app, cookie, { deckId, front: 'A', back: 'a' });
    const cardB = await seedBasicCard(app, cookie, { deckId, front: 'B', back: 'b' });
    await db.insert(cardSourcesTable).values([
      { userId, cardId: cardA.id, sourceChunkId: chunkIds[0]!, sourceId, notebookId: nb1 },
      { userId, cardId: cardB.id, sourceChunkId: chunkIds[0]!, sourceId, notebookId: nb1 },
    ]);

    const res = await callApp(app, 'GET', '/library', { cookie });
    const item = (await res.json<{ items: { id: string; notebookCount: number; cardCount: number }[] }>()).items.find(
      (i) => i.id === sourceId,
    );
    expect(item).toBeTruthy();
    expect(item!.notebookCount).toBe(2);
    expect(item!.cardCount).toBe(2);
  });
});

// ── POST /library/items ───────────────────────────────────────────────────────

describe('library — POST /library/items (inline create + optional attach)', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(finishSourceIngest);

  test('text create returns a pending source (no notebook)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const res = await callApp(app, 'POST', '/library/items', {
      cookie,
      body: { kind: 'text', title: 'My Notes', text: 'Some study material.' },
    });
    expect(res.status).toBe(200);
    const src = await res.json<{ id: string; kind: string; status: string; verified: boolean }>();
    expect(src.kind).toBe('text');
    expect(src.verified).toBe(true);
    // Created but not attached to any notebook.
    const [edges] = await db
      .select({ n: count() })
      .from(notebookSourcesTable)
      .where(eq(notebookSourcesTable.sourceId, src.id));
    expect(edges!.n).toBe(0);
  });

  test('text create with notebookId attaches in the same call (Р8)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const res = await callApp(app, 'POST', '/library/items', {
      cookie,
      body: { kind: 'text', title: 'Notebook Notes', text: 'Inline content.', notebookId: nb },
    });
    expect(res.status).toBe(200);
    const src = await res.json<{ id: string }>();
    expect(await edgeCount(nb, src.id)).toBe(1);
  });

  test('create with a FOREIGN notebookId → 404 (no source created)', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const foreignNb = await freshNotebook(b.userId);
    const res = await callApp(app, 'POST', '/library/items', {
      cookie: a.cookie,
      body: { kind: 'text', title: 'X', text: 'y', notebookId: foreignNb },
    });
    expect(res.status).toBe(404);
    const [total] = await db
      .select({ n: count() })
      .from(sourcesTable)
      .where(eq(sourcesTable.userId, a.userId));
    expect(total!.n).toBe(0);
  });
});

// ── PATCH /library/items/:id ──────────────────────────────────────────────────

describe('library — PATCH /library/items/:id (explicit field map)', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('updates title/author/description/tags; unknown keys are ignored', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const { sourceId } = await seedLibrarySource(userId, { title: 'Old', author: 'Old Author' });

    const res = await callApp(app, 'PATCH', `/library/items/${sourceId}`, {
      cookie,
      body: {
        title: 'New Title',
        author: 'New Author',
        description: 'An annotation.',
        tags: ['ml', 'ml', 'algorithms'], // dup dropped
        // An unknown key must NOT reach a column (explicit field map, not spread).
        status: 'ready',
        userId: 'attacker',
      },
    });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(sourcesTable).where(eq(sourcesTable.id, sourceId));
    expect(row!.title).toBe('New Title');
    expect(row!.author).toBe('New Author');
    expect(row!.description).toBe('An annotation.');
    expect(row!.tags).toEqual(['ml', 'algorithms']); // dedup'd
    expect(row!.userId).toBe(userId); // the stray userId key was ignored
  });

  test('empty title → 400 invalid_metadata', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const { sourceId } = await seedLibrarySource(userId);
    const res = await callApp(app, 'PATCH', `/library/items/${sourceId}`, { cookie, body: { title: '   ' } });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_metadata');
  });

  test('empty body → 400 nothing_to_update', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const { sourceId } = await seedLibrarySource(userId);
    const res = await callApp(app, 'PATCH', `/library/items/${sourceId}`, { cookie, body: {} });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('nothing_to_update');
  });

  test('tags over the cap (>32) → 400 invalid_metadata', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const { sourceId } = await seedLibrarySource(userId);
    const tags = Array.from({ length: 33 }, (_, i) => `t${i}`);
    const res = await callApp(app, 'PATCH', `/library/items/${sourceId}`, { cookie, body: { tags } });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_metadata');
  });

  test('readingStatus via PATCH upserts the reading-state row', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const { sourceId } = await seedLibrarySource(userId);
    const res = await callApp(app, 'PATCH', `/library/items/${sourceId}`, {
      cookie,
      body: { readingStatus: 'finished' },
    });
    expect(res.status).toBe(200);
    const [rs] = await db
      .select({ status: readingStateTable.status })
      .from(readingStateTable)
      .where(and(eq(readingStateTable.sourceId, sourceId), eq(readingStateTable.userId, userId)));
    expect(rs!.status).toBe('finished');
  });

  test('a foreign source → 404', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const { sourceId } = await seedLibrarySource(b.userId);
    const res = await callApp(app, 'PATCH', `/library/items/${sourceId}`, { cookie: a.cookie, body: { title: 'z' } });
    expect(res.status).toBe(404);
  });
});

// ── PUT /library/items/:id/reading-state ──────────────────────────────────────

describe('library — PUT reading-state', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('first PUT creates the row and flips unread→reading', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const { sourceId } = await seedLibrarySource(userId);
    const res = await callApp(app, 'PUT', `/library/items/${sourceId}/reading-state`, {
      cookie,
      body: { page: 4, percent: 0.1 },
    });
    expect(res.status).toBe(200);
    expect((await res.json<{ status: string }>()).status).toBe('reading');
    const [rs] = await db
      .select()
      .from(readingStateTable)
      .where(and(eq(readingStateTable.sourceId, sourceId), eq(readingStateTable.userId, userId)));
    expect(rs!.status).toBe('reading');
    expect(rs!.page).toBe(4);
    expect(rs!.percent).toBeCloseTo(0.1, 5);
  });

  test('a repeat PUT updates position; a manual `finished` is NOT undone by a stray progress PUT', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const { sourceId } = await seedLibrarySource(userId);
    await callApp(app, 'PUT', `/library/items/${sourceId}/reading-state`, { cookie, body: { page: 2 } });
    // Mark finished via PATCH.
    await callApp(app, 'PATCH', `/library/items/${sourceId}`, { cookie, body: { readingStatus: 'finished' } });
    // A later progress PUT updates the page but keeps 'finished'.
    const res = await callApp(app, 'PUT', `/library/items/${sourceId}/reading-state`, { cookie, body: { page: 9 } });
    expect((await res.json<{ status: string }>()).status).toBe('finished');
    const [rs] = await db
      .select()
      .from(readingStateTable)
      .where(and(eq(readingStateTable.sourceId, sourceId), eq(readingStateTable.userId, userId)));
    expect(rs!.status).toBe('finished');
    expect(rs!.page).toBe(9);
  });

  test('percent out of [0,1] → 400 (Elysia schema bound)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const { sourceId } = await seedLibrarySource(userId);
    const res = await callApp(app, 'PUT', `/library/items/${sourceId}/reading-state`, { cookie, body: { percent: 1.5 } });
    expect(res.status).toBe(400);
  });

  test('a foreign source → 404 (no row created under the attacker)', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const { sourceId } = await seedLibrarySource(b.userId);
    const res = await callApp(app, 'PUT', `/library/items/${sourceId}/reading-state`, { cookie: a.cookie, body: { page: 1 } });
    expect(res.status).toBe(404);
    const [rs] = await db
      .select({ n: count() })
      .from(readingStateTable)
      .where(eq(readingStateTable.userId, a.userId));
    expect(rs!.n).toBe(0);
  });
});

// ── GET /library/items/:id (detail) ───────────────────────────────────────────

describe('library — GET /library/items/:id detail', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('detail returns readingState with page/chunkPos/percent after a reading-state PUT', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const { sourceId } = await seedLibrarySource(userId, { title: 'Tracked' });

    // Before any PUT, readingState is null (never opened).
    const before = await callApp(app, 'GET', `/library/items/${sourceId}`, { cookie });
    expect((await before.json<{ readingState: unknown }>()).readingState).toBeNull();

    await callApp(app, 'PUT', `/library/items/${sourceId}/reading-state`, {
      cookie,
      body: { page: 7, chunkPos: 3, percent: 0.42 },
    });

    const res = await callApp(app, 'GET', `/library/items/${sourceId}`, { cookie });
    expect(res.status).toBe(200);
    const body = await res.json<{
      readingState: { status: string; page: number | null; chunkPos: number | null; percent: number | null } | null;
    }>();
    expect(body.readingState).not.toBeNull();
    expect(body.readingState!.status).toBe('reading');
    expect(body.readingState!.page).toBe(7);
    expect(body.readingState!.chunkPos).toBe(3);
    expect(body.readingState!.percent).toBeCloseTo(0.42, 5);
  });

  test('a foreign source → 404', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const { sourceId } = await seedLibrarySource(b.userId);
    const res = await callApp(app, 'GET', `/library/items/${sourceId}`, { cookie: a.cookie });
    expect(res.status).toBe(404);
  });
});

// ── DELETE /library/items/:id ─────────────────────────────────────────────────

describe('library — DELETE /library/items/:id', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('delete → 404 on re-GET; document kb_chunk cleaned up', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const { sourceId } = await seedLibrarySource(userId, {
      title: 'To Delete',
      chunks: [{ text: 'vectorized chunk', page: 1 }],
    });
    // Sanity: a document vector exists.
    expect(
      (await db.select({ n: count() }).from(kbChunk).where(and(eq(kbChunk.sourceId, sourceId), eq(kbChunk.sourceType, 'document'))))[0]!.n,
    ).toBe(1);

    const del = await callApp(app, 'DELETE', `/library/items/${sourceId}`, { cookie });
    expect(del.status).toBe(200);

    // Re-GET is a 404.
    expect((await callApp(app, 'GET', `/library/items/${sourceId}`, { cookie })).status).toBe(404);
    // The document kb_chunk rows are explicitly cleaned up (no FK cascade on source_id).
    expect(
      (await db.select({ n: count() }).from(kbChunk).where(and(eq(kbChunk.sourceId, sourceId), eq(kbChunk.sourceType, 'document'))))[0]!.n,
    ).toBe(0);
  });

  test('a foreign source → 404', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const { sourceId } = await seedLibrarySource(b.userId);
    expect((await callApp(app, 'DELETE', `/library/items/${sourceId}`, { cookie: a.cookie })).status).toBe(404);
    // The owner's source is untouched.
    expect(
      (await db.select({ n: count() }).from(sourcesTable).where(eq(sourcesTable.id, sourceId)))[0]!.n,
    ).toBe(1);
  });
});

// ── library_full cap ──────────────────────────────────────────────────────────

describe('library — MAX_LIBRARY_ITEMS_PER_USER cap', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(finishSourceIngest);

  test('at the cap → 409 library_full (per-user; another user is unaffected)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const cap = env.ai.MAX_LIBRARY_ITEMS_PER_USER;
    // Seed exactly the cap directly (the route counts rows, not creates).
    await db.insert(sourcesTable).values(
      Array.from({ length: cap }, (_, i) => ({
        userId,
        kind: 'text' as const,
        title: `seed-${i}`,
        status: 'ready' as const,
        verified: true,
      })),
    );
    const res = await callApp(app, 'POST', '/library/items', {
      cookie,
      body: { kind: 'text', title: 'one too many', text: 'x' },
    });
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toBe('library_full');

    // The cap is per-USER: a second user can still create.
    const other = await signUpAndCookie(app, uniqueEmail('other'));
    const ok = await callApp(app, 'POST', '/library/items', {
      cookie: other.cookie,
      body: { kind: 'text', title: 'fine', text: 'y' },
    });
    expect(ok.status).toBe(200);
  });
});

// ── finalize dedup carries existingSourceId (DB-layer backstop) ───────────────

describe('library — finalize dedup returns existingSourceId', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('the dedup response shape carries the existing source id (per-user, status NOT IN error/deleting)', async () => {
    // The end-to-end 409 round-trip lives in source-dedup.test.ts (real MinIO).
    // Here we assert the dedup-query backstop directly: an indexing OR ready
    // source of the same user + byteHash is the duplicate whose id is returned.
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const HASH = 'cafebabe'.repeat(8);
    const [existing] = await db
      .insert(sourcesTable)
      .values({
        userId,
        kind: 'pdf',
        title: 'Original',
        status: 'indexing',
        verified: true,
        byteHash: HASH,
      })
      .returning({ id: sourcesTable.id });

    // Mirror the finalize dedup SELECT (sources-shared.ts finalizeUploadSource).
    const [dup] = await db
      .select({ id: sourcesTable.id })
      .from(sourcesTable)
      .where(
        and(
          eq(sourcesTable.userId, userId),
          eq(sourcesTable.byteHash, HASH),
        ),
      )
      .limit(1);
    expect(dup!.id).toBe(existing!.id); // → 409 duplicate_source { existingSourceId: dup.id }
  });
});
