// Semantic-graph read endpoints: per-card "similar cards" + whole-graph
// semantic edges. Both are computed from ALREADY-STORED kb_chunk embeddings —
// NO embedding API call happens here, so these endpoints deliberately do NOT
// gate on `embeddingEnabled` (they work whenever index data exists, e.g. after
// the key was removed). A user with no embedded chunks gets an honest 200
// `{ ..., reason: 'not_indexed' }` degrade, never an error.
//
// Vectors themselves never leave the server — responses carry only card ids,
// scores and short text snippets.

import { Elysia, t } from 'elysia';
import { and, eq } from 'drizzle-orm';
import { cards, db } from '@reomi/db';
import { authPlugin } from '../auth-plugin.ts';
import { similarCards } from '../ai/similar.ts';
import { semanticEdges } from '../ai/semantic-edges.ts';

/** Parse an optional numeric query param ('' / garbage → undefined). */
function parseNum(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export const cardsSimilarModule = new Elysia({ prefix: '/cards' })
  .use(authPlugin)
  // Top-k semantically similar cards for one OWNED card. Ownership first:
  // a foreign/missing id is a 404 (same contract as GET /cards/:id), only then
  // is the stored-vector lookup run.
  .get(
    '/:id/similar',
    async ({ user, params, query, status }) => {
      const [row] = await db
        .select({ id: cards.id })
        .from(cards)
        .where(and(eq(cards.id, params.id), eq(cards.userId, user.id)))
        .limit(1);
      if (!row) return status(404, { error: 'not_found' });
      return similarCards({
        userId: user.id,
        cardId: params.id,
        k: parseNum(query.k),
        minScore: parseNum(query.minScore),
      });
    },
    {
      auth: true,
      params: t.Object({ id: t.String({ format: 'uuid' }) }),
      query: t.Object({
        k: t.Optional(t.String()),
        minScore: t.Optional(t.String()),
      }),
    },
  );

export const graphModule = new Elysia({ prefix: '/graph' })
  .use(authPlugin)
  // Undirected semantic edges over the user's embedded cards (for /graph).
  .get(
    '/semantic-edges',
    async ({ user, query }) => {
      return semanticEdges({
        userId: user.id,
        k: parseNum(query.k),
        minScore: parseNum(query.minScore),
        maxEdges: parseNum(query.limit),
      });
    },
    {
      auth: true,
      query: t.Object({
        k: t.Optional(t.String()),
        minScore: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    },
  );
