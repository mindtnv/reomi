import { beforeEach, expect, test } from 'bun:test';
import { buildApp } from '../src/app';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers';

const app = buildApp();
beforeEach(resetTestDb);
async function fixture() {
  const { cookie } = await signUpAndCookie(app, uniqueEmail());
  const type = await (await callApp(app, 'POST', '/note-types', { cookie, body: { name: 'Kind test', kind: 'basic',
    fields: [{ name: 'Q', ord: 0 }, { name: 'A', ord: 1 }],
    templates: [{ name: 'Question', ord: 0, frontTemplate: '{{Q}}', backTemplate: '{{A}}' }] } })).json<any>();
  const deck = await (await callApp(app, 'POST', '/decks', { cookie, body: { name: 'Study' } })).json<any>();
  const { note, cards } = await (await callApp(app, 'POST', '/notes', { cookie, body: { noteTypeId: type.id,
    deckId: deck.id, fieldValues: { Q: 'Capital?', A: 'Paris' } } })).json<any>();
  const grade = await (await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: cards[0].id, rating: 4 } })).json<any>();
  return { cookie, type, note, card: grade.card };
}

test('changing the answer method requires an explicit fresh preview and never transfers FSRS', async () => {
  const { cookie, type, note, card } = await fixture();
  expect((await callApp(app, 'PATCH', `/note-types/${type.id}`, { cookie, body: { kind: 'typein' } })).status).toBe(409);
  const body = { kind: 'typein', answerFieldId: type.fields[1].id, expectedUpdatedAt: type.updatedAt };
  expect((await callApp(app, 'POST', `/note-types/${type.id}/kind`, { cookie, body })).status).toBe(409);
  const response = await callApp(app, 'POST', `/note-types/${type.id}/kind/preview`, { cookie, body });
  expect(response.status).toBe(200);
  const preview = await response.json<any>();
  expect(preview.kindTransition).toEqual({ from: 'basic', to: 'typein', resetsQuestions: true });
  expect(preview.impact).toMatchObject({ willCreateCards: 1, willDeleteCards: 1, willDeleteReviews: 1, willKeepCards: 0 });
  expect(preview.validation.samples[0].answer).toBe('Paris');
  const applied = await callApp(app, 'POST', `/note-types/${type.id}/kind`, { cookie, body: { ...body, confirmationToken: preview.confirmationToken } });
  expect(applied.status).toBe(200);
  const page = await (await callApp(app, 'GET', '/cards', { cookie })).json<any>();
  expect(page.items).toHaveLength(1);
  expect(page.items[0].id).not.toBe(card.id);
  expect(page.items[0]).toMatchObject({ noteId: note.id, state: 'new', reps: 0, renderKind: 'typein', note: { fieldValues: note.fieldValues } });
  expect((await callApp(app, 'GET', `/cards/${card.id}`, { cookie })).status).toBe(404);
});

test('ordinary-to-custom preserves the exact card and history but still requires consent', async () => {
  const { cookie, type, card } = await fixture();
  const body = { kind: 'custom', expectedUpdatedAt: type.updatedAt };
  const preview = await (await callApp(app, 'POST', `/note-types/${type.id}/kind/preview`, { cookie, body })).json<any>();
  expect(preview.kindTransition.resetsQuestions).toBe(false);
  expect(preview.impact).toMatchObject({ willKeepCards: 1, willDeleteCards: 0, willCreateCards: 0 });
  expect((await callApp(app, 'POST', `/note-types/${type.id}/kind`, { cookie, body })).status).toBe(409);
  expect((await callApp(app, 'POST', `/note-types/${type.id}/kind`, { cookie, body: { ...body, confirmationToken: preview.confirmationToken } })).status).toBe(200);
  const after = await (await callApp(app, 'GET', `/cards/${card.id}`, { cookie })).json<any>();
  expect(after).toMatchObject({ id: card.id, due: card.due, reps: card.reps, stability: card.stability, renderKind: 'custom' });
  expect(await (await callApp(app, 'GET', '/reviews', { cookie })).json<any[]>()).toHaveLength(1);
});

test('invalid cloze and missing typed answer targets cannot apply; all routes stay owner scoped', async () => {
  const { cookie, type, card } = await fixture();
  const body = { kind: 'cloze', expectedUpdatedAt: type.updatedAt };
  const preview = await (await callApp(app, 'POST', `/note-types/${type.id}/kind/preview`, { cookie, body })).json<any>();
  expect(preview.validation.invalidNotes).toBe(1);
  expect((await callApp(app, 'POST', `/note-types/${type.id}/kind`, { cookie, body: { ...body, confirmationToken: preview.confirmationToken } })).status).toBe(400);
  expect((await callApp(app, 'POST', `/note-types/${type.id}/kind/preview`, { cookie, body: { ...body, kind: 'typein' } })).status).toBe(400);
  const other = await signUpAndCookie(app, uniqueEmail());
  expect((await callApp(app, 'POST', `/note-types/${type.id}/kind/preview`, { cookie: other.cookie, body })).status).toBe(404);
  expect((await callApp(app, 'GET', `/cards/${card.id}`, { cookie })).status).toBe(200);
});

test('new grades after preview invalidate the exact consent', async () => {
  const { cookie, type, card } = await fixture();
  const body = { kind: 'typein', answerFieldId: type.fields[1].id, expectedUpdatedAt: type.updatedAt };
  const preview = await (await callApp(app, 'POST', `/note-types/${type.id}/kind/preview`, { cookie, body })).json<any>();
  await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: card.id, rating: 3 } });
  expect((await callApp(app, 'POST', `/note-types/${type.id}/kind`, { cookie, body: { ...body, confirmationToken: preview.confirmationToken } })).status).toBe(409);
  expect((await callApp(app, 'GET', `/cards/${card.id}`, { cookie })).status).toBe(200);
});

test('conversion rejects a selected answer exposed on the question or absent from the answer', async () => {
  const { cookie, type, card } = await fixture();
  const body = { kind: 'typein', expectedUpdatedAt: type.updatedAt, answerFieldId: type.fields[0].id };
  const preview = await (await callApp(app, 'POST', `/note-types/${type.id}/kind/preview`, { cookie, body })).json<any>();
  expect(preview.validation.invalidNotes).toBe(1);
  expect(preview.validation.samples[0].error).toBe('typein_answer_placement');
  expect((await callApp(app, 'POST', `/note-types/${type.id}/kind`, { cookie, body: { ...body, confirmationToken: preview.confirmationToken } })).status).toBe(400);
  expect((await callApp(app, 'GET', `/cards/${card.id}`, { cookie })).status).toBe(200);
});
