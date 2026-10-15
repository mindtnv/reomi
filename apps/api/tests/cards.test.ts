import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { cards as cardsTable, db, deckOptionsPreset, decks as decksTable } from '@reomi/db';
import { buildApp } from '../src/app.ts';
import {
  callApp,
  resetTestDb,
  seedBasicCard,
  seedNote,
  signUpAndCookie,
  uniqueEmail,
} from './helpers.ts';

const app = buildApp();

async function freshDeck(cookie: string, name = 'Test', parentId?: string): Promise<string> {
  const res = await callApp(app, 'POST', '/decks', {
    cookie,
    body: { name, ...(parentId ? { parentId } : {}) },
  });
  return (await res.json<{ id: string }>()).id;
}

/**
 * Seed a deck-options preset directly via the DB and bind it to `deckId`. The
 * preset CRUD endpoint (`/deck-options`) + the `PATCH /decks { presetId }`
 * binding ship in Phase 5; Phase 4 tests the QUEUE consuming a bound preset, so
 * we seed the binding at the DB layer (the same shape Phase 5 will write).
 */
async function bindPreset(
  userId: string,
  deckId: string,
  fields: { newPerDay?: number; reviewsPerDay?: number },
): Promise<string> {
  const [preset] = await db
    .insert(deckOptionsPreset)
    .values({
      userId,
      name: 'P',
      ...(fields.newPerDay !== undefined ? { newPerDay: fields.newPerDay } : {}),
      ...(fields.reviewsPerDay !== undefined ? { reviewsPerDay: fields.reviewsPerDay } : {}),
    })
    .returning();
  await db.update(decksTable).set({ presetId: preset!.id }).where(eq(decksTable.id, deckId));
  return preset!.id;
}

type QueueResp = {
  due: { id: string; deckId: string }[];
  new: { id: string; deckId: string }[];
  total: number;
  mode: string;
};

describe('cards', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('POST /notes requires a deck that belongs to the user', async () => {
    const { cookie: aCookie } = await signUpAndCookie(app, uniqueEmail('a'));
    const { cookie: bCookie } = await signUpAndCookie(app, uniqueEmail('b'));
    const bDeck = await freshDeck(bCookie, 'Bob');
    // User A tries to create a note in user B's deck — rejected with 400.
    await expect(
      seedBasicCard(app, aCookie, { deckId: bDeck, front: 'x', back: 'y' }),
    ).rejects.toThrow(/400/);
  });

  test('generated card starts in state=new with default fsrs counters', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deck = await freshDeck(cookie);
    const { note, cards } = await seedNote(app, cookie, {
      deckId: deck,
      fields: { Front: 'Hund', Back: 'dog' },
      tags: ['a1', 'noun'],
    });
    expect(cards.length).toBe(1);
    const card = cards[0]!;
    expect(card.state).toBe('new');
    expect(card.reps).toBe(0);
    expect(card.lapses).toBe(0);
    expect(card.suspended).toBe(false);
    // Tags are NOTE-level now (Anki-correct), not on the card.
    expect(note.tags).toEqual(['a1', 'noun']);
    // The card carries the denormalized render plaintext + kind.
    expect(card.renderFrontText).toBe('Hund');
    expect(card.renderKind).toBe('basic');
  });

  test('suspended cards are hidden from default /cards, shown with includeSuspended', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deck = await freshDeck(cookie);
    const card = await seedBasicCard(app, cookie, { deckId: deck, front: 'a', back: 'b' });

    await callApp(app, 'PATCH', `/cards/${card.id}`, { cookie, body: { suspended: true } });

    const plain = await (await callApp(app, 'GET', '/cards', { cookie })).json<{
      items: unknown[];
      nextCursor: string | null;
    }>();
    expect(plain.items).toEqual([]);
    expect(plain.nextCursor).toBeNull();

    const withSuspended = await (
      await callApp(app, 'GET', '/cards?includeSuspended=true', { cookie })
    ).json<{ items: { id: string }[] }>();
    expect(withSuspended.items.find((c) => c.id === card.id)).toBeTruthy();
  });

  test('/cards/queue returns due + capped new with suspended excluded', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deck = await freshDeck(cookie);

    // 3 new cards
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const c = await seedBasicCard(app, cookie, { deckId: deck, front: `front-${i}`, back: `back-${i}` });
      ids.push(c.id);
    }

    // Suspend one
    await callApp(app, 'PATCH', `/cards/${ids[0]}`, { cookie, body: { suspended: true } });

    const q = await (
      await callApp(app, 'GET', '/cards/queue?newLimit=10', { cookie })
    ).json<{ new: { id: string }[]; due: unknown[]; total: number }>();
    expect(q.due).toEqual([]);
    expect(q.new.length).toBe(2);
    expect(q.new.find((c) => c.id === ids[0])).toBeUndefined();
    expect(q.total).toBe(2);
  });

  test('/cards/queue respects newLimit', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deck = await freshDeck(cookie);
    for (let i = 0; i < 5; i++) {
      await seedBasicCard(app, cookie, { deckId: deck, front: `f${i}`, back: `b${i}` });
    }
    const q = await (
      await callApp(app, 'GET', '/cards/queue?newLimit=2', { cookie })
    ).json<{ new: unknown[]; total: number }>();
    expect(q.new.length).toBe(2);
    expect(q.total).toBe(2);
  });

  test('DELETE /cards/:id removes the card and leaves the deck', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deck = await freshDeck(cookie);
    const c = await seedBasicCard(app, cookie, { deckId: deck, front: 'x', back: 'y' });
    const del = await callApp(app, 'DELETE', `/cards/${c.id}`, { cookie });
    expect(del.status).toBe(200);
    const decks = await (await callApp(app, 'GET', '/decks', { cookie })).json<unknown[]>();
    expect(decks.length).toBe(1);
    const cardsBody = await (await callApp(app, 'GET', '/cards', { cookie })).json<{
      items: unknown[];
    }>();
    expect(cardsBody.items).toEqual([]);
  });

  test('GET /cards paginates via limit + cursor', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail('page'));
    const deck = await freshDeck(cookie);
    // Create 5 cards. Server orders by createdAt DESC so card-4 is the newest.
    for (let i = 0; i < 5; i++) {
      await seedBasicCard(app, cookie, { deckId: deck, front: `f${i}`, back: `b${i}` });
    }

    // First page — 3 items, cursor set.
    const page1 = await (
      await callApp(app, 'GET', '/cards?limit=3', { cookie })
    ).json<{ items: { renderFrontText: string; createdAt: string }[]; nextCursor: string | null }>();
    expect(page1.items.length).toBe(3);
    expect(page1.nextCursor).toBeTruthy();

    // Second page — remaining 2, cursor null.
    const page2 = await (
      await callApp(app, 'GET', `/cards?limit=3&cursor=${encodeURIComponent(page1.nextCursor!)}`, {
        cookie,
      })
    ).json<{ items: { renderFrontText: string }[]; nextCursor: string | null }>();
    expect(page2.items.length).toBe(2);
    expect(page2.nextCursor).toBeNull();

    // No overlap between the two pages.
    const fronts1 = new Set(page1.items.map((c) => c.renderFrontText));
    const overlap = page2.items.some((c) => fronts1.has(c.renderFrontText));
    expect(overlap).toBe(false);
  });

  test('GET /cards cursor does not skip cards with the same createdAt', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail('page-tie'));
    const deck = await freshDeck(cookie);
    const cardIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const card = await seedBasicCard(app, cookie, {
        deckId: deck,
        front: `same-time-${i}`,
        back: `back-${i}`,
      });
      cardIds.push(card.id);
    }

    const sharedCreatedAt = new Date('2026-01-02T03:04:05.678Z');
    await db
      .update(cardsTable)
      .set({ createdAt: sharedCreatedAt })
      .where(eq(cardsTable.userId, userId));

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query = cursor
        ? `/cards?limit=2&cursor=${encodeURIComponent(cursor)}`
        : '/cards?limit=2';
      const page = await (await callApp(app, 'GET', query, { cookie })).json<{
        items: { id: string; createdAt: string }[];
        nextCursor: string | null;
      }>();
      seen.push(...page.items.map((card) => card.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toEqual([...cardIds].sort().reverse());
    expect(new Set(seen).size).toBe(cardIds.length);
  });

  test('GET /cards accepts a legacy timestamp-only cursor', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail('page-legacy'));
    const deck = await freshDeck(cookie);
    const older = await seedBasicCard(app, cookie, {
      deckId: deck,
      front: 'older',
      back: 'older-back',
    });
    const newer = await seedBasicCard(app, cookie, {
      deckId: deck,
      front: 'newer',
      back: 'newer-back',
    });
    const cutoff = new Date('2026-02-03T04:05:06.789Z');
    await db
      .update(cardsTable)
      .set({ createdAt: new Date(cutoff.getTime() - 1_000) })
      .where(eq(cardsTable.id, older.id));
    await db.update(cardsTable).set({ createdAt: cutoff }).where(eq(cardsTable.id, newer.id));

    const page = await (
      await callApp(app, 'GET', `/cards?cursor=${encodeURIComponent(cutoff.toISOString())}`, {
        cookie,
      })
    ).json<{ items: { id: string }[]; nextCursor: string | null }>();

    expect(page.items.map((card) => card.id)).toEqual([older.id]);
    expect(page.nextCursor).toBeNull();
  });

  test('GET /cards includes x-request-id response header', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail('rid'));
    const incoming = 'rid-test-abcdef';
    const res = await callApp(app, 'GET', '/cards', {
      cookie,
      headers: { 'x-request-id': incoming },
    });
    expect(res.headers['x-request-id']).toBe(incoming);
  });

  test('GET /health generates a request-id if upstream did not provide one', async () => {
    const res = await callApp(app, 'GET', '/health');
    expect(res.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test('PATCH /cards/:id moves card to another deck owned by the same user', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail('move'));
    const deckA = await freshDeck(cookie, 'Deck A');
    const deckB = await freshDeck(cookie, 'Deck B');

    const card = await seedBasicCard(app, cookie, { deckId: deckA, front: 'front', back: 'back' });
    expect(card.deckId).toBe(deckA);

    const res = await callApp(app, 'PATCH', `/cards/${card.id}`, {
      cookie,
      body: { deckId: deckB },
    });
    expect(res.status).toBe(200);
    const updated = await res.json<{ id: string; deckId: string }>();
    expect(updated.deckId).toBe(deckB);
  });

  test('PATCH /cards/:id returns 400 deck_not_found for a non-existent deck', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail('move-noexist'));
    const deckA = await freshDeck(cookie, 'Deck A');
    const card = await seedBasicCard(app, cookie, { deckId: deckA, front: 'front', back: 'back' });

    const nonExistentDeckId = '00000000-0000-4000-8000-000000000000';
    const res = await callApp(app, 'PATCH', `/cards/${card.id}`, {
      cookie,
      body: { deckId: nonExistentDeckId },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('deck_not_found');
  });

  test('PATCH /cards/:id returns 400 deck_not_found when target deck belongs to another user', async () => {
    const { cookie: aCookie } = await signUpAndCookie(app, uniqueEmail('move-a'));
    const { cookie: bCookie } = await signUpAndCookie(app, uniqueEmail('move-b'));

    const aDeck = await freshDeck(aCookie, 'A Deck');
    const bDeck = await freshDeck(bCookie, 'B Deck');

    const card = await seedBasicCard(app, aCookie, { deckId: aDeck, front: 'front', back: 'back' });

    // User A tries to move their card into user B's deck — must be rejected.
    const res = await callApp(app, 'PATCH', `/cards/${card.id}`, {
      cookie: aCookie,
      body: { deckId: bDeck },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('deck_not_found');
  });

  // ── Step 3: manual scheduling control (forget / set-due) ────────────────────

  type FullCard = {
    id: string;
    state: string;
    reps: number;
    lapses: number;
    due: string;
    lastReview: string | null;
    suspended: boolean;
    [key: string]: unknown;
  };

  // No GET /cards/:id endpoint — fetch the full row via the list endpoint
  // (includeSuspended covers suspended cards too) and pick it by id.
  const getCardById = async (cookie: string, id: string): Promise<FullCard> => {
    const body = await (
      await callApp(app, 'GET', '/cards?includeSuspended=true', { cookie })
    ).json<{ items: FullCard[] }>();
    const found = body.items.find((c) => c.id === id);
    if (!found) throw new Error(`card ${id} not found in /cards`);
    return found;
  };

  test('PATCH /cards/:id forget resets FSRS state to new (reps/lapses 0, due≈now, lastReview null)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail('forget'));
    const deck = await freshDeck(cookie);
    const card = await seedBasicCard(app, cookie, { deckId: deck, front: 'f', back: 'b' });

    // Grade the card so it leaves "new" with non-zero reps + a lastReview.
    const graded = await callApp(app, 'POST', '/reviews', {
      cookie,
      body: { cardId: card.id, rating: 3 },
    });
    expect(graded.status).toBe(200);

    const beforeForget = await getCardById(cookie, card.id);
    expect(beforeForget.state).not.toBe('new');
    expect(beforeForget.reps).toBeGreaterThan(0);

    const before = Date.now();
    const res = await callApp(app, 'PATCH', `/cards/${card.id}`, {
      cookie,
      body: { forget: true },
    });
    expect(res.status).toBe(200);
    const updated = await res.json<FullCard>();
    expect(updated.state).toBe('new');
    expect(updated.reps).toBe(0);
    expect(updated.lapses).toBe(0);
    expect(updated.lastReview).toBeNull();
    // due reset to ~now (within a generous window for test execution time).
    const dueMs = new Date(updated.due).getTime();
    expect(dueMs).toBeGreaterThanOrEqual(before - 5000);
    expect(dueMs).toBeLessThanOrEqual(Date.now() + 5000);
  });

  test('PATCH /cards/:id setDue sets due to the given date', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail('setdue'));
    const deck = await freshDeck(cookie);
    const card = await seedBasicCard(app, cookie, { deckId: deck, front: 'f', back: 'b' });

    const target = '2030-01-15T00:00:00.000Z';
    const res = await callApp(app, 'PATCH', `/cards/${card.id}`, {
      cookie,
      body: { setDue: target },
    });
    expect(res.status).toBe(200);
    const updated = await res.json<FullCard>();
    expect(new Date(updated.due).getTime()).toBe(new Date(target).getTime());
  });

  test('PATCH /cards/:id forget returns 404 for a card owned by another user', async () => {
    const { cookie: aCookie } = await signUpAndCookie(app, uniqueEmail('forget-a'));
    const { cookie: bCookie } = await signUpAndCookie(app, uniqueEmail('forget-b'));
    const aDeck = await freshDeck(aCookie);
    const card = await seedBasicCard(app, aCookie, { deckId: aDeck, front: 'f', back: 'b' });

    const res = await callApp(app, 'PATCH', `/cards/${card.id}`, {
      cookie: bCookie,
      body: { forget: true },
    });
    expect(res.status).toBe(404);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('not_found');
  });

  test('PATCH /cards/:id setDue returns 400 invalid_date for an unparseable date', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail('setdue-bad'));
    const deck = await freshDeck(cookie);
    const card = await seedBasicCard(app, cookie, { deckId: deck, front: 'f', back: 'b' });

    const res = await callApp(app, 'PATCH', `/cards/${card.id}`, {
      cookie,
      body: { setDue: 'not-a-date' },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('invalid_date');
  });

  test('PATCH /cards/:id returns 400 when forget and setDue are combined', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail('combo'));
    const deck = await freshDeck(cookie);
    const card = await seedBasicCard(app, cookie, { deckId: deck, front: 'f', back: 'b' });

    const res = await callApp(app, 'PATCH', `/cards/${card.id}`, {
      cookie,
      body: { forget: true, setDue: '2030-01-15T00:00:00.000Z' },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe('forget_and_setdue_exclusive');
  });

  test('PATCH /cards/:id still toggles suspended without touching FSRS state (regression)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail('suspend-regress'));
    const deck = await freshDeck(cookie);
    const card = await seedBasicCard(app, cookie, { deckId: deck, front: 'f', back: 'b' });

    // Grade to move off "new" so we can prove suspend doesn't reset FSRS.
    await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: card.id, rating: 3 } });
    const before = await getCardById(cookie, card.id);

    const res = await callApp(app, 'PATCH', `/cards/${card.id}`, {
      cookie,
      body: { suspended: true },
    });
    expect(res.status).toBe(200);
    const updated = await res.json<FullCard>();
    expect(updated.suspended).toBe(true);
    // FSRS untouched: state + reps stay as graded (not reset to new).
    expect(updated.state).toBe(before.state);
    expect(updated.reps).toBe(before.reps);
  });

  // ── M3 Phase 4: regular queue config + subtree + global daily-remaining ──────

  test('/cards/queue honors a bound preset newPerDay/reviewsPerDay over the 20/200 defaults', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail('preset'));
    const deck = await freshDeck(cookie);
    await bindPreset(userId, deck, { newPerDay: 5, reviewsPerDay: 7 });

    // 8 new cards — preset caps new at 5.
    for (let i = 0; i < 8; i++) {
      await seedBasicCard(app, cookie, { deckId: deck, front: `f${i}`, back: `b${i}` });
    }

    const q = await (await callApp(app, 'GET', `/cards/queue?deckId=${deck}`, { cookie })).json<QueueResp>();
    expect(q.new.length).toBe(5); // preset cap, not the default 20
    expect(q.mode).toBe('regular');
  });

  test('/cards/queue decrements the GLOBAL new budget after grading new cards', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail('decrement'));
    // Materialize the profile row (the web bootstrap fetches GET /profile right
    // after sign-in — lazy-create-on-read). The grade handler only advances the
    // GLOBAL daily counter when a profile row exists, so the per-day remaining
    // semantics require this row, exactly as in real usage.
    await callApp(app, 'GET', '/profile', { cookie });
    const deck = await freshDeck(cookie);
    await bindPreset(userId, deck, { newPerDay: 5 });

    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const c = await seedBasicCard(app, cookie, { deckId: deck, front: `f${i}`, back: `b${i}` });
      ids.push(c.id);
    }

    // Before any grade: 5 new slots available.
    const before = await (
      await callApp(app, 'GET', `/cards/queue?deckId=${deck}`, { cookie })
    ).json<QueueResp>();
    expect(before.new.length).toBe(5);

    // Grade 2 NEW cards (regular) → consumes 2 of the daily NEW budget.
    for (let i = 0; i < 2; i++) {
      const r = await callApp(app, 'POST', '/reviews', {
        cookie,
        body: { cardId: ids[i], rating: 3 },
      });
      expect(r.status).toBe(200);
    }

    // Same-day decrement: cfg.newPerDay (5) − 2 consumed = 3 remaining slots. The
    // two graded cards are now `learning` (not `new`), so they leave the new
    // list regardless; the cap itself is what matters here.
    const after = await (
      await callApp(app, 'GET', `/cards/queue?deckId=${deck}`, { cookie })
    ).json<QueueResp>();
    expect(after.new.length).toBe(3); // 6 still-new cards, but capped at 5−2=3
  });

  test('/cards/queue aggregates a deck subtree and counts child cards against the parent cap', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail('subtree'));
    const parent = await freshDeck(cookie, 'Parent');
    const child = await freshDeck(cookie, 'Child', parent);
    // Cap the PARENT at 3 new; the CHILD has no preset → inherits the parent's cap.
    await bindPreset(userId, parent, { newPerDay: 3 });

    // M=5 cards live in the CHILD deck only.
    const childCardIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const c = await seedBasicCard(app, cookie, { deckId: child, front: `c${i}`, back: `b${i}` });
      childCardIds.push(c.id);
    }

    const q = await (
      await callApp(app, 'GET', `/cards/queue?deckId=${parent}`, { cookie })
    ).json<QueueResp>();
    // Child cards appear in the parent's queue (subtree aggregation)…
    expect(q.new.every((c) => childCardIds.includes(c.id))).toBe(true);
    expect(q.new.every((c) => c.deckId === child)).toBe(true);
    // …AND count against the PARENT's resolved cap of 3 (5 cards present → ≤3).
    expect(q.new.length).toBe(3);
    expect(q.mode).toBe('regular');
  });

  test('/cards/queue (no deckId) spans the whole collection with default limits', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail('whole'));
    const deckA = await freshDeck(cookie, 'A');
    const deckB = await freshDeck(cookie, 'B');
    const a = await seedBasicCard(app, cookie, { deckId: deckA, front: 'a', back: 'a' });
    const b = await seedBasicCard(app, cookie, { deckId: deckB, front: 'b', back: 'b' });

    const q = await (await callApp(app, 'GET', '/cards/queue', { cookie })).json<QueueResp>();
    // Both decks' cards are returned (no deckId/subtree filter).
    const ids = q.new.map((c) => c.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    expect(q.mode).toBe('regular');
  });

  test('/cards/queue (no deckId) applies the GLOBAL daily-new decrement', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail('whole-decrement'));
    // Materialize the profile row so the GLOBAL daily counter advances on grade
    // (mirrors the web bootstrap's GET /profile after sign-in).
    await callApp(app, 'GET', '/profile', { cookie });
    const deck = await freshDeck(cookie);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const c = await seedBasicCard(app, cookie, { deckId: deck, front: `f${i}`, back: `b${i}` });
      ids.push(c.id);
    }

    const before = await (await callApp(app, 'GET', '/cards/queue', { cookie })).json<QueueResp>();
    expect(before.new.length).toBe(4); // default cap 20, all 4 new shown

    // Grade 1 new card (regular) → consumes 1 of the GLOBAL new budget.
    await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: ids[0], rating: 3 } });

    const after = await (await callApp(app, 'GET', '/cards/queue', { cookie })).json<QueueResp>();
    // 3 cards still `new`; the consumed count is global so it applies here too.
    expect(after.new.length).toBe(3);
  });

  test('/cards/queue excludes suspended cards by default (whole-collection)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail('q-suspend'));
    const deck = await freshDeck(cookie);
    const keep = await seedBasicCard(app, cookie, { deckId: deck, front: 'keep', back: '1' });
    const susp = await seedBasicCard(app, cookie, { deckId: deck, front: 'susp', back: '2' });
    await callApp(app, 'PATCH', `/cards/${susp.id}`, { cookie, body: { suspended: true } });

    const q = await (await callApp(app, 'GET', '/cards/queue', { cookie })).json<QueueResp>();
    const ids = q.new.map((c) => c.id);
    expect(ids).toContain(keep.id);
    expect(ids).not.toContain(susp.id);
  });

  test('/cards/queue envelope carries mode: regular on both paths', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail('q-mode'));
    const deck = await freshDeck(cookie);
    await seedBasicCard(app, cookie, { deckId: deck, front: 'x', back: 'y' });

    const scoped = await (
      await callApp(app, 'GET', `/cards/queue?deckId=${deck}`, { cookie })
    ).json<QueueResp>();
    expect(scoped.mode).toBe('regular');

    const whole = await (await callApp(app, 'GET', '/cards/queue', { cookie })).json<QueueResp>();
    expect(whole.mode).toBe('regular');
  });
});
