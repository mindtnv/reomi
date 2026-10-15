// Progress read-tools integration tests (S4 / AC1.1, AC1.2, AC1.5, P4).
//
// Drives `study_stats` / `card_progress` through the real agentic loop: a
// scripted fake emits a tool_call, the loop auto-executes the READ tool
// server-side, and we read the resulting `role:tool` content back. Reviews are
// seeded DIRECTLY via db.insert with controlled dates/ratings (the POST /reviews
// path applies FSRS + only "today"). Same in-process injection harness as
// chat.test.ts (NODE_ENV=test forces real flags off; the injected fake flips
// isChatEnabled() on).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cards as cardsTable, db, messages as messagesTable, reviews } from '@reomi/db';
import { newUuidV7 } from '@reomi/shared';
import { asc, eq } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import {
  __resetAiClientForTests,
  __setAiClientForTests,
  type AgentChatMessage,
  type AgentStreamChunk,
} from '../src/ai/openai-client.ts';
import { callApp, resetTestDb, seedBasicCard, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

// ── Scripted agentic fake ─────────────────────────────────────────────────────

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
function callTurn(calls: ToolCallScript[]): AgentTurn {
  return { toolCalls: calls, finish: 'tool_calls' };
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
async function streamReq(cookie: string, convId: string, content: string): Promise<Response> {
  const req = new Request(`http://localhost/chat/conversations/${convId}/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ content }),
  });
  return app.handle(req);
}
async function createConversation(cookie: string): Promise<string> {
  const res = await callApp(app, 'POST', '/chat/conversations', { cookie, body: {} });
  return (await res.json<{ id: string }>()).id;
}
async function freshDeck(cookie: string, name = 'D', parentId?: string): Promise<string> {
  const res = await callApp(app, 'POST', '/decks', {
    cookie,
    body: { name, ...(parentId ? { parentId } : {}) },
  });
  return (await res.json<{ id: string }>()).id;
}

/** Insert a review row directly (controlled date/rating — bypasses FSRS). */
async function seedReview(
  userId: string,
  cardId: string,
  deckId: string,
  rating: number,
  reviewedAt: Date,
  durationMs = 30000,
): Promise<void> {
  await db.insert(reviews).values({
    userId,
    cardId,
    deckId,
    rating,
    durationMs,
    reviewedAt,
    nextDue: new Date(reviewedAt.getTime() + 86400000),
    nextStability: 1,
    nextDifficulty: 5,
  });
}

/** The persisted role:tool content for the single tool round, parsed/raw. */
async function toolResultText(convId: string): Promise<string> {
  const rows = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, convId))
    .orderBy(asc(messagesTable.createdAt));
  const toolRow = rows.find((r) => r.role === 'tool');
  return toolRow?.content ?? '';
}

const daysAgo = (n: number): Date => new Date(Date.now() - n * 86400000);
const daysFromNow = (n: number): Date => new Date(Date.now() + n * 86400000);

/** Force a seeded card's scheduling columns (due/state/suspended) directly. */
async function scheduleCard(
  cardId: string,
  opts: { due: Date; state?: 'learning' | 'review' | 'relearning'; suspended?: boolean },
): Promise<void> {
  await db
    .update(cardsTable)
    .set({ due: opts.due, state: opts.state ?? 'review', suspended: opts.suspended ?? false })
    .where(eq(cardsTable.id, cardId));
}

describe('progress read-tools', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  // ── study_stats — global ────────────────────────────────────────────────────

  test('study_stats global aggregates (count + retention + minutes + heatmap buckets)', async () => {
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        callTurn([{ id: 's1', name: 'study_stats', args: { scope: 'global' } }]),
        answerTurn('Here are your stats.'),
      ]),
    });
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const card = await seedBasicCard(app, cookie, { deckId, front: 'q', back: 'a' });
    // 3 reviews across 2 days: 2 remembered (>=3), 1 lapse → retention 67%.
    await seedReview(userId, card.id, deckId, 3, daysAgo(1), 60000);
    await seedReview(userId, card.id, deckId, 4, daysAgo(1), 60000);
    await seedReview(userId, card.id, deckId, 1, daysAgo(0), 60000);

    const convId = await createConversation(cookie);
    const frames = await readSse(await streamReq(cookie, convId, 'что я заваливаю?'));
    expect(frames.some((f) => f.event === 'tool_call')).toBe(true);

    const text = await toolResultText(convId);
    expect(text).toContain('Reviews: 3');
    expect(text).toContain('Answer success: 67% (2/3 answers)');
    expect(text).toContain('True retention: 50% (1/2 first daily reviews)');
    expect(text).toContain('Minutes: 3');
    expect(text).toContain('2 active day');
  });

  test('study_stats global reports profile streak/level/xp', async () => {
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        callTurn([{ id: 's1', name: 'study_stats', args: { scope: 'global' } }]),
        answerTurn('ok'),
      ]),
    });
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    // Touch /profile + grade once via the real path so the profile row exists
    // with a non-zero streak/xp.
    await callApp(app, 'GET', '/profile', { cookie });
    const deckId = await freshDeck(cookie);
    const card = await seedBasicCard(app, cookie, { deckId, front: 'q', back: 'a' });
    await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: card.id, rating: 3, durationMs: 2000 } });

    const convId = await createConversation(cookie);
    await readSse(await streamReq(cookie, convId, 'сколько я занимался?'));
    const text = await toolResultText(convId);
    expect(text).toMatch(/Streak \d+d · Level \d+ · XP \d+/);
  });

  // ── study_stats — deck scope + subtree + foreign ──────────────────────────────

  test('study_stats deck scope includes the subtree (parent + child decks)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const parent = await freshDeck(cookie, 'Parent');
    const child = await freshDeck(cookie, 'Child', parent);
    const otherDeck = await freshDeck(cookie, 'Other');
    const pCard = await seedBasicCard(app, cookie, { deckId: parent, front: 'p', back: 'a' });
    const cCard = await seedBasicCard(app, cookie, { deckId: child, front: 'c', back: 'a' });
    const oCard = await seedBasicCard(app, cookie, { deckId: otherDeck, front: 'o', back: 'a' });
    await seedReview(userId, pCard.id, parent, 3, daysAgo(1));
    await seedReview(userId, cCard.id, child, 3, daysAgo(1));
    await seedReview(userId, oCard.id, otherDeck, 3, daysAgo(1)); // must NOT be counted

    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        callTurn([{ id: 's1', name: 'study_stats', args: { scope: 'deck', deckId: parent } }]),
        answerTurn('ok'),
      ]),
    });
    const convId = await createConversation(cookie);
    // Send the parent deckId as the turn scope so the subtree resolves.
    const req = new Request(`http://localhost/chat/conversations/${convId}/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ content: 'как у меня дела по этой колоде?', deckId: parent }),
    });
    await readSse(await app.handle(req));
    const text = await toolResultText(convId);
    // parent + child = 2 reviews; the Other deck's review is excluded.
    expect(text).toContain('Reviews: 2');
  });

  test('study_stats deck scope resolves subtree from tool deckId arg ALONE (no turn scope) — parent includes child reviews', async () => {
    // AC1.2: agent calls study_stats({scope:'deck', deckId:parent}) in a FREE-FORM
    // turn (no deckId on the POST body → ctx.deckIds is undefined). The tool MUST
    // still walk the subtree and include the child deck's reviews.
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const parent = await freshDeck(cookie, 'ParentAgent');
    const child = await freshDeck(cookie, 'ChildAgent', parent);
    const other = await freshDeck(cookie, 'OtherAgent');
    const pCard = await seedBasicCard(app, cookie, { deckId: parent, front: 'p', back: 'a' });
    const cCard = await seedBasicCard(app, cookie, { deckId: child, front: 'c', back: 'a' });
    const oCard = await seedBasicCard(app, cookie, { deckId: other, front: 'o', back: 'a' });
    await seedReview(userId, pCard.id, parent, 3, daysAgo(1));
    await seedReview(userId, cCard.id, child, 3, daysAgo(1));
    await seedReview(userId, oCard.id, other, 3, daysAgo(1)); // must NOT appear

    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        // Agent supplies the deckId arg; the turn has NO deckId scope (ctx.deckIds undefined).
        callTurn([{ id: 's1', name: 'study_stats', args: { scope: 'deck', deckId: parent } }]),
        answerTurn('ok'),
      ]),
    });
    const convId = await createConversation(cookie);
    // Plain streamReq — no deckId body field → ctx.deckIds is undefined (agent-initiated path).
    await readSse(await streamReq(cookie, convId, 'how am I doing on my German deck?'));
    const text = await toolResultText(convId);
    // parent + child = 2 reviews; the Other deck's review is excluded.
    expect(text).toContain('Reviews: 2');
    expect(text).not.toContain('Reviews: 3');
  });

  test('study_stats foreign/un-owned deckId resolves to an EMPTY scope (not global fallback)', async () => {
    const foreignDeck = newUuidV7();
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        callTurn([{ id: 's1', name: 'study_stats', args: { scope: 'deck', deckId: foreignDeck } }]),
        answerTurn('ok'),
      ]),
    });
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const card = await seedBasicCard(app, cookie, { deckId, front: 'q', back: 'a' });
    await seedReview(userId, card.id, deckId, 3, daysAgo(1)); // owned reviews exist globally

    const convId = await createConversation(cookie);
    const req = new Request(`http://localhost/chat/conversations/${convId}/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ content: 'stats for that deck', deckId: foreignDeck }),
    });
    const response = await app.handle(req);
    expect(response.status).toBe(200);
    await readSse(response);
    const text = await toolResultText(convId);
    // EMPTY scope: "no reviews ... in this deck", NOT a global "Reviews: 1".
    expect(text.toLowerCase()).toContain('no reviews');
    expect(text).not.toContain('Reviews: 1');
  });

  test('study_stats empty history → retentionPct NULL renders as "no reviews yet" (graceful, not error)', async () => {
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        callTurn([{ id: 's1', name: 'study_stats', args: { scope: 'global' } }]),
        answerTurn('ok'),
      ]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    const frames = await readSse(await streamReq(cookie, convId, 'how am I doing?'));

    const toolResult = frames.find((f) => f.event === 'tool_result');
    expect((toolResult!.data as { ok: boolean }).ok).toBe(true); // graceful, not an error
    const text = await toolResultText(convId);
    expect(text.toLowerCase()).toContain('no reviews');
  });

  test('study_stats days clamp boundaries (helper)', async () => {
    const { clampDays } = await import('../src/modules/progress-stats.ts');
    expect(clampDays(undefined)).toBe(30);
    expect(clampDays(0)).toBe(1);
    expect(clampDays(-5)).toBe(1);
    expect(clampDays(9999)).toBe(365);
    expect(clampDays(45)).toBe(45);
  });

  test('study_stats cross-user isolation (user B reviews never appear for user A)', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const deckA = await freshDeck(a.cookie, 'A');
    const deckB = await freshDeck(b.cookie, 'B');
    const cardA = await seedBasicCard(app, a.cookie, { deckId: deckA, front: 'qa', back: 'a' });
    const cardB = await seedBasicCard(app, b.cookie, { deckId: deckB, front: 'qb', back: 'b' });
    await seedReview(a.userId, cardA.id, deckA, 3, daysAgo(1));
    // user B has 5 reviews — they must NOT leak into A's global stats.
    for (let i = 0; i < 5; i++) await seedReview(b.userId, cardB.id, deckB, 3, daysAgo(1));

    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        callTurn([{ id: 's1', name: 'study_stats', args: { scope: 'global' } }]),
        answerTurn('ok'),
      ]),
    });
    const convId = await createConversation(a.cookie);
    await readSse(await streamReq(a.cookie, convId, 'my stats'));
    const text = await toolResultText(convId);
    expect(text).toContain('Reviews: 1'); // only A's single review
  });

  test('study_stats rendered text < TOOL_RESULT_MAX_CHARS (no raw row dumps)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const card = await seedBasicCard(app, cookie, { deckId, front: 'q', back: 'a' });
    // 200 reviews across many days — the compact summary must still be tiny.
    for (let i = 0; i < 200; i++) await seedReview(userId, card.id, deckId, (i % 4) + 1, daysAgo(i % 60));

    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        callTurn([{ id: 's1', name: 'study_stats', args: { scope: 'global' } }]),
        answerTurn('ok'),
      ]),
    });
    const convId = await createConversation(cookie);
    await readSse(await streamReq(cookie, convId, 'stats'));
    const text = await toolResultText(convId);
    expect(text.length).toBeLessThan(4000);
  });

  // ── card_progress ─────────────────────────────────────────────────────────────

  test('card_progress returns FSRS fields + last-N history', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const card = await seedBasicCard(app, cookie, { deckId, front: 'q', back: 'a' });
    await seedReview(userId, card.id, deckId, 3, daysAgo(2));
    await seedReview(userId, card.id, deckId, 1, daysAgo(1));

    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        callTurn([{ id: 'p1', name: 'card_progress', args: { cardId: card.id } }]),
        answerTurn('ok'),
      ]),
    });
    const convId = await createConversation(cookie);
    const frames = await readSse(await streamReq(cookie, convId, 'how is this card?'));
    expect(frames.some((f) => f.event === 'tool_call')).toBe(true);

    const text = await toolResultText(convId);
    expect(text).toContain(`Card ${card.id}`);
    expect(text).toMatch(/state=/);
    expect(text).toMatch(/reps=/);
    expect(text).toContain('Recent grades');
  });

  test('card_progress reviews read is scoped by BOTH cardId AND userId (user B cannot see)', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const deckA = await freshDeck(a.cookie, 'A');
    const cardA = await seedBasicCard(app, a.cookie, { deckId: deckA, front: 'qa', back: 'a' });
    await seedReview(a.userId, cardA.id, deckA, 3, daysAgo(1));

    // User B asks card_progress for user A's card id → graceful "not found",
    // never A's review history.
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        callTurn([{ id: 'p1', name: 'card_progress', args: { cardId: cardA.id } }]),
        answerTurn('ok'),
      ]),
    });
    const convId = await createConversation(b.cookie);
    await readSse(await streamReq(b.cookie, convId, 'how is that card?'));
    const text = await toolResultText(convId);
    expect(text.toLowerCase()).toContain('no reviews recorded');
    expect(text).not.toContain(`Card ${cardA.id}: state=`);
  });

  // ── due_forecast ──────────────────────────────────────────────────────────────

  test('due_forecast reports total, busiest day and overdue backlog', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const c1 = await seedBasicCard(app, cookie, { deckId, front: 'q1', back: 'a' });
    const c2 = await seedBasicCard(app, cookie, { deckId, front: 'q2', back: 'a' });
    const c3 = await seedBasicCard(app, cookie, { deckId, front: 'q3', back: 'a' });
    const c4 = await seedBasicCard(app, cookie, { deckId, front: 'q4', back: 'a' });
    await scheduleCard(c1.id, { due: daysFromNow(1) });
    await scheduleCard(c2.id, { due: daysFromNow(1) });
    await scheduleCard(c3.id, { due: daysFromNow(2) });
    await scheduleCard(c4.id, { due: daysAgo(2) }); // overdue backlog

    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        callTurn([{ id: 'f1', name: 'due_forecast', args: {} }]),
        answerTurn('ok'),
      ]),
    });
    const convId = await createConversation(cookie);
    const frames = await readSse(await streamReq(cookie, convId, 'сколько мне предстоит повторить?'));
    expect(frames.some((f) => f.event === 'tool_call')).toBe(true);

    const text = await toolResultText(convId);
    expect(text).toContain('3 reviews due');
    expect(text).toMatch(/Busiest day \d{4}-\d{2}-\d{2} \(2\)/);
    expect(text).toContain('Overdue backlog: 1');
  });

  test('due_forecast deckId arg scopes to the subtree (parent + child)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const parent = await freshDeck(cookie, 'Parent');
    const child = await freshDeck(cookie, 'Child', parent);
    const other = await freshDeck(cookie, 'Other');
    for (const deckId of [parent, child, other]) {
      const c = await seedBasicCard(app, cookie, { deckId, front: `q-${deckId}`, back: 'a' });
      await scheduleCard(c.id, { due: daysFromNow(1) });
    }

    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        callTurn([{ id: 'f1', name: 'due_forecast', args: { deckId: parent } }]),
        answerTurn('ok'),
      ]),
    });
    const convId = await createConversation(cookie);
    await readSse(await streamReq(cookie, convId, 'how busy is this deck next week?'));
    const text = await toolResultText(convId);
    expect(text).toContain('2 reviews due'); // parent + child, not Other
  });

  test('due_forecast foreign deckId → graceful empty, not a global fallback', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const c = await seedBasicCard(app, cookie, { deckId, front: 'q', back: 'a' });
    await scheduleCard(c.id, { due: daysFromNow(1) });

    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        callTurn([
          {
            id: 'f1',
            name: 'due_forecast',
            args: { deckId: '00000000-0000-0000-0000-0000000000ff' },
          },
        ]),
        answerTurn('ok'),
      ]),
    });
    const convId = await createConversation(cookie);
    const frames = await readSse(await streamReq(cookie, convId, 'load for that deck?'));
    const toolResult = frames.find((f) => f.event === 'tool_result');
    expect((toolResult!.data as { ok: boolean }).ok).toBe(true); // graceful, not error
    const text = await toolResultText(convId);
    expect(text).toContain('No reviews scheduled in this deck');
    expect(text).not.toContain('1 reviews due');
  });

  test('card_progress foreign/missing card → graceful result, not a throw', async () => {
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        callTurn([
          { id: 'p1', name: 'card_progress', args: { cardId: '00000000-0000-0000-0000-0000000000aa' } },
        ]),
        answerTurn('ok'),
      ]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    const frames = await readSse(await streamReq(cookie, convId, 'unknown card'));
    const toolResult = frames.find((f) => f.event === 'tool_result');
    expect((toolResult!.data as { ok: boolean }).ok).toBe(true); // graceful, not error
    expect(frames.some((f) => f.event === 'error')).toBe(false);
    const done = frames.find((f) => f.event === 'done');
    expect(done).toBeTruthy();
  });
});
