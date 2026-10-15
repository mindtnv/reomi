// Deck option presets — CRUD (Milestone 3, Phase 5, Decision 1).
//
// A `deck_options_preset` is a named, reusable FSRS/scheduling config bindable
// to one or more decks (via `PATCH /decks/:id { presetId }`). All routes are
// auth-gated and every query is scoped by `user.id`. Steps are validated at
// WRITE time against the ts-fsrs duration-string grammar (reused from the
// resolver's `isValidSteps`); `desiredRetention` is validated against the
// SINGLE source for the range (`MIN_RETENTION`/`MAX_RETENTION` in @reomi/
// shared) so it can't drift from the scheduler clamp.

import { Elysia, t } from 'elysia';
import { and, count, eq } from 'drizzle-orm';
import { db, deckOptionsPreset, decks } from '@reomi/db';
import { MAX_RETENTION, MIN_RETENTION } from '@reomi/shared';
import { authPlugin } from '../auth-plugin.ts';
import { isValidSteps } from './deck-config.ts';

// Shared range bounds for the integer-valued preset fields. Generous caps —
// the daily limits and intervals are user-facing knobs, not security surface.
const newPerDaySchema = t.Integer({ minimum: 0, maximum: 9999 });
const reviewsPerDaySchema = t.Integer({ minimum: 0, maximum: 9999 });
const leechThresholdSchema = t.Integer({ minimum: 1, maximum: 999 });
const maximumIntervalSchema = t.Integer({ minimum: 1, maximum: 36500 });
const stepsSchema = t.Array(t.String());
// desiredRetention: NULLABLE override (null ⇒ inherit profile/ANKI default).
// Range is checked in-handler against the shared bounds (not in the typebox
// schema) so the single source stays `MIN_RETENTION`/`MAX_RETENTION`.
const retentionSchema = t.Optional(t.Union([t.Number(), t.Null()]));

/**
 * Validate the per-field business rules beyond what typebox enforces. Returns
 * an error code (→ 400) or null when the provided fields are all valid. Only
 * checks fields that are present (supports partial PATCH bodies).
 */
function validatePresetFields(body: {
  learningSteps?: string[];
  relearningSteps?: string[];
  desiredRetention?: number | null;
}): string | null {
  if (body.learningSteps !== undefined && !isValidSteps(body.learningSteps)) {
    return 'bad_learning_steps';
  }
  if (body.relearningSteps !== undefined && !isValidSteps(body.relearningSteps)) {
    return 'bad_relearning_steps';
  }
  if (
    body.desiredRetention !== undefined &&
    body.desiredRetention !== null &&
    (body.desiredRetention < MIN_RETENTION || body.desiredRetention > MAX_RETENTION)
  ) {
    return 'bad_retention';
  }
  return null;
}

export const deckOptionsModule = new Elysia({ prefix: '/deck-options' })
  .use(authPlugin)
  .get(
    '/',
    async ({ user }) => {
      const rows = await db
        .select()
        .from(deckOptionsPreset)
        .where(eq(deckOptionsPreset.userId, user.id));
      return rows;
    },
    { auth: true },
  )
  .post(
    '/',
    async ({ user, body, status }) => {
      const err = validatePresetFields(body);
      if (err) return status(400, { error: err });
      const [created] = await db
        .insert(deckOptionsPreset)
        .values({
          userId: user.id,
          name: body.name,
          newPerDay: body.newPerDay,
          reviewsPerDay: body.reviewsPerDay,
          learningSteps: body.learningSteps,
          relearningSteps: body.relearningSteps,
          desiredRetention: body.desiredRetention ?? null,
          leechThreshold: body.leechThreshold,
          maximumInterval: body.maximumInterval,
        })
        .returning();
      return created;
    },
    {
      auth: true,
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 100 }),
        newPerDay: newPerDaySchema,
        reviewsPerDay: reviewsPerDaySchema,
        learningSteps: stepsSchema,
        relearningSteps: stepsSchema,
        desiredRetention: retentionSchema,
        leechThreshold: leechThresholdSchema,
        maximumInterval: maximumIntervalSchema,
      }),
    },
  )
  .patch(
    '/:id',
    async ({ user, params, body, status }) => {
      const err = validatePresetFields(body);
      if (err) return status(400, { error: err });
      const [updated] = await db
        .update(deckOptionsPreset)
        .set({ ...body, updatedAt: new Date() })
        .where(and(eq(deckOptionsPreset.id, params.id), eq(deckOptionsPreset.userId, user.id)))
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
          newPerDay: newPerDaySchema,
          reviewsPerDay: reviewsPerDaySchema,
          learningSteps: stepsSchema,
          relearningSteps: stepsSchema,
          desiredRetention: t.Union([t.Number(), t.Null()]),
          leechThreshold: leechThresholdSchema,
          maximumInterval: maximumIntervalSchema,
        }),
      ),
    },
  )
  .delete(
    '/:id',
    async ({ user, params, status }) => {
      // Count the decks bound to this preset BEFORE deleting so the web confirm
      // dialog can warn "N decks will revert to inherited/default" (Must-Fix #9,
      // matching the decks.deleteConfirm subtree-warning convention). The FK
      // `ON DELETE SET NULL` unbinds those decks automatically at the DB level.
      const [{ n: affectedDecks }] = await db
        .select({ n: count() })
        .from(decks)
        .where(and(eq(decks.presetId, params.id), eq(decks.userId, user.id)));
      const [deleted] = await db
        .delete(deckOptionsPreset)
        .where(and(eq(deckOptionsPreset.id, params.id), eq(deckOptionsPreset.userId, user.id)))
        .returning({ id: deckOptionsPreset.id });
      if (!deleted) return status(404, { error: 'not_found' });
      return { ok: true, affectedDecks };
    },
    { auth: true, params: t.Object({ id: t.String({ format: 'uuid' }) }) },
  );
