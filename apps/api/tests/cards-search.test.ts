import { beforeEach, describe, expect, test } from 'bun:test';
import { cards, db } from '@reomi/db';
import { eq } from 'drizzle-orm';
import {
  buildCardPredicate,
  parseCardQuery,
  type CardLike,
} from '@reomi/shared';
import { buildApp } from '../src/app.ts';
import {
  callApp,
  resetTestDb,
  seedNote,
  signUpAndCookie,
  uniqueEmail,
  type BuiltinKind,
} from './helpers.ts';

const app = buildApp();

// A fixed clock shared by the server (via ?now=) and the in-memory predicate so
// time-relative operators (is:due / added / edited / prop:due) are in parity and
// stable. 2026-06-06T12:00:00Z.
const NOW = new Date('2026-06-06T12:00:00.000Z');
const NOW_MS = NOW.getTime();
const DAY = 86_400_000;

// ── Note-based card seeding (M1) ─────────────────────────────────────────────
//
// Cards are generated from a NOTE (`POST /notes`). To exercise time-/FSRS-
// relative operators (is:/prop:/added:/edited:/due) we POST the note (real
// generation fills the stored render* columns) and then directly UPDATE the
// generated card's FSRS + bookkeeping columns to the controlled values. The
// render* columns are NEVER touched here — the parity assertions below prove the
// predicate consumes the SERVER-STORED render columns verbatim (must-fix #5).

type CardSeed = {
  // Note content (drives generation → stored render* columns).
  kind?: BuiltinKind;
  fields?: Record<string, string>;
  tags?: string[];
  // Controlled card FSRS / bookkeeping state.
  state?: 'new' | 'learning' | 'review' | 'relearning';
  suspended?: boolean;
  due?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  lapses?: number;
  reps?: number;
  stability?: number;
  difficulty?: number;
  scheduledDays?: number;
};

// Per-card view of the note-type identity + note content the predicate needs but
// which the server card row does not carry (those live on the note / note-type).
type NoteMeta = {
  fieldValues: Record<string, string>;
  tags: string[];
  noteTypeKind: CardLike['noteTypeKind'];
  noteTypeName: string;
};

const KIND_NAME: Record<BuiltinKind, string> = {
  basic: 'Basic',
  cloze: 'Cloze',
  typein: 'Type-in',
};

/**
 * Seed a single-card note: POST /notes (real generation), then pin the card's
 * FSRS / bookkeeping columns. Records the note meta for the predicate adapter.
 * Returns the generated card id.
 */
async function seedCard(
  cookie: string,
  deckId: string,
  seed: CardSeed,
  meta: Map<string, NoteMeta>,
): Promise<string> {
  const kind = seed.kind ?? 'basic';
  const fields =
    seed.fields ??
    (kind === 'cloze' ? { Text: 'front', Extra: '' } : { Front: 'front', Back: 'back' });
  const { note, cards: generated } = await seedNote(app, cookie, {
    kind,
    deckId,
    fields,
    tags: seed.tags ?? [],
  });
  // Single-card notes only (the fixture uses one card per note).
  const card = generated[0]!;
  // Pin the FSRS / bookkeeping columns to the controlled values. render* columns
  // are intentionally left as generated.
  await db
    .update(cards)
    .set({
      due: seed.due ?? new Date(NOW_MS + DAY),
      stability: seed.stability ?? 0,
      difficulty: seed.difficulty ?? 0,
      scheduledDays: seed.scheduledDays ?? 0,
      reps: seed.reps ?? 0,
      lapses: seed.lapses ?? 0,
      state: seed.state ?? 'new',
      createdAt: seed.createdAt ?? NOW,
      updatedAt: seed.updatedAt ?? NOW,
      suspended: seed.suspended ?? false,
    })
    .where(eq(cards.id, card.id));
  meta.set(card.id, {
    fieldValues: note.fieldValues,
    tags: note.tags,
    noteTypeKind: kind,
    noteTypeName: KIND_NAME[kind],
  });
  return card.id;
}

async function freshDeck(cookie: string, name: string, parentId?: string): Promise<string> {
  const res = await callApp(app, 'POST', '/decks', {
    cookie,
    body: { name, ...(parentId ? { parentId } : {}) },
  });
  return (await res.json<{ id: string }>()).id;
}

/**
 * Map a server card row + its note meta into the CardLike shape the client
 * predicate expects. The render* fields are taken from the SERVER-STORED columns
 * VERBATIM (never re-rendered — predicate-text==stored-columns invariant). The
 * cross-note fields (fieldValues/tags/noteType*) come from the seeded note.
 */
function toCardLike(row: Record<string, unknown>, m: NoteMeta): CardLike {
  return {
    renderText: row.renderText as string,
    renderFrontText: row.renderFrontText as string,
    renderBackText: row.renderBackText as string,
    fieldValues: m.fieldValues,
    noteTypeKind: m.noteTypeKind,
    noteTypeName: m.noteTypeName,
    templateOrd: row.templateOrd as number,
    tags: m.tags,
    deckId: row.deckId as string,
    state: row.state as CardLike['state'],
    suspended: row.suspended as boolean,
    due: new Date(row.due as string).getTime(),
    createdAt: new Date(row.createdAt as string).getTime(),
    updatedAt: new Date(row.updatedAt as string).getTime(),
    lapses: row.lapses as number,
    reps: row.reps as number,
    stability: row.stability as number,
    difficulty: row.difficulty as number,
    scheduledDays: row.scheduledDays as number,
  };
}

async function search(
  cookie: string,
  q: string,
  extra = '',
): Promise<{ items: Array<Record<string, unknown>>; nextCursor: string | null }> {
  const res = await callApp(
    app,
    'GET',
    `/cards/search?now=${NOW_MS}&q=${encodeURIComponent(q)}${extra}`,
    { cookie },
  );
  return res.json();
}

function ids(items: Array<Record<string, unknown>>): string[] {
  return items.map((i) => i.id as string).sort();
}

describe('GET /cards/search — operators', () => {
  let cookie: string;
  let deckGerman: string;
  let deckB1: string;
  let deckFrench: string;
  const meta = new Map<string, NoteMeta>();

  // ids by label for assertions
  const C: Record<string, string> = {};

  beforeEach(async () => {
    await resetTestDb();
    meta.clear();
    const u = await signUpAndCookie(app, uniqueEmail('search'));
    cookie = u.cookie;

    deckGerman = await freshDeck(cookie, 'German');
    deckB1 = await freshDeck(cookie, 'B1', deckGerman); // child of German
    deckFrench = await freshDeck(cookie, 'French');

    C.hund = await seedCard(
      cookie,
      deckGerman,
      {
        fields: { Front: 'Hund', Back: 'dog' },
        tags: ['noun', 'a1'],
        state: 'review',
        reps: 5,
        lapses: 2,
        stability: 12.5,
        difficulty: 4.2,
        scheduledDays: 10,
        due: new Date(NOW_MS - DAY), // overdue
        createdAt: new Date(NOW_MS - 2 * DAY),
        updatedAt: new Date(NOW_MS - 2 * DAY),
      },
      meta,
    );
    C.katze = await seedCard(
      cookie,
      deckB1,
      {
        fields: { Front: 'Katze', Back: 'cat' },
        tags: ['noun'],
        state: 'learning',
        reps: 1,
        lapses: 0,
        due: new Date(NOW_MS + 3 * DAY),
      },
      meta,
    );
    C.bonjour = await seedCard(
      cookie,
      deckFrench,
      {
        fields: { Front: 'Bonjour', Back: 'hello' },
        tags: [],
        state: 'new',
        reps: 0,
        due: new Date(NOW_MS + 10 * DAY),
      },
      meta,
    );
    C.cloze = await seedCard(
      cookie,
      deckGerman,
      {
        kind: 'cloze',
        fields: { Text: 'Das ist ein {{c1::Hund}}', Extra: '' },
        tags: ['cloze', 'a2'],
        state: 'review',
        reps: 3,
        lapses: 8,
        due: new Date(NOW_MS - 2 * DAY),
        createdAt: new Date(NOW_MS - 30 * DAY),
        updatedAt: new Date(NOW_MS - DAY),
      },
      meta,
    );
    C.suspended = await seedCard(
      cookie,
      deckFrench,
      {
        fields: { Front: 'Merci', Back: 'thanks' },
        tags: ['polite'],
        state: 'review',
        suspended: true,
        due: new Date(NOW_MS - DAY), // would be due but suspended
      },
      meta,
    );
  });

  test('bareword → substring over rendered text (case-insensitive)', async () => {
    const r = await search(cookie, 'hund');
    // matches Basic "Hund" (renderText) and cloze "Das ist ein [Hund]" (renderText)
    expect(ids(r.items)).toEqual([C.hund, C.cloze].sort());
  });

  test('front: substring', async () => {
    const r = await search(cookie, 'front:Kat');
    expect(ids(r.items)).toEqual([C.katze]);
  });

  test('front: wildcard', async () => {
    const r = await search(cookie, 'front:H*d');
    expect(ids(r.items)).toEqual([C.hund]);
  });

  test('back: substring', async () => {
    const r = await search(cookie, 'back:dog');
    expect(ids(r.items)).toEqual([C.hund]);
  });

  test('cloze: substring (aliased to bareword → rendered text)', async () => {
    const r = await search(cookie, 'cloze:Hund');
    // The Basic Hund card AND the cloze card both contain "Hund" in renderText.
    expect(ids(r.items)).toEqual([C.hund, C.cloze].sort());
  });

  // must-fix #4: post-rewrite `front:` targets the denormalized PLAINTEXT render
  // column. Empty-front templates generate NO card (generateCards skips them), so
  // no card can ever have an empty renderFrontText — `front:` (empty) is
  // intentionally a no-match. The cloze card's front is the rendered prompt
  // ("Das ist ein […]"), NOT empty.
  test('empty front: → matches nothing (empty-front templates generate no card)', async () => {
    const r = await search(cookie, 'front:');
    expect(ids(r.items)).toEqual([]);
  });

  test('deck: resolves the subtree (German includes B1)', async () => {
    const r = await search(cookie, 'deck:German');
    expect(ids(r.items)).toEqual([C.hund, C.katze, C.cloze].sort());
  });

  test('deck: leaf', async () => {
    const r = await search(cookie, 'deck:French');
    // includes suspended Merci (search does not auto-exclude suspended)
    expect(ids(r.items)).toEqual([C.bonjour, C.suspended].sort());
  });

  test('deck: unknown name → no rows', async () => {
    const r = await search(cookie, 'deck:Nonexistent');
    expect(r.items).toEqual([]);
  });

  test('tag: membership (note-level)', async () => {
    const r = await search(cookie, 'tag:noun');
    expect(ids(r.items)).toEqual([C.hund, C.katze].sort());
  });

  test('tag:none → cards whose note has no tags', async () => {
    const r = await search(cookie, 'tag:none');
    expect(ids(r.items)).toEqual([C.bonjour]);
  });

  test('tag: prefix wildcard', async () => {
    const r = await search(cookie, 'tag:a*');
    expect(ids(r.items)).toEqual([C.hund, C.cloze].sort()); // a1, a2
  });

  test('is:new', async () => {
    const r = await search(cookie, 'is:new');
    expect(ids(r.items)).toEqual([C.bonjour]);
  });

  test('is:learn covers learning + relearning', async () => {
    const r = await search(cookie, 'is:learn');
    expect(ids(r.items)).toEqual([C.katze]);
  });

  test('is:review', async () => {
    const r = await search(cookie, 'is:review');
    expect(ids(r.items)).toEqual([C.hund, C.cloze, C.suspended].sort());
  });

  test('is:due → due<=now AND not suspended', async () => {
    const r = await search(cookie, 'is:due');
    // hund (overdue), cloze (overdue). suspended Merci excluded though overdue.
    expect(ids(r.items)).toEqual([C.hund, C.cloze].sort());
  });

  test('is:suspended', async () => {
    const r = await search(cookie, 'is:suspended');
    expect(ids(r.items)).toEqual([C.suspended]);
  });

  test('variant:cloze (alias → note-type kind)', async () => {
    const r = await search(cookie, 'variant:cloze');
    expect(ids(r.items)).toEqual([C.cloze]);
  });

  test('note: matches the note-type name', async () => {
    const r = await search(cookie, 'note:Cloze');
    expect(ids(r.items)).toEqual([C.cloze]);
  });

  test('field:Name=X matches the note field value', async () => {
    const r = await search(cookie, 'field:Back=dog');
    expect(ids(r.items)).toEqual([C.hund]);
  });

  test('template:0 matches first-template cards', async () => {
    const r = await search(cookie, 'template:0');
    // every fixture card is its note's single (ord 0) template.
    expect(ids(r.items)).toEqual(
      [C.hund, C.katze, C.bonjour, C.cloze, C.suspended].sort(),
    );
  });

  test('added:N → created within last N days', async () => {
    const r = await search(cookie, 'added:3');
    // hund (-2d), katze/bonjour/merci (NOW). cloze (-30d) excluded.
    expect(ids(r.items)).toEqual([C.hund, C.katze, C.bonjour, C.suspended].sort());
  });

  test('edited:N → updated within last N days', async () => {
    const r = await search(cookie, 'edited:1');
    // cloze updated -1d (boundary inclusive), katze/bonjour/merci at NOW. hund -2d excluded.
    expect(ids(r.items)).toEqual([C.katze, C.bonjour, C.cloze, C.suspended].sort());
  });

  test('prop:lapses>=8', async () => {
    const r = await search(cookie, 'prop:lapses>=8');
    expect(ids(r.items)).toEqual([C.cloze]);
  });

  test('prop:reps<2', async () => {
    const r = await search(cookie, 'prop:reps<2');
    expect(ids(r.items)).toEqual([C.katze, C.bonjour, C.suspended].sort());
  });

  test('prop:ivl maps to scheduledDays', async () => {
    const r = await search(cookie, 'prop:ivl>5');
    expect(ids(r.items)).toEqual([C.hund]); // scheduledDays 10
  });

  test('prop:s (stability) comparator', async () => {
    const r = await search(cookie, 'prop:s>10');
    expect(ids(r.items)).toEqual([C.hund]); // stability 12.5
  });

  test('prop:d (difficulty) comparator', async () => {
    const r = await search(cookie, 'prop:d>=4');
    expect(ids(r.items)).toEqual([C.hund]); // difficulty 4.2
  });

  test('prop:due relative day offset (due within 3 days)', async () => {
    const r = await search(cookie, 'prop:due<=3');
    // hund(-1d), cloze(-2d), katze(+3d), suspended(-1d). bonjour(+10d) excluded.
    expect(ids(r.items)).toEqual([C.hund, C.cloze, C.katze, C.suspended].sort());
  });

  test('AND (implicit) — tag:noun deck:German', async () => {
    const r = await search(cookie, 'tag:noun deck:German');
    expect(ids(r.items)).toEqual([C.hund, C.katze].sort());
  });

  test('OR', async () => {
    const r = await search(cookie, 'front:Hund OR front:Bonjour');
    expect(ids(r.items)).toEqual([C.hund, C.bonjour].sort());
  });

  test('negation -tag:noun within deck', async () => {
    const r = await search(cookie, 'deck:German -tag:noun');
    expect(ids(r.items)).toEqual([C.cloze]);
  });

  test('grouping ( ) with OR', async () => {
    const r = await search(cookie, 'deck:French (front:Bonjour OR front:Merci)');
    expect(ids(r.items)).toEqual([C.bonjour, C.suspended].sort());
  });

  test('empty q → full list (all cards incl suspended)', async () => {
    const r = await search(cookie, '');
    expect(ids(r.items)).toEqual([C.hund, C.katze, C.bonjour, C.cloze, C.suspended].sort());
  });

  test('whitespace q → full list', async () => {
    const r = await search(cookie, '   ');
    expect(r.items.length).toBe(5);
  });
});

describe('GET /cards/search — sort, cursor, validation', () => {
  let cookie: string;
  let deck: string;
  const meta = new Map<string, NoteMeta>();

  beforeEach(async () => {
    await resetTestDb();
    meta.clear();
    const u = await signUpAndCookie(app, uniqueEmail('sort'));
    cookie = u.cookie;
    deck = await freshDeck(cookie, 'D');
  });

  test('invalid sort field → 400', async () => {
    const res = await callApp(app, 'GET', `/cards/search?sort=bogus%20asc`, { cookie });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('bad_sort');
  });

  test('invalid sort dir → 400', async () => {
    const res = await callApp(app, 'GET', `/cards/search?sort=created%20sideways`, { cookie });
    expect(res.status).toBe(400);
  });

  test('query too long → 400 bad_query', async () => {
    const long = 'a'.repeat(1001);
    const res = await callApp(app, 'GET', `/cards/search?q=${long}`, { cookie });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('bad_query');
  });

  test('default sort is created desc', async () => {
    const a = await seedCard(cookie, deck, { fields: { Front: 'a', Back: 'b' }, createdAt: new Date(NOW_MS - 3 * DAY) }, meta);
    const b = await seedCard(cookie, deck, { fields: { Front: 'b', Back: 'b' }, createdAt: new Date(NOW_MS - 1 * DAY) }, meta);
    const c = await seedCard(cookie, deck, { fields: { Front: 'c', Back: 'b' }, createdAt: new Date(NOW_MS - 2 * DAY) }, meta);
    const r = await search(cookie, '');
    expect(r.items.map((i) => i.id)).toEqual([b, c, a]); // newest first
  });

  test('sort=front asc', async () => {
    const z = await seedCard(cookie, deck, { fields: { Front: 'zebra', Back: 'b' } }, meta);
    const a = await seedCard(cookie, deck, { fields: { Front: 'apple', Back: 'b' } }, meta);
    const m = await seedCard(cookie, deck, { fields: { Front: 'mango', Back: 'b' } }, meta);
    const r = await search(cookie, '', '&sort=front%20asc');
    expect(r.items.map((i) => i.id)).toEqual([a, m, z]);
  });

  test('tied-lapses keyset pagination has no dupes or drops', async () => {
    // 5 cards all with lapses=3 (a hard tie on the sort key).
    const all: string[] = [];
    for (let i = 0; i < 5; i++) {
      all.push(await seedCard(cookie, deck, { fields: { Front: `f${i}`, Back: 'b' }, lapses: 3 }, meta));
    }
    // Add a couple with different lapses to ensure ordering still partitions.
    all.push(await seedCard(cookie, deck, { fields: { Front: 'low', Back: 'b' }, lapses: 1 }, meta));
    all.push(await seedCard(cookie, deck, { fields: { Front: 'high', Back: 'b' }, lapses: 9 }, meta));

    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const extra = `&sort=lapses%20desc&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = await search(cookie, '', extra);
      for (const it of page.items) seen.push(it.id as string);
      cursor = page.nextCursor;
      if (++guard > 20) throw new Error('pagination did not terminate');
    } while (cursor);

    // No drops: every card seen. No dupes: unique count equals total.
    expect(seen.length).toBe(all.length);
    expect(new Set(seen).size).toBe(all.length);
    expect([...seen].sort()).toEqual([...all].sort());
  });

  // C-1: page through a `field:`-filtered result with ties on the sort column →
  // the cross-table EXISTS predicate must compose with the tuple-keyset cursor
  // with NO dupes / NO skips.
  test('field:-filtered keyset pagination (with sort-column ties) has no dupes or drops', async () => {
    const matching: string[] = [];
    // 6 cards all sharing Back=common AND lapses=2 (hard ties on both the EXISTS
    // filter column and the sort column).
    for (let i = 0; i < 6; i++) {
      matching.push(
        await seedCard(cookie, deck, { fields: { Front: `m${i}`, Back: 'common' }, lapses: 2 }, meta),
      );
    }
    // Decoys that the field: filter must exclude.
    await seedCard(cookie, deck, { fields: { Front: 'd1', Back: 'other' }, lapses: 2 }, meta);
    await seedCard(cookie, deck, { fields: { Front: 'd2', Back: 'other' }, lapses: 9 }, meta);

    const seen: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    do {
      const extra = `&sort=lapses%20desc&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page = await search(cookie, 'field:Back=common', extra);
      for (const it of page.items) seen.push(it.id as string);
      cursor = page.nextCursor;
      if (++guard > 20) throw new Error('pagination did not terminate');
    } while (cursor);

    expect(seen.length).toBe(matching.length);
    expect(new Set(seen).size).toBe(matching.length);
    expect([...seen].sort()).toEqual([...matching].sort());
  });

  test('cross-user isolation', async () => {
    const mine = await seedCard(cookie, deck, { fields: { Front: 'mine', Back: 'b' } }, meta);

    const other = await signUpAndCookie(app, uniqueEmail('other'));
    const otherDeck = await freshDeck(other.cookie, 'Theirs');
    await seedCard(other.cookie, otherDeck, { fields: { Front: 'theirs', Back: 'b' } }, new Map());

    const r = await search(cookie, '');
    expect(ids(r.items)).toEqual([mine]);
  });
});

// ── AST parity: client predicate (in-memory) vs server SQL (same pinned now) ──

describe('AST parity', () => {
  let cookie: string;
  let allRows: Array<Record<string, unknown>>;
  const meta = new Map<string, NoteMeta>();
  const deckIdByName = new Map<string, string>();
  const deckRows: Array<{ id: string; parentId: string | null; name: string }> = [];

  beforeEach(async () => {
    await resetTestDb();
    meta.clear();
    const u = await signUpAndCookie(app, uniqueEmail('parity'));
    cookie = u.cookie;
    deckIdByName.clear();
    deckRows.length = 0;

    const mk = async (name: string, parent?: string) => {
      const id = await freshDeck(cookie, name, parent ? deckIdByName.get(parent) : undefined);
      deckIdByName.set(name, id);
      deckRows.push({ id, parentId: parent ? deckIdByName.get(parent)! : null, name });
      return id;
    };
    await mk('Languages');
    await mk('German', 'Languages');
    await mk('Spanish', 'Languages');

    const g = deckIdByName.get('German')!;
    const s = deckIdByName.get('Spanish')!;
    const l = deckIdByName.get('Languages')!;

    // 15-card fixture spanning states, tags, kinds, props, dates. Each card is one
    // single-template note. Cloze + type-in are included; a mixed-case tag (`Noun`)
    // exercises case-insensitive tag parity on the note.
    await seedCard(cookie, g, { fields: { Front: 'Apfel', Back: 'apple' }, tags: ['noun', 'a1'], state: 'review', reps: 10, lapses: 1, stability: 20, difficulty: 3, scheduledDays: 30, due: new Date(NOW_MS - DAY) }, meta);
    await seedCard(cookie, g, { fields: { Front: 'rennen', Back: 'to run' }, tags: ['verb'], state: 'learning', reps: 2, lapses: 0, due: new Date(NOW_MS + DAY) }, meta);
    await seedCard(cookie, g, { fields: { Front: 'Buch', Back: 'book' }, tags: ['noun', 'a2'], state: 'new', reps: 0, due: new Date(NOW_MS + 5 * DAY) }, meta);
    await seedCard(cookie, g, { kind: 'cloze', fields: { Text: 'Ich {{c1::lese}} ein Buch', Extra: '' }, tags: ['verb', 'cloze'], state: 'review', reps: 4, lapses: 5, due: new Date(NOW_MS - 3 * DAY), createdAt: new Date(NOW_MS - 40 * DAY) }, meta);
    await seedCard(cookie, s, { fields: { Front: 'gato', Back: 'cat' }, tags: ['noun'], state: 'review', reps: 7, lapses: 8, stability: 5, due: new Date(NOW_MS - 2 * DAY), suspended: true }, meta);
    await seedCard(cookie, s, { fields: { Front: 'correr', Back: 'to run' }, tags: ['verb'], state: 'relearning', reps: 3, lapses: 4, due: new Date(NOW_MS - DAY) }, meta);
    await seedCard(cookie, s, { kind: 'typein', fields: { Front: 'casa', Back: 'house' }, tags: [], state: 'new', reps: 0, due: new Date(NOW_MS + 2 * DAY) }, meta);
    await seedCard(cookie, l, { fields: { Front: 'meta', Back: 'top-level' }, tags: ['meta'], state: 'review', reps: 1, lapses: 0, due: new Date(NOW_MS) }, meta);
    await seedCard(cookie, g, { fields: { Front: 'Wasser', Back: 'water' }, tags: ['noun', 'a1'], state: 'review', reps: 6, lapses: 2, scheduledDays: 14, due: new Date(NOW_MS + 7 * DAY), createdAt: new Date(NOW_MS - 5 * DAY), updatedAt: new Date(NOW_MS - 2 * DAY) }, meta);
    await seedCard(cookie, g, { fields: { Front: 'Hund', Back: 'dog' }, tags: ['noun'], state: 'learning', reps: 1, lapses: 0, due: new Date(NOW_MS - DAY) }, meta);
    await seedCard(cookie, s, { fields: { Front: 'perro', Back: 'dog' }, tags: ['noun', 'a1'], state: 'review', reps: 9, lapses: 3, stability: 40, difficulty: 6, scheduledDays: 60, due: new Date(NOW_MS - 10 * DAY) }, meta);
    await seedCard(cookie, s, { fields: { Front: 'libro', Back: 'book' }, tags: ['noun', 'a2'], state: 'new', reps: 0, due: new Date(NOW_MS + 4 * DAY), createdAt: new Date(NOW_MS - DAY) }, meta);
    await seedCard(cookie, g, { fields: { Front: 'gehen', Back: 'to go' }, tags: ['verb', 'a1'], state: 'review', reps: 5, lapses: 1, due: new Date(NOW_MS - 4 * DAY), updatedAt: new Date(NOW_MS - 6 * DAY) }, meta);
    await seedCard(cookie, g, { fields: { Front: 'Katze', Back: 'cat' }, tags: [], state: 'new', reps: 0, due: new Date(NOW_MS + 8 * DAY) }, meta);
    // Mixed-case tag: exercises case-insensitive exact-match parity (`tag:noun` /
    // `tag:Noun` must both hit this card on client AND server).
    await seedCard(cookie, g, { fields: { Front: 'Vogel', Back: 'bird' }, tags: ['Noun'], state: 'review', reps: 2, lapses: 0, due: new Date(NOW_MS - DAY) }, meta);

    // Fetch the full fixture (use a big limit so the predicate sees every row).
    const r = await search(cookie, '', '&limit=1000');
    allRows = r.items;
    expect(allRows.length).toBe(15);
  });

  function resolveDeckIds(value: string, nested: boolean): string[] {
    const lower = value.toLowerCase();
    const matched = deckRows.filter((d) => d.name.toLowerCase() === lower);
    if (matched.length === 0) return [];
    const descOf = (id: string): string[] => {
      const kids = deckRows.filter((d) => d.parentId === id).map((d) => d.id);
      return kids.flatMap((k) => [k, ...descOf(k)]);
    };
    const out = new Set<string>();
    for (const m of matched) {
      out.add(m.id);
      if (nested) for (const id of descOf(m.id)) out.add(id);
    }
    return [...out];
  }

  const QUERIES = [
    'apple',
    'front:Buch',
    'back:to run',
    'cloze:lese',
    'field:Back=book',
    'note:Cloze',
    'note:Type-in',
    'template:0',
    'deck:German',
    'deck:Languages',
    'deck:Spanish',
    'tag:noun',
    'tag:Noun',
    'tag:none',
    'tag:a*',
    'is:new',
    'is:learn',
    'is:review',
    'is:due',
    'is:suspended',
    'variant:cloze',
    'variant:type',
    'added:6',
    'edited:3',
    'prop:lapses>=3',
    'prop:reps<2',
    'prop:ivl>=14',
    'prop:due<=2',
    'deck:German -tag:noun',
    'tag:noun OR tag:verb',
    'is:review prop:lapses>1',
    'front:', // must-fix #4: empty-front → both back-ends match nothing
  ];

  test('each query yields identical id sets across both back-ends', async () => {
    for (const q of QUERIES) {
      // server side: SQL WHERE built from the AST.
      const r = await search(cookie, q, '&limit=1000');
      const serverIds = ids(r.items);

      // client side: in-memory predicate built from the SAME AST + pinned now.
      const pred = buildCardPredicate(parseCardQuery(q), {
        now: NOW_MS,
        resolveDeckIds,
      });
      const clientIds = allRows
        .filter((row) => pred(toCardLike(row, meta.get(row.id as string)!)))
        .map((row) => row.id as string)
        .sort();

      expect(clientIds, `query: ${q}`).toEqual(serverIds);
    }
  });

  // must-fix #5: the predicate consumes the SERVER-STORED render columns
  // VERBATIM (no client re-render drift). Prove it directly: the CardLike text
  // fields equal the server card row's stored render* columns for every card.
  test('predicate text fields equal the server-stored render columns (no re-render)', async () => {
    // Sanity: the stored render columns reflect real generation (not blank).
    const clozeRow = allRows.find((row) => meta.get(row.id as string)!.noteTypeKind === 'cloze')!;
    expect(clozeRow.renderFrontText).toContain('[…]'); // cloze blank, server-rendered
    expect(clozeRow.renderBackText).toContain('lese'); // cloze revealed, server-rendered

    for (const row of allRows) {
      const like = toCardLike(row, meta.get(row.id as string)!);
      expect(like.renderText).toBe(row.renderText as string);
      expect(like.renderFrontText).toBe(row.renderFrontText as string);
      expect(like.renderBackText).toBe(row.renderBackText as string);
    }
  });

  // Cross-check: the server-stored render columns match what the shared engine
  // would produce — i.e. the SQL search columns came from the real generator, and
  // the predicate (reading those same columns) can never diverge from the server.
  test('server-stored render columns are the generated plaintext (not the raw field value)', async () => {
    const clozeRow = allRows.find((row) => meta.get(row.id as string)!.noteTypeKind === 'cloze')!;
    const m = meta.get(clozeRow.id as string)!;
    // The raw field value still contains cloze markup; the stored render columns
    // do NOT (they are the generated, cloze-stripped plaintext).
    expect(m.fieldValues.Text).toContain('{{c1::');
    expect(clozeRow.renderText).not.toContain('{{c1::');
  });
});
