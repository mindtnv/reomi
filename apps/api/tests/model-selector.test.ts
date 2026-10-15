// Model/reasoning selector integration tests (S2/S3 / AC2.1, AC2.2, AC2.3, AC2.5).
//
// `/ai/status` shape (models:[] when unset / parsed when set / no secret leak);
// stream body model validation (unknown → 400, absent → default, valid → threaded
// to chatStreamAgentic.opts.model on EVERY step); resume carries model. The
// allow-list is parsed once at module load, so the suite pins it via the
// `__setChatModelsForTests` seam (mirrors `__setAiClientForTests`).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { buildApp } from '../src/app.ts';
import {
  __resetAiClientForTests,
  __setAiClientForTests,
  type AgentChatMessage,
  type AgentChatStreamOpts,
  type AgentStreamChunk,
} from '../src/ai/openai-client.ts';
import { __setChatModelsForTests } from '../src/modules/ai.ts';
import { db, ensureBuiltins } from '@reomi/db';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

// ── Scripted fake that RECORDS the per-step opts.model ────────────────────────

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

let seenModels: (string | undefined)[] = [];
function modelRecordingStream(script: AgentTurn[]) {
  let call = 0;
  return async function* (
    _m: AgentChatMessage[],
    opts?: AgentChatStreamOpts,
  ): AsyncIterable<AgentStreamChunk> {
    seenModels.push(opts?.model);
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
async function drain(res: Response): Promise<void> {
  const reader = res.body!.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
}
async function createConversation(cookie: string): Promise<string> {
  const res = await callApp(app, 'POST', '/chat/conversations', { cookie, body: {} });
  return (await res.json<{ id: string }>()).id;
}
function streamReq(cookie: string, convId: string, body: Record<string, unknown>): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/chat/conversations/${convId}/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    }),
  );
}

describe('model selector — /ai/status', () => {
  beforeEach(async () => {
    await resetTestDb();
    seenModels = [];
  });
  afterEach(() => {
    __resetAiClientForTests();
    __setChatModelsForTests('');
  });

  test('/ai/status returns models:[] when CHAT_MODELS unset', async () => {
    __setChatModelsForTests('');
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const res = await callApp(app, 'GET', '/ai/status', { cookie });
    expect(res.status).toBe(200);
    const body = await res.json<{ models: unknown[] }>();
    expect(body.models).toEqual([]);
  });

  test('/ai/status returns the parsed allow-list when set', async () => {
    __setChatModelsForTests('fast|Быстро,deep|Глубоко');
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const res = await callApp(app, 'GET', '/ai/status', { cookie });
    const body = await res.json<{ models: { id: string; label: string; default: boolean }[] }>();
    expect(body.models).toEqual([
      { id: 'fast', label: 'Быстро', default: true },
      { id: 'deep', label: 'Глубоко', default: false },
    ]);
  });

  test('/ai/status leaks no secret (exact key set — no CHAT_API_KEY / base URL)', async () => {
    __setChatModelsForTests('fast|Быстро');
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const res = await callApp(app, 'GET', '/ai/status', { cookie });
    const body = await res.json<Record<string, unknown>>();
    const keys = Object.keys(body).sort();
    expect(keys).toEqual(
      [
        'assistant',
        'chatEnabled',
        'chatModel',
        'degraded',
        'embeddingDim',
        'embeddingEnabled',
        'embeddingModel',
        'fetchPageEnabled',
        'models',
        'notebooksEnabled',
        'visionEnabled',
        'webSearchEnabled',
      ].sort(),
    );
    const blob = JSON.stringify(body).toLowerCase();
    expect(blob).not.toContain('api_key');
    expect(blob).not.toContain('base_url');
    expect(blob).not.toContain('baseurl');
    // The model picker exposes only id/label/default — no `apiKey`-shaped field.
    for (const m of body.models as Record<string, unknown>[]) {
      expect(Object.keys(m).sort()).toEqual(['default', 'id', 'label']);
    }
  });
});

describe('model selector — stream body validation + threading', () => {
  beforeEach(async () => {
    await resetTestDb();
    // create_card now VALIDATES before pausing (validate-before-pause) — the
    // builtin Basic must exist or the write is answered as an error instead of
    // suspending, which would consume an extra script turn.
    await ensureBuiltins(db);
    seenModels = [];
  });
  afterEach(() => {
    __resetAiClientForTests();
    __setChatModelsForTests('');
  });

  test('stream body model unknown → 400 invalid_model', async () => {
    __setChatModelsForTests('fast|Быстро,deep|Глубоко');
    __setAiClientForTests({ chatStreamAgentic: modelRecordingStream([answerTurn('hi')]) });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    const res = await streamReq(cookie, convId, { content: 'hi', model: 'not-a-model' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_model');
    // Nothing flushed — the fake was never called.
    expect(seenModels.length).toBe(0);
  });

  test('stream body model absent → default model threaded', async () => {
    __setChatModelsForTests('fast|Быстро,deep|Глубоко');
    __setAiClientForTests({ chatStreamAgentic: modelRecordingStream([answerTurn('hi')]) });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    await drain(await streamReq(cookie, convId, { content: 'hi' }));
    expect(seenModels).toEqual(['fast']); // the default (first allow-list entry)
  });

  test('stream valid model → threaded to chatStreamAgentic.opts.model on EVERY step', async () => {
    __setChatModelsForTests('fast|Быстро,deep|Глубоко');
    __setAiClientForTests({
      chatStreamAgentic: modelRecordingStream([
        searchTurn([{ id: 'c1', name: 'study_stats', args: { scope: 'global' } }]),
        answerTurn('done'),
      ]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    await drain(await streamReq(cookie, convId, { content: 'stats', model: 'deep' }));
    // Two steps (tool round + final answer) — BOTH must carry the chosen model.
    expect(seenModels.length).toBe(2);
    expect(seenModels.every((m) => m === 'deep')).toBe(true);
  });

  test('no allow-list (unset) → any model accepted, threaded verbatim', async () => {
    __setChatModelsForTests('');
    __setAiClientForTests({ chatStreamAgentic: modelRecordingStream([answerTurn('hi')]) });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    // With NO allow-list, a supplied model is not rejected (back-compat) and is
    // threaded as-is (the gateway owns it).
    await drain(await streamReq(cookie, convId, { content: 'hi', model: 'whatever' }));
    expect(seenModels).toEqual(['whatever']);
  });

  test('resume body carries model → continuation uses it', async () => {
    __setChatModelsForTests('fast|Быстро,deep|Глубоко');
    // Turn 0: a write tool (create_card) → the loop SUSPENDS for confirmation.
    // Resume(apply) continues; both the apply-continuation step(s) must carry the
    // model the resume body sent.
    __setAiClientForTests({
      chatStreamAgentic: modelRecordingStream([
        searchTurn([
          { id: 'w1', name: 'create_card', args: { deckId: 'x', fieldValues: { Front: 'F', Back: 'B' } } },
        ]),
        answerTurn('created'),
      ]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckRes = await callApp(app, 'POST', '/decks', { cookie, body: { name: 'D' } });
    const deckId = (await deckRes.json<{ id: string }>()).id;
    const convId = await createConversation(cookie);

    // Stream until suspend (re-script with the real deckId).
    __setAiClientForTests({
      chatStreamAgentic: modelRecordingStream([
        searchTurn([
          { id: 'w1', name: 'create_card', args: { deckId, fieldValues: { Front: 'F', Back: 'B' } } },
        ]),
        answerTurn('created'),
      ]),
    });
    await drain(await streamReq(cookie, convId, { content: 'make a card', model: 'deep' }));
    expect(seenModels).toEqual(['deep']); // the suspend step used the chosen model
    seenModels = [];

    // Resume(apply) carrying model 'fast' → the continuation must thread 'fast'.
    const resumeRes = await app.handle(
      new Request(`http://localhost/chat/conversations/${convId}/resume`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ resumeToolCallId: 'w1', decision: 'apply', model: 'fast' }),
      }),
    );
    await drain(resumeRes);
    expect(seenModels.length).toBeGreaterThan(0);
    expect(seenModels.every((m) => m === 'fast')).toBe(true);
  });

  test('resume body model unknown → 400 invalid_model', async () => {
    __setChatModelsForTests('fast|Быстро');
    __setAiClientForTests({ chatStreamAgentic: modelRecordingStream([answerTurn('hi')]) });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    const res = await app.handle(
      new Request(`http://localhost/chat/conversations/${convId}/resume`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ resumeToolCallId: 'x', decision: 'apply', model: 'bogus' }),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_model');
  });
});
