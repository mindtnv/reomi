import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from '@reomi/db';
import { buildApp } from '../src/app';
import { applyNoteUpdate, insertNoteAndCards, resolveNoteCreate, resolveNoteUpdate } from '../src/modules/notes';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers';

const app = buildApp();
beforeEach(resetTestDb);
async function fixture() {
  const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
  const deck = await (await callApp(app, 'POST', '/decks', { cookie, body: { name: 'Notes' } })).json<any>();
  const type = await (await callApp(app, 'POST', '/note-types', { cookie, body: { name: 'Two sides',
    fields: [{ name: 'Q', ord: 0 }, { name: 'A', ord: 1 }], templates: [
      { name: 'Forward', ord: 0, frontTemplate: '{{Q}}', backTemplate: '{{A}}' },
      { name: 'Reverse', ord: 1, frontTemplate: '{{A}}', backTemplate: '{{Q}}' },
    ], kind: 'custom' } })).json<any>();
  const created = await (await callApp(app, 'POST', '/notes', { cookie, body: {
    noteTypeId: type.id, deckId: deck.id, fieldValues: { Q: 'question', A: 'answer' },
  } })).json<any>();
  return { cookie, userId, deck, type, created };
}

describe('note impact and concurrency', () => {
  test('batched refresh and note-type filtering never expose another user cards', async () => {
    const a = await fixture();
    const b = await fixture();
    const lookup = await callApp(app, 'POST', '/cards/lookup', { cookie: a.cookie,
      body: { ids: [a.created.cards[0].id, a.created.cards[0].id, b.created.cards[0].id] } });
    expect(lookup.status).toBe(200);
    const rows = (await lookup.json<any>()).items;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(a.created.cards[0].id);
    const foreignType = await (await callApp(app, 'GET', `/cards?noteTypeId=${b.type.id}`, { cookie: a.cookie })).json<any>();
    expect(foreignType.items).toEqual([]);
    expect((await callApp(app, 'POST', '/cards/lookup', { cookie: a.cookie,
      body: { ids: Array(201).fill(a.created.cards[0].id) } })).status).toBe(400);
  });
  test('removal is previewed with history and never applied without current consent', async () => {
    const { cookie, created } = await fixture();
    const reverse = created.cards.find((card: any) => card.templateOrd === 1);
    expect((await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: reverse.id, rating: 4 } })).status).toBe(200);
    // Forget resets reps, but its retained reviews must still be disclosed.
    expect((await callApp(app, 'PATCH', `/cards/${reverse.id}`, { cookie, body: { forget: true } })).status).toBe(200);
    const patch = { fieldValues: { Q: 'question', A: '' }, expectedUpdatedAt: created.note.updatedAt };
    expect((await callApp(app, 'PATCH', `/notes/${created.note.id}`, { cookie, body: patch })).status).toBe(409);
    const previewResponse = await callApp(app, 'POST', `/notes/${created.note.id}/preview`, { cookie, body: patch });
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json<any>();
    expect(preview.impact).toMatchObject({ willDeleteCards: 1, willDeleteReviews: 1, willKeepCards: 1 });
    const unchanged = await (await callApp(app, 'GET', `/cards/${reverse.id}`, { cookie })).json<any>();
    expect(unchanged.note.fieldValues.A).toBe('answer');
    const saved = await callApp(app, 'PATCH', `/notes/${created.note.id}`, { cookie, body: { ...patch, confirmationToken: preview.confirmationToken } });
    expect(saved.status).toBe(200);
    expect((await saved.json<any>()).cards).toHaveLength(1);
  });

  test('a grade between note preview and apply invalidates the preview token', async () => {
    const { cookie, created } = await fixture();
    const patch = { fieldValues: { Q: 'question', A: '' } };
    const preview = await (await callApp(app, 'POST', `/notes/${created.note.id}/preview`, { cookie, body: patch })).json<any>();
    const reverse = created.cards.find((card: any) => card.templateOrd === 1);
    await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: reverse.id, rating: 3 } });
    const result = await callApp(app, 'PATCH', `/notes/${created.note.id}`, { cookie, body: { ...patch, confirmationToken: preview.confirmationToken } });
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ error: 'preview_changed' });
    expect((await callApp(app, 'GET', `/cards/${reverse.id}`, { cookie })).status).toBe(200);
  });

  test('a stale editor cannot overwrite fields from another editor', async () => {
    const { cookie, created } = await fixture();
    const version = created.note.updatedAt;
    expect((await callApp(app, 'PATCH', `/notes/${created.note.id}`, { cookie,
      body: { fieldValues: { Q: 'current', A: 'answer' }, expectedUpdatedAt: version } })).status).toBe(200);
    const stale = await callApp(app, 'PATCH', `/notes/${created.note.id}`, { cookie,
      body: { fieldValues: { Q: 'stale', A: 'answer' }, expectedUpdatedAt: version } });
    expect(stale.status).toBe(409);
    const current = await (await callApp(app, 'GET', `/cards/${created.cards[0].id}`, { cookie })).json<any>();
    expect(current.note.fieldValues.Q).toBe('current');
  });

  test('create resolved before a type change cannot commit obsolete generated cards', async () => {
    const { cookie, userId, type, deck } = await fixture();
    const resolved = await resolveNoteCreate(userId, { noteTypeId: type.id, deckId: deck.id, fieldValues: { Q: 'old', A: 'answer' } });
    if (!resolved.ok) throw new Error(resolved.error);
    expect((await callApp(app, 'PATCH', `/note-types/${type.id}`, { cookie, body: {
      templates: type.templates.map((template: any) => ({ ...template, frontTemplate: `Updated ${template.frontTemplate}` })),
    } })).status).toBe(200);
    await expect(db.transaction((tx) => insertNoteAndCards(tx, { userId, noteTypeId: type.id, deckId: deck.id,
      expectedTypeUpdatedAt: resolved.typeUpdatedAt, sanitized: resolved.sanitized, generated: resolved.generated, tags: [],
    }))).rejects.toThrow('note_type_changed');
    const page = await (await callApp(app, 'GET', '/cards', { cookie })).json<any>();
    expect(page.items).toHaveLength(2);
    expect(page.items.every((card: any) => card.renderFrontText.startsWith('Updated'))).toBe(true);
  });

  test('resolved note edit cannot commit after template reorder or type deletion', async () => {
    const { cookie, userId, type, created } = await fixture();
    const resolved = await resolveNoteUpdate(userId, created.note.id, { fieldValues: { Q: 'pending', A: 'answer' } });
    if (!resolved.ok) throw new Error(resolved.error);
    const input = { userId, noteId: created.note.id, nextFieldValues: resolved.nextFieldValues, nextTags: resolved.nextTags,
      generated: resolved.generated, expectedUpdatedAt: resolved.note.updatedAt, expectedTypeUpdatedAt: resolved.typeUpdatedAt };
    await callApp(app, 'PATCH', `/note-types/${type.id}`, { cookie, body: { templates: type.templates.toReversed().map((template: any, ord: number) => ({ ...template, ord })) } });
    await expect(db.transaction((tx) => applyNoteUpdate(tx, input))).rejects.toThrow('note_type_changed');
    await callApp(app, 'DELETE', `/note-types/${type.id}`, { cookie, body: { confirmationToken: (await (await callApp(app, 'GET', `/note-types/${type.id}/delete-preview`, { cookie })).json<any>()).confirmationToken } });
    await expect(db.transaction((tx) => applyNoteUpdate(tx, input))).rejects.toThrow('note_changed');
  });
});
