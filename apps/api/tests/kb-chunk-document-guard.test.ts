// CARD-graph guard on a MIXED corpus (NotebookLM M1, T9 / AC1.2 — HIGH-A1).
//
// THE COUNT-PRESERVATION TEST. A pure visibility test (does a document chunk
// LEAK into card results?) is INSUFFICIENT. The AC1.2 invariant under test is
// stronger: on a mixed corpus where document vectors are CLOSER to the probe
// than every card neighbour, `retrieve()`, `similarCards()` and `semanticEdges()`
// must still return the FULL k CARD neighbours (count == k) and never a document.
//
// NOTE (verified empirically, see report): with the CURRENT SQL the count is
// preserved by the pre-existing `card_id` join/filter that runs BEFORE the LIMIT
// (retrieve/similar INNER JOIN cards; the edges lateral's `kc2.card_id <> src`
// drops NULL-card_id document rows since `NULL <> uuid` ⇒ UNKNOWN). The added
// `kc.source_type='card'` conjunct is therefore a planner PRE-FILTER, not the
// sole correctness guard — removing it alone does NOT flip these assertions red.
// These tests pin the OBSERVABLE AC1.2 invariant (which is what ships); they are
// not a single-guard mutation test (the architecture has two overlapping guards).
//
// Vectors go straight into kb_chunk (insertChunkFixture for cards; a raw insert
// for documents) — no AI client. Independence from the embedder is the point.

import { beforeEach, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db, kbChunk, notebooks, sources } from '@reomi/db';
import { buildApp } from '../src/app.ts';
import { retrieve } from '../src/ai/retrieve.ts';
import { similarCards } from '../src/ai/similar.ts';
import { semanticEdges } from '../src/ai/semantic-edges.ts';
import {
  callApp,
  insertChunkFixture,
  nearVectorFixture,
  resetTestDb,
  seedBasicCard,
  signUpAndCookie,
  uniqueEmail,
  vectorFixtureFor,
} from './helpers.ts';

const app = buildApp();

async function freshDeck(cookie: string, name = 'D'): Promise<string> {
  const res = await callApp(app, 'POST', '/decks', { cookie, body: { name } });
  return (await res.json<{ id: string }>()).id;
}

/** A notebook + source pair so document chunks have a valid parent/source id. */
async function freshNotebookSource(
  userId: string,
): Promise<{ notebookId: string; sourceId: string }> {
  const [nb] = await db
    .insert(notebooks)
    .values({ userId, title: 'Guard NB' })
    .returning({ id: notebooks.id });
  const [src] = await db
    .insert(sources)
    .values({
      userId,
      kind: 'text',
      title: 'Guard Source',
      status: 'ready',
      verified: true,
    })
    .returning({ id: sources.id });
  return { notebookId: nb!.id, sourceId: src!.id };
}

/**
 * Insert a DOCUMENT kb_chunk row directly (source_type='document', card_id=NULL,
 * parent_id=source_id, source_id=source). Mirrors the ingest worker's row tuple
 * (library refactor: parent_id = source_id for documents) and satisfies the
 * kb_chunk_card_source_chk check (card_id null ⇔ non-card).
 */
async function insertDocChunk(opts: {
  userId: string;
  notebookId: string;
  sourceId: string;
  text: string;
  embedding: number[];
  position: number;
}): Promise<void> {
  await db.insert(kbChunk).values({
    userId: opts.userId,
    sourceType: 'document',
    sourceId: opts.sourceId,
    parentId: opts.sourceId,
    position: opts.position,
    text: opts.text,
    embedding: opts.embedding,
    embeddingModel: 'test-fixture',
    sourceHash: `doc-${opts.sourceId}-${opts.position}`,
    cardId: null,
  });
}

describe('CARD-graph guard — count preservation on a mixed corpus', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('retrieve() returns the FULL k card chunks even when document vectors are closer', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const { notebookId, sourceId } = await freshNotebookSource(userId);

    const k = 5;
    const probe = vectorFixtureFor('guard probe topic');

    // 7 CARD chunks, all reasonably close to the probe (eps 0.06). > k so the
    // top-k must be entirely cards when the guard is in place.
    const cardIds: string[] = [];
    for (let i = 0; i < 7; i++) {
      const card = await seedBasicCard(app, cookie, { deckId, front: `card-${i}`, back: 'a' });
      await insertChunkFixture(userId, card.id, `card-${i}`, nearVectorFixture(probe, 0.06, i + 1));
      cardIds.push(card.id);
    }

    // 4 DOCUMENT chunks, EVEN closer to the probe (eps 0.01 → smaller cosine
    // distance than any card). Without the guard these would occupy the nearest
    // 4 slots of `LIMIT k`, leaving only 1 card → count drops below k.
    for (let i = 0; i < 4; i++) {
      await insertDocChunk({
        userId,
        notebookId,
        sourceId,
        text: `doc-${i}`,
        embedding: nearVectorFixture(probe, 0.01, i + 1),
        position: i,
      });
    }

    const hits = await retrieve({ userId, queryEmbedding: probe, k });
    // The guard keeps document vectors out of the top-k window → full k cards.
    expect(hits.length).toBe(k);
    // Every hit is a real card (card_id set, present in our card set).
    for (const h of hits) {
      expect(cardIds).toContain(h.cardId);
    }
    // Sanity: the doc chunks really WERE closer than the k-th card (otherwise
    // the test couldn't go red on guard removal). Probe-vs-doc distance ≈ 0.
    const docCloser = await retrieveRawNearest(userId, probe);
    expect(docCloser.startsWith('doc-')).toBe(true);
  });

  test('similarCards() (one card → neighbours) returns card-only neighbours, full count', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const { notebookId, sourceId } = await freshNotebookSource(userId);

    const probe = vectorFixtureFor('similar guard topic');
    // Source card whose stored vector IS the probe.
    const source = await seedBasicCard(app, cookie, { deckId, front: 'source', back: 'a' });
    await insertChunkFixture(userId, source.id, 'source', probe);

    // 6 neighbour cards close to the probe.
    const neighbourIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const c = await seedBasicCard(app, cookie, { deckId, front: `n-${i}`, back: 'a' });
      await insertChunkFixture(userId, c.id, `n-${i}`, nearVectorFixture(probe, 0.05, i + 10));
      neighbourIds.push(c.id);
    }
    // 4 document chunks closer than every neighbour.
    for (let i = 0; i < 4; i++) {
      await insertDocChunk({
        userId,
        notebookId,
        sourceId,
        text: `doc-${i}`,
        embedding: nearVectorFixture(probe, 0.01, i + 1),
        position: i,
      });
    }

    const res = await similarCards({ userId, cardId: source.id, k: 5, minScore: 0 });
    expect(res.reason).toBeUndefined();
    // k neighbours, all real cards (never a document), source excluded.
    expect(res.items.length).toBe(5);
    for (const item of res.items) {
      expect(neighbourIds).toContain(item.cardId);
      expect(item.cardId).not.toBe(source.id);
    }
  });

  test('semanticEdges() yields card-only neighbours — document vectors do not starve the k*2 window', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const deckId = await freshDeck(cookie);
    const { notebookId, sourceId } = await freshNotebookSource(userId);

    const probe = vectorFixtureFor('edges guard topic');
    // A tight cluster of cards (k+ members) so each card has > k card neighbours.
    const cardIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const c = await seedBasicCard(app, cookie, { deckId, front: `e-${i}`, back: 'a' });
      await insertChunkFixture(userId, c.id, `e-${i}`, nearVectorFixture(probe, 0.03, i + 1));
      cardIds.push(c.id);
    }
    // Many document chunks even closer — without the lateral guard they would
    // fill each card's `LIMIT k*2` ANN window, collapsing the edge count.
    for (let i = 0; i < 8; i++) {
      await insertDocChunk({
        userId,
        notebookId,
        sourceId,
        text: `doc-${i}`,
        embedding: nearVectorFixture(probe, 0.005, i + 1),
        position: i,
      });
    }

    const result = await semanticEdges({ userId, k: 3, minScore: 0 });
    // nodes counts only the embedded CARD chunks (document vectors excluded).
    expect(result.nodes).toBe(6);
    expect(result.reason).toBeUndefined();
    // Every edge endpoint is a real card — no document id ever appears.
    const cardSet = new Set(cardIds);
    expect(result.edges.length).toBeGreaterThan(0);
    for (const e of result.edges) {
      expect(cardSet.has(e.a)).toBe(true);
      expect(cardSet.has(e.b)).toBe(true);
    }
    // The card cluster is dense — the edge set is non-trivial and card-only.
    expect(result.edges.length).toBeGreaterThanOrEqual(1);
  });
});

/** Raw nearest-row text by cosine distance (no source_type filter) — proves the
 *  doc fixtures really are closer than the cards, so the guard is load-bearing. */
async function retrieveRawNearest(userId: string, probe: number[]): Promise<string> {
  const lit = `[${probe.join(',')}]`;
  const rows = (await db.execute(sql`
    SELECT kc.text AS text
    FROM kb_chunk kc
    WHERE kc.user_id = ${userId} AND kc.embedding IS NOT NULL
    ORDER BY kc.embedding <=> ${lit}::vector
    LIMIT 1
  `)) as unknown as Array<{ text: string }>;
  return rows[0]?.text ?? '';
}
