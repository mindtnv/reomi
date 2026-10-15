// PDF reader ink annotations — server routes (M4 / T3).
//
// CONTRACT (read from apps/api/src/modules/notebooks.ts sourcesModule + the
// shared annotations types, NOT invented):
//   * PUT /sources/:id/annotations/:page body { strokes: PageAnnotations;
//     markedText? } — `validateStrokes` runs in the handler (the wire schema is
//     `strokes: t.Unknown()` so a structural failure returns OUR 400
//     `invalid_annotation`, not Elysia's generic validation error):
//       - body must be { v:1, strokes: InkStroke[] }
//       - each stroke: tool ∈ {pen,highlighter}, color /^#[0-9a-f]{6}$/i, width
//         finite > 0, points a flat finite-number list whose length % 3 === 0,
//         with x/y (index %3 !== 2) clamped to [0,1].
//       - > ANNOTATION_MAX_STROKES strokes OR > ANNOTATION_MAX_POINTS points →
//         invalid_annotation (validateStrokes caps).
//       - JSON.stringify(strokes).length > SOURCE_ANNOTATION_MAX_BYTES → 400
//         `annotation_too_large`.
//     EMPTY strokes array ⇒ DELETE the row → { ok:true, cleared:true }. Else
//     UPSERT on (source_id,page); markedText re-capped MARKED_TEXT_MAX. page
//     param 1..10000 (out of range → Elysia 4xx). user-scoped 404.
//   * GET /sources/:id/annotations → { items:[{ page, strokes, markedText,
//     updatedAt }] } ordered by page. user-scoped 404.
//   * GET /sources/:id/file → streams the original bytes for sources with a
//     storageKey; url/text (no storageKey) → 404; foreign → 404. (No storage
//     test seam exists in storage.ts — `getObjectBytes` hits S3 directly — so the
//     byte-roundtrip is NOT exercised; only the 404 paths are. See file note.)
//
// Direct-DB fixtures mirror notebook-chat.test.ts / notebooks.test.ts.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  db,
  notebooks as notebooksTable,
  sourceAnnotations as sourceAnnotationsTable,
  sources as sourcesTable,
} from '@reomi/db';
import {
  ANNOTATION_MAX_POINTS,
  ANNOTATION_MAX_STROKES,
  MARKED_TEXT_MAX,
  type InkStroke,
  type PageAnnotations,
} from '@reomi/shared';
import { and, eq } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import { env } from '../src/env.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

// ── fixtures ──────────────────────────────────────────────────────────────────

async function freshNotebook(userId: string, title = 'NB'): Promise<string> {
  const [nb] = await db
    .insert(notebooksTable)
    .values({ userId, title })
    .returning({ id: notebooksTable.id });
  return nb!.id;
}

/**
 * Seed a source row directly. Defaults to a `pdf` upload-kind source WITH a
 * storageKey (the only kind GET /sources/:id/file serves); pass `kind:'text'`
 * for a no-storageKey source (the file route 404 case).
 */
async function seedSource(
  userId: string,
  // Sources are user-level now (library refactor); annotations are source-scoped
  // so the notebook arg is unused (kept for call-site compatibility).
  _notebookId: string,
  opts: {
    title?: string;
    kind?: 'pdf' | 'epub' | 'url' | 'text';
    withStorageKey?: boolean;
    mime?: string;
  } = {},
): Promise<string> {
  const kind = opts.kind ?? 'pdf';
  const withKey = opts.withStorageKey ?? (kind === 'pdf' || kind === 'epub');
  const [src] = await db
    .insert(sourcesTable)
    .values({
      userId,
      kind,
      title: opts.title ?? 'Doc',
      status: 'ready',
      verified: true,
      storageKey: withKey ? `source/placeholder-${crypto.randomUUID()}` : null,
      mime: opts.mime ?? (kind === 'pdf' ? 'application/pdf' : null),
    })
    .returning({ id: sourcesTable.id });
  return src!.id;
}

/** A minimal, structurally-valid one-stroke PageAnnotations. */
function validStroke(over: Partial<InkStroke> = {}): InkStroke {
  return {
    tool: 'pen',
    color: '#ff0000',
    width: 0.003,
    points: [0.1, 0.2, 0.5, 0.3, 0.4, 0.6],
    ...over,
  };
}
function validBody(strokes: InkStroke[] = [validStroke()]): PageAnnotations {
  return { v: 1, strokes };
}

function putAnnotation(
  cookie: string,
  sourceId: string,
  page: number,
  body: unknown,
) {
  return callApp(app, 'PUT', `/sources/${sourceId}/annotations/${page}`, { cookie, body });
}

// ── PUT validation matrix ───────────────────────────────────────────────────

describe('PUT /sources/:id/annotations/:page — structural validation', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {});

  test('rejects a bad tool name → 400 invalid_annotation', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    // `tool: 'marker'` is not pen/highlighter.
    const res = await putAnnotation(cookie, sourceId, 1, {
      strokes: validBody([validStroke({ tool: 'marker' as unknown as InkStroke['tool'] })]),
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_annotation');
  });

  test('rejects a non-#rrggbb color → 400 invalid_annotation', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    for (const color of ['red', '#fff', '#1234567', 'rgb(1,2,3)']) {
      const res = await putAnnotation(cookie, sourceId, 1, {
        strokes: validBody([validStroke({ color })]),
      });
      expect(res.status).toBe(400);
      expect((await res.json<{ error: string }>()).error).toBe('invalid_annotation');
    }
  });

  test('rejects points whose length is not a multiple of 3 → 400 invalid_annotation', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    const res = await putAnnotation(cookie, sourceId, 1, {
      // 5 numbers — not a multiple of 3.
      strokes: validBody([validStroke({ points: [0.1, 0.2, 0.5, 0.3, 0.4] })]),
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_annotation');
  });

  test('rejects NaN / Infinity coordinates → 400 invalid_annotation', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    // JSON cannot carry NaN/Infinity literally; the route parses JSON, so a
    // non-finite slips in only as a string the validator coerces or as a value
    // outside [0,1]. Assert both the non-finite-coerced and the out-of-range
    // clamp paths reject.
    const outOfRange = await putAnnotation(cookie, sourceId, 1, {
      // x = 1.5 is outside the normalized [0,1] clamp (index 0, %3 !== 2).
      strokes: validBody([validStroke({ points: [1.5, 0.2, 0.5] })]),
    });
    expect(outOfRange.status).toBe(400);
    expect((await outOfRange.json<{ error: string }>()).error).toBe('invalid_annotation');

    // A negative y is also out of the clamp.
    const negative = await putAnnotation(cookie, sourceId, 1, {
      strokes: validBody([validStroke({ points: [0.2, -0.1, 0.5] })]),
    });
    expect(negative.status).toBe(400);

    // A non-numeric point value (string) is not a finite number → reject.
    const nonNumeric = await putAnnotation(cookie, sourceId, 1, {
      strokes: validBody([
        validStroke({ points: ['x' as unknown as number, 0.2, 0.5] }),
      ]),
    });
    expect(nonNumeric.status).toBe(400);
  });

  test('rejects a non-{v:1} body (wrong version, non-array strokes) → 400', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    // Wrong schema version.
    const v2 = await putAnnotation(cookie, sourceId, 1, {
      strokes: { v: 2, strokes: [validStroke()] },
    });
    expect(v2.status).toBe(400);
    expect((await v2.json<{ error: string }>()).error).toBe('invalid_annotation');

    // strokes not an array.
    const notArray = await putAnnotation(cookie, sourceId, 1, {
      strokes: { v: 1, strokes: 'nope' },
    });
    expect(notArray.status).toBe(400);
  });

  test('rejects width <= 0 → 400 invalid_annotation', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    const res = await putAnnotation(cookie, sourceId, 1, {
      strokes: validBody([validStroke({ width: 0 })]),
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_annotation');
  });

  test('rejects > ANNOTATION_MAX_STROKES strokes → 400 invalid_annotation', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    // One past the cap; each stroke is tiny (3 points) so the point cap is not
    // the trigger — the stroke-count cap is.
    const strokes = Array.from({ length: ANNOTATION_MAX_STROKES + 1 }, () =>
      validStroke({ points: [0.1, 0.2, 0.5] }),
    );
    const res = await putAnnotation(cookie, sourceId, 1, { strokes: validBody(strokes) });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_annotation');
  });

  test('rejects > ANNOTATION_MAX_POINTS total points → 400 invalid_annotation', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    // A handful of strokes whose point triples sum to just over the point cap,
    // while staying under the stroke-count cap so the point cap is the trigger.
    // Each stroke carries (ANNOTATION_MAX_POINTS / 10 + 1) triples → 11 strokes
    // overshoot the total-points cap. Stay within byte cap by reusing values.
    const triplesPerStroke = Math.ceil(ANNOTATION_MAX_POINTS / 10) + 1;
    const pts: number[] = [];
    for (let i = 0; i < triplesPerStroke; i++) pts.push(0.1, 0.2, 0.5);
    const strokes = Array.from({ length: 11 }, () => validStroke({ points: pts.slice() }));
    const res = await putAnnotation(cookie, sourceId, 1, { strokes: validBody(strokes) });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_annotation');
  });

  test('rejects an oversized JSON payload → 400 annotation_too_large (byte cap)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    // Exercise the byte-cap branch deterministically: a payload that passes the
    // structural validator (within BOTH the stroke and point caps) but whose
    // JSON.stringify(strokes) length exceeds the byte cap. Under the 512 KiB
    // default the point cap (20000 points) bounds the JSON to ~390 KB, so the
    // byte cap is unreachable while staying structurally valid — we temporarily
    // LOWER SOURCE_ANNOTATION_MAX_BYTES (restored in finally) so a modest,
    // structurally-valid payload trips the byte cap, not the structural one.
    const original = env.ai.SOURCE_ANNOTATION_MAX_BYTES;
    try {
      env.ai.SOURCE_ANNOTATION_MAX_BYTES = 50; // tiny cap for this test only
      const body = validBody([
        validStroke({ points: [0.111111, 0.222222, 0.5, 0.333333, 0.444444, 0.6] }),
      ]);
      // Precondition: structurally valid (passes validateStrokes) AND over the
      // lowered byte cap.
      expect(JSON.stringify(body.strokes).length).toBeGreaterThan(50);
      const res = await putAnnotation(cookie, sourceId, 1, { strokes: body });
      expect(res.status).toBe(400);
      expect((await res.json<{ error: string }>()).error).toBe('annotation_too_large');
    } finally {
      env.ai.SOURCE_ANNOTATION_MAX_BYTES = original;
    }
  });

  test('a small coordinate overflow (1.01 / -0.01) is CLAMPED into [0,1], not rejected; persisted strokes carry the clamped values', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    // x = 1.01 (just over 1) and y = -0.01 (just under 0) — both within the
    // ±0.05 tolerance band → CLAMPED to 1 / 0, accepted.
    const res = await putAnnotation(cookie, sourceId, 1, {
      strokes: validBody([validStroke({ points: [1.01, -0.01, 0.5] })]),
    });
    expect(res.status).toBe(200);
    expect((await res.json<{ ok: boolean; cleared: boolean }>()).cleared).toBe(false);

    // The PERSISTED strokes carry the clamped coordinates (not the raw 1.01/-0.01).
    const stored = (
      await db
        .select({ strokes: sourceAnnotationsTable.strokes })
        .from(sourceAnnotationsTable)
        .where(eq(sourceAnnotationsTable.sourceId, sourceId))
    )[0]!.strokes;
    const pts = stored.strokes[0]!.points;
    expect(pts[0]).toBe(1); // 1.01 → 1
    expect(pts[1]).toBe(0); // -0.01 → 0
    expect(pts[2]).toBe(0.5); // pressure untouched
  });

  test('a gross coordinate overflow (5.0) is still rejected → 400 invalid_annotation', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    const res = await putAnnotation(cookie, sourceId, 1, {
      strokes: validBody([validStroke({ points: [5.0, 0.2, 0.5] })]),
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_annotation');
  });

  test('page param out of range: 0 → 4xx; large (<=10000) accepted', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    // page 0 violates the route's `minimum: 1` → Elysia 4xx (not our 400 body).
    const zero = await putAnnotation(cookie, sourceId, 0, { strokes: validBody() });
    expect(zero.status).toBeGreaterThanOrEqual(400);
    expect(zero.status).toBeLessThan(500);

    // A large but in-bounds page (<=10000) is accepted.
    const big = await putAnnotation(cookie, sourceId, 10000, { strokes: validBody() });
    expect(big.status).toBe(200);
    expect((await big.json<{ ok: boolean; cleared: boolean }>()).cleared).toBe(false);
  });
});

// ── happy path: PUT → GET, update-in-place, clear ────────────────────────────

describe('PUT/GET /sources/:id/annotations — upsert, update, clear', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('PUT then GET returns the row ordered by page, with markedText present', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));

    // Write page 3 first, then page 1 → GET must order by page (1 before 3).
    const p3 = await putAnnotation(cookie, sourceId, 3, {
      strokes: validBody([validStroke({ color: '#00ff00' })]),
      markedText: 'page three marked text',
    });
    expect(p3.status).toBe(200);
    const p3body = await p3.json<{ ok: boolean; cleared: boolean; item: { page: number } }>();
    expect(p3body.ok).toBe(true);
    expect(p3body.cleared).toBe(false);
    expect(p3body.item.page).toBe(3);

    const p1 = await putAnnotation(cookie, sourceId, 1, {
      strokes: validBody([validStroke()]),
      markedText: 'page one marked text',
    });
    expect(p1.status).toBe(200);

    const get = await callApp(app, 'GET', `/sources/${sourceId}/annotations`, { cookie });
    expect(get.status).toBe(200);
    const { items } = await get.json<{
      items: {
        page: number;
        strokes: PageAnnotations;
        markedText: string | null;
        updatedAt: string;
      }[];
    }>();
    expect(items.map((i) => i.page)).toEqual([1, 3]);
    expect(items[0]!.markedText).toBe('page one marked text');
    expect(items[1]!.markedText).toBe('page three marked text');
    // Strokes survive the jsonb roundtrip.
    expect(items[0]!.strokes.v).toBe(1);
    expect(items[0]!.strokes.strokes[0]!.tool).toBe('pen');
    expect(items[1]!.strokes.strokes[0]!.color).toBe('#00ff00');
  });

  test('a second PUT on the same page replaces (update-in-place, single row)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));

    await putAnnotation(cookie, sourceId, 2, {
      strokes: validBody([validStroke({ color: '#ff0000' })]),
      markedText: 'first',
    });
    await putAnnotation(cookie, sourceId, 2, {
      strokes: validBody([validStroke({ color: '#0000ff', tool: 'highlighter' })]),
      markedText: 'second',
    });

    // Exactly one row for (source, page=2) — the upsert replaced, not appended.
    const rows = await db
      .select()
      .from(sourceAnnotationsTable)
      .where(
        and(
          eq(sourceAnnotationsTable.sourceId, sourceId),
          eq(sourceAnnotationsTable.page, 2),
        ),
      );
    expect(rows.length).toBe(1);
    expect(rows[0]!.markedText).toBe('second');
    expect(rows[0]!.strokes.strokes[0]!.color).toBe('#0000ff');
    expect(rows[0]!.strokes.strokes[0]!.tool).toBe('highlighter');

    // GET reflects the replacement.
    const get = await callApp(app, 'GET', `/sources/${sourceId}/annotations`, { cookie });
    const { items } = await get.json<{ items: { page: number; markedText: string }[] }>();
    expect(items.length).toBe(1);
    expect(items[0]!.markedText).toBe('second');
  });

  test('PUT with an empty strokes array clears the page → { ok, cleared } + row gone', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));

    // Seed a page, then clear it.
    await putAnnotation(cookie, sourceId, 5, {
      strokes: validBody([validStroke()]),
      markedText: 'to be cleared',
    });
    const cleared = await putAnnotation(cookie, sourceId, 5, { strokes: { v: 1, strokes: [] } });
    expect(cleared.status).toBe(200);
    const body = await cleared.json<{ ok: boolean; cleared: boolean }>();
    expect(body).toEqual({ ok: true, cleared: true });

    // The row is gone from GET and from the DB.
    const get = await callApp(app, 'GET', `/sources/${sourceId}/annotations`, { cookie });
    expect((await get.json<{ items: unknown[] }>()).items).toEqual([]);
    const rows = await db
      .select()
      .from(sourceAnnotationsTable)
      .where(eq(sourceAnnotationsTable.sourceId, sourceId));
    expect(rows.length).toBe(0);
  });

  test('clearing a page that was never annotated is a no-op → { ok, cleared }', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    const res = await putAnnotation(cookie, sourceId, 9, { strokes: { v: 1, strokes: [] } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cleared: true });
  });

  test('markedText is re-capped to MARKED_TEXT_MAX server-side', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    const huge = 'a'.repeat(MARKED_TEXT_MAX + 500);
    const res = await putAnnotation(cookie, sourceId, 1, {
      strokes: validBody([validStroke()]),
      markedText: huge,
    });
    expect(res.status).toBe(200);
    const stored = (
      await db
        .select({ markedText: sourceAnnotationsTable.markedText })
        .from(sourceAnnotationsTable)
        .where(eq(sourceAnnotationsTable.sourceId, sourceId))
    )[0]!.markedText!;
    expect(stored.length).toBe(MARKED_TEXT_MAX);

    // GET returns the capped value too.
    const get = await callApp(app, 'GET', `/sources/${sourceId}/annotations`, { cookie });
    const { items } = await get.json<{ items: { markedText: string }[] }>();
    expect(items[0]!.markedText.length).toBe(MARKED_TEXT_MAX);
  });

  test('PUT with no markedText stores null markedText', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId));
    await putAnnotation(cookie, sourceId, 1, { strokes: validBody([validStroke()]) });
    const get = await callApp(app, 'GET', `/sources/${sourceId}/annotations`, { cookie });
    const { items } = await get.json<{ items: { markedText: string | null }[] }>();
    expect(items[0]!.markedText).toBeNull();
  });
});

// ── user scoping: foreign source 404 on all three routes ─────────────────────

describe('annotations + file — user scoping (foreign source 404)', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('PUT / GET annotations + GET file 404 a foreign source', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    // B owns the source.
    const sourceId = await seedSource(b.userId, await freshNotebook(b.userId));

    // A (the attacker) is 404 on every route — never leaks existence.
    const put = await putAnnotation(a.cookie, sourceId, 1, { strokes: validBody([validStroke()]) });
    expect(put.status).toBe(404);
    expect(await put.json()).toEqual({ error: 'not_found' });

    const get = await callApp(app, 'GET', `/sources/${sourceId}/annotations`, { cookie: a.cookie });
    expect(get.status).toBe(404);
    expect(await get.json()).toEqual({ error: 'not_found' });

    const file = await callApp(app, 'GET', `/sources/${sourceId}/file`, { cookie: a.cookie });
    expect(file.status).toBe(404);

    // B (the owner) is NOT 404 on the annotation routes.
    expect((await putAnnotation(b.cookie, sourceId, 1, { strokes: validBody([validStroke()]) })).status).toBe(200);
    expect((await callApp(app, 'GET', `/sources/${sourceId}/annotations`, { cookie: b.cookie })).status).toBe(200);

    // A foreign user writing/reading B's source never created any rows for A's id.
    const rows = await db
      .select()
      .from(sourceAnnotationsTable)
      .where(eq(sourceAnnotationsTable.userId, a.userId));
    expect(rows.length).toBe(0);
  });

  test('a non-existent source id → 404 on PUT and GET annotations', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const missing = '00000000-0000-4000-8000-000000000000';
    expect((await putAnnotation(cookie, missing, 1, { strokes: validBody([validStroke()]) })).status).toBe(404);
    expect((await callApp(app, 'GET', `/sources/${missing}/annotations`, { cookie })).status).toBe(404);
  });
});

// ── GET /sources/:id/file — storageKey gating ────────────────────────────────
//
// NOTE: storage.ts exposes NO test seam for `getObjectBytes` (it constructs the
// S3 client at module load and the route calls getObjectBytes directly). There
// is therefore no way to fake the object bytes in-process, so the byte-roundtrip
// is NOT tested here — only the deterministic 404 paths that never reach S3:
//   * a url/text source has no storageKey → 404 BEFORE any S3 call.
//   * a foreign source → 404 (covered above).
// (A source WITH a storageKey but no real object would attempt the S3 GET, which
// the route degrades to 404 — but that depends on an unconfigured/empty MinIO,
// so we don't assert it to avoid an environment-coupled flake.)

describe('GET /sources/:id/file — storageKey gating', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('a url source (no storageKey) → 404', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId), {
      kind: 'url',
      withStorageKey: false,
    });
    const res = await callApp(app, 'GET', `/sources/${sourceId}/file`, { cookie });
    expect(res.status).toBe(404);
  });

  test('a text source (no storageKey) → 404', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const sourceId = await seedSource(userId, await freshNotebook(userId), {
      kind: 'text',
      withStorageKey: false,
    });
    const res = await callApp(app, 'GET', `/sources/${sourceId}/file`, { cookie });
    expect(res.status).toBe(404);
  });
});
