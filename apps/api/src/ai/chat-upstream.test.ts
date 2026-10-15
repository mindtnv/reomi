import { afterEach, describe, expect, test } from 'bun:test';
import { AiDisabledError } from './openai-client.ts';
import {
  __setChatUpstreamFetchForTests,
  judgeChatUpstream,
  learnerCodeForThrown,
  probeChatUpstream,
  requestChatCompletion,
  UpstreamChatError,
  type ChatUpstreamObservation,
} from './chat-upstream.ts';

afterEach(() => {
  __setChatUpstreamFetchForTests(null);
});

describe('judgeChatUpstream', () => {
  test('404 is unavailable', () => {
    expect(judgeChatUpstream({ status: 404, html: false })).toEqual({ kind: 'unavailable' });
  });

  test('503 is unavailable', () => {
    expect(judgeChatUpstream({ status: 503, html: false })).toEqual({ kind: 'unavailable' });
  });

  test('HTML 200 is unavailable', () => {
    expect(judgeChatUpstream({ status: 200, html: true })).toEqual({ kind: 'unavailable' });
  });

  test('HTML at a rejected status is unavailable', () => {
    expect(judgeChatUpstream({ status: 401, html: true })).toEqual({ kind: 'unavailable' });
  });

  test('a null status is unavailable', () => {
    expect(judgeChatUpstream({ status: null, html: false })).toEqual({ kind: 'unavailable' });
  });

  test('401 is rejected', () => {
    expect(judgeChatUpstream({ status: 401, html: false })).toEqual({ kind: 'rejected' });
  });

  test('200 JSON is reachable', () => {
    expect(judgeChatUpstream({ status: 200, html: false })).toEqual({ kind: 'reachable' });
  });
});

describe('learnerCodeForThrown', () => {
  test('upstream_5xx stays chat_failed', () => {
    expect(learnerCodeForThrown(new Error('upstream_5xx'))).toBe('chat_failed');
  });

  test('a legacy chat_failed:404 is ai_unavailable', () => {
    expect(learnerCodeForThrown(new Error('chat_failed:404'))).toBe('ai_unavailable');
  });

  test('a legacy complete_failed:401 is chat_failed', () => {
    expect(learnerCodeForThrown(new Error('complete_failed:401'))).toBe('chat_failed');
  });

  test('chat_stream_torn stays chat_stream_torn', () => {
    expect(learnerCodeForThrown(new Error('chat_stream_torn'))).toBe('chat_stream_torn');
  });

  test('fetch failed is ai_unavailable', () => {
    expect(learnerCodeForThrown(new TypeError('fetch failed'))).toBe('ai_unavailable');
  });

  test('a socket code on the cause is ai_unavailable', () => {
    const cause = Object.assign(new Error('socket'), { code: 'ECONNREFUSED' });
    expect(learnerCodeForThrown(new Error('wrapped', { cause }))).toBe('ai_unavailable');
  });

  test('a host written into the message is not a transport failure', () => {
    expect(learnerCodeForThrown(new Error('getaddrinfo ENOTFOUND evil.example'))).toBe('chat_failed');
  });

  test('an abort is not a transport failure', () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    expect(learnerCodeForThrown(abort)).toBe('chat_failed');
  });

  test('an unavailable observation is ai_unavailable', () => {
    expect(learnerCodeForThrown(new UpstreamChatError({ status: 404, html: false }))).toBe(
      'ai_unavailable',
    );
  });

  test('a rejected observation is chat_failed', () => {
    expect(learnerCodeForThrown(new UpstreamChatError({ status: 401, html: false }))).toBe(
      'chat_failed',
    );
  });

  test('a surprising reachable observation is chat_failed', () => {
    const observation: ChatUpstreamObservation = { status: 200, html: false };
    expect(learnerCodeForThrown(new UpstreamChatError(observation))).toBe('chat_failed');
  });

  test('the upstream error message does not carry the status', () => {
    expect(new UpstreamChatError({ status: 404, html: true }).message).toBe('upstream_chat');
  });

  test('AiDisabledError keeps its surface message', () => {
    expect(learnerCodeForThrown(new AiDisabledError('chat'))).toBe('ai_disabled:chat');
    expect(learnerCodeForThrown(new AiDisabledError('embedding'))).toBe('ai_disabled:embedding');
  });
});

describe('requestChatCompletion', () => {
  test('HTML and a failed fetch become an upstream observation without logging the URL', async () => {
    const sentinel = 'https://sentinel.example/v1/chat/completions';
    const logged: { fields: { status: number | null; html: boolean }; event: string }[] = [];
    const log = {
      error(fields: { status: number | null; html: boolean }, event: string) {
        logged.push({ fields, event });
      },
    };
    __setChatUpstreamFetchForTests(async () =>
      new Response('<html>https://secret.example sk-secret</html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    await expect(
      requestChatCompletion(sentinel, { method: 'POST' }, { log, event: 'ai.chat.failed', requireBody: true }),
    ).rejects.toMatchObject({
      message: 'upstream_chat',
      observation: { status: 200, html: true },
    });
    expect(logged).toEqual([{ fields: { status: 200, html: true }, event: 'ai.chat.failed' }]);
    expect(JSON.stringify(logged)).not.toContain('sentinel.example');
    expect(JSON.stringify(logged)).not.toContain('sk-secret');

    logged.length = 0;
    __setChatUpstreamFetchForTests(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(
      requestChatCompletion(sentinel, { method: 'POST' }, { log, event: 'ai.complete.failed' }),
    ).rejects.toMatchObject({ observation: { status: null, html: false } });
    expect(logged).toEqual([{ fields: { status: null, html: false }, event: 'ai.complete.failed' }]);

    logged.length = 0;
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    __setChatUpstreamFetchForTests(async () => {
      throw abort;
    });
    await expect(
      requestChatCompletion(sentinel, { method: 'POST' }, { log, event: 'ai.chat.failed' }),
    ).rejects.toBe(abort);
    expect(logged).toEqual([]);
  });
});

describe('probeChatUpstream', () => {
  test('HTML 404 is unavailable and the log omits the URL and key', async () => {
    const calls: { method?: string; redirect?: RequestRedirect; url: string }[] = [];
    __setChatUpstreamFetchForTests(async (input, init) => {
      calls.push({ method: init?.method, redirect: init?.redirect, url: String(input) });
      return new Response('<html>https://secret.example Bearer sk-secret</html>', {
        status: 404,
        headers: { 'content-type': 'text/html' },
      });
    });
    const logged: unknown[] = [];
    const body = await probeChatUpstream({
      info(fields, event) {
        logged.push({ fields, event });
      },
    });
    expect(body).toEqual({ ok: false, state: 'unavailable' });
    expect(logged).toEqual([
      { fields: { status: 404, html: true, kind: 'unavailable' }, event: 'ai.chat.probe' },
    ]);
    expect(JSON.stringify(body)).not.toContain('http');
    expect(JSON.stringify(logged)).not.toContain('secret');
    expect(JSON.stringify(logged)).not.toContain('sk-');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.redirect).toBe('manual');
    expect(calls[0]?.url.endsWith('/models')).toBe(true);
  });

  test('a JSON 200 is reachable and a JSON 401 is rejected', async () => {
    __setChatUpstreamFetchForTests(async () =>
      new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    expect(await probeChatUpstream({ info() {} })).toEqual({ ok: true });

    __setChatUpstreamFetchForTests(async () =>
      new Response('{"error":"no"}', { status: 401, headers: { 'content-type': 'application/json' } }),
    );
    expect(await probeChatUpstream({ info() {} })).toEqual({ ok: false, state: 'rejected' });
  });

  test('a fetch failure is unavailable', async () => {
    __setChatUpstreamFetchForTests(async () => {
      throw new TypeError('fetch failed');
    });
    const logged: { status: number | null; html: boolean; kind: string }[] = [];
    expect(
      await probeChatUpstream({
        info(fields) {
          logged.push(fields);
        },
      }),
    ).toEqual({ ok: false, state: 'unavailable' });
    expect(logged).toEqual([{ status: null, html: false, kind: 'unavailable' }]);
  });
});
