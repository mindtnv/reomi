// R2-036: every note-tag write stores one list.
// Commas split, NFC, trim, collapsed whitespace, C0/DEL stripped, case kept,
// exact dedupe, 128 characters, 100 tags. Over-limit is a 400. A write that
// omits tags leaves case-different stored tags in place.

import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { cards, db, deckOptionsPreset, decks, filteredDeck, media, noteTypes, notes, notificationSettings, studyDayPolicy } from '@reomi/db';
import { newUuidV7 } from '@reomi/shared';
import { buildToolRegistry, type ToolContext } from '../src/ai/tools.ts';
import { rootLogger } from '../src/logger.ts';
import { buildApp } from '../src/app.ts';
import { applyStudySnapshot } from '../src/profile/restore-rehearsal.ts';
import type { StudySnapshot } from '../src/profile/study-snapshot.ts';
import { callApp, resetTestDb, seedBasicCard, seedNote, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();
const NFC_CAFE = 'caf\u00e9';
const MESSY = ['  Grammar ', 'grammar', 'Grammar', 'a, b', '', '  ', 'hello   world', NFC_CAFE, 'cafe\u0301'];
const CANONICAL = ['Grammar', 'grammar', 'a', 'b', 'hello world', NFC_CAFE];

async function freshDeck(cookie: string): Promise<string> {
  const res = await callApp(app, 'POST', '/decks', { cookie, body: { name: 'Tags' } });
  expect(res.status).toBe(200);
  return (await res.json<{ id: string }>()).id;
}

async function noteTags(cookie: string, noteId: string): Promise<string[]> {
  const res = await callApp(app, 'GET', `/notes/${noteId}`, { cookie });
  expect(res.status).toBe(200);
  return (await res.json<{ note: { tags: string[] } }>()).note.tags;
}

async function createNote(cookie: string, deckId: string, tags: string[], front = 'Question') {
  const typeId = await (await callApp(app, 'POST', '/note-types', {
    cookie,
    body: {
      name: 'Basic',
      kind: 'basic',
      fields: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }],
      templates: [{ name: 'Card 1', ord: 0, frontTemplate: '{{Front}}', backTemplate: '{{Front}}<hr>{{Back}}' }],
    },
  })).json<{ id: string }>();
  const res = await callApp(app, 'POST', '/notes', {
    cookie,
    body: { noteTypeId: typeId.id, deckId, fieldValues: { Front: front, Back: 'Answer' }, tags },
  });
  return { res, noteTypeId: typeId.id };
}

describe('note tag writes', () => {
  beforeEach(() => resetTestDb());

  test('POST /notes stores the canonical list', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail('tags'));
    const deckId = await freshDeck(cookie);
    const created = await createNote(cookie, deckId, MESSY);
    expect(created.res.status).toBe(200);
    const note = await created.res.json<{ note: { id: string; tags: string[] } }>();
    expect(note.note.tags).toEqual(CANONICAL);
  });

  test('a tag longer than 128 characters is tag_too_long', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail('tags-limits'));
    const deckId = await freshDeck(cookie);
    const tooLong = await createNote(cookie, deckId, ['a'.repeat(129)], 'long');
    expect(tooLong.res.status).toBe(400);
    expect(await tooLong.res.json<{ error: string }>()).toEqual({ error: 'tag_too_long' });

  });

  test('more than 100 tags is too_many_tags', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail('tags-count'));
    const deckId = await freshDeck(cookie);
    const tooMany = await createNote(cookie, deckId, Array.from({ length: 101 }, (_, i) => `t${i}`), 'many');
    expect(tooMany.res.status).toBe(400);
    expect(await tooMany.res.json<{ error: string }>()).toEqual({ error: 'too_many_tags' });
  });

  test('a NUL byte in a tag is stripped before insert', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail('tags-nul'));
    const deckId = await freshDeck(cookie);
    const nul = await createNote(cookie, deckId, ['gram\u0000mar'], 'nul');
    expect(nul.res.status).toBe(200);
    expect((await nul.res.json<{ note: { tags: string[] } }>()).note.tags).toEqual(['grammar']);
  });

  test('PATCH /notes replaces tags with the canonical list', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail('tags-patch'));
    const deckId = await freshDeck(cookie);
    const seeded = await seedNote(app, cookie, { deckId, fields: { Front: 'Question', Back: 'Answer' }, tags: ['keep'] });
    const res = await callApp(app, 'PATCH', `/notes/${seeded.note.id}`, { cookie, body: { tags: MESSY } });
    expect(res.status).toBe(200);
    expect(await noteTags(cookie, seeded.note.id)).toEqual(CANONICAL);
  });

  test('a repeated versioned create with different whitespace is the same operation', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail('tags-op'));
    const deckId = await freshDeck(cookie);
    const noteTypeId = (await createNote(cookie, deckId, ['seed'], 'unused')).noteTypeId;
    const operationId = newUuidV7();
    const body = { noteTypeId, deckId, fieldValues: { Front: 'Versioned', Back: 'Answer' }, tags: MESSY };
    const first = await callApp(app, 'POST', `/notes/operations/${operationId}`, { cookie, body });
    expect(first.status).toBe(200);
    const created = await first.json<{ note: { id: string; tags: string[] }; replayed: boolean }>();
    expect(created.replayed).toBe(false);
    expect(created.note.tags).toEqual(CANONICAL);

    const second = await callApp(app, 'POST', `/notes/operations/${operationId}`, {
      cookie,
      body: { ...body, tags: ['Grammar', ' grammar', 'a,b', 'hello world', NFC_CAFE] },
    });
    expect(second.status).toBe(200);
    const replay = await second.json<{ note: { id: string; tags: string[] }; replayed: boolean }>();
    expect(replay).toMatchObject({ replayed: true, note: { id: created.note.id, tags: CANONICAL } });
  });

  test('bulk add and remove use the same tag rules', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail('tags-bulk'));
    const deckId = await freshDeck(cookie);
    const grammar = await seedBasicCard(app, cookie, { deckId, front: 'grammar', tags: ['Grammar'] });
    const both = await seedBasicCard(app, cookie, { deckId, front: 'both', tags: ['Grammar', 'grammar'] });
    const empty = await seedBasicCard(app, cookie, { deckId, front: 'empty', tags: [] });

    const padded = await callApp(app, 'POST', '/cards/bulk', {
      cookie, body: { action: 'addTag', cardIds: [grammar.id], payload: { tag: '  Grammar ' } },
    });
    expect(padded.status).toBe(200);
    expect(await padded.json<{ updated: number }>()).toEqual({ updated: 0 });
    expect(await noteTags(cookie, grammar.noteId)).toEqual(['Grammar']);

    const lower = await callApp(app, 'POST', '/cards/bulk', {
      cookie, body: { action: 'addTag', cardIds: [grammar.id], payload: { tag: 'grammar' } },
    });
    expect(lower.status).toBe(200);
    expect(await noteTags(cookie, grammar.noteId)).toEqual(['Grammar', 'grammar']);

    const split = await callApp(app, 'POST', '/cards/bulk', {
      cookie, body: { action: 'addTag', cardIds: [empty.id], payload: { tag: 'a, b' } },
    });
    expect(split.status).toBe(200);
    expect(await noteTags(cookie, empty.noteId)).toEqual(['a', 'b']);

    const removed = await callApp(app, 'POST', '/cards/bulk', {
      cookie, body: { action: 'removeTag', cardIds: [both.id], payload: { tag: '  Grammar ' } },
    });
    expect(removed.status).toBe(200);
    expect(await noteTags(cookie, both.noteId)).toEqual(['grammar']);

    const blank = await callApp(app, 'POST', '/cards/bulk', {
      cookie, body: { action: 'addTag', cardIds: [empty.id], payload: { tag: '   ' } },
    });
    expect(blank.status).toBe(400);
    expect(await blank.json<{ error: string }>()).toEqual({ error: 'tag_required' });

    const tooLong = await callApp(app, 'POST', '/cards/bulk', {
      cookie, body: { action: 'addTag', cardIds: [empty.id], payload: { tag: 'a'.repeat(129) } },
    });
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json<{ error: string }>()).toEqual({ error: 'tag_too_long' });
  });

  test('create_card and edit_card, including MCP confirm, store the canonical list', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail('tags-ai'));
    const deckId = await freshDeck(cookie);
    const seeded = await seedNote(app, cookie, { deckId, fields: { Front: 'Existing', Back: 'Answer' }, tags: ['keep'] });
    const ctx: ToolContext = { userId, log: rootLogger };
    const registry = buildToolRegistry();
    const create = registry.find((tool) => tool.name === 'create_card')!;
    const edit = registry.find((tool) => tool.name === 'edit_card')!;

    const created = await create.execute(ctx, {
      deckId,
      noteTypeId: seeded.note.noteTypeId,
      fieldValues: { Front: 'From the tool', Back: 'Answer' },
      tags: MESSY,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const [toolNote] = await db.select({ tags: notes.tags }).from(notes)
      .innerJoin(cards, eq(cards.noteId, notes.id))
      .where(eq(cards.id, created.cardIds![0]!));
    expect(toolNote?.tags).toEqual(CANONICAL);

    const edited = await edit.execute(ctx, { noteId: seeded.note.id, tags: MESSY });
    expect(edited.ok).toBe(true);
    expect(await noteTags(cookie, seeded.note.id)).toEqual(CANONICAL);
  });

  test('a field-only edit keeps tags that differ only by case', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail('tags-case'));
    const deckId = await freshDeck(cookie);
    const card = await seedBasicCard(app, cookie, { deckId, front: 'Case', tags: [] });
    await db.update(notes).set({ tags: ['Tag', 'tag'] }).where(eq(notes.id, card.noteId));
    const res = await callApp(app, 'PATCH', `/notes/${card.noteId}`, {
      cookie, body: { fieldValues: { Front: 'Case edited', Back: '' } },
    });
    expect(res.status).toBe(200);
    expect(await noteTags(cookie, card.noteId)).toEqual(['Tag', 'tag']);
  });

  test('snapshot import stores the canonical list and rejects an over-long tag', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail('tags-import'));
    const deckId = await freshDeck(cookie);
    const card = await seedBasicCard(app, cookie, { deckId, front: 'Imported', back: 'Answer', tags: ['keep'] });
    const snapshot = JSON.parse(await (await callApp(app, 'GET', '/profile/export', { cookie })).text()) as StudySnapshot;
    const note = snapshot.notes.find((row) => row.id === card.noteId);
    expect(note).toBeDefined();
    note!.tags = [...MESSY];

    await db.delete(notes).where(eq(notes.userId, userId));
    await db.delete(decks).where(eq(decks.userId, userId));
    await db.delete(filteredDeck).where(eq(filteredDeck.userId, userId));
    await db.delete(deckOptionsPreset).where(eq(deckOptionsPreset.userId, userId));
    await db.delete(media).where(eq(media.userId, userId));
    await db.delete(noteTypes).where(eq(noteTypes.userId, userId));
    await db.delete(notificationSettings).where(eq(notificationSettings.userId, userId));
    await db.delete(studyDayPolicy).where(eq(studyDayPolicy.userId, userId));

    const restored = await applyStudySnapshot(snapshot);
    expect(restored.ok).toBe(true);
    expect(await noteTags(cookie, card.noteId)).toEqual(CANONICAL);

    const oversized = structuredClone(snapshot);
    oversized.notes.find((row) => row.id === card.noteId)!.tags = ['a'.repeat(129)];
    await db.delete(notes).where(eq(notes.userId, userId));
    await db.delete(decks).where(eq(decks.userId, userId));
    await db.delete(filteredDeck).where(eq(filteredDeck.userId, userId));
    await db.delete(deckOptionsPreset).where(eq(deckOptionsPreset.userId, userId));
    await db.delete(media).where(eq(media.userId, userId));
    await db.delete(noteTypes).where(eq(noteTypes.userId, userId));
    await db.delete(notificationSettings).where(eq(notificationSettings.userId, userId));
    await db.delete(studyDayPolicy).where(eq(studyDayPolicy.userId, userId));
    const rejected = await applyStudySnapshot(oversized);
    expect(rejected).toEqual({ ok: false, error: 'tag_too_long' });
    expect(await db.select({ id: notes.id }).from(notes).where(eq(notes.userId, userId))).toEqual([]);
  });
});
