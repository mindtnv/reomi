// C1 — token-usage accounting integration tests.
//
// CONTRACT (read from apps/api/src/modules/ai.ts + ai/openai-client.ts):
//   * The gateway's `stream_options: { include_usage: true }` final chunk
//     (OpenAI sends it with `choices: []`, AFTER finish_reason) is parsed into
//     an AgentStreamChunk `{ type:'usage', promptTokens, completionTokens,
//     totalTokens }` — the scripted fake mirrors that wire order by yielding
//     usage AFTER `finish`.
//   * `runAgentTurn` accumulates usage across ALL steps of a turn and:
//       - emits ONE SSE `usage` frame (after `citation`, before `done`);
//       - persists the totals on the LAST assistant row of the transcript —
//         the final text row at `done`, or the pending tool_calls row of a
//         suspended turn (the resume continuation then persists its own);
//       - stamps the EFFECTIVE model (picker choice or env default) on every
//         assistant row.
//   * Provider reports nothing → NO usage frame, NULL usage column (zeros and
//     absence are distinguishable).
//
// Same in-process / injection harness as agent-chat.test.ts.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { db, ensureBuiltins, messages as messagesTable } from '@reomi/db';
import { asc, eq } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import {
  __resetAiClientForTests,
  __setAiClientForTests,
  type AgentChatMessage,
  type AgentStreamChunk,
} from '../src/ai/openai-client.ts';
import { __setChatModelsForTests } from '../src/modules/ai.ts';
import { env } from '../src/env.ts';
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

// ── Scripted agentic fake (usage-aware) ───────────────────────────────────────

interface ToolCallScript {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
interface AgentTurn {
  content?: string[];
  toolCalls?: ToolCallScript[];
  finish: 'stop' | 'tool_calls';
  /** Yielded AFTER `finish` — mirrors the real wire order of include_usage. */
  usage?: { prompt: number; completion: number };
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
      const argsJson = JSON.stringify(tc.args);
      yield { type: 'tool_call_delta', index, id: tc.id, name: tc.name };
      yield { type: 'tool_call_delta', index, argsFragment: argsJson };
      index += 1;
    }
    yield { type: 'finish', reason: turn.finish };
    if (turn.usage) {
      yield {
        type: 'usage',
        promptTokens: turn.usage.prompt,
        completionTokens: turn.usage.completion,
        totalTokens: turn.usage.prompt + turn.usage.completion,
      };
    }
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

async function streamReq(
  cookie: string,
  convId: string,
  content: string,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  const req = new Request(`http://localhost/chat/conversations/${convId}/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ content, ...extra }),
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

/** Rows of a conversation, oldest-first (the persisted transcript). */
async function transcriptRows(convId: string) {
  return db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, convId))
    .orderBy(asc(messagesTable.createdAt));
}

describe('agentic chat — token usage accounting (C1)', () => {
  beforeEach(async () => {
    await resetTestDb();
    await ensureBuiltins(db);
  });
  afterEach(() => {
    __resetAiClientForTests();
    __setChatModelsForTests(undefined);
  });

  test('single-step turn: usage frame before done + persisted usage/model on the answer row', async () => {
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        { content: ['Hello!'], finish: 'stop', usage: { prompt: 10, completion: 20 } },
      ]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);

    const frames = await readSse(await streamReq(cookie, convId, 'hi'));
    const usageIdx = frames.findIndex((f) => f.event === 'usage');
    const doneIdx = frames.findIndex((f) => f.event === 'done');
    expect(usageIdx).toBeGreaterThan(-1);
    expect(doneIdx).toBeGreaterThan(usageIdx);
    expect(frames[usageIdx]!.data).toEqual({
      type: 'usage',
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
    });

    const rows = await transcriptRows(convId);
    const answer = rows.find((r) => r.role === 'assistant' && r.content === 'Hello!');
    expect(answer).toBeDefined();
    expect(answer!.usage).toEqual({ promptTokens: 10, completionTokens: 20, totalTokens: 30 });
    // No allow-list + no body model ⇒ the env default is the effective model.
    expect(answer!.model).toBe(env.ai.CHAT_MODEL);
  });

  test('multi-step turn: usage accumulates across steps; intermediate tool_calls row carries model but no usage', async () => {
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        {
          toolCalls: [{ id: 'call_ld', name: 'list_decks', args: {} }],
          finish: 'tool_calls',
          usage: { prompt: 5, completion: 7 },
        },
        { content: ['Done.'], finish: 'stop', usage: { prompt: 11, completion: 13 } },
      ]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);

    const frames = await readSse(await streamReq(cookie, convId, 'what decks do I have?'));
    const usageFrames = frames.filter((f) => f.event === 'usage');
    expect(usageFrames).toHaveLength(1);
    expect(usageFrames[0]!.data).toEqual({
      type: 'usage',
      promptTokens: 16,
      completionTokens: 20,
      totalTokens: 36,
    });

    const rows = await transcriptRows(convId);
    const toolCallsRow = rows.find((r) => r.role === 'assistant' && (r.toolCalls?.length ?? 0) > 0);
    const answer = rows.find((r) => r.role === 'assistant' && r.content === 'Done.');
    expect(toolCallsRow!.usage).toBeNull();
    expect(toolCallsRow!.model).toBe(env.ai.CHAT_MODEL);
    expect(answer!.usage).toEqual({ promptTokens: 16, completionTokens: 20, totalTokens: 36 });
  });

  test('provider reports no usage: no frame, null column', async () => {
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([{ content: ['Hi.'], finish: 'stop' }]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);

    const frames = await readSse(await streamReq(cookie, convId, 'hello'));
    expect(frames.some((f) => f.event === 'usage')).toBe(false);
    expect(frames.some((f) => f.event === 'done')).toBe(true);

    const rows = await transcriptRows(convId);
    const answer = rows.find((r) => r.role === 'assistant');
    expect(answer!.usage).toBeNull();
  });

  test('suspended turn parks usage-so-far on the pending tool_calls row; resume persists its own', async () => {
    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        {
          toolCalls: [
            {
              id: 'call_w',
              name: 'create_card',
              args: { deckId: '', fieldValues: { Front: 'Q', Back: 'A' } },
            },
          ],
          finish: 'tool_calls',
          usage: { prompt: 3, completion: 4 },
        },
        { content: ['Created.'], finish: 'stop', usage: { prompt: 5, completion: 6 } },
      ]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const convId = await createConversation(cookie);

    // Patch the scripted args with the real deck id by re-injecting (the script
    // above was built before the deck existed — rebuild it).
    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        {
          toolCalls: [
            {
              id: 'call_w',
              name: 'create_card',
              args: { deckId, fieldValues: { Front: 'Q', Back: 'A' } },
            },
          ],
          finish: 'tool_calls',
          usage: { prompt: 3, completion: 4 },
        },
        { content: ['Created.'], finish: 'stop', usage: { prompt: 5, completion: 6 } },
      ]),
    });

    const frames = await readSse(await streamReq(cookie, convId, 'make a card'));
    expect(frames.some((f) => f.event === 'await_confirmation')).toBe(true);
    expect(frames.some((f) => f.event === 'done')).toBe(false);
    // The suspended turn emits NO usage frame (the turn isn't over)…
    expect(frames.some((f) => f.event === 'usage')).toBe(false);

    // …but the pending tool_calls row carries the usage-so-far.
    let rows = await transcriptRows(convId);
    const pending = rows.find((r) => r.role === 'assistant' && (r.toolCalls?.length ?? 0) > 0);
    expect(pending!.usage).toEqual({ promptTokens: 3, completionTokens: 4, totalTokens: 7 });

    const resumeFrames = await readSse(
      await resumeReq(cookie, convId, { resumeToolCallId: 'call_w', decision: 'apply' }),
    );
    const usageFrame = resumeFrames.find((f) => f.event === 'usage');
    expect(usageFrame!.data).toEqual({
      type: 'usage',
      promptTokens: 5,
      completionTokens: 6,
      totalTokens: 11,
    });

    rows = await transcriptRows(convId);
    const answer = rows.find((r) => r.role === 'assistant' && r.content === 'Created.');
    expect(answer!.usage).toEqual({ promptTokens: 5, completionTokens: 6, totalTokens: 11 });
    // Sum over assistant rows = true turn totals (3+5 / 4+6).
  });

  test('per-turn picker model is persisted on the answer row', async () => {
    __setChatModelsForTests('m-fast|Fast,m-deep|Deep');
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        { content: ['Deep answer.'], finish: 'stop', usage: { prompt: 1, completion: 2 } },
      ]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);

    const frames = await readSse(await streamReq(cookie, convId, 'think hard', { model: 'm-deep' }));
    expect(frames.some((f) => f.event === 'done')).toBe(true);

    const rows = await transcriptRows(convId);
    const answer = rows.find((r) => r.role === 'assistant');
    expect(answer!.model).toBe('m-deep');
  });
});
