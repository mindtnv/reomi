// NotebookLM M2 — grounded notebook chat integration tests.
//
// CONTRACT (read from the implementation, NOT invented):
//   * POST /chat/conversations { notebookId } — owned ⇒ the row binds notebookId;
//     a foreign/missing notebookId ⇒ 404 pre-insert (ai.ts POST /conversations).
//   * GET  /chat/conversations — default lists every owned thread;
//     `?scope=global` retains legacy global-only listing; `?notebookId=<owned>` lists that notebook's
//     threads; a foreign notebookId 404s (never leaks foreign threads).
//   * A NOTEBOOK turn (conversation bound to a notebook) runs the narrow
//     source-grounded registry: `search_source` retrieves over the notebook's
//     ready source chunks (`retrieveDocuments`), renders `[src:<sourceChunkId>]`
//     passages + a SourceCitation[] (kind:'source', sourceChunkId/position), and
//     the turn-level `citation` frame intersects to the `[src:]` tokens the
//     answer emitted. `read_source` reads sequentially; a foreign sourceId is a
//     self-correcting error (ok:false, lists valid sources) and the loop continues.
//   * Scope: body `sourceIds` is INTERSECTED with the notebook's ready sources
//     (foreign ids dropped, the conversation's notebook is the authority); a
//     non-ready source is excluded; sourceIds:[] ⇒ empty scope (no hits).
//   * Registry shape: in notebook mode `search_cards` is NOT offered (the model
//     calling it gets an unknown-tool error, never executed); `web_search` is
//     present only when web search is enabled.
//   * System prompt: a notebook turn's prompt mentions source grounding + `[src:`
//     + the notebook title; a global turn's prompt has no source section.
//   * GET /sources/:id/chunks: paging (from/limit/nextFrom/total), 404 foreign,
//     ordered by position.
//
// Harness mirrors agent-chat.test.ts / agent-confirm.test.ts: NODE_ENV=test
// forces the real AI flags off; injecting `chatStreamAgentic` flips chat on. A
// scripted fake AI client scripts the model's tool_calls turns; SSE frames are
// parsed by a small reader. Document fixtures (notebook/source/source_chunks +
// kb_chunk document rows) are inserted DIRECTLY via db — the chunk embedding is
// `vectorFor(chunkText)` and the fake `embed(query)` returns `vectorFor(query)`,
// so a search whose query EQUALS a chunk's text ranks that chunk at cosine 1.0.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  db,
  kbChunk,
  notebooks as notebooksTable,
  notebookSources as notebookSourcesTable,
  sourceChunks as sourceChunksTable,
  sources as sourcesTable,
} from '@reomi/db';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import {
  __resetAiClientForTests,
  __setAiClientForTests,
  type AgentChatMessage,
  type AgentStreamChunk,
} from '../src/ai/openai-client.ts';
import { __setWebSearchProviderForTests } from '../src/ai/web-search.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();
const EMBED_DIM = 1536;

// Deterministic text→vector (same hash-scatter as the other RAG tests): the same
// text always yields the same vector, so embedding a chunk's exact text and then
// querying with that exact text yields cosine 1.0 (≥ RETRIEVE_MIN_SCORE).
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

// ── Scripted agentic fake (one turn per `chatStreamAgentic` call) ─────────────

interface ToolCallScript {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
interface AgentTurn {
  content?: string[];
  toolCalls?: ToolCallScript[];
  finish: 'stop' | 'tool_calls';
}
function answerTurn(text: string): AgentTurn {
  return { content: [text], finish: 'stop' };
}
function searchTurn(calls: ToolCallScript[]): AgentTurn {
  return { toolCalls: calls, finish: 'tool_calls' };
}

/** Captured `messages[]` of every `chatStreamAgentic` call (for prompt asserts). */
let capturedAgentMessages: AgentChatMessage[][] = [];

function scriptedAgentStream(script: AgentTurn[]) {
  let call = 0;
  return async function* (messages: AgentChatMessage[]): AsyncIterable<AgentStreamChunk> {
    capturedAgentMessages.push(messages);
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

// ── SSE reader (mirrors the other chat suites) ────────────────────────────────

interface SseFrame {
  event: string;
  data: unknown;
}
async function readSse(res: Response): Promise<SseFrame[]> {
  expect(res.headers.get('content-type')).toContain('text/event-stream');
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

function streamReq(
  cookie: string,
  convId: string,
  content: string,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/chat/conversations/${convId}/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ content, ...extra }),
    }),
  );
}

// ── Fixture helpers (direct DB inserts — mirror source-ingest.test.ts) ─────────

async function freshNotebook(userId: string, title = 'My Notebook'): Promise<string> {
  const [nb] = await db
    .insert(notebooksTable)
    .values({ userId, title })
    .returning({ id: notebooksTable.id });
  return nb!.id;
}

/**
 * Seed a READY user-level source with `chunks` document chunks + attach it to the
 * notebook via the join edge. Inserts the source row, the notebook_sources edge,
 * the source_chunks SoT rows, AND the denormalized kb_chunk document rows (the
 * embedding = vectorFor(chunk.text), matching the AC7 seam tuple:
 * source_type='document', source_id=source.id, parent_id=source.id (library
 * refactor), card_id=NULL, position aligned with source_chunks.position). Returns
 * the source id + the source_chunk ids (in position order).
 */
async function seedReadySource(
  userId: string,
  notebookId: string,
  title: string,
  chunks: { text: string; page?: number; heading?: string }[],
  status: 'ready' | 'indexing' | 'pending' | 'error' = 'ready',
): Promise<{ sourceId: string; chunkIds: string[] }> {
  const [src] = await db
    .insert(sourcesTable)
    .values({
      userId,
      kind: 'text',
      title,
      status,
      verified: true,
      chunkCount: chunks.length,
    })
    .returning({ id: sourcesTable.id });
  const sourceId = src!.id;
  // Library refactor: a source is user-level; the notebook binding is an edge.
  await db.insert(notebookSourcesTable).values({ userId, notebookId, sourceId });
  const chunkIds: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    const [sc] = await db
      .insert(sourceChunksTable)
      .values({
        userId,
        sourceId,
        position: i,
        text: c.text,
        page: c.page,
        heading: c.heading,
        embedded: true,
      })
      .returning({ id: sourceChunksTable.id });
    chunkIds.push(sc!.id);
    await db.insert(kbChunk).values({
      userId,
      sourceType: 'document',
      sourceId,
      // parentId = sourceId for documents (library refactor — kb-chunk.ts:13).
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

async function createConversation(
  cookie: string,
  body: Record<string, unknown> = {},
): Promise<Response> {
  return app.handle(
    new Request('http://localhost/chat/conversations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    }),
  );
}

/** Names of tools the loop actually executed, from the SSE `tool_call` frames. */
function executedTools(frames: SseFrame[]): string[] {
  return frames
    .filter((f) => f.event === 'tool_call')
    .map((f) => (f.data as { name: string }).name);
}

describe('notebook chat — conversation binding + list filter', () => {
  beforeEach(async () => {
    await resetTestDb();
    capturedAgentMessages = [];
  });
  afterEach(() => {
    __resetAiClientForTests();
    __setWebSearchProviderForTests(null);
  });

  test('POST /chat/conversations with an owned notebookId binds the row; foreign 404s', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId);

    const res = await createConversation(cookie, { notebookId });
    expect(res.status).toBe(200);
    const conv = await res.json<{ id: string; notebookId: string | null }>();
    expect(conv.notebookId).toBe(notebookId);

    // Foreign notebook (another user's) → 404, no row created.
    const other = await signUpAndCookie(app, uniqueEmail('b'));
    const foreignNb = await freshNotebook(other.userId);
    const foreign = await createConversation(cookie, { notebookId: foreignNb });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: 'not_found' });

    // A random non-existent uuid → 404 too.
    const missing = await createConversation(cookie, {
      notebookId: '00000000-0000-4000-8000-000000000000',
    });
    expect(missing.status).toBe(404);
  });

  test('GET /chat/conversations: unified default, legacy global filter, notebook filter and foreign 404', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nbA = await freshNotebook(userId, 'A');
    const nbB = await freshNotebook(userId, 'B');

    // One global thread, one in A, one in B.
    const globalConv = await (await createConversation(cookie, {})).json<{ id: string }>();
    const convA = await (await createConversation(cookie, { notebookId: nbA })).json<{ id: string }>();
    const convB = await (await createConversation(cookie, { notebookId: nbB })).json<{ id: string }>();

    // Unified rail includes notebook history without copying conversations.
    const def = await callApp(app, 'GET', '/chat/conversations', { cookie });
    expect(def.status).toBe(200);
    const defItems = (await def.json<{ items: { id: string; notebookId: string | null }[] }>()).items;
    const defIds = defItems.map((c) => c.id);
    expect(defIds).toContain(globalConv.id);
    expect(defIds).toContain(convA.id);
    expect(defIds).toContain(convB.id);
    expect(defIds).toHaveLength(3);
    const legacy = await callApp(app, 'GET', '/chat/conversations?scope=global', { cookie });
    expect((await legacy.json<{ items: { id: string }[] }>()).items.map(c => c.id)).toEqual([globalConv.id]);

    // ?notebookId=A: ONLY A's thread.
    const aRes = await callApp(app, 'GET', `/chat/conversations?notebookId=${nbA}`, { cookie });
    expect(aRes.status).toBe(200);
    const aItems = (await aRes.json<{ items: { id: string; notebookId: string }[] }>()).items;
    expect(aItems.map((c) => c.id)).toEqual([convA.id]);
    expect(aItems[0]!.notebookId).toBe(nbA);

    // Foreign notebookId (another user's) → 404, never leaks the foreign threads.
    const other = await signUpAndCookie(app, uniqueEmail('b'));
    const foreignNb = await freshNotebook(other.userId);
    const foreign = await callApp(app, 'GET', `/chat/conversations?notebookId=${foreignNb}`, {
      cookie,
    });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: 'not_found' });
  });
});

describe('notebook chat — search_source grounding + citations', () => {
  beforeEach(async () => {
    await resetTestDb();
    capturedAgentMessages = [];
  });
  afterEach(() => {
    __resetAiClientForTests();
    __setWebSearchProviderForTests(null);
  });

  test('search_source: tool_result carries [src:<id>] + title; citation frame is the [src:]-token intersect', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'Physics');
    const { chunkIds } = await seedReadySource(userId, notebookId, 'Newton', [
      { text: 'gravity attracts masses', page: 3 },
      { text: 'inertia keeps motion', page: 7 },
    ]);

    // The model searches with a query EQUAL to chunk 0's text (cosine 1.0), then
    // answers citing ONLY chunk 0's [src:] token. The turn's citation set must
    // intersect to that one chunk.
    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        searchTurn([{ id: 's1', name: 'search_source', args: { query: 'gravity attracts masses' } }]),
        answerTurn(`Gravity attracts masses [src:${chunkIds[0]}].`),
      ]),
    });

    const convId = (await (await createConversation(cookie, { notebookId })).json<{ id: string }>()).id;
    const frames = await readSse(await streamReq(cookie, convId, 'what about gravity?'));

    // search_source executed and returned a useful, citable result.
    expect(executedTools(frames)).toContain('search_source');
    const result = frames.find((f) => f.event === 'tool_result');
    expect(result).toBeTruthy();
    expect((result!.data as { ok: boolean }).ok).toBe(true);
    const summary = (result!.data as { summary: string }).summary;
    expect(summary).toContain(`[src:${chunkIds[0]}]`);
    expect(summary).toContain('«Newton»'); // the source title rides the header
    expect(summary).toContain('p.3');

    // The tool_result frame carries SourceCitation[] (kind:'source').
    const resultCitations = (result!.data as { citations?: { kind: string; sourceChunkId: string }[] })
      .citations;
    expect(resultCitations).toBeTruthy();
    expect(resultCitations!.some((c) => c.kind === 'source')).toBe(true);

    // The final turn-level citation set is intersected to the ONE [src:] token the
    // answer emitted (chunk 0 only — chunk 1 was retrieved but not cited).
    const citationFrame = frames.find((f) => f.event === 'citation');
    expect(citationFrame).toBeTruthy();
    const cited = (citationFrame!.data as {
      citations: { kind: string; sourceChunkId: string; position?: number; sourceId: string }[];
    }).citations;
    expect(cited.length).toBe(1);
    expect(cited[0]!.kind).toBe('source');
    expect(cited[0]!.sourceChunkId).toBe(chunkIds[0]);
    expect(cited[0]!.position).toBe(0);
    expect(frames.some((f) => f.event === 'done')).toBe(true);
  });

  test('a source attached via the ATTACH route (not upload) is visible in the grounding scope', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'Library Notebook');
    // Seed a user-level source + its chunks but DO NOT attach it (no edge yet).
    const [src] = await db
      .insert(sourcesTable)
      .values({
        userId,
        kind: 'text',
        title: 'Library Book',
        status: 'ready',
        verified: true,
        chunkCount: 1,
      })
      .returning({ id: sourcesTable.id });
    const sourceId = src!.id;
    const [sc] = await db
      .insert(sourceChunksTable)
      .values({ userId, sourceId, position: 0, text: 'photosynthesis converts light', page: 1, embedded: true })
      .returning({ id: sourceChunksTable.id });
    const chunkId = sc!.id;
    await db.insert(kbChunk).values({
      userId,
      sourceType: 'document',
      sourceId,
      parentId: sourceId,
      position: 0,
      text: 'photosynthesis converts light',
      embedding: vectorFor('photosynthesis converts light'),
      embeddingModel: 'test-fixture',
      sourceHash: `fixture-${sourceId}-0`,
      cardId: null,
    });

    // Attach the EXISTING library source via the attach route (not an upload).
    const attach = await callApp(app, 'POST', `/notebooks/${notebookId}/sources/attach`, {
      cookie,
      body: { sourceIds: [sourceId] },
    });
    expect(attach.status).toBe(200);
    expect((await attach.json<{ attached: number }>()).attached).toBe(1);

    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        searchTurn([{ id: 's1', name: 'search_source', args: { query: 'photosynthesis converts light' } }]),
        answerTurn(`Photosynthesis converts light [src:${chunkId}].`),
      ]),
    });

    const convId = (await (await createConversation(cookie, { notebookId })).json<{ id: string }>()).id;
    const frames = await readSse(await streamReq(cookie, convId, 'how does it work?'));

    // The attached source IS in scope: search_source surfaces + cites its chunk.
    expect(executedTools(frames)).toContain('search_source');
    const result = frames.find((f) => f.event === 'tool_result');
    expect((result!.data as { ok: boolean }).ok).toBe(true);
    expect((result!.data as { summary: string }).summary).toContain(`[src:${chunkId}]`);
    const citationFrame = frames.find((f) => f.event === 'citation');
    const cited = (citationFrame!.data as { citations: { sourceChunkId: string }[] }).citations;
    expect(cited.length).toBe(1);
    expect(cited[0]!.sourceChunkId).toBe(chunkId);
  });

  test('search_source over an empty-scope notebook returns a graceful "no sources" result', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'Empty');
    // No sources at all → resolveNotebookScope yields sourceIds: [].

    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        searchTurn([{ id: 's1', name: 'search_source', args: { query: 'anything' } }]),
        answerTurn('There are no sources in this notebook yet.'),
      ]),
    });

    const convId = (await (await createConversation(cookie, { notebookId })).json<{ id: string }>()).id;
    const frames = await readSse(await streamReq(cookie, convId, 'tell me about it'));

    const result = frames.find((f) => f.event === 'tool_result');
    expect((result!.data as { ok: boolean }).ok).toBe(true);
    expect((result!.data as { summary: string }).summary.toLowerCase()).toContain('no ready sources');
    // No citations (nothing retrieved).
    const citation = frames.find((f) => f.event === 'citation');
    expect((citation!.data as { citations: unknown[] }).citations).toEqual([]);
  });
});

describe('notebook chat — read_source', () => {
  beforeEach(async () => {
    await resetTestDb();
    capturedAgentMessages = [];
  });
  afterEach(() => {
    __resetAiClientForTests();
    __setWebSearchProviderForTests(null);
  });

  test('read_source: a valid sourceId returns a slice header + [src:] passages', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'Book');
    // 5 chunks; READ_SOURCE_CHUNKS default = 3 ⇒ a slice of positions 0..2 with a
    // "continue with position=3" header.
    const { sourceId, chunkIds } = await seedReadySource(userId, notebookId, 'Manual', [
      { text: 'chapter one intro', page: 1 },
      { text: 'chapter one body', page: 2 },
      { text: 'chapter one end', page: 3 },
      { text: 'chapter two intro', page: 4 },
      { text: 'chapter two body', page: 5 },
    ]);

    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        searchTurn([{ id: 'r1', name: 'read_source', args: { sourceId, position: 0 } }]),
        answerTurn(`The manual opens with an intro [src:${chunkIds[0]}].`),
      ]),
    });

    const convId = (await (await createConversation(cookie, { notebookId })).json<{ id: string }>()).id;
    const frames = await readSse(await streamReq(cookie, convId, 'read the start'));

    expect(executedTools(frames)).toContain('read_source');
    const result = frames.find((f) => f.event === 'tool_result');
    expect((result!.data as { ok: boolean }).ok).toBe(true);
    const summary = (result!.data as { summary: string }).summary;
    expect(summary).toContain('«Manual»');
    // 5 total, slice ends at position 2, continue with position=3.
    expect(summary).toContain('of 5');
    expect(summary).toContain('continue with position=3');
    // First three chunk ids are present (READ_SOURCE_CHUNKS=3); chunk 3 is not.
    expect(summary).toContain(`[src:${chunkIds[0]}]`);
    expect(summary).toContain(`[src:${chunkIds[2]}]`);
    expect(summary).not.toContain(`[src:${chunkIds[3]}]`);
  });

  test('read_source: a foreign/unknown sourceId is a self-correcting error result (loop continues)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    await seedReadySource(userId, notebookId, 'Known Source', [{ text: 'known content' }]);

    // The model asks to read a source id that is NOT in the notebook scope.
    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        searchTurn([
          {
            id: 'r1',
            name: 'read_source',
            args: { sourceId: '11111111-1111-4111-8111-111111111111' },
          },
        ]),
        // The loop continued — the model self-corrects with an answer.
        answerTurn('I could not find that source.'),
      ]),
    });

    const convId = (await (await createConversation(cookie, { notebookId })).json<{ id: string }>()).id;
    const frames = await readSse(await streamReq(cookie, convId, 'read source X'));

    const result = frames.find((f) => f.event === 'tool_result');
    expect((result!.data as { ok: boolean }).ok).toBe(false);
    // The error lists the valid source(s) so the model can self-correct.
    expect((result!.data as { summary: string }).summary).toContain('«Known Source»');
    // The loop continued to a `done` (self-correcting, never a torn stream).
    expect(frames.some((f) => f.event === 'done')).toBe(true);
  });
});

describe('notebook chat — source scope intersect', () => {
  beforeEach(async () => {
    await resetTestDb();
    capturedAgentMessages = [];
  });
  afterEach(() => {
    __resetAiClientForTests();
    __setWebSearchProviderForTests(null);
  });

  test('body sourceIds=[one of two] restricts search_source to that source only', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'Two Sources');
    const s1 = await seedReadySource(userId, notebookId, 'Alpha', [{ text: 'alpha topic content' }]);
    const s2 = await seedReadySource(userId, notebookId, 'Beta', [{ text: 'beta topic content' }]);

    // The model searches for content that EXISTS in BOTH sources' chunk texts
    // verbatim — but with the per-turn scope pinned to Alpha only, the Beta chunk
    // must never appear. We query for Alpha's exact text (ranks Alpha chunk top),
    // and assert the cited/returned chunk is Alpha's, not Beta's.
    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        searchTurn([{ id: 's1', name: 'search_source', args: { query: 'alpha topic content' } }]),
        answerTurn(`Found it [src:${s1.chunkIds[0]}].`),
      ]),
    });

    const convId = (await (await createConversation(cookie, { notebookId })).json<{ id: string }>()).id;
    // Per-turn scope: ONLY Alpha checked in.
    const frames = await readSse(
      await streamReq(cookie, convId, 'find the topic', { sourceIds: [s1.sourceId] }),
    );

    const result = frames.find((f) => f.event === 'tool_result');
    const summary = (result!.data as { summary: string }).summary;
    expect(summary).toContain(`[src:${s1.chunkIds[0]}]`);
    // Beta's chunk must NOT be in scope.
    expect(summary).not.toContain(`[src:${s2.chunkIds[0]}]`);
    expect(summary).not.toContain('«Beta»');
  });

  test('sourceIds=[] ⇒ empty scope: search_source returns nothing', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'Has Sources');
    await seedReadySource(userId, notebookId, 'Alpha', [{ text: 'alpha content' }]);

    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        searchTurn([{ id: 's1', name: 'search_source', args: { query: 'alpha content' } }]),
        answerTurn('No sources are checked in.'),
      ]),
    });

    const convId = (await (await createConversation(cookie, { notebookId })).json<{ id: string }>()).id;
    // Explicit empty scope: the user unchecked every source.
    const frames = await readSse(
      await streamReq(cookie, convId, 'find the topic', { sourceIds: [] }),
    );

    const result = frames.find((f) => f.event === 'tool_result');
    expect((result!.data as { ok: boolean }).ok).toBe(true);
    // Empty scope ⇒ the "no ready sources checked in" branch (not a hit).
    expect((result!.data as { summary: string }).summary.toLowerCase()).toContain('no ready sources');
  });

  test('a non-ready source is excluded from the scope (only ready chunks searchable)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'Mixed');
    const ready = await seedReadySource(userId, notebookId, 'Ready', [{ text: 'ready passage text' }]);
    // An 'indexing' source whose chunk exists in kb_chunk but the source is NOT
    // ready — it must be excluded by resolveNotebookScope (status='ready' only).
    const pending = await seedReadySource(
      userId,
      notebookId,
      'Pending',
      [{ text: 'pending passage text' }],
      'indexing',
    );

    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        // Query the PENDING source's exact text — but it is out of scope, so the
        // search cannot surface it. The ready source's chunk is the only candidate.
        searchTurn([{ id: 's1', name: 'search_source', args: { query: 'pending passage text' } }]),
        answerTurn('Answered from ready sources only.'),
      ]),
    });

    const convId = (await (await createConversation(cookie, { notebookId })).json<{ id: string }>()).id;
    const frames = await readSse(await streamReq(cookie, convId, 'find pending'));

    const result = frames.find((f) => f.event === 'tool_result');
    const summary = (result!.data as { summary: string }).summary;
    // The non-ready source's chunk is never surfaced.
    expect(summary).not.toContain(`[src:${pending.chunkIds[0]}]`);
    expect(summary).not.toContain('«Pending»');
    // If anything was returned, it can only be the ready source's chunk.
    if ((result!.data as { ok: boolean }).ok && summary.includes('[src:')) {
      expect(summary).toContain(`[src:${ready.chunkIds[0]}]`);
    }
  });
});

describe('notebook chat — registry shape', () => {
  beforeEach(async () => {
    await resetTestDb();
    capturedAgentMessages = [];
  });
  afterEach(() => {
    __resetAiClientForTests();
    __setWebSearchProviderForTests(null);
  });

  test('search_cards is discoverable but strict source-only context rejects its execution', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    await seedReadySource(userId, notebookId, 'Src', [{ text: 'some content' }]);

    // The embed spy proves search_cards never ran (its execute embeds FIRST). The
    // model calls search_cards without an attached card/deck — scope rejects it.
    let embedCalls = 0;
    const embed = (texts: string[]): Promise<number[][]> => {
      embedCalls += 1;
      return Promise.resolve(texts.map(vectorFor));
    };
    __setAiClientForTests({
      embed,
      chatStreamAgentic: scriptedAgentStream([
        searchTurn([{ id: 'x1', name: 'search_cards', args: { query: 'anything' } }]),
        answerTurn('Recovered.'),
      ]),
    });

    const convId = (await (await createConversation(cookie, { notebookId })).json<{ id: string }>()).id;
    const frames = await readSse(await streamReq(cookie, convId, 'search my cards'));

    const result = frames.find((f) => f.event === 'tool_result');
    expect((result!.data as { ok: boolean }).ok).toBe(false);
    expect((result!.data as { summary: string }).summary).toContain('outside_context');
    // search_cards.execute (which would embed) never ran.
    expect(embedCalls).toBe(0);
    expect(frames.some((f) => f.event === 'done')).toBe(true);
  });

  test('enabled web_search stays discoverable but strict notebook grounding prevents outside evidence', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    await seedReadySource(userId, notebookId, 'Src', [{ text: 'content' }]);

    // Inject a web-search provider so isWebSearchEnabled() flips on for this turn.
    __setWebSearchProviderForTests({
      async search() {
        return [{ title: 'Result', snippet: 'a web snippet', url: 'https://example.com' }];
      },
    });

    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        searchTurn([{ id: 'w1', name: 'web_search', args: { query: 'external fact' } }]),
        answerTurn('outside your sources: per the web.'),
      ]),
    });

    const convId = (await (await createConversation(cookie, { notebookId })).json<{ id: string }>()).id;
    const frames = await readSse(await streamReq(cookie, convId, 'search the web for X'));

    // The tool is discoverable, but strict grounding does not permit outside evidence.
    expect(executedTools(frames)).toContain('web_search');
    const result = frames.find((f) => f.event === 'tool_result');
    expect((result!.data as { ok: boolean }).ok).toBe(false);
    expect((result!.data as { summary: string }).summary).toContain('outside_context');
    expect((result!.data as { summary: string }).summary).not.toContain('a web snippet');
  });

  test('web_search is NOT offered when web search is disabled → unknown-tool error', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    await seedReadySource(userId, notebookId, 'Src', [{ text: 'content' }]);

    // No web provider injected (default test env: web search off).
    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        searchTurn([{ id: 'w1', name: 'web_search', args: { query: 'external fact' } }]),
        answerTurn('Recovered.'),
      ]),
    });

    const convId = (await (await createConversation(cookie, { notebookId })).json<{ id: string }>()).id;
    const frames = await readSse(await streamReq(cookie, convId, 'search the web'));

    const result = frames.find((f) => f.event === 'tool_result');
    expect((result!.data as { ok: boolean }).ok).toBe(false);
    expect((result!.data as { summary: string }).summary).toContain('unknown tool');
  });
});

describe('notebook chat — system prompt variants', () => {
  beforeEach(async () => {
    await resetTestDb();
    capturedAgentMessages = [];
  });
  afterEach(() => {
    __resetAiClientForTests();
    __setWebSearchProviderForTests(null);
  });

  test('a notebook turn builds the source-grounded prompt (mentions [src:, grounding, the title)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'Quantum Notes');
    await seedReadySource(userId, notebookId, 'Lecture One', [{ text: 'superposition basics' }]);

    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([answerTurn('Hello.')]),
    });

    const convId = (await (await createConversation(cookie, { notebookId })).json<{ id: string }>()).id;
    await readSse(await streamReq(cookie, convId, 'hi'));

    const system = capturedAgentMessages[0]![0]!;
    expect(system.role).toBe('system');
    const prompt = String(system.content);
    // Notebook variant markers.
    expect(prompt).toContain('NOTEBOOK');
    expect(prompt).toContain('[src:<sourceChunkId>]');
    expect(prompt).toContain('search_source');
    expect(prompt).toContain('Quantum Notes'); // the notebook title
    expect(prompt).toContain('Lecture One'); // the source title in the sources section
    // The shared catalog remains available; the notebook grounding instructions stay.
    expect(prompt).toContain('search_cards');
    expect(prompt).not.toContain('[card:<cardId>]');
  });

  test('a global turn builds the card prompt with NO source section', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());

    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([answerTurn('Hello.')]),
    });

    // A GLOBAL conversation (no notebookId).
    const convId = (await (await createConversation(cookie, {})).json<{ id: string }>()).id;
    await readSse(await streamReq(cookie, convId, 'hi'));

    const prompt = String(capturedAgentMessages[0]![0]!.content);
    expect(prompt).toContain('search_cards');
    expect(prompt).toContain('[card:<cardId>]');
    // No notebook/source grounding section.
    expect(prompt).not.toContain('[src:<sourceChunkId>]');
    expect(prompt).toContain('search_source');
  });
});

describe('notebook chat — GET /sources/:id/chunks reader paging', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('paging: from/limit drive nextFrom + total; ordered by position', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const chunks = Array.from({ length: 5 }, (_, i) => ({ text: `passage ${i}`, page: i + 1 }));
    const { sourceId } = await seedReadySource(userId, notebookId, 'Doc', chunks);

    // First page: limit 2 → positions 0,1, nextFrom 2, total 5.
    const p0 = await callApp(app, 'GET', `/sources/${sourceId}/chunks?from=0&limit=2`, { cookie });
    expect(p0.status).toBe(200);
    const page0 = await p0.json<{
      items: { position: number; text: string; page: number | null }[];
      total: number;
      nextFrom: number | null;
    }>();
    expect(page0.total).toBe(5);
    expect(page0.items.map((c) => c.position)).toEqual([0, 1]);
    expect(page0.items[0]!.text).toBe('passage 0');
    expect(page0.items[0]!.page).toBe(1);
    expect(page0.nextFrom).toBe(2);

    // Next page from 2: positions 2,3, nextFrom 4.
    const p1 = await callApp(app, 'GET', `/sources/${sourceId}/chunks?from=2&limit=2`, { cookie });
    const page1 = await p1.json<{ items: { position: number }[]; nextFrom: number | null }>();
    expect(page1.items.map((c) => c.position)).toEqual([2, 3]);
    expect(page1.nextFrom).toBe(4);

    // Last page from 4: position 4 only, nextFrom null (end of source).
    const p2 = await callApp(app, 'GET', `/sources/${sourceId}/chunks?from=4&limit=2`, { cookie });
    const page2 = await p2.json<{ items: { position: number }[]; nextFrom: number | null }>();
    expect(page2.items.map((c) => c.position)).toEqual([4]);
    expect(page2.nextFrom).toBeNull();
  });

  test('GET /sources/:id/chunks 404s a foreign source', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const { sourceId } = await seedReadySource(userId, notebookId, 'Doc', [{ text: 'x' }]);

    const other = await signUpAndCookie(app, uniqueEmail('b'));
    const res = await callApp(app, 'GET', `/sources/${sourceId}/chunks`, { cookie: other.cookie });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});
