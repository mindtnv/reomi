// fetch_page tool through the agent loop (deep research integration).
//
// The page reader is injected via `__setPageReaderForTests` (flips
// `isFetchPageEnabled()` on, exactly like the web-search provider seam), so the
// registry offers the tool and the scripted turn can call it. Covers: the slice
// header + links block on offset=0, offset continuation against the SAME cached
// crawl, the reader error surfaced as a graceful ok:false result, and the tool
// being absent when the reader is forced off.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { db, ensureBuiltins } from '@reomi/db';
import { buildApp } from '../src/app.ts';
import {
  __resetAiClientForTests,
  __setAiClientForTests,
  type AgentChatMessage,
  type AgentStreamChunk,
} from '../src/ai/openai-client.ts';
import {
  __resetPageReaderForTests,
  __setPageReaderForTests,
  type PageContent,
} from '../src/ai/page-reader.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

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
/** All `messages[]` arrays each chatStreamAgentic call observed (call order). */
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
  return app.handle(
    new Request(`http://localhost/chat/conversations/${convId}/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ content, ...extra }),
    }),
  );
}
async function createConversation(cookie: string): Promise<string> {
  const res = await callApp(app, 'POST', '/chat/conversations', { cookie, body: {} });
  expect(res.status).toBe(200);
  return (await res.json<{ id: string }>()).id;
}

const LONG_TEXT = `${'A'.repeat(3200)}${'B'.repeat(500)}`; // 3700 chars → 2 slices

function fakeReader() {
  let reads = 0;
  const reader = {
    async read(url: string): Promise<PageContent> {
      reads += 1;
      return {
        url,
        title: 'Bun Docs',
        text: LONG_TEXT,
        links: ['https://docs.example.com/api', 'https://docs.example.com/cli'],
      };
    },
  };
  return { reader, reads: () => reads };
}

describe('agentic chat — fetch_page (deep research)', () => {
  beforeEach(async () => {
    await resetTestDb();
    await ensureBuiltins(db);
    capturedAgentMessages = [];
  });
  afterEach(() => {
    __resetAiClientForTests();
    __resetPageReaderForTests();
  });

  test('first slice carries title header, continuation hint and the links block', async () => {
    const { reader } = fakeReader();
    __setPageReaderForTests(reader);
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        toolTurn([{ id: 'f1', name: 'fetch_page', args: { url: 'https://docs.example.com/guide' } }]),
        answerTurn('Read it.'),
      ]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    const frames = await readSse(await streamReq(cookie, convId, 'study this page'));

    const result = frames.find((f) => f.event === 'tool_result');
    expect(result).toBeTruthy();
    const data = result!.data as { ok: boolean; summary?: string };
    expect(data.ok).toBe(true);
    const summary = data.summary ?? '';
    expect(summary).toContain('«Bun Docs» — https://docs.example.com/guide');
    expect(summary).toContain('chars 0–3200 of 3700');
    expect(summary).toContain('offset=3200');
    expect(summary).toContain('Links on this page:');
    expect(summary).toContain('https://docs.example.com/api');
    expect(frames.some((f) => f.event === 'done')).toBe(true);
  });

  test('offset continuation reads the SAME cached crawl (no second reader.read)', async () => {
    const { reader, reads } = fakeReader();
    __setPageReaderForTests(reader);
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        toolTurn([{ id: 'f1', name: 'fetch_page', args: { url: 'https://docs.example.com/guide' } }]),
        toolTurn([
          {
            id: 'f2',
            name: 'fetch_page',
            args: { url: 'https://docs.example.com/guide', offset: 3200 },
          },
        ]),
        answerTurn('Done reading.'),
      ]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    const frames = await readSse(await streamReq(cookie, convId, 'study it all'));

    const results = frames.filter((f) => f.event === 'tool_result');
    expect(results.length).toBe(2);
    const second = results[1]!.data as { ok: boolean; summary?: string };
    expect(second.ok).toBe(true);
    expect(second.summary).toContain('chars 3200–3700 of 3700 — end of page');
    expect(second.summary).toContain('BBBB');
    // The links block only renders on the first slice.
    expect(second.summary).not.toContain('Links on this page:');
    // ONE crawl for both slices — the cache served the continuation.
    expect(reads()).toBe(1);
  });

  test('reader failure → graceful ok:false tool result, loop continues to done', async () => {
    __setPageReaderForTests({
      async read(): Promise<PageContent> {
        throw new Error('exa could not fetch the page (CRAWL_NOT_FOUND)');
      },
    });
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        toolTurn([{ id: 'f1', name: 'fetch_page', args: { url: 'https://gone.example.com/' } }]),
        answerTurn('That page is unreachable.'),
      ]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    const frames = await readSse(await streamReq(cookie, convId, 'read this'));

    const result = frames.find((f) => f.event === 'tool_result');
    expect((result!.data as { ok: boolean }).ok).toBe(false);
    expect((result!.data as { summary?: string }).summary).toContain('CRAWL_NOT_FOUND');
    expect(frames.some((f) => f.event === 'done')).toBe(true);
    expect(frames.some((f) => f.event === 'error')).toBe(false);
  });

  test('deep-research MODE: prompt section present + the loop runs past the normal 8-step cap', async () => {
    const { reader } = fakeReader();
    __setPageReaderForTests(reader);
    // 10 read rounds then an answer: under the DEFAULT cap (AGENT_MAX_STEPS=8)
    // the loop exhausts its steps and falls back to the step-limit message; in
    // research mode (RESEARCH_MAX_STEPS=16) all rounds run and the real answer
    // lands.
    const tenRounds = Array.from({ length: 10 }, (_, i) =>
      toolTurn([
        {
          id: `f${i}`,
          name: 'fetch_page',
          args: { url: `https://docs.example.com/page-${i}` },
        },
      ]),
    );
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([...tenRounds, answerTurn('Research complete.')]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    const frames = await readSse(
      await streamReq(cookie, convId, 'study these docs deeply', { research: true }),
    );

    // The research-mode prompt section reached the model on the FIRST step.
    const system = capturedAgentMessages[0]![0]!;
    expect(system.role).toBe('system');
    expect(String(system.content)).toContain('<deep_research_mode>');

    // All 10 read rounds executed (> the default 8-step ceiling) and the real
    // answer closed the turn.
    const results = frames.filter((f) => f.event === 'tool_result');
    expect(results.length).toBe(10);
    expect(results.every((f) => (f.data as { ok: boolean }).ok)).toBe(true);
    expect(frames.some((f) => f.event === 'done')).toBe(true);
    const tokens = frames
      .filter((f) => f.event === 'token')
      .map((f) => (f.data as { delta: string }).delta)
      .join('');
    expect(tokens).toContain('Research complete.');
  });

  test('without the research flag the same 10-round script hits the default step cap', async () => {
    const { reader } = fakeReader();
    __setPageReaderForTests(reader);
    const tenRounds = Array.from({ length: 10 }, (_, i) =>
      toolTurn([
        { id: `f${i}`, name: 'fetch_page', args: { url: `https://docs.example.com/p-${i}` } },
      ]),
    );
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([...tenRounds, answerTurn('never reached')]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    const frames = await readSse(await streamReq(cookie, convId, 'study these docs deeply'));

    // No research-mode section in the system prompt.
    expect(String(capturedAgentMessages[0]![0]!.content)).not.toContain('<deep_research_mode>');
    // The loop stopped at the default ceiling — fewer rounds than scripted.
    const results = frames.filter((f) => f.event === 'tool_result');
    expect(results.length).toBeLessThan(10);
    expect(frames.some((f) => f.event === 'done')).toBe(true);
  });

  test('forced-off reader → fetch_page is not offered, a scripted call errors as unknown tool', async () => {
    __setPageReaderForTests(null);
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        toolTurn([{ id: 'f1', name: 'fetch_page', args: { url: 'https://docs.example.com/' } }]),
        answerTurn('No fetch available.'),
      ]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    const frames = await readSse(await streamReq(cookie, convId, 'read this'));

    const result = frames.find((f) => f.event === 'tool_result');
    expect((result!.data as { ok: boolean }).ok).toBe(false);
    expect((result!.data as { summary?: string }).summary).toContain('unknown tool');
  });
});
