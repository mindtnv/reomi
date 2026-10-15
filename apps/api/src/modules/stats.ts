// Read-only stats endpoints for the web stats screen: the forward-looking due
// forecast and the interval-bucketed retention curve. Thin HTTP wrappers over
// the user-scoped aggregation helpers in progress-stats.ts (which the agent's
// read-tools also use) — `user.id` is the mandatory first conjunct on every
// query down there.
//
// Lives in its own `/stats` module rather than reviews.ts: the forecast reads
// `cards` (not `reviews`), and reviews.ts already carries the grade
// transaction. An optional `deckId` query param scopes either endpoint to that
// deck's SUBTREE (resolved via the exported server-side `descendantIds` walker
// — the same pattern as the study_stats tool). A foreign/un-owned deckId
// resolves to an empty scope, never a global fallback.

import { Elysia, t } from 'elysia';
import { eq } from 'drizzle-orm';
import { db, decks } from '@reomi/db';
import { authPlugin } from '../auth-plugin.ts';
import { internalReadDeckScope } from '../mcp/internal-read.ts';
import { descendantIds } from './cards.ts';
import { deckBreakdown, dueForecast, retentionCurve, studyOverview } from './progress-stats.ts';

/** Resolve an optional deckId query param to its owned subtree (or undefined). */
async function resolveDeckScope(
  userId: string,
  deckId: string | undefined,
  allowed?: readonly string[],
): Promise<string[] | undefined> {
  if (!deckId) return allowed ? [...allowed] : undefined;
  const userDecks = await db
    .select({ id: decks.id, parentId: decks.parentId, name: decks.name })
    .from(decks)
    .where(eq(decks.userId, userId));
  if (!userDecks.some((deck) => deck.id === deckId)) return [];
  const ids = [deckId, ...descendantIds(deckId, userDecks)];
  return allowed ? ids.filter(id => allowed.includes(id)) : ids;
}

/** Parse an optional numeric query param ('' / garbage → undefined). */
function parseDays(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

const statsQuerySchema = t.Object({
  days: t.Optional(t.String()),
  deckId: t.Optional(t.String()),
});

export const statsModule = new Elysia({ prefix: '/stats' })
  .use(authPlugin)
  .get(
    '/forecast',
    async ({ user, query, request }) => {
      const deckIds = await resolveDeckScope(user.id, query.deckId, internalReadDeckScope(request));
      return dueForecast({ userId: user.id, deckIds, days: parseDays(query.days) });
    },
    { auth: true, query: statsQuerySchema },
  )
  .get(
    '/retention',
    async ({ user, query, request }) => {
      const deckIds = await resolveDeckScope(user.id, query.deckId, internalReadDeckScope(request));
      return retentionCurve({ userId: user.id, deckIds, days: parseDays(query.days) });
    },
    { auth: true, query: statsQuerySchema },
  )
  .get(
    '/overview',
    async ({ user, query, request }) => {
      const deckIds = await resolveDeckScope(user.id, query.deckId, internalReadDeckScope(request));
      const owned = !query.deckId || deckIds?.includes(query.deckId) === true;
      return studyOverview({
        userId: user.id,
        deckIds,
        targetDeckId: query.deckId ? (owned ? query.deckId : null) : undefined,
        days: parseDays(query.days),
      });
    },
    { auth: true, query: statsQuerySchema },
  )
  .get(
    '/decks',
    async ({ user, query }) => deckBreakdown(user.id, parseDays(query.days)),
    { auth: true, query: statsQuerySchema },
  );
