import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as indexQueue from '../src/ai/index-queue';
import { db, kbChunk } from '@reomi/db';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app';
import { callApp, insertChunkFixture, resetTestDb, signUpAndCookie, uniqueEmail, vectorFixtureFor } from './helpers';

const app = buildApp();
beforeEach(resetTestDb);

async function fixture() {
  const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
  const deck = await (await callApp(app, 'POST', '/decks', { cookie, body: { name: 'Impact' } })).json<any>();
  const type = await (await callApp(app, 'POST', '/note-types', { cookie, body: {
    name: 'Directions', fields: [{ name: 'Q', ord: 0 }, { name: 'A', ord: 1 }], templates: [
      { name: 'Forward', ord: 0, frontTemplate: '{{Q}}', backTemplate: '{{A}}' },
      { name: 'Reverse', ord: 1, frontTemplate: '{{A}}', backTemplate: '{{Q}}' },
    ], kind: 'custom',
  } })).json<any>();
  const created = await (await callApp(app, 'POST', '/notes', { cookie, body: {
    noteTypeId: type.id, deckId: deck.id, fieldValues: { Q: 'question', A: 'answer' },
  } })).json<any>();
  const forward = created.cards.find((card: any) => card.templateOrd === 0);
  const reverse = created.cards.find((card: any) => card.templateOrd === 1);
  return { cookie, userId, type, created, forward, reverse };
}

describe('note type impact and reconciliation', () => {
  test('preview is read-only, removal needs its exact token, survivors keep their schedule', async () => {
    const { cookie, type, forward, reverse } = await fixture();
    const grade = await (await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: forward.id, rating: 4 } })).json<any>();
    const reverseGrade = await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: reverse.id, rating: 3 } });
    expect(reverseGrade.status).toBe(200);
    const history = await (await callApp(app, 'GET', '/reviews', { cookie })).json<any[]>();
    expect(history.filter((row) => row.cardId === reverse.id)).toHaveLength(1);
    const patch = { templates: [type.templates[0], { name: 'New question', ord: 1, frontTemplate: 'New {{Q}}', backTemplate: '{{A}}' }] };
    const previewResponse = await callApp(app, 'PATCH', `/note-types/${type.id}`, { cookie, body: { ...patch, preview: true } });
    expect(previewResponse.status).toBe(200);
    const preview = await previewResponse.json<any>();
    expect(preview.impact).toMatchObject({ willCreateCards: 1, willKeepCards: 1, willDeleteCards: 1, willDeleteReviews: 1 });
    expect(preview.impact.removedCards[0]).toMatchObject({ id: reverse.id, front: 'answer', reviews: 1 });
    expect((await callApp(app, 'GET', `/cards/${reverse.id}`, { cookie })).status).toBe(200);
    const denied = await callApp(app, 'PATCH', `/note-types/${type.id}`, { cookie, body: patch });
    expect(denied.status).toBe(409);
    const applied = await callApp(app, 'PATCH', `/note-types/${type.id}`, { cookie,
      body: { ...patch, confirmationToken: preview.confirmationToken, expectedUpdatedAt: preview.sourceVersion } });
    expect(applied.status).toBe(200);
    const survivor = await (await callApp(app, 'GET', `/cards/${forward.id}`, { cookie })).json<any>();
    expect(survivor).toMatchObject({ id: forward.id, due: grade.card.due, reps: grade.card.reps });
    expect((await callApp(app, 'GET', `/cards/${reverse.id}`, { cookie })).status).toBe(404);
    const page = await (await callApp(app, 'GET', '/cards', { cookie })).json<any>();
    expect(page.items).toHaveLength(2);
    expect(page.items.find((card: any) => card.id !== forward.id)).toMatchObject({ renderFrontText: 'New question', reps: 0 });
  });

  test('a grade after preview invalidates removal consent without changing the type', async () => {
    const { cookie, type, reverse } = await fixture();
    const patch = { templates: [type.templates[0]] };
    const previewResult = await callApp(app, 'PATCH', `/note-types/${type.id}`, { cookie, body: { ...patch, preview: true } });
    expect(previewResult.status).toBe(200);
    const preview = await previewResult.json<any>();
    await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: reverse.id, rating: 4 } });
    const rejected = await callApp(app, 'PATCH', `/note-types/${type.id}`, { cookie, body: { ...patch, confirmationToken: preview.confirmationToken } });
    expect(rejected.status).toBe(409);
    expect((await callApp(app, 'GET', `/cards/${reverse.id}`, { cookie })).status).toBe(200);
    const types = await (await callApp(app, 'GET', '/note-types', { cookie })).json<any[]>();
    expect(types.find((row) => row.id === type.id).templates).toHaveLength(2);
  });

  test('preview is owner-scoped and stale type versions cannot overwrite new changes', async () => {
    const { cookie, type } = await fixture();
    const other = await signUpAndCookie(app, uniqueEmail());
    expect((await callApp(app, 'PATCH', `/note-types/${type.id}`, { cookie: other.cookie, body: { preview: true } })).status).toBe(404);
    expect((await callApp(app, 'PATCH', `/note-types/${type.id}`, { cookie, body: { name: 'Current', expectedUpdatedAt: type.updatedAt } })).status).toBe(200);
    const stale = await callApp(app, 'PATCH', `/note-types/${type.id}`, { cookie, body: { name: 'Stale', expectedUpdatedAt: type.updatedAt } });
    expect(stale.status).toBe(409);
    const types = await (await callApp(app, 'GET', '/note-types', { cookie })).json<any[]>();
    expect(types.find((row) => row.id === type.id).name).toBe('Current');
  });

  test('only changed search text is enqueued after commit and deleted cards lose their index', async () => {
    const { cookie, userId, type, forward, reverse } = await fixture();
    await insertChunkFixture(userId, reverse.id, 'old index', vectorFixtureFor('old index'));
    const ids: string[] = [];
    const spy = spyOn(indexQueue, 'enqueueIndex').mockImplementation((id) => { ids.push(id); });
    try {
      expect((await callApp(app, 'PATCH', `/note-types/${type.id}`, { cookie, body: { styling: '.card { color: red }' } })).status).toBe(200);
      expect(ids).toEqual([]);
      const patch = { templates: [{ ...type.templates[0], frontTemplate: 'Changed {{Q}}' }] };
      const preview = await (await callApp(app, 'POST', `/note-types/${type.id}/preview`, { cookie, body: patch })).json<any>();
      expect(ids).toEqual([]);
      expect((await callApp(app, 'PATCH', `/note-types/${type.id}`, { cookie,
        body: { ...patch, confirmationToken: preview.confirmationToken } })).status).toBe(200);
      expect(ids).toEqual([forward.id]);
      expect(await db.select().from(kbChunk).where(eq(kbChunk.cardId, reverse.id))).toEqual([]);
    } finally { spy.mockRestore(); }
  });
});
