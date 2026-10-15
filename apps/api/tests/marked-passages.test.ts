// PDF reader markup → AI-visible passages (M4 / T3): the `list_marked_passages`
// tool + its grounding → provenance chain.
//
// CONTRACT (read from apps/api/src/ai/tools.ts listMarkedPassages +
// buildToolRegistry + the M3 provenance path, NOT invented):
//   * `list_marked_passages` is in the NOTEBOOK registry ONLY (after read_source);
//     a GLOBAL turn calling it gets an unknown-tool error (never executed).
//   * It reads `source_annotations.marked_text` (non-empty), user-scoped +
//     source_id IN scope, JOIN sources for the title, ordered by source then page.
//     Result text per row: `«<title>» — p.<page>: "<markedText capped ~400/row>"`.
//   * Grounding/citations: each annotated page's marked_text is matched to the
//     page's `source_chunks` (EXACT page match, user-scoped) → chunk ids push into
//     ctx.grounding + a SourceCitation[] (kind:'source', page, sourceTitle) per
//     matched chunk. A page with NO matching chunk renders its text but yields no
//     citation/grounding (no error).
//   * `sourceId` arg absent ⇒ all of ctx.notebook.sourceIds; given ⇒ must be in
//     scope (else a self-correcting error listing the valid sources).
//   * Nothing marked ⇒ a graceful "no marked passages yet" result (ok:true).
//   * END-TO-END: list_marked_passages → create_card suspend stamps
//     messages.grounding = the page-matched chunk ids → resume apply →
//     writeCardProvenance inserts card_sources edges for exactly those chunks.
//
// Harness mirrors notebook-chat.test.ts + card-provenance.test.ts (scripted fake
// AI client, direct-DB document fixtures, SSE frame parsing; the fake's call
// counter persists across /stream + /resume).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  cardSources as cardSourcesTable,
  cards as cardsTable,
  db,
  ensureBuiltins,
  kbChunk,
  messages as messagesTable,
  notebooks as notebooksTable,
  notebookSources as notebookSourcesTable,
  sourceAnnotations as sourceAnnotationsTable,
  sourceChunks as sourceChunksTable,
  sourceMarks as sourceMarksTable,
  sources as sourcesTable,
} from '@reomi/db';
import type { MarkRect, SourceMarkKind } from '@reomi/shared';
import { asc, eq } from 'drizzle-orm';
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

// ── scripted agentic fake (counter persists across /stream + /resume) ─────────

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
function toolTurn(calls: ToolCallScript[]): AgentTurn {
  return { toolCalls: calls, finish: 'tool_calls' };
}

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
      const argsJson = JSON.stringify(tc.args);
      const mid = Math.floor(argsJson.length / 2);
      yield { type: 'tool_call_delta', index, id: tc.id, name: tc.name };
      yield { type: 'tool_call_delta', index, argsFragment: argsJson.slice(0, mid) };
      yield { type: 'tool_call_delta', index, argsFragment: argsJson.slice(mid) };
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
function resumeReq(
  cookie: string,
  convId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/chat/conversations/${convId}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    }),
  );
}

function executedTools(frames: SseFrame[]): string[] {
  return frames
    .filter((f) => f.event === 'tool_call')
    .map((f) => (f.data as { name: string }).name);
}

// ── fixtures ──────────────────────────────────────────────────────────────────

async function freshNotebook(userId: string, title = 'NB'): Promise<string> {
  const [nb] = await db
    .insert(notebooksTable)
    .values({ userId, title })
    .returning({ id: notebooksTable.id });
  return nb!.id;
}

/**
 * Seed a READY source with source_chunks + kb_chunk document rows (mirrors
 * notebook-chat.test.ts). Each chunk carries a `page` so list_marked_passages can
 * match a page's marked_text to its chunks. Returns the source id + chunk ids (in
 * position order).
 */
async function seedReadySource(
  userId: string,
  notebookId: string,
  title: string,
  chunks: { text: string; page?: number }[],
): Promise<{ sourceId: string; chunkIds: string[] }> {
  const [src] = await db
    .insert(sourcesTable)
    .values({
      userId,
      kind: 'pdf',
      title,
      status: 'ready',
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
      .values({ userId, sourceId, position: i, text: c.text, page: c.page, embedded: true })
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

/** Insert one source_annotations row directly (the client's debounced PUT did this). */
async function seedAnnotation(
  userId: string,
  sourceId: string,
  page: number,
  markedText: string | null,
): Promise<void> {
  await db.insert(sourceAnnotationsTable).values({
    userId,
    sourceId,
    page,
    strokes: { v: 1, strokes: [{ tool: 'highlighter', color: '#ffcc00', width: 0.004, points: [0.1, 0.2, 0.5] }] },
    markedText,
  });
}

/** Insert one source_marks row directly (the selection popover's POST did this, M5). */
async function seedMark(
  userId: string,
  sourceId: string,
  page: number,
  kind: SourceMarkKind,
  quote: string,
  note: string | null = null,
): Promise<void> {
  const rects: MarkRect[] = [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04 }];
  await db.insert(sourceMarksTable).values({
    userId,
    sourceId,
    page,
    kind,
    quote,
    rects,
    color: 'lime',
    note,
  });
}

async function createConversation(cookie: string, body: Record<string, unknown> = {}): Promise<string> {
  const res = await callApp(app, 'POST', '/chat/conversations', { cookie, body });
  expect(res.status).toBe(200);
  return (await res.json<{ id: string }>()).id;
}
async function freshDeck(cookie: string, name = 'Deck'): Promise<string> {
  const res = await callApp(app, 'POST', '/decks', { cookie, body: { name } });
  return (await res.json<{ id: string }>()).id;
}

async function edgesFor(userId: string) {
  return db
    .select()
    .from(cardSourcesTable)
    .where(eq(cardSourcesTable.userId, userId))
    .orderBy(asc(cardSourcesTable.createdAt));
}

// ── registry shape: notebook-only ───────────────────────────────────────────

describe('list_marked_passages — registry shape', () => {
  beforeEach(async () => {
    await resetTestDb();
    capturedAgentMessages = [];
  });
  afterEach(() => {
    __resetAiClientForTests();
    __setWebSearchProviderForTests(null);
  });

  test('present in NOTEBOOK mode — executes and returns the marked text', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'Reader NB');
    const { sourceId, chunkIds } = await seedReadySource(userId, notebookId, 'Lecture', [
      { text: 'photosynthesis converts light to chemical energy', page: 4 },
    ]);
    await seedAnnotation(userId, sourceId, 4, 'photosynthesis converts light');

    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        toolTurn([{ id: 'm1', name: 'list_marked_passages', args: {} }]),
        answerTurn('You marked the photosynthesis passage.'),
      ]),
    });

    const convId = await createConversation(cookie, { notebookId });
    const frames = await readSse(await streamReq(cookie, convId, 'what did I highlight?'));

    expect(executedTools(frames)).toContain('list_marked_passages');
    const result = frames.find((f) => f.event === 'tool_result');
    expect(result).toBeTruthy();
    expect((result!.data as { ok: boolean }).ok).toBe(true);
    const summary = (result!.data as { summary: string }).summary;
    // Result text per row: «<title>» — p.<page>: "<markedText>".
    expect(summary).toContain('«Lecture»');
    expect(summary).toContain('p.4');
    expect(summary).toContain('photosynthesis converts light');

    // The page-matched chunk rode out as a kind:'source' citation.
    const resultCitations = (result!.data as { citations?: { kind: string; sourceChunkId: string }[] })
      .citations;
    expect(resultCitations!.some((c) => c.kind === 'source' && c.sourceChunkId === chunkIds[0])).toBe(true);
    expect(frames.some((f) => f.event === 'done')).toBe(true);
  });

  test('global registry includes marked passages and reports its empty selected scope', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());

    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        toolTurn([{ id: 'm1', name: 'list_marked_passages', args: {} }]),
        answerTurn('Recovered.'),
      ]),
    });

    // A GLOBAL conversation (no notebookId).
    const convId = await createConversation(cookie, {});
    const frames = await readSse(await streamReq(cookie, convId, 'what did I highlight?'));

    const result = frames.find((f) => f.event === 'tool_result');
    expect((result!.data as { ok: boolean }).ok).toBe(true);
    expect((result!.data as { summary: string }).summary).toContain('no ready sources selected');
    expect(frames.some((f) => f.event === 'done')).toBe(true);
  });
});

// ── result content: title/page/text, per-row cap, scoping, empty ────────────

describe('list_marked_passages — result content', () => {
  beforeEach(async () => {
    await resetTestDb();
    capturedAgentMessages = [];
  });
  afterEach(() => {
    __resetAiClientForTests();
    __setWebSearchProviderForTests(null);
  });

  test('per-row cap: a long marked_text is truncated (~400 chars) in the result row', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const { sourceId } = await seedReadySource(userId, notebookId, 'Big', [
      { text: 'chunk text', page: 1 },
    ]);
    // A 1000-char marked_text — the row renders only ~400 chars + an ellipsis.
    const long = 'X'.repeat(1000);
    await seedAnnotation(userId, sourceId, 1, long);

    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        toolTurn([{ id: 'm1', name: 'list_marked_passages', args: {} }]),
        answerTurn('ok'),
      ]),
    });

    const convId = await createConversation(cookie, { notebookId });
    const frames = await readSse(await streamReq(cookie, convId, 'markup?'));
    const summary = (frames.find((f) => f.event === 'tool_result')!.data as { summary: string }).summary;
    // The full 1000-char marked text is NOT echoed verbatim (per-row cap applied).
    expect(summary).not.toContain(long);
    expect(summary).toContain('X'.repeat(400)); // first 400 chars survive
    expect(summary).not.toContain('X'.repeat(500)); // but not 500
    expect(summary).toContain('…'); // truncation marker
  });

  test('sourceId outside the notebook scope → self-correcting error listing valid sources', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    await seedReadySource(userId, notebookId, 'Known Doc', [{ text: 'x', page: 1 }]);

    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        // A sourceId that is NOT one of the notebook's checked-in sources.
        toolTurn([
          {
            id: 'm1',
            name: 'list_marked_passages',
            args: { sourceId: '11111111-1111-4111-8111-111111111111' },
          },
        ]),
        answerTurn('I could not find that source.'),
      ]),
    });

    const convId = await createConversation(cookie, { notebookId });
    const frames = await readSse(await streamReq(cookie, convId, 'markup of source X'));

    const result = frames.find((f) => f.event === 'tool_result');
    expect((result!.data as { ok: boolean }).ok).toBe(false);
    const summary = (result!.data as { summary: string }).summary;
    // Lists the valid source(s) so the model self-corrects.
    expect(summary).toContain('«Known Doc»');
    expect(summary).toContain('not a source in this notebook');
    expect(frames.some((f) => f.event === 'done')).toBe(true);
  });

  test('no marked passages → a graceful "nothing marked" result (ok:true)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    // A ready source exists, but it has NO annotations at all.
    await seedReadySource(userId, notebookId, 'Unmarked', [{ text: 'chunk', page: 1 }]);

    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        toolTurn([{ id: 'm1', name: 'list_marked_passages', args: {} }]),
        answerTurn('You have not highlighted anything yet.'),
      ]),
    });

    const convId = await createConversation(cookie, { notebookId });
    const frames = await readSse(await streamReq(cookie, convId, 'what did I mark?'));

    const result = frames.find((f) => f.event === 'tool_result');
    expect((result!.data as { ok: boolean }).ok).toBe(true);
    expect((result!.data as { summary: string }).summary.toLowerCase()).toContain('no marked passages');
    // No citations (nothing matched).
    const citation = frames.find((f) => f.event === 'citation');
    expect((citation!.data as { citations: unknown[] }).citations).toEqual([]);
  });

  test('an empty/whitespace-only marked_text row is excluded (treated as nothing marked)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const { sourceId } = await seedReadySource(userId, notebookId, 'Doc', [{ text: 'c', page: 1 }]);
    // An annotation row whose marked_text is whitespace-only — the SQL filter
    // (length(trim(marked_text)) > 0) drops it.
    await seedAnnotation(userId, sourceId, 1, '   ');
    // And a NULL marked_text row on another page — also dropped.
    await seedAnnotation(userId, sourceId, 2, null);

    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        toolTurn([{ id: 'm1', name: 'list_marked_passages', args: {} }]),
        answerTurn('nothing'),
      ]),
    });

    const convId = await createConversation(cookie, { notebookId });
    const frames = await readSse(await streamReq(cookie, convId, 'markup?'));
    const result = frames.find((f) => f.event === 'tool_result');
    expect((result!.data as { ok: boolean }).ok).toBe(true);
    expect((result!.data as { summary: string }).summary.toLowerCase()).toContain('no marked passages');
  });

  test('kind:"card" markers are EXCLUDED (outputs, not user emphasis)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const { sourceId } = await seedReadySource(userId, notebookId, 'Doc', [{ text: 'chunk', page: 1 }]);
    // A real user HIGHLIGHT (should appear) + a kind:'card' marker (should NOT).
    await seedMark(userId, sourceId, 1, 'highlight', 'the user highlighted this');
    await db.insert(sourceMarksTable).values({
      userId,
      sourceId,
      page: 1,
      kind: 'card',
      quote: 'the card-marker quote that must never reach the model',
      rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04 }] as MarkRect[],
      color: 'lime',
    });

    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        toolTurn([{ id: 'm1', name: 'list_marked_passages', args: {} }]),
        answerTurn('ok'),
      ]),
    });

    const convId = await createConversation(cookie, { notebookId });
    const frames = await readSse(await streamReq(cookie, convId, 'what did I mark?'));
    const summary = (frames.find((f) => f.event === 'tool_result')!.data as { summary: string }).summary;
    expect(summary).toContain('the user highlighted this');
    // The card marker's quote is filtered out at the SQL level.
    expect(summary).not.toContain('the card-marker quote that must never reach the model');
  });

  test('sourceId in scope limits to that source only (multi-source notebook)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'Two');
    const a = await seedReadySource(userId, notebookId, 'Alpha', [{ text: 'alpha chunk', page: 1 }]);
    const b = await seedReadySource(userId, notebookId, 'Beta', [{ text: 'beta chunk', page: 1 }]);
    await seedAnnotation(userId, a.sourceId, 1, 'alpha highlight');
    await seedAnnotation(userId, b.sourceId, 1, 'beta highlight');

    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        toolTurn([{ id: 'm1', name: 'list_marked_passages', args: { sourceId: a.sourceId } }]),
        answerTurn('ok'),
      ]),
    });

    const convId = await createConversation(cookie, { notebookId });
    const frames = await readSse(await streamReq(cookie, convId, 'alpha markup'));
    const summary = (frames.find((f) => f.event === 'tool_result')!.data as { summary: string }).summary;
    expect(summary).toContain('alpha highlight');
    expect(summary).toContain('«Alpha»');
    // Beta's markup is out of the per-call scope.
    expect(summary).not.toContain('beta highlight');
    expect(summary).not.toContain('«Beta»');
  });
});

// ── end-to-end provenance: marked passages → card → card_sources edges ───────

describe('list_marked_passages — grounding → card provenance (end to end)', () => {
  beforeEach(async () => {
    await resetTestDb();
    await ensureBuiltins(db);
    capturedAgentMessages = [];
  });
  afterEach(() => {
    __resetAiClientForTests();
    __setWebSearchProviderForTests(null);
  });

  test('marked text → create_card suspend stamps grounding (page-matched chunks) → apply writes card_sources edges', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'Bio');
    const deckId = await freshDeck(cookie);
    // Page 3 has TWO chunks; page 7 has one. Mark page 3 only.
    const { sourceId, chunkIds } = await seedReadySource(userId, notebookId, 'Cell Biology', [
      { text: 'mitochondria are the powerhouse', page: 3 }, // chunk 0
      { text: 'ATP synthase spans the membrane', page: 3 }, // chunk 1 (same page)
      { text: 'unrelated chapter two material', page: 7 }, // chunk 2 (different page)
    ]);
    await seedAnnotation(userId, sourceId, 3, 'mitochondria are the powerhouse of the cell');

    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        toolTurn([{ id: 'm1', name: 'list_marked_passages', args: {} }]),
        // A create_card grounded on the marked page (paused for confirm).
        toolTurn([
          {
            id: 'w1',
            name: 'create_card',
            args: { deckId, evidenceChunkIds: chunkIds.slice(0,2), fieldValues: { Front: 'What is the powerhouse?', Back: 'Mitochondria' } },
          },
        ]),
        answerTurn('Created the card from your markup.'),
      ]),
    });

    const convId = await createConversation(cookie, { notebookId });
    const frames = await readSse(await streamReq(cookie, convId, 'make a card from what I marked'));

    // The marked-passages citation frame carried kind:'source' with page + title.
    const markedResult = frames.find(
      (f) => f.event === 'tool_result',
    );
    const markedCitations = (markedResult!.data as {
      citations?: { kind: string; page?: number; sourceTitle?: string; sourceChunkId: string }[];
    }).citations!;
    // Both page-3 chunks are surfaced (citation per matched chunk); the page-7
    // chunk is NOT (no marked text on page 7).
    expect(markedCitations.length).toBe(2);
    expect(markedCitations.every((c) => c.kind === 'source')).toBe(true);
    expect(markedCitations.every((c) => c.page === 3)).toBe(true);
    expect(markedCitations.every((c) => c.sourceTitle === 'Cell Biology')).toBe(true);
    const citedChunkIds = markedCitations.map((c) => c.sourceChunkId).sort();
    expect(citedChunkIds).toEqual([chunkIds[0]!, chunkIds[1]!].sort());

    // The pending assistant row carries the grounding = the two page-matched chunks.
    const rows = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, convId))
      .orderBy(asc(messagesTable.createdAt));
    const pendingRow = rows.find(
      (r) => r.role === 'assistant' && r.toolCalls?.[0]?.name === 'create_card',
    )!;
    expect(pendingRow.toolCalls![0]!.impact?.cardEvidence).toBeTruthy();
    expect([...pendingRow.toolCalls![0]!.impact!.cardEvidence![0]!.map(item => item.chunkId)].sort()).toEqual(
      [chunkIds[0]!, chunkIds[1]!].sort(),
    );
    // The page-7 chunk (no marked text) is NOT in the grounding.
    expect(pendingRow.toolCalls![0]!.impact!.cardEvidence![0]!.map(item => item.chunkId)).not.toContain(chunkIds[2]);

    // No edges yet (still paused).
    expect((await edgesFor(userId)).length).toBe(0);

    // Resume APPLY → one card + one edge per (card × distinct grounding chunk).
    const resumeFrames = await readSse(
      await resumeReq(cookie, convId, { resumeToolCallId: 'w1', decision: 'apply' }),
    );
    expect(resumeFrames.some((f) => f.event === 'done')).toBe(true);

    const cards = await db.select().from(cardsTable).where(eq(cardsTable.userId, userId));
    expect(cards.length).toBe(1);
    const cardId = cards[0]!.id;

    const edges = await edgesFor(userId);
    expect(edges.length).toBe(2);
    const linkedChunks = edges.map((e) => e.sourceChunkId).sort();
    expect(linkedChunks).toEqual([chunkIds[0]!, chunkIds[1]!].sort());
    for (const e of edges) {
      expect(e.cardId).toBe(cardId);
      expect(e.sourceId).toBe(sourceId);
      expect(e.notebookId).toBe(notebookId);
      expect(e.conversationId).toBe(convId);
      expect(e.messageId).toBe(pendingRow.id);
    }
  });

  test('a marked page with NO matching source_chunk contributes text but no grounding/edge (no error)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const deckId = await freshDeck(cookie);
    // The source's only chunk is on page 1; mark page 9 (no chunk there) AND
    // page 1 (a matching chunk). list_marked_passages renders both pages' text
    // but grounds only on page 1's chunk.
    const { sourceId, chunkIds } = await seedReadySource(userId, notebookId, 'Doc', [
      { text: 'page one passage', page: 1 },
    ]);
    await seedAnnotation(userId, sourceId, 1, 'highlighted on page one');
    await seedAnnotation(userId, sourceId, 9, 'highlighted on a page with no chunk');

    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        toolTurn([{ id: 'm1', name: 'list_marked_passages', args: {} }]),
        toolTurn([
          {
            id: 'w1',
            name: 'create_card',
            args: { deckId, evidenceChunkIds: [chunkIds[0]!], fieldValues: { Front: 'Q', Back: 'A' } },
          },
        ]),
        answerTurn('Done.'),
      ]),
    });

    const convId = await createConversation(cookie, { notebookId });
    const frames = await readSse(await streamReq(cookie, convId, 'cards from my markup'));

    const markedResult = frames.find((f) => f.event === 'tool_result')!;
    expect((markedResult.data as { ok: boolean }).ok).toBe(true);
    const summary = (markedResult.data as { summary: string }).summary;
    // BOTH pages' marked text is rendered (the no-chunk page still contributes text).
    expect(summary).toContain('highlighted on page one');
    expect(summary).toContain('highlighted on a page with no chunk');
    expect(summary).toContain('p.1');
    expect(summary).toContain('p.9');
    // But only ONE citation (page 1's matching chunk) — the no-chunk page adds none.
    const citations = (markedResult.data as { citations?: { sourceChunkId: string }[] }).citations!;
    expect(citations.length).toBe(1);
    expect(citations[0]!.sourceChunkId).toBe(chunkIds[0]);

    // Grounding = exactly the one matched chunk.
    const rows = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, convId))
      .orderBy(asc(messagesTable.createdAt));
    const pendingRow = rows.find(
      (r) => r.role === 'assistant' && r.toolCalls?.[0]?.name === 'create_card',
    )!;
    expect(pendingRow.toolCalls![0]!.impact!.cardEvidence![0]!.map(item => item.chunkId)).toEqual([chunkIds[0]!]);

    // Apply → exactly one edge (the one matched chunk), no error from the no-chunk page.
    await readSse(await resumeReq(cookie, convId, { resumeToolCallId: 'w1', decision: 'apply' }));
    const edges = await edgesFor(userId);
    expect(edges.length).toBe(1);
    expect(edges[0]!.sourceChunkId).toBe(chunkIds[0]);
  });

  test('M5 merge: ink + highlight + note on different pages → all three labeled in page order; grounds a HIGHLIGHT page chunk → provenance edge', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'Reader');
    const deckId = await freshDeck(cookie);
    // One source, three pages each with its own chunk:
    //   page 2 → an INK marked_text (M4 source_annotations).
    //   page 5 → a TEXT HIGHLIGHT (M5 source_marks, kind 'highlight').
    //   page 8 → a place-anchored NOTE (M5 source_marks, kind 'note').
    const { sourceId, chunkIds } = await seedReadySource(userId, notebookId, 'Reader Doc', [
      { text: 'ink chunk on page two', page: 2 }, // chunk 0
      { text: 'highlight chunk on page five', page: 5 }, // chunk 1
      { text: 'note chunk on page eight', page: 8 }, // chunk 2
    ]);
    await seedAnnotation(userId, sourceId, 2, 'ink underline on page two');
    await seedMark(userId, sourceId, 5, 'highlight', 'the highlighted span on page five');
    await seedMark(userId, sourceId, 8, 'note', 'the noted span on page eight', 'my margin note');

    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        toolTurn([{ id: 'm1', name: 'list_marked_passages', args: {} }]),
        // A create_card grounded on ALL marked pages (paused for confirm).
        toolTurn([
          {
            id: 'w1',
            name: 'create_card',
            args: { deckId, evidenceChunkIds: chunkIds, fieldValues: { Front: 'What did I mark?', Back: 'Three passages.' } },
          },
        ]),
        answerTurn('Created a card from your markup.'),
      ]),
    });

    const convId = await createConversation(cookie, { notebookId });
    const frames = await readSse(await streamReq(cookie, convId, 'make a card from everything I marked'));

    const markedResult = frames.find((f) => f.event === 'tool_result')!;
    expect((markedResult.data as { ok: boolean }).ok).toBe(true);
    const summary = (markedResult.data as { summary: string }).summary;

    // All three entries are present, each labeled by its kind.
    expect(summary).toContain('ink underline on page two'); // ink (no [kind] tag)
    expect(summary).toContain('[выделение]'); // highlight label
    expect(summary).toContain('the highlighted span on page five');
    expect(summary).toContain('[заметка]'); // note label
    expect(summary).toContain('the noted span on page eight');
    expect(summary).toContain('my margin note'); // the note body rides along

    // Page-ordered: p.2 (ink) < p.5 (highlight) < p.8 (note).
    const idxInk = summary.indexOf('p.2');
    const idxHi = summary.indexOf('p.5');
    const idxNote = summary.indexOf('p.8');
    expect(idxInk).toBeGreaterThanOrEqual(0);
    expect(idxHi).toBeGreaterThan(idxInk);
    expect(idxNote).toBeGreaterThan(idxHi);

    // Grounding covers each marked page's chunk — including the HIGHLIGHT page (5)
    // and the NOTE page (8), not just the ink page (2).
    const citations = (markedResult.data as { citations?: { sourceChunkId: string; page?: number }[] }).citations!;
    const citedChunkIds = citations.map((c) => c.sourceChunkId).sort();
    expect(citedChunkIds).toEqual([chunkIds[0]!, chunkIds[1]!, chunkIds[2]!].sort());

    const rows = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, convId))
      .orderBy(asc(messagesTable.createdAt));
    const pendingRow = rows.find(
      (r) => r.role === 'assistant' && r.toolCalls?.[0]?.name === 'create_card',
    )!;
    const grounded = [...pendingRow.toolCalls![0]!.impact!.cardEvidence![0]!.map(item => item.chunkId)].sort();
    expect(grounded).toEqual([chunkIds[0]!, chunkIds[1]!, chunkIds[2]!].sort());

    // Apply → an edge per grounding chunk; the HIGHLIGHT page's chunk is among them.
    await readSse(await resumeReq(cookie, convId, { resumeToolCallId: 'w1', decision: 'apply' }));
    const edges = await edgesFor(userId);
    const edgeChunks = edges.map((e) => e.sourceChunkId);
    expect(edgeChunks).toContain(chunkIds[1]); // the highlight-page chunk has provenance
    expect(edgeChunks.slice().sort()).toEqual([chunkIds[0]!, chunkIds[1]!, chunkIds[2]!].sort());
  });
});
