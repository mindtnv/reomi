// Deterministic browse read-tools integration tests (AC2.1–AC2.5).
//
// Drives `list_decks` / `browse_cards` / `get_card` through the real agentic
// loop: a scripted fake emits a tool_call, the loop auto-executes the READ tool
// server-side, and we read the resulting `role:tool` content back (and the SSE
// `tool_call` LOG for routing assertions). Same in-process injection harness as
// chat.test.ts / progress-tools.test.ts (NODE_ENV=test forces real flags off;
// the injected fake flips isChatEnabled() on).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { db, cards as cardsTable, messages as messagesTable } from '@reomi/db';
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

/** The persisted role:tool content for the single tool round. */
async function toolResultText(convId: string): Promise<string> {
  const rows = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, convId))
    .orderBy(asc(messagesTable.createdAt));
  const toolRow = rows.find((r) => r.role === 'tool');
  return toolRow?.content ?? '';
}

/** Names of tools the loop actually executed, from the SSE `tool_call` frames. */
function executedTools(frames: SseFrame[]): string[] {
  return frames
    .filter((f) => f.event === 'tool_call')
    .map((f) => (f.data as { name: string }).name);
}

/** Force a card's createdAt to a fixed instant so "newest-first" is deterministic. */
async function setCreatedAt(cardId: string, when: Date): Promise<void> {
  await db.update(cardsTable).set({ createdAt: when }).where(eq(cardsTable.id, cardId));
}

describe('browse read-tools', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  // ── list_decks ───────────────────────────────────────────────────────────────

  test('list_decks returns the tree (parent/child) + per-deck total/due counts', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const parent = await freshDeck(cookie, 'Parent');
    const child = await freshDeck(cookie, 'Child', parent);
    // 2 cards in parent: p1 due in the past (due), p2 due far in the future (not
    // due). 1 card in child. (A freshly seeded card defaults `due = now`, so we
    // set both parent cards' due explicitly to make the "1 due" count exact.)
    const p1 = await seedBasicCard(app, cookie, { deckId: parent, front: 'p1', back: 'a' });
    const p2 = await seedBasicCard(app, cookie, { deckId: parent, front: 'p2', back: 'a' });
    await seedBasicCard(app, cookie, { deckId: child, front: 'c1', back: 'a' });
    await db
      .update(cardsTable)
      .set({ due: new Date(Date.now() - 86400000) })
      .where(eq(cardsTable.id, p1.id));
    await db
      .update(cardsTable)
      .set({ due: new Date(Date.now() + 30 * 86400000) })
      .where(eq(cardsTable.id, p2.id));

    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        callTurn([{ id: 'l1', name: 'list_decks', args: {} }]),
        answerTurn('Here are your decks.'),
      ]),
    });
    const convId = await createConversation(cookie);
    const frames = await readSse(await streamReq(cookie, convId, 'какие у меня колоды?'));
    expect(frames.some((f) => f.event === 'tool_call')).toBe(true);

    const text = await toolResultText(convId);
    expect(text).toContain('Parent');
    expect(text).toContain('Child');
    expect(text).toContain(`[deck:${parent}]`);
    expect(text).toContain(`[deck:${child}]`);
    // Parent: 2 cards, 1 due. Child: 1 card, 0 due (new card due defaults to now-ish;
    // a freshly seeded basic card is `due` defaultNow ⇒ <= now ⇒ due. But it is NOT
    // suspended, so it counts as due). Assert the parent's counts explicitly.
    expect(text).toMatch(/Parent \[deck:[0-9a-f-]+\] — 2 card\(s\), 1 due/);
    // Child is indented under Parent (two-space indent prefix on its line).
    expect(text).toMatch(/\n {2}- Child/);
  });

  test('list_decks cross-user isolation — user B decks/cards never appear for A', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const deckA = await freshDeck(a.cookie, 'AlphaDeck');
    const deckB = await freshDeck(b.cookie, 'BravoDeck');
    await seedBasicCard(app, a.cookie, { deckId: deckA, front: 'qa', back: 'a' });
    await seedBasicCard(app, b.cookie, { deckId: deckB, front: 'qb', back: 'b' });

    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        callTurn([{ id: 'l1', name: 'list_decks', args: {} }]),
        answerTurn('ok'),
      ]),
    });
    const convId = await createConversation(a.cookie);
    await readSse(await streamReq(a.cookie, convId, 'my decks'));
    const text = await toolResultText(convId);
    expect(text).toContain('AlphaDeck');
    expect(text).not.toContain('BravoDeck');
    expect(text).not.toContain(deckB);
  });

  test('list_decks with no decks → graceful "no decks yet"', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        callTurn([{ id: 'l1', name: 'list_decks', args: {} }]),
        answerTurn('ok'),
      ]),
    });
    const convId = await createConversation(cookie);
    const frames = await readSse(await streamReq(cookie, convId, 'decks?'));
    const toolResult = frames.find((f) => f.event === 'tool_result');
    expect((toolResult!.data as { ok: boolean }).ok).toBe(true);
    const text = await toolResultText(convId);
    expect(text.toLowerCase()).toContain('no decks');
  });

  // ── browse_cards ───────────────────────────────────────────────────────────────

  test('browse_cards default sort = created desc (newest first)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const older = await seedBasicCard(app, cookie, { deckId, front: 'OLDEST', back: 'a' });
    const newer = await seedBasicCard(app, cookie, { deckId, front: 'NEWEST', back: 'a' });
    await setCreatedAt(older.id, new Date('2020-01-01T00:00:00Z'));
    await setCreatedAt(newer.id, new Date('2024-01-01T00:00:00Z'));

    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        callTurn([{ id: 'b1', name: 'browse_cards', args: {} }]),
        answerTurn('ok'),
      ]),
    });
    const convId = await createConversation(cookie);
    await readSse(await streamReq(cookie, convId, 'покажи последние карточки'));
    const text = await toolResultText(convId);
    // Newest first: NEWEST appears before OLDEST.
    expect(text.indexOf('NEWEST')).toBeGreaterThanOrEqual(0);
    expect(text.indexOf('NEWEST')).toBeLessThan(text.indexOf('OLDEST'));
    // Each line carries a [card:<id>] token + deck name + state.
    expect(text).toContain(`[card:${newer.id}]`);
    expect(text).toContain('deck:');
  });

  test('browse_cards deckId includes the subtree (parent returns child cards)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const parent = await freshDeck(cookie, 'P');
    const child = await freshDeck(cookie, 'C', parent);
    const other = await freshDeck(cookie, 'O');
    const pCard = await seedBasicCard(app, cookie, { deckId: parent, front: 'PARENTCARD', back: 'a' });
    const cCard = await seedBasicCard(app, cookie, { deckId: child, front: 'CHILDCARD', back: 'a' });
    const oCard = await seedBasicCard(app, cookie, { deckId: other, front: 'OTHERCARD', back: 'a' });

    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        callTurn([{ id: 'b1', name: 'browse_cards', args: { deckId: parent, limit: 50 } }]),
        answerTurn('ok'),
      ]),
    });
    const convId = await createConversation(cookie);
    await readSse(await streamReq(cookie, convId, 'cards in P'));
    const text = await toolResultText(convId);
    expect(text).toContain(`[card:${pCard.id}]`);
    expect(text).toContain(`[card:${cCard.id}]`); // subtree included
    expect(text).not.toContain(`[card:${oCard.id}]`); // sibling deck excluded
  });

  test('browse_cards foreign deckId → empty scope (NOT global)', async () => {
    const foreignDeck = '00000000-0000-0000-0000-0000000000ff';
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    await seedBasicCard(app, cookie, { deckId, front: 'MYCARD', back: 'a' });

    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        callTurn([{ id: 'b1', name: 'browse_cards', args: { deckId: foreignDeck } }]),
        answerTurn('ok'),
      ]),
    });
    const convId = await createConversation(cookie);
    const frames = await readSse(await streamReq(cookie, convId, 'cards in that deck'));
    const toolResult = frames.find((f) => f.event === 'tool_result');
    expect((toolResult!.data as { ok: boolean }).ok).toBe(true); // graceful
    const text = await toolResultText(convId);
    expect(text).not.toContain('MYCARD'); // NOT a global fallback
    expect(text.toLowerCase()).toContain('no cards');
  });

  test('browse_cards Anki query filter (is:due returns only due cards)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const dueCard = await seedBasicCard(app, cookie, { deckId, front: 'DUECARD', back: 'a' });
    const futureCard = await seedBasicCard(app, cookie, { deckId, front: 'FUTURECARD', back: 'a' });
    // Make dueCard due in the past, futureCard far in the future. is:due also
    // requires state != new for the route's `is:due` semantics? No — is:due is
    // (due <= now AND not suspended), state-agnostic. Set due explicitly.
    await db.update(cardsTable).set({ due: new Date(Date.now() - 86400000) }).where(eq(cardsTable.id, dueCard.id));
    await db.update(cardsTable).set({ due: new Date(Date.now() + 30 * 86400000) }).where(eq(cardsTable.id, futureCard.id));

    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        callTurn([{ id: 'b1', name: 'browse_cards', args: { query: 'is:due' } }]),
        answerTurn('ok'),
      ]),
    });
    const convId = await createConversation(cookie);
    await readSse(await streamReq(cookie, convId, "what's due"));
    const text = await toolResultText(convId);
    expect(text).toContain(`[card:${dueCard.id}]`);
    expect(text).not.toContain(`[card:${futureCard.id}]`);
  });

  test('browse_cards Anki query filter (tag:x returns only tagged cards)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const tagged = await seedBasicCard(app, cookie, { deckId, front: 'TAGGED', back: 'a', tags: ['grammar'] });
    const untagged = await seedBasicCard(app, cookie, { deckId, front: 'UNTAGGED', back: 'a' });

    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        callTurn([{ id: 'b1', name: 'browse_cards', args: { query: 'tag:grammar' } }]),
        answerTurn('ok'),
      ]),
    });
    const convId = await createConversation(cookie);
    await readSse(await streamReq(cookie, convId, 'cards tagged grammar'));
    const text = await toolResultText(convId);
    expect(text).toContain(`[card:${tagged.id}]`);
    expect(text).not.toContain(`[card:${untagged.id}]`);
  });

  test('browse_cards limit clamp (default 10, max 50)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    // Seed 12 cards so the default (10) truncates.
    for (let i = 0; i < 12; i++) {
      await seedBasicCard(app, cookie, { deckId, front: `card-${i}`, back: 'a' });
    }

    // Default limit (no `limit` arg) → 10 lines.
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        callTurn([{ id: 'b1', name: 'browse_cards', args: {} }]),
        answerTurn('ok'),
      ]),
    });
    const conv1 = await createConversation(cookie);
    await readSse(await streamReq(cookie, conv1, 'recent cards'));
    const text1 = await toolResultText(conv1);
    expect(text1.split('\n').filter((l) => l.startsWith('- ')).length).toBe(10);

    // Over-max limit (999) → clamps to <= 50 (only 12 exist, so 12 returned).
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        callTurn([{ id: 'b2', name: 'browse_cards', args: { limit: 999 } }]),
        answerTurn('ok'),
      ]),
    });
    const conv2 = await createConversation(cookie);
    await readSse(await streamReq(cookie, conv2, 'all cards'));
    const text2 = await toolResultText(conv2);
    const count2 = text2.split('\n').filter((l) => l.startsWith('- ')).length;
    expect(count2).toBe(12);
    expect(count2).toBeLessThanOrEqual(50);
  });

  test('browse_cards cross-user isolation (user B cards never appear for A)', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const deckA = await freshDeck(a.cookie, 'A');
    const deckB = await freshDeck(b.cookie, 'B');
    await seedBasicCard(app, a.cookie, { deckId: deckA, front: 'ACARD', back: 'a' });
    const bCard = await seedBasicCard(app, b.cookie, { deckId: deckB, front: 'BCARD', back: 'b' });

    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        callTurn([{ id: 'b1', name: 'browse_cards', args: {} }]),
        answerTurn('ok'),
      ]),
    });
    const convId = await createConversation(a.cookie);
    await readSse(await streamReq(a.cookie, convId, 'my cards'));
    const text = await toolResultText(convId);
    expect(text).toContain('ACARD');
    expect(text).not.toContain('BCARD');
    expect(text).not.toContain(bCard.id);
  });

  test('browse_cards rendered text < TOOL_RESULT_MAX_CHARS (no raw row dumps)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    // 50 cards with long fronts; the max-limit page must still be compact.
    const long = 'x'.repeat(500);
    for (let i = 0; i < 50; i++) {
      await seedBasicCard(app, cookie, { deckId, front: `${long}-${i}`, back: long });
    }

    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        callTurn([{ id: 'b1', name: 'browse_cards', args: { limit: 50 } }]),
        answerTurn('ok'),
      ]),
    });
    const convId = await createConversation(cookie);
    await readSse(await streamReq(cookie, convId, 'all'));
    const text = await toolResultText(convId);
    // env.ai.TOOL_RESULT_MAX_CHARS — capText truncates beyond it.
    const { env } = await import('../src/env.ts');
    expect(text.length).toBeLessThanOrEqual(env.ai.TOOL_RESULT_MAX_CHARS + 32);
  });

  // ── get_card ───────────────────────────────────────────────────────────────────

  test('get_card returns fields + deck + tags + note type for an owned card', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie, 'MyDeck');
    const card = await seedBasicCard(app, cookie, {
      deckId,
      front: 'Capital of France',
      back: 'Paris',
      tags: ['geo'],
    });

    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        callTurn([{ id: 'g1', name: 'get_card', args: { cardId: card.id } }]),
        answerTurn('ok'),
      ]),
    });
    const convId = await createConversation(cookie);
    const frames = await readSse(await streamReq(cookie, convId, `open card ${card.id}`));
    expect(frames.some((f) => f.event === 'tool_call')).toBe(true);

    const text = await toolResultText(convId);
    expect(text).toContain(`Card ${card.id}`);
    expect(text).toContain('MyDeck');
    expect(text).toContain('Capital of France');
    expect(text).toContain('Paris');
    expect(text).toContain('geo');
    expect(text).toMatch(/Note type:/);
  });

  test('get_card foreign/missing id → graceful "Card not found." (not a throw)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        callTurn([
          { id: 'g1', name: 'get_card', args: { cardId: '00000000-0000-0000-0000-0000000000aa' } },
        ]),
        answerTurn('ok'),
      ]),
    });
    const convId = await createConversation(cookie);
    const frames = await readSse(await streamReq(cookie, convId, 'open unknown card'));
    const toolResult = frames.find((f) => f.event === 'tool_result');
    expect((toolResult!.data as { ok: boolean }).ok).toBe(true); // graceful
    expect(frames.some((f) => f.event === 'error')).toBe(false);
    const text = await toolResultText(convId);
    expect(text).toContain('Card not found.');
  });

  test('get_card cross-user isolation — user B cannot read user A card content', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const deckA = await freshDeck(a.cookie, 'A');
    const cardA = await seedBasicCard(app, a.cookie, { deckId: deckA, front: 'SECRET-FRONT', back: 'SECRET-BACK' });

    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        callTurn([{ id: 'g1', name: 'get_card', args: { cardId: cardA.id } }]),
        answerTurn('ok'),
      ]),
    });
    const convId = await createConversation(b.cookie);
    await readSse(await streamReq(b.cookie, convId, `open card ${cardA.id}`));
    const text = await toolResultText(convId);
    expect(text).toContain('Card not found.');
    expect(text).not.toContain('SECRET-FRONT');
    expect(text).not.toContain('SECRET-BACK');
  });

  // ── prompt routing (AC2.4 / AC2.5) via the scripted fake's tool-call LOG ───────

  test('routing: "покажи последние карточки" → browse_cards CALLED (not search_cards)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    await seedBasicCard(app, cookie, { deckId, front: 'q', back: 'a' });
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        callTurn([{ id: 'b1', name: 'browse_cards', args: {} }]),
        answerTurn('Here are your recent cards.'),
      ]),
    });
    const convId = await createConversation(cookie);
    const frames = await readSse(await streamReq(cookie, convId, 'покажи последние карточки'));
    const tools = executedTools(frames);
    expect(tools).toContain('browse_cards');
    expect(tools).not.toContain('search_cards');
  });

  test('routing: "какие у меня колоды?" → list_decks CALLED', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    await freshDeck(cookie, 'Deck1');
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        callTurn([{ id: 'l1', name: 'list_decks', args: {} }]),
        answerTurn('Here are your decks.'),
      ]),
    });
    const convId = await createConversation(cookie);
    const frames = await readSse(await streamReq(cookie, convId, 'какие у меня колоды?'));
    expect(executedTools(frames)).toContain('list_decks');
  });

  test('small-talk ("спасибо!") → ZERO browse-tool executions (tool-call LOG)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([answerTurn('Пожалуйста!')]),
    });
    const convId = await createConversation(cookie);
    const frames = await readSse(await streamReq(cookie, convId, 'спасибо!'));
    const tools = executedTools(frames);
    expect(tools).not.toContain('list_decks');
    expect(tools).not.toContain('browse_cards');
    expect(tools).not.toContain('get_card');
    expect(tools.length).toBe(0);
  });
});
