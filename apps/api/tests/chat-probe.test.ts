import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { db, messages as messagesTable } from '@reomi/db';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import {
  __resetAiClientForTests,
  __setAiClientForTests,
  type AgentStreamChunk,
} from '../src/ai/openai-client.ts';
import { __setChatUpstreamFetchForTests, UpstreamChatError } from '../src/ai/chat-upstream.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

async function createConversation(cookie: string): Promise<string> {
  const res = await callApp(app, 'POST', '/chat/conversations', { cookie, body: {} });
  expect(res.status).toBe(200);
  return (await res.json<{ id: string }>()).id;
}

async function stream(cookie: string, convId: string, content: string): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/chat/conversations/${convId}/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ content }),
    }),
  );
}

async function readSse(res: Response): Promise<{ event: string; data: { message?: string } }[]> {
  const text = await res.text();
  const frames: { event: string; data: { message?: string } }[] = [];
  for (const raw of text.split('\n\n')) {
    if (!raw.trim()) continue;
    let event = 'message';
    let data = '';
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    frames.push({ event, data: data ? JSON.parse(data) : {} });
  }
  return frames;
}

async function userCount(convId: string): Promise<number> {
  const rows = await db
    .select({ role: messagesTable.role })
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, convId));
  return rows.filter((row) => row.role === 'user').length;
}

describe('GET /ai/chat-probe', () => {
  beforeEach(async () => {
    await resetTestDb();
    __resetAiClientForTests();
    __setChatUpstreamFetchForTests(null);
  });

  afterEach(() => {
    __resetAiClientForTests();
    __setChatUpstreamFetchForTests(null);
  });

  test('unauthenticated probe is 401', async () => {
    let calls = 0;
    __setChatUpstreamFetchForTests(async () => {
      calls += 1;
      throw new Error('fetch should not run');
    });
    const res = await callApp(app, 'GET', '/ai/chat-probe');
    expect(res.status).toBe(401);
    expect(calls).toBe(0);
  });

  test('disabled chat does not fetch', async () => {
    let calls = 0;
    __setChatUpstreamFetchForTests(async () => {
      calls += 1;
      throw new Error('fetch should not run');
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const res = await callApp(app, 'GET', '/ai/chat-probe', { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, state: 'disabled' });
    expect(calls).toBe(0);
  });

  test('HTML 404 is unavailable and the body has no URL or key', async () => {
    const secretUrl = 'https://secret.example/models';
    const secretKey = 'sk-live-test-key';
    let calls = 0;
    __setChatUpstreamFetchForTests(async (input, init) => {
      calls += 1;
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('manual');
      expect(String(input).endsWith('/models')).toBe(true);
      return new Response(`<html>${secretUrl} Bearer ${secretKey}</html>`, {
        status: 404,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });
    __setAiClientForTests({
      chatStream: async function* () {
        yield 'unused';
      },
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const res = await callApp(app, 'GET', '/ai/chat-probe', { cookie });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ ok: false, state: 'unavailable' });
    expect(text).not.toContain(secretUrl);
    expect(text).not.toContain(secretKey);
    expect(text).not.toContain('http');
    expect(text).not.toContain('Bearer');
    expect(calls).toBe(1);
  });
});

describe('chat upstream policy', () => {
  beforeEach(async () => {
    await resetTestDb();
    __resetAiClientForTests();
    __setChatUpstreamFetchForTests(null);
  });

  afterEach(() => {
    __resetAiClientForTests();
  });

  test('an upstream failure before the user row is 503 ai_unavailable', async () => {
    __setAiClientForTests({
      chatStreamAgentic: async function* (): AsyncIterable<AgentStreamChunk> {
        yield { type: 'content', text: 'ok' };
        yield { type: 'finish', reason: 'stop' };
      },
      complete: async () => {
        throw new UpstreamChatError({ status: null, html: false });
      },
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    const res = await stream(cookie, convId, 'Use only these materials');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'ai_unavailable' });
    expect(await userCount(convId)).toBe(0);
  });

  test('a transport failure before the user row is 503 ai_unavailable', async () => {
    __setAiClientForTests({
      chatStreamAgentic: async function* (): AsyncIterable<AgentStreamChunk> {
        yield { type: 'finish', reason: 'stop' };
      },
      complete: async () => {
        throw new TypeError('fetch failed');
      },
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    const res = await stream(cookie, convId, 'Use only these materials');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'ai_unavailable' });
    expect(await userCount(convId)).toBe(0);
  });

  test('an ordinary policy failure stays selection_required', async () => {
    __setAiClientForTests({
      chatStreamAgentic: async function* (): AsyncIterable<AgentStreamChunk> {
        yield { type: 'finish', reason: 'stop' };
      },
      complete: async () => {
        throw new Error('offline');
      },
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    const res = await stream(cookie, convId, 'Use only these materials');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'context_policy_selection_required' });
    expect(await userCount(convId)).toBe(0);
  });

  test('a 404 upstream error on the stream is ai_unavailable', async () => {
    __setAiClientForTests({
      chatStreamAgentic: async function* (): AsyncIterable<AgentStreamChunk> {
        throw new UpstreamChatError({ status: 404, html: false });
      },
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    const res = await stream(cookie, convId, 'hello');
    expect(res.status).toBe(200);
    const frames = await readSse(res);
    expect(frames.find((frame) => frame.event === 'error')?.data.message).toBe('ai_unavailable');
  });
});
