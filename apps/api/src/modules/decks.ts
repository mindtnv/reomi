import { moveDeckInTransaction } from './ui-action-mutations';
import { Elysia, t } from 'elysia';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db, deckOptionsPreset, decks } from '@reomi/db';
import { DECK_COLORS } from '@reomi/shared';
import { authPlugin } from '../auth-plugin.ts';

const deckColorSchema = t.Union(DECK_COLORS.map(color => t.Literal(color)));

export const decksModule = new Elysia({ prefix: '/decks' })
  .use(authPlugin)
  .get('/', async ({ user }) => {
    const rows = await db.select().from(decks).where(eq(decks.userId, user.id));
    return rows;
  }, { auth: true })
  .post(
    '/',
    async ({ user, body, status }) => db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${user.id}, 73))`);
      if (body.parentId) {
        const parent = await tx
          .select({ id: decks.id })
          .from(decks)
          .where(and(eq(decks.id, body.parentId), eq(decks.userId, user.id)))
          .limit(1);
        if (parent.length === 0) return status(400, { error: 'parent_not_found' });
      }
      const [last] = await tx.select({ maximum: sql<number>`coalesce(max(${decks.position}), -1)` }).from(decks).where(eq(decks.userId, user.id));
      const [created] = await tx
        .insert(decks)
        .values({
          userId: user.id,
          name: body.name,
          color: body.color ?? 'lime',
          icon: body.icon,
          position: Number(last?.maximum ?? -1) + 1,
          parentId: body.parentId,
        })
        .returning();
      return created;
    }),
    {
      auth: true,
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 100 }),
        color: t.Optional(deckColorSchema),
        icon: t.Optional(t.String()),
        parentId: t.Optional(t.String({ format: 'uuid' })),
      }),
    },
  )
  .patch(
    '/:id',
    async ({ user, params, body, status }) => db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${user.id}, 73))`);
      // Cycle guard: if setting parentId, ensure target isn't a descendant of this deck.
      if (body.parentId) {
        if (body.parentId === params.id) return status(400, { error: 'cycle' });
        const all = await tx
          .select({ id: decks.id, parentId: decks.parentId })
          .from(decks)
          .where(eq(decks.userId, user.id))
          .orderBy(asc(decks.id))
          .for('update');
        if (!all.some((deck) => deck.id === body.parentId)) return status(400, { error: 'parent_not_found' });
        let cursor: string | null = body.parentId;
        const seen = new Set<string>();
        while (cursor) {
          if (cursor === params.id) return status(400, { error: 'cycle' });
          if (seen.has(cursor)) break;
          seen.add(cursor);
          const row: { id: string; parentId: string | null } | undefined = all.find((d) => d.id === cursor);
          cursor = row?.parentId ?? null;
        }
      }
      // Preset binding: a non-null presetId must reference a preset owned by the
      // same user before we bind it. `null` unbinds (FK is nullable). The DB FK
      // `ON DELETE SET NULL` only unbinds on preset DELETE — this guards the
      // bind direction so a user can't attach another user's preset.
      if (body.presetId) {
        const owned = await tx
          .select({ id: deckOptionsPreset.id })
          .from(deckOptionsPreset)
          .where(and(eq(deckOptionsPreset.id, body.presetId), eq(deckOptionsPreset.userId, user.id)))
          .limit(1);
        if (owned.length === 0) return status(404, { error: 'preset_not_found' });
      }
      const [updated] = await tx
        .update(decks)
        .set(body)
        .where(and(eq(decks.id, params.id), eq(decks.userId, user.id)))
        .returning();
      if (!updated) return status(404, { error: 'not_found' });
      return updated;
    }),
    {
      auth: true,
      params: t.Object({ id: t.String({ format: 'uuid' }) }),
      body: t.Partial(
        t.Object({
          name: t.String({ minLength: 1, maxLength: 100 }),
          color: deckColorSchema,
          icon: t.String(),
          parentId: t.Union([t.String({ format: 'uuid' }), t.Null()]),
          presetId: t.Union([t.String({ format: 'uuid' }), t.Null()]),
        }),
      ),
    },
  )
  .post('/:id/move', async ({ user, params, body }) => db.transaction(async tx => {
    return (await moveDeckInTransaction(tx, user.id, params.id, body)).result;
  }), { auth: true, params: t.Object({ id: t.String({ format: 'uuid' }) }), body: t.Object({
    targetId: t.Union([t.String({ format: 'uuid' }), t.Null()]),
    placement: t.Union([t.Literal('before'), t.Literal('after'), t.Literal('inside')]),
  }) })
  .delete(
    '/:id',
    async ({ user, params, status }) => db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${user.id}, 73))`);
      // Cascade handled by FK ON DELETE CASCADE on parent_id + deck_id (cards/reviews).
      const [deleted] = await tx
        .delete(decks)
        .where(and(eq(decks.id, params.id), eq(decks.userId, user.id)))
        .returning({ id: decks.id });
      if (!deleted) return status(404, { error: 'not_found' });
      return { ok: true };
    }),
    { auth: true, params: t.Object({ id: t.String({ format: 'uuid' }) }) },
  );
