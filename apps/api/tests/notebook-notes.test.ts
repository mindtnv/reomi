// «Блокноты 2.0» N1 — notebook notes CRUD (Р1/Р7/Р15). Pure route tests via
// `app.handle` — no AI. We assert:
//   * CRUD cycle (create → list → patch → delete).
//   * caps: NOTE_CONTENT_MAX over → 400 invalid_note.
//   * search (q=) + pinned-first ordering + excerpt field.
//   * messageId validation (Р7): foreign message → 400; a GLOBAL-chat message
//     → 400; a valid notebook message → ok; deleting the conversation SET NULLs
//     message_id and the note survives.
//   * foreign-404 on every route + zero attacker rows.
//   * notebooks.updated_at bumps on POST/PATCH(content)/DELETE (Р15).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { and, count, eq } from 'drizzle-orm';
import {
  conversations,
  db,
  messages,
  notebookNotes,
  notebooks,
} from '@reomi/db';
import { buildApp } from '../src/app.ts';
import { __resetAiClientForTests } from '../src/ai/openai-client.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

interface NoteRow {
  id: string;
  title: string;
  content: string;
  kind: string;
  pinned: boolean;
  messageId: string | null;
  excerpt?: string;
}

async function createNotebook(cookie: string, title = 'NB'): Promise<{ id: string }> {
  const res = await callApp(app, 'POST', '/notebooks', { cookie, body: { title } });
  expect(res.status).toBe(200);
  return res.json<{ id: string }>();
}

/** Insert a conversation (optionally notebook-bound) + one assistant message
 *  directly, returning the message id. */
async function seedMessage(
  userId: string,
  notebookId: string | null,
): Promise<string> {
  const [conv] = await db
    .insert(conversations)
    .values({ userId, notebookId })
    .returning({ id: conversations.id });
  const [msg] = await db
    .insert(messages)
    .values({ conversationId: conv!.id, userId, role: 'assistant', content: 'answer text' })
    .returning({ id: messages.id });
  return msg!.id;
}

describe('notebook notes CRUD', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('create → list → patch → delete', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const nb = await createNotebook(cookie);

    const created = await callApp(app, 'POST', `/notebooks/${nb.id}/notes`, {
      cookie,
      body: { title: 'My note', content: 'Some **markdown** content.' },
    });
    expect(created.status).toBe(200);
    const note = await created.json<NoteRow>();
    expect(note.title).toBe('My note');
    expect(note.kind).toBe('manual');

    const list = await callApp(app, 'GET', `/notebooks/${nb.id}/notes`, { cookie });
    const { items } = await list.json<{ items: NoteRow[] }>();
    expect(items.map((i) => i.id)).toContain(note.id);
    // The list carries both full content AND a light excerpt.
    expect(items[0]!.content).toBe('Some **markdown** content.');
    expect(typeof items[0]!.excerpt).toBe('string');

    const patched = await callApp(app, 'PATCH', `/notebooks/${nb.id}/notes/${note.id}`, {
      cookie,
      body: { title: 'Renamed', pinned: true },
    });
    expect(patched.status).toBe(200);
    const updated = await patched.json<NoteRow>();
    expect(updated.title).toBe('Renamed');
    expect(updated.pinned).toBe(true);

    const del = await callApp(app, 'DELETE', `/notebooks/${nb.id}/notes/${note.id}`, { cookie });
    expect(del.status).toBe(200);
    const after = await callApp(app, 'GET', `/notebooks/${nb.id}/notes`, { cookie });
    expect((await after.json<{ items: NoteRow[] }>()).items).toHaveLength(0);
  });

  test('content over NOTE_CONTENT_MAX → 400 invalid_note', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const nb = await createNotebook(cookie);
    const res = await callApp(app, 'POST', `/notebooks/${nb.id}/notes`, {
      cookie,
      body: { title: 'big', content: 'x'.repeat(16_001) },
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_note');
  });

  test('empty PATCH body → 400 nothing_to_update', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const nb = await createNotebook(cookie);
    const note = await (
      await callApp(app, 'POST', `/notebooks/${nb.id}/notes`, {
        cookie,
        body: { title: 't', content: 'c' },
      })
    ).json<NoteRow>();
    const res = await callApp(app, 'PATCH', `/notebooks/${nb.id}/notes/${note.id}`, {
      cookie,
      body: {},
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('nothing_to_update');
  });

  test('search q= matches title or content; pinned-first ordering', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const nb = await createNotebook(cookie);
    await callApp(app, 'POST', `/notebooks/${nb.id}/notes`, {
      cookie,
      body: { title: 'Mitochondria', content: 'powerhouse of the cell' },
    });
    const second = await (
      await callApp(app, 'POST', `/notebooks/${nb.id}/notes`, {
        cookie,
        body: { title: 'Ribosome', content: 'makes proteins' },
      })
    ).json<NoteRow>();
    // Pin the SECOND (newer) note — it should sort first regardless.
    await callApp(app, 'PATCH', `/notebooks/${nb.id}/notes/${second.id}`, {
      cookie,
      body: { pinned: true },
    });

    const all = await callApp(app, 'GET', `/notebooks/${nb.id}/notes`, { cookie });
    const items = (await all.json<{ items: NoteRow[] }>()).items;
    expect(items[0]!.id).toBe(second.id); // pinned first

    // Search by content term.
    const search = await callApp(app, 'GET', `/notebooks/${nb.id}/notes?q=powerhouse`, { cookie });
    const found = (await search.json<{ items: NoteRow[] }>()).items;
    expect(found).toHaveLength(1);
    expect(found[0]!.title).toBe('Mitochondria');
  });

  test('q= escapes ILIKE wildcards: literal % matches itself; _ is not a wildcard', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const nb = await createNotebook(cookie);
    // One note carries a LITERAL percent sign in its title; two plain ones.
    await callApp(app, 'POST', `/notebooks/${nb.id}/notes`, {
      cookie,
      body: { title: '100% effort', content: 'a' },
    });
    await callApp(app, 'POST', `/notebooks/${nb.id}/notes`, {
      cookie,
      body: { title: 'Alpha', content: 'b' },
    });
    await callApp(app, 'POST', `/notebooks/${nb.id}/notes`, {
      cookie,
      body: { title: 'Beta', content: 'c' },
    });

    // q='%' must match ONLY the note with a literal '%' (not every row).
    const pct = await callApp(
      app,
      'GET',
      `/notebooks/${nb.id}/notes?q=${encodeURIComponent('%')}`,
      { cookie },
    );
    const pctItems = (await pct.json<{ items: NoteRow[] }>()).items;
    expect(pctItems).toHaveLength(1);
    expect(pctItems[0]!.title).toBe('100% effort');

    // q='_' must match NOTHING (no note contains a literal underscore) — it must
    // NOT behave like the single-char ILIKE wildcard and match every row.
    const underscore = await callApp(
      app,
      'GET',
      `/notebooks/${nb.id}/notes?q=${encodeURIComponent('_')}`,
      { cookie },
    );
    const usItems = (await underscore.json<{ items: NoteRow[] }>()).items;
    expect(usItems).toHaveLength(0);
  });

  test('messageId validation (Р7): foreign / global-chat → 400; valid notebook message → ok; delete conv → SET NULL survives', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await createNotebook(cookie);

    // A GLOBAL chat message (notebook_id NULL) is NOT valid for a notebook note.
    const globalMsg = await seedMessage(userId, null);
    const globalRes = await callApp(app, 'POST', `/notebooks/${nb.id}/notes`, {
      cookie,
      body: { title: 'a', content: 'b', kind: 'answer', messageId: globalMsg },
    });
    expect(globalRes.status).toBe(400);
    expect((await globalRes.json<{ error: string }>()).error).toBe('invalid_message');

    // A message of ANOTHER notebook's conversation → 400.
    const otherNb = await createNotebook(cookie, 'Other');
    const otherMsg = await seedMessage(userId, otherNb.id);
    const otherRes = await callApp(app, 'POST', `/notebooks/${nb.id}/notes`, {
      cookie,
      body: { title: 'a', content: 'b', kind: 'answer', messageId: otherMsg },
    });
    expect(otherRes.status).toBe(400);

    // A valid message bound to THIS notebook → ok.
    const [conv] = await db
      .insert(conversations)
      .values({ userId, notebookId: nb.id })
      .returning({ id: conversations.id });
    const [msg] = await db
      .insert(messages)
      .values({ conversationId: conv!.id, userId, role: 'assistant', content: 'grounded answer' })
      .returning({ id: messages.id });
    const okRes = await callApp(app, 'POST', `/notebooks/${nb.id}/notes`, {
      cookie,
      body: {
        title: 'Saved answer',
        content: 'grounded answer [src:abc]',
        kind: 'answer',
        messageId: msg!.id,
        citations: [{ kind: 'source', sourceId: 's', sourceChunkId: 'c' }],
      },
    });
    expect(okRes.status).toBe(200);
    const note = await okRes.json<NoteRow>();
    expect(note.messageId).toBe(msg!.id);
    expect(note.kind).toBe('answer');

    // Delete the conversation (cascades messages) → note.message_id SET NULL,
    // the note still exists.
    await db.delete(conversations).where(eq(conversations.id, conv!.id));
    const [survived] = await db
      .select()
      .from(notebookNotes)
      .where(eq(notebookNotes.id, note.id));
    expect(survived).toBeTruthy();
    expect(survived!.messageId).toBeNull();
    expect(survived!.content).toBe('grounded answer [src:abc]');
  });

  test('foreign-404 on every route + zero attacker rows', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const nbB = await createNotebook(b.cookie);
    const noteB = await (
      await callApp(app, 'POST', `/notebooks/${nbB.id}/notes`, {
        cookie: b.cookie,
        body: { title: 'secret', content: 'secret body' },
      })
    ).json<NoteRow>();

    // A cannot list / create / patch / delete B's notebook notes.
    expect(
      (await callApp(app, 'GET', `/notebooks/${nbB.id}/notes`, { cookie: a.cookie })).status,
    ).toBe(404);
    expect(
      (
        await callApp(app, 'POST', `/notebooks/${nbB.id}/notes`, {
          cookie: a.cookie,
          body: { title: 'x', content: 'y' },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await callApp(app, 'PATCH', `/notebooks/${nbB.id}/notes/${noteB.id}`, {
          cookie: a.cookie,
          body: { title: 'hijack' },
        })
      ).status,
    ).toBe(404);
    expect(
      (await callApp(app, 'DELETE', `/notebooks/${nbB.id}/notes/${noteB.id}`, { cookie: a.cookie }))
        .status,
    ).toBe(404);

    // Attacker created zero rows; B's note is unchanged.
    const total = (await db.select({ n: count() }).from(notebookNotes))[0]!.n;
    expect(total).toBe(1);
    const [stillThere] = await db
      .select()
      .from(notebookNotes)
      .where(eq(notebookNotes.id, noteB.id));
    expect(stillThere!.title).toBe('secret');
  });

  test('notebooks.updated_at bumps on POST / PATCH(content) / DELETE (Р15)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const nb = await createNotebook(cookie);

    const readUpdatedAt = async () =>
      (await db.select({ u: notebooks.updatedAt }).from(notebooks).where(eq(notebooks.id, nb.id)))[0]!
        .u;

    const t0 = await readUpdatedAt();
    await new Promise((r) => setTimeout(r, 10));

    // POST bumps.
    const note = await (
      await callApp(app, 'POST', `/notebooks/${nb.id}/notes`, {
        cookie,
        body: { title: 't', content: 'c' },
      })
    ).json<NoteRow>();
    const tPost = await readUpdatedAt();
    expect(tPost.getTime()).toBeGreaterThan(t0.getTime());

    await new Promise((r) => setTimeout(r, 10));
    // PATCH content bumps.
    await callApp(app, 'PATCH', `/notebooks/${nb.id}/notes/${note.id}`, {
      cookie,
      body: { content: 'changed' },
    });
    const tPatch = await readUpdatedAt();
    expect(tPatch.getTime()).toBeGreaterThan(tPost.getTime());

    await new Promise((r) => setTimeout(r, 10));
    // DELETE bumps.
    await callApp(app, 'DELETE', `/notebooks/${nb.id}/notes/${note.id}`, { cookie });
    const tDelete = await readUpdatedAt();
    expect(tDelete.getTime()).toBeGreaterThan(tPatch.getTime());
  });
});

// A foreign notebook id provided to the note routes must touch zero of the
// attacker's own rows either (the user-scope guard is the FIRST conjunct).
describe('notebook notes — scoping invariant', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('GET /notes on a non-existent notebook → 404', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const res = await callApp(
      app,
      'GET',
      '/notebooks/00000000-0000-0000-0000-0000000000aa/notes',
      { cookie },
    );
    expect(res.status).toBe(404);
  });

  test('a note created in notebook A is invisible from notebook B (same user)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const a = await createNotebook(cookie, 'A');
    const b = await createNotebook(cookie, 'B');
    await callApp(app, 'POST', `/notebooks/${a.id}/notes`, {
      cookie,
      body: { title: 'only-in-A', content: 'x' },
    });
    const fromB = await callApp(app, 'GET', `/notebooks/${b.id}/notes`, { cookie });
    expect((await fromB.json<{ items: NoteRow[] }>()).items).toHaveLength(0);
    // Sanity: A has exactly one, scoped to this user.
    const aCount = (
      await db
        .select({ n: count() })
        .from(notebookNotes)
        .where(and(eq(notebookNotes.userId, userId), eq(notebookNotes.notebookId, a.id)))
    )[0]!.n;
    expect(aCount).toBe(1);
  });
});

test('shared note listing preserves the notebook page limit and legacy excerpt format',async()=>{
  await resetTestDb();
  const {env}=await import('../src/env');const {NOTE_EXCERPT_MAX}=await import('@reomi/shared');
  const {cookie,userId}=await signUpAndCookie(app,uniqueEmail());
  const notebook=await createNotebook(cookie);
  await db.insert(notebookNotes).values(Array.from({length:env.ai.LIBRARY_PAGE+1},(_,index)=>({
    userId,notebookId:notebook.id,title:`Note ${index}`,content:index===0?'x'.repeat(NOTE_EXCERPT_MAX+20):'Short note',pinned:index===0,
  })));
  const response=await callApp(app,'GET',`/notebooks/${notebook.id}/notes`,{cookie});
  expect(response.status).toBe(200);const result=await response.json<{items:NoteRow[];nextOffset?:number}>();
  expect(result.items).toHaveLength(env.ai.LIBRARY_PAGE);expect(result.nextOffset).toBeUndefined();
  expect(result.items[0]!.excerpt).toBe(`${'x'.repeat(NOTE_EXCERPT_MAX)}…`);
});

test('direct note reading requires both the owned notebook and its owned note',async()=>{
  await resetTestDb();
  const a=await signUpAndCookie(app,uniqueEmail()),b=await signUpAndCookie(app,uniqueEmail());
  const notebook=await createNotebook(a.cookie),other=await createNotebook(a.cookie);
  const [note]=await db.insert(notebookNotes).values({userId:a.userId,notebookId:notebook.id,title:'2026-09-21',content:'Exact note content'}).returning();
  const read=await callApp(app,'GET',`/notebooks/${notebook.id}/notes/${note!.id}`,{cookie:a.cookie});
  expect(read.status).toBe(200);expect((await read.json<any>()).content).toBe('Exact note content');
  expect((await callApp(app,'GET',`/notebooks/${other.id}/notes/${note!.id}`,{cookie:a.cookie})).status).toBe(404);
  expect((await callApp(app,'GET',`/notebooks/${notebook.id}/notes/${note!.id}`,{cookie:b.cookie})).status).toBe(404);
});
