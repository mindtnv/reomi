// Notes CRUD + generation integration tests (Milestone 1, Phase 4).
//
// Covers: POST → card generation (count, render cols, FSRS init, sanitization),
// PATCH → regeneration that PRESERVES FSRS on surviving templateOrds while
// inserting/deleting changed ords, DELETE → cascade, and ownership scoping.

import { beforeEach, describe, expect, test } from 'bun:test';
import { buildApp } from '../src/app.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';
import { db, cards } from '@reomi/db';
import { eq, sql } from 'drizzle-orm';
import { rebuildCardTextBatch } from '../src/ai/rebuild-card-text';

const app = buildApp();

async function freshDeck(cookie: string, name = 'D'): Promise<string> {
  return (
    await (await callApp(app, 'POST', '/decks', { cookie, body: { name } })).json<{ id: string }>()
  ).id;
}

/** A two-template note-type: Card 1 always renders, Card 2 only when Extra set. */
async function twoTemplateType(cookie: string): Promise<string> {
  const res = await callApp(app, 'POST', '/note-types', {
    cookie,
    body: {
      name: 'Front/Back+Reverse',
      kind: 'custom',
      fields: [
        { name: 'Front', ord: 0 },
        { name: 'Back', ord: 1 },
      ],
      templates: [
        { name: 'Card 1', ord: 0, frontTemplate: '{{Front}}', backTemplate: '{{Back}}' },
        // reverse card only generates when Back is non-empty (empty-front skip).
        { name: 'Card 2', ord: 1, frontTemplate: '{{Back}}', backTemplate: '{{Front}}' },
      ],
    },
  });
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
  return (await res.json<{ id: string }>()).id;
}

describe('notes', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('POST generates one card per non-empty template with render cols + FSRS init', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const noteTypeId = await twoTemplateType(cookie);

    const res = await callApp(app, 'POST', '/notes', {
      cookie,
      body: { noteTypeId, fieldValues: { Front: 'Hund', Back: 'dog' }, deckId, tags: ['a1'] },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{
      note: { id: string; fieldValues: Record<string, string>; tags: string[] };
      cards: Array<{
        templateOrd: number;
        renderFrontText: string;
        renderBackText: string;
        renderText: string;
        renderKind: string;
        deckId: string;
        state: string;
        reps: number;
        lapses: number;
      }>;
    }>();

    // both templates render (Front + Back both non-empty).
    expect(body.cards.length).toBe(2);
    const c0 = body.cards.find((c) => c.templateOrd === 0)!;
    const c1 = body.cards.find((c) => c.templateOrd === 1)!;
    expect(c0.renderFrontText).toBe('Hund');
    expect(c0.renderBackText).toBe('dog');
    expect(c1.renderFrontText).toBe('dog'); // reverse
    expect(c1.renderBackText).toBe('Hund');
    // render cols + FSRS init
    expect(c0.renderText).toContain('Hund');
    expect(c0.renderKind).toBe('custom');
    expect(c0.deckId).toBe(deckId);
    expect(c0.state).toBe('new');
    expect(c0.reps).toBe(0);
    expect(c0.lapses).toBe(0);
    // note carries tags + field values
    expect(body.note.tags).toEqual(['a1']);
    expect(body.note.fieldValues).toEqual({ Front: 'Hund', Back: 'dog' });
  });

  test('POST skips a template whose rendered front is empty (optional reverse)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const noteTypeId = await twoTemplateType(cookie);

    // Back empty → Card 2 (front = {{Back}}) renders empty → skipped.
    const res = await callApp(app, 'POST', '/notes', {
      cookie,
      body: { noteTypeId, fieldValues: { Front: 'Hund', Back: '' }, deckId },
    });
    const body = await res.json<{ cards: Array<{ templateOrd: number }> }>();
    expect(body.cards.length).toBe(1);
    expect(body.cards[0]!.templateOrd).toBe(0);
  });

  test('POST rejects content that generates no cards instead of saving an invisible note', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const noteTypeId = await basicType(cookie);
    const result = await callApp(app, 'POST', '/notes', {
      cookie, body: { deckId, noteTypeId, fieldValues: { Front: ' \n\t ', Back: '' } },
    });
    expect(result.status).toBe(400);
    expect(await result.json()).toMatchObject({ error: 'no_cards_generated' });
  });

  test('PATCH saves fields and a note-wide deck move together while preserving scheduling', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie, 'Before');
    const destination = await freshDeck(cookie, 'After');
    const noteTypeId = await twoTemplateType(cookie);
    const created = await (await callApp(app, 'POST', '/notes', { cookie,
      body: { noteTypeId, deckId, fieldValues: { Front: 'Question', Back: 'Answer' } },
    })).json<any>();
    const grade = await (await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: created.cards[0].id, rating: 4 } })).json<any>();
    const moved = await callApp(app, 'PATCH', `/notes/${created.note.id}`, { cookie,
      body: { deckId: destination, fieldValues: { Front: 'Updated', Back: 'Answer' } },
    });
    expect(moved.status).toBe(200);
    const body = await moved.json<any>();
    expect(body.cards).toHaveLength(2);
    expect(body.cards.every((card: any) => card.deckId === destination)).toBe(true);
    expect(body.cards.find((card: any) => card.id === grade.card.id)).toMatchObject({ due: grade.card.due, reps: grade.card.reps, stability: grade.card.stability });
    expect(body.note.fieldValues.Front).toBe('Updated');
    const other = await signUpAndCookie(app, uniqueEmail());
    const foreign = await freshDeck(other.cookie);
    const denied = await callApp(app, 'PATCH', `/notes/${created.note.id}`, { cookie,
      body: { deckId: foreign, fieldValues: { Front: 'Must not save', Back: 'Answer' } },
    });
    expect(denied.status).toBe(400);
    const unchanged = await (await callApp(app, 'GET', `/cards/${created.cards[0].id}`, { cookie })).json<any>();
    expect(unchanged.note.fieldValues.Front).toBe('Updated');
    expect(unchanged.deckId).toBe(destination);
  });

  test('POST preserves literal Markdown source; search columns remain derived text', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const noteTypeId = await basicType(cookie);

    const res = await callApp(app, 'POST', '/notes', {
      cookie,
      body: {
        noteTypeId,
        fieldValues: { Front: '<b>Hund</b><script>alert(1)</script>', Back: 'dog<img src=x onerror=alert(1)>' },
        deckId,
      },
    });
    const body = await res.json<{
      note: { fieldValues: Record<string, string> };
      cards: Array<{ renderText: string }>;
    }>();
    // Markdown source is not HTML. The render-boundary security corpus proves
    // that these exact literal values never become executable DOM elements.
    expect(body.note.fieldValues.Front).toBe('<b>Hund</b><script>alert(1)</script>');
    expect(body.note.fieldValues.Back).toBe('dog<img src=x onerror=alert(1)>');
    expect(body.cards[0]!.renderText).toContain('Hund');
    expect(body.cards[0]!.renderText).toContain('<b>'); // literal text, as displayed
  });

  test('POST and PATCH round-trip code, literal HTML and entities without source loss', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const noteTypeId = await basicType(cookie);
    const fieldValues = {
      Front: 'Example:\n```ts\nconst value: Array<T> = [];\n```',
      Back: '```html\n<script>alert(1)</script>\n```\n5 < 8 && 9 > 2; &lt;',
    };
    const created = await callApp(app, 'POST', '/notes', { cookie, body: { deckId, noteTypeId, fieldValues } });
    expect(created.status).toBe(200);
    const saved = await created.json<any>();
    const loaded = await (await callApp(app, 'GET', `/cards/${saved.cards[0].id}`, { cookie })).json<any>();
    expect(loaded.note.fieldValues).toEqual(fieldValues);
    const next = { ...fieldValues, Front: 'Example: `<button onclick="example()">OK</button>`' };
    const updated = await callApp(app, 'PATCH', `/notes/${saved.note.id}`, { cookie, body: { fieldValues: next } });
    expect(updated.status).toBe(200);
    const reloaded = await (await callApp(app, 'GET', `/cards/${saved.cards[0].id}`, { cookie })).json<any>();
    expect(reloaded.note.fieldValues).toEqual(next);
  });

  test('deleting the former deck preserves a moved card and its reviews', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const original = await freshDeck(cookie, 'Original');
    const destination = await freshDeck(cookie, 'Destination');
    const noteTypeId = await basicType(cookie);
    const created = await (await callApp(app, 'POST', '/notes', { cookie, body: {
      noteTypeId, deckId: original, fieldValues: { Front: 'question', Back: 'answer' },
    } })).json<any>();
    const cardId = created.cards[0].id;
    const grade = await (await callApp(app, 'POST', '/reviews', { cookie, body: { cardId, rating: 4 } })).json<any>();
    expect((await callApp(app, 'PATCH', `/cards/${cardId}`, { cookie, body: { deckId: destination } })).status).toBe(200);
    expect((await callApp(app, 'DELETE', `/decks/${original}`, { cookie })).status).toBe(200);
    const history = await (await callApp(app, 'GET', '/reviews', { cookie })).json<any[]>();
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ id: grade.review.id, cardId, deckId: null, rating: 4 });
    const moved = await (await callApp(app, 'GET', `/cards/${cardId}`, { cookie })).json<any>();
    expect(moved).toMatchObject({ deckId: destination, due: grade.card.due, reps: grade.card.reps });
    const other = await signUpAndCookie(app, uniqueEmail());
    expect(await (await callApp(app, 'GET', '/reviews', { cookie: other.cookie })).json<any[]>()).toEqual([]);
  });

  test('text backfill is user-scoped and idempotent without changing source or FSRS', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const noteTypeId = await basicType(cookie);
    const fieldValues = { Front: '`Array<T>`', Back: 'answer' };
    const created = await (await callApp(app, 'POST', '/notes', { cookie, body: { noteTypeId, deckId, fieldValues } })).json<any>();
    const cardId = created.cards[0].id;
    const grade = await (await callApp(app, 'POST', '/reviews', { cookie, body: { cardId, rating: 4 } })).json<any>();
    await db.update(cards).set({ renderText: 'old corrupt cache', renderFrontText: 'Array' }).where(eq(cards.id, cardId));
    const foreign = await signUpAndCookie(app, uniqueEmail());
    expect((await rebuildCardTextBatch(foreign.userId)).updated).toBe(0);
    expect(await rebuildCardTextBatch(userId)).toMatchObject({ scanned: 1, updated: 1, skipped: 0 });
    expect((await rebuildCardTextBatch(userId)).updated).toBe(0);
    const rebuilt = await (await callApp(app, 'GET', `/cards/${cardId}`, { cookie })).json<any>();
    expect(rebuilt.renderFrontText).toBe('Array<T>');
    expect(rebuilt.note.fieldValues).toEqual(fieldValues);
    expect(rebuilt).toMatchObject({ reps: grade.card.reps, due: grade.card.due, updatedAt: grade.card.updatedAt });
  });

  test('text backfill also repairs unreviewed rows with PostgreSQL microsecond timestamps', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const noteTypeId = await basicType(cookie);
    const created = await (await callApp(app, 'POST', '/notes', { cookie, body: {
      noteTypeId, deckId, fieldValues: { Front: '`Array<T>`', Back: 'answer' },
    } })).json<any>();
    await db.update(cards).set({ renderFrontText: 'Array', updatedAt: sql`'2026-09-19T00:00:00.123456Z'::timestamptz` }).where(eq(cards.id, created.cards[0].id));
    expect((await rebuildCardTextBatch(userId)).updated).toBe(1);
    const [row] = await db.select().from(cards).where(eq(cards.id, created.cards[0].id));
    expect(row.renderFrontText).toBe('Array<T>');
    expect(row.reps).toBe(0);
  });

  test('POST rejects a deck the user does not own', async () => {
    const { cookie: a } = await signUpAndCookie(app, uniqueEmail('a'));
    const { cookie: b } = await signUpAndCookie(app, uniqueEmail('b'));
    const bDeck = await freshDeck(b, 'bob');
    const noteTypeId = await basicType(a);
    const res = await callApp(app, 'POST', '/notes', {
      cookie: a,
      body: { noteTypeId, fieldValues: { Front: 'x', Back: 'y' }, deckId: bDeck },
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('deck_not_found');
  });

  test('POST rejects a note-type the user cannot see', async () => {
    const { cookie: a } = await signUpAndCookie(app, uniqueEmail('a'));
    const { cookie: b } = await signUpAndCookie(app, uniqueEmail('b'));
    const aDeck = await freshDeck(a);
    const bType = await basicType(b);
    const res = await callApp(app, 'POST', '/notes', {
      cookie: a,
      body: { noteTypeId: bType, fieldValues: { Front: 'x', Back: 'y' }, deckId: aDeck },
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('note_type_not_found');
  });

  test('PATCH re-renders surviving template card while PRESERVING FSRS', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const noteTypeId = await basicType(cookie);

    const created = await (
      await callApp(app, 'POST', '/notes', {
        cookie,
        body: { noteTypeId, fieldValues: { Front: 'Hund', Back: 'dog' }, deckId },
      })
    ).json<{ note: { id: string }; cards: Array<{ id: string }> }>();
    const cardId = created.cards[0]!.id;

    // grade → non-default FSRS state.
    await callApp(app, 'POST', '/reviews', { cookie, body: { cardId, rating: 3 } });

    // edit the Front field value → render col changes, template ord 0 survives.
    const res = await callApp(app, 'PATCH', `/notes/${created.note.id}`, {
      cookie,
      body: { fieldValues: { Front: 'Katze', Back: 'cat' } },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{
      cards: Array<{ id: string; templateOrd: number; renderFrontText: string; reps: number; state: string }>;
    }>();
    const card = body.cards.find((c) => c.templateOrd === 0)!;
    // same card row (id preserved) …
    expect(card.id).toBe(cardId);
    // … render col refreshed …
    expect(card.renderFrontText).toBe('Katze');
    // … FSRS state preserved.
    expect(card.reps).toBe(1);
    expect(card.state).not.toBe('new');
  });

  test('PATCH inserts a card for a newly-non-empty reverse template (fresh FSRS)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const noteTypeId = await twoTemplateType(cookie);

    // Back empty → only Card 1.
    const created = await (
      await callApp(app, 'POST', '/notes', {
        cookie,
        body: { noteTypeId, fieldValues: { Front: 'Hund', Back: '' }, deckId },
      })
    ).json<{ note: { id: string }; cards: Array<{ id: string; templateOrd: number }> }>();
    expect(created.cards.length).toBe(1);
    const firstCardId = created.cards[0]!.id;

    // grade the surviving card.
    await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: firstCardId, rating: 3 } });

    // fill Back → Card 2 now generates.
    const res = await callApp(app, 'PATCH', `/notes/${created.note.id}`, {
      cookie,
      body: { fieldValues: { Front: 'Hund', Back: 'dog' } },
    });
    const body = await res.json<{
      cards: Array<{ id: string; templateOrd: number; reps: number; deckId: string }>;
    }>();
    expect(body.cards.length).toBe(2);
    const survivor = body.cards.find((c) => c.templateOrd === 0)!;
    const inserted = body.cards.find((c) => c.templateOrd === 1)!;
    // survivor keeps FSRS …
    expect(survivor.id).toBe(firstCardId);
    expect(survivor.reps).toBe(1);
    // … inserted card has fresh FSRS + inherits the note's deck.
    expect(inserted.reps).toBe(0);
    expect(inserted.deckId).toBe(deckId);
  });

  test('PATCH deletes the card for a now-empty template', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const noteTypeId = await twoTemplateType(cookie);

    const created = await (
      await callApp(app, 'POST', '/notes', {
        cookie,
        body: { noteTypeId, fieldValues: { Front: 'Hund', Back: 'dog' }, deckId },
      })
    ).json<{ note: { id: string }; cards: Array<{ templateOrd: number }> }>();
    expect(created.cards.length).toBe(2);

    // A preview and its exact confirmation are required before removing Card 2.
    const patch = { fieldValues: { Front: 'Hund', Back: '' } };
    const preview = await (await callApp(app, 'PATCH', `/notes/${created.note.id}`, {
      cookie, body: { ...patch, preview: true },
    })).json<any>();
    const res = await callApp(app, 'PATCH', `/notes/${created.note.id}`, {
      cookie, body: { ...patch, confirmationToken: preview.confirmationToken },
    });
    const body = await res.json<{ cards: Array<{ templateOrd: number }> }>();
    expect(body.cards.length).toBe(1);
    expect(body.cards[0]!.templateOrd).toBe(0);
  });

  test('DELETE removes the note and cascades to its cards', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const noteTypeId = await basicType(cookie);
    const created = await (
      await callApp(app, 'POST', '/notes', {
        cookie,
        body: { noteTypeId, fieldValues: { Front: 'Hund', Back: 'dog' }, deckId },
      })
    ).json<{ note: { id: string } }>();

    const before = await (await callApp(app, 'GET', '/cards', { cookie })).json<{ items: unknown[] }>();
    expect(before.items.length).toBe(1);

    const del = await callApp(app, 'DELETE', `/notes/${created.note.id}`, { cookie });
    expect(del.status).toBe(200);

    const after = await (await callApp(app, 'GET', '/cards', { cookie })).json<{ items: unknown[] }>();
    expect(after.items.length).toBe(0);
  });

  test('DELETE refuses a foreign note', async () => {
    const { cookie: a } = await signUpAndCookie(app, uniqueEmail('a'));
    const { cookie: b } = await signUpAndCookie(app, uniqueEmail('b'));
    const deckId = await freshDeck(a);
    const noteTypeId = await basicType(a);
    const created = await (
      await callApp(app, 'POST', '/notes', {
        cookie: a,
        body: { noteTypeId, fieldValues: { Front: 'x', Back: 'y' }, deckId },
      })
    ).json<{ note: { id: string } }>();

    const del = await callApp(app, 'DELETE', `/notes/${created.note.id}`, { cookie: b });
    expect(del.status).toBe(404);
  });
});
