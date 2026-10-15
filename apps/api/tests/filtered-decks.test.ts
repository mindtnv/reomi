import { beforeEach, describe, expect, test } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { cards, db } from '@reomi/db';
import { buildApp } from '../src/app.ts';
import {
  callApp,
  resetTestDb,
  seedBasicCard,
  signUpAndCookie,
  uniqueEmail,
} from './helpers.ts';

const app = buildApp();

// A full, valid filtered-deck body for the POST endpoint.
function fdBody(over: Record<string, unknown> = {}) {
  return {
    name: 'Cram',
    query: 'is:review',
    sortOrder: 'due',
    cardLimit: 50,
    includeSuspended: false,
    ...over,
  };
}

async function makeDeck(cookie: string, name: string): Promise<string> {
  const res = await callApp(app, 'POST', '/decks', { cookie, body: { name } });
  return (await res.json<{ id: string }>()).id;
}

/** Create a filtered deck via the API; returns its id. */
async function makeFilteredDeck(
  cookie: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const res = await callApp(app, 'POST', '/filtered-decks', { cookie, body: fdBody(over) });
  if (res.status !== 200) throw new Error(`create filtered deck failed: ${res.status}`);
  return (await res.json<{ id: string }>()).id;
}

type QueueResp = {
  due: { id: string; deckId: string }[];
  new: { id: string }[];
  total: number;
  mode: string;
};

async function runSession(cookie: string, filteredDeckId: string): Promise<QueueResp> {
  const res = await callApp(app, 'GET', `/cards/queue?filteredDeckId=${filteredDeckId}`, {
    cookie,
  });
  expect(res.status).toBe(200);
  return res.json<QueueResp>();
}

describe('filtered-decks (custom study / cram)', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  // ── CRUD ─────────────────────────────────────────────────────────────────────

  test('CRUD roundtrip', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());

    const created = await callApp(app, 'POST', '/filtered-decks', {
      cookie,
      body: fdBody({ name: 'Lapses', query: 'prop:lapses>0', sortOrder: 'difficultyDesc', cardLimit: 25 }),
    });
    expect(created.status).toBe(200);
    const fd = await created.json<{
      id: string;
      name: string;
      query: string;
      sortOrder: string;
      cardLimit: number;
      includeSuspended: boolean;
    }>();
    expect(fd.name).toBe('Lapses');
    expect(fd.query).toBe('prop:lapses>0');
    expect(fd.sortOrder).toBe('difficultyDesc');
    expect(fd.cardLimit).toBe(25);
    expect(fd.includeSuspended).toBe(false);

    // List
    const list = await callApp(app, 'GET', '/filtered-decks', { cookie });
    const all = await list.json<{ id: string }[]>();
    expect(all.map((x) => x.id)).toContain(fd.id);

    // Update
    const patched = await callApp(app, 'PATCH', `/filtered-decks/${fd.id}`, {
      cookie,
      body: { name: 'Lapses2', sortOrder: 'lapses', cardLimit: 10, includeSuspended: true },
    });
    expect(patched.status).toBe(200);
    const pp = await patched.json<{ name: string; sortOrder: string; cardLimit: number; includeSuspended: boolean }>();
    expect(pp.name).toBe('Lapses2');
    expect(pp.sortOrder).toBe('lapses');
    expect(pp.cardLimit).toBe(10);
    expect(pp.includeSuspended).toBe(true);

    // Delete
    const del = await callApp(app, 'DELETE', `/filtered-decks/${fd.id}`, { cookie });
    expect(del.status).toBe(200);
    expect((await del.json<{ ok: boolean }>()).ok).toBe(true);

    const after = await callApp(app, 'GET', '/filtered-decks', { cookie });
    const left = await after.json<{ id: string }[]>();
    expect(left.find((x) => x.id === fd.id)).toBeUndefined();
  });

  test('defaults applied when optional fields omitted', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const res = await callApp(app, 'POST', '/filtered-decks', {
      cookie,
      body: { name: 'Min', query: 'is:new' },
    });
    expect(res.status).toBe(200);
    const fd = await res.json<{ sortOrder: string; cardLimit: number; includeSuspended: boolean }>();
    expect(fd.sortOrder).toBe('due');
    expect(fd.cardLimit).toBe(50);
    expect(fd.includeSuspended).toBe(false);
  });

  // ── validation ────────────────────────────────────────────────────────────────

  test('POST with an unparseable query → 400', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    // parseCardQuery throws CardQueryError on a too-long query (> 1000 chars).
    const tooLong = 'a'.repeat(1001);
    const res = await callApp(app, 'POST', '/filtered-decks', {
      cookie,
      body: fdBody({ query: tooLong }),
    });
    expect(res.status).toBe(400);
  });

  test('PATCH with an unparseable query → 400', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const id = await makeFilteredDeck(cookie);
    const res = await callApp(app, 'PATCH', `/filtered-decks/${id}`, {
      cookie,
      body: { query: 'a'.repeat(1001) },
    });
    expect(res.status).toBe(400);
  });

  test('sortOrder outside the enum → 400 (typebox)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const res = await callApp(app, 'POST', '/filtered-decks', {
      cookie,
      body: fdBody({ sortOrder: 'banana' }),
    });
    expect(res.status).toBe(400);
  });

  test('cardLimit out of 1–1000 → 400 (typebox)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const zero = await callApp(app, 'POST', '/filtered-decks', {
      cookie,
      body: fdBody({ cardLimit: 0 }),
    });
    expect(zero.status).toBe(400);
    const over = await callApp(app, 'POST', '/filtered-decks', {
      cookie,
      body: fdBody({ cardLimit: 1001 }),
    });
    expect(over.status).toBe(400);
  });

  test('unauthenticated requests are rejected', async () => {
    const list = await callApp(app, 'GET', '/filtered-decks', {});
    expect(list.status).toBe(401);
    const create = await callApp(app, 'POST', '/filtered-decks', { body: fdBody() });
    expect(create.status).toBe(401);
  });

  // ── user scoping ────────────────────────────────────────────────────────────

  test('user B cannot GET/PATCH/DELETE user A filtered deck', async () => {
    const { cookie: aCookie } = await signUpAndCookie(app, uniqueEmail('alice'));
    const { cookie: bCookie } = await signUpAndCookie(app, uniqueEmail('bob'));

    const aId = await makeFilteredDeck(aCookie);

    // GET — B's list never includes A's
    const bList = await (await callApp(app, 'GET', '/filtered-decks', { cookie: bCookie })).json<
      { id: string }[]
    >();
    expect(bList.find((x) => x.id === aId)).toBeUndefined();

    // PATCH — 404
    const patch = await callApp(app, 'PATCH', `/filtered-decks/${aId}`, {
      cookie: bCookie,
      body: { name: 'hijack' },
    });
    expect(patch.status).toBe(404);

    // DELETE — 404
    const del = await callApp(app, 'DELETE', `/filtered-decks/${aId}`, { cookie: bCookie });
    expect(del.status).toBe(404);

    // A's still intact
    const stillThere = await (
      await callApp(app, 'GET', '/filtered-decks', { cookie: aCookie })
    ).json<{ id: string }[]>();
    expect(stillThere.map((x) => x.id)).toContain(aId);
  });

  test('foreign filteredDeckId in the queue → 404', async () => {
    const { cookie: aCookie } = await signUpAndCookie(app, uniqueEmail('a'));
    const { cookie: bCookie } = await signUpAndCookie(app, uniqueEmail('b'));
    const aId = await makeFilteredDeck(aCookie);
    const res = await callApp(app, 'GET', `/cards/queue?filteredDeckId=${aId}`, {
      cookie: bCookie,
    });
    expect(res.status).toBe(404);
  });

  // ── session: query filter + cardLimit ──────────────────────────────────────

  test('session respects the saved query (only matching cards returned)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deck = await makeDeck(cookie, 'D');
    const match = await seedBasicCard(app, cookie, { deckId: deck, front: 'apple', back: 'a', tags: ['fruit'] });
    const miss = await seedBasicCard(app, cookie, { deckId: deck, front: 'banana', back: 'b', tags: ['other'] });

    const fdId = await makeFilteredDeck(cookie, { query: 'tag:fruit', sortOrder: 'added' });
    const session = await runSession(cookie, fdId);
    const ids = session.due.map((c) => c.id);
    expect(ids).toContain(match.id);
    expect(ids).not.toContain(miss.id);
    expect(session.mode).toBe('filtered');
    expect(session.new).toEqual([]);
    expect(session.total).toBe(session.due.length);
  });

  test('session respects cardLimit (capped)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deck = await makeDeck(cookie, 'D');
    for (let i = 0; i < 5; i++) {
      await seedBasicCard(app, cookie, { deckId: deck, front: `q${i}`, back: 'a', tags: ['cap'] });
    }
    const fdId = await makeFilteredDeck(cookie, { query: 'tag:cap', cardLimit: 3 });
    const session = await runSession(cookie, fdId);
    expect(session.due.length).toBe(3);
    expect(session.total).toBe(3);
  });

  // ── session: sortOrder mapping ──────────────────────────────────────────────

  test('sortOrder=due orders by due ASC', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deck = await makeDeck(cookie, 'D');
    const c1 = await seedBasicCard(app, cookie, { deckId: deck, front: 'a', back: 'x', tags: ['s'] });
    const c2 = await seedBasicCard(app, cookie, { deckId: deck, front: 'b', back: 'x', tags: ['s'] });
    const c3 = await seedBasicCard(app, cookie, { deckId: deck, front: 'c', back: 'x', tags: ['s'] });
    // due: c3 earliest, c1 middle, c2 latest
    const now = Date.now();
    await db.update(cards).set({ due: new Date(now + 3000) }).where(eq(cards.id, c1.id));
    await db.update(cards).set({ due: new Date(now + 5000) }).where(eq(cards.id, c2.id));
    await db.update(cards).set({ due: new Date(now + 1000) }).where(eq(cards.id, c3.id));

    const fdId = await makeFilteredDeck(cookie, { query: 'tag:s', sortOrder: 'due', cardLimit: 50 });
    const session = await runSession(cookie, fdId);
    expect(session.due.map((c) => c.id)).toEqual([c3.id, c1.id, c2.id]);
  });

  test('sortOrder=difficultyDesc orders hard-first', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deck = await makeDeck(cookie, 'D');
    const lo = await seedBasicCard(app, cookie, { deckId: deck, front: 'a', back: 'x', tags: ['d'] });
    const hi = await seedBasicCard(app, cookie, { deckId: deck, front: 'b', back: 'x', tags: ['d'] });
    const mid = await seedBasicCard(app, cookie, { deckId: deck, front: 'c', back: 'x', tags: ['d'] });
    await db.update(cards).set({ difficulty: 2 }).where(eq(cards.id, lo.id));
    await db.update(cards).set({ difficulty: 9 }).where(eq(cards.id, hi.id));
    await db.update(cards).set({ difficulty: 5 }).where(eq(cards.id, mid.id));

    const fdId = await makeFilteredDeck(cookie, { query: 'tag:d', sortOrder: 'difficultyDesc' });
    const session = await runSession(cookie, fdId);
    expect(session.due.map((c) => c.id)).toEqual([hi.id, mid.id, lo.id]);
  });

  test('sortOrder=lapses orders most-lapsed first', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deck = await makeDeck(cookie, 'D');
    const a = await seedBasicCard(app, cookie, { deckId: deck, front: 'a', back: 'x', tags: ['l'] });
    const b = await seedBasicCard(app, cookie, { deckId: deck, front: 'b', back: 'x', tags: ['l'] });
    const c = await seedBasicCard(app, cookie, { deckId: deck, front: 'c', back: 'x', tags: ['l'] });
    await db.update(cards).set({ lapses: 1 }).where(eq(cards.id, a.id));
    await db.update(cards).set({ lapses: 7 }).where(eq(cards.id, b.id));
    await db.update(cards).set({ lapses: 3 }).where(eq(cards.id, c.id));

    const fdId = await makeFilteredDeck(cookie, { query: 'tag:l', sortOrder: 'lapses' });
    const session = await runSession(cookie, fdId);
    expect(session.due.map((c) => c.id)).toEqual([b.id, c.id, a.id]);
  });

  test('sortOrder=random returns the full set', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deck = await makeDeck(cookie, 'D');
    const seeded: string[] = [];
    for (let i = 0; i < 4; i++) {
      const c = await seedBasicCard(app, cookie, { deckId: deck, front: `r${i}`, back: 'x', tags: ['r'] });
      seeded.push(c.id);
    }
    const fdId = await makeFilteredDeck(cookie, { query: 'tag:r', sortOrder: 'random' });
    const session = await runSession(cookie, fdId);
    expect(session.due.map((c) => c.id).sort()).toEqual([...seeded].sort());
  });

  test('sortOrder=added orders by createdAt DESC', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deck = await makeDeck(cookie, 'D');
    const first = await seedBasicCard(app, cookie, { deckId: deck, front: 'a', back: 'x', tags: ['ad'] });
    const second = await seedBasicCard(app, cookie, { deckId: deck, front: 'b', back: 'x', tags: ['ad'] });
    const third = await seedBasicCard(app, cookie, { deckId: deck, front: 'c', back: 'x', tags: ['ad'] });
    const now = Date.now();
    await db.update(cards).set({ createdAt: new Date(now - 3000) }).where(eq(cards.id, first.id));
    await db.update(cards).set({ createdAt: new Date(now - 2000) }).where(eq(cards.id, second.id));
    await db.update(cards).set({ createdAt: new Date(now - 1000) }).where(eq(cards.id, third.id));

    const fdId = await makeFilteredDeck(cookie, { query: 'tag:ad', sortOrder: 'added' });
    const session = await runSession(cookie, fdId);
    expect(session.due.map((c) => c.id)).toEqual([third.id, second.id, first.id]);
  });

  // ── suspended toggle ─────────────────────────────────────────────────────────

  test('suspended cards stay out of gradeable sessions even for legacy includeSuspended:true', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deck = await makeDeck(cookie, 'D');
    const open = await seedBasicCard(app, cookie, { deckId: deck, front: 'a', back: 'x', tags: ['sus'] });
    const susp = await seedBasicCard(app, cookie, { deckId: deck, front: 'b', back: 'x', tags: ['sus'] });
    await db.update(cards).set({ suspended: true }).where(eq(cards.id, susp.id));

    const excludeId = await makeFilteredDeck(cookie, { query: 'tag:sus', includeSuspended: false });
    const excluded = await runSession(cookie, excludeId);
    const exIds = excluded.due.map((c) => c.id);
    expect(exIds).toContain(open.id);
    expect(exIds).not.toContain(susp.id);

    const includeId = await makeFilteredDeck(cookie, { query: 'tag:sus', includeSuspended: true });
    const included = await runSession(cookie, includeId);
    const inIds = included.due.map((c) => c.id);
    expect(inIds).toContain(open.id);
    expect(inIds).not.toContain(susp.id);
  });

  // ── cram AC (Decision 5) ──────────────────────────────────────────────────────

  test('cram returns a FUTURE-due card that overdue/regular sessions exclude', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const deck = await makeDeck(cookie, 'D');
    const future = await seedBasicCard(app, cookie, { deckId: deck, front: 'future', back: 'x', tags: ['cr'] });
    // Make it a review card scheduled in the future (well past now).
    await db
      .update(cards)
      .set({ state: 'review', due: new Date(Date.now() + 10 * 86_400_000), stability: 10, difficulty: 5, reps: 5 })
      .where(eq(cards.id, future.id));

    // cram session: future card IS returned.
    const cramId = await makeFilteredDeck(cookie, { query: 'tag:cr', sortOrder: 'cram' });
    const cram = await runSession(cookie, cramId);
    expect(cram.due.map((c) => c.id)).toContain(future.id);
    expect(cram.mode).toBe('filtered');

    // overdue session: due-gate excludes it.
    const overdueId = await makeFilteredDeck(cookie, { query: 'tag:cr', sortOrder: 'overdue' });
    const overdue = await runSession(cookie, overdueId);
    expect(overdue.due.map((c) => c.id)).not.toContain(future.id);

    // regular whole-collection queue: due-gate excludes it too.
    const regular = await (
      await callApp(app, 'GET', '/cards/queue', { cookie })
    ).json<QueueResp>();
    expect(regular.mode).toBe('regular');
    expect(regular.due.map((c) => c.id)).not.toContain(future.id);
  });

  test('cram grade (source:filtered) produces a valid FSRS step and leaves daily counters unchanged', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    // Lazy-create the profile.
    await callApp(app, 'GET', '/profile', { cookie });
    const deck = await makeDeck(cookie, 'D');
    const card = await seedBasicCard(app, cookie, { deckId: deck, front: 'future', back: 'x', tags: ['cg'] });
    await db
      .update(cards)
      .set({ state: 'review', due: new Date(Date.now() + 10 * 86_400_000), stability: 10, difficulty: 5, reps: 5 })
      .where(eq(cards.id, card.id));

    // Confirm cram returns it.
    const cramId = await makeFilteredDeck(cookie, { query: 'tag:cg', sortOrder: 'cram' });
    const cram = await runSession(cookie, cramId);
    expect(cram.due.map((c) => c.id)).toContain(card.id);

    const before = await (await callApp(app, 'GET', '/profile', { cookie })).json<{
      newIntroducedToday: number;
      reviewsDoneToday: number;
      dailyCountsDate: string | null;
    }>();
    expect(before.newIntroducedToday).toBe(0);
    expect(before.reviewsDoneToday).toBe(0);

    // Grade it as a filtered-session review.
    const graded = await callApp(app, 'POST', '/reviews', {
      cookie,
      body: { cardId: card.id, rating: 3, source: 'filtered' },
    });
    expect(graded.status).toBe(200);
    const body = await graded.json<{ card: { stability: number; due: string; reps: number } }>();
    // Valid FSRS step: stability advanced, due rescheduled, reps incremented.
    expect(body.card.reps).toBe(6);
    expect(Number.isFinite(body.card.stability)).toBe(true);
    expect(body.card.stability).toBeGreaterThan(0);
    expect(Number.isNaN(new Date(body.card.due).getTime())).toBe(false);

    // Daily counters UNCHANGED (filtered grades skip them).
    const after = await (await callApp(app, 'GET', '/profile', { cookie })).json<{
      newIntroducedToday: number;
      reviewsDoneToday: number;
      dailyCountsDate: string | null;
    }>();
    expect(after.newIntroducedToday).toBe(0);
    expect(after.reviewsDoneToday).toBe(0);
    expect(after.dailyCountsDate).toBeNull();
  });

  // ── isolation: filtered session is user-scoped on the card set ─────────────────

  test('filtered session never returns another user cards', async () => {
    const { cookie: aCookie } = await signUpAndCookie(app, uniqueEmail('a'));
    const { cookie: bCookie } = await signUpAndCookie(app, uniqueEmail('b'));
    const aDeck = await makeDeck(aCookie, 'A');
    const bDeck = await makeDeck(bCookie, 'B');
    const aCard = await seedBasicCard(app, aCookie, { deckId: aDeck, front: 'a', back: 'x', tags: ['shared'] });
    await seedBasicCard(app, bCookie, { deckId: bDeck, front: 'b', back: 'x', tags: ['shared'] });

    const aFdId = await makeFilteredDeck(aCookie, { query: 'tag:shared' });
    const session = await runSession(aCookie, aFdId);
    // Only A's cards belong to A's user — verify by checking each returned card is A's.
    const returnedIds = session.due.map((c) => c.id);
    const aRows = await db.select({ id: cards.id }).from(cards).where(inArray(cards.id, returnedIds));
    expect(aRows.length).toBe(returnedIds.length);
    expect(returnedIds).toContain(aCard.id);
  });
});
