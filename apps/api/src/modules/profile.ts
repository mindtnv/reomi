import { Elysia, t } from 'elysia';
import { eq, isNull, or } from 'drizzle-orm';
import {
  cards,
  db,
  decks,
  noteTypes,
  notes,
  notificationSettings,
  profile,
  reviews,
  user as userTable,
} from '@reomi/db';
import { MAX_RETENTION, MIN_RETENTION, PLANT_SPECIES, type PlantSpecies } from '@reomi/shared';
import { authPlugin } from '../auth-plugin.ts';
import { requestLogFromContext } from '../logger.ts';
import { deleteAccountStorage } from '../media-gc.ts';

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
  // Full data export. Returns everything we have on the user in a single JSON
  // blob — profile, decks, note-types, notes, cards, reviews. Intentionally not
  // paginated: a dedicated user shouldn't have more than a few MB of history,
  // and GDPR wants "the whole thing". Note-types include the user's own types
  // PLUS the global builtins their notes reference (so the export is complete).
  .get(
    '/export',
    async ({ user }) => {
      const [profileRow] = await db.select().from(profile).where(eq(profile.userId, user.id));
      const [reminderRow] = await db.select().from(notificationSettings).where(eq(notificationSettings.userId, user.id));
      const [decksRows, noteTypesRows, notesRows, cardsRows, reviewsRows] = await Promise.all([
        db.select().from(decks).where(eq(decks.userId, user.id)),
        db
          .select()
          .from(noteTypes)
          .where(or(eq(noteTypes.userId, user.id), isNull(noteTypes.userId))),
        db.select().from(notes).where(eq(notes.userId, user.id)),
        db.select().from(cards).where(eq(cards.userId, user.id)),
        db.select().from(reviews).where(eq(reviews.userId, user.id)),
      ]);
      return {
        exportedAt: new Date().toISOString(),
        user: { id: user.id, email: user.email, name: user.name },
        profile: profileRow ?? null,
        decks: decksRows,
        noteTypes: noteTypesRows,
        notes: notesRows,
        cards: cardsRows,
        reviews: reviewsRows,
        reminders: reminderRow
          ? {
              digestEnabled: reminderRow.digestEnabled,
              streakWarningEnabled: reminderRow.streakWarningEnabled,
              timeZone: reminderRow.timeZone,
              digestHour: reminderRow.digestHour,
              streakHour: reminderRow.streakHour,
              emailEnabled: reminderRow.emailEnabled,
              pushEnabled: reminderRow.pushEnabled,
              locale: reminderRow.locale,
              updatedAt: reminderRow.updatedAt,
            }
          : null,
      };
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
