// Agentic-loop robustness — regression tests for the in-the-wild incident chain
// (2026-06: refresh mid-stream → zombie turn → concurrent regenerate → corrupted
// replay → gateway 400 "No tool output found" → generic client error):
//
//   1. create_card resolves its note type LIVE (legacy databases keep builtin
//      rows under NON-stable UUIDs — `ON CONFLICT DO NOTHING` preserved them, so
//      the shared BASIC_NOTE_TYPE.id literal cannot be trusted), accepts a
//      note-type NAME, and maps field keys case-insensitively.
//   2. Validate-before-pause: an invalid write proposal NEVER pauses for a
//      doomed confirmation — the error returns to the model as a normal tool
//      result and the loop continues (self-correction), with the exchange
//      persisted as a fully-answered tool_calls row.
//   3. Per-conversation turn lock: a second /stream (or /regenerate) while a
//      turn is live → 409 turn_in_progress; the lock releases at turn end.
//   4. Replay sanitizer: corrupted histories (unanswered tool_calls mid-history,
//      orphan role:tool rows) replay to the gateway SELF-CONSISTENT — no
//      unanswered call, no orphan output.
//   5. persistTranscript stamps strictly-increasing createdAt (Postgres `now()`
//      is transaction-fixed, so DEFAULT timestamps of one turn all tie).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  db,
  ensureBuiltins,
  messages as messagesTable,
  noteTypes as noteTypesTable,
  notes as notesTable,
} from '@reomi/db';
import { BUILTIN_NOTE_TYPES } from '@reomi/shared';
import { asc, eq } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import {
  __resetAiClientForTests,
  __setAiClientForTests,
  type AgentChatMessage,
  type AgentStreamChunk,
} from '../src/ai/openai-client.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

// ── Scripted fake (same shape as agent-confirm.test.ts) ───────────────────────

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
function writeTurn(call: ToolCallScript): AgentTurn {
  return { toolCalls: [call], finish: 'tool_calls' };
}

let capturedAgentMessages: AgentChatMessage[][] = [];

function scriptedAgentStream(script: AgentTurn[]) {
  let call = 0;
  return async function* (messages: AgentChatMessage[]): AsyncIterable<AgentStreamChunk> {
    capturedAgentMessages.push(messages);
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
  body: { resumeToolCallId: string; decision: 'apply' | 'reject' },
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
  return (await res.json<{ id: string }>()).id;
}
async function freshDeck(cookie: string, name = 'D'): Promise<string> {
  return (
    await (await callApp(app, 'POST', '/decks', { cookie, body: { name } })).json<{ id: string }>()
  ).id;
}
async function transcriptRows(convId: string) {
  return db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.conversationId, convId))
    .orderBy(asc(messagesTable.createdAt), asc(messagesTable.id));
}

describe('agentic loop — robustness regressions', () => {
  beforeEach(async () => {
    await resetTestDb();
    capturedAgentMessages = [];
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  // ── 1. Legacy-UUID builtins (THE production note_type_not_found bug) ────────
  test('create_card resolves Basic LIVE — works when builtins carry legacy (non-stable) ids', async () => {
    // Seed the builtins under RANDOM ids — exactly what a database from before
    // the stable-UUID era looks like (the user's dev DB).
    for (const def of BUILTIN_NOTE_TYPES) {
      await db.insert(noteTypesTable).values({
        // No explicit id → PostgreSQL uuidv7() default — NOT the shared literal.
        userId: null,
        name: def.name,
        fields: def.fields,
        templates: def.templates,
        styling: def.styling,
        kind: def.kind,
        isBuiltin: true,
      });
    }

    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const convId = await createConversation(cookie);
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        writeTurn({
          id: 'w1',
          name: 'create_card',
          args: { deckId, fieldValues: { Front: 'Q', Back: 'A' } },
        }),
        answerTurn('created'),
      ]),
    });

    // The proposal VALIDATES (live Basic resolution) → pauses for confirmation.
    const frames = await readSse(await streamReq(cookie, convId, 'make a card'));
    expect(frames.some((f) => f.event === 'await_confirmation')).toBe(true);

    // Apply succeeds — the note really lands despite the legacy builtin ids.
    const resumeFrames = await readSse(
      await resumeReq(cookie, convId, { resumeToolCallId: 'w1', decision: 'apply' }),
    );
    const result = resumeFrames.find((f) => f.event === 'tool_result');
    expect((result!.data as { ok: boolean }).ok).toBe(true);
    const noteRows = await db.select().from(notesTable);
    expect(noteRows.length).toBe(1);
  });

  test('create_card accepts a note-type NAME and case-insensitive field keys', async () => {
    await ensureBuiltins(db);
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const convId = await createConversation(cookie);
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        writeTurn({
          id: 'w1',
          name: 'create_card',
          // Name instead of UUID + lowercase field keys — both must normalize.
          args: { deckId, noteTypeId: 'basic', fieldValues: { front: 'Q', back: 'A' } },
        }),
        answerTurn('created'),
      ]),
    });

    const frames = await readSse(await streamReq(cookie, convId, 'make a card'));
    expect(frames.some((f) => f.event === 'await_confirmation')).toBe(true);
    await readSse(await resumeReq(cookie, convId, { resumeToolCallId: 'w1', decision: 'apply' }));

    const noteRows = await db.select().from(notesTable);
    expect(noteRows.length).toBe(1);
    // Keys normalized onto the REAL field names.
    expect(noteRows[0]!.fieldValues).toEqual({ Front: 'Q', Back: 'A' });
  });

  // ── 2. Validate-before-pause ─────────────────────────────────────────────────
  test('invalid write (foreign deck) does NOT pause — error returns to the model, loop continues', async () => {
    await ensureBuiltins(db);
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    const foreignDeck = '11111111-2222-3333-4444-555555555555';
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        writeTurn({
          id: 'w1',
          name: 'create_card',
          args: { deckId: foreignDeck, fieldValues: { Front: 'Q', Back: 'A' } },
        }),
        answerTurn('sorry, that deck does not exist'),
      ]),
    });

    const frames = await readSse(await streamReq(cookie, convId, 'make a card'));
    // No confirmation pause; the turn runs to done in ONE request.
    expect(frames.some((f) => f.event === 'await_confirmation')).toBe(false);
    expect(frames.some((f) => f.event === 'done')).toBe(true);
    const result = frames.find((f) => f.event === 'tool_result');
    expect((result!.data as { ok: boolean }).ok).toBe(false);

    // The model's SECOND step saw the error as a role:tool message.
    const second = capturedAgentMessages[1]!;
    const toolMsg = second.find((m) => m.role === 'tool');
    expect(toolMsg!.content).toContain('list_decks');

    // Persisted: the failed exchange is a fully-answered tool_calls row pair.
    const rows = await transcriptRows(convId);
    const toolRow = rows.find((r) => r.role === 'tool');
    expect(toolRow!.toolCallId).toBe('w1');
    expect(rows[rows.length - 1]!.content).toContain('sorry');
  });

  // ── 3. Per-conversation turn lock ────────────────────────────────────────────
  test('concurrent /stream and /regenerate on one conversation → 409 turn_in_progress', async () => {
    await ensureBuiltins(db);
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    __setAiClientForTests({
      chatStreamAgentic: async function* (): AsyncIterable<AgentStreamChunk> {
        await gate; // hold the turn live until the test releases it
        yield { type: 'content', text: 'done' };
        yield { type: 'finish', reason: 'stop' };
      },
    });

    const first = await streamReq(cookie, convId, 'first');
    expect(first.status).toBe(200);

    // A second turn while the first is live → 409, and NO second user row.
    const second = await streamReq(cookie, convId, 'second');
    expect(second.status).toBe(409);
    expect((await second.json() as { error: string }).error).toBe('turn_in_progress');

    const regen = await app.handle(
      new Request(`http://localhost/chat/conversations/${convId}/regenerate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({}),
      }),
    );
    expect(regen.status).toBe(409);

    const midRows = await transcriptRows(convId);
    expect(midRows.filter((r) => r.role === 'user').length).toBe(1);

    // Release the gate → the first turn finishes → the lock frees.
    release();
    const frames = await readSse(first);
    expect(frames.some((f) => f.event === 'done')).toBe(true);

    __setAiClientForTests({ chatStreamAgentic: scriptedAgentStream([answerTurn('again')]) });
    const third = await streamReq(cookie, convId, 'third');
    expect(third.status).toBe(200);
    await readSse(third);
  });

  // ── 4. Replay sanitizer ──────────────────────────────────────────────────────
  test('corrupted history (unanswered mid-history call + orphan tool row) replays self-consistent', async () => {
    await ensureBuiltins(db);
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);

    // Hand-craft the corruption the concurrent-turns incident produced:
    //   user → assistant tool_calls (NEVER answered) → orphan role:tool row
    //   (no call anywhere names it) → assistant text.
    const base = Date.now() - 60_000;
    const stamp = (i: number) => new Date(base + i * 10);
    await db.insert(messagesTable).values([
      {
        conversationId: convId,
        userId,
        role: 'user',
        content: 'earlier question',
        createdAt: stamp(0),
      },
      {
        conversationId: convId,
        userId,
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'lost-call', name: 'list_decks', arguments: '{}' }],
        createdAt: stamp(1),
      },
      {
        conversationId: convId,
        userId,
        role: 'tool',
        content: 'orphaned result',
        toolCallId: 'orphan-result',
        createdAt: stamp(2),
      },
      {
        conversationId: convId,
        userId,
        role: 'assistant',
        content: 'earlier answer',
        createdAt: stamp(3),
      },
    ]);

    __setAiClientForTests({ chatStreamAgentic: scriptedAgentStream([answerTurn('ok')]) });
    const frames = await readSse(await streamReq(cookie, convId, 'next question'));
    // The gateway never saw the hole: the turn completed (no error frame).
    expect(frames.some((f) => f.event === 'done')).toBe(true);

    const history = capturedAgentMessages[0]!;
    // No assistant message still carrying the unanswered call…
    const danglingCall = history.some(
      (m) => m.role === 'assistant' && m.tool_calls?.some((tc) => tc.id === 'lost-call'),
    );
    expect(danglingCall).toBe(false);
    // …and no orphan tool output either.
    const orphanTool = history.some((m) => m.role === 'tool' && m.tool_call_id === 'orphan-result');
    expect(orphanTool).toBe(false);
    // The surviving prose history is intact.
    expect(history.some((m) => m.role === 'assistant' && m.content === 'earlier answer')).toBe(true);
  });

  // ── 5. Strictly-increasing persisted timestamps ──────────────────────────────
  test('a multi-row turn persists strictly-increasing createdAt (stable reload order)', async () => {
    await ensureBuiltins(db);
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const convId = await createConversation(cookie);
    __setAiClientForTests({
      chatStreamAgentic: scriptedAgentStream([
        { toolCalls: [{ id: 't1', name: 'list_decks', args: {} }], finish: 'tool_calls' },
        answerTurn('answer'),
      ]),
    });
    await readSse(await streamReq(cookie, convId, 'list my decks'));

    const rows = await transcriptRows(convId);
    expect(rows.length).toBeGreaterThanOrEqual(4); // user + tool_calls + tool + text
    const times = rows.map((r) => r.createdAt.getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i]!).toBeGreaterThan(times[i - 1]!);
    }
  });
});
