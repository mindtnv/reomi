import { beforeEach, expect, spyOn, test } from 'bun:test';
import { buildApp } from '../src/app';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers';

const app = buildApp();
beforeEach(resetTestDb);
async function fixture() {
  const { cookie } = await signUpAndCookie(app, uniqueEmail());
  const source = await (await callApp(app, 'POST', '/note-types', { cookie, body: { name: 'Source', kind: 'basic',
    fields: [{ name: 'Q', ord: 0 }, { name: 'A', ord: 1 }, { name: 'Extra', ord: 2 }], templates: [
      { name: 'Forward', ord: 0, frontTemplate: '{{Q}}', backTemplate: '{{A}}' }, { name: 'Reverse', ord: 1, frontTemplate: '{{A}}', backTemplate: '{{Q}}' }] } })).json<any>();
  const target = await (await callApp(app, 'POST', '/note-types', { cookie, body: { name: 'Target', kind: 'custom',
    fields: [{ name: 'Question', ord: 0 }, { name: 'Answer', ord: 1 }], templates: [
      { name: 'Reverse', ord: 0, frontTemplate: '{{Answer}}', backTemplate: '{{Question}}' },
      { name: 'Forward', ord: 1, frontTemplate: '{{Question}}', backTemplate: '{{Answer}}' }] } })).json<any>();
  const deck = await (await callApp(app, 'POST', '/decks', { cookie, body: { name: 'Study' } })).json<any>();
  const created = await (await callApp(app, 'POST', '/notes', { cookie, body: { noteTypeId: source.id, deckId: deck.id,
    fieldValues: { Q: 'Question?', A: '**Answer**', Extra: 'Keep this source' }, tags: ['preserved'] } })).json<any>();
  const forward = created.cards.find((card: any) => card.templateOrd === 0);
  const grade = await (await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: forward.id, rating: 4 } })).json<any>();
  const input = { noteIds: [created.note.id], sourceTypeId: source.id, targetTypeId: target.id,
    sourceVersion: source.updatedAt, targetVersion: target.updatedAt, preserveUnmappedFields: true,
    fieldMap: { Question: 'Q', Answer: 'A' }, templateMap: { [target.templates[0].id]: source.templates[1].id, [target.templates[1].id]: source.templates[0].id } };
  return { cookie, source, target, created, grade, input };
}

test('conversion maps fields and reversed template positions without transferring one question history to another', async () => {
  const { cookie, source, target, created, grade, input } = await fixture();
  expect((await callApp(app, 'POST', '/notes/convert', { cookie, body: input })).status).toBe(409);
  const response = await callApp(app, 'POST', '/notes/convert/preview', { cookie, body: input });
  expect(response.status).toBe(200);
  const preview = await response.json<any>();
  expect(preview.impact).toMatchObject({ willKeepCards: 2, willCreateCards: 0, willDeleteCards: 0, willDeleteReviews: 0 });
  expect(preview.cardMapping).toEqual([{ target: { name: 'Reverse', ord: 0 }, source: { name: 'Reverse', ord: 1 } }, { target: { name: 'Forward', ord: 1 }, source: { name: 'Forward', ord: 0 } }]);
  expect(preview.unmappedFields).toContainEqual({ field: 'Extra', action: 'preserve', nonemptyNotes: 1, example: 'Keep this source' });
  const before = await (await callApp(app, 'GET', `/cards/${grade.card.id}`, { cookie })).json<any>();
  expect(before.noteType.id).toBe(source.id);
  const result = await callApp(app, 'POST', '/notes/convert', { cookie, body: { ...input, confirmationToken: preview.confirmationToken } });
  expect(result.status).toBe(200);
  const converted = await result.json<any>();
  expect(converted.cards).toHaveLength(2);
  const forward = converted.cards.find((card: any) => card.id === grade.card.id);
  expect(forward).toMatchObject({ templateOrd: 1, due: grade.card.due, stability: grade.card.stability, reps: grade.card.reps,
    noteId: created.note.id, noteType: { id: target.id }, note: { fieldValues: { Question: 'Question?', Answer: '**Answer**', Extra: 'Keep this source' }, tags: ['preserved'] } });
  expect(await (await callApp(app, 'GET', '/reviews', { cookie })).json()).toHaveLength(1);
});

test('discarded fields and replacement histories require the exact preview; new study invalidates it', async () => {
  const { cookie, input, grade, target } = await fixture();
  const changed = { ...input, preserveUnmappedFields: false, templateMap: Object.fromEntries(target.templates.map((template: any) => [template.id, null])) };
  const preview = await (await callApp(app, 'POST', '/notes/convert/preview', { cookie, body: changed })).json<any>();
  expect(preview.discardedValues).toBe(1);
  expect(preview.impact).toMatchObject({ willCreateCards: 2, willKeepCards: 0, willDeleteCards: 2, willDeleteReviews: 1 });
  await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: grade.card.id, rating: 3 } });
  expect((await callApp(app, 'POST', '/notes/convert', { cookie, body: { ...changed, confirmationToken: preview.confirmationToken } })).status).toBe(409);
  const current = await (await callApp(app, 'POST', '/notes/convert/preview', { cookie, body: changed })).json<any>();
  const result = await (await callApp(app, 'POST', '/notes/convert', { cookie, body: { ...changed, confirmationToken: current.confirmationToken } })).json<any>();
  expect(result.cards.every((card: any) => card.reps === 0 && card.id !== grade.card.id)).toBe(true);
  expect(result.cards[0].note.fieldValues).toEqual({ Question: 'Question?', Answer: '**Answer**' });
});

test('foreign notes, mismatched versions, colliding fields and duplicate history mappings do not mutate', async () => {
  const { cookie, input, target, source, grade } = await fixture();
  const other = await signUpAndCookie(app, uniqueEmail());
  expect((await callApp(app, 'POST', '/notes/convert/preview', { cookie: other.cookie, body: input })).status).toBe(404);
  expect((await callApp(app, 'POST', '/notes/convert/preview', { cookie, body: { ...input, targetVersion: '2020-01-01T00:00:00Z' } })).status).toBe(409);
  expect((await callApp(app, 'POST', '/notes/convert/preview', { cookie, body: { ...input,
    templateMap: Object.fromEntries(target.templates.map((template: any) => [template.id, source.templates[0].id])) } })).status).toBe(400);
  const unchanged = await (await callApp(app, 'GET', `/cards/${grade.card.id}`, { cookie })).json<any>();
  expect(unchanged.noteType.id).toBe(source.id);
});

test('an invalid note blocks the whole batch, including notes that could have converted', async () => {
  const { cookie, source, created, grade, input } = await fixture();
  const target = await (await callApp(app, 'POST', '/note-types', { cookie, body: { name: 'Typed target', kind: 'typein',
    fields: [{ name: 'Question', ord: 0 }, { name: 'Answer', ord: 1 }], templates: [{ name: 'Card', ord: 0, frontTemplate: '{{Question}}', backTemplate: '{{Answer}}' }] } })).json<any>();
  const second = await (await callApp(app, 'POST', '/notes', { cookie, body: { noteTypeId: source.id,
    deckId: created.cards[0].deckId, fieldValues: { Q: 'Missing answer', A: '' } } })).json<any>();
  const body = { ...input, noteIds: [created.note.id, second.note.id], targetTypeId: target.id, targetVersion: target.updatedAt,
    templateMap: { [target.templates[0].id]: null } };
  const preview = await (await callApp(app, 'POST', '/notes/convert/preview', { cookie, body })).json<any>();
  expect(preview.validation).toMatchObject({ checkedNotes: 2, invalidNotes: 1 });
  expect((await callApp(app, 'POST', '/notes/convert', { cookie, body: { ...body, confirmationToken: preview.confirmationToken } })).status).toBe(400);
  const card = await (await callApp(app, 'GET', `/cards/${grade.card.id}`, { cookie })).json<any>();
  expect(card).toMatchObject({ noteType: { id: source.id }, reps: grade.card.reps, note: { fieldValues: created.note.fieldValues } });
});

test('type selection is scoped by identity even when names match and cannot expose foreign cards', async () => {
  const { cookie, source, target, input } = await fixture();
  await callApp(app, 'PATCH', `/note-types/${target.id}`, { cookie, body: { name: source.name } });
  const sourcePage = await (await callApp(app, 'GET', `/cards/search?noteTypeId=${source.id}`, { cookie })).json<any>();
  expect(sourcePage.items).toHaveLength(2);
  expect(sourcePage.items.every((card: any) => card.noteType.id === source.id)).toBe(true);
  const empty = await (await callApp(app, 'GET', `/cards/search?noteTypeId=${target.id}`, { cookie })).json<any>();
  expect(empty.items).toEqual([]);
  const other = await signUpAndCookie(app, uniqueEmail());
  expect((await (await callApp(app, 'GET', `/cards/search?noteTypeId=${source.id}`, { cookie: other.cookie })).json<any>()).items).toEqual([]);
  expect((await callApp(app, 'POST', '/notes/convert/preview', { cookie, body: input })).status).toBe(409); // rename changed target version
});

test('a target field cannot silently replace a preserved unmatched value', async () => {
  const { cookie, target, source, input, created } = await fixture();
  const patched = await (await callApp(app, 'PATCH', `/notes/${created.note.id}`, { cookie, body: { fieldValues: { ...created.note.fieldValues, Question: 'Hidden original value' } } })).json<any>();
  expect(patched.note.fieldValues.Question).toBe('Hidden original value');
  const conflict = await callApp(app, 'POST', '/notes/convert/preview', { cookie, body: input });
  expect(conflict.status).toBe(400); expect(await conflict.json()).toMatchObject({ error: 'conversion_field_collision' });
  const preview = await (await callApp(app, 'POST', '/notes/convert/preview', { cookie, body: { ...input, preserveUnmappedFields: false } })).json<any>();
  expect(preview.unmappedFields.find((field: any) => field.field === 'Question')).toMatchObject({ action: 'discard', example: 'Hidden original value' });
  expect(preview.discardedValues).toBe(2);
});

test('obsolete accepted alternatives are disclosed and removed when the typed answer role changes', async () => {
  const { cookie, input, source, created } = await fixture();
  await callApp(app, 'PATCH', `/notes/${created.note.id}`, { cookie, body: { acceptedAnswers: ['Old alternative'] } });
  const target = await (await callApp(app, 'POST', '/note-types', { cookie, body: { name: 'Typed target', kind: 'typein',
    fields: [{ name: 'Question', ord: 0 }, { name: 'Answer', ord: 1 }], templates: [{ name: 'Card', ord: 0, frontTemplate: '{{Question}}', backTemplate: '{{Answer}}' }] } })).json<any>();
  const body = { ...input, targetTypeId: target.id, targetVersion: target.updatedAt, templateMap: { [target.templates[0].id]: null } };
  const preview = await (await callApp(app, 'POST', '/notes/convert/preview', { cookie, body })).json<any>();
  expect(preview.discardedAlternatives).toBe(1);
  const result = await (await callApp(app, 'POST', '/notes/convert', { cookie, body: { ...body, confirmationToken: preview.confirmationToken } })).json<any>();
  expect(result.cards[0].note.acceptedAnswers).toEqual([]);
  expect(result.cards[0].note.fieldValues.Answer).toBe('**Answer**');
});

test('applying a personal copy never modifies the global source definition or unselected notes', async () => {
  const { db, noteTypes } = await import('@reomi/db'); const { eq } = await import('drizzle-orm');
  const { cookie, source, created, input } = await fixture();
  await db.update(noteTypes).set({ userId: null, isBuiltin: true }).where(eq(noteTypes.id, source.id));
  try {
    const untouched = await (await callApp(app, 'POST', '/notes', { cookie, body: { noteTypeId: source.id, deckId: created.cards[0].deckId,
      fieldValues: { Q: 'Not selected', A: 'Leave me here' } } })).json<any>();
    const readGlobal = async () => (await (await callApp(app, 'GET', '/note-types', { cookie })).json<any[]>()).find((type) => type.id === source.id);
    const before = await readGlobal();
    const preview = await (await callApp(app, 'POST', '/notes/convert/preview', { cookie, body: input })).json<any>();
    expect((await callApp(app, 'POST', '/notes/convert', { cookie, body: { ...input, confirmationToken: preview.confirmationToken } })).status).toBe(200);
    expect(await readGlobal()).toEqual(before);
    const original = await (await callApp(app, 'GET', `/cards/${untouched.cards[0].id}`, { cookie })).json<any>();
    expect(original.noteType.id).toBe(source.id);
    expect(original.note.fieldValues).toEqual(untouched.note.fieldValues);
  } finally { await db.update(noteTypes).set({ userId: source.userId, isBuiltin: false }).where(eq(noteTypes.id, source.id)); }
});

test('compatible cloze conversion preserves the history of each independent number', async () => {
  const { cookie } = await signUpAndCookie(app, uniqueEmail());
  const definition = { kind: 'cloze', fields: [{ name: 'Text', ord: 0 }, { name: 'Extra', ord: 1 }],
    templates: [{ name: 'Cloze', ord: 0, frontTemplate: '{{Text}}', backTemplate: '{{Text}} {{Extra}}' }] };
  const source = await (await callApp(app, 'POST', '/note-types', { cookie, body: { ...definition, name: 'Old cloze' } })).json<any>();
  const target = await (await callApp(app, 'POST', '/note-types', { cookie, body: { ...definition, name: 'New cloze' } })).json<any>();
  const deck = await (await callApp(app, 'POST', '/decks', { cookie, body: { name: 'Cloze deck' } })).json<any>();
  const original = await (await callApp(app, 'POST', '/notes', { cookie, body: { noteTypeId: source.id, deckId: deck.id,
    fieldValues: { Text: '{{c1::Paris}} is in {{c2::France}}.', Extra: '' } } })).json<any>();
  const second = original.cards.find((card: any) => card.clozeNumber === 2);
  const grade = await (await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: second.id, rating: 3 } })).json<any>();
  const body = { noteIds: [original.note.id], sourceTypeId: source.id, targetTypeId: target.id, sourceVersion: source.updatedAt, targetVersion: target.updatedAt,
    preserveUnmappedFields: true, fieldMap: { Text: 'Text', Extra: 'Extra' }, templateMap: { [target.templates[0].id]: source.templates[0].id } };
  const preview = await (await callApp(app, 'POST', '/notes/convert/preview', { cookie, body })).json<any>();
  expect(preview.impact).toMatchObject({ willKeepCards: 2, willCreateCards: 0, willDeleteCards: 0 });
  const result = await (await callApp(app, 'POST', '/notes/convert', { cookie, body: { ...body, confirmationToken: preview.confirmationToken } })).json<any>();
  expect(result.cards.find((card: any) => card.clozeNumber === 2)).toMatchObject({ id: second.id, due: grade.card.due, reps: 1 });
  expect(result.cards.find((card: any) => card.clozeNumber === 1)).toMatchObject({ id: original.cards.find((card: any) => card.clozeNumber === 1).id, reps: 0 });
});

test('notes with directions in different decks can place new questions explicitly without moving survivors', async () => {
  const { cookie, source, target, input, created, grade } = await fixture();
  const otherDeck = await (await callApp(app, 'POST', '/decks', { cookie, body: { name: 'Other direction' } })).json<any>();
  const reverse = created.cards.find((card: any) => card.templateOrd === 1);
  expect((await callApp(app, 'PATCH', `/cards/${reverse.id}`, { cookie, body: { deckId: otherDeck.id } })).status).toBe(200);
  const expanded = await (await callApp(app, 'PATCH', `/note-types/${target.id}`, { cookie, body: { templates: [...target.templates,
    { name: 'Extra question', ord: 2, frontTemplate: 'Extra: {{Question}}', backTemplate: '{{Answer}}' }] } })).json<any>();
  const body = { ...input, targetVersion: expanded.updatedAt, templateMap: { ...input.templateMap, [expanded.templates[2].id]: null } };
  const ambiguous = await (await callApp(app, 'POST', '/notes/convert/preview', { cookie, body })).json<any>();
  expect(ambiguous.validation.samples[0].error).toBe('conversion_deck_required');
  const explicit = { ...body, newCardsDeckId: otherDeck.id };
  const preview = await (await callApp(app, 'POST', '/notes/convert/preview', { cookie, body: explicit })).json<any>();
  expect(preview.validation.invalidNotes).toBe(0);
  expect(preview.newCardsDeckId).toBe(otherDeck.id);
  expect(preview.impact).toMatchObject({ willKeepCards: 2, willCreateCards: 1, willDeleteCards: 0 });
  expect((await callApp(app, 'POST', '/notes/convert', { cookie, body: { ...explicit, newCardsDeckId: created.cards[0].deckId, confirmationToken: preview.confirmationToken } })).status).toBe(409);
  const result = await (await callApp(app, 'POST', '/notes/convert', { cookie, body: { ...explicit, confirmationToken: preview.confirmationToken } })).json<any>();
  expect(result.cards.find((card: any) => card.templateOrd === 2)).toMatchObject({ deckId: otherDeck.id, reps: 0 });
  expect(result.cards.find((card: any) => card.id === grade.card.id)).toMatchObject({ deckId: created.cards[0].deckId, due: grade.card.due, reps: grade.card.reps });
  expect(result.cards.find((card: any) => card.id === reverse.id).deckId).toBe(otherDeck.id);
});


test('the conversion response is assembled before a concurrent type edit can change its definition', async () => {
  const { db, noteTypes } = await import('@reomi/db'); const { eq, sql } = await import('drizzle-orm');
  const enrichment = await import('../src/modules/cards');
  const { cookie, target, input, created } = await fixture();
  const preview = await (await callApp(app, 'POST', '/notes/convert/preview', { cookie, body: input })).json<any>();
  const reached = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  const original = enrichment.enrichCards;
  const spy = spyOn(enrichment, 'enrichCards').mockImplementation(async (rows, executor) => {
    if (rows.some((card) => card.noteId === created.note.id)) { reached.resolve(); await release.promise; }
    return original(rows, executor);
  });
  const converting = callApp(app, 'POST', '/notes/convert', { cookie, body: { ...input, confirmationToken: preview.confirmationToken } });
  try {
    await Promise.race([reached.promise, converting.then(() => { throw new Error('conversion did not reach enrichment'); })]);
    let code: string | undefined;
    try { await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '100ms'`);
      await tx.update(noteTypes).set({ name: 'Concurrent edit' }).where(eq(noteTypes.id, target.id));
    }); } catch (error: any) { code = error.cause?.code ?? error.code; }
    expect(code).toBe('55P03'); // The conversion still owns its definition snapshot.
    release.resolve();
    const response = await converting; expect(response.status).toBe(200);
    const result = await response.json<any>();
    expect(result.cards.every((card: any) => card.noteType.name === target.name && card.note.fieldValues.Question === 'Question?')).toBe(true);
  } finally { release.resolve(); await converting; spy.mockRestore(); }
});
