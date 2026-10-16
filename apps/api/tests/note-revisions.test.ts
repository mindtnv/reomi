import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { beforeEach, describe, expect, test } from 'bun:test';
import { cards, db, deckOptionsPreset, decks, filteredDeck, media, noteRevisions, notes, noteTypes, notificationSettings, studyDayPolicy, user as userTable } from '@reomi/db';
import { newUuidV7 } from '@reomi/shared';
import { desc, eq } from 'drizzle-orm';
import { buildApp } from '../src/app';
import { __resetMediaGcForTests, runMediaGc } from '../src/media-gc';
import { canonicalNoteDocument, NOTE_REVISION_MAX_BYTES } from '../src/modules/note-revisions';
import { applyStudySnapshot } from '../src/profile/restore-rehearsal';
import { __setObjectDeleterForTests, __setObjectListerForTests } from '../src/storage';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers';

const repoRoot = resolve(import.meta.dir, '../../..');

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

async function storedRevisions(noteId: string) {
  return db.select().from(noteRevisions).where(eq(noteRevisions.noteId, noteId))
    .orderBy(desc(noteRevisions.revisedAt), desc(noteRevisions.id));
}

function schedule(card: { due: Date; stability: number; difficulty: number; reps: number; lapses: number; state: string }) {
  return {
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
  };
}

describe('note text revisions', () => {
  test('restoring an earlier document keeps the surviving card schedule', async () => {
    const { cookie, type, created } = await fixture();
    expect(await storedRevisions(created.note.id)).toHaveLength(0);
    const cardId = created.cards[0].id as string;
    expect((await callApp(app, 'POST', '/reviews', { cookie, body: { cardId, rating: 3 } })).status).toBe(200);
    const edited = await callApp(app, 'PATCH', `/notes/${created.note.id}`, { cookie, body: {
      fieldValues: { Q: 'edited question', A: 'answer' }, expectedUpdatedAt: created.note.updatedAt,
    } });
    expect(edited.status).toBe(200);
    const editedBody = await edited.json<any>();
    const before = schedule((await db.select().from(cards).where(eq(cards.id, cardId)))[0]!);
    expect(before.reps).toBeGreaterThan(0);

    const listed = await callApp(app, 'GET', `/notes/${created.note.id}/revisions`, { cookie });
    expect(listed.status).toBe(200);
    const items = (await listed.json<any>()).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ noteTypeId: type.id, label: 'question' });
    expect(items[0].fieldValues).toBeUndefined();
    expect(Object.keys(items[0]).sort()).toEqual(['id', 'label', 'noteTypeId', 'revisedAt']);

    const restored = await callApp(app, 'POST', `/notes/${created.note.id}/revisions/${items[0].id}/restore`, { cookie, body: {
      expectedUpdatedAt: editedBody.note.updatedAt, expectedTypeUpdatedAt: type.updatedAt,
    } });
    expect(restored.status).toBe(200);
    const body = await restored.json<any>();
    expect(body.note.fieldValues).toEqual({ Q: 'question', A: 'answer' });
    const after = schedule((await db.select().from(cards).where(eq(cards.id, cardId)))[0]!);
    expect(after).toEqual(before);
    const archived = await storedRevisions(created.note.id);
    expect(archived.some((row) => row.fieldValues.Q === 'edited question')).toBe(true);
  });

  test('restoring a document that drops a question requires confirmation and then deletes that card', async () => {
    const { cookie, type, created } = await fixture();
    const forward = created.cards.find((card: { templateOrd: number }) => card.templateOrd === 0);
    expect((await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: forward.id, rating: 4 } })).status).toBe(200);
    const emptied = { fieldValues: { Q: 'sided', A: '' }, expectedUpdatedAt: created.note.updatedAt };
    const preview = await (await callApp(app, 'POST', `/notes/${created.note.id}/preview`, { cookie, body: emptied })).json<any>();
    const oneSided = await callApp(app, 'PATCH', `/notes/${created.note.id}`, { cookie, body: { ...emptied, confirmationToken: preview.confirmationToken } });
    expect(oneSided.status).toBe(200);
    const oneSidedBody = await oneSided.json<any>();
    expect(oneSidedBody.cards).toHaveLength(1);
    const refilled = await callApp(app, 'PATCH', `/notes/${created.note.id}`, { cookie, body: {
      fieldValues: { Q: 'sided', A: 'back' }, expectedUpdatedAt: oneSidedBody.note.updatedAt,
    } });
    expect(refilled.status).toBe(200);
    const current = await refilled.json<any>();
    expect(current.cards).toHaveLength(2);
    const reverse = current.cards.find((card: { templateOrd: number }) => card.templateOrd === 1);
    const before = schedule((await db.select().from(cards).where(eq(cards.id, forward.id)))[0]!);
    const history = await (await callApp(app, 'GET', `/notes/${created.note.id}/revisions`, { cookie })).json<any>();
    const sided = history.items.find((item: { label: string }) => item.label === 'sided');
    const restoreBody = { expectedUpdatedAt: current.note.updatedAt, expectedTypeUpdatedAt: type.updatedAt };
    const impact = await callApp(app, 'POST', `/notes/${created.note.id}/revisions/${sided.id}/restore`, { cookie, body: { ...restoreBody, preview: true } });
    expect(impact.status).toBe(200);
    const impactBody = await impact.json<any>();
    expect(impactBody.impact.willDeleteCards).toBe(1);
    expect((await db.select().from(cards).where(eq(cards.noteId, created.note.id)))).toHaveLength(2);

    const blocked = await callApp(app, 'POST', `/notes/${created.note.id}/revisions/${sided.id}/restore`, { cookie, body: restoreBody });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: 'card_removal_confirmation_required' });
    expect((await callApp(app, 'GET', `/cards/${reverse.id}`, { cookie })).status).toBe(200);

    const token = impactBody.confirmationToken as string;
    const restored = await callApp(app, 'POST', `/notes/${created.note.id}/revisions/${sided.id}/restore`, { cookie, body: { ...restoreBody, confirmationToken: token } });
    expect(restored.status).toBe(200);
    expect((await restored.json<any>()).cards).toHaveLength(1);
    expect((await callApp(app, 'GET', `/cards/${reverse.id}`, { cookie })).status).toBe(404);
    expect(schedule((await db.select().from(cards).where(eq(cards.id, forward.id)))[0]!)).toEqual(before);
  });

  test('a stale expectedUpdatedAt on restore is note_changed and keeps the current text', async () => {
    const { cookie, type, created } = await fixture();
    const edited = await (await callApp(app, 'PATCH', `/notes/${created.note.id}`, { cookie, body: {
      fieldValues: { Q: 'current', A: 'answer' }, expectedUpdatedAt: created.note.updatedAt,
    } })).json<any>();
    const [revision] = await storedRevisions(created.note.id);
    const stale = await callApp(app, 'POST', `/notes/${created.note.id}/revisions/${revision!.id}/restore`, { cookie, body: {
      expectedUpdatedAt: created.note.updatedAt, expectedTypeUpdatedAt: type.updatedAt,
    } });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: 'note_changed' });
    const [note] = await db.select().from(notes).where(eq(notes.id, created.note.id));
    expect(note!.fieldValues).toEqual({ Q: 'current', A: 'answer' });
    expect(note!.updatedAt.toISOString()).toBe(edited.note.updatedAt);
    expect(await storedRevisions(created.note.id)).toHaveLength(1);
  });

  test('a note type mismatch is note_type_changed and writes nothing', async () => {
    const { cookie, type, created } = await fixture();
    const edited = await (await callApp(app, 'PATCH', `/notes/${created.note.id}`, { cookie, body: {
      fieldValues: { Q: 'kept', A: 'answer' }, expectedUpdatedAt: created.note.updatedAt,
    } })).json<any>();
    const other = await (await callApp(app, 'POST', '/note-types', { cookie, body: { name: 'Other',
      fields: [{ name: 'Q', ord: 0 }, { name: 'A', ord: 1 }], templates: [
        { name: 'Forward', ord: 0, frontTemplate: '{{Q}}', backTemplate: '{{A}}' },
      ], kind: 'custom' } })).json<any>();
    await db.update(notes).set({ noteTypeId: other.id }).where(eq(notes.id, created.note.id));
    const [revision] = await storedRevisions(created.note.id);
    const missing = await callApp(app, 'POST', `/notes/${created.note.id}/revisions/00000000-0000-7000-8000-000000000099/restore`, { cookie, body: {
      expectedUpdatedAt: edited.note.updatedAt, expectedTypeUpdatedAt: type.updatedAt,
    } });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: 'revision_not_found' });

    const mismatched = await callApp(app, 'POST', `/notes/${created.note.id}/revisions/${revision!.id}/restore`, { cookie, body: {
      expectedUpdatedAt: edited.note.updatedAt, expectedTypeUpdatedAt: other.updatedAt,
    } });
    expect(mismatched.status).toBe(409);
    expect(await mismatched.json()).toMatchObject({ error: 'note_type_changed' });
    const [note] = await db.select().from(notes).where(eq(notes.id, created.note.id));
    expect(note!.noteTypeId).toBe(other.id);
    expect(note!.fieldValues).toEqual({ Q: 'kept', A: 'answer' });
    expect(note!.updatedAt.toISOString()).toBe(edited.note.updatedAt);
    expect(await storedRevisions(created.note.id)).toHaveLength(1);
  });

  test('a second identical save does not add a revision', async () => {
    const { cookie, created } = await fixture();
    const first = await (await callApp(app, 'PATCH', `/notes/${created.note.id}`, { cookie, body: {
      fieldValues: { Q: 'same', A: 'answer' }, expectedUpdatedAt: created.note.updatedAt,
    } })).json<any>();
    expect(await storedRevisions(created.note.id)).toHaveLength(1);
    const second = await callApp(app, 'PATCH', `/notes/${created.note.id}`, { cookie, body: {
      fieldValues: { Q: 'same', A: 'answer' }, expectedUpdatedAt: first.note.updatedAt,
    } });
    expect(second.status).toBe(200);
    expect((await second.json<any>()).note.fieldValues.Q).toBe('same');
    expect(await storedRevisions(created.note.id)).toHaveLength(1);
  });

  test('the sixth distinct save drops the oldest revision for that note', async () => {
    const { cookie, created } = await fixture();
    let version = created.note.updatedAt as string;
    for (let i = 1; i <= 6; i++) {
      const saved = await callApp(app, 'PATCH', `/notes/${created.note.id}`, { cookie, body: {
        fieldValues: { Q: `v${i}`, A: 'answer' }, expectedUpdatedAt: version,
      } });
      expect(saved.status).toBe(200);
      version = (await saved.json<any>()).note.updatedAt;
    }
    const rows = await storedRevisions(created.note.id);
    expect(rows).toHaveLength(5);
    expect(rows.map((row) => row.fieldValues.Q)).toEqual(['v5', 'v4', 'v3', 'v2', 'v1']);
    const listed = await (await callApp(app, 'GET', `/notes/${created.note.id}/revisions`, { cookie })).json<any>();
    expect(listed.items.map((item: { label: string }) => item.label)).toEqual(['v5', 'v4', 'v3', 'v2', 'v1']);
  });

  test('a pre-image over 262144 bytes saves and adds no revision', async () => {
    const { cookie, deck } = await fixture();
    const type = await (await callApp(app, 'POST', '/note-types', { cookie, body: { name: 'Wide',
      fields: ['A', 'B', 'C', 'D'].map((name, ord) => ({ name, ord })),
      templates: [{ name: 'Only', ord: 0, frontTemplate: '{{A}}', backTemplate: '{{B}}' }],
      kind: 'custom' } })).json<any>();
    const huge = 'x'.repeat(65536);
    const fieldValues = { A: huge, B: huge, C: huge, D: huge };
    expect(Buffer.byteLength(canonicalNoteDocument({
      acceptedAnswers: [], fieldValues, noteTypeId: type.id, tags: [],
    }), 'utf8')).toBeGreaterThan(NOTE_REVISION_MAX_BYTES);
    const created = await (await callApp(app, 'POST', '/notes', { cookie, body: {
      noteTypeId: type.id, deckId: deck.id, fieldValues,
    } })).json<any>();
    const saved = await callApp(app, 'PATCH', `/notes/${created.note.id}`, { cookie, body: {
      fieldValues: { ...fieldValues, A: 'tiny' }, expectedUpdatedAt: created.note.updatedAt,
    } });
    expect(saved.status).toBe(200);
    expect((await saved.json<any>()).note.fieldValues.A).toBe('tiny');
    expect(await storedRevisions(created.note.id)).toHaveLength(0);
  });

  test('bulk tag changes record the previous tags and leave the card schedule and render cache', async () => {
    const { cookie, type, created } = await fixture();
    const cardId = created.cards[0].id as string;
    expect((await callApp(app, 'POST', '/reviews', { cookie, body: { cardId, rating: 3 } })).status).toBe(200);
    const before = (await db.select().from(cards).where(eq(cards.noteId, created.note.id))).map(cardCache)
      .sort((left, right) => left.id < right.id ? -1 : 1);
    const added = await callApp(app, 'POST', '/cards/bulk', { cookie, body: {
      action: 'addTag', cardIds: created.cards.map((card: { id: string }) => card.id), payload: { tag: 'biology' },
    } });
    expect(added.status).toBe(200);
    expect((await added.json<any>()).updated).toBe(1);
    expect((await storedRevisions(created.note.id)).map((row) => row.tags)).toEqual([[]]);
    const again = await callApp(app, 'POST', '/cards/bulk', { cookie, body: {
      action: 'addTag', cardIds: [cardId], payload: { tag: 'biology' },
    } });
    expect(again.status).toBe(200);
    expect((await again.json<any>()).updated).toBe(0);
    expect(await storedRevisions(created.note.id)).toHaveLength(1);
    const removed = await callApp(app, 'POST', '/cards/bulk', { cookie, body: {
      action: 'removeTag', cardIds: [cardId], payload: { tag: 'biology' },
    } });
    expect(removed.status).toBe(200);
    const history = await storedRevisions(created.note.id);
    expect(history.map((row) => row.tags)).toEqual([['biology'], []]);
    const afterBulk = (await db.select().from(cards).where(eq(cards.noteId, created.note.id))).map(cardCache)
      .sort((left, right) => left.id < right.id ? -1 : 1);
    expect(afterBulk).toEqual(before);

    const [note] = await db.select().from(notes).where(eq(notes.id, created.note.id));
    const tagged = history.find((row) => row.tags[0] === 'biology')!;
    const restored = await callApp(app, 'POST', `/notes/${created.note.id}/revisions/${tagged.id}/restore`, { cookie, body: {
      expectedUpdatedAt: note!.updatedAt.toISOString(), expectedTypeUpdatedAt: type.updatedAt,
    } });
    expect(restored.status).toBe(200);
    expect((await restored.json<any>()).note.tags).toEqual(['biology']);
    const after = (await db.select().from(cards).where(eq(cards.id, cardId)))[0]!;
    const graded = before.find((card) => card.id === cardId)!;
    expect(schedule(after)).toEqual({
      due: graded.due, stability: graded.stability, difficulty: graded.difficulty,
      reps: graded.reps, lapses: graded.lapses, state: graded.state,
    });
  });

  test('renaming a field records the previous field values', async () => {
    const { cookie, type, created } = await fixture();
    const renamed = await callApp(app, 'PATCH', `/note-types/${type.id}`, { cookie, body: {
      fields: type.fields.map((field: { name: string }) => field.name === 'Q' ? { ...field, name: 'Question' } : field),
    } });
    expect(renamed.status).toBe(200);
    const renamedType = await renamed.json<any>();
    const rows = await storedRevisions(created.note.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fieldValues).toEqual({ Q: 'question', A: 'answer' });
    expect(rows[0]!.noteTypeId).toBe(type.id);
    const card = await (await callApp(app, 'GET', `/cards/${created.cards[0].id}`, { cookie })).json<any>();
    expect(card.note.fieldValues).toEqual({ Question: 'question', A: 'answer' });
    const [saved] = await db.select().from(notes).where(eq(notes.id, created.note.id));
    const restore = await callApp(app, 'POST', `/notes/${created.note.id}/revisions/${rows[0]!.id}/restore`, { cookie, body: {
      expectedUpdatedAt: saved!.updatedAt.toISOString(), expectedTypeUpdatedAt: renamedType.updatedAt,
    } });
    expect(restore.status).toBe(409);
    expect(await restore.json()).toMatchObject({ error: 'note_type_changed' });
    expect((await db.select().from(notes).where(eq(notes.id, created.note.id)))[0]!.fieldValues).toEqual({ Question: 'question', A: 'answer' });
    expect(await storedRevisions(created.note.id)).toHaveLength(1);
  });

  test('converting a note records the previous field document', async () => {
    const { cookie, type, created } = await fixture();
    const target = await (await callApp(app, 'POST', '/note-types', { cookie, body: { name: 'Target', kind: 'custom',
      fields: [{ name: 'Question', ord: 0 }, { name: 'Answer', ord: 1 }],
      templates: [{ name: 'Forward', ord: 0, frontTemplate: '{{Question}}', backTemplate: '{{Answer}}' }],
    } })).json<any>();
    const input = {
      noteIds: [created.note.id], sourceTypeId: type.id, targetTypeId: target.id,
      sourceVersion: type.updatedAt, targetVersion: target.updatedAt, preserveUnmappedFields: true,
      fieldMap: { Question: 'Q', Answer: 'A' },
      templateMap: { [target.templates[0].id]: type.templates[0].id },
    };
    const preview = await (await callApp(app, 'POST', '/notes/convert/preview', { cookie, body: input })).json<any>();
    const converted = await callApp(app, 'POST', '/notes/convert', { cookie, body: { ...input, confirmationToken: preview.confirmationToken } });
    expect(converted.status).toBe(200);
    const [row] = await storedRevisions(created.note.id);
    expect(row).toMatchObject({
      fieldValues: { Q: 'question', A: 'answer' }, noteTypeId: type.id, tags: [], acceptedAnswers: [],
    });
    expect((await converted.json<any>()).cards[0].note.fieldValues).toEqual({ Question: 'question', Answer: 'answer' });
  });

  test('export schema version 2 keeps revisions, version 1 applies without them, and a broken revision file is rejected', async () => {
    const { cookie, userId, created } = await fixture();
    const edited = await (await callApp(app, 'PATCH', `/notes/${created.note.id}`, { cookie, body: {
      fieldValues: { Q: 'current', A: 'answer' }, expectedUpdatedAt: created.note.updatedAt,
    } })).json<any>();
    const exported = await callApp(app, 'GET', '/profile/export', { cookie });
    expect(exported.status).toBe(200);
    const snapshot = JSON.parse(await exported.text());
    expect(snapshot.schemaVersion).toBe(2);
    expect(snapshot.noteRevisions).toHaveLength(1);
    expect(snapshot.noteRevisions[0]).toMatchObject({
      noteId: created.note.id, fieldValues: { Q: 'question', A: 'answer' }, tags: [],
    });
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeGreaterThan(Buffer.byteLength(JSON.stringify({ ...snapshot, noteRevisions: [] })));

    const base = snapshot.noteRevisions[0];
    const six = structuredClone(snapshot);
    six.noteRevisions = Array.from({ length: 6 }, (_, index) => ({
      ...base, id: newUuidV7(), revisedAt: new Date(Date.UTC(2020, 0, 1, 0, 0, index)).toISOString(),
    }));
    const huge = 'x'.repeat(65536);
    const oversize = structuredClone(snapshot);
    oversize.noteRevisions = [{ ...base, fieldValues: { A: huge, B: huge, C: huge, D: huge } }];
    const missing = structuredClone(snapshot);
    missing.noteRevisions = [{ ...base, noteId: newUuidV7() }];
    const duplicate = structuredClone(snapshot);
    duplicate.noteRevisions = [base, { ...base, id: newUuidV7() }];
    const crowded = structuredClone(snapshot);
    crowded.noteRevisions = [];
    for (let noteIndex = 0; noteIndex < 201; noteIndex++) {
      const noteId = newUuidV7();
      crowded.notes.push({ ...crowded.notes[0], id: noteId });
      const count = noteIndex < 200 ? 5 : 1;
      for (let revision = 0; revision < count; revision++) {
        crowded.noteRevisions.push({
          ...base, id: newUuidV7(), noteId,
          revisedAt: new Date(Date.UTC(2021, 0, 1, 0, noteIndex, revision)).toISOString(),
        });
      }
    }
    expect(crowded.noteRevisions).toHaveLength(1001);
    for (const file of [six, oversize, missing, duplicate, crowded]) {
      expect(await applyStudySnapshot(file)).toEqual({ ok: false, error: 'incoherent_snapshot' });
    }
    expect((await db.select().from(notes).where(eq(notes.id, created.note.id)))[0]!.fieldValues).toEqual({ Q: 'current', A: 'answer' });

    const versionOne = structuredClone(snapshot);
    versionOne.schemaVersion = 1;
    await emptyStudy(userId);
    expect((await applyStudySnapshot(versionOne)).ok).toBe(true);
    expect(await storedRevisions(created.note.id)).toHaveLength(0);
    expect((await db.select().from(notes).where(eq(notes.id, created.note.id)))[0]!.fieldValues.Q).toBe('current');

    await emptyStudy(userId);
    expect((await applyStudySnapshot(snapshot)).ok).toBe(true);
    expect((await storedRevisions(created.note.id))[0]!.fieldValues).toEqual({ Q: 'question', A: 'answer' });
    expect(edited.note.fieldValues.Q).toBe('current');
  });

  test('DELETE /profile removes note revisions', async () => {
    const { cookie, userId, created } = await fixture();
    expect((await callApp(app, 'PATCH', `/notes/${created.note.id}`, { cookie, body: {
      fieldValues: { Q: 'gone', A: 'answer' }, expectedUpdatedAt: created.note.updatedAt,
    } })).status).toBe(200);
    expect(await storedRevisions(created.note.id)).toHaveLength(1);
    const [account] = await db.select({ email: userTable.email }).from(userTable).where(eq(userTable.id, userId));
    const deleted = await callApp(app, 'DELETE', '/profile', { cookie, body: { confirmEmail: account!.email } });
    expect(deleted.status).toBe(200);
    expect(await storedRevisions(created.note.id)).toHaveLength(0);
  });

  test('an image that exists only in a pre-image stays referenced and is not collected', async () => {
    const { cookie, userId, created } = await fixture();
    const image = newUuidV7();
    const orphan = newUuidV7();
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await db.insert(media).values([
      { id: image, userId, s3Key: `media/${image}`, mime: 'image/png', size: 8, verified: true, createdAt: old },
      { id: orphan, userId, s3Key: `media/${orphan}`, mime: 'image/png', size: 8, verified: true, createdAt: old },
    ]);
    const withImage = await (await callApp(app, 'PATCH', `/notes/${created.note.id}`, { cookie, body: {
      fieldValues: { Q: `see ![](/m/${image})`, A: 'answer' }, expectedUpdatedAt: created.note.updatedAt,
    } })).json<any>();
    const cleared = await callApp(app, 'PATCH', `/notes/${created.note.id}`, { cookie, body: {
      fieldValues: { Q: 'plain', A: 'answer' }, expectedUpdatedAt: withImage.note.updatedAt,
    } });
    expect(cleared.status).toBe(200);
    const exported = JSON.parse(await (await callApp(app, 'GET', '/profile/export', { cookie })).text());
    expect(exported.notes[0].fieldValues.Q).toBe('plain');
    expect(exported.media.find((row: { id: string }) => row.id === image).referenced).toBe(true);
    expect(exported.media.find((row: { id: string }) => row.id === orphan).referenced).toBe(false);
    expect(exported.noteRevisions.some((row: { fieldValues: { Q: string } }) => row.fieldValues.Q.includes(image))).toBe(true);

    __resetMediaGcForTests();
    __setObjectDeleterForTests(async () => {});
    __setObjectListerForTests(async () => ({ items: [] }));
    try {
      const report = await runMediaGc({ now: new Date(), pendingMaxAgeMs: 60_000, unreferencedMaxAgeMs: 60_000, batch: 20 });
      expect(report.unreferencedMedia).toBe(1);
      const left = (await db.select({ id: media.id }).from(media)).map((row) => row.id);
      expect(left).toContain(image);
      expect(left).not.toContain(orphan);
    } finally {
      __setObjectDeleterForTests(null);
      __setObjectListerForTests(null);
      __resetMediaGcForTests();
    }
  });

  test('another account gets 404 for list, preview, and restore and the owner text stays', async () => {
    const { cookie, type, created } = await fixture();
    const secret = 'owner-only-question-text';
    const edited = await (await callApp(app, 'PATCH', `/notes/${created.note.id}`, { cookie, body: {
      fieldValues: { Q: secret, A: 'answer' }, expectedUpdatedAt: created.note.updatedAt,
    } })).json<any>();
    const [revision] = await storedRevisions(created.note.id);
    const other = await signUpAndCookie(app, uniqueEmail());
    const stamp = { expectedUpdatedAt: edited.note.updatedAt, expectedTypeUpdatedAt: type.updatedAt };

    const listed = await callApp(app, 'GET', `/notes/${created.note.id}/revisions`, { cookie: other.cookie });
    expect(listed.status).toBe(404);
    expect(await listed.json()).toEqual({ error: 'not_found' });

    const preview = await callApp(app, 'POST', `/notes/${created.note.id}/revisions/${revision!.id}/restore`, {
      cookie: other.cookie, body: { ...stamp, preview: true },
    });
    expect(preview.status).toBe(404);
    const previewBody = await preview.json();
    expect(previewBody).toEqual({ error: 'not_found' });
    expect(JSON.stringify(previewBody)).not.toContain(secret);
    expect(JSON.stringify(previewBody)).not.toContain('question');

    const restored = await callApp(app, 'POST', `/notes/${created.note.id}/revisions/${revision!.id}/restore`, {
      cookie: other.cookie, body: stamp,
    });
    expect(restored.status).toBe(404);
    expect(await restored.json()).toEqual({ error: 'not_found' });

    const ownerList = await callApp(app, 'GET', `/notes/${created.note.id}/revisions`, { cookie });
    expect(ownerList.status).toBe(200);
    const [note] = await db.select().from(notes).where(eq(notes.id, created.note.id));
    expect(note!.fieldValues).toEqual({ Q: secret, A: 'answer' });
    expect(await storedRevisions(created.note.id)).toHaveLength(1);
  });

  test('only the revision module assigns note field values or tags', () => {
    const offenders = productionSources().flatMap((file) => {
      const text = stripComments(readFileSync(file, 'utf8'));
      const relativePath = relative(repoRoot, file);
      const problems: string[] = [];
      if (relativePath !== 'apps/api/src/modules/note-revisions.ts' && assignsNoteDocument(text)) problems.push(`${relativePath} assigns note fields or tags`);
      const allowed = relativePath === 'apps/api/src/modules/note-revisions.ts' || relativePath === 'packages/db/src/schema/app.ts';
      if (!allowed && /\bnoteRevisions\b/.test(text)) problems.push(`${relativePath} queries noteRevisions`);
      return problems;
    });
    expect(offenders).toEqual([]);
  });
});

async function emptyStudy(userId: string) {
  await db.delete(notes).where(eq(notes.userId, userId));
  await db.delete(decks).where(eq(decks.userId, userId));
  await db.delete(filteredDeck).where(eq(filteredDeck.userId, userId));
  await db.delete(deckOptionsPreset).where(eq(deckOptionsPreset.userId, userId));
  await db.delete(media).where(eq(media.userId, userId));
  await db.delete(noteTypes).where(eq(noteTypes.userId, userId));
  await db.delete(notificationSettings).where(eq(notificationSettings.userId, userId));
  await db.delete(studyDayPolicy).where(eq(studyDayPolicy.userId, userId));
}

function cardCache(card: typeof cards.$inferSelect) {
  return {
    id: card.id,
    due: card.due.toISOString(),
    stability: card.stability,
    difficulty: card.difficulty,
    reps: card.reps,
    lapses: card.lapses,
    state: card.state,
    renderText: card.renderText,
    renderFrontText: card.renderFrontText,
    renderBackText: card.renderBackText,
    updatedAt: card.updatedAt.toISOString(),
  };
}

function productionSources(): string[] {
  const roots = ['apps/api/src', 'apps/web/src', 'packages/db/src', 'packages/shared/src', 'packages/auth/src'];
  const files: string[] = [];
  for (const root of roots) {
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) files.push(path);
      }
    };
    walk(resolve(repoRoot, root));
  }
  return files;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function assignsNoteDocument(source: string): boolean {
  let from = 0;
  while (from < source.length) {
    const at = source.indexOf('update(notes)', from);
    if (at < 0) return false;
    const setAt = source.indexOf('.set(', at);
    if (setAt >= 0 && setAt - at < 400) {
      const arg = balanced(source, setAt + 4);
      if (/\b(?:fieldValues|tags)\b/.test(arg)) return true;
    }
    from = at + 'update(notes)'.length;
  }
  return false;
}

function balanced(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')') {
      depth--;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return source.slice(open);
}
