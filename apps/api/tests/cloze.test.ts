import { beforeEach, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { cards, db, notes, reviews } from '@reomi/db';
import { CLOZE_NOTE_TYPE, fsrsResetColumns, generateCards } from '@reomi/shared';
import { buildApp } from '../src/app';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers';

const app = buildApp();
beforeEach(resetTestDb);
const fields = { Text: '{{c1::Paris::city}} is in {{c2::France}}.', Extra: '' };
async function fixture() {
  const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
  const deck = await (await callApp(app, 'POST', '/decks', { cookie, body: { name: 'Cloze' } })).json<any>();
  const type = await (await callApp(app, 'POST', '/note-types', { cookie, body: { name: 'Cloze', kind: 'cloze',
    fields: CLOZE_NOTE_TYPE.fields, templates: CLOZE_NOTE_TYPE.templates } })).json<any>();
  return { cookie, userId, deckId: deck.id, type };
}

describe('numbered cloze', () => {
  test('numbers have independent schedules; unchanged numbers keep their IDs after edits', async () => {
    const { cookie, deckId, type } = await fixture();
    const response = await callApp(app, 'POST', '/notes', { cookie, body: { noteTypeId: type.id, deckId, fieldValues: fields } });
    expect(response.status).toBe(200);
    const created = await response.json<any>();
    expect(created.cards.map((card: any) => card.clozeNumber)).toEqual([1, 2]);
    const first = created.cards[0]; const second = created.cards[1];
    const grade = await (await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: first.id, rating: 4 } })).json<any>();
    const untouched = await (await callApp(app, 'GET', `/cards/${second.id}`, { cookie })).json<any>();
    expect(untouched.reps).toBe(0);
    const updated = await (await callApp(app, 'PATCH', `/notes/${created.note.id}`, { cookie, body: {
      fieldValues: { ...fields, Text: fields.Text + ' {{c3::Europe}}' },
    } })).json<any>();
    expect(updated.cards).toHaveLength(3);
    expect(updated.cards.find((card: any) => card.clozeNumber === 1)).toMatchObject({ id: first.id, due: grade.card.due, reps: 1 });
    expect(updated.cards.find((card: any) => card.clozeNumber === 2).id).toBe(second.id);
    expect(updated.cards.find((card: any) => card.clozeNumber === 3).reps).toBe(0);
    const patch = { fieldValues: { ...fields, Text: '{{c2::France}} {{c3::Europe}}' } };
    const preview = await (await callApp(app, 'POST', `/notes/${created.note.id}/preview`, { cookie, body: patch })).json<any>();
    expect(preview.impact).toMatchObject({ willKeepCards: 2, willDeleteCards: 1, willDeleteReviews: 1 });
    expect((await callApp(app, 'PATCH', `/notes/${created.note.id}`, { cookie, body: { ...patch, confirmationToken: preview.confirmationToken } })).status).toBe(200);
    expect((await callApp(app, 'GET', `/cards/${second.id}`, { cookie })).status).toBe(200);
  });

  for (const legacyNumber of [0, null]) {
  test(`legacy ${legacyNumber} aggregates keep history through an explicit split`, async () => {
    const { cookie, userId, deckId, type } = await fixture();
    const [note] = await db.insert(notes).values({ userId, noteTypeId: type.id, fieldValues: fields }).returning();
    const descriptor = generateCards(CLOZE_NOTE_TYPE, fields, { legacyCloze: true })[0];
    const [legacy] = await db.insert(cards).values({ userId, deckId, noteId: note.id, ...descriptor, clozeNumber: legacyNumber, ...fsrsResetColumns() }).returning();
    const grade = await (await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: legacy.id, rating: 4 } })).json<any>();
    const edit = await (await callApp(app, 'PATCH', `/notes/${note.id}`, { cookie, body: { fieldValues: fields } })).json<any>();
    expect(edit.cards).toHaveLength(1);
    expect(edit.cards[0]).toMatchObject({ id: legacy.id, clozeNumber: 0, due: grade.card.due });
    const patch = { fieldValues: fields, clozeRetainHistoryFor: { 0: 2 } };
    expect((await callApp(app, 'PATCH', `/notes/${note.id}`, { cookie, body: patch })).status).toBe(409);
    const preview = await (await callApp(app, 'POST', `/notes/${note.id}/preview`, { cookie, body: patch })).json<any>();
    expect(preview.impact).toMatchObject({ retainedClozeTargets: { 0: 2 }, willCreateCards: 1, willKeepCards: 1, willDeleteCards: 0, willDeleteReviews: 0 });
    const changedTarget = await callApp(app, 'PATCH', `/notes/${note.id}`, { cookie, body: { ...patch, clozeRetainHistoryFor: { 0: 1 }, confirmationToken: preview.confirmationToken } });
    expect(changedTarget.status).toBe(409);
    const applied = await callApp(app, 'PATCH', `/notes/${note.id}`, { cookie, body: { ...patch, confirmationToken: preview.confirmationToken } });
    expect(applied.status).toBe(200);
    const result = await applied.json<any>();
    expect(result.cards.find((card: any) => card.clozeNumber === 2)).toMatchObject({ id: legacy.id, reps: 1, due: grade.card.due });
    expect(result.cards.find((card: any) => card.clozeNumber === 1).reps).toBe(0);
    expect(await db.select().from(reviews).where(eq(reviews.cardId, legacy.id))).toHaveLength(1);
  });

  }

  test('malformed cloze is rejected without saving or deleting existing content', async () => {
    const { cookie, deckId, type } = await fixture();
    const created = await (await callApp(app, 'POST', '/notes', { cookie, body: { deckId, noteTypeId: type.id, fieldValues: fields } })).json<any>();
    for (const Text of ['{{c1::unclosed', '{{c0::bad}}', '{{c1::'.repeat(9) + 'deep' + '}}'.repeat(9)]) {
      expect((await callApp(app, 'POST', '/notes', { cookie, body: { deckId, noteTypeId: type.id, fieldValues: { Text } } })).status).toBe(400);
      expect((await callApp(app, 'PATCH', `/notes/${created.note.id}`, { cookie, body: { fieldValues: { Text } } })).status).toBe(400);
    }
    const saved = await (await callApp(app, 'GET', `/cards/${created.cards[0].id}`, { cookie })).json<any>();
    expect(saved.note.fieldValues).toEqual(fields);
  });

  test('each legacy template must have an explicit history destination', async () => {
    const { cookie, userId, deckId, type } = await fixture();
    const changed = await (await callApp(app, 'PATCH', `/note-types/${type.id}`, { cookie, body: { templates: [
      type.templates[0], { name: 'Extra question', ord: 1, frontTemplate: '{{Extra}}', backTemplate: '{{Extra}}' },
    ] } })).json<any>();
    const values = { Text: '{{c1::One}}', Extra: '{{c2::Two}}' };
    const [note] = await db.insert(notes).values({ userId, noteTypeId: type.id, fieldValues: values }).returning();
    const generated = generateCards({ ...CLOZE_NOTE_TYPE, templates: changed.templates }, values, { legacyCloze: true });
    const original = await db.insert(cards).values(generated.map((card) => ({ userId, deckId, noteId: note.id, ...card, ...fsrsResetColumns() }))).returning();
    expect((await callApp(app, 'POST', `/notes/${note.id}/preview`, { cookie,
      body: { clozeRetainHistoryFor: { 0: 1, 1: 2 }, expectedTypeUpdatedAt: type.updatedAt } })).status).toBe(409);
    expect((await callApp(app, 'POST', `/notes/${note.id}/preview`, { cookie, body: { clozeRetainHistoryFor: { 0: 1 } } })).status).toBe(400);
    const patch = { clozeRetainHistoryFor: { 0: 1, 1: 2 } };
    const preview = await (await callApp(app, 'POST', `/notes/${note.id}/preview`, { cookie, body: patch })).json<any>();
    expect(preview.impact).toMatchObject({ willKeepCards: 2, willDeleteCards: 0, willCreateCards: 0 });
    const applied = await (await callApp(app, 'PATCH', `/notes/${note.id}`, { cookie, body: { ...patch, confirmationToken: preview.confirmationToken } })).json<any>();
    expect(applied.cards.map((card: any) => card.id).sort()).toEqual(original.map((card) => card.id).sort());
    expect(applied.cards.map((card: any) => card.clozeNumber).sort()).toEqual([1, 2]);
  });

  test('the database prevents duplicate identities without deleting the original', async () => {
    const { cookie, deckId, type, userId } = await fixture();
    const created = await (await callApp(app, 'POST', '/notes', { cookie, body: { deckId, noteTypeId: type.id, fieldValues: fields } })).json<any>();
    const [first] = await db.select().from(cards).where(eq(cards.id, created.cards[0].id));
    const { id: _id, ...duplicate } = first;
    let code: string | undefined;
    try { await db.insert(cards).values(duplicate); } catch (error: any) { code = error.cause?.code ?? error.code; }
    expect(code).toBe('23505');
    expect(await db.select().from(cards).where(and(eq(cards.noteId, created.note.id), eq(cards.userId, userId)))).toHaveLength(2);
  });
});
