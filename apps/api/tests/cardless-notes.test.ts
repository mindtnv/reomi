// Notes keep their text after every card is deleted. The author must be able
// to find that note, recreate its cards in a chosen deck, or delete it.
// Nothing deletes the note just because its cards are gone.

import { beforeEach, expect, test } from 'bun:test';
import { buildApp } from '../src/app.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();
const FRONT = 'Capital of France ![](/m/0199aabb-ccdd-7ee0-8ff0-111111111111)';

async function freshDeck(cookie: string, name: string): Promise<string> {
  const res = await callApp(app, 'POST', '/decks', { cookie, body: { name } });
  expect(res.status).toBe(200);
  return (await res.json<{ id: string }>()).id;
}

async function basicType(cookie: string): Promise<string> {
  const res = await callApp(app, 'POST', '/note-types', {
    cookie,
    body: {
      name: 'Basic',
      kind: 'basic',
      fields: [
        { name: 'Front', ord: 0 },
        { name: 'Back', ord: 1 },
      ],
      templates: [
        { name: 'Card 1', ord: 0, frontTemplate: '{{Front}}', backTemplate: '{{Front}}<hr>{{Back}}' },
      ],
    },
  });
  expect(res.status).toBe(200);
  return (await res.json<{ id: string }>()).id;
}

async function twoTemplateType(cookie: string): Promise<string> {
  const res = await callApp(app, 'POST', '/note-types', {
    cookie,
    body: {
      name: 'Both ways',
      kind: 'custom',
      fields: [
        { name: 'Front', ord: 0 },
        { name: 'Back', ord: 1 },
      ],
      templates: [
        { name: 'Card 1', ord: 0, frontTemplate: '{{Front}}', backTemplate: '{{Back}}' },
        { name: 'Card 2', ord: 1, frontTemplate: '{{Back}}', backTemplate: '{{Front}}' },
      ],
    },
  });
  expect(res.status).toBe(200);
  return (await res.json<{ id: string }>()).id;
}

async function createNote(cookie: string, deckId: string, noteTypeId: string, front = FRONT) {
  const res = await callApp(app, 'POST', '/notes', {
    cookie,
    body: { noteTypeId, deckId, tags: ['keep'], fieldValues: { Front: front, Back: 'Paris' } },
  });
  expect(res.status).toBe(200);
  return res.json<{
    note: { id: string; fieldValues: Record<string, string>; tags: string[]; createdAt: string; updatedAt: string };
    cards: Array<{ id: string; deckId: string }>;
  }>();
}

beforeEach(async () => {
  await resetTestDb();
});

test('deleting the last card keeps the note findable and a chosen deck restores its cards', async () => {
  const { cookie } = await signUpAndCookie(app, uniqueEmail());
  const original = await freshDeck(cookie, 'Original');
  const recovery = await freshDeck(cookie, 'Recovery');
  const noteTypeId = await basicType(cookie);
  const created = await createNote(cookie, original, noteTypeId);

  const deleted = await callApp(app, 'DELETE', `/cards/${created.cards[0]!.id}`, { cookie });
  expect(deleted.status).toBe(200);

  const detail = await callApp(app, 'GET', `/notes/${created.note.id}`, { cookie });
  expect(detail.status).toBe(200);
  const saved = await detail.json<{
    note: { fieldValues: Record<string, string>; tags: string[]; createdAt: string; updatedAt: string };
    cards: unknown[];
  }>();
  expect(saved.cards).toEqual([]);
  expect(saved.note.fieldValues).toEqual({ Front: FRONT, Back: 'Paris' });
  expect(saved.note.tags).toEqual(['keep']);

  const listed = await callApp(app, 'GET', '/notes/cardless', { cookie });
  expect(listed.status).toBe(200);
  expect(await listed.json()).toEqual({
    total: 1,
    items: [{
      id: created.note.id,
      noteTypeId,
      noteTypeName: 'Basic',
      fieldValues: { Front: FRONT, Back: 'Paris' },
      tags: ['keep'],
      createdAt: saved.note.createdAt,
      updatedAt: saved.note.updatedAt,
    }],
  });

  const restored = await callApp(app, 'POST', `/notes/${created.note.id}/restore`, {
    cookie,
    body: { deckId: recovery },
  });
  expect(restored.status).toBe(200);
  const body = await restored.json<{
    note: { fieldValues: Record<string, string>; tags: string[] };
    cards: Array<{ id: string; deckId: string; templateOrd: number; state: string; reps: number }>;
  }>();
  expect(body.note.fieldValues).toEqual({ Front: FRONT, Back: 'Paris' });
  expect(body.note.tags).toEqual(['keep']);
  expect(body.cards.map((card) => ({
    deckId: card.deckId,
    templateOrd: card.templateOrd,
    state: card.state,
    reps: card.reps,
  }))).toEqual([{ deckId: recovery, templateOrd: 0, state: 'new', reps: 0 }]);

  const hidden = await callApp(app, 'GET', '/notes/cardless', { cookie });
  expect(await hidden.json()).toEqual({ total: 0, items: [] });

  const card = await callApp(app, 'GET', `/cards/${body.cards[0]!.id}`, { cookie });
  expect(card.status).toBe(200);
  const read = await card.json<{ deckId: string; note: { fieldValues: { Front: string } } }>();
  expect(read.deckId).toBe(recovery);
  expect(read.note.fieldValues.Front).toBe(FRONT);

  const again = await callApp(app, 'POST', `/notes/${created.note.id}/restore`, {
    cookie,
    body: { deckId: original },
  });
  expect(again.status).toBe(409);
  expect(await again.json()).toEqual({ error: 'note_has_cards' });
  const still = await callApp(app, 'GET', `/cards/${body.cards[0]!.id}`, { cookie });
  expect(still.status).toBe(200);
  expect((await still.json<{ deckId: string }>()).deckId).toBe(recovery);
});

test('bulk-deleting every card lists that note, and a note that still has a card stays hidden', async () => {
  const { cookie } = await signUpAndCookie(app, uniqueEmail());
  const deckId = await freshDeck(cookie, 'Deck');
  const paired = await twoTemplateType(cookie);
  const both = await createNote(cookie, deckId, paired, 'Alpha');
  const kept = await createNote(cookie, deckId, paired, 'Beta');
  expect(both.cards).toHaveLength(2);
  expect(kept.cards).toHaveLength(2);

  const bulk = await callApp(app, 'POST', '/cards/bulk', {
    cookie,
    body: { action: 'delete', cardIds: both.cards.map((card) => card.id) },
  });
  expect(bulk.status).toBe(200);
  expect(await bulk.json()).toEqual({ deleted: 2 });

  const half = await callApp(app, 'DELETE', `/cards/${kept.cards[0]!.id}`, { cookie });
  expect(half.status).toBe(200);

  const listed = await callApp(app, 'GET', '/notes/cardless', { cookie });
  expect(listed.status).toBe(200);
  const list = await listed.json<{ total: number; items: Array<{ id: string; noteTypeName: string; fieldValues: { Front: string } }> }>();
  expect(list.total).toBe(1);
  expect(list.items.map((item) => ({
    id: item.id,
    noteTypeName: item.noteTypeName,
    front: item.fieldValues.Front,
  }))).toEqual([
    { id: both.note.id, noteTypeName: 'Both ways', front: 'Alpha' },
  ]);

  const survivor = await callApp(app, 'GET', `/notes/${kept.note.id}`, { cookie });
  expect(survivor.status).toBe(200);
  const survivorBody = await survivor.json<{ cards: unknown[]; note: { fieldValues: { Front: string } } }>();
  expect(survivorBody.cards).toHaveLength(1);
  expect(survivorBody.note.fieldValues.Front).toBe('Beta');
});

test('explicit delete removes a cardless note, and another user cannot see or restore it', async () => {
  const owner = await signUpAndCookie(app, uniqueEmail());
  const other = await signUpAndCookie(app, uniqueEmail());
  const deckId = await freshDeck(owner.cookie, 'Mine');
  const foreignDeck = await freshDeck(other.cookie, 'Theirs');
  const noteTypeId = await basicType(owner.cookie);
  const created = await createNote(owner.cookie, deckId, noteTypeId);
  const removed = await callApp(app, 'DELETE', `/cards/${created.cards[0]!.id}`, { cookie: owner.cookie });
  expect(removed.status).toBe(200);

  const foreignList = await callApp(app, 'GET', '/notes/cardless', { cookie: other.cookie });
  expect(foreignList.status).toBe(200);
  expect(await foreignList.json()).toEqual({ total: 0, items: [] });

  const foreignRestore = await callApp(app, 'POST', `/notes/${created.note.id}/restore`, {
    cookie: other.cookie,
    body: { deckId: foreignDeck },
  });
  expect(foreignRestore.status).toBe(404);
  expect(await foreignRestore.json()).toEqual({ error: 'not_found' });

  const wrongDeck = await callApp(app, 'POST', `/notes/${created.note.id}/restore`, {
    cookie: owner.cookie,
    body: { deckId: foreignDeck },
  });
  expect(wrongDeck.status).toBe(400);
  expect(await wrongDeck.json()).toEqual({ error: 'deck_not_found' });
  const stillThere = await callApp(app, 'GET', `/notes/${created.note.id}`, { cookie: owner.cookie });
  expect(stillThere.status).toBe(200);
  expect((await stillThere.json<{ note: { fieldValues: { Front: string } } }>()).note.fieldValues.Front).toBe(FRONT);

  const foreignDelete = await callApp(app, 'DELETE', `/notes/${created.note.id}`, { cookie: other.cookie });
  expect(foreignDelete.status).toBe(404);

  const deleted = await callApp(app, 'DELETE', `/notes/${created.note.id}`, { cookie: owner.cookie });
  expect(deleted.status).toBe(200);
  expect(await deleted.json()).toEqual({ ok: true });
  const gone = await callApp(app, 'GET', `/notes/${created.note.id}`, { cookie: owner.cookie });
  expect(gone.status).toBe(404);
  const empty = await callApp(app, 'GET', '/notes/cardless', { cookie: owner.cookie });
  expect(await empty.json()).toEqual({ total: 0, items: [] });
});
