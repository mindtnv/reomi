// Agentic tool-calling chat integration tests (agentic milestone, AC1/AC2/AC3/AC5/AC6).
//
// Conversation CRUD + cross-user scoping, plus the SSE stream endpoint read
// fully IN-PROCESS via `(await app.handle(req)).body` (no network, no timing
// flake). A DETERMINISTIC fake embedder + a scripted `chatStreamAgentic` make
// every path reproducible without real API keys. Injecting a fake
// `chatStreamAgentic` flips `isChatEnabled()` on (openai-client seam), so chat
// works even though CHAT_API_KEY is unset in the test env.
//
// CONTRACT (the loop in apps/api/src/modules/ai.ts):
//   The handler calls `chatStreamAgentic` REPEATEDLY — once per agent step. Each
//   call is a fresh generator. So the fake is scripted PER CALL (a turn list):
//   turn 0 may stream a `tool_call_delta` sequence + `finish:tool_calls`; the
//   loop then executes the read tool server-side, appends the result to the
//   gateway `messages[]`, and calls `chatStreamAgentic` AGAIN (turn 1) to get
//   the final `content` + `finish:stop`. Per turn the SSE order is:
//     reasoning* / token* → (per tool round) tool_call(running) →
//     tool_result(ok, citations?) → … → ONE citation event on finish → done.
//   `citation` is emitted ONLY after the loop and only carries cards the model
//   actually grounded on via `search_cards` (union-dedup, intersected with the
//   `[card:<id>]` tokens the answer emitted). A turn that calls no tool emits an
//   EMPTY citation list and zero `tool_call` frames.
//
// Covers:
//   * conversation CRUD; cross-user GET → 404; list excludes others.
//   * stream: ≥2 `event: token` frames arrive BEFORE `event: done` (AC6).
//   * a turn that THROWS after the first delta → terminal `event: error` frame,
//     NOT a JSON `.onError` body (SHOULD-FIX #7).
//   * grounding: seeded+indexed card → model calls search_cards → cites it (AC2).
//   * not-found: search_cards returns zero hits → empty citation, honest answer (AC1).
//   * tool turn persistence: assistant(tool_calls) + role:tool + final assistant
//     rows persisted; citations on the final assistant turn (AC3/AC5).
//   * ai_disabled → 503 when chat is disabled.
//   * GET /cards/:id returns the caller's card; 404 on a foreign id (SHOULD-FIX #4).

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

// Deterministic embedder (shared shape with retrieve/index tests). The query a
// scripted `search_cards` call passes is embedded by the SAME function the index
// queue used, so embedding the card's exact `renderText` produces an identical
// vector (cosine distance 0 → score 1.0, clears RETRIEVE_MIN_SCORE).
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
function fakeEmbed(texts: string[]): Promise<number[][]> {
  return Promise.resolve(texts.map(vectorFor));
}

// ── Agentic fake client ──────────────────────────────────────────────────────
//
// One `AgentTurn` scripts a single `chatStreamAgentic` call (one agent step). A
// `script` is the ORDERED list of turns; `scriptedAgentStream(script)` returns a
// `chatStreamAgentic`-shaped fn that yields the next turn's chunks on each call
// (the loop calls once per step), capturing the `messages[]` each call saw.
//
// Helpers build the two common turn shapes:
//   * `answerTurn(text)`   — content delta + finish:stop (single-shot or
//                            follow-up answer; no tools).
//   * `searchTurn(calls)`  — one `tool_call_delta` sequence per call (id+name,
//                            then the args JSON fragment) + finish:tool_calls.
//   * `errorTurn(text)`    — one content delta then THROWS (post-flush failure).

interface ToolCallScript {
  id: string;
  name: string;
  /** Args object — JSON-stringified and emitted as a single argsFragment. */
  args: Record<string, unknown>;
}

interface AgentTurn {
  reasoning?: string[];
  content?: string[];
  toolCalls?: ToolCallScript[];
  finish?: 'stop' | 'tool_calls' | 'length';
  /** Throw AFTER yielding the (single) content delta — post-flush failure path. */
  throwAfter?: string;
}

/** All `messages[]` arrays each `chatStreamAgentic` call observed, in call order. */
let capturedAgentMessages: AgentChatMessage[][] = [];

function answerTurn(text: string, reasoning?: string[]): AgentTurn {
  return { reasoning, content: [text], finish: 'stop' };
}

function answerTurnDeltas(deltas: string[]): AgentTurn {
  return { content: deltas, finish: 'stop' };
}

function searchTurn(calls: ToolCallScript[]): AgentTurn {
  return { toolCalls: calls, finish: 'tool_calls' };
}

function errorTurn(firstDelta: string): AgentTurn {
  return { content: [firstDelta], throwAfter: firstDelta };
}

/**
 * Build a `chatStreamAgentic` fake from an ordered turn script. Each invocation
 * (one agent step) yields the corresponding turn's chunks: reasoning → content →
 * a fragmented `tool_call_delta` sequence per scripted call → a `finish` chunk.
 * If the script runs out of turns the fake yields a terminal `finish:stop` with
 * no content (defensive — the loop should never call past the scripted answer).
 */
function scriptedAgentStream(script: AgentTurn[]) {
  let call = 0;
  return async function* (messages: AgentChatMessage[]): AsyncIterable<AgentStreamChunk> {
    capturedAgentMessages.push(messages);
    const turn = script[call++];
    if (!turn) {
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    for (const r of turn.reasoning ?? []) yield { type: 'reasoning', text: r };
    for (const c of turn.content ?? []) {
      yield { type: 'content', text: c };
      if (turn.throwAfter !== undefined && c === turn.throwAfter) {
        throw new Error('upstream_5xx');
      }
    }
    let index = 0;
    for (const tc of turn.toolCalls ?? []) {
      // id + name first, then the args JSON as one fragment (mirrors a real
      // stream that splits the name from the arguments across deltas).
      yield { type: 'tool_call_delta', index, id: tc.id, name: tc.name };
      yield { type: 'tool_call_delta', index, argsFragment: JSON.stringify(tc.args) };
      index += 1;
    }
    if (turn.finish) yield { type: 'finish', reason: turn.finish };
  };
}

/** Convenience: latest `messages[]` the gateway saw (the final-answer call). */
function lastCapturedMessages(): AgentChatMessage[] | null {
  return capturedAgentMessages[capturedAgentMessages.length - 1] ?? null;
}

interface SseFrame {
  event: string;
  data: unknown;
}

/** Read an SSE Response body fully in-process and parse frames in arrival order. */
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

/** POST the stream endpoint with a session cookie and return the raw Response. */
async function streamReq(cookie: string, convId: string, content: string): Promise<Response> {
  const req = new Request(`http://localhost/chat/conversations/${convId}/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ content }),
  });
  return app.handle(req);
}

async function createConversation(cookie: string, title?: string): Promise<string> {
  const res = await callApp(app, 'POST', '/chat/conversations', { cookie, body: { title } });
  expect(res.status).toBe(200);
  return (await res.json<{ id: string }>()).id;
}

async function freshDeck(cookie: string, name = 'D'): Promise<string> {
  return (
    await (await callApp(app, 'POST', '/decks', { cookie, body: { name } })).json<{ id: string }>()
  ).id;
}

describe('chat (agentic)', () => {
  beforeEach(async () => {
    await resetTestDb();
    capturedAgentMessages = [];
    // Default: embedding + an agentic single-shot answer (chat enabled via the seam).
    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([answerTurnDeltas(['Hello', ' ', 'world'])]),
    });
  });

  afterEach(() => {
    __resetAiClientForTests();
  });

  // ── Conversation CRUD + scoping (AC5) ──────────────────────────────────────

  test('conversation CRUD: create, get, list, delete', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const id = await createConversation(cookie, 'My thread');

    const got = await callApp(app, 'GET', `/chat/conversations/${id}`, { cookie });
    expect(got.status).toBe(200);
    const body = await got.json<{ conversation: { id: string; title: string }; messages: unknown[] }>();
    expect(body.conversation.id).toBe(id);
    expect(body.conversation.title).toBe('My thread');
    expect(body.messages).toEqual([]);

    const list = await callApp(app, 'GET', '/chat/conversations', { cookie });
    const listed = await list.json<{ items: { id: string }[] }>();
    expect(listed.items.map((c) => c.id)).toContain(id);

    const del = await callApp(app, 'DELETE', `/chat/conversations/${id}`, { cookie });
    expect(del.status).toBe(200);
    const gone = await callApp(app, 'GET', `/chat/conversations/${id}`, { cookie });
    expect(gone.status).toBe(404);
  });

  test('cross-user GET → 404 and list excludes others (AC5)', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const aId = await createConversation(a.cookie, 'A thread');

    // B cannot read A's conversation.
    const foreign = await callApp(app, 'GET', `/chat/conversations/${aId}`, { cookie: b.cookie });
    expect(foreign.status).toBe(404);

    // B's list does not include A's conversation.
    const bList = await callApp(app, 'GET', '/chat/conversations', { cookie: b.cookie });
    const items = (await bList.json<{ items: { id: string }[] }>()).items;
    expect(items.map((c) => c.id)).not.toContain(aId);

    // B cannot delete A's conversation.
    const delForeign = await callApp(app, 'DELETE', `/chat/conversations/${aId}`, { cookie: b.cookie });
    expect(delForeign.status).toBe(404);
  });

  // ── Streaming (AC6) ─────────────────────────────────────────────────────────

  test('stream: ≥2 token frames arrive BEFORE done (AC6)', async () => {
    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([answerTurnDeltas(['The ', 'quick ', 'brown ', 'fox'])]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);

    const res = await streamReq(cookie, convId, 'tell me something');
    expect(res.status).toBe(200);
    const frames = await readSse(res);

    const doneIdx = frames.findIndex((f) => f.event === 'done');
    expect(doneIdx).toBeGreaterThanOrEqual(0);
    const tokenFramesBeforeDone = frames.slice(0, doneIdx).filter((f) => f.event === 'token');
    expect(tokenFramesBeforeDone.length).toBeGreaterThanOrEqual(2);
    // Done carries the assistant message id.
    expect((frames[doneIdx]!.data as { messageId: string }).messageId).toBeTruthy();
    // A single citation frame ALWAYS precedes done (empty here — no tool called).
    const citationFrame = frames.slice(0, doneIdx).find((f) => f.event === 'citation');
    expect(citationFrame).toBeTruthy();
    expect((citationFrame!.data as { citations: unknown[] }).citations).toEqual([]);
    // A no-tool turn emits zero tool_call frames.
    expect(frames.some((f) => f.event === 'tool_call')).toBe(false);
  });

  test('post-flush error → terminal event:error frame, NOT a JSON onError body (SHOULD-FIX #7)', async () => {
    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([errorTurn('first ')]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);

    const res = await streamReq(cookie, convId, 'will fail mid-stream');
    // Headers were committed as event-stream BEFORE the error → status 200,
    // content-type is event-stream, and the body carries an `event: error` frame
    // rather than a JSON `{ error: 'InternalServerError' }` from app.ts's onError.
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const frames = await readSse(res);

    expect(frames.some((f) => f.event === 'token')).toBe(true);
    const errFrame = frames.find((f) => f.event === 'error');
    expect(errFrame).toBeTruthy();
    // Raw upstream error text is NOT forwarded — it's an unrecognized internal
    // string, so the client gets the opaque `chat_failed` code (Security Low-1).
    expect((errFrame!.data as { message: string }).message).toBe('chat_failed');
    // No done frame on a mid-stream failure.
    expect(frames.some((f) => f.event === 'done')).toBe(false);

    // No half-message persisted (transcript only committed at `done`).
    const msgs = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, convId))
      .orderBy(asc(messagesTable.createdAt));
    expect(msgs.filter((m) => m.role === 'assistant').length).toBe(0);
    expect(msgs.filter((m) => m.role === 'tool').length).toBe(0);
    expect(msgs.filter((m) => m.role === 'user').length).toBe(1);
  });

  // ── Grounding (AC2/AC3) ─────────────────────────────────────────────────────

  test('grounding: model calls search_cards → cites the card (AC2)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const card = await seedBasicCard(app, cookie, {
      deckId,
      front: 'What are mitochondria?',
      back: 'The powerhouse of the cell',
    });
    await drainIndexQueue({ timeoutMs: 5000 });

    // Turn 0: model calls search_cards with the card's exact render_text (so the
    // deterministic query embedding matches the indexed chunk). Turn 1: the model
    // answers, citing the card via its `[card:<id>]` token.
    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        searchTurn([{ id: 'call_1', name: 'search_cards', args: { query: card.renderText } }]),
        answerTurn(`Mitochondria are the powerhouse. [card:${card.id}]`),
      ]),
    });

    const convId = await createConversation(cookie);
    const res = await streamReq(cookie, convId, 'What are mitochondria?');
    const frames = await readSse(res);

    // Frame order: tool_call(search_cards, running) → tool_result(ok) precede the
    // final citation event, which itself precedes done.
    const toolCallIdx = frames.findIndex(
      (f) => f.event === 'tool_call' && (f.data as { name: string }).name === 'search_cards',
    );
    const toolResultIdx = frames.findIndex((f) => f.event === 'tool_result');
    const citationIdx = frames.findIndex((f) => f.event === 'citation');
    const doneIdx = frames.findIndex((f) => f.event === 'done');
    expect(toolCallIdx).toBeGreaterThanOrEqual(0);
    expect((frames[toolCallIdx]!.data as { status: string }).status).toBe('running');
    expect(toolResultIdx).toBeGreaterThan(toolCallIdx);
    expect((frames[toolResultIdx]!.data as { ok: boolean }).ok).toBe(true);
    expect(citationIdx).toBeGreaterThan(toolResultIdx);
    expect(doneIdx).toBeGreaterThan(citationIdx);

    const citations = (frames[citationIdx]!.data as { citations: { cardId: string }[] }).citations;
    expect(citations.map((c) => c.cardId)).toContain(card.id);

    // The follow-up gateway call carried the tool-result text (grounding contract):
    // the assistant(tool_calls) message + the role:tool result with the card token.
    const followUp = lastCapturedMessages();
    const promptText = JSON.stringify(followUp);
    expect(promptText).toContain(`[card:${card.id}]`);
    expect(promptText).toContain('powerhouse');
    expect(followUp!.some((m) => m.role === 'tool')).toBe(true);
    expect(
      followUp!.some((m) => m.role === 'assistant' && (m.tool_calls?.length ?? 0) > 0),
    ).toBe(true);

    // Persisted transcript: an assistant(tool_calls) row + a role:tool row + the
    // final assistant text row, in order.
    const rows = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.conversationId, convId))
      .orderBy(asc(messagesTable.createdAt));
    const toolCallRow = rows.find((m) => m.role === 'assistant' && (m.toolCalls?.length ?? 0) > 0);
    const toolResultRow = rows.find((m) => m.role === 'tool');
    const finalAssistant = rows.find(
      (m) => m.role === 'assistant' && (m.toolCalls?.length ?? 0) === 0,
    );
    expect(toolCallRow).toBeTruthy();
    expect(toolCallRow!.toolCalls![0]!.name).toBe('search_cards');
    expect(toolCallRow!.content).toBe('');
    expect(toolResultRow).toBeTruthy();
    expect(toolResultRow!.toolCallId).toBe('call_1');
    expect(finalAssistant).toBeTruthy();
    expect(finalAssistant!.citations.map((c) => c.cardId)).toContain(card.id);
  });

  test('tool turn persistence: tool_calls + role:tool + final assistant rows, citations on final (AC3/AC5)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const card = await seedBasicCard(app, cookie, { deckId, front: 'Cite me', back: 'persisted' });
    await drainIndexQueue({ timeoutMs: 5000 });

    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        searchTurn([{ id: 'call_x', name: 'search_cards', args: { query: card.renderText } }]),
        answerTurn(`Here is the answer. [card:${card.id}]`),
      ]),
    });

    const convId = await createConversation(cookie);
    const res = await streamReq(cookie, convId, 'cite the card');
    const frames = await readSse(res);
    const doneId = (frames.find((f) => f.event === 'done')!.data as { messageId: string }).messageId;

    // The `done` messageId is the FINAL assistant text row; citations ride it.
    const [finalAssistant] = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.id, doneId))
      .limit(1);
    expect(finalAssistant).toBeTruthy();
    expect(finalAssistant!.role).toBe('assistant');
    expect(finalAssistant!.content).toContain('Here is the answer.');
    expect(finalAssistant!.toolCalls).toBeNull();
    expect(finalAssistant!.citations.map((c) => c.cardId)).toContain(card.id);

    // GET re-read returns the full agentic transcript in order: user → assistant
    // (tool_calls, '' content) → tool (JSON result) → assistant (final text).
    const thread = await callApp(app, 'GET', `/chat/conversations/${convId}`, { cookie });
    const body = await thread.json<{
      messages: {
        role: string;
        content: string;
        toolCalls: { name: string }[] | null;
        toolCallId: string | null;
        citations: { cardId: string }[];
      }[];
    }>();
    const roles = body.messages.map((m) => m.role);
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant']);

    const toolCallMsg = body.messages[1]!;
    expect(toolCallMsg.toolCalls?.[0]?.name).toBe('search_cards');
    expect(toolCallMsg.content).toBe('');

    const toolResultMsg = body.messages[2]!;
    expect(toolResultMsg.toolCallId).toBe('call_x');
    // The role:tool content is the JSON-stringable model-facing result text and
    // carries the cited card token.
    expect(toolResultMsg.content).toContain(`[card:${card.id}]`);

    const finalMsg = body.messages[3]!;
    expect(finalMsg.citations.map((c) => c.cardId)).toContain(card.id);
  });

  // ── Not-found path (AC1) ────────────────────────────────────────────────────

  test('not-found: search_cards returns zero hits → empty citation, honest answer (AC1)', async () => {
    // No cards seeded → search_cards retrieval returns []. The model calls the
    // tool, sees an empty result, and answers honestly. No citation rides the turn.
    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        searchTurn([{ id: 'call_n', name: 'search_cards', args: { query: 'nobody has this' } }]),
        answerTurnDeltas(['No matching ', 'card was found.']),
      ]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    const res = await streamReq(cookie, convId, 'something nobody has a card about');
    const frames = await readSse(res);

    // The tool ran (ok, but with no citations).
    const toolResult = frames.find((f) => f.event === 'tool_result');
    expect(toolResult).toBeTruthy();
    expect((toolResult!.data as { ok: boolean }).ok).toBe(true);
    expect((toolResult!.data as { citations?: unknown[] }).citations).toBeUndefined();

    // A citation frame is still emitted, but EMPTY.
    const citationFrame = frames.find((f) => f.event === 'citation');
    expect(citationFrame).toBeTruthy();
    expect((citationFrame!.data as { citations: unknown[] }).citations).toEqual([]);

    const doneId = (frames.find((f) => f.event === 'done')!.data as { messageId: string }).messageId;
    const [assistant] = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.id, doneId))
      .limit(1);
    expect(assistant!.citations).toEqual([]);
    expect(assistant!.content).toContain('No matching card was found.');

    // The follow-up call's tool result told the model no cards matched.
    const followUp = lastCapturedMessages();
    const toolMsg = followUp!.find((m) => m.role === 'tool');
    expect(toolMsg).toBeTruthy();
    expect(toolMsg!.content.toLowerCase()).toContain('no matching cards were found');
  });

  test('no-tool answer (model answers directly): zero tool_call frames, empty citation (AC1)', async () => {
    // The model answers a meta/small-talk turn WITHOUT calling any tool.
    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([answerTurnDeltas(['You ', 'are ', 'welcome.'])]),
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    const res = await streamReq(cookie, convId, 'thanks!');
    const frames = await readSse(res);

    expect(frames.some((f) => f.event === 'tool_call')).toBe(false);
    expect(frames.some((f) => f.event === 'tool_result')).toBe(false);
    const citationFrame = frames.find((f) => f.event === 'citation');
    expect(citationFrame).toBeTruthy();
    expect((citationFrame!.data as { citations: unknown[] }).citations).toEqual([]);

    const doneId = (frames.find((f) => f.event === 'done')!.data as { messageId: string }).messageId;
    const [assistant] = await db
      .select()
      .from(messagesTable)
      .where(eq(messagesTable.id, doneId))
      .limit(1);
    expect(assistant!.content).toBe('You are welcome.');
    expect(assistant!.citations).toEqual([]);
  });

  // ── Disabled gate ───────────────────────────────────────────────────────────

  test('ai_disabled → 503 when chat is disabled', async () => {
    // Inject ONLY an embedder — no chat surface → isChatEnabled() stays false.
    __setAiClientForTests({ embed: fakeEmbed });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);

    const res = await streamReq(cookie, convId, 'hi');
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ error: 'ai_disabled' });
  });

  test('stream on a foreign conversation → 404 (pre-flush)', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const aConv = await createConversation(a.cookie);
    const res = await streamReq(b.cookie, aConv, 'hi');
    expect(res.status).toBe(404);
  });

  // ── GET /cards/:id (SHOULD-FIX #4) ──────────────────────────────────────────

  test('GET /cards/:id returns the caller card; 404 on a foreign id', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const deckA = await freshDeck(a.cookie, 'A');
    const card = await seedBasicCard(app, a.cookie, { deckId: deckA, front: 'mine', back: 'card' });

    // Owner fetch → enriched card.
    const mine = await callApp(app, 'GET', `/cards/${card.id}`, { cookie: a.cookie });
    expect(mine.status).toBe(200);
    const body = await mine.json<{ id: string; note: { fieldValues: Record<string, string> } | null }>();
    expect(body.id).toBe(card.id);
    expect(body.note).not.toBeNull();
    expect(body.note!.fieldValues.Front).toBe('mine');

    // Foreign fetch → 404.
    const foreign = await callApp(app, 'GET', `/cards/${card.id}`, { cookie: b.cookie });
    expect(foreign.status).toBe(404);
  });
});
