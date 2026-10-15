// C2 — parallel read-tool execution + mixed read/write batches.
//
// CONTRACT (read from apps/api/src/modules/ai.ts `runAgentTurn`, NOT invented):
//   * A batch of READ tool calls executes CONCURRENTLY (Promise.all). All
//     `tool_call` frames go out up-front in batch order; `tool_result` frames
//     arrive per-completion (so a slow call's result lands AFTER a fast
//     sibling's even when it came first in the batch). Everything
//     order-sensitive — persisted role:tool rows, citation dedup, the char
//     budget — is applied AFTER the Promise.all in batch order (deterministic).
//   * A MIXED batch (reads + a write/SRS call) executes the reads first as
//     their own fully-answered assistant tool_calls row, THEN pauses on the
//     FIRST write as a second assistant tool_calls row (`await_confirmation`,
//     no `done`). Before C2 the reads were silently dropped.
//   * A failing read (unknown tool) doesn't poison its siblings — it yields an
//     `ok:false` result row and the loop continues.
//
// Out-of-order completion is forced via a delay-controlled fake web-search
// provider (`__setWebSearchProviderForTests`) — the 'slow' query resolves last.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { db, ensureBuiltins, messages as messagesTable, cards as cardsTable } from '@reomi/db';
import { asc, eq } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import {
  __resetAiClientForTests,
  __setAiClientForTests,
  type AgentChatMessage,
  type AgentStreamChunk,
} from '../src/ai/openai-client.ts';
import {
  __resetWebSearchProviderForTests,
  __setWebSearchProviderForTests,
} from '../src/ai/web-search.ts';
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

// ── Scripted agentic fake ─────────────────────────────────────────────────────

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

async function streamReq(cookie: string, convId: string, content: string): Promise<Response> {
  const req = new Request(`http://localhost/chat/conversations/${convId}/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ content }),
  });
  return app.handle(req);
}
async function resumeReq(
  cookie: string,
  convId: string,
  body: { resumeToolCallId: string; decision: 'apply' | 'reject' },
): Promise<Response> {
  const req = new Request(`http://localhost/chat/conversations/${convId}/resume`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  return app.handle(req);
}
async function createConversation(cookie: string): Promise<string> {
  const res = await callApp(app, 'POST', '/chat/conversations', { cookie, body: {} });
  expect(res.status).toBe(200);
  return (await res.json<{ id: string }>()).id;
}
async function freshDeck(cookie: string, name = 'D'): Promise<string> {
  return (
    await (await callApp(app, 'POST', '/decks', { cookie, body: { name } })).json<{ id: string }>()
  ).id;
}

async function transcriptRows(convId: string) {
  return db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, convId))
    .orderBy(asc(messagesTable.createdAt));
}

describe('agentic chat — parallel read tools + mixed batches (C2)', () => {
  beforeEach(async () => {
    await resetTestDb();
    await ensureBuiltins(db);
    capturedAgentMessages = [];
  });
  afterEach(() => {
    __resetAiClientForTests();
    __resetWebSearchProviderForTests();
  });

  test('read batch executes concurrently: results land out of batch order, persistence stays in batch order', async () => {
    // 'slow' resolves well after 'fast' — with sequential execution the result
    // frames would be [slow, fast]; with Promise.all they are [fast, slow].
    __setWebSearchProviderForTests({
      search: async (query) => {
        await new Promise((r) => setTimeout(r, query === 'slow' ? 120 : 5));
        return [{ title: `T ${query}`, url: `https://example.com/${query}`, snippet: 'S' }];
      },
    });
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        {
          toolCalls: [
            { id: 'call_slow', name: 'web_search', args: { query: 'slow' } },
            { id: 'call_fast', name: 'web_search', args: { query: 'fast' } },
            { id: 'call_decks', name: 'list_decks', args: {} },
          ],
          finish: 'tool_calls',
        },
        { content: ['All done.'], finish: 'stop' },
      ]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);

    const frames = await readSse(await streamReq(cookie, convId, 'search everything'));

    // All tool_call frames go out up-front, in batch order.
    const callFrames = frames.filter((f) => f.event === 'tool_call');
    expect(callFrames.map((f) => (f.data as { id: string }).id)).toEqual([
      'call_slow',
      'call_fast',
      'call_decks',
    ]);

    // Result frames arrive per-completion: the slow call's result lands LAST
    // even though it was first in the batch (proves concurrency).
    const resultIds = frames
      .filter((f) => f.event === 'tool_result')
      .map((f) => (f.data as { id: string }).id);
    expect(resultIds).toHaveLength(3);
    expect(resultIds[2]).toBe('call_slow');
    expect(frames.some((f) => f.event === 'done')).toBe(true);

    // Persisted shape: ONE assistant tool_calls row (batch order) + role:tool
    // rows in batch order, regardless of completion interleaving.
    const rows = await transcriptRows(convId);
    const toolCallsRow = rows.find((r) => r.role === 'assistant' && (r.toolCalls?.length ?? 0) > 0);
    expect(toolCallsRow!.toolCalls!.map((tc) => tc.id)).toEqual([
      'call_slow',
      'call_fast',
      'call_decks',
    ]);
    const toolRowIds = rows.filter((r) => r.role === 'tool').map((r) => r.toolCallId);
    expect(toolRowIds).toEqual(['call_slow', 'call_fast', 'call_decks']);
  });

  test('mixed batch: reads execute first (fully answered), then the write pauses; resume yields clean history', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const convId = await createConversation(cookie);

    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        {
          toolCalls: [
            { id: 'call_read', name: 'list_decks', args: {} },
            {
              id: 'call_write',
              name: 'create_card',
              args: { deckId, fieldValues: { Front: 'Q', Back: 'A' } },
            },
          ],
          finish: 'tool_calls',
        },
        { content: ['Card created.'], finish: 'stop' },
      ]),
    });

    const frames = await readSse(await streamReq(cookie, convId, 'list decks and add a card'));

    // The read executed (ok result) BEFORE the write paused the turn.
    const readResult = frames.find(
      (f) => f.event === 'tool_result' && (f.data as { id: string }).id === 'call_read',
    );
    expect(readResult).toBeDefined();
    expect((readResult!.data as { ok: boolean }).ok).toBe(true);
    const confirmIdx = frames.findIndex((f) => f.event === 'await_confirmation');
    expect(confirmIdx).toBeGreaterThan(frames.indexOf(readResult!));
    expect(frames.some((f) => f.event === 'done')).toBe(false);

    // Persisted: user → assistant(tool_calls=[read]) → tool(read) →
    // assistant(tool_calls=[write], pending). No text row yet.
    const rows = await transcriptRows(convId);
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(rows[1]!.toolCalls!.map((tc) => tc.id)).toEqual(['call_read']);
    expect(rows[2]!.toolCallId).toBe('call_read');
    expect(rows[3]!.toolCalls!.map((tc) => tc.id)).toEqual(['call_write']);

    // Resume-apply continues to done; the model-facing history contains the
    // fully-answered read row + the answered write row (valid OpenAI shape).
    const resumeFrames = await readSse(
      await resumeReq(cookie, convId, { resumeToolCallId: 'call_write', decision: 'apply' }),
    );
    expect(resumeFrames.some((f) => f.event === 'done')).toBe(true);

    const continuation = capturedAgentMessages.at(-1)!;
    const roles = continuation.map((m) =>
      m.role === 'assistant' && m.tool_calls ? 'assistant+tools' : m.role,
    );
    expect(roles).toEqual([
      'system',
      'user',
      'assistant+tools', // the read batch
      'tool', // its answer
      'assistant+tools', // the pending write
      'tool', // the apply result
    ]);

    // The card actually exists.
    const cardRows = await db.select().from(cardsTable).where(eq(cardsTable.deckId, deckId));
    expect(cardRows.length).toBeGreaterThan(0);
  });

  test('a failing read does not poison its siblings', async () => {
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        {
          toolCalls: [
            { id: 'call_bad', name: 'no_such_tool', args: {} },
            { id: 'call_ok', name: 'list_decks', args: {} },
          ],
          finish: 'tool_calls',
        },
        { content: ['Partial success.'], finish: 'stop' },
      ]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);

    const frames = await readSse(await streamReq(cookie, convId, 'do things'));
    const results = new Map(
      frames
        .filter((f) => f.event === 'tool_result')
        .map((f) => [(f.data as { id: string }).id, f.data as { ok: boolean }]),
    );
    expect(results.get('call_bad')!.ok).toBe(false);
    expect(results.get('call_ok')!.ok).toBe(true);
    expect(frames.some((f) => f.event === 'done')).toBe(true);

    const rows = await transcriptRows(convId);
    const toolRowIds = rows.filter((r) => r.role === 'tool').map((r) => r.toolCallId);
    expect(toolRowIds).toEqual(['call_bad', 'call_ok']);
  });
});
