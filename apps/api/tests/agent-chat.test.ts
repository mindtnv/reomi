// Agentic chat headline regression tests — the milestone's reason-for-being.
//
// These pin the two behaviors the single-shot RAG pipeline could NOT do:
//   C2 (headline): a meta / small-talk turn answers DIRECTLY, with NO card
//      search. We prove it by spying on `embed`: `search_cards.execute` calls
//      `embed()` FIRST, so zero embed calls ⇒ no card search ran. (The old
//      pipeline embedded EVERY user turn unconditionally → it would have run a
//      search + risked a spurious "not in your cards" answer for "thanks!".)
//   Multi-search union-dedup: two `search_cards` calls in ONE turn over two
//      overlapping seeded sets → the final `citation` is the DEDUPED union
//      (not last-only), intersected with the `[card:]` tokens the answer emits.
//
// Same in-process / injection harness as chat.test.ts (NODE_ENV=test forces the
// real AI flags off; the injected fakes flip `isChatEnabled()` on).

import { newUuidV7 } from '@reomi/shared';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { db, messages as messagesTable } from '@reomi/db';
import { asc, eq } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import {
  __resetAiClientForTests,
  __setAiClientForTests,
  type AgentChatMessage,
  type AgentStreamChunk,
} from '../src/ai/openai-client.ts';
import { drainIndexQueue } from '../src/ai/index-queue.ts';
import { callApp, resetTestDb, seedBasicCard, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();
const EMBED_DIM = 1536;

// Deterministic text→vector (same shape the index queue + retrieve tests use):
// embedding a card's exact render_text reproduces its indexed chunk vector.
function vectorFor(text: string): number[] {
  const v = new Array<number>(EMBED_DIM).fill(0);
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  for (let i = 0; i < 8; i++) {
    const idx = (h + i * 131) % EMBED_DIM;
    v[idx] = ((h >>> (i * 3)) % 100) / 100 + 0.01;
  }
  return v;
}

// ── Scripted agentic fake (one turn per `chatStreamAgentic` call) ─────────────

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

function scriptedAgentStream(script: AgentTurn[]) {
  let call = 0;
  return async function* (_messages: AgentChatMessage[]): AsyncIterable<AgentStreamChunk> {
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
  expect(res.headers.get('content-type')).toContain('text/event-stream');
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
  expect(res.status).toBe(200);
  return (await res.json<{ id: string }>()).id;
}
async function freshDeck(cookie: string, name = 'D', parentId?: string): Promise<string> {
  return (
    await (
      await callApp(app, 'POST', '/decks', {
        cookie,
        body: { name, ...(parentId ? { parentId } : {}) },
      })
    ).json<{ id: string }>()
  ).id;
}

describe('agentic chat — headline regressions', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  // ── C2 (HEADLINE) ───────────────────────────────────────────────────────────
  // A meta / small-talk turn must answer DIRECTLY — no card search at all. The
  // EMBED spy is the proof: `search_cards.execute` embeds the query FIRST, so
  // `embedCalls === 0` is definitive evidence that no search ran. (Asserting on
  // `embed` — not `retrieve` — because embed is the FIRST side-effect inside the
  // tool; zero embeds rules out even a search that would have returned nothing.)
  test('meta/small-talk turn: no card search runs (embed spy = 0), zero tool_calls, no "not in your cards"', async () => {
    let embedCalls = 0;
    const embed = (texts: string[]): Promise<number[][]> => {
      embedCalls += 1;
      return Promise.resolve(texts.map(vectorFor));
    };

    // Inject the client BEFORE seeding so the write-hook actually enqueues the card
    // for indexing (the queue is gated on the effective embedding switch).
    __setAiClientForTests({
      embed,
      // The model answers the small-talk question directly — no tool call.
      chatStreamAgentic: scriptedAgentStream([answerTurn('You asked about your cards earlier.')]),
    });

    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    // Seed a card so the index queue exercises `embed` during indexing — then
    // reset the spy to zero so the count reflects ONLY the chat turn.
    const deckId = await freshDeck(cookie);
    await seedBasicCard(app, cookie, { deckId, front: 'unrelated', back: 'content' });
    await drainIndexQueue({ timeoutMs: 5000 });
    expect(embedCalls).toBeGreaterThan(0); // indexing DID embed the seeded card.
    embedCalls = 0; // discount the indexing embeds — count only the chat turn.

    const convId = await createConversation(cookie);
    const res = await streamReq(cookie, convId, 'о чём я спрашивал?');
    const frames = await readSse(res);

    // (1) ZERO embed calls during the turn ⇒ search_cards never executed.
    expect(embedCalls).toBe(0);

    // (2) ZERO tool_call frames in the SSE stream.
    expect(frames.some((f) => f.event === 'tool_call')).toBe(false);
    expect(frames.some((f) => f.event === 'tool_result')).toBe(false);

    // (3) The answer has NO "not in your cards"-equivalent string.
    const doneId = (frames.find((f) => f.event === 'done')!.data as { messageId: string }).messageId;
    const [assistant] = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.id, doneId))
      .limit(1);
    expect(assistant!.content).toBe('You asked about your cards earlier.');
    expect(assistant!.content.toLowerCase()).not.toContain('not in your cards');
    expect(assistant!.content.toLowerCase()).not.toContain('no matching card');
    // The citation event is present but empty (no grounding).
    const citationFrame = frames.find((f) => f.event === 'citation');
    expect((citationFrame!.data as { citations: unknown[] }).citations).toEqual([]);
  });

  test('"thanks!" turn answers directly with zero embeds', async () => {
    let embedCalls = 0;
    const embed = (texts: string[]): Promise<number[][]> => {
      embedCalls += 1;
      return Promise.resolve(texts.map(vectorFor));
    };
    __setAiClientForTests({
      embed,
      chatStreamAgentic: scriptedAgentStream([answerTurn('You are welcome!')]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    const res = await streamReq(cookie, convId, 'thanks!');
    const frames = await readSse(res);

    expect(embedCalls).toBe(0);
    expect(frames.some((f) => f.event === 'tool_call')).toBe(false);
    const done = frames.find((f) => f.event === 'done');
    expect(done).toBeTruthy();
  });

  // ── Multi-search union-dedup ──────────────────────────────────────────────────
  // Two `search_cards` calls in ONE turn over two overlapping seeded sets. The
  // final `citation` must be the DEDUPED union of both results (not last-only),
  // intersected with the `[card:]` tokens the answer emits.
  test('two search_cards calls → final citation is the deduped union', async () => {
    // Cards are seeded AFTER injection (lazily referenced by the embedder closure)
    // so the write-hook enqueues them for indexing — the queue is gated on the
    // effective embedding switch, which the injected embed flips on.
    let cardA: { id: string; renderText: string };
    let cardB: { id: string; renderText: string };

    // Deterministic embedder where each query maps to ONE specific card's vector,
    // so the two scripted searches hit DIFFERENT cards. The follow-up "find A again"
    // re-hits A (overlap) to exercise dedup. Indexing falls to the default branch
    // (embed the chunk text verbatim) so a query of the card's render_text matches.
    const embed = (texts: string[]): Promise<number[][]> =>
      Promise.resolve(
        texts.map((t) => {
          if (t === 'find A') return vectorFor(cardA.renderText);
          if (t === 'find B') return vectorFor(cardB.renderText);
          if (t === 'find A again') return vectorFor(cardA.renderText);
          return vectorFor(t);
        }),
      );

    // Inject the embedder FIRST so the write-hook enqueues seeded cards (the queue
    // is gated on the effective embedding switch). The agentic script is added
    // after the cards exist (its turn 2 references the card ids).
    __setAiClientForTests({ embed });

    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    cardA = await seedBasicCard(app, cookie, { deckId, front: 'Topic A', back: 'about alpha' });
    cardB = await seedBasicCard(app, cookie, { deckId, front: 'Topic B', back: 'about beta' });

    // Turn 0: TWO search calls (A, then A-again to overlap). Turn 1: another search
    // (B). Turn 2: final answer citing BOTH A and B. The union must dedup A.
    __setAiClientForTests({
      embed,
      chatStreamAgentic: scriptedAgentStream([
        searchTurn([
          { id: 'c1', name: 'search_cards', args: { query: 'find A' } },
          { id: 'c2', name: 'search_cards', args: { query: 'find A again' } },
        ]),
        searchTurn([{ id: 'c3', name: 'search_cards', args: { query: 'find B' } }]),
        answerTurn(`Both topics: [card:${cardA.id}] and [card:${cardB.id}].`),
      ]),
    });
    await drainIndexQueue({ timeoutMs: 5000 });

    const convId = await createConversation(cookie);
    const res = await streamReq(cookie, convId, 'tell me about A and B');
    const frames = await readSse(res);

    const citationFrame = frames.find((f) => f.event === 'citation');
    expect(citationFrame).toBeTruthy();
    const cited = (citationFrame!.data as { citations: { cardId: string }[] }).citations;
    const citedIds = cited.map((c) => c.cardId).sort();

    // Deduped union of {A, A, B} = {A, B} — A appears ONCE, not twice.
    expect(citedIds).toEqual([cardA.id, cardB.id].sort());
    expect(citedIds.filter((id) => id === cardA.id).length).toBe(1);

    // Three search rounds persisted three role:tool rows + two assistant(tool_calls)
    // rows + one final assistant row.
    const rows = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, convId))
      .orderBy(asc(messagesTable.createdAt));
    expect(rows.filter((m) => m.role === 'tool').length).toBe(3);
    expect(
      rows.filter((m) => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0).length,
    ).toBe(2);
    const finalAssistant = rows.filter(
      (m) => m.role === 'assistant' && (m.toolCalls?.length ?? 0) === 0,
    );
    expect(finalAssistant.length).toBe(1);
    expect(finalAssistant[0]!.citations.map((c) => c.cardId).sort()).toEqual(
      [cardA.id, cardB.id].sort(),
    );
  });
});

// ── M6 / M7 — progress-tool routing carve-out + small-talk guard ──────────────
//
// The progress tools (study_stats/card_progress) do NOT embed, so the embed-count
// guard is BLIND to a spurious progress-tool call (M7). We assert ZERO progress
// tool EXECUTIONS via the SSE `tool_call` frames (the loop emits one `tool_call`
// frame per executed call, carrying the tool `name`).

/** Names of tools the loop actually executed, from the SSE `tool_call` frames. */
function executedTools(frames: SseFrame[]): string[] {
  return frames
    .filter((f) => f.event === 'tool_call')
    .map((f) => (f.data as { name: string }).name);
}

describe('agentic chat — progress-tool routing (M6) + small-talk guard (M7)', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('progress-meta question → study_stats is CALLED', async () => {
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        searchTurn([{ id: 's1', name: 'study_stats', args: { scope: 'global' } }]),
        answerTurn('You are doing fine.'),
      ]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    const frames = await readSse(await streamReq(cookie, convId, 'что я заваливаю?'));
    expect(executedTools(frames)).toContain('study_stats');
  });

  test('card-history question → card_progress is CALLED', async () => {
    let embedCalls = 0;
    const countingEmbed = (texts: string[]) => {
      embedCalls += 1;
      return Promise.resolve(texts.map(vectorFor));
    };
    __setAiClientForTests({ embed: countingEmbed });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const card = await seedBasicCard(app, cookie, { deckId, front: 'q', back: 'a' });
    // Drain the index queue THEN reset the spy so the count reflects only the
    // chat turn (indexing the seeded card embeds it asynchronously).
    await drainIndexQueue({ timeoutMs: 5000 });
    expect(embedCalls).toBeGreaterThan(0);
    embedCalls = 0;

    __setAiClientForTests({
      embed: countingEmbed,
      chatStreamAgentic: scriptedAgentStream([
        searchTurn([{ id: 'p1', name: 'card_progress', args: { cardId: card.id } }]),
        answerTurn('That card is doing well.'),
      ]),
    });
    const convId = await createConversation(cookie);
    const frames = await readSse(await streamReq(cookie, convId, 'how is this card scheduled?'));
    expect(executedTools(frames)).toContain('card_progress');
    // card_progress does NOT embed — the embed spy stays at zero (M7).
    expect(embedCalls).toBe(0);
  });

  test('conversation-meta question → NO tool call (the carve-out)', async () => {
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([answerTurn('You asked about your decks earlier.')]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    const frames = await readSse(await streamReq(cookie, convId, 'summarize what we discussed'));
    expect(frames.some((f) => f.event === 'tool_call')).toBe(false);
    expect(executedTools(frames)).toEqual([]);
  });

  test('small-talk → ZERO study_stats/card_progress executions (tool-call LOG, not embedCalls — M7)', async () => {
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([answerTurn('You are welcome!')]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    const frames = await readSse(await streamReq(cookie, convId, 'спасибо!'));
    const tools = executedTools(frames);
    expect(tools).not.toContain('study_stats');
    expect(tools).not.toContain('card_progress');
    expect(tools.length).toBe(0);
  });
});

// ── S7 — per-deck retrieval scope (AC3.7) ─────────────────────────────────────
//
// `search_cards` forwards the turn's resolved deck subtree (ctx.deckIds) to
// `retrieve({ deckIds })`. A card in the scoped deck is returned; a card only in
// another deck is NOT. An unscoped turn forwards NO deckIds (byte-identical to
// pre-S7 — covered by the existing grounding tests passing).

describe('agentic chat — per-deck retrieval scope (S7 / AC3.7)', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('deck-scoped search_cards: card in scoped deck returned, card only in other deck NOT', async () => {
    let cardA: { id: string; renderText: string };
    let cardB: { id: string; renderText: string };
    const embed = (texts: string[]): Promise<number[][]> =>
      Promise.resolve(
        texts.map((t) => {
          // A query that matches BOTH cards' content equally so the deck filter
          // (not relevance) is what excludes B.
          if (t === 'find topic') return vectorFor(cardA.renderText);
          return vectorFor(t);
        }),
      );
    __setAiClientForTests({ embed });

    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckA = await freshDeck(cookie, 'A');
    const deckB = await freshDeck(cookie, 'B');
    cardA = await seedBasicCard(app, cookie, { deckId: deckA, front: 'shared topic', back: 'in A' });
    cardB = await seedBasicCard(app, cookie, { deckId: deckB, front: 'shared topic', back: 'in B' });

    __setAiClientForTests({
      embed,
      chatStreamAgentic: scriptedAgentStream([
        searchTurn([{ id: 'c1', name: 'search_cards', args: { query: 'find topic' } }]),
        answerTurn(`Found [card:${cardA.id}].`),
      ]),
    });
    await drainIndexQueue({ timeoutMs: 5000 });

    const convId = await createConversation(cookie);
    // Scope the turn to deck A.
    const req = new Request(`http://localhost/chat/conversations/${convId}/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ content: 'find the topic', deckId: deckA }),
    });
    const frames = await readSse(await app.handle(req));
    const toolResult = frames.find((f) => f.event === 'tool_result');
    const cites = (toolResult!.data as { citations?: { cardId: string }[] }).citations ?? [];
    const ids = cites.map((c) => c.cardId);
    expect(ids).toContain(cardA.id);
    expect(ids).not.toContain(cardB.id);
  });

  test('subtree: a card in a CHILD deck is in scope when scoped to the PARENT', async () => {
    let childCard: { id: string; renderText: string };
    const embed = (texts: string[]): Promise<number[][]> =>
      Promise.resolve(
        texts.map((t) => (t === 'find child' ? vectorFor(childCard.renderText) : vectorFor(t))),
      );
    __setAiClientForTests({ embed });

    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const parent = await freshDeck(cookie, 'Parent');
    const child = await freshDeck(cookie, 'Child', parent);
    childCard = await seedBasicCard(app, cookie, { deckId: child, front: 'child topic', back: 'x' });

    __setAiClientForTests({
      embed,
      chatStreamAgentic: scriptedAgentStream([
        searchTurn([{ id: 'c1', name: 'search_cards', args: { query: 'find child' } }]),
        answerTurn(`Found [card:${childCard.id}].`),
      ]),
    });
    await drainIndexQueue({ timeoutMs: 5000 });

    const convId = await createConversation(cookie);
    const req = new Request(`http://localhost/chat/conversations/${convId}/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ content: 'find it', deckId: parent }),
    });
    const frames = await readSse(await app.handle(req));
    const toolResult = frames.find((f) => f.event === 'tool_result');
    const cites = (toolResult!.data as { citations?: { cardId: string }[] }).citations ?? [];
    expect(cites.map((c) => c.cardId)).toContain(childCard.id);
  });

  test('foreign deckId → empty scope: no cards returned (NOT a global fallback)', async () => {
    const foreignDeck = newUuidV7();
    let card: { id: string; renderText: string };
    const embed = (texts: string[]): Promise<number[][]> =>
      Promise.resolve(texts.map((t) => (t === 'find it' ? vectorFor(card.renderText) : vectorFor(t))));
    __setAiClientForTests({ embed });

    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    card = await seedBasicCard(app, cookie, { deckId, front: 'topic', back: 'x' });

    __setAiClientForTests({
      embed,
      chatStreamAgentic: scriptedAgentStream([
        searchTurn([{ id: 'c1', name: 'search_cards', args: { query: 'find it' } }]),
        answerTurn('done'),
      ]),
    });
    await drainIndexQueue({ timeoutMs: 5000 });

    const convId = await createConversation(cookie);
    const req = new Request(`http://localhost/chat/conversations/${convId}/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ content: 'find it', deckId: foreignDeck }),
    });
    const frames = await readSse(await app.handle(req));
    const toolResult = frames.find((f) => f.event === 'tool_result');
    const cites = (toolResult!.data as { citations?: { cardId: string }[] }).citations ?? [];
    // Empty scope — the owned card is NOT returned (no global fallback).
    expect(cites.map((c) => c.cardId)).not.toContain(card.id);
  });
});
