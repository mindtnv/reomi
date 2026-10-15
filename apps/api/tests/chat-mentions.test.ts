// C7 — composer card-mentions integration tests.
//
// CONTRACT (read from apps/api/src/modules/ai.ts, NOT invented):
//   * `/stream` body accepts `mentionedCardIds` (uuid[], max 8). Resolution is
//     ONE user-scoped select; foreign/missing ids are silently dropped; nothing
//     surviving ⇒ NULL column.
//   * The user row persists `mentions` as a SNAPSHOT (`{cardId, front ≤200,
//     deckName?}`) while its `content` stays CLEAN for display. The model-facing
//     content gets a trailing `<mentioned_cards>` block — for the current turn
//     AND on every history replay (`reconstructHistory`).
//   * `/regenerate` keeps the stored snapshot when the body omits
//     `mentionedCardIds`, and overwrites it (in TX1) when provided.
//   * >8 ids → 400 ValidationError (Elysia body schema).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { db, ensureBuiltins, messages as messagesTable } from '@reomi/db';
import { asc, eq } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import {
  __resetAiClientForTests,
  __setAiClientForTests,
  type AgentChatMessage,
  type AgentStreamChunk,
} from '../src/ai/openai-client.ts';
import {
  callApp,
  resetTestDb,
  seedBasicCard,
  signUpAndCookie,
  uniqueEmail,
} from './helpers.ts';

const app = buildApp();

// ── Scripted fake (captures model-facing messages) ────────────────────────────

let capturedAgentMessages: AgentChatMessage[][] = [];

function scriptedAgentStream(script: { content: string[] }[]) {
  let call = 0;
  return async function* (messages: AgentChatMessage[]): AsyncIterable<AgentStreamChunk> {
    capturedAgentMessages.push(messages);
    const turn = script[call++] ?? { content: ['fallback'] };
    for (const c of turn.content) yield { type: 'content', text: c };
    yield { type: 'finish', reason: 'stop' };
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
function streamReq(
  cookie: string,
  convId: string,
  content: string,
  mentionedCardIds?: string[],
): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/chat/conversations/${convId}/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ content, ...(mentionedCardIds ? { mentionedCardIds } : {}) }),
    }),
  );
}
function regenReq(
  cookie: string,
  convId: string,
  body: Record<string, unknown> = {},
): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/chat/conversations/${convId}/regenerate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    }),
  );
}
async function freshDeck(cookie: string, name = 'D'): Promise<string> {
  return (
    await (await callApp(app, 'POST', '/decks', { cookie, body: { name } })).json<{ id: string }>()
  ).id;
}
async function freshCard(cookie: string, deckId: string, front: string): Promise<string> {
  const card = await seedBasicCard(app, cookie, { deckId, front });
  return card.id;
}
async function rows(convId: string) {
  return db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, convId))
    .orderBy(asc(messagesTable.createdAt));
}

describe('agentic chat — composer card mentions (C7)', () => {
  beforeEach(async () => {
    await resetTestDb();
    await ensureBuiltins(db); // seedBasicCard needs the global Basic note type.
    capturedAgentMessages = [];
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('mentions persist as a snapshot; stored content stays clean; model sees the block', async () => {
    __setAiClientForTests({ chatStreamAgentic: scriptedAgentStream([{ content: ['Ok.'] }]) });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie, 'Bio');
    const cardId = await freshCard(cookie, deckId, 'What is mitosis?');
    const convId = await createConversation(cookie);

    await drain(await streamReq(cookie, convId, 'Explain this card', [cardId]));

    const all = await rows(convId);
    const userRow = all.find((r) => r.role === 'user')!;
    // Stored content is CLEAN — no block.
    expect(userRow.content).toBe('Explain this card');
    expect(userRow.mentions).toHaveLength(1);
    expect(userRow.mentions![0]!.cardId).toBe(cardId);
    expect(userRow.mentions![0]!.front).toContain('What is mitosis?');
    expect(userRow.mentions![0]!.deckName).toBe('Bio');

    // The model-facing current-turn message carries the block.
    const turnMessages = capturedAgentMessages[0]!;
    const userMsg = turnMessages.find((m) => m.role === 'user')!;
    expect(userMsg.content).toContain('Explain this card');
    expect(userMsg.content).toContain('<mentioned_cards>');
    expect(userMsg.content).toContain(`[card:${cardId}]`);
    expect(userMsg.content).toContain('What is mitosis?');

    // …and so does the HISTORY replay on the next turn.
    await drain(await streamReq(cookie, convId, 'And now summarize'));
    const turn2 = capturedAgentMessages[1]!;
    const replayed = turn2.find((m) => m.role === 'user' && m.content.includes('Explain this card'))!;
    expect(replayed.content).toContain('<mentioned_cards>');
    // The follow-up itself carries no block.
    const followUp = turn2.find((m) => m.role === 'user' && m.content.includes('And now summarize'))!;
    expect(followUp.content).not.toContain('<mentioned_cards>');
  });

  test('foreign/missing ids are silently dropped; nothing surviving ⇒ NULL column, no block', async () => {
    __setAiClientForTests({ chatStreamAgentic: scriptedAgentStream([{ content: ['Ok.'] }]) });
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const bDeck = await freshDeck(b.cookie, 'Foreign');
    const bCard = await freshCard(b.cookie, bDeck, 'Not yours');
    const convId = await createConversation(a.cookie);

    await drain(
      await streamReq(a.cookie, convId, 'try to leak', [
        bCard,
        '00000000-0000-4000-8000-000000000000',
      ]),
    );

    const all = await rows(convId);
    const userRow = all.find((r) => r.role === 'user')!;
    expect(userRow.mentions).toBeNull();
    const userMsg = capturedAgentMessages[0]!.find((m) => m.role === 'user')!;
    expect(userMsg.content).not.toContain('<mentioned_cards>');
    expect(userMsg.content).not.toContain('Not yours');
  });

  test('more than 8 mention ids → 400 ValidationError', async () => {
    __setAiClientForTests({ chatStreamAgentic: scriptedAgentStream([{ content: ['Ok.'] }]) });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    const ids = Array.from(
      { length: 9 },
      (_, i) => `00000000-0000-4000-8000-00000000000${i}`,
    );
    const res = await streamReq(cookie, convId, 'too many', ids);
    expect(res.status).toBe(400);
  });

  test('regenerate without mentionedCardIds replays the stored snapshot; with them — overwrites', async () => {
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        { content: ['One.'] },
        { content: ['Two.'] },
        { content: ['Three.'] },
      ]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const cardA = await freshCard(cookie, deckId, 'Card Alpha');
    const cardB = await freshCard(cookie, deckId, 'Card Beta');
    const convId = await createConversation(cookie);

    await drain(await streamReq(cookie, convId, 'about this', [cardA]));

    // Regenerate WITHOUT ids → snapshot unchanged, replay carries cardA's block.
    await drain(await regenReq(cookie, convId));
    let userRow = (await rows(convId)).find((r) => r.role === 'user')!;
    expect(userRow.mentions![0]!.cardId).toBe(cardA);
    const replay1 = capturedAgentMessages[1]!.find((m) => m.role === 'user')!;
    expect(replay1.content).toContain(`[card:${cardA}]`);

    // Regenerate WITH new ids → snapshot overwritten in TX1, replay uses cardB.
    await drain(await regenReq(cookie, convId, { mentionedCardIds: [cardB] }));
    userRow = (await rows(convId)).find((r) => r.role === 'user')!;
    expect(userRow.mentions![0]!.cardId).toBe(cardB);
    const replay2 = capturedAgentMessages[2]!.find((m) => m.role === 'user')!;
    expect(replay2.content).toContain(`[card:${cardB}]`);
    expect(replay2.content).not.toContain(`[card:${cardA}]`);
  });
});
