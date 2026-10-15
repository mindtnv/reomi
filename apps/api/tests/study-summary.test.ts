import { beforeEach, describe, expect, test } from 'bun:test';
import { cards, db } from '@reomi/db';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import { callApp, resetTestDb, seedBasicCard, signUpAndCookie, uniqueEmail } from './helpers';

const app = buildApp();

describe('study overview', () => {
  beforeEach(resetTestDb);

  test('counts the full collection beyond the 500-card page, with descendant totals', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const parent = await (await callApp(app, 'POST', '/decks', { cookie, body: { name: 'Parent' } })).json<any>();
    const child = await (await callApp(app, 'POST', '/decks', { cookie, body: { name: 'Child', parentId: parent.id } })).json<any>();
    const card = await seedBasicCard(app, cookie, { deckId: child.id, front: 'Question' });
    await db.insert(cards).values(Array.from({ length: 600 }, (_, i) => ({ userId, deckId: child.id, noteId: card.noteId, templateOrd: i + 1 })));
    const response = await callApp(app, 'GET', '/cards/study-summary', { cookie });
    expect(response.status).toBe(200);
    const summary = await response.json<any>();
    expect(summary.overall).toMatchObject({ total: 601, newCount: 601, availableNew: 20, totalAvailable: 20 });
    expect(summary.decks[parent.id]).toMatchObject({ total: 601, newCount: 601, totalAvailable: 20 });
    expect(summary.decks[child.id]).toMatchObject({ total: 601, newCount: 601, totalAvailable: 20 });
    expect(summary.direct[parent.id].total).toBe(0);
    expect(summary.direct[child.id].total).toBe(601);
  });

  test('states, future learning and suspended counts are isolated and contain no content', async () => {
    const a = await signUpAndCookie(app, uniqueEmail());
    const b = await signUpAndCookie(app, uniqueEmail());
    const deck = await (await callApp(app, 'POST', '/decks', { cookie: a.cookie, body: { name: 'Private' } })).json<any>();
    const due = new Date(Date.now() + 600_000);
    for (const state of ['new', 'learning', 'relearning', 'review'] as const) {
      const card = await seedBasicCard(app, a.cookie, { deckId: deck.id, front: 'Private answer content' });
      await db.update(cards).set({ state, due: state === 'relearning' ? due : new Date(Date.now() - 60_000), suspended: state === 'review' }).where(eq(cards.id, card.id));
    }
    const result = await (await callApp(app, 'GET', '/cards/study-summary', { cookie: a.cookie })).json<any>();
    expect(result.overall).toMatchObject({ total: 4, newCount: 1, learningCount: 2, reviewCount: 0, suspendedCount: 1, dueLearning: 1, dueReview: 0, totalAvailable: 2, nextLearningAt: due.toISOString() });
    expect(JSON.stringify(result)).not.toContain('Private answer content');
    const other = await (await callApp(app, 'GET', '/cards/study-summary', { cookie: b.cookie })).json<any>();
    expect(other.overall.total).toBe(0);
    expect(other.decks).toEqual({});
    expect((await callApp(app, 'GET', '/cards/study-summary')).status).toBe(401);
  });
});
