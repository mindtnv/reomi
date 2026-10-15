// Bare-schema onboarding contract (Step 1, B2). The general test lifecycle
// (helpers.resetTestDb) TRUNCATEs note_types, so builtins do NOT survive a
// reset. This file owns a DISTINCT lifecycle: after each reset it re-runs
// `ensureBuiltins(db)` to recreate the 3 global builtins, then proves a fresh
// user can list them and create a card from one — i.e. a clean install is
// usable without the demo seed. Also pins idempotency + the strict N1 conflict
// contract (the partial unique index actually fires).

import { beforeEach, describe, expect, test } from 'bun:test';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { ensureBuiltins, noteTypes } from '@reomi/db';
import { db } from '@reomi/db/client';
import { BUILTIN_NOTE_TYPES } from '@reomi/shared';
import { buildApp } from '../src/app.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

async function builtinCount(): Promise<number> {
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(noteTypes)
    .where(and(eq(noteTypes.isBuiltin, true), isNull(noteTypes.userId)));
  return n;
}

describe('onboarding builtins (bare schema)', () => {
  beforeEach(async () => {
    await resetTestDb(); // TRUNCATE wipes note_types …
    await ensureBuiltins(db); // … then recreate the 3 builtins for a clean install.
  });

  test('GET /note-types lists Basic / Cloze / Type-in for a fresh user', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail('onboard'));
    const res = await callApp(app, 'GET', '/note-types', { cookie });
    expect(res.status).toBe(200);
    const rows = await res.json<Array<{ name: string; isBuiltin: boolean; userId: string | null }>>();
    const builtinNames = rows.filter((r) => r.isBuiltin && r.userId === null).map((r) => r.name).sort();
    expect(builtinNames).toEqual(['Basic', 'Cloze', 'Type-in']);
  });

  test('POST /notes creates a card from a global builtin', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail('onboard'));
    const deck = await (
      await callApp(app, 'POST', '/decks', { cookie, body: { name: 'D' } })
    ).json<{ id: string }>();

    const basic = BUILTIN_NOTE_TYPES.find((d) => d.kind === 'basic')!;
    const res = await callApp(app, 'POST', '/notes', {
      cookie,
      body: {
        noteTypeId: basic.id,
        deckId: deck.id,
        fieldValues: { Front: 'hund', Back: 'dog' },
        tags: [],
      },
    });
    expect(res.status).toBe(200);
    const { cards } = await res.json<{ cards: Array<{ id: string; renderFrontText: string }> }>();
    expect(cards.length).toBe(1);
    expect(cards[0]!.renderFrontText).toBe('hund');
  });

  test('ensureBuiltins is idempotent — calling twice keeps count at 3', async () => {
    // beforeEach already called it once; calling again must not duplicate.
    await ensureBuiltins(db);
    await ensureBuiltins(db);
    expect(await builtinCount()).toBe(3);
  });

  test('strict N1: re-inserting a builtin via ON CONFLICT affects 0 rows (partial unique index fired)', async () => {
    const basic = BUILTIN_NOTE_TYPES.find((d) => d.kind === 'basic')!;
    // Deliberate duplicate insert of an existing builtin (same name, is_builtin,
    // user_id NULL) using a FRESH id and the same targeted ON CONFLICT predicate.
    // If the partial unique index exists, this conflicts → 0 rows. If push failed
    // to materialize the index, the row would slip in → result.length > 0 (red).
    const result = await db
      .insert(noteTypes)
      .values({
        userId: null,
        name: basic.name,
        fields: basic.fields,
        templates: basic.templates,
        styling: basic.styling,
        kind: basic.kind,
        isBuiltin: true,
      })
      .onConflictDoNothing({
        target: noteTypes.name,
        where: sql`is_builtin AND user_id IS NULL`,
      })
      .returning({ id: noteTypes.id });

    expect(result.length).toBe(0);
    expect(await builtinCount()).toBe(3);
  });

  test('persisted builtin ids match the BUILTIN_NOTE_TYPES literals', async () => {
    const rows = await db
      .select({ id: noteTypes.id, name: noteTypes.name })
      .from(noteTypes)
      .where(and(eq(noteTypes.isBuiltin, true), isNull(noteTypes.userId)));
    const byName = new Map(rows.map((r) => [r.name, r.id]));
    for (const def of BUILTIN_NOTE_TYPES) {
      expect(byName.get(def.name)).toBe(def.id);
    }
  });
});
