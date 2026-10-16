import { Elysia, t } from 'elysia';
import { eq } from 'drizzle-orm';
import { db, profile, user as userTable } from '@reomi/db';
import { MAX_RETENTION, MIN_RETENTION, PLANT_SPECIES, type PlantSpecies } from '@reomi/shared';
import { authPlugin } from '../auth-plugin.ts';
import { requestLogFromContext } from '../logger.ts';
import { deleteAccountStorage } from '../media-gc.ts';
import { StudyExportTooLarge, loadStudySnapshot, rehearsalReport } from '../profile/study-snapshot.ts';

const plantSpeciesSchema = t.Union([
  t.Literal('fern'),
  t.Literal('cactus'),
  t.Literal('succulent'),
  t.Literal('bonsai'),
  t.Literal('sakura'),
  t.Literal('mushroom'),
]);

// Narrow the TypeBox-inferred union back to our domain type.
const asSpecies = (v: unknown): PlantSpecies => v as PlantSpecies;
void PLANT_SPECIES;

export const profileModule = new Elysia({ prefix: '/profile' })
  .use(authPlugin)
  .get(
    '/',
    async ({ user }) => {
      const rows = await db.select().from(profile).where(eq(profile.userId, user.id));
      if (rows.length === 0) {
        // Lazy-create on first read — avoids a separate "finish signup" round trip.
        await db
          .insert(profile)
          .values({ userId: user.id, name: user.name ?? 'Friend' })
          .onConflictDoNothing({ target: profile.userId });
        const [created] = await db.select().from(profile).where(eq(profile.userId, user.id));
        return created;
      }
      return rows[0];
    },
    { auth: true },
  )
  .patch(
    '/',
    async ({ user, body, status }) => {
      // If the user tries to switch to a plant species, make sure they have
      // it unlocked. Keeps a future client UI from racing past the achievement
      // reward logic.
      const species = body.plantSpecies ? asSpecies(body.plantSpecies) : undefined;
      if (species) {
        const [row] = await db
          .select({ unlocked: profile.unlockedSpecies })
          .from(profile)
          .where(eq(profile.userId, user.id))
          .limit(1);
        const unlocked = row?.unlocked ?? ['fern'];
        if (!unlocked.includes(species)) {
          return status(400, { error: 'species_locked' });
        }
      }
      const patch: Record<string, unknown> = { ...body, updatedAt: new Date() };
      if (species) patch.plantSpecies = species;
      // C5 — standing agent instructions: whitespace-only ⇒ NULL (cleared), so
      // the prompt builder's presence check stays meaningful.
      if (body.agentInstructions !== undefined) {
        const trimmed = body.agentInstructions.trim();
        patch.agentInstructions = trimmed.length > 0 ? trimmed : null;
      }
      const [updated] = await db
        .update(profile)
        .set(patch)
        .where(eq(profile.userId, user.id))
        .returning();
      if (!updated) throw new Error('profile not found');
      return updated;
    },
    {
      auth: true,
      body: t.Partial(
        t.Object({
          name: t.String({ minLength: 1, maxLength: 80 }),
          dailyGoalMinutes: t.Integer({ minimum: 1, maximum: 600 }),
          desiredRetention: t.Number({ minimum: MIN_RETENTION, maximum: MAX_RETENTION }),
          plantStage: t.Integer({ minimum: 0, maximum: 5 }),
          plantSpecies: plantSpeciesSchema,
          // Standing instructions for the agentic chat (C5). Cap 2000 chars.
          agentInstructions: t.String({ maxLength: 2000 }),
        }),
      ),
    },
  )
  // One repeatable-read snapshot. The first statement pins the view so a grade
  // that commits during the read cannot appear without its card state.
  .get(
    '/export',
    async ({ user, set, status }) => {
      try {
        const snapshot = await loadStudySnapshot(user.id);
        set.headers['content-disposition'] = 'attachment; filename="reomi-study-export.json"';
        set.headers['cache-control'] = 'no-store';
        set.headers['x-content-type-options'] = 'nosniff';
        return snapshot;
      } catch (error) {
        if (error instanceof StudyExportTooLarge) {
          return status(413, { error: 'export_too_large', maxBytes: error.maxBytes });
        }
        throw error;
      }
    },
    { auth: true },
  )
  .post(
    '/export/rehearse',
    async ({ user, status }) => {
      const started = Date.now();
      try {
        const snapshot = await loadStudySnapshot(user.id);
        return rehearsalReport(snapshot, started);
      } catch (error) {
        if (error instanceof StudyExportTooLarge) {
          return status(413, { error: 'export_too_large', maxBytes: error.maxBytes });
        }
        throw error;
      }
    },
    { auth: true },
  )
  // Requires the user to retype their current email as confirmation — cheap
  // protection against XSRF / accidental clicks.
  .delete(
    '/',
    async (context) => {
      const { user, body, status } = context;
      const log = requestLogFromContext(context);
      if (body.confirmEmail.trim().toLowerCase() !== (user.email ?? '').toLowerCase()) {
        return status(400, { error: 'email_mismatch' });
      }
      try {
        await deleteAccountStorage(user.id);
      } catch (error) {
        log.warn(
          { event: 'profile.storage_cleanup_failed', userId: user.id, errName: error instanceof Error ? error.name : 'Error' },
          'profile.storage_cleanup_failed',
        );
        return status(502, { error: 'storage_cleanup_failed' });
      }
      await db.delete(userTable).where(eq(userTable.id, user.id));
      return { ok: true };
    },
    {
      auth: true,
      body: t.Object({
        confirmEmail: t.String({ minLength: 3, maxLength: 320 }),
      }),
    },
  );
