// Seed script — populate a single user account with realistic decks + notes +
// generated cards + review history (note-types M1 model). Idempotent: ensures
// the 3 global builtin note-types exist, then wipes the user's existing decks /
// notes / cards / reviews (cascade handles the rest) and rebuilds.
//
//   bun run db:seed                                   # default demo user
//   bun run db:seed -- --email mindtnv@gmail.com      # explicit email
//
// or set the email via env:
//
//   SEED_USER_EMAIL=mindtnv@gmail.com bun run db:seed
//
// With no email given it targets the local demo account
// (demo@neuronexus.local / demodemo123), creating it via BetterAuth on first
// run so you can sign in immediately without going through the sign-up flow.
//
// Each seed entry is a NOTE referencing a builtin note-type. The seeder runs
// `generateCards(noteType, fieldValues)` to produce one-or-more `cards` rows
// (with the denormalized render* columns + renderKind) and an FSRS init, then
// replays each note's `ratings` through ts-fsrs to produce a plausible card
// state (stability, due, reps, lapses) and writes matching rows into `reviews`
// so stats/heatmap look lived-in. Review dates are spread across the past ~21
// days. Deterministic except for the small per-review time jitter.

import { and, count, eq, isNull } from 'drizzle-orm';
import {
  BUILTIN_NOTE_TYPES,
  BUILTIN_BY_KIND,
  generateCards,
  gradeFsrs,
  newFsrsCard,
  stateLabel,
  type NoteTypeDef,
  type Rating,
} from '@reomi/shared';
import { auth } from '@reomi/auth/server';
import { db } from './client.ts';
import { ensureBuiltins } from './ensure-builtins.ts';
import { cards, decks, noteTypes, notes, profile, reviews, user } from './schema/index.ts';
import { SEED_DECKS, type DeckSeed, type NoteSeed } from './seed-data.ts';

const DAY_MS = 24 * 60 * 60 * 1000;

// Local demo account used when no --email / SEED_USER_EMAIL is given. Created
// on first run via BetterAuth so the credentials work in the web sign-in form.
const DEMO_EMAIL = 'demo@neuronexus.local';
const DEMO_PASSWORD = 'demodemo123';
const DEMO_NAME = 'Demo';

function parseEmail(): string {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--email');
  if (idx >= 0 && args[idx + 1]) return args[idx + 1]!;
  const envEmail = process.env.SEED_USER_EMAIL;
  if (envEmail) return envEmail;
  // No email given → fall back to the local demo account.
  return DEMO_EMAIL;
}

/**
 * Look up the seed target by email. If it doesn't exist AND it's the demo
 * account, create it through BetterAuth (so the password hash matches what the
 * sign-in verifier expects). For any other email we refuse to auto-create — the
 * caller is expected to have signed up in the web app first.
 */
async function resolveTargetUser(email: string): Promise<{ id: string; email: string }> {
  const [existing] = await db.select().from(user).where(eq(user.email, email));
  if (existing) return existing;

  if (email !== DEMO_EMAIL) {
    throw new Error(`User ${email} not found. Sign up in the web app first.`);
  }

  // eslint-disable-next-line no-console
  console.log(`[seed] demo user ${email} not found — creating via BetterAuth`);
  await auth.api.signUpEmail({
    body: { email, password: DEMO_PASSWORD, name: DEMO_NAME },
  });

  const [created] = await db.select().from(user).where(eq(user.email, email));
  if (!created) throw new Error(`failed to create demo user ${email}`);
  return created;
}

/**
 * Ensure the 3 global builtin note-types exist (userId NULL, isBuiltin true) via
 * the shared `ensureBuiltins()` writer (idempotent + concurrency-safe, targeted
 * ON CONFLICT on the partial unique index). Then build a name → def map whose
 * `id` is the ACTUAL persisted row id read back from the DB.
 *
 * Why read back instead of trusting `BUILTIN_NOTE_TYPES[].id`: `ensureBuiltins`
 * upserts `ON CONFLICT (name) DO NOTHING`, so on a DB that already has a builtin
 * with that name — but a LEGACY random id (a dev DB seeded before the stable-id
 * refactor / built via `db:push`, never running migration 0007's stable INSERT)
 * — the stable id is NOT written, the legacy row keeps its id. Keying the note
 * inserts off the live row id keeps the `notes.note_type_id` FK valid in both
 * cases (fresh stable-id DB and legacy-id dev DB). The fields/templates/kind
 * still come from `BUILTIN_NOTE_TYPES` (the engine contract for `generateCards`).
 */
async function ensureBuiltinNoteTypes(): Promise<Map<string, NoteTypeDef & { id: string }>> {
  await ensureBuiltins(db);
  const rows = await db
    .select({ id: noteTypes.id, name: noteTypes.name })
    .from(noteTypes)
    .where(and(eq(noteTypes.isBuiltin, true), isNull(noteTypes.userId)));
  const idByName = new Map(rows.map((r) => [r.name, r.id]));
  const byName = new Map<string, NoteTypeDef & { id: string }>();
  for (const def of BUILTIN_NOTE_TYPES) {
    const id = idByName.get(def.name);
    if (!id) throw new Error(`builtin note-type ${def.name} not persisted (ensureBuiltins failed?)`);
    byName.set(def.name, { ...def, id });
  }
  return byName;
}

async function wipeUserData(userId: string) {
  // FK cascade removes cards + reviews when decks/notes go; we delete decks,
  // notes and reviews explicitly for a clean slate. (Builtin note-types are
  // global and intentionally NOT wiped.)
  await db.delete(reviews).where(eq(reviews.userId, userId));
  await db.delete(cards).where(eq(cards.userId, userId));
  await db.delete(notes).where(eq(notes.userId, userId));
  await db.delete(decks).where(eq(decks.userId, userId));
}

function pickReviewTime(rating: Rating, stepIndex: number, totalSteps: number): Date {
  // Spread reviews across the last 21 days. Earlier grades land earlier,
  // most recent ones within the last few days.
  const span = 21 * DAY_MS;
  const start = Date.now() - span;
  const progress = totalSteps <= 1 ? 1 : stepIndex / (totalSteps - 1);
  const jitter = (Math.random() - 0.5) * DAY_MS;
  return new Date(start + progress * span + jitter);
  void rating;
}

/**
 * Replay a list of ratings through ts-fsrs, inserting a review row for each
 * grade. Returns the final FSRS state that will be persisted on the card.
 */
async function replayRatings(
  ratings: Rating[],
  userId: string,
  cardId: string,
  deckId: string,
): Promise<Awaited<ReturnType<typeof gradeFsrs>>['card']> {
  let state = newFsrsCard();
  let lastReviewAt: Date | null = null;

  for (let i = 0; i < ratings.length; i++) {
    const rating = ratings[i]!;
    const reviewedAt = pickReviewTime(rating, i, ratings.length);
    const graded = gradeFsrs(state, rating, reviewedAt, { enableFuzz: false });
    state = graded.card;
    lastReviewAt = reviewedAt;

    await db.insert(reviews).values({
      userId,
      cardId,
      deckId,
      rating,
      durationMs: 2500 + Math.floor(Math.random() * 4500),
      reviewedAt,
      nextDue: state.due,
      nextStability: state.stability,
      nextDifficulty: state.difficulty,
    });
  }

  void lastReviewAt;
  return state;
}

async function insertDeckTree(
  userId: string,
  def: DeckSeed,
  parentId: string | null,
  builtins: Map<string, NoteTypeDef & { id: string }>,
): Promise<void> {
  const [row] = await db
    .insert(decks)
    .values({
      userId,
      parentId: parentId ?? null,
      name: def.name,
      color: def.color,
    })
    .returning();
  if (!row) throw new Error(`failed to insert deck ${def.name}`);

  // Own notes
  if (def.notes && def.notes.length > 0) {
    for (const note of def.notes) {
      await insertNote(userId, row.id, note, builtins);
    }
  }

  // Children
  if (def.children) {
    for (const child of def.children) {
      await insertDeckTree(userId, child, row.id, builtins);
    }
  }
}

/**
 * Insert one note + the cards generated from its note-type's templates, then
 * replay the note's ratings through ts-fsrs onto each generated card. All cards
 * from a note default to the note's deck (Decision A1: card-level deckId).
 */
async function insertNote(
  userId: string,
  deckId: string,
  note: NoteSeed,
  builtins: Map<string, NoteTypeDef & { id: string }>,
): Promise<void> {
  const kind = note.kind ?? 'basic';
  const def = BUILTIN_BY_KIND[kind];
  if (!def) throw new Error(`no builtin note-type for kind ${kind}`);
  const persisted = builtins.get(def.name);
  if (!persisted) throw new Error(`builtin note-type ${def.name} not seeded`);

  const [noteRow] = await db
    .insert(notes)
    .values({
      userId,
      noteTypeId: persisted.id,
      fieldValues: note.fields,
      tags: note.tags ?? [],
    })
    .returning();
  if (!noteRow) throw new Error(`failed to insert note (${def.name})`);

  // Generate the per-template cards. `def` is the full note-type definition
  // (fields + templates + kind) — the engine produces one record per template,
  // skipping templates whose rendered front is empty.
  const generated = generateCards(persisted, note.fields);
  if (generated.length === 0) {
    throw new Error(`note generated no cards (${def.name}): ${JSON.stringify(note.fields)}`);
  }

  const ratings = note.ratings ?? [];
  for (const gen of generated) {
    const initial = newFsrsCard();
    const [cardRow] = await db
      .insert(cards)
      .values({
        userId,
        deckId,
        noteId: noteRow.id,
        templateOrd: gen.templateOrd,
        clozeNumber: gen.clozeNumber,
        renderText: gen.renderText,
        renderFrontText: gen.renderFrontText,
        renderBackText: gen.renderBackText,
        renderKind: gen.renderKind,
        due: initial.due,
        stability: initial.stability,
        difficulty: initial.difficulty,
        elapsedDays: initial.elapsed_days,
        scheduledDays: initial.scheduled_days,
        learningSteps: initial.learning_steps,
        reps: initial.reps,
        lapses: initial.lapses,
        state: stateLabel(initial.state),
      })
      .returning();
    if (!cardRow) throw new Error(`failed to insert card (${def.name})`);

    if (ratings.length === 0) continue;

    const finalState = await replayRatings(ratings, userId, cardRow.id, deckId);

    await db
      .update(cards)
      .set({
        due: finalState.due,
        stability: finalState.stability,
        difficulty: finalState.difficulty,
        elapsedDays: finalState.elapsed_days,
        scheduledDays: finalState.scheduled_days,
        learningSteps: finalState.learning_steps,
        reps: finalState.reps,
        lapses: finalState.lapses,
        state: stateLabel(finalState.state),
        lastReview: finalState.last_review ?? null,
        updatedAt: new Date(),
      })
      .where(eq(cards.id, cardRow.id));
  }
}

/** Tweak profile to match all those reviews so the home banner isn't level 1 / 0 XP. */
async function bumpProfile(userId: string, totalReviews: number) {
  const [existing] = await db.select().from(profile).where(eq(profile.userId, userId));
  const xp = Math.min(20_000, totalReviews * 8); // ≈ mostly-good grades
  const level = Math.max(1, Math.floor(xp / 500) + 1);
  const streakDays = 6; // seeded feels like the user's been at it for a bit
  const plantStage = Math.max(0, Math.min(5, Math.floor(streakDays / 7))) as 0 | 1 | 2 | 3 | 4 | 5;
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);

  if (existing) {
    await db
      .update(profile)
      .set({
        xp,
        level,
        streakDays,
        plantStage,
        lastReviewDate: yesterday, // so today's grade bumps streak to 7
        todayMinutes: 0,
        todayMinutesDate: null,
        dailyGoalMetCount: 4,
        dailyGoalMetDate: yesterday,
        streakFreezes: 1,
        updatedAt: new Date(),
      })
      .where(eq(profile.userId, userId));
  } else {
    await db.insert(profile).values({
      userId,
      name: 'Dev',
      xp,
      level,
      streakDays,
      plantStage,
      lastReviewDate: yesterday,
      dailyGoalMetCount: 4,
      dailyGoalMetDate: yesterday,
      streakFreezes: 1,
    });
  }
  void today;
}

async function main() {
  const email = parseEmail();
  const u = await resolveTargetUser(email);
  // eslint-disable-next-line no-console
  console.log(`[seed] target user: ${u.email} (${u.id})`);

  // eslint-disable-next-line no-console
  console.log(`[seed] ensuring ${BUILTIN_NOTE_TYPES.length} global builtin note-types`);
  const builtins = await ensureBuiltinNoteTypes();

  // eslint-disable-next-line no-console
  console.log('[seed] wiping existing decks / notes / cards / reviews');
  await wipeUserData(u.id);

  // eslint-disable-next-line no-console
  console.log(`[seed] inserting ${SEED_DECKS.length} root decks`);
  for (const root of SEED_DECKS) {
    await insertDeckTree(u.id, root, null, builtins);
  }

  const [{ n: noteCount } = { n: 0 }] = await db
    .select({ n: count(notes.id) })
    .from(notes)
    .where(eq(notes.userId, u.id));
  const [{ n: cardCount } = { n: 0 }] = await db
    .select({ n: count(cards.id) })
    .from(cards)
    .where(eq(cards.userId, u.id));
  const [{ n: totalReviews } = { n: 0 }] = await db
    .select({ n: count(reviews.id) })
    .from(reviews)
    .where(eq(reviews.userId, u.id));
  // eslint-disable-next-line no-console
  console.log(
    `[seed] inserted ${noteCount} notes, ${cardCount} cards, ${totalReviews} reviews; adjusting profile`,
  );
  await bumpProfile(u.id, totalReviews);

  // eslint-disable-next-line no-console
  console.log('[seed] done.');
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[seed] failed:', err);
  process.exit(1);
});
