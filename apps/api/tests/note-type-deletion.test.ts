import { beforeEach, expect, test } from 'bun:test';
import { eq, sql, count } from 'drizzle-orm';
import { db, cards, notes, noteTypes, decks, reviews } from '@reomi/db';
import { buildApp } from '../src/app';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers';

const app = buildApp();
beforeEach(resetTestDb);
async function fixture(size = 1) {
  const { cookie, userId } = await signUpAndCookie(app, uniqueEmail('type-delete'));
  const [type] = await db.insert(noteTypes).values({ userId, name: 'Delete scope', kind: 'basic',
    fields: [{ name: 'Q', ord: 0 }, { name: 'A', ord: 1 }],
    templates: [{ name: 'Forward', ord: 0, frontTemplate: '{{Q}}', backTemplate: '{{A}}' }],
  }).returning();
  const [deck] = await db.insert(decks).values({ userId, name: 'Keep deck' }).returning();
  await db.execute(sql`insert into notes (user_id, note_type_id, field_values)
    select ${userId}, ${type!.id}::uuid, jsonb_build_object('Q', 'Question ' || n, 'A', 'Answer')
    from generate_series(1, ${size}) as n`);
  await db.execute(sql`insert into cards (user_id, note_id, deck_id, template_ord, render_front_text, render_back_text, render_text, render_kind)
    select ${userId}, id, ${deck!.id}::uuid, 0, field_values->>'Q', 'Answer', 'Question Answer', 'basic'
    from notes where user_id = ${userId}`);
  return { cookie, userId, type: type!, deck: deck! };
}
async function preview(cookie: string, id: string) {
  const response = await callApp(app, 'GET', `/note-types/${id}/delete-preview`, { cookie });
  expect(response.headers['cache-control']).toBe('no-store');
  const data = await response.json<any>();
  expect({ status: response.status, error: data.error }).toEqual({ status: 200, error: undefined });
  return data;
}

test('deletion previews complete scope beyond 500 cards including orphan notes and reviews', async () => {
  const { cookie, userId, type, deck } = await fixture(700);
  const foreign = await fixture(2);
  await db.insert(notes).values({ userId, noteTypeId: type.id, fieldValues: { Q: 'Orphan', A: 'Kept in export' } });
  await db.execute(sql`insert into reviews (user_id, card_id, deck_id, rating, next_due, next_stability, next_difficulty)
    select ${userId}, id, deck_id, 3, now(), 1, 5 from cards where user_id = ${userId}`);
  const state = await preview(cookie, type.id);
  expect(state).toMatchObject({ noteTypeId: type.id, name: type.name, notes: 701, cards: 700, reviews: 700, notesWithoutCards: 1 });
  expect(state.confirmationToken).toMatch(/^[a-f0-9]{64}$/);
  expect((await db.select({ n: count() }).from(notes).where(eq(notes.userId, userId)))[0]!.n).toBe(701);
  expect((await callApp(app, 'DELETE', `/note-types/${type.id}`, { cookie })).status).toBe(409);
  const removed = await callApp(app, 'DELETE', `/note-types/${type.id}`, { cookie, body: { confirmationToken: state.confirmationToken } });
  expect(removed.status).toBe(200);
  expect(await db.select().from(notes).where(eq(notes.userId, userId))).toHaveLength(0);
  expect(await db.select().from(cards).where(eq(cards.userId, userId))).toHaveLength(0);
  expect(await db.select().from(reviews).where(eq(reviews.userId, userId))).toHaveLength(0);
  expect(await db.select().from(decks).where(eq(decks.id, deck.id))).toHaveLength(1);
  expect(await db.select().from(cards).where(eq(cards.userId, foreign.userId))).toHaveLength(2);
}, 15_000);

test('foreign, missing and builtin type previews/deletes never expose impact or mutate', async () => {
  const { cookie, type } = await fixture();
  const { cookie: other } = await signUpAndCookie(app, uniqueEmail('foreign-delete'));
  const [builtin] = await db.insert(noteTypes).values({ ...type, id: undefined, userId: null, isBuiltin: true, name: 'Global' }).returning();
  for (const id of [type.id, builtin!.id, crypto.randomUUID()]) {
    const actor = id === type.id ? other : cookie;
    expect((await callApp(app, 'GET', `/note-types/${id}/delete-preview`, { cookie: actor })).status).toBe(404);
    expect((await callApp(app, 'DELETE', `/note-types/${id}`, { cookie: actor, body: { confirmationToken: 'a'.repeat(64) } })).status).toBe(404);
  }
  expect((await callApp(app, 'GET', `/note-types/${type.id}/delete-preview`)).status).toBe(401);
  expect(await db.select().from(noteTypes).where(eq(noteTypes.id, type.id))).toHaveLength(1);
});

test('new reviews and changed notes invalidate consent before deleting anything', async () => {
  const { cookie, userId, type } = await fixture();
  const beforeGrade = await preview(cookie, type.id);
  const [card] = await db.select().from(cards).where(eq(cards.userId, userId));
  expect((await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: card!.id, rating: 3 } })).status).toBe(200);
  const stale = await callApp(app, 'DELETE', `/note-types/${type.id}`, { cookie, body: { confirmationToken: beforeGrade.confirmationToken } });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({ error: 'preview_changed' });
  const beforeEdit = await preview(cookie, type.id);
  await db.update(notes).set({ fieldValues: { Q: 'Changed without timestamp bump', A: 'Answer' } }).where(eq(notes.userId, userId));
  expect((await callApp(app, 'DELETE', `/note-types/${type.id}`, { cookie, body: { confirmationToken: beforeEdit.confirmationToken } })).status).toBe(409);
  expect(await db.select().from(cards).where(eq(cards.id, card!.id))).toHaveLength(1);
  expect(await db.select().from(reviews).where(eq(reviews.cardId, card!.id))).toHaveLength(1);
});

test('converting notes first protects their cards/history when the old type is later deleted', async () => {
  const { identifiedTemplates } = await import('@reomi/shared');
  const { cookie, userId, type } = await fixture(2);
  const [kept] = await db.select().from(cards).where(eq(cards.userId, userId)).orderBy(cards.id);
  expect((await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: kept!.id, rating: 3 } })).status).toBe(200);
  const originalPreview = await preview(cookie, type.id);
  const target = await (await callApp(app, 'POST', '/note-types', { cookie, body: {
    name: 'Preserved type', fields: type.fields, templates: type.templates, kind: 'basic',
  } })).json<any>();
  const input = { noteIds: [kept!.noteId], sourceTypeId: type.id, targetTypeId: target.id,
    sourceVersion: type.updatedAt.toISOString(), targetVersion: target.updatedAt,
    fieldMap: { Q: 'Q', A: 'A' }, templateMap: { [target.templates[0].id]: identifiedTemplates(type.id, type.templates)[0]!.id }, preserveUnmappedFields: true };
  const convertPreview = await callApp(app, 'POST', '/notes/convert/preview', { cookie, body: input });
  expect(convertPreview.status).toBe(200);
  const consent = await convertPreview.json<any>();
  expect((await callApp(app, 'POST', '/notes/convert', { cookie, body: { ...input, confirmationToken: consent.confirmationToken } })).status).toBe(200);
  expect((await callApp(app, 'DELETE', `/note-types/${type.id}`, { cookie, body: { confirmationToken: originalPreview.confirmationToken } })).status).toBe(409);
  const after = await preview(cookie, type.id);
  expect(after).toMatchObject({ notes: 1, cards: 1, reviews: 0 });
  expect((await callApp(app, 'DELETE', `/note-types/${type.id}`, { cookie, body: { confirmationToken: after.confirmationToken } })).status).toBe(200);
  const remaining = await db.select().from(cards).where(eq(cards.userId, userId));
  expect(remaining.map(c => c.id)).toEqual([kept!.id]);
  expect(remaining[0]!.reps).toBe(1);
  expect(await db.select().from(reviews).where(eq(reviews.cardId, kept!.id))).toHaveLength(1);
});

test('cascade timeout rolls back partially deleted rows and preserves the type', async () => {
  const { cookie, userId, type } = await fixture(2);
  const consent = await preview(cookie, type.id);
  await db.execute(sql`create function test_type_delete_delay() returns trigger language plpgsql as $$
    begin perform pg_sleep(3); return old; end $$`);
  await db.execute(sql`create trigger test_type_delete_delay after delete on cards for each row execute function test_type_delete_delay()`);
  try {
    const response = await callApp(app, 'DELETE', `/note-types/${type.id}`, { cookie, body: { confirmationToken: consent.confirmationToken } });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: 'note_type_operation_timeout' });
    expect(await db.select().from(noteTypes).where(eq(noteTypes.id, type.id))).toHaveLength(1);
    expect(await db.select().from(notes).where(eq(notes.userId, userId))).toHaveLength(2);
    expect(await db.select().from(cards).where(eq(cards.userId, userId))).toHaveLength(2);
  } finally {
    await db.execute(sql`drop trigger test_type_delete_delay on cards`);
    await db.execute(sql`drop function test_type_delete_delay()`);
  }
}, 10_000);

test('replacing a note without changing counts invalidates the membership snapshot', async () => {
  const { cookie, userId, type } = await fixture(0);
  const [first] = await db.insert(notes).values({ userId, noteTypeId: type.id, fieldValues: { Q: 'Same', A: 'Same' } }).returning();
  const consent = await preview(cookie, type.id);
  await db.delete(notes).where(eq(notes.id, first!.id));
  await db.insert(notes).values({ userId, noteTypeId: type.id, fieldValues: first!.fieldValues });
  const rejected = await callApp(app, 'DELETE', `/note-types/${type.id}`, { cookie, body: { confirmationToken: consent.confirmationToken } });
  expect(rejected.status).toBe(409);
  expect(await db.select().from(notes).where(eq(notes.userId, userId))).toHaveLength(1);
});
