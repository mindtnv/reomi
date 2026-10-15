// Filtered (custom-study / cram) decks — CRUD (Milestone 3, Phase 7, Decision 4).
//
// A `filtered_deck` row is a saved, re-runnable card query: a `query` (the M1
// card-query language), a `sortOrder` (one of SORT_ORDERS, applied OUTSIDE the
// AST), a `cardLimit`, and an `includeSuspended` toggle. It NEVER moves cards
// out of their home decks — the session is built fresh each run by
// `GET /cards/queue?filteredDeckId=` (the filtered branch). All routes are
// auth-gated and every query is scoped by `user.id`. The `query` string is
// validated at WRITE time (`parseCardQuery` → 400 on `CardQueryError`).

import { Elysia, t } from 'elysia';
import { and, eq } from 'drizzle-orm';
import { db, filteredDeck } from '@reomi/db';
import { CardQueryError, parseCardQuery } from '@reomi/shared';
import { authPlugin } from '../auth-plugin.ts';

// The session sort-order enum — single source of truth. The queue's filtered
// branch imports this tuple to map each value onto a `cards` column (Decision 4):
//   due            → cards.due ASC
//   added          → cards.createdAt DESC
//   random         → ORDER BY random()
//   difficultyDesc → cards.difficulty DESC (hard-first)
//   overdue        → cards.due ASC + a `due <= now` gate in the WHERE
//   lapses         → cards.lapses DESC (most-lapsed first)
//   cram           → cards.due ASC, NO due-gate (returns future-due cards — Decision 5)
export const SORT_ORDERS = [
  'due',
  'added',
  'random',
  'difficultyDesc',
  'overdue',
  'lapses',
  'cram',
] as const;
export type SortOrder = (typeof SORT_ORDERS)[number];

const sortOrderSchema = t.Union(SORT_ORDERS.map((o) => t.Literal(o)));
const cardLimitSchema = t.Integer({ minimum: 1, maximum: 1000 });

/** Validate that a query string parses (caps). Returns true when safe. */
function queryParses(query: string): boolean {
  try {
    parseCardQuery(query);
    return true;
  } catch (err) {
    if (err instanceof CardQueryError) return false;
    throw err;
  }
}

export const filteredDecksModule = new Elysia({ prefix: '/filtered-decks' })
  .use(authPlugin)
  .get(
    '/',
    async ({ user }) => {
      const rows = await db
        .select()
        .from(filteredDeck)
        .where(eq(filteredDeck.userId, user.id));
      return rows;
    },
    { auth: true },
  )
  .post(
    '/',
    async ({ user, body, status }) => {
      if (!queryParses(body.query)) return status(400, { error: 'bad_query' });
      const [created] = await db
        .insert(filteredDeck)
        .values({
          userId: user.id,
          name: body.name,
          query: body.query,
          sortOrder: body.sortOrder ?? 'due',
          cardLimit: body.cardLimit ?? 50,
          includeSuspended: body.includeSuspended ?? false,
        })
        .returning();
      return created;
    },
    {
      auth: true,
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 100 }),
        query: t.String(),
        sortOrder: t.Optional(sortOrderSchema),
        cardLimit: t.Optional(cardLimitSchema),
        includeSuspended: t.Optional(t.Boolean()),
      }),
    },
  )
  .patch(
    '/:id',
    async ({ user, params, body, status }) => {
      if (body.query !== undefined && !queryParses(body.query)) {
        return status(400, { error: 'bad_query' });
      }
      const [updated] = await db
        .update(filteredDeck)
        .set({ ...body, updatedAt: new Date() })
        .where(and(eq(filteredDeck.id, params.id), eq(filteredDeck.userId, user.id)))
        .returning();
      if (!updated) return status(404, { error: 'not_found' });
      return updated;
    },
    {
      auth: true,
      params: t.Object({ id: t.String({ format: 'uuid' }) }),
      body: t.Partial(
        t.Object({
          name: t.String({ minLength: 1, maxLength: 100 }),
          query: t.String(),
          sortOrder: sortOrderSchema,
          cardLimit: cardLimitSchema,
          includeSuspended: t.Boolean(),
        }),
      ),
    },
  )
  .delete(
    '/:id',
    async ({ user, params, status }) => {
      const [deleted] = await db
        .delete(filteredDeck)
        .where(and(eq(filteredDeck.id, params.id), eq(filteredDeck.userId, user.id)))
        .returning({ id: filteredDeck.id });
      if (!deleted) return status(404, { error: 'not_found' });
      return { ok: true };
    },
    { auth: true, params: t.Object({ id: t.String({ format: 'uuid' }) }) },
  );
