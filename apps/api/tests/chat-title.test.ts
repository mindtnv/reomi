// C3 — conversation auto-titling integration tests.
//
// CONTRACT (read from apps/api/src/modules/ai.ts + ai/title.ts):
//   * On `/stream` (and `/regenerate`) over a conversation whose `title IS
//     NULL`, a non-streaming `complete()` call generates a short title from the
//     OLDEST user message, concurrently with the agent turn. After the turn:
//     UPDATE … WHERE title IS NULL (a concurrent manual rename wins) → emit
//     `{type:'title', title}` BEFORE `done`.
//   * Best-effort: a rejecting/absent `complete` (every pre-existing test fake)
//     skips titling silently — the turn still completes.
//   * `/resume` does NOT title (a resume implies a prior /stream attempt; the
//     `title IS NULL` gate lets the next turn retry).
//   * Normalization: quotes/newlines stripped, trailing punctuation dropped,
//     clamped to 60 chars.
//
// Harness: the scripted agent fake + an injectable `complete` member
// (`__setAiClientForTests({ chatStreamAgentic, complete })`).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { conversations, db } from '@reomi/db';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import {
  __resetAiClientForTests,
  __setAiClientForTests,
  type AgentChatMessage,
  type AgentStreamChunk,
  type ChatMessage,
} from '../src/ai/openai-client.ts';
import { normalizeTitle } from '../src/ai/title.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

// ── Scripted fakes ────────────────────────────────────────────────────────────

interface AgentTurn {
  content?: string[];
  finish: 'stop' | 'tool_calls';
}
function scriptedAgentStream(script: AgentTurn[]) {
  let call = 0;
  return async function* (_m: AgentChatMessage[]): AsyncIterable<AgentStreamChunk> {
    const turn = script[call++];
    if (!turn) {
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    for (const c of turn.content ?? []) yield { type: 'content', text: c };
    yield { type: 'finish', reason: turn.finish };
  };
}

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

async function createConversation(cookie: string, title?: string): Promise<string> {
  const res = await callApp(app, 'POST', '/chat/conversations', {
    cookie,
    body: title ? { title } : {},
  });
  return (await res.json<{ id: string }>()).id;
}
function streamReq(cookie: string, convId: string, content: string): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/chat/conversations/${convId}/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ content }),
    }),
  );
}
function regenReq(cookie: string, convId: string): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/chat/conversations/${convId}/regenerate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({}),
    }),
  );
}

async function dbTitle(convId: string): Promise<string | null> {
  const [row] = await db
    .select({ title: conversations.title })
    .from(conversations)
    .where(eq(conversations.id, convId))
    .limit(1);
  return row?.title ?? null;
}

describe('agentic chat — auto-titling (C3)', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('untitled conversation: title frame before done + persisted; the prompt carries the first user message', async () => {
    const completeCalls: ChatMessage[][] = [];
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([{ content: ['Answer.'], finish: 'stop' }]),
      complete: async (messages) => {
        completeCalls.push(messages);
        return '"FSRS scheduling basics."\n';
      },
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie); // no title

    const frames = await readSse(await streamReq(cookie, convId, 'How does FSRS scheduling work?'));
    const titleIdx = frames.findIndex((f) => f.event === 'title');
    const doneIdx = frames.findIndex((f) => f.event === 'done');
    expect(titleIdx).toBeGreaterThan(-1);
    expect(doneIdx).toBeGreaterThan(titleIdx);
    // Normalized: quotes + trailing punctuation stripped.
    expect((frames[titleIdx]!.data as { title: string }).title).toBe('FSRS scheduling basics');

    expect(await dbTitle(convId)).toBe('FSRS scheduling basics');
    // The titling prompt saw the user's first message.
    expect(completeCalls).toHaveLength(1);
    expect(completeCalls[0]!.some((m) => m.content.includes('How does FSRS scheduling work?'))).toBe(
      true,
    );
  });

  test('already-titled conversation: no complete() call, no title frame', async () => {
    let completeCalls = 0;
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([{ content: ['Hi.'], finish: 'stop' }]),
      complete: async () => {
        completeCalls += 1;
        return 'Should not happen';
      },
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie, 'Manual title');

    const frames = await readSse(await streamReq(cookie, convId, 'hello'));
    expect(frames.some((f) => f.event === 'title')).toBe(false);
    expect(completeCalls).toBe(0);
    expect(await dbTitle(convId)).toBe('Manual title');
  });

  test('failing complete(): turn still reaches done, title stays null (next turn retries)', async () => {
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        { content: ['First.'], finish: 'stop' },
        { content: ['Second.'], finish: 'stop' },
      ]),
      complete: async () => {
        throw new Error('gateway_down');
      },
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);

    const frames = await readSse(await streamReq(cookie, convId, 'first question'));
    expect(frames.some((f) => f.event === 'done')).toBe(true);
    expect(frames.some((f) => f.event === 'title')).toBe(false);
    expect(await dbTitle(convId)).toBeNull();
  });

  test('no complete member injected (pre-existing fakes): graceful skip', async () => {
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([{ content: ['Hi.'], finish: 'stop' }]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);

    const frames = await readSse(await streamReq(cookie, convId, 'hello'));
    expect(frames.some((f) => f.event === 'done')).toBe(true);
    expect(frames.some((f) => f.event === 'title')).toBe(false);
  });

  test('manual-rename race: a concurrent rename wins (title IS NULL guard)', async () => {
    // The complete() fake renames the conversation BEFORE returning — by the
    // time the title lands, the row is already titled → no clobber, no frame.
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([{ content: ['Hi.'], finish: 'stop' }]),
      complete: async () => {
        await callApp(app, 'PATCH', `/chat/conversations/${convId}`, {
          cookie,
          body: { title: 'User typed this' },
        });
        return 'Model title';
      },
    });

    const frames = await readSse(await streamReq(cookie, convId, 'hello'));
    expect(frames.some((f) => f.event === 'done')).toBe(true);
    expect(frames.some((f) => f.event === 'title')).toBe(false);
    expect(await dbTitle(convId)).toBe('User typed this');
  });

  test('regenerate titles a still-untitled thread (abort-tail recovery path)', async () => {
    // Turn 1: the stream tears post-flush (throwing fake) → user row persists,
    // no assistant row, NO title (complete also fails on turn 1).
    let allowTitle = false;
    __setAiClientForTests({
      chatStreamAgentic: (function () {
        let call = 0;
        return async function* (_m: AgentChatMessage[]): AsyncIterable<AgentStreamChunk> {
          call += 1;
          if (call === 1) {
            yield { type: 'content', text: 'par' };
            throw new Error('upstream_5xx');
          }
          yield { type: 'content', text: 'Recovered answer.' };
          yield { type: 'finish', reason: 'stop' };
        };
      })(),
      complete: async () => {
        if (!allowTitle) throw new Error('down');
        return 'Recovered thread';
      },
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);

    const tornFrames = await readSse(await streamReq(cookie, convId, 'doomed question'));
    expect(tornFrames.some((f) => f.event === 'error')).toBe(true);
    expect(await dbTitle(convId)).toBeNull();

    allowTitle = true;
    const frames = await readSse(await regenReq(cookie, convId));
    expect(frames.some((f) => f.event === 'done')).toBe(true);
    const titleFrame = frames.find((f) => f.event === 'title');
    expect((titleFrame!.data as { title: string }).title).toBe('Recovered thread');
    expect(await dbTitle(convId)).toBe('Recovered thread');
  });
});

describe('normalizeTitle (unit)', () => {
  test('strips quotes + trailing punctuation, collapses whitespace, clamps to 60', () => {
    expect(normalizeTitle('"Hello   world!"')).toBe('Hello world');
    expect(normalizeTitle('«Тайтл по-русски».')).toBe('Тайтл по-русски');
    expect(normalizeTitle('  \n ')).toBeNull();
    expect(normalizeTitle('x'.repeat(100))!.length).toBe(60);
    expect(normalizeTitle('No change')).toBe('No change');
  });
});
