// Reading-workflow TEXT marks (M5 / T1) — `source_marks` CRUD: highlight/note
// rows with a selected `quote`, normalized `rects`, a palette `color`, and (for
// notes) a freeform `note` body.
//
// CONTRACT (read from apps/api/src/modules/notebooks.ts sourcesModule + the
// shared annotations caps/colors, NOT invented):
//   * POST /sources/:id/marks body { page, kind, quote, rects, color?, note? }
//     — validation runs in the handler (the wire schema keeps `rects:
//     t.Unknown()` etc. permissive so a structural failure returns OUR 400
//     `invalid_mark`, not Elysia's generic validation error):
//       - kind ∈ {highlight,note} (else invalid_mark)
//       - color ∈ SOURCE_MARK_COLORS, default 'lime' (else invalid_mark)
//       - rects: 1..MARK_RECTS_MAX, each x/y/w/h finite in [0,1] (else invalid_mark)
//       - quote trimmed non-empty (else invalid_mark); re-capped MARK_QUOTE_MAX
//       - kind 'note' → note re-capped MARK_NOTE_MAX; 'highlight' → note stored null
//       - per-source cap MARKS_PER_SOURCE_CAP (2000) → 409 `too_many_marks`
//     page param 1..10000 (out of range → Elysia 4xx). user-scoped 404.
//   * GET /sources/:id/marks → { items } ordered (page ASC, created_at ASC). 404.
//   * PATCH /sources/:id/marks/:markId { color?, note? } — nothing → 400
//     `nothing_to_update`; bad color → 400 invalid_mark; foreign source/mark → 404.
//   * DELETE /sources/:id/marks/:markId → { ok:true }; second delete → 404.
//   * Foreign source → 404 on all five routes, and no rows created under the
//     attacker's id.
//
// Direct-DB fixtures mirror source-annotations.test.ts / notebooks.test.ts.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  db,
  notebooks as notebooksTable,
  sourceMarks as sourceMarksTable,
  sources as sourcesTable,
} from '@reomi/db';
import {
  MARK_NOTE_MAX,
  MARK_QUOTE_MAX,
  MARK_RECTS_MAX,
  SOURCE_MARK_COLORS,
  type MarkRect,
} from '@reomi/shared';
import { and, eq } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

// The per-source cap is a module-level const in notebooks.ts (not env-driven),
// so the 409 test seeds exactly this many rows directly then POSTs one more.
const MARKS_PER_SOURCE_CAP = 2000;

// ── fixtures ──────────────────────────────────────────────────────────────────

async function freshNotebook(userId: string, title = 'NB'): Promise<string> {
  const [nb] = await db
    .insert(notebooksTable)
    .values({ userId, title })
    .returning({ id: notebooksTable.id });
  return nb!.id;
}

/**
 * Seed a READY pdf source row directly. Sources are user-level now (library
 * refactor) — marks are source-scoped, so the notebook arg is no longer needed.
 */
async function seedSource(userId: string, _notebookId: string, title = 'Doc'): Promise<string> {
  const [src] = await db
    .insert(sourcesTable)
    .values({
      userId,
      kind: 'pdf',
      title,
      status: 'ready',
      verified: true,
      storageKey: `source/placeholder-${crypto.randomUUID()}`,
      mime: 'application/pdf',
    })
    .returning({ id: sourcesTable.id });
  return src!.id;
}

/** A single valid normalized rect. */
function rect(over: Partial<MarkRect> = {}): MarkRect {
  return { x: 0.1, y: 0.2, w: 0.3, h: 0.04, ...over };
}

/** A structurally-valid POST body; override any field. */
function markBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    page: 1,
    kind: 'highlight',
    quote: 'the selected text',
    rects: [rect()],
    ...over,
  };
}

function postMark(cookie: string, sourceId: string, body: unknown) {
  return callApp(app, 'POST', `/sources/${sourceId}/marks`, { cookie, body });
}
function getMarks(cookie: string, sourceId: string) {
  return callApp(app, 'GET', `/sources/${sourceId}/marks`, { cookie });
}
function patchMark(cookie: string, sourceId: string, markId: string, body: unknown) {
  return callApp(app, 'PATCH', `/sources/${sourceId}/marks/${markId}`, { cookie, body });
}
function deleteMark(cookie: string, sourceId: string, markId: string) {
  return callApp(app, 'DELETE', `/sources/${sourceId}/marks/${markId}`, { cookie });
}

// ── POST validation matrix ───────────────────────────────────────────────────

describe('POST /sources/:id/marks — validation → 400 invalid_mark', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {});

  test('a bad kind → 400 invalid_mark', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    const res = await postMark(cookie, sourceId, markBody({ kind: 'underline' }));
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_mark');
  });

  test('an off-list color → 400 invalid_mark', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    for (const color of ['red', '#ff0000', 'green', 'LIME']) {
      const res = await postMark(cookie, sourceId, markBody({ color }));
      expect(res.status).toBe(400);
      expect((await res.json<{ error: string }>()).error).toBe('invalid_mark');
    }
  });

  test('rects empty → 400 invalid_mark', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    const res = await postMark(cookie, sourceId, markBody({ rects: [] }));
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_mark');
  });

  test('rects too many (> MARK_RECTS_MAX) → 400 invalid_mark', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    const rects = Array.from({ length: MARK_RECTS_MAX + 1 }, () => rect());
    const res = await postMark(cookie, sourceId, markBody({ rects }));
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_mark');
  });

  test('a non-finite / out-of-[0..1] rect coordinate → 400 invalid_mark', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    // x out of [0,1].
    const over = await postMark(cookie, sourceId, markBody({ rects: [rect({ x: 1.5 })] }));
    expect(over.status).toBe(400);
    expect((await over.json<{ error: string }>()).error).toBe('invalid_mark');

    // negative h.
    const negative = await postMark(cookie, sourceId, markBody({ rects: [rect({ h: -0.1 })] }));
    expect(negative.status).toBe(400);

    // a non-numeric (string) coordinate — not a finite number → reject.
    const nonNumeric = await postMark(cookie, sourceId, markBody({
      rects: [{ x: 'a' as unknown as number, y: 0.2, w: 0.3, h: 0.04 }],
    }));
    expect(nonNumeric.status).toBe(400);

    // a missing field (undefined coordinate) → reject.
    const missing = await postMark(cookie, sourceId, markBody({ rects: [{ x: 0.1, y: 0.2, w: 0.3 }] }));
    expect(missing.status).toBe(400);
  });

  test('page 0 → 4xx (route minimum:1, not our 400 body)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    const res = await postMark(cookie, sourceId, markBody({ page: 0 }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test('a whitespace-only quote → 400 invalid_mark', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    const res = await postMark(cookie, sourceId, markBody({ quote: '   ' }));
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_mark');
  });

  test('kind "card" is rejected → 400 invalid_mark (clients never create card markers)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    const res = await postMark(cookie, sourceId, markBody({ kind: 'card' }));
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_mark');
    // No row created.
    const rows = await db
      .select()
      .from(sourceMarksTable)
      .where(eq(sourceMarksTable.sourceId, sourceId));
    expect(rows.length).toBe(0);
  });
});

// ── POST happy path + server-side caps ───────────────────────────────────────

describe('POST /sources/:id/marks — happy path + server-side caps', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('a highlight row: defaults color lime, note null', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    const res = await postMark(cookie, sourceId, markBody({ kind: 'highlight', quote: 'photosynthesis' }));
    expect(res.status).toBe(200);
    const row = await res.json<{
      id: string;
      kind: string;
      quote: string;
      color: string;
      note: string | null;
      page: number;
      rects: MarkRect[];
    }>();
    expect(row.kind).toBe('highlight');
    expect(row.quote).toBe('photosynthesis');
    expect(row.color).toBe('lime'); // default
    expect(row.note).toBeNull(); // highlight stores null note
    expect(row.page).toBe(1);
    expect(row.rects[0]!.x).toBe(0.1);
  });

  test('a note row: explicit color + note body persisted', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    const res = await postMark(cookie, sourceId, markBody({
      kind: 'note',
      color: 'amber',
      quote: 'a quoted span',
      note: 'my note about this',
      page: 4,
    }));
    expect(res.status).toBe(200);
    const row = await res.json<{ kind: string; color: string; note: string | null; page: number }>();
    expect(row.kind).toBe('note');
    expect(row.color).toBe('amber');
    expect(row.note).toBe('my note about this');
    expect(row.page).toBe(4);
  });

  test('a note with an empty note body ("") is allowed (stored "")', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    const res = await postMark(cookie, sourceId, markBody({ kind: 'note', note: '' }));
    expect(res.status).toBe(200);
    expect((await res.json<{ note: string | null }>()).note).toBe('');
  });

  test('every SOURCE_MARK_COLORS value is accepted', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    for (const color of SOURCE_MARK_COLORS) {
      const res = await postMark(cookie, sourceId, markBody({ color }));
      expect(res.status).toBe(200);
      expect((await res.json<{ color: string }>()).color).toBe(color);
    }
  });

  test('quote re-capped to MARK_QUOTE_MAX server-side', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    // The wire schema bounds quote to MARK_QUOTE_MAX + 1; send exactly that (the
    // largest accepted payload) so the handler's `.slice(0, MARK_QUOTE_MAX)` is
    // the thing that trims it, not Elysia's generic validation 400.
    const huge = 'q'.repeat(MARK_QUOTE_MAX + 1);
    const res = await postMark(cookie, sourceId, markBody({ quote: huge }));
    expect(res.status).toBe(200);
    const stored = (
      await db
        .select({ quote: sourceMarksTable.quote })
        .from(sourceMarksTable)
        .where(eq(sourceMarksTable.sourceId, sourceId))
    )[0]!.quote;
    expect(stored.length).toBe(MARK_QUOTE_MAX);
  });

  test('note re-capped to MARK_NOTE_MAX server-side', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    // The wire schema bounds note to MARK_NOTE_MAX + 1; the handler `.slice`s it.
    const huge = 'n'.repeat(MARK_NOTE_MAX + 1);
    const res = await postMark(cookie, sourceId, markBody({ kind: 'note', note: huge }));
    expect(res.status).toBe(200);
    const stored = (
      await db
        .select({ note: sourceMarksTable.note })
        .from(sourceMarksTable)
        .where(eq(sourceMarksTable.sourceId, sourceId))
    )[0]!.note!;
    expect(stored.length).toBe(MARK_NOTE_MAX);
  });

  test('per-source cap reached → 409 too_many_marks', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    // Seed exactly the cap directly (one batch insert) so the next POST trips 409.
    const bulk = Array.from({ length: MARKS_PER_SOURCE_CAP }, () => ({
      userId,
      sourceId,
      page: 1,
      kind: 'highlight',
      quote: 'x',
      rects: [rect()] as MarkRect[],
      color: 'lime',
      note: null,
    }));
    await db.insert(sourceMarksTable).values(bulk);

    const res = await postMark(cookie, sourceId, markBody());
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toBe('too_many_marks');
  });
});

// ── GET ordering ──────────────────────────────────────────────────────────────

describe('GET /sources/:id/marks — ordering (page ASC, created_at ASC)', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('rows order by page then created_at', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));

    // Insert out of page order: page 3 first, then two page-1 rows in time order.
    await postMark(cookie, sourceId, markBody({ page: 3, quote: 'p3' }));
    await postMark(cookie, sourceId, markBody({ page: 1, quote: 'p1-first' }));
    await postMark(cookie, sourceId, markBody({ page: 1, quote: 'p1-second' }));

    const res = await getMarks(cookie, sourceId);
    expect(res.status).toBe(200);
    const { items } = await res.json<{ items: { page: number; quote: string }[] }>();
    expect(items.map((i) => i.page)).toEqual([1, 1, 3]);
    // Within page 1, created_at order is preserved.
    expect(items[0]!.quote).toBe('p1-first');
    expect(items[1]!.quote).toBe('p1-second');
    expect(items[2]!.quote).toBe('p3');
  });

  test('empty source → { items: [] }', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    const res = await getMarks(cookie, sourceId);
    expect(res.status).toBe(200);
    expect((await res.json<{ items: unknown[] }>()).items).toEqual([]);
  });
});

// ── PATCH color / note ────────────────────────────────────────────────────────

describe('PATCH /sources/:id/marks/:markId — color/note', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('patch the color', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    const markId = (await (await postMark(cookie, sourceId, markBody({ color: 'lime' }))).json<{ id: string }>()).id;

    const res = await patchMark(cookie, sourceId, markId, { color: 'rose' });
    expect(res.status).toBe(200);
    expect((await res.json<{ color: string }>()).color).toBe('rose');
  });

  test('patch the note body', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    const markId = (await (await postMark(cookie, sourceId, markBody({ kind: 'note', note: 'old' }))).json<{ id: string }>()).id;

    const res = await patchMark(cookie, sourceId, markId, { note: 'updated note' });
    expect(res.status).toBe(200);
    expect((await res.json<{ note: string | null }>()).note).toBe('updated note');
  });

  test('patch both color and note in one request', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    const markId = (await (await postMark(cookie, sourceId, markBody({ kind: 'note', color: 'lime', note: 'a' }))).json<{ id: string }>()).id;

    const res = await patchMark(cookie, sourceId, markId, { color: 'sky', note: 'b' });
    expect(res.status).toBe(200);
    const row = await res.json<{ color: string; note: string | null }>();
    expect(row.color).toBe('sky');
    expect(row.note).toBe('b');
  });

  test('an off-list color in PATCH → 400 invalid_mark', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    const markId = (await (await postMark(cookie, sourceId, markBody())).json<{ id: string }>()).id;
    const res = await patchMark(cookie, sourceId, markId, { color: 'chartreuse' });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_mark');
  });

  test('empty body → 400 nothing_to_update', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    const markId = (await (await postMark(cookie, sourceId, markBody())).json<{ id: string }>()).id;
    const res = await patchMark(cookie, sourceId, markId, {});
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('nothing_to_update');
  });

  test('a foreign / unknown markId → 404', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    const missing = '00000000-0000-4000-8000-000000000000';
    const res = await patchMark(cookie, sourceId, missing, { color: 'rose' });
    expect(res.status).toBe(404);
    expect((await res.json<{ error: string }>()).error).toBe('not_found');
  });

  test('a kind "card" marker is immutable → PATCH rejected 400 invalid_mark', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    // Seed a card marker directly (clients never create them via POST).
    const [marker] = await db
      .insert(sourceMarksTable)
      .values({
        userId,
        sourceId,
        page: 1,
        kind: 'card',
        quote: 'the card back excerpt',
        rects: [rect()] as MarkRect[],
        color: 'lime',
      })
      .returning({ id: sourceMarksTable.id });

    // A color edit is rejected (the marker is immutable).
    const color = await patchMark(cookie, sourceId, marker!.id, { color: 'rose' });
    expect(color.status).toBe(400);
    expect((await color.json<{ error: string }>()).error).toBe('invalid_mark');

    // A note edit is rejected too.
    const note = await patchMark(cookie, sourceId, marker!.id, { note: 'hi' });
    expect(note.status).toBe(400);
    expect((await note.json<{ error: string }>()).error).toBe('invalid_mark');

    // The row is unchanged.
    const [unchanged] = await db
      .select({ color: sourceMarksTable.color })
      .from(sourceMarksTable)
      .where(eq(sourceMarksTable.id, marker!.id));
    expect(unchanged!.color).toBe('lime');
  });
});

// ── card markers: DELETE allowed; CASCADE on card delete ──────────────────────

describe('source_marks — kind "card" markers (DELETE allowed)', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('a card marker can be DELETEd (removes the marker, not the card)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    const [marker] = await db
      .insert(sourceMarksTable)
      .values({
        userId,
        sourceId,
        page: 1,
        kind: 'card',
        quote: 'back excerpt',
        rects: [rect()] as MarkRect[],
        color: 'lime',
      })
      .returning({ id: sourceMarksTable.id });

    const res = await deleteMark(cookie, sourceId, marker!.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const rows = await db
      .select()
      .from(sourceMarksTable)
      .where(eq(sourceMarksTable.id, marker!.id));
    expect(rows.length).toBe(0);
  });
});

// ── DELETE (+ idempotent 404) ─────────────────────────────────────────────────

describe('DELETE /sources/:id/marks/:markId', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('delete a mark → { ok }, the row is gone; second delete → 404', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    const markId = (await (await postMark(cookie, sourceId, markBody())).json<{ id: string }>()).id;

    const first = await deleteMark(cookie, sourceId, markId);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });

    // The row is gone.
    const rows = await db
      .select()
      .from(sourceMarksTable)
      .where(eq(sourceMarksTable.id, markId));
    expect(rows.length).toBe(0);

    // A second delete of the now-missing mark → 404 (idempotent-but-honest).
    const second = await deleteMark(cookie, sourceId, markId);
    expect(second.status).toBe(404);
    expect((await second.json<{ error: string }>()).error).toBe('not_found');
  });
});

// ── user scoping: foreign source 404 on all five routes ──────────────────────

describe('marks — user scoping (foreign source 404 everywhere)', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('all five routes 404 a foreign source AND create no rows under the attacker', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    // B owns the source + one mark.
    const sourceId = await seedSource(b.userId, await freshNotebook(b.userId));
    const bMarkId = (await (await postMark(b.cookie, sourceId, markBody())).json<{ id: string }>()).id;

    // A (the attacker) is 404 on every route — never leaks existence.
    const post = await postMark(a.cookie, sourceId, markBody());
    expect(post.status).toBe(404);
    expect(await post.json()).toEqual({ error: 'not_found' });

    const get = await getMarks(a.cookie, sourceId);
    expect(get.status).toBe(404);
    expect(await get.json()).toEqual({ error: 'not_found' });

    const patch = await patchMark(a.cookie, sourceId, bMarkId, { color: 'rose' });
    expect(patch.status).toBe(404);

    const del = await deleteMark(a.cookie, sourceId, bMarkId);
    expect(del.status).toBe(404);

    // B (the owner) is NOT 404.
    expect((await getMarks(b.cookie, sourceId)).status).toBe(200);

    // The attacker's POST never created a row under A's id, AND B's mark is intact.
    const aRows = await db
      .select()
      .from(sourceMarksTable)
      .where(eq(sourceMarksTable.userId, a.userId));
    expect(aRows.length).toBe(0);
    const bRows = await db
      .select()
      .from(sourceMarksTable)
      .where(and(eq(sourceMarksTable.sourceId, sourceId), eq(sourceMarksTable.userId, b.userId)));
    expect(bRows.length).toBe(1);
    expect(bRows[0]!.id).toBe(bMarkId);
  });

  test('a non-existent source id → 404 on POST and GET', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const missing = '00000000-0000-4000-8000-000000000000';
    expect((await postMark(cookie, missing, markBody())).status).toBe(404);
    expect((await getMarks(cookie, missing)).status).toBe(404);
  });
});
