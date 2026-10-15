// «Блокноты 2.0» N3 (Р14) — the notebook NOTE tools: list_notes / read_note
// (read) + save_note (write, confirm-pause).
//
// CONTRACT (read from apps/api/src/ai/tools.ts + the /resume apply path, NOT
// invented):
//   * Registry shape: in NOTEBOOK mode list_notes/read_note/save_note ARE
//     offered; GLOBAL mode requires an explicit owned notebookId.
//   * list_notes returns pinned-first notes (id/title/kind/excerpt). read_note
//     returns one note's full markdown; a foreign/missing noteId is a
//     self-correcting error (ok:false, loop continues). Note content does NOT
//     ground (no [src:] citations).
//   * save_note PAUSES for confirmation: the await_confirmation impact carries
//     proposedNote {title, contentExcerpt}. Resume APPLY creates a kind='manual'
//     note (bumps notebooks.updated_at) and writes ZERO card_sources rows (the
//     create_card-specific provenance branches gate on pending.name). Resume
//     REJECT creates no note.
//   * validate-before-pause: content over the cap goes back to the model as a
//     tool error WITHOUT pausing (no await_confirmation).
//
// Harness mirrors card-provenance.test.ts (scripted fake whose call counter
// persists across /stream + /resume).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  cardSources as cardSourcesTable,
  db,
  ensureBuiltins,
  notebookNotes as notebookNotesTable,
  notebooks as notebooksTable,
  notebookSources as notebookSourcesTable,
  sourceChunks as sourceChunksTable,
  sources as sourcesTable,
} from '@reomi/db';
import { and, eq } from 'drizzle-orm';
import { NOTE_CONTENT_MAX } from '@reomi/shared';
import { buildApp } from '../src/app.ts';
import {
  __resetAiClientForTests,
  __setAiClientForTests,
  type AgentChatMessage,
  type AgentStreamChunk,
} from '../src/ai/openai-client.ts';
import { buildToolRegistry } from '../src/ai/tools.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();
const EMBED_DIM = 1536;

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
  return async function* (_messages: AgentChatMessage[]): AsyncIterable<AgentStreamChunk> {
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

function streamReq(cookie: string, convId: string, content: string, extra: Record<string, unknown> = {}): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/chat/conversations/${convId}/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ content, ...extra }),
    }),
  );
}
function resumeReq(cookie: string, convId: string, body: Record<string, unknown>): Promise<Response> {
  return app.handle(
    new Request(`http://localhost/chat/conversations/${convId}/resume`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    }),
  );
}

async function freshNotebook(userId: string, title = 'NB'): Promise<string> {
  const [nb] = await db.insert(notebooksTable).values({ userId, title }).returning({ id: notebooksTable.id });
  return nb!.id;
}

/** A ready source so the notebook has scope (note tools don't need it, but the
 *  prompt path is identical to a real notebook). */
async function seedSource(userId: string, notebookId: string): Promise<void> {
  const [src] = await db
    .insert(sourcesTable)
    .values({ userId, kind: 'text', title: 'Src', status: 'ready', verified: true, chunkCount: 1 })
    .returning({ id: sourcesTable.id });
  await db.insert(notebookSourcesTable).values({ userId, notebookId, sourceId: src!.id });
  await db.insert(sourceChunksTable).values({ userId, sourceId: src!.id, position: 0, text: 'x', embedded: true });
}

async function insertNote(
  userId: string,
  notebookId: string,
  opts: { title: string; content: string; pinned?: boolean; kind?: string },
): Promise<string> {
  const [row] = await db
    .insert(notebookNotesTable)
    .values({
      userId,
      notebookId,
      title: opts.title,
      content: opts.content,
      pinned: opts.pinned ?? false,
      kind: opts.kind ?? 'manual',
    })
    .returning({ id: notebookNotesTable.id });
  return row!.id;
}

async function createConversation(cookie: string, body: Record<string, unknown> = {}): Promise<string> {
  const res = await callApp(app, 'POST', '/chat/conversations', { cookie, body });
  expect(res.status).toBe(200);
  return (await res.json<{ id: string }>()).id;
}

function executedTools(frames: SseFrame[]): string[] {
  return frames.filter((f) => f.event === 'tool_call').map((f) => (f.data as { name: string }).name);
}

// ── registry shape ──────────────────────────────────────────────────────────────

describe('note tools — registry shape', () => {
  test('notebook mode offers scoped note tools; global mode requires explicit notebookId', () => {
    const notebookNames = buildToolRegistry({ notebook: true }).map((t) => t.name);
    expect(notebookNames).toContain('list_notes');
    expect(notebookNames).toContain('read_note');
    expect(notebookNames).toContain('save_note');

    const globalNames = buildToolRegistry({}).map((t) => t.name);
    expect(globalNames).toContain('list_notes');
    expect(globalNames).toContain('read_note');
    expect(globalNames).toContain('save_note');
  });

  test('save_note is a write tool with validate + dryRun', () => {
    const saveNote = buildToolRegistry({ notebook: true }).find((t) => t.name === 'save_note')!;
    expect(saveNote.kind).toBe('write');
    expect(typeof saveNote.validate).toBe('function');
    expect(typeof saveNote.dryRun).toBe('function');
  });
});

// ── read tools through the agentic loop ──────────────────────────────────────────

describe('note tools — list_notes / read_note', () => {
  beforeEach(async () => {
    await resetTestDb();
    await ensureBuiltins(db);
  });
  afterEach(() => __resetAiClientForTests());

  test('list_notes returns the notebook notes (pinned-first)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId);
    await seedSource(userId, notebookId);
    await insertNote(userId, notebookId, { title: 'Plain', content: 'plain body' });
    await insertNote(userId, notebookId, { title: 'Pinned One', content: 'pinned body', pinned: true });

    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        toolTurn([{ id: 'l1', name: 'list_notes', args: {} }]),
        answerTurn('Here are your notes.'),
      ]),
    });

    const convId = await createConversation(cookie, { notebookId });
    const frames = await readSse(await streamReq(cookie, convId, 'what notes do I have?'));

    expect(executedTools(frames)).toContain('list_notes');
    const result = frames.find((f) => f.event === 'tool_result')!;
    expect((result.data as { ok: boolean }).ok).toBe(true);
    const summary = (result.data as { summary: string }).summary;
    expect(summary).toContain('Pinned One');
    expect(summary).toContain('Plain');
    // Pinned note comes first (📌 marker on the first listed note).
    expect(summary.indexOf('Pinned One')).toBeLessThan(summary.indexOf('Plain'));
  });

  test('read_note returns one note in full', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId);
    await seedSource(userId, notebookId);
    const noteId = await insertNote(userId, notebookId, {
      title: 'Deep Note',
      content: 'the full markdown body here',
    });

    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        toolTurn([{ id: 'r1', name: 'read_note', args: { noteId } }]),
        answerTurn('Read it.'),
      ]),
    });

    const convId = await createConversation(cookie, { notebookId });
    const frames = await readSse(await streamReq(cookie, convId, 'read my note'));

    const result = frames.find((f) => f.event === 'tool_result')!;
    expect((result.data as { ok: boolean }).ok).toBe(true);
    const summary = (result.data as { summary: string }).summary;
    expect(summary).toContain('Deep Note');
    expect(summary).toContain('the full markdown body here');
    // Note content does NOT produce source citations.
    expect((result.data as { citations?: unknown[] }).citations ?? []).toEqual([]);
  });

  test('read_note with a foreign noteId is a self-correcting error (loop continues)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId);
    await seedSource(userId, notebookId);
    // A note owned by ANOTHER user (and another notebook) — must not be readable.
    const other = await signUpAndCookie(app, uniqueEmail('b'));
    const otherNb = await freshNotebook(other.userId);
    const foreignNoteId = await insertNote(other.userId, otherNb, { title: 'Secret', content: 'secret body' });

    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        toolTurn([{ id: 'r1', name: 'read_note', args: { noteId: foreignNoteId } }]),
        answerTurn('I could not find that note.'),
      ]),
    });

    const convId = await createConversation(cookie, { notebookId });
    const frames = await readSse(await streamReq(cookie, convId, 'read note X'));

    const result = frames.find((f) => f.event === 'tool_result')!;
    expect((result.data as { ok: boolean }).ok).toBe(false);
    expect((result.data as { summary: string }).summary).toContain('not found');
    // Foreign note content never leaked into the result.
    expect((result.data as { summary: string }).summary).not.toContain('secret body');
    expect(frames.some((f) => f.event === 'done')).toBe(true);
  });

  test('global list_notes rejects missing notebookId without reading notes', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());

    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        toolTurn([{ id: 'l1', name: 'list_notes', args: {} }]),
        answerTurn('Recovered.'),
      ]),
    });

    const convId = await createConversation(cookie, {}); // global
    const frames = await readSse(await streamReq(cookie, convId, 'list my notes'));

    const result = frames.find((f) => f.event === 'tool_result')!;
    expect((result.data as { ok: boolean }).ok).toBe(false);
    expect((result.data as { summary: string }).summary).toContain('invalid_arguments');
  });
});

// ── save_note (write, confirm-pause) ─────────────────────────────────────────────

async function notesFor(userId: string, notebookId: string) {
  return db
    .select()
    .from(notebookNotesTable)
    .where(and(eq(notebookNotesTable.userId, userId), eq(notebookNotesTable.notebookId, notebookId)));
}
async function edgesFor(userId: string) {
  return db.select().from(cardSourcesTable).where(eq(cardSourcesTable.userId, userId));
}

describe('note tools — save_note confirm flow', () => {
  beforeEach(async () => {
    await resetTestDb();
    await ensureBuiltins(db);
  });
  afterEach(() => __resetAiClientForTests());

  test('pauses with proposedNote impact → resume apply creates a kind=manual note, zero card_sources', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId);
    await seedSource(userId, notebookId);

    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        toolTurn([
          { id: 'w1', name: 'save_note', args: { title: 'Summary', content: 'A saved markdown note.' } },
        ]),
        answerTurn('Saved.'),
      ]),
    });

    const convId = await createConversation(cookie, { notebookId });
    const frames = await readSse(await streamReq(cookie, convId, 'save this to my notes'));

    // It paused for confirmation with the proposedNote preview.
    const await_ = frames.find((f) => f.event === 'await_confirmation')!;
    expect(await_).toBeTruthy();
    const impact = (await_.data as { impact?: { proposedNote?: { title: string; contentExcerpt: string } } }).impact;
    expect(impact?.proposedNote).toBeTruthy();
    expect(impact!.proposedNote!.title).toBe('Summary');
    expect(impact!.proposedNote!.contentExcerpt).toContain('A saved markdown note.');

    // Nothing created yet.
    expect((await notesFor(userId, notebookId)).length).toBe(0);

    // Apply.
    const resumeFrames = await readSse(await resumeReq(cookie, convId, { resumeToolCallId: 'w1', decision: 'apply' }));
    expect(resumeFrames.some((f) => f.event === 'done')).toBe(true);

    const notes = await notesFor(userId, notebookId);
    expect(notes.length).toBe(1);
    expect(notes[0]!.title).toBe('Summary');
    expect(notes[0]!.content).toBe('A saved markdown note.');
    expect(notes[0]!.kind).toBe('manual');
    // save_note writes NO provenance edges (create_card-only branch never fires).
    expect((await edgesFor(userId)).length).toBe(0);
  });

  test('reject → no note created', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId);
    await seedSource(userId, notebookId);

    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        toolTurn([{ id: 'w1', name: 'save_note', args: { title: 'Nope', content: 'do not save me' } }]),
        answerTurn('Okay, not saving.'),
      ]),
    });

    const convId = await createConversation(cookie, { notebookId });
    await readSse(await streamReq(cookie, convId, 'save this'));
    const resumeFrames = await readSse(await resumeReq(cookie, convId, { resumeToolCallId: 'w1', decision: 'reject' }));
    expect(resumeFrames.some((f) => f.event === 'done')).toBe(true);

    expect((await notesFor(userId, notebookId)).length).toBe(0);
  });

  test('validate-before-pause: content over the cap → tool error, NO pause', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId);
    await seedSource(userId, notebookId);

    const tooBig = 'x'.repeat(NOTE_CONTENT_MAX + 100);
    __setAiClientForTests({
      embed: fakeEmbed,
      chatStreamAgentic: scriptedAgentStream([
        toolTurn([{ id: 'w1', name: 'save_note', args: { title: 'Big', content: tooBig } }]),
        // The loop continues (the error came back as a tool result), model answers.
        answerTurn('That note was too long.'),
      ]),
    });

    const convId = await createConversation(cookie, { notebookId });
    const frames = await readSse(await streamReq(cookie, convId, 'save a huge note'));

    // No confirmation pause — the validate rejected it BEFORE the pause.
    expect(frames.some((f) => f.event === 'await_confirmation')).toBe(false);
    const result = frames.find((f) => f.event === 'tool_result')!;
    expect((result.data as { ok: boolean }).ok).toBe(false);
    expect((result.data as { summary: string }).summary).toContain('exceeds');
    // And nothing was saved.
    expect((await notesFor(userId, notebookId)).length).toBe(0);
    expect(frames.some((f) => f.event === 'done')).toBe(true);
  });
});
