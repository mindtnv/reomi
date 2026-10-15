import { beforeEach, expect, test } from 'bun:test';
import { db, notes, noteTypes, uiActionReceipts } from '@reomi/db';
import { eq, sql } from 'drizzle-orm';
import { newUuidV7 } from '@reomi/shared';
import { buildApp } from '../src/app';
import { callApp, ensureNoteType, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers';
import { performUiAction } from '../src/modules/ui-action-receipts';
import { createNoteForRequest } from '../src/modules/notes';
const app = buildApp();
beforeEach(resetTestDb);
const envelope = () => ({ requestId: newUuidV7(), sessionId: newUuidV7() });
async function fixture() {
  const owner = await signUpAndCookie(app, uniqueEmail());
  const deck = await (await callApp(app, 'POST', '/decks', { cookie: owner.cookie, body: { name: 'Deck' } })).json<any>();
  const type = await (await callApp(app, 'POST', '/note-types', { cookie: owner.cookie, body: { name: 'Two directions', kind: 'custom',
    fields: [{ name: 'Q', ord: 0 }, { name: 'A', ord: 1 }], templates: [
      { name: 'Forward', ord: 0, frontTemplate: '{{Q}}', backTemplate: '{{A}}' },
      { name: 'Reverse', ord: 1, frontTemplate: '{{A}}', backTemplate: '{{Q}}' },
    ] } })).json<any>();
  return { ...owner, deck, type };
}
test('lost card-create response returns the same generated identities without persisting card bodies in receipts', async () => {
  const { cookie, userId, deck, type } = await fixture();
  const body = { ...envelope(), input: { deckId: deck.id, noteTypeId: type.id, expectedTypeUpdatedAt: type.updatedAt,
    fieldValues: { Q: 'Private question', A: 'Private answer' }, tags: [] } };
  const save = () => callApp(app, 'POST', '/ui-actions/v1/card-notes', { cookie, body });
  const [first, second] = await Promise.all([save(), save()]);
  expect(first.status).toBe(200); expect(second.status).toBe(200);
  const a = await first.json<any>(), b = await second.json<any>();
  expect(a.result.note.id).toBe(b.result.note.id);
  expect(a.result.cards.map((row: any) => row.id).sort()).toEqual(b.result.cards.map((row: any) => row.id).sort());
  expect(await db.select().from(notes).where(eq(notes.userId, userId))).toHaveLength(1);
  expect(JSON.stringify(await db.select().from(uiActionReceipts))).not.toContain('Private question');
});
test('replayed destructive card edit reuses its receipt while a new unconfirmed edit is rejected', async () => {
  const { cookie, deck, type } = await fixture();
  const created = await (await callApp(app, 'POST', '/notes', { cookie, body: { deckId: deck.id, noteTypeId: type.id, fieldValues: { Q: 'Q', A: 'A' } } })).json<any>();
  const patch = { fieldValues: { Q: 'Q', A: '' }, expectedUpdatedAt: created.note.updatedAt, expectedTypeUpdatedAt: type.updatedAt };
  const blocked = await callApp(app, 'PATCH', `/ui-actions/v1/card-notes/${created.note.id}`, { cookie, body: { ...envelope(), input: patch } });
  expect(blocked.status).toBe(409);
  const preview = await (await callApp(app, 'POST', `/notes/${created.note.id}/preview`, { cookie, body: patch })).json<any>();
  const body = { ...envelope(), input: { ...patch, confirmationToken: preview.confirmationToken } };
  const first = await callApp(app, 'PATCH', `/ui-actions/v1/card-notes/${created.note.id}`, { cookie, body });
  expect(first.status).toBe(200);
  const repeat = await callApp(app, 'PATCH', `/ui-actions/v1/card-notes/${created.note.id}`, { cookie, body });
  expect(repeat.status).toBe(200);
  expect((await repeat.json<any>()).replayed).toBe(true);
});
test('builtin type clone is created once and owned type removal still needs a current preview', async () => {
  const { cookie, userId, type, deck } = await fixture();
  const builtinId = await ensureNoteType(app, cookie, 'basic');
  const [builtin] = await db.select().from(noteTypes).where(eq(noteTypes.id, builtinId));
  const body = { ...envelope(), input: { name: 'My clone', expectedUpdatedAt: builtin!.updatedAt.toISOString() } };
  const clone = await callApp(app, 'PATCH', `/ui-actions/v1/note-types/${builtinId}`, { cookie, body });
  expect(clone.status).toBe(200);
  const repeated = await callApp(app, 'PATCH', `/ui-actions/v1/note-types/${builtinId}`, { cookie, body });
  expect(repeated.status).toBe(200);
  expect((await clone.json<any>()).result.id).toBe((await repeated.json<any>()).result.id);
  expect((await db.select().from(noteTypes).where(eq(noteTypes.userId, userId))).filter(row => row.name === 'My clone')).toHaveLength(1);
  await callApp(app, 'POST', '/notes', { cookie, body: { deckId: deck.id, noteTypeId: type.id, fieldValues: { Q: 'Q', A: 'A' } } });
  const patch = { templates: [type.templates[0]], expectedUpdatedAt: type.updatedAt };
  expect((await callApp(app, 'PATCH', `/ui-actions/v1/note-types/${type.id}`, { cookie, body: { ...envelope(), input: patch } })).status).toBe(409);
  const preview = await (await callApp(app, 'POST', `/note-types/${type.id}/preview`, { cookie, body: patch })).json<any>();
  const edit = { ...envelope(), input: { ...patch, confirmationToken: preview.confirmationToken } };
  expect((await callApp(app, 'PATCH', `/ui-actions/v1/note-types/${type.id}`, { cookie, body: edit })).status).toBe(200);
  expect((await callApp(app, 'PATCH', `/ui-actions/v1/note-types/${type.id}`, { cookie, body: edit })).status).toBe(200);
});

test('ten concurrent receipt transactions resolve card input without acquiring a second pool connection', async () => {
  const { userId, deck, type } = await fixture();
  await Promise.all(Array.from({ length: 10 }, (_, i) => performUiAction(userId, envelope(), 'card-note-save', { i }, async tx => {
    // Hold all pool slots before entering the shared resolver. A nested db
    // read here would wait forever for a connection owned by these callers.
    await tx.execute(sql`SELECT pg_sleep(0.05)`);
    const result = await createNoteForRequest({ user: { id: userId }, body: {
      deckId: deck.id, noteTypeId: type.id, expectedTypeUpdatedAt: type.updatedAt, fieldValues: { Q: `Q ${i}`, A: 'A' },
    } }, tx);
    if (!('note' in result)) throw new Error('unexpected validation result');
    return { result, label: 'Card', target: { kind: 'card-note', id: result.note.id,
      revision: `${result.note.updatedAt.toISOString()}_${type.updatedAt}` } };
  })));
  expect(await db.select().from(notes).where(eq(notes.userId, userId))).toHaveLength(10);
}, 10000);
