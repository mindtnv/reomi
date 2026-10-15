import { beforeEach, expect, test } from 'bun:test';
import { eq, sql, count } from 'drizzle-orm';
import { db, cards, notes, noteTypes, decks } from '@reomi/db';
import { buildApp } from '../src/app';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers';

const app = buildApp();
beforeEach(resetTestDb);
async function fixture(size: number) {
  const { cookie, userId } = await signUpAndCookie(app, uniqueEmail('type-budget'));
  const [type] = await db.insert(noteTypes).values({ userId, name: 'Measured type', kind: 'basic',
    fields: [{ name: 'Q', ord: 0 }, { name: 'A', ord: 1 }],
    templates: [{ name: 'Forward', ord: 0, frontTemplate: '{{Q}}', backTemplate: '{{A}}' }],
  }).returning();
  const [deck] = await db.insert(decks).values({ userId, name: 'Measured deck' }).returning();
  await db.execute(sql`insert into notes (user_id, note_type_id, field_values)
    select ${userId}, ${type!.id}::uuid, jsonb_build_object('Q', 'Question ' || n, 'A', 'Answer ' || n)
    from generate_series(1, ${size}) as n`);
  await db.execute(sql`insert into cards (user_id, note_id, deck_id, template_ord, render_front_text, render_back_text, render_text, render_kind)
    select ${userId}, id, ${deck!.id}::uuid, 0, field_values->>'Q', field_values->>'A', (field_values->>'Q') || ' ' || (field_values->>'A'), 'basic'
    from notes where user_id = ${userId}`);
  const patch = { templates: [{ name: 'Forward', ord: 0, frontTemplate: 'Updated {{Q}}', backTemplate: '{{A}}' }] };
  return { cookie, userId, type: type!, patch };
}

test('10,000-note type is rejected before regeneration and remains unchanged', async () => {
  const { cookie, userId, type, patch } = await fixture(10_000);
  const started = performance.now();
  const preview = await callApp(app, 'POST', `/note-types/${type.id}/preview`, { cookie, body: patch });
  const elapsedMs = performance.now() - started;
  console.info(`type-budget 10000 notes preview: ${elapsedMs.toFixed(1)} ms, status ${preview.status}`);
  expect(preview.status).toBe(413);
  expect(await preview.json()).toMatchObject({ error: 'note_type_operation_too_large' });
  expect(elapsedMs).toBeLessThan(5000);
  const applied = await callApp(app, 'PATCH', `/note-types/${type.id}`, { cookie, body: patch });
  expect(applied.status).toBe(413);
  expect((await db.select().from(noteTypes).where(eq(noteTypes.id, type.id)))[0]).toEqual(type);
  expect((await db.select({ n: count() }).from(cards).where(eq(cards.userId, userId)))[0]!.n).toBe(10_000);
  expect((await db.select().from(cards).where(eq(cards.userId, userId)).limit(1))[0]!.renderFrontText.startsWith('Updated')).toBe(false);
  // Metadata-only rename must remain cheap and usable even for a large type.
  expect((await callApp(app, 'PATCH', `/note-types/${type.id}`, { cookie, body: { name: 'Renamed' } })).status).toBe(200);
}, 30_000);

test('admitted 1000-note operation preserves identities and finishes within the budget', async () => {
  const { cookie, userId, type, patch } = await fixture(1000);
  const before = await db.select({ id: cards.id }).from(cards).where(eq(cards.userId, userId)).orderBy(cards.id);
  const started = performance.now();
  const previewResponse = await callApp(app, 'POST', `/note-types/${type.id}/preview`, { cookie, body: patch });
  expect(previewResponse.status).toBe(200);
  const preview = await previewResponse.json<any>();
  expect(preview.impact.willKeepCards).toBe(1000);
  const result = await callApp(app, 'PATCH', `/note-types/${type.id}`, { cookie, body: {
    ...patch, expectedUpdatedAt: preview.sourceVersion, confirmationToken: preview.confirmationToken,
  } });
  expect(result.status).toBe(200);
  const elapsedMs = performance.now() - started;
  console.info(`type-budget 1000 notes preview+apply: ${elapsedMs.toFixed(1)} ms`);
  expect(elapsedMs).toBeLessThan(5000);
  const after = await db.select().from(cards).where(eq(cards.userId, userId)).orderBy(cards.id);
  expect(after.map(c => ({ id: c.id }))).toEqual(before);
  expect(after.every(c => c.renderFrontText.startsWith('Updated') && c.reps === 0)).toBe(true);
}, 15_000);

test('a contended type lock returns a recoverable result without waiting indefinitely', async () => {
  const { cookie, type, patch } = await fixture(1);
  let release!: () => void;
  let locked!: () => void;
  const lockReady = new Promise<void>(r => { locked = r; });
  const releaseLock = new Promise<void>(r => { release = r; });
  const holder = db.transaction(async tx => {
    await tx.select().from(noteTypes).where(eq(noteTypes.id, type.id)).for('update');
    locked(); await releaseLock;
  });
  try {
    await lockReady;
    const started = performance.now();
    const result = await callApp(app, 'PATCH', `/note-types/${type.id}`, { cookie, body: patch });
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ error: 'note_type_operation_busy' });
    expect(performance.now() - started).toBeLessThan(2000);
  } finally { release(); await holder; }
  expect((await db.select().from(noteTypes).where(eq(noteTypes.id, type.id)))[0]).toEqual(type);
});

test('a slow card write rolls back the already-updated definition and every card', async () => {
  const { cookie, type, patch, userId } = await fixture(2);
  const before = await db.select().from(cards).where(eq(cards.userId, userId)).orderBy(cards.id);
  await db.execute(sql`create function test_note_type_budget_delay() returns trigger language plpgsql as $$
    begin perform pg_sleep(3); return new; end $$`);
  await db.execute(sql`create trigger test_note_type_budget_delay before update on cards
    for each row execute function test_note_type_budget_delay()`);
  try {
    const result = await callApp(app, 'PATCH', `/note-types/${type.id}`, { cookie, body: patch });
    expect(result.status).toBe(503);
    expect(await result.json()).toMatchObject({ error: 'note_type_operation_timeout' });
    expect((await db.select().from(noteTypes).where(eq(noteTypes.id, type.id)))[0]).toEqual(type);
    expect(await db.select().from(cards).where(eq(cards.userId, userId)).orderBy(cards.id)).toEqual(before);
  } finally {
    await db.execute(sql`drop trigger test_note_type_budget_delay on cards`);
    await db.execute(sql`drop function test_note_type_budget_delay()`);
  }
}, 10_000);

test('card fan-out and source size have separate pre-write limits', async () => {
  const { cookie, userId, type, patch } = await fixture(100);
  const templates = Array.from({ length: 32 }, (_, ord) => ({ name: `Card ${ord}`, ord, frontTemplate: '{{Q}}', backTemplate: '{{A}}' }));
  const generated = await callApp(app, 'POST', `/note-types/${type.id}/preview`, { cookie, body: { templates } });
  expect(generated.status).toBe(413);
  expect(await generated.json()).toMatchObject({ error: 'note_type_operation_too_large' });
  await db.update(notes).set({ fieldValues: { Q: 'x'.repeat(30_000), A: 'A' } }).where(eq(notes.userId, userId));
  const oversized = await callApp(app, 'PATCH', `/note-types/${type.id}`, { cookie, body: patch });
  expect(oversized.status).toBe(413);
  expect((await db.select().from(noteTypes).where(eq(noteTypes.id, type.id)))[0]).toEqual(type);
  expect((await db.select({ n: count() }).from(cards).where(eq(cards.userId, userId)))[0]!.n).toBe(100);
});

test('existing card cap is checked before applying a question-removal change', async () => {
  const { cookie, userId, type, patch } = await fixture(500);
  await db.execute(sql`insert into cards (user_id, note_id, deck_id, template_ord, render_front_text, render_back_text, render_text, render_kind)
    select user_id, note_id, deck_id, ord, render_front_text, render_back_text, render_text, render_kind
    from cards cross join generate_series(1,4) as ord where user_id = ${userId}`);
  expect((await callApp(app, 'PATCH', `/note-types/${type.id}`, { cookie, body: patch })).status).toBe(413);
  expect((await db.select({ n: count() }).from(cards).where(eq(cards.userId, userId)))[0]!.n).toBe(2500);
  expect((await db.select().from(noteTypes).where(eq(noteTypes.id, type.id)))[0]).toEqual(type);
});

test('repeated field expansion is rejected before allocating an enormous rendered template', async () => {
  const { cookie, userId, type } = await fixture(1);
  await db.update(notes).set({ fieldValues: { Q: 'x'.repeat(60_000), A: 'A' } }).where(eq(notes.userId, userId));
  const started = performance.now();
  const response = await callApp(app, 'PATCH', `/note-types/${type.id}`, { cookie, body: {
    templates: [{ name: 'Forward', ord: 0, frontTemplate: '{{Q}}'.repeat(2000), backTemplate: '{{A}}' }],
  } });
  expect(response.status).toBe(413);
  expect(performance.now() - started).toBeLessThan(1000);
  expect((await db.select().from(noteTypes).where(eq(noteTypes.id, type.id)))[0]).toEqual(type);
});
