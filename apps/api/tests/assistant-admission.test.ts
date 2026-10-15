import { afterEach, beforeEach, expect, test } from 'bun:test';
import { buildApp } from '../src/app';
import { __setAiClientForTests, __resetAiClientForTests } from '../src/ai/openai-client';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers';

const app = buildApp();
beforeEach(resetTestDb);
afterEach(__resetAiClientForTests);
async function conversation(cookie: string) {
  return (await (await callApp(app, 'POST', '/chat/conversations', { cookie, body: {} })).json<{ id: string }>()).id;
}
const stream = (cookie: string, id: string, signal?: AbortSignal) => app.handle(new Request(`http://localhost/chat/conversations/${id}/stream`, {
  method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ content: 'Explain' }), signal,
}));

test('three concurrent turns per user; rejection precedes message insertion and another user is independent', async () => {
  let finish!: () => void;
  const hold = new Promise<void>(resolve => { finish = resolve; });
  __setAiClientForTests({ async *chatStreamAgentic() {
    yield { type: 'content', text: 'Working' }; await hold; yield { type: 'finish', reason: 'stop' };
  } });
  const alice = await signUpAndCookie(app, uniqueEmail('alice'));
  const bob = await signUpAndCookie(app, uniqueEmail('bob'));
  const ids = await Promise.all(Array.from({ length: 4 }, () => conversation(alice.cookie)));
  const other = await conversation(bob.cookie);
  const pending: Promise<string>[] = [];
  try {
    for (const id of ids.slice(0, 3)) {
      const res = await stream(alice.cookie, id); expect(res.status).toBe(200); pending.push(res.text());
    }
    const busy = await stream(alice.cookie, ids[3]!);
    expect(busy.status).toBe(409);
    expect(await busy.json()).toEqual({ error: 'too_many_active_turns' });
    const duplicate = await stream(alice.cookie, ids[0]!);
    expect(await duplicate.json()).toEqual({ error: 'turn_in_progress' });
    const detail = await (await callApp(app, 'GET', `/chat/conversations/${ids[3]}`, { cookie: alice.cookie })).json<any>();
    expect(detail.messages).toEqual([]);
    const independent = await stream(bob.cookie, other);
    expect(independent.status).toBe(200); pending.push(independent.text());
  } finally { finish(); await Promise.all(pending); }
  const retry = await stream(alice.cookie, ids[3]!);
  expect(retry.status).toBe(200); await retry.text();
});

test('disconnect releases only its turn after cancellation settles', async () => {
  let finish!: () => void;
  const hold = new Promise<void>(resolve => { finish = resolve; });
  __setAiClientForTests({ async *chatStreamAgentic(_messages, options) {
    yield { type: 'content', text: 'Working' };
    await Promise.race([hold, new Promise<void>(resolve => {
      if (options?.signal?.aborted) resolve();
      else options?.signal?.addEventListener('abort', () => resolve(), { once: true });
    })]);
    yield { type: 'finish', reason: 'stop' };
  } });
  const { cookie } = await signUpAndCookie(app, uniqueEmail());
  const ids = await Promise.all(Array.from({ length: 4 }, () => conversation(cookie)));
  const abort = new AbortController();
  const pending: Promise<string>[] = [];
  try {
    for (let n = 0; n < 3; n++) pending.push((await stream(cookie, ids[n]!, n === 0 ? abort.signal : undefined)).text());
    abort.abort(); await pending[0];
    const admitted = await stream(cookie, ids[3]!);
    expect(admitted.status).toBe(200); pending.push(admitted.text());
    expect((await stream(cookie, ids[1]!)).status).toBe(409);
  } finally { finish(); await Promise.all(pending); }
});

test('failed preflight, unknown resume, empty regenerate and provider failure release admission', async () => {
  __setAiClientForTests({ async *chatStreamAgentic() { throw new Error('test_provider_failure'); } });
  const { cookie } = await signUpAndCookie(app, uniqueEmail());
  const ids = await Promise.all(Array.from({ length: 5 }, () => conversation(cookie)));
  for (const id of ids) {
    const unknown = await callApp(app, 'POST', `/chat/conversations/${id}/resume`, { cookie, body: { resumeToolCallId: 'missing', decision: 'apply' } });
    expect(unknown.status).toBe(404);
    const empty = await callApp(app, 'POST', `/chat/conversations/${id}/regenerate`, { cookie, body: {} });
    expect(empty.status).toBe(400);
    const bad = await callApp(app, 'POST', `/chat/conversations/${id}/stream`, { cookie, body: { content: 'Test', context: { version: 7, refs: [] } } });
    expect(bad.status).toBe(400);
    const response = await stream(cookie, id);
    expect(response.status).toBe(200); expect(await response.text()).toContain('event: error');
  }
});

test('suspension releases a slot and confirmation reacquires it before consuming the preview', async () => {
  let first = true;
  let finish!: () => void;
  const hold = new Promise<void>(resolve => { finish = resolve; });
  __setAiClientForTests({ async *chatStreamAgentic(_messages, options) {
    if (first) {
      first = false;
      yield { type: 'tool_call_delta', index: 0, id: 'admission-deck', name: 'create_deck' };
      yield { type: 'tool_call_delta', index: 0, argsFragment: JSON.stringify({ name: 'Approved after admission' }) };
      yield { type: 'finish', reason: 'tool_calls' };
      return;
    }
    yield { type: 'content', text: 'Working' };
    await Promise.race([hold, new Promise<void>(resolve => {
      if (options?.signal?.aborted) resolve();
      else options?.signal?.addEventListener('abort', () => resolve(), { once: true });
    })]);
    yield { type: 'finish', reason: 'stop' };
  } });
  const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
  const ids = await Promise.all(Array.from({ length: 5 }, () => conversation(cookie)));
  const suspended = await stream(cookie, ids[0]!);
  expect(await suspended.text()).toContain('await_confirmation');
  const abort = new AbortController();
  const pending: Promise<string>[] = [];
  const { db, decks } = await import('@reomi/db');
  const { eq } = await import('drizzle-orm');
  const resume = () => callApp(app, 'POST', `/chat/context-v1/conversations/${ids[0]}/resume`, { cookie, body: { resumeToolCallId: 'admission-deck', decision: 'apply' } });
  try {
    for (let index = 1; index <= 3; index++) {
      const response = await stream(cookie, ids[index]!, index === 1 ? abort.signal : undefined);
      expect(response.status).toBe(200); pending.push(response.text());
    }
    const blocked = await resume();
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ error: 'too_many_active_turns' });
    expect(await db.select().from(decks).where(eq(decks.userId, userId))).toHaveLength(0);
    abort.abort(); await pending[0];
    const accepted = await resume();
    expect(accepted.status).toBe(200); pending.push(accepted.text());
    expect((await stream(cookie, ids[4]!)).status).toBe(409);
  } finally { finish(); await Promise.all(pending); }
  expect(await db.select().from(decks).where(eq(decks.userId, userId))).toHaveLength(1);
  const completed = await stream(cookie, ids[4]!);
  expect(completed.status).toBe(200); await completed.text();
});
