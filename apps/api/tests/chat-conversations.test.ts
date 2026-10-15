// Conversation rename + regenerate + abort-tail integration tests
// (S5 / AC3.1, S6 / AC3.3, AC3.4). Same in-process injection harness as
// chat.test.ts (NODE_ENV=test forces real flags off; the injected fake flips
// isChatEnabled() on).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { db, messages as messagesTable } from '@reomi/db';
import { asc, eq } from 'drizzle-orm';
import { newUuidV7 } from '@reomi/shared';
import { buildApp } from '../src/app.ts';
import {
  __resetAiClientForTests,
  __setAiClientForTests,
  type AgentChatMessage,
  type AgentStreamChunk,
} from '../src/ai/openai-client.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

// ── Scripted fake ─────────────────────────────────────────────────────────────

interface ToolCallScript {
  id: string;
  name: string;
  args: Record<string, unknown>;
}
interface AgentTurn {
  content?: string[];
  toolCalls?: ToolCallScript[];
  finish: 'stop' | 'tool_calls';
  throwAfter?: string;
}
function answerTurn(text: string): AgentTurn {
  return { content: [text], finish: 'stop' };
}
function searchTurn(calls: ToolCallScript[]): AgentTurn {
  return { toolCalls: calls, finish: 'tool_calls' };
}
function errorTurn(firstDelta: string): AgentTurn {
  return { content: [firstDelta], finish: 'stop', throwAfter: firstDelta };
}
function scriptedAgentStream(script: AgentTurn[]) {
  let call = 0;
  return async function* (_m: AgentChatMessage[]): AsyncIterable<AgentStreamChunk> {
    const turn = script[call++];
    if (!turn) {
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    for (const c of turn.content ?? []) {
      yield { type: 'content', text: c };
      if (turn.throwAfter !== undefined && c === turn.throwAfter) {
        throw new Error('upstream_5xx');
      }
    }
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
// Edit-and-rerun (B2 / AC4.2): regenerate WITH an edited last-user `content`.
function regenReqWithContent(cookie: string, convId: string, content: string): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/chat/conversations/${convId}/regenerate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ content }),
    }),
  );
}
async function rows(convId: string) {
  return db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, convId))
    .orderBy(asc(messagesTable.createdAt), asc(messagesTable.id));
}

// ── S5 — rename (AC3.1) ───────────────────────────────────────────────────────

describe('PATCH /chat/conversations/:id — rename', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('renames; the list reflects it', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie, 'Old title');
    const res = await callApp(app, 'PATCH', `/chat/conversations/${convId}`, {
      cookie,
      body: { title: 'New title' },
    });
    expect(res.status).toBe(200);
    expect((await res.json<{ title: string }>()).title).toBe('New title');

    const list = await callApp(app, 'GET', '/chat/conversations', { cookie });
    const items = (await list.json<{ items: { id: string; title: string }[] }>()).items;
    expect(items.find((c) => c.id === convId)!.title).toBe('New title');
  });

  test('foreign conversation → 404', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const convId = await createConversation(a.cookie, 'A thread');
    const res = await callApp(app, 'PATCH', `/chat/conversations/${convId}`, {
      cookie: b.cookie,
      body: { title: 'hijack' },
    });
    expect(res.status).toBe(404);
    // Untouched.
    const list = await callApp(app, 'GET', '/chat/conversations', { cookie: a.cookie });
    const items = (await list.json<{ items: { title: string }[] }>()).items;
    expect(items[0]!.title).toBe('A thread');
  });

  test('empty title → 400 ValidationError', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    const res = await callApp(app, 'PATCH', `/chat/conversations/${convId}`, {
      cookie,
      body: { title: '' },
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('ValidationError');
  });

  test('over-200 title → 400 ValidationError', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    const res = await callApp(app, 'PATCH', `/chat/conversations/${convId}`, {
      cookie,
      body: { title: 'x'.repeat(201) },
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('ValidationError');
  });

  // ── C4 — pinned threads ──────────────────────────────────────────────────────

  test('pin/unpin round-trips and the list orders pinned first', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const older = await createConversation(cookie, 'Older');
    const newer = await createConversation(cookie, 'Newer');

    // Pin the OLDER one — it must jump above the newer despite older updatedAt.
    const res = await callApp(app, 'PATCH', `/chat/conversations/${older}`, {
      cookie,
      body: { pinned: true },
    });
    expect(res.status).toBe(200);
    expect((await res.json<{ pinned: boolean }>()).pinned).toBe(true);

    const list = await callApp(app, 'GET', '/chat/conversations', { cookie });
    const items = (await list.json<{ items: { id: string; pinned: boolean }[] }>()).items;
    expect(items.map((c) => c.id)).toEqual([older, newer]);
    expect(items[0]!.pinned).toBe(true);

    // Unpin → recency order restored.
    await callApp(app, 'PATCH', `/chat/conversations/${older}`, {
      cookie,
      body: { pinned: false },
    });
    const list2 = await callApp(app, 'GET', '/chat/conversations', { cookie });
    const items2 = (await list2.json<{ items: { id: string }[] }>()).items;
    expect(items2.map((c) => c.id)).toEqual([newer, older]);
  });

  test('pin-only PATCH does NOT bump updatedAt (recency must reflect activity)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie, 'T');
    const before = await callApp(app, 'GET', '/chat/conversations', { cookie });
    const updatedBefore = (await before.json<{ items: { updatedAt: string }[] }>()).items[0]!
      .updatedAt;

    const res = await callApp(app, 'PATCH', `/chat/conversations/${convId}`, {
      cookie,
      body: { pinned: true },
    });
    expect(res.status).toBe(200);
    expect((await res.json<{ updatedAt: string }>()).updatedAt).toBe(updatedBefore);
  });

  test('empty PATCH body → 400 nothing_to_update', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    const res = await callApp(app, 'PATCH', `/chat/conversations/${convId}`, {
      cookie,
      body: {},
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('nothing_to_update');
  });

  test('pin a foreign conversation → 404', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const convId = await createConversation(a.cookie, 'A thread');
    const res = await callApp(app, 'PATCH', `/chat/conversations/${convId}`, {
      cookie: b.cookie,
      body: { pinned: true },
    });
    expect(res.status).toBe(404);
  });
});

// ── S6 — regenerate + abort tail (AC3.3, AC3.4) ───────────────────────────────

describe('POST /chat/conversations/:id/regenerate', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('edited regeneration targets the latest user beyond 1000 rows and preserves every earlier row', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie, 'Long conversation');
    const start = Date.now() - 100_000;
    await db.insert(messagesTable).values(Array.from({ length: 1002 }, (_, i) => ({
      conversationId: convId, userId, role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `Historical row ${i}`, createdAt: new Date(start + i),
    })));
    const before = await rows(convId);
    let replayed = '';
    __setAiClientForTests({ async *chatStreamAgentic(history) {
      replayed = String(history.findLast(message => message.role === 'user')?.content);
      yield { type: 'content', text: 'Updated final answer' };
      yield { type: 'finish', reason: 'stop' };
    } });
    const response = await regenReqWithContent(cookie, convId, 'Edited latest question');
    expect(response.status).toBe(200); await drain(response);
    const after = await rows(convId);
    expect(after.slice(0, 1000)).toEqual(before.slice(0, 1000));
    expect(after).toHaveLength(1002);
    expect(after[1000]!.id).toBe(before[1000]!.id);
    expect(after[1000]!.content).toBe('Edited latest question');
    expect(after[1001]!.content).toBe('Updated final answer');
    expect(after[1001]!.id).not.toBe(before[1001]!.id);
    expect(replayed).toContain('Edited latest question');
  });

  test('regeneration separates the tail by ID when messages share a timestamp', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie, 'Tied timestamps');
    const createdAt = new Date(Date.now() - 1000);
    const ids = Array.from({ length: 4 }, () => newUuidV7()).sort();
    await db.insert(messagesTable).values(ids.map((id, index) => ({
      id, conversationId: convId, userId, createdAt,
      role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `Tied row ${index}`,
    })));
    __setAiClientForTests({ chatStreamAgentic: scriptedAgentStream([answerTurn('New tail')]) });
    const before = await rows(convId);
    await drain(await regenReqWithContent(cookie, convId, 'Latest edit'));
    const after = await rows(convId);
    expect(after.slice(0, 2)).toEqual(before.slice(0, 2));
    expect(after).toHaveLength(4);
    expect(after[2]!.id).toBe(ids[2]!);
    expect(after[2]!.content).toBe('Latest edit');
    expect(after[3]!.content).toBe('New tail');
  });

  test('removes EXACTLY the trailing assistant turn rows + re-streams to a fresh done', async () => {
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        answerTurn('first answer'),
        answerTurn('regenerated answer'),
      ]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    await drain(await streamReq(cookie, convId, 'my question'));

    const before = await rows(convId);
    // user + 1 assistant text row.
    expect(before.filter((r) => r.role === 'user').length).toBe(1);
    expect(before.filter((r) => r.role === 'assistant').length).toBe(1);

    const res = await regenReq(cookie, convId);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await drain(res);

    const after = await rows(convId);
    // Still exactly ONE user row + ONE assistant row (the OLD assistant was
    // deleted, a fresh one re-streamed).
    expect(after.filter((r) => r.role === 'user').length).toBe(1);
    const assistants = after.filter((r) => r.role === 'assistant');
    expect(assistants.length).toBe(1);
    expect(assistants[0]!.content).toBe('regenerated answer');
    // The regenerated assistant row is a DIFFERENT id than the original.
    const oldId = before.find((r) => r.role === 'assistant')!.id;
    expect(assistants[0]!.id).not.toBe(oldId);
  });

  test('removes the WHOLE trailing assistant turn (tool_calls + role:tool + text — no orphan tool rows)', async () => {
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        searchTurn([{ id: 's1', name: 'study_stats', args: { scope: 'global' } }]),
        answerTurn('first answer with a tool'),
        answerTurn('regenerated'),
      ]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    await drain(await streamReq(cookie, convId, 'how am I doing?'));

    const before = await rows(convId);
    expect(before.filter((r) => r.role === 'tool').length).toBe(1);
    expect(before.filter((r) => r.role === 'assistant' && (r.toolCalls?.length ?? 0) > 0).length).toBe(1);

    await drain(await regenReq(cookie, convId));

    const after = await rows(convId);
    // The whole trailing turn was removed: NO leftover tool row, NO leftover
    // assistant(tool_calls) row from the old turn (the new turn answered directly).
    expect(after.filter((r) => r.role === 'tool').length).toBe(0);
    expect(after.filter((r) => r.role === 'user').length).toBe(1);
    const finalAssistant = after.filter((r) => r.role === 'assistant' && (r.toolCalls?.length ?? 0) === 0);
    expect(finalAssistant.length).toBe(1);
    expect(finalAssistant[0]!.content).toBe('regenerated');
  });

  test('foreign conversation → 404', async () => {
    __setAiClientForTests({ chatStreamAgentic: scriptedAgentStream([answerTurn('x')]) });
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const convId = await createConversation(a.cookie);
    await drain(await streamReq(a.cookie, convId, 'q'));
    const res = await regenReq(b.cookie, convId);
    expect(res.status).toBe(404);
  });

  test('no trailing user row → 400 nothing_to_regenerate', async () => {
    __setAiClientForTests({ chatStreamAgentic: scriptedAgentStream([answerTurn('x')]) });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie); // empty thread, no messages
    const res = await regenReq(cookie, convId);
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('nothing_to_regenerate');
  });

  // ── Edit-and-rerun via additive `content?` (S7 / B2 / AC4.2, AC4.3) ──────────

  test('content present → the last user row is UPDATED to the edited text + the trailing assistant turn replays', async () => {
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        answerTurn('first answer'),
        answerTurn('answer to the edited question'),
      ]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    await drain(await streamReq(cookie, convId, 'original question'));

    const before = await rows(convId);
    expect(before.filter((r) => r.role === 'user').length).toBe(1);
    expect(before.find((r) => r.role === 'user')!.content).toBe('original question');

    const res = await regenReqWithContent(cookie, convId, 'edited question');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    await drain(res);

    const after = await rows(convId);
    // STILL exactly one user row — the edited text REPLACED the old (clean history,
    // no duplicate pre-edit pair).
    const users = after.filter((r) => r.role === 'user');
    expect(users.length).toBe(1);
    expect(users[0]!.content).toBe('edited question');
    // The trailing assistant turn was replayed over the edited user row.
    const assistants = after.filter((r) => r.role === 'assistant');
    expect(assistants.length).toBe(1);
    expect(assistants[0]!.content).toBe('answer to the edited question');
  });

  test('content absent → IDENTICAL to today (no user-row mutation, just replay — backward-compat)', async () => {
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        answerTurn('first answer'),
        answerTurn('regenerated answer'),
      ]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    await drain(await streamReq(cookie, convId, 'unchanged question'));

    await drain(await regenReq(cookie, convId));

    const after = await rows(convId);
    const users = after.filter((r) => r.role === 'user');
    expect(users.length).toBe(1);
    // The user row is UNTOUCHED — no `content` was supplied.
    expect(users[0]!.content).toBe('unchanged question');
    const assistants = after.filter((r) => r.role === 'assistant');
    expect(assistants.length).toBe(1);
    expect(assistants[0]!.content).toBe('regenerated answer');
  });

  // ── Abort / torn tail (AC3.3) ───────────────────────────────────────────────
  // A torn turn (the gateway throws mid-stream) commits NO assistant rows — the
  // pre-committed user row is left as a trailing question with no answer. Same
  // tail as a client abort. Regenerate recovers it (M1).

  test('abort/torn tail: user row survives, no assistant row, no orphan role:tool row', async () => {
    __setAiClientForTests({ chatStreamAgentic: scriptedAgentStream([errorTurn('partial ')]) });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    // The stream emits a terminal error frame; no assistant turn is committed.
    await drain(await streamReq(cookie, convId, 'my question'));

    const after = await rows(convId);
    expect(after.filter((r) => r.role === 'user').length).toBe(1);
    expect(after.filter((r) => r.role === 'assistant').length).toBe(0);
    expect(after.filter((r) => r.role === 'tool').length).toBe(0);
  });

  test('abort then reload via GET /conversations/:id → user row present AND regenerate reaches done (M1 recovery)', async () => {
    // Turn 0 (initial stream): torn. Turn 1 (regenerate replay): succeeds.
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([errorTurn('partial '), answerTurn('recovered answer')]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    await drain(await streamReq(cookie, convId, 'my question'));

    // Reload: the trailing user message survives with no following assistant row.
    const get = await callApp(app, 'GET', `/chat/conversations/${convId}`, { cookie });
    const msgs = (await get.json<{ messages: { role: string }[] }>()).messages;
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.role).toBe('user');

    // Recovery: regenerate replays the last user turn → reaches a `done`.
    const regen = await regenReq(cookie, convId);
    expect(regen.headers.get('content-type')).toContain('text/event-stream');
    const reader = regen.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let sawDone = false;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      if (buf.includes('event: done')) sawDone = true;
    }
    expect(sawDone).toBe(true);

    const after = await rows(convId);
    expect(after.filter((r) => r.role === 'user').length).toBe(1);
    expect(after.filter((r) => r.role === 'assistant').length).toBe(1);
    expect(after.find((r) => r.role === 'assistant')!.content).toBe('recovered answer');
  });
});
