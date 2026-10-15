// «Блокноты 2.0» overview (Р6, N2) — POST /notebooks/:id/overview.
//
// CONTRACT (read from apps/api/src/ai/artifacts.ts + modules/notebooks.ts):
//   * Order: 404 ownership → 400 no_sources (no ready sources) → 503 ai_disabled
//     (chat off) → 502 overview_failed (timeout/gateway/unparseable) → 200
//     {overview, questions, fingerprint}.
//   * Defensive JSON parse (suggest-card pattern): a ```json fence is stripped;
//     the first balanced {...} is sliced; types validated; questions capped to 6,
//     each ≤200 chars; missing/empty overview ⇒ null ⇒ 502.
//   * The persisted `overview_fingerprint` equals the recomputed
//     computeOverviewFingerprint(ready sources + chunkCounts); GET /notebooks/:id
//     returns both the saved fingerprint and the CURRENT recomputed one, so
//     adding a source makes them diverge (staleness).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  db,
  notebooks as notebooksTable,
  notebookSources as notebookSourcesTable,
  sourceChunks as sourceChunksTable,
  sources as sourcesTable,
} from '@reomi/db';
import { buildApp } from '../src/app.ts';
import {
  __resetAiClientForTests,
  __setAiClientForTests,
} from '../src/ai/openai-client.ts';
import { parseOverview } from '../src/ai/artifacts.ts';
import { computeOverviewFingerprint } from '../src/modules/notebooks.ts';
import { cooldownReset } from '../src/ai-cooldown.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

function installComplete(reply: string): void {
  __setAiClientForTests({
    async complete(): Promise<string> {
      return reply;
    },
    // A chat surface so isChatEnabled() flips on for the route's 503 gate (the
    // overview route never streams — this is just the enable flag, like
    // quick-card's suggest-card test).
    async *chatStreamAgentic() {
      yield { type: 'finish', reason: 'stop' };
    },
  });
}

async function freshNotebook(userId: string, title = 'NB'): Promise<string> {
  const [nb] = await db
    .insert(notebooksTable)
    .values({ userId, title })
    .returning({ id: notebooksTable.id });
  return nb!.id;
}

async function seedSource(
  userId: string,
  notebookId: string,
  title: string,
  chunkTexts: string[],
  status: 'ready' | 'indexing' = 'ready',
): Promise<string> {
  const [src] = await db
    .insert(sourcesTable)
    .values({ userId, kind: 'pdf', title, status, verified: true, chunkCount: chunkTexts.length })
    .returning({ id: sourcesTable.id });
  const sourceId = src!.id;
  await db.insert(notebookSourcesTable).values({ userId, notebookId, sourceId });
  for (let i = 0; i < chunkTexts.length; i++) {
    await db
      .insert(sourceChunksTable)
      .values({ userId, sourceId, position: i, text: chunkTexts[i]!, embedded: true });
  }
  return sourceId;
}

// ── parseOverview unit (defensive JSON) ───────────────────────────────────────

describe('parseOverview — defensive JSON', () => {
  test('plain JSON object', () => {
    const out = parseOverview('{"overview":"About X","questions":["Q1","Q2"]}');
    expect(out).toEqual({ overview: 'About X', questions: ['Q1', 'Q2'] });
  });

  test('```json fence + prose around is tolerated', () => {
    const raw = 'Sure!\n```json\n{"overview":"About Y","questions":["Q"]}\n```\n';
    expect(parseOverview(raw)).toEqual({ overview: 'About Y', questions: ['Q'] });
  });

  test('questions capped to 6, non-strings dropped', () => {
    const qs = JSON.stringify(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
    const out = parseOverview(`{"overview":"o","questions":${qs}}`);
    expect(out!.questions.length).toBe(6);
  });

  test('missing/empty overview ⇒ null', () => {
    expect(parseOverview('{"questions":["q"]}')).toBeNull();
    expect(parseOverview('{"overview":"   ","questions":[]}')).toBeNull();
  });

  test('garbage ⇒ null', () => {
    expect(parseOverview('not json at all')).toBeNull();
  });
});

// ── route ─────────────────────────────────────────────────────────────────────

describe('POST /notebooks/:id/overview', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => __resetAiClientForTests());

  test('happy path — JSON parsed, persisted, fingerprint matches recompute', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const sourceId = await seedSource(userId, nb, 'Doc', ['alpha', 'beta', 'gamma']);
    installComplete('```json\n{"overview":"This notebook is about X.","questions":["What is X?","Why X?"]}\n```');

    const res = await callApp(app, 'POST', `/notebooks/${nb}/overview`, { cookie });
    expect(res.status).toBe(200);
    const body = await res.json<{ overview: string; questions: string[]; fingerprint: string }>();
    expect(body.overview).toBe('This notebook is about X.');
    expect(body.questions).toEqual(['What is X?', 'Why X?']);

    // Persisted on the notebook row + equals the recomputed fingerprint.
    const [row] = await db
      .select()
      .from(notebooksTable)
      .where(eq(notebooksTable.id, nb))
      .limit(1);
    expect(row!.overview).toBe('This notebook is about X.');
    expect(row!.suggestedQuestions).toEqual(['What is X?', 'Why X?']);
    const expected = computeOverviewFingerprint([{ sourceId, chunkCount: 3 }]);
    expect(row!.overviewFingerprint).toBe(expected);
    expect(body.fingerprint).toBe(expected);
  });

  test('broken JSON ⇒ 502 overview_failed', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    await seedSource(userId, nb, 'Doc', ['alpha']);
    installComplete('the model rambled and produced no JSON');

    const res = await callApp(app, 'POST', `/notebooks/${nb}/overview`, { cookie });
    expect(res.status).toBe(502);
    expect((await res.json<{ error: string }>()).error).toBe('overview_failed');
  });

  test('no chat key ⇒ 503 ai_disabled', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    await seedSource(userId, nb, 'Doc', ['alpha']);
    // No fake injected ⇒ isChatEnabled() false under test env.
    const res = await callApp(app, 'POST', `/notebooks/${nb}/overview`, { cookie });
    expect(res.status).toBe(503);
    expect((await res.json<{ error: string }>()).error).toBe('ai_disabled');
  });

  test('no ready sources ⇒ 400 no_sources (BEFORE the AI gate)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    await seedSource(userId, nb, 'Doc', ['alpha'], 'indexing'); // not ready
    installComplete('{"overview":"x","questions":[]}');

    const res = await callApp(app, 'POST', `/notebooks/${nb}/overview`, { cookie });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('no_sources');
  });

  test('GET /notebooks/:id returns saved + current fingerprint; adding a source diverges them', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    await seedSource(userId, nb, 'Doc', ['alpha', 'beta']);
    installComplete('{"overview":"o","questions":["q"]}');

    const gen = await callApp(app, 'POST', `/notebooks/${nb}/overview`, { cookie });
    expect(gen.status).toBe(200);
    const saved = (await gen.json<{ fingerprint: string }>()).fingerprint;

    // Right after generation, saved == current.
    let detail = await callApp(app, 'GET', `/notebooks/${nb}`, { cookie });
    let dj = await detail.json<{ overviewFingerprint: string; currentFingerprint: string }>();
    expect(dj.overviewFingerprint).toBe(saved);
    expect(dj.currentFingerprint).toBe(saved);

    // Add another ready source ⇒ the current fingerprint changes, saved does not.
    await seedSource(userId, nb, 'Doc2', ['gamma']);
    detail = await callApp(app, 'GET', `/notebooks/${nb}`, { cookie });
    dj = await detail.json<{ overviewFingerprint: string; currentFingerprint: string }>();
    expect(dj.overviewFingerprint).toBe(saved); // stale cache
    expect(dj.currentFingerprint).not.toBe(saved); // recomputed differs
  });

  test('foreign notebook ⇒ 404', async () => {
    const a = await signUpAndCookie(app, uniqueEmail());
    const b = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(a.userId);
    await seedSource(a.userId, nb, 'Doc', ['alpha']);
    const res = await callApp(app, 'POST', `/notebooks/${nb}/overview`, { cookie: b.cookie });
    expect(res.status).toBe(404);
  });

  // The cooldown short-circuits under NODE_ENV=test; this integration forces it
  // on (mirrors rate-limit.test.ts flipping NODE_ENV) to prove a rapid second
  // call gets 429 cooldown while the first succeeds. Sign-up runs under test env
  // BEFORE the flip so the auth rate-limiter doesn't interfere.
  test('rapid second overview ⇒ 429 cooldown (forced-on)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    await seedSource(userId, nb, 'Doc', ['alpha', 'beta']);
    installComplete('{"overview":"o","questions":["q"]}');

    cooldownReset();
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const first = await callApp(app, 'POST', `/notebooks/${nb}/overview`, { cookie });
      expect(first.status).toBe(200);

      const second = await callApp(app, 'POST', `/notebooks/${nb}/overview`, { cookie });
      expect(second.status).toBe(429);
      const body = await second.json<{ error: string; retryAfterMs: number }>();
      expect(body.error).toBe('cooldown');
      expect(body.retryAfterMs).toBeGreaterThan(0);
    } finally {
      process.env.NODE_ENV = savedEnv;
      cooldownReset();
    }
  });
});
