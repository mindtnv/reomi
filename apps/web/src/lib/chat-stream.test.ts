import { afterEach, describe, expect, test } from 'bun:test';
import { ApiError } from './api.ts';
import { regenerateChat, streamChat } from './chat-stream.ts';
import { learnerChatCopyKey } from './learner-chat-copy.ts';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('chat stream failure correlation', () => {
  test('typed context and revision are serialized intact; ordinary regeneration does not replace context', async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return new Response('event: done\ndata: {"messageId":"saved"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    const context = { version: 1 as const, policy: 'strict' as const, refs: [] };
    await streamChat('conversation', 'hello', {}, { context, expectedContextRevision: 4 });
    expect(bodies[0].context).toEqual(context);
    expect(bodies[0].expectedContextRevision).toBe(4);
    await regenerateChat('conversation', {}, {});
    expect(bodies[1].context).toBeUndefined();
    await regenerateChat('conversation', { context, policySelection: 'strict', expectedContextRevision: 4 }, {});
    expect(bodies[2].context).toEqual(context);
    expect(bodies[2].policySelection).toBe('strict');
  });
  test('non-success responses surface a typed error with request correlation', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: 'chat_upstream_failed' }), {
        status: 503,
        headers: { 'x-request-id': 'chat-503' },
      })) as unknown as typeof fetch;

    let received: { message: string; error?: ApiError } | undefined;
    await streamChat('conversation', 'hello', {
      onError: (message, error) => {
        received = { message, error };
      },
    });

    expect(received?.error).toBeInstanceOf(ApiError);
    expect(received?.error).toMatchObject({ status: 503, requestId: 'chat-503' });
    expect(received?.message).toContain('chat-503');
  });

  test('an SSE error frame keeps the wire code beside the request id', async () => {
    globalThis.fetch = (async () =>
      new Response('event: error\ndata: {"type":"error","message":"ai_unavailable"}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'x-request-id': 'req_1' },
      })) as unknown as typeof fetch;

    let received: { message: string; error?: ApiError } | undefined;
    await streamChat('conversation', 'hello', {
      onError: (message, error) => {
        received = { message, error };
      },
    });

    expect(received?.error?.safeMessage).toBe('ai_unavailable');
    expect(received?.error?.status).toBe(500);
    expect(received?.error?.requestId).toBe('req_1');
    expect(received?.message).toContain('req_1');
    expect(learnerChatCopyKey(received!.error!.safeMessage)).toBe('assistant.errors.ai_unavailable');
    expect(learnerChatCopyKey(received!.message)).toBe('chat.errors.generic');
  });

  test('a deliberate abort keeps the specialized silent behavior', async () => {
    globalThis.fetch = (async () => {
      throw new DOMException('aborted', 'AbortError');
    }) as unknown as typeof fetch;
    let errorCalls = 0;

    await streamChat('conversation', 'hello', {
      onError: () => {
        errorCalls += 1;
      },
    });

    expect(errorCalls).toBe(0);
  });
});

test('context-aware sends never fall through to an older unversioned mutation route',async()=>{
  let legacyWrites=0;const failures:string[]=[];
  globalThis.fetch=(async input=>{
    if(String(input).includes('/chat/conversations/')){legacyWrites++;return new Response('event: done\ndata: {"type":"done","messageId":"legacy"}\n\n',{headers:{'content-type':'text/event-stream'}});}
    return Response.json({error:'NotFound'},{status:404});
  }) as typeof fetch;
  await streamChat('conversation','Keep my context',{onError:message=>failures.push(message)},{context:{version:1,policy:'strict',refs:[]}});
  expect(legacyWrites).toBe(0);expect(failures).toEqual(['context_unsupported']);
});
