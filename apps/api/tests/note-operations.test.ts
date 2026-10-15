import { beforeEach, expect, test } from 'bun:test';
import { count, eq, sql } from 'drizzle-orm';
import { db, notes } from '@reomi/db';
import { newUuidV7 } from '@reomi/shared';
import { buildApp } from '../src/app';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers';

const app = buildApp();
beforeEach(resetTestDb);

async function fixture() {
  const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
  const deckId = (await (await callApp(app, 'POST', '/decks', { cookie, body: { name: 'D' } })).json<{ id: string }>()).id;
  const noteTypeId = (await (await callApp(app, 'POST', '/note-types', {
    cookie,
    body: {
      name: 'Basic',
      kind: 'basic',
      fields: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }],
      templates: [{ name: 'Card 1', ord: 0, frontTemplate: '{{Front}}', backTemplate: '{{Front}}<hr>{{Back}}' }],
    },
  })).json<{ id: string }>()).id;
  const body = {
    noteTypeId,
    deckId,
    fieldValues: { Front: 'Private question', Back: 'Answer' },
    tags: ['kept'],
    acceptedAnswers: ['answer'],
  };
  return { cookie, userId, body };
}

async function noteCount(userId: string) {
  const [row] = await db.select({ n: count() }).from(notes).where(eq(notes.userId, userId));
  return Number(row?.n ?? 0);
}

test('one operation id returns one note after a lost create response', async () => {
  const { cookie, userId, body } = await fixture();
  const operationId = newUuidV7();
  const first = await callApp(app, 'POST', `/notes/operations/${operationId}`, { cookie, body });
  expect(first.status).toBe(200);
  const saved = await first.json<{ note: { id: string }; cards: Array<{ id: string }>; replayed: boolean }>();
  expect(saved.replayed).toBe(false);
  const retry = await callApp(app, 'POST', `/notes/operations/${operationId}`, { cookie, body });
  expect(retry.status).toBe(200);
  const replay = await retry.json<{ note: { id: string }; cards: Array<{ id: string }>; replayed: boolean }>();
  expect(replay.note.id).toBe(saved.note.id);
  expect(replay.cards.map((card) => card.id)).toEqual(saved.cards.map((card) => card.id));
  expect(replay.replayed).toBe(true);
  expect(await noteCount(userId)).toBe(1);
  const receipt = await callApp(app, 'GET', `/notes/operations/${operationId}`, { cookie });
  expect(receipt.status).toBe(200);
  const lookedUp = await receipt.json<{ status: string; result: { note: { id: string } } }>();
  expect(lookedUp.status).toBe('committed');
  expect(lookedUp.result.note.id).toBe(saved.note.id);
  const stored = JSON.stringify(await db.execute(sql`SELECT row_to_json(note_operations) AS row FROM note_operations`));
  expect(stored).not.toContain('Private question');
});

test('concurrent retries create once and a changed body conflicts', async () => {
  const { cookie, userId, body } = await fixture();
  const operationId = newUuidV7();
  const responses = await Promise.all([0, 1, 2].map(() => callApp(app, 'POST', `/notes/operations/${operationId}`, { cookie, body })));
  expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
  const ids = await Promise.all(responses.map(async (response) => (await response.json<{ note: { id: string } }>()).note.id));
  expect(new Set(ids).size).toBe(1);
  expect(await noteCount(userId)).toBe(1);
  const conflict = await callApp(app, 'POST', `/notes/operations/${operationId}`, {
    cookie,
    body: { ...body, fieldValues: { Front: 'Other question', Back: 'Answer' } },
  });
  expect(conflict.status).toBe(409);
  expect((await conflict.json<{ error: string }>()).error).toBe('operation_conflict');
  expect(await noteCount(userId)).toBe(1);
});

test('a new operation id is an intentional copy and legacy POST /notes still inserts', async () => {
  const { cookie, userId, body } = await fixture();
  const first = await callApp(app, 'POST', `/notes/operations/${newUuidV7()}`, { cookie, body });
  const second = await callApp(app, 'POST', `/notes/operations/${newUuidV7()}`, { cookie, body });
  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  const a = await first.json<{ note: { id: string } }>();
  const b = await second.json<{ note: { id: string } }>();
  expect(a.note.id).not.toBe(b.note.id);
  const legacyA = await callApp(app, 'POST', '/notes', { cookie, body });
  const legacyB = await callApp(app, 'POST', '/notes', { cookie, body });
  expect(legacyA.status).toBe(200);
  expect(legacyB.status).toBe(200);
  expect((await legacyA.json<{ note: { id: string } }>()).note.id).not.toBe((await legacyB.json<{ note: { id: string } }>()).note.id);
  expect(await noteCount(userId)).toBe(4);
});

test('deleting the note leaves a tombstone and a rejected create does not consume the id', async () => {
  const { cookie, userId, body } = await fixture();
  const operationId = newUuidV7();
  const missingDeck = await callApp(app, 'POST', `/notes/operations/${operationId}`, {
    cookie,
    body: { ...body, deckId: newUuidV7() },
  });
  expect(missingDeck.status).toBe(400);
  const created = await callApp(app, 'POST', `/notes/operations/${operationId}`, { cookie, body });
  expect(created.status).toBe(200);
  const { note } = await created.json<{ note: { id: string } }>();
  expect((await callApp(app, 'DELETE', `/notes/${note.id}`, { cookie })).status).toBe(200);
  const retry = await callApp(app, 'POST', `/notes/operations/${operationId}`, { cookie, body });
  expect(retry.status).toBe(409);
  expect((await retry.json<{ error: string }>()).error).toBe('operation_reverted');
  const receipt = await (await callApp(app, 'GET', `/notes/operations/${operationId}`, { cookie })).json<{ status: string }>();
  expect(receipt.status).toBe('reverted');
  expect(await noteCount(userId)).toBe(0);
});

test('another owner cannot read a note operation and keeps an independent receipt', async () => {
  const a = await fixture();
  const b = await fixture();
  const operationId = newUuidV7();
  expect((await callApp(app, 'POST', `/notes/operations/${operationId}`, { cookie: a.cookie, body: a.body })).status).toBe(200);
  expect((await callApp(app, 'GET', `/notes/operations/${operationId}`, { cookie: b.cookie })).status).toBe(404);
  const own = await callApp(app, 'POST', `/notes/operations/${operationId}`, { cookie: b.cookie, body: b.body });
  expect(own.status).toBe(200);
  expect((await own.json<{ note: { id: string } }>()).note.id).not.toBe((await (await callApp(app, 'GET', `/notes/operations/${operationId}`, { cookie: a.cookie })).json<{ result: { note: { id: string } } }>()).result.note.id);
  expect(await noteCount(a.userId)).toBe(1);
  expect(await noteCount(b.userId)).toBe(1);
});
