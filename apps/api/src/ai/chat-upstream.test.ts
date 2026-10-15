import { describe, expect, test } from 'bun:test';
import { AiDisabledError } from './openai-client.ts';
import {
  judgeChatUpstream,
  learnerCodeForThrown,
  UpstreamChatError,
  type ChatUpstreamObservation,
} from './chat-upstream.ts';

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
