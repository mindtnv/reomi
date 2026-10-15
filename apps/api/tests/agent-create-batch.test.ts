// Batch create_card (`cards: [...]`) + live tool_result summaries.
//
// CONTRACT (apps/api/src/ai/tools.ts `createCard` + apps/api/src/modules/ai.ts):
//   * `create_card` accepts EITHER a single `fieldValues` OR a `cards` array
//     (max CREATE_CARD_BATCH_MAX) — the batch pauses for ONE confirmation whose
//     impact carries `willCreateCards` (sum) + per-card `proposedCards`; a
//     single-card call keeps emitting `proposedFields` (back-compat).
//   * Apply executes the WHOLE batch in one transaction (N notes + N cards).
//   * Batch-entry validation errors are indexed ("cards[1]: …") and take the
//     validate-before-pause path: NO await_confirmation, the error returns to
//     the model as a fully-answered tool call and the loop continues.
//   * Successful tool_result SSE frames now carry `summary` (the capped
//     model-facing text) so every step is inspectable live — same content the
//     reload path reads from the persisted role:tool row.
//
// Same in-process / injection harness as agent-confirm.test.ts.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  cards as cardsTable,
  db,
  ensureBuiltins,
  messages as messagesTable,
  notes as notesTable,
} from '@reomi/db';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import {
  __resetAiClientForTests,
  __setAiClientForTests,
  type AgentStreamChunk,
} from '../src/ai/openai-client.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

// ── Scripted agentic fake (one AgentTurn per chatStreamAgentic call) ──────────

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
function toolTurn(calls: ToolCallScript[]): AgentTurn {
  return { toolCalls: calls, finish: 'tool_calls' };
}
function scriptedAgentStream(script: AgentTurn[]) {
  let call = 0;
  return async function* (): AsyncIterable<AgentStreamChunk> {
    const turn = script[call++];
    if (!turn) {
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    for (const c of turn.content ?? []) yield { type: 'content', text: c };
    let index = 0;
    for (const tc of turn.toolCalls ?? []) {
      const argsJson = JSON.stringify(tc.args);
      const mid = Math.floor(argsJson.length / 2);
      yield { type: 'tool_call_delta', index, id: tc.id, name: tc.name };
      yield { type: 'tool_call_delta', index, argsFragment: argsJson.slice(0, mid) };
      yield { type: 'tool_call_delta', index, argsFragment: argsJson.slice(mid) };
      index += 1;
    }
    yield { type: 'finish', reason: turn.finish };
  };
}

// ── SSE reader (mirrors the other chat suites) ────────────────────────────────

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
  return app.handle(
    new Request(`http://localhost/chat/conversations/${convId}/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ content }),
    }),
  );
}
async function resumeReq(
  cookie: string,
  convId: string,
  body: {
    resumeToolCallId: string;
    decision: 'apply' | 'reject';
    cardSelections?: { index: number; include: boolean; fieldValues?: Record<string, string> }[];
    feedback?: string;
  },
): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/chat/conversations/${convId}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    }),
  );
}
async function createConversation(cookie: string): Promise<string> {
  const res = await callApp(app, 'POST', '/chat/conversations', { cookie, body: {} });
  expect(res.status).toBe(200);
  return (await res.json<{ id: string }>()).id;
}
async function freshDeck(cookie: string, name = 'D'): Promise<string> {
  return (
    await (await callApp(app, 'POST', '/decks', { cookie, body: { name } })).json<{ id: string }>()
  ).id;
}

describe('agentic chat — batch create_card (cards: [...])', () => {
  beforeEach(async () => {
    await resetTestDb();
    await ensureBuiltins(db);
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('batch of 3: ONE confirmation with willCreateCards=3 + proposedCards; apply creates all 3 atomically', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);

    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        toolTurn([
          {
            id: 'w_batch',
            name: 'create_card',
            args: {
              deckId,
              cards: [
                { fieldValues: { Front: 'Q1', Back: 'A1' } },
                { fieldValues: { Front: 'Q2', Back: 'A2' }, tags: ['t2'] },
                { fieldValues: { front: 'Q3', back: 'A3' } }, // case-insensitive keys
              ],
            },
          },
        ]),
        answerTurn('Created all three.'),
      ]),
    });

    const convId = await createConversation(cookie);
    const streamFrames = await readSse(await streamReq(cookie, convId, 'make 3 cards'));

    // ONE pause for the whole batch.
    const awaits = streamFrames.filter((f) => f.event === 'await_confirmation');
    expect(awaits.length).toBe(1);
    const impact = (awaits[0]!.data as { impact?: {
      willCreateCards?: number;
      proposedCards?: { fields: { field: string; value: string }[] }[];
      proposedFields?: unknown;
    } }).impact;
    expect(impact?.willCreateCards).toBe(3);
    expect(impact?.proposedCards?.length).toBe(3);
    expect(impact?.proposedCards?.[1]?.fields).toEqual([
      { field: 'Front', value: 'Q2' },
      { field: 'Back', value: 'A2' },
    ]);
    // Batch uses proposedCards, NOT the single-card proposedFields.
    expect(impact?.proposedFields).toBeUndefined();
    expect(streamFrames.some((f) => f.event === 'done')).toBe(false);

    // Nothing created while paused.
    expect((await db.select().from(notesTable).where(eq(notesTable.userId, userId))).length).toBe(0);

    // Apply → all 3 notes + cards exist; the result summary mentions the batch.
    const resumeFrames = await readSse(
      await resumeReq(cookie, convId, { resumeToolCallId: 'w_batch', decision: 'apply' }),
    );
    const result = resumeFrames.find((f) => f.event === 'tool_result');
    expect((result!.data as { ok: boolean }).ok).toBe(true);
    expect((result!.data as { summary?: string }).summary).toContain('3 notes');
    expect(resumeFrames.some((f) => f.event === 'done')).toBe(true);

    const notes = await db.select().from(notesTable).where(eq(notesTable.userId, userId));
    const cards = await db.select().from(cardsTable).where(eq(cardsTable.userId, userId));
    expect(notes.length).toBe(3);
    expect(cards.length).toBe(3);
    const fronts = cards.map((c) => c.renderFrontText).sort();
    expect(fronts).toEqual(['Q1', 'Q2', 'Q3']);
    // Per-entry tags land on their note ("t2" only on the second card's note).
    const tagged = notes.filter((n) => (n.tags ?? []).includes('t2'));
    expect(tagged.length).toBe(1);
  });

  test('batch over the cap (21) does NOT pause — indexed error returns to the model, loop continues', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);

    const tooMany = Array.from({ length: 21 }, (_, i) => ({
      fieldValues: { Front: `Q${i}`, Back: `A${i}` },
    }));
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        toolTurn([{ id: 'w_cap', name: 'create_card', args: { deckId, cards: tooMany } }]),
        answerTurn('That was too many at once.'),
      ]),
    });

    const convId = await createConversation(cookie);
    const frames = await readSse(await streamReq(cookie, convId, 'make 21 cards'));

    // Validate-before-pause: no confirmation, an error tool_result, then done.
    expect(frames.some((f) => f.event === 'await_confirmation')).toBe(false);
    const result = frames.find((f) => f.event === 'tool_result');
    expect((result!.data as { ok: boolean }).ok).toBe(false);
    expect((result!.data as { summary?: string }).summary).toContain('too many cards');
    expect(frames.some((f) => f.event === 'done')).toBe(true);
    expect((await db.select().from(notesTable).where(eq(notesTable.userId, userId))).length).toBe(0);
  });

  test('a bad batch entry is addressed by index (cards[1]) and does not pause', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);

    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        toolTurn([
          {
            id: 'w_bad',
            name: 'create_card',
            args: {
              deckId,
              cards: [
                { fieldValues: { Front: 'ok', Back: 'ok' } },
                { fieldValues: { Bogus: 'no such field' } },
              ],
            },
          },
        ]),
        answerTurn('Fixed in the next attempt.'),
      ]),
    });

    const convId = await createConversation(cookie);
    const frames = await readSse(await streamReq(cookie, convId, 'make 2 cards'));

    expect(frames.some((f) => f.event === 'await_confirmation')).toBe(false);
    const result = frames.find((f) => f.event === 'tool_result');
    expect((result!.data as { ok: boolean }).ok).toBe(false);
    expect((result!.data as { summary?: string }).summary).toContain('cards[1]');
    expect((result!.data as { summary?: string }).summary).toContain('Bogus');
  });

  test('per-card selections: exclude one + edit one → only the chosen cards land, result tells the model', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);

    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        toolTurn([
          {
            id: 'w_sel',
            name: 'create_card',
            args: {
              deckId,
              cards: [
                { fieldValues: { Front: 'Q1', Back: 'A1' } },
                { fieldValues: { Front: 'Q2', Back: 'A2' } },
                { fieldValues: { Front: 'Q3', Back: 'A3' } },
              ],
            },
          },
        ]),
        answerTurn('Done with your picks.'),
      ]),
    });

    const convId = await createConversation(cookie);
    await readSse(await streamReq(cookie, convId, 'make 3 cards'));

    // Apply: card 1 excluded, card 2 edited inline, card 0 as proposed.
    const resumeFrames = await readSse(
      await resumeReq(cookie, convId, {
        resumeToolCallId: 'w_sel',
        decision: 'apply',
        cardSelections: [
          { index: 1, include: false },
          { index: 2, include: true, fieldValues: { Front: 'Q3 edited', Back: 'A3 edited' } },
        ],
        feedback: 'card 2 was a duplicate',
      }),
    );

    const result = resumeFrames.find((f) => f.event === 'tool_result');
    expect((result!.data as { ok: boolean }).ok).toBe(true);
    const summary = (result!.data as { summary?: string }).summary ?? '';
    // The model learns what the user changed — count, edits, and the note.
    expect(summary).toContain('2 notes');
    expect(summary).toContain('excluded 1');
    expect(summary).toContain('edited 1');
    expect(summary).toContain('card 2 was a duplicate');
    expect(resumeFrames.some((f) => f.event === 'done')).toBe(true);

    const cards = await db.select().from(cardsTable).where(eq(cardsTable.userId, userId));
    const fronts = cards.map((c) => c.renderFrontText).sort();
    expect(fronts).toEqual(['Q1', 'Q3 edited']);

    // The persisted role:tool row carries the same augmented text (the replayed
    // history keeps the model informed across turns).
    const toolRow = (
      await db.select().from(messagesTable).where(eq(messagesTable.conversationId, convId))
    ).find((r) => r.role === 'tool');
    expect(toolRow!.content).toContain('excluded 1');
  });

  test('ALL cards excluded → the apply degrades to a reject (nothing created, feedback rides along)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);

    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        toolTurn([
          {
            id: 'w_none',
            name: 'create_card',
            args: {
              deckId,
              cards: [
                { fieldValues: { Front: 'Q1', Back: 'A1' } },
                { fieldValues: { Front: 'Q2', Back: 'A2' } },
              ],
            },
          },
        ]),
        answerTurn('Understood, nothing created.'),
      ]),
    });

    const convId = await createConversation(cookie);
    await readSse(await streamReq(cookie, convId, 'make 2 cards'));

    const resumeFrames = await readSse(
      await resumeReq(cookie, convId, {
        resumeToolCallId: 'w_none',
        decision: 'apply',
        cardSelections: [
          { index: 0, include: false },
          { index: 1, include: false },
        ],
        feedback: 'rephrase both as cloze',
      }),
    );

    const result = resumeFrames.find((f) => f.event === 'tool_result');
    expect((result!.data as { ok: boolean }).ok).toBe(false);
    expect((result!.data as { summary?: string }).summary).toContain('user_rejected');
    expect((result!.data as { summary?: string }).summary).toContain('rephrase both as cloze');
    expect(resumeFrames.some((f) => f.event === 'done')).toBe(true);

    expect((await db.select().from(notesTable).where(eq(notesTable.userId, userId))).length).toBe(0);
    // The persisted rejection carries the feedback for the model's next step.
    const toolRow = (
      await db.select().from(messagesTable).where(eq(messagesTable.conversationId, convId))
    ).find((r) => r.role === 'tool');
    expect(toolRow!.content).toContain('rephrase both as cloze');
  });

  test('single-card proposal: inline edit via cardSelections index 0', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);

    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        toolTurn([
          {
            id: 'w_edit1',
            name: 'create_card',
            args: { deckId, fieldValues: { Front: 'Original', Back: 'B' } },
          },
        ]),
        answerTurn('done'),
      ]),
    });

    const convId = await createConversation(cookie);
    await readSse(await streamReq(cookie, convId, 'one card'));
    await readSse(
      await resumeReq(cookie, convId, {
        resumeToolCallId: 'w_edit1',
        decision: 'apply',
        cardSelections: [{ index: 0, include: true, fieldValues: { Front: 'Edited', Back: 'B' } }],
      }),
    );

    const cards = await db.select().from(cardsTable).where(eq(cardsTable.userId, userId));
    expect(cards.length).toBe(1);
    expect(cards[0]!.renderFrontText).toBe('Edited');
  });

  test('single fieldValues call is unchanged: proposedFields (not proposedCards) in the impact', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);

    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        toolTurn([
          {
            id: 'w_one',
            name: 'create_card',
            args: { deckId, fieldValues: { Front: 'Solo', Back: 'Card' } },
          },
        ]),
        answerTurn('done'),
      ]),
    });

    const convId = await createConversation(cookie);
    const frames = await readSse(await streamReq(cookie, convId, 'one card'));

    const await_ = frames.find((f) => f.event === 'await_confirmation');
    const impact = (await_!.data as { impact?: {
      willCreateCards?: number;
      proposedFields?: { field: string; value: string }[];
      proposedCards?: unknown;
    } }).impact;
    expect(impact?.willCreateCards).toBe(1);
    expect(impact?.proposedFields).toEqual([
      { field: 'Front', value: 'Solo' },
      { field: 'Back', value: 'Card' },
    ]);
    expect(impact?.proposedCards).toBeUndefined();
  });
});

describe('agentic chat — successful tool_result frames carry a summary', () => {
  beforeEach(async () => {
    await resetTestDb();
    await ensureBuiltins(db);
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('a successful read tool (list_decks) streams its result text in the frame', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    await freshDeck(cookie, 'Espresso');

    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        toolTurn([{ id: 'r_decks', name: 'list_decks', args: {} }]),
        answerTurn('You have one deck.'),
      ]),
    });

    const convId = await createConversation(cookie);
    const frames = await readSse(await streamReq(cookie, convId, 'what decks do I have?'));

    const result = frames.find((f) => f.event === 'tool_result');
    expect(result).toBeTruthy();
    const data = result!.data as { ok: boolean; summary?: string };
    expect(data.ok).toBe(true);
    // The live frame carries the model-facing text — the step is inspectable
    // without a reload.
    expect(data.summary ?? '').toContain('Espresso');
    expect(frames.some((f) => f.event === 'done')).toBe(true);
  });
});
