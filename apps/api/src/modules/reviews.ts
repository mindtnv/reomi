import { createHash } from 'node:crypto';
import { Elysia, t, status } from 'elysia';
import { and, count, desc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import {
  cards,
  db,
  deckOptionsPreset,
  decks,
  profile,
  reviews,
  reviewOperations,
  type UndoSnapshot,
} from '@reomi/db';
import {
  applyGradeRollup,
  gradeFsrs,
  isLeech,
  MAX_REVIEW_DURATION_MS,
  nextDailyCounts,
  stateLabel,
  State,
  todayISO,
  xpForRating,
  type FsrsCard,
} from '@reomi/shared';
import { authPlugin } from '../auth-plugin.ts';
import { resolveDeckConfig } from './deck-config.ts';

const stateFromLabel: Record<string, State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
};

const gradeInput = t.Object({
    cardId: t.String({ format: 'uuid' }),
    rating: t.Union([t.Literal(1), t.Literal(2), t.Literal(3), t.Literal(4)]),
    durationMs: t.Optional(t.Integer({ minimum: 0 })),
    expectedReps: t.Optional(t.Integer({ minimum: 0 })),
    expectedUpdatedAt: t.Optional(t.String({ format: 'date-time' })),
    // Grade origin: 'filtered' (custom-study / cram) grades skip the GLOBAL
    // daily counters so a cram run never blocks the regular queue. Default
    // ('regular' / omitted) consumes the daily budget.
    source: t.Optional(t.Union([t.Literal('regular'), t.Literal('filtered')])),
  });
type GradeInput = typeof gradeInput.static;

async function gradeReview(user:{id:string;name?:string|null}, body:GradeInput, operationId?:string) {
  const argumentsHash = createHash('sha256').update(JSON.stringify([
    body.cardId,body.rating,body.durationMs??0,body.source??'regular',body.expectedReps??null,
    body.expectedUpdatedAt?new Date(body.expectedUpdatedAt).toISOString():null,
  ])).digest('hex');
  const durationMs = Math.min(body.durationMs ?? 0, MAX_REVIEW_DURATION_MS);
  return await db.transaction(async (tx) => {
    // All study writes take the profile lock before any card lock. This
    // serializes the user's rollups across tabs and API instances.
    await tx.insert(profile)
      .values({ userId: user.id, name: user.name ?? 'Friend' })
      .onConflictDoNothing({ target: profile.userId });
    const [existingProfile] = await tx
      .select()
      .from(profile)
      .where(eq(profile.userId, user.id))
      .for('update');
    if (operationId) {
      const [receipt]=await tx.select().from(reviewOperations).where(and(eq(reviewOperations.userId,user.id),eq(reviewOperations.operationId,operationId))).limit(1);
      if (receipt) {
        if(receipt.argumentsHash!==argumentsHash)return status(409,{error:'operation_conflict'});
        if(!receipt.reviewId)return status(409,{error:'operation_reverted'});
        return {...receipt.result,replayed:true};
      }
    }
    const [card] = await tx
      .select()
      .from(cards)
      .where(and(eq(cards.id, body.cardId), eq(cards.userId, user.id)))
      .limit(1)
      .for('update');
    if (!card) return status(404, { error: 'card_not_found' });
    if (card.suspended) return status(409, { error: 'card_suspended' });
    if (
      (body.expectedReps !== undefined && body.expectedReps !== card.reps) ||
      (body.expectedUpdatedAt !== undefined &&
        new Date(body.expectedUpdatedAt).getTime() !== card.updatedAt.getTime())
    ) return status(409, { error: 'card_changed' });

    const now = new Date(Math.max(Date.now(), card.updatedAt.getTime() + 1, (existingProfile?.updatedAt.getTime() ?? 0) + 1));

    // Pre-grade snapshot (Principle 4 / B5). Captures the EXACT mutate-set
    // BEFORE the FSRS step + rollup touch the card / profile, so undo can
    // restore byte-identically. Dates → ISO strings for JSONB; rebuilt via
    // `new Date(...)` in the undo handler. For `source:'filtered'` grades
    // the daily counters aren't mutated, so their pre-values == post-values
    // and restore is a no-op — correct by construction.
    const undoSnapshot: UndoSnapshot = {
      card: {
        due: card.due.toISOString(),
        stability: card.stability,
        difficulty: card.difficulty,
        elapsedDays: card.elapsedDays,
        scheduledDays: card.scheduledDays,
        learningSteps: card.learningSteps,
        reps: card.reps,
        lapses: card.lapses,
        state: card.state,
        lastReview: card.lastReview ? card.lastReview.toISOString() : null,
        suspended: card.suspended,
        updatedAt: card.updatedAt.toISOString(),
      },
      profile: existingProfile
        ? {
            streakDays: existingProfile.streakDays,
            streakFreezes: existingProfile.streakFreezes,
            lastReviewDate: existingProfile.lastReviewDate,
            todayMinutes: existingProfile.todayMinutes,
            todayMinutesDate: existingProfile.todayMinutesDate,
            dailyGoalMetCount: existingProfile.dailyGoalMetCount,
            dailyGoalMetDate: existingProfile.dailyGoalMetDate,
            xp: existingProfile.xp,
            level: existingProfile.level,
            plantStage: existingProfile.plantStage,
            newIntroducedToday: existingProfile.newIntroducedToday,
            reviewsDoneToday: existingProfile.reviewsDoneToday,
            dailyCountsDate: existingProfile.dailyCountsDate,
            updatedAt: existingProfile.updatedAt.toISOString(),
          }
        : null,
    };

    // Snapshot for the per-deck config resolver (Principle 1): two batched
    // reads — the user's decks + presets — so `resolveDeckConfig` runs
    // synchronously with ZERO extra round-trips inside this transaction.
    const userDecks = await tx.select().from(decks).where(eq(decks.userId, user.id));
    const userPresets = await tx
      .select()
      .from(deckOptionsPreset)
      .where(eq(deckOptionsPreset.userId, user.id));
    const presetsById = new Map(userPresets.map((p) => [p.id, p]));
    const cfg = resolveDeckConfig(card.deckId, {
      userDecks,
      presetsById,
      profile: existingProfile ?? null,
    });

    // PRE-grade state — classifies new-introduction vs review for the
    // daily counters BEFORE the FSRS step mutates `state`.
    const wasNew = card.state === 'new';

    // FSRS step
    const fsrsCard: FsrsCard = {
      due: card.due,
      stability: card.stability,
      difficulty: card.difficulty,
      elapsed_days: card.elapsedDays,
      scheduled_days: card.scheduledDays,
      learning_steps: card.learningSteps,
      reps: card.reps,
      lapses: card.lapses,
      state: stateFromLabel[card.state] ?? State.New,
      last_review: card.lastReview ?? undefined,
    };
    const res = gradeFsrs(fsrsCard, body.rating, now, {
      requestRetention: cfg.desiredRetention,
      learningSteps: cfg.learningSteps,
      relearningSteps: cfg.relearningSteps,
      maximumInterval: cfg.maximumInterval,
    });

    // Leech detection — auto-suspend once the resolved threshold crossed.
    const nowLeech = isLeech(res.card.lapses, cfg.leechThreshold);
    const shouldSuspend = nowLeech && !isLeech(card.lapses, cfg.leechThreshold);

    const [updatedCard] = await tx
      .update(cards)
      .set({
        due: new Date(res.card.due),
        stability: res.card.stability,
        difficulty: res.card.difficulty,
        elapsedDays: res.card.elapsed_days,
        scheduledDays: res.card.scheduled_days,
        learningSteps: res.card.learning_steps,
        reps: res.card.reps,
        lapses: res.card.lapses,
        state: stateLabel(res.card.state),
        lastReview: now,
        updatedAt: now,
        ...(shouldSuspend ? { suspended: true } : {}),
      })
      .where(eq(cards.id, card.id))
      .returning();

    const [review] = await tx
      .insert(reviews)
      .values({
        userId: user.id,
        cardId: card.id,
        deckId: card.deckId,
        rating: body.rating,
        durationMs,
        reviewedAt: now,
        nextDue: new Date(res.card.due),
        nextStability: res.card.stability,
        nextDifficulty: res.card.difficulty,
        undoSnapshot,
      })
      .returning();

    // ── gamification rollup ────────────────────────────────────────
    // Streak / freeze / today-minutes / daily-goal / XP / level / plant
    // stage fold into a new profile snapshot. (Achievements were removed.)
    let updatedProfile = existingProfile ?? null;
    let freezeUsed = false;
    let dailyGoalJustMet = false;

    if (existingProfile) {
      // Round AFTER summing. Flooring each individual answer discarded
      // every sub-minute review. The user/date index bounds this to today.
      const dayStart = new Date(`${todayISO(now)}T00:00:00Z`);
      const dayEnd = new Date(dayStart.getTime() + 86_400_000);
      const [todayTime] = await tx.select({
        durationMs: sql<number>`coalesce(sum(${reviews.durationMs}), 0)`.mapWith(Number),
      }).from(reviews).where(and(
        eq(reviews.userId, user.id),
        gte(reviews.reviewedAt, dayStart),
        lt(reviews.reviewedAt, dayEnd),
      ));
      const rollup = applyGradeRollup({
        durationMs,
        todayDurationMs: todayTime?.durationMs ?? durationMs,
        now,
        previous: {
          streakDays: existingProfile.streakDays,
          streakFreezes: existingProfile.streakFreezes,
          lastReviewDate: existingProfile.lastReviewDate,
          todayMinutes: existingProfile.todayMinutes,
          todayMinutesDate: existingProfile.todayMinutesDate,
          dailyGoalMinutes: existingProfile.dailyGoalMinutes,
          dailyGoalMetCount: existingProfile.dailyGoalMetCount,
          dailyGoalMetDate: existingProfile.dailyGoalMetDate,
          xp: existingProfile.xp,
        },
        ratingXp: xpForRating(body.rating),
      });

      freezeUsed = rollup.freezeUsed;
      dailyGoalJustMet = rollup.dailyGoalJustMet;

      // Daily counters (GLOBAL, Decision 2/3). Only REGULAR grades consume
      // the per-day budget; filtered/cram grades leave the columns as-is.
      // Folded into THIS profile update — same read-modify-write shape as
      // the todayMinutes ledger; no separate statement, one transaction.
      const dailyCounts =
        body.source === 'filtered'
          ? null
          : nextDailyCounts({
              previousNew: existingProfile.newIntroducedToday,
              previousReviews: existingProfile.reviewsDoneToday,
              previousDate: existingProfile.dailyCountsDate,
              today: todayISO(now),
              introducedNew: wasNew,
              reviewedCard: card.state === 'review',
            });

      const [saved] = await tx
        .update(profile)
        .set({
          streakDays: rollup.streakDays,
          streakFreezes: rollup.streakFreezes,
          lastReviewDate: rollup.lastReviewDate,
          todayMinutes: rollup.todayMinutes,
          todayMinutesDate: rollup.todayMinutesDate,
          dailyGoalMetCount: rollup.dailyGoalMetCount,
          dailyGoalMetDate: rollup.dailyGoalMetDate ?? null,
          xp: rollup.xp,
          level: rollup.level,
          plantStage: rollup.plantStage,
          ...(dailyCounts
            ? {
                newIntroducedToday: dailyCounts.newIntroducedToday,
                reviewsDoneToday: dailyCounts.reviewsDoneToday,
                dailyCountsDate: dailyCounts.date,
              }
            : {}),
          updatedAt: now,
        })
        .where(eq(profile.userId, user.id))
        .returning();
      updatedProfile = saved ?? null;
    }

    const result = {
      card: updatedCard,
      review,
      profile: updatedProfile,
      leeched: shouldSuspend,
      freezeUsed,
      dailyGoalJustMet,
    };
    if(operationId)await tx.insert(reviewOperations).values({userId:user.id,operationId,argumentsHash,reviewId:review!.id,result});
    return operationId ? {...result,replayed:false} : result;
  });
}


const DEFAULT_REVIEWS_PAGE = 100;
const MAX_REVIEWS_PAGE = 500;
const REVIEW_CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseReviewCursor(raw: string): { at: Date; id: string } | null {
  const split = raw.lastIndexOf('_');
  if (split <= 0) return null;
  const at = new Date(raw.slice(0, split));
  const id = raw.slice(split + 1);
  if (!REVIEW_CURSOR_ID.test(id) || !Number.isFinite(at.getTime())) return null;
  return { at, id };
}

export const reviewsModule = new Elysia({ prefix: '/reviews' })
  .use(authPlugin)
  // History. Deploy rolls the API out before the web app, and the previous
  // client calls this with `since` only and maps the body as an array. That
  // call stays an array (full rows, no page cap). `limit` or `cursor` selects
  // the page object and omits undo snapshots. Order is reviewed_at DESC, id DESC.
  .get(
    '/',
    async ({ user, query, status }) => {
      const since = query.since
        ? new Date(/^\d+$/.test(query.since) ? Number(query.since) : query.since)
        : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      if (!Number.isFinite(since.getTime())) return status(400, { error: 'invalid_since' });
      const paged = (query.limit !== undefined && query.limit !== '') || (query.cursor !== undefined && query.cursor !== '');
      const conds = [eq(reviews.userId, user.id), gte(reviews.reviewedAt, since)];
      if (!paged) {
        return db
          .select()
          .from(reviews)
          .where(and(...conds))
          .orderBy(desc(reviews.reviewedAt), desc(reviews.id));
      }
      const limit = query.limit === undefined || query.limit === '' ? DEFAULT_REVIEWS_PAGE : Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_REVIEWS_PAGE) {
        return status(400, { error: 'invalid_limit' });
      }
      const cursor = query.cursor ? parseReviewCursor(query.cursor) : null;
      if (query.cursor && !cursor) return status(400, { error: 'invalid_cursor' });
      if (cursor) {
        conds.push(
          or(
            lt(reviews.reviewedAt, cursor.at),
            and(eq(reviews.reviewedAt, cursor.at), lt(reviews.id, cursor.id)),
          )!,
        );
      }
      const rows = await db
        .select({
          id: reviews.id,
          cardId: reviews.cardId,
          deckId: reviews.deckId,
          rating: reviews.rating,
          durationMs: reviews.durationMs,
          reviewedAt: reviews.reviewedAt,
          nextDue: reviews.nextDue,
          nextStability: reviews.nextStability,
          nextDifficulty: reviews.nextDifficulty,
        })
        .from(reviews)
        .where(and(...conds))
        .orderBy(desc(reviews.reviewedAt), desc(reviews.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);
      const last = rows.length > limit ? page[page.length - 1] : undefined;
      return {
        items: page.map((row) => ({
          ...row,
          reviewedAt: row.reviewedAt.toISOString(),
          nextDue: row.nextDue.toISOString(),
        })),
        nextCursor: last ? `${last.reviewedAt.toISOString()}_${last.id}` : null,
      };
    },
    {
      auth: true,
      query: t.Object({
        since: t.Optional(t.String()),
        cursor: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    },
  )
  // Total review count (used by achievements screen).
  .get(
    '/count',
    async ({ user }) => {
      const [row] = await db
        .select({ n: count() })
        .from(reviews)
        .where(eq(reviews.userId, user.id));
      return { count: row?.n ?? 0 };
    },
    { auth: true },
  )
  .post('/', ({user,body})=>gradeReview(user,body), {auth:true,body:gradeInput})
  .post('/operations/:operationId', ({user,body,params})=>gradeReview(user,body,params.operationId), {
    auth:true,body:gradeInput,params:t.Object({operationId:t.String({format:'uuid'})}),
  })
  .get('/operations/:operationId',async({user,params})=>{
    const [receipt]=await db.select().from(reviewOperations).where(and(eq(reviewOperations.userId,user.id),eq(reviewOperations.operationId,params.operationId))).limit(1);
    if(!receipt)return status(404,{error:'operation_not_found'});
    return receipt.reviewId ? {status:'committed' as const,result:receipt.result} : {status:'reverted' as const};
  },{auth:true,params:t.Object({operationId:t.String({format:'uuid'})})})
  .get('/records',async({user,query})=>{
    const ids=[...new Set(query.ids.split(','))];
    if(ids.length>100||ids.some(id=>!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)))return status(400,{error:'invalid_review_ids'});
    const items=await db.select({id:reviews.id,cardId:reviews.cardId,deckId:reviews.deckId,rating:reviews.rating,
      durationMs:reviews.durationMs,reviewedAt:reviews.reviewedAt,nextDue:reviews.nextDue,nextStability:reviews.nextStability,nextDifficulty:reviews.nextDifficulty})
      .from(reviews).where(and(eq(reviews.userId,user.id),inArray(reviews.id,ids)));
    return {items};
  },{auth:true,query:t.Object({ids:t.String({minLength:1,maxLength:3700})})})
  // Undo the user's most recent grade. Atomically restores the card + profile
  // to the exact pre-grade state from the snapshot stored on the review row,
  // then deletes that row (A5a-i / B5 / M-misc). Restores EXACTLY the grade's
  // mutate-set incl. `updatedAt` → undo is "as if the grade never happened".
  .post(
    '/undo',
    async ({ user, body, status }) => {
      return await db.transaction(async (tx) => {
        await tx.select({ id: profile.userId }).from(profile)
          .where(eq(profile.userId, user.id)).for('update');
        // Most recent undoable review. Tie-break on `id DESC` so two grades in
        // the same `reviewedAt` instant undo the genuinely-last one first.
        const [review] = await tx
          .select()
          .from(reviews)
          .where(eq(reviews.userId, user.id))
          .orderBy(desc(reviews.reviewedAt), desc(reviews.id))
          .limit(1)
          .for('update');

        if (!review || !review.undoSnapshot) {
          return status(404, { error: 'nothing_to_undo' });
        }
        if (body?.reviewId && body.reviewId !== review.id) {
          return status(409, { error: 'review_changed' });
        }

        const snapshot = review.undoSnapshot;

        // Stale-guard (M-misc): a manual mutation (forget / setDue, Step 3)
        // bumps `cards.updatedAt` AFTER the grade. Undoing on top of that would
        // silently clobber the manual change, so block it.
        const [currentCard] = await tx
          .select({ id: cards.id, updatedAt: cards.updatedAt })
          .from(cards)
          .where(and(eq(cards.id, review.cardId), eq(cards.userId, user.id)))
          .limit(1)
          .for('update');
        if (!currentCard) {
          return status(404, { error: 'nothing_to_undo' });
        }
        if (currentCard.updatedAt.getTime() > review.reviewedAt.getTime()) {
          return status(409, { error: 'card_modified_since_review' });
        }

        // Restore the card to its pre-grade state (all snapshot fields).
        const [restoredCard] = await tx
          .update(cards)
          .set({
            due: new Date(snapshot.card.due),
            stability: snapshot.card.stability,
            difficulty: snapshot.card.difficulty,
            elapsedDays: snapshot.card.elapsedDays,
            scheduledDays: snapshot.card.scheduledDays,
            learningSteps: snapshot.card.learningSteps,
            reps: snapshot.card.reps,
            lapses: snapshot.card.lapses,
            state: snapshot.card.state,
            lastReview: snapshot.card.lastReview ? new Date(snapshot.card.lastReview) : null,
            suspended: snapshot.card.suspended,
            updatedAt: new Date(snapshot.card.updatedAt),
          })
          .where(eq(cards.id, review.cardId))
          .returning();

        // Restore the profile if the grade rolled one up.
        let restoredProfile = null;
        if (snapshot.profile) {
          const [saved] = await tx
            .update(profile)
            .set({
              streakDays: snapshot.profile.streakDays,
              streakFreezes: snapshot.profile.streakFreezes,
              lastReviewDate: snapshot.profile.lastReviewDate,
              todayMinutes: snapshot.profile.todayMinutes,
              todayMinutesDate: snapshot.profile.todayMinutesDate,
              dailyGoalMetCount: snapshot.profile.dailyGoalMetCount,
              dailyGoalMetDate: snapshot.profile.dailyGoalMetDate,
              xp: snapshot.profile.xp,
              level: snapshot.profile.level,
              plantStage: snapshot.profile.plantStage,
              newIntroducedToday: snapshot.profile.newIntroducedToday,
              reviewsDoneToday: snapshot.profile.reviewsDoneToday,
              dailyCountsDate: snapshot.profile.dailyCountsDate,
              updatedAt: new Date(snapshot.profile.updatedAt),
            })
            .where(eq(profile.userId, user.id))
            .returning();
          restoredProfile = saved ?? null;
        } else {
          const [existing] = await tx
            .select()
            .from(profile)
            .where(eq(profile.userId, user.id))
            .limit(1);
          restoredProfile = existing ?? null;
        }

        // Drop the review row — the grade is gone.
        await tx.delete(reviews).where(eq(reviews.id, review.id));

        return { card: restoredCard, profile: restoredProfile, reviewId: review.id };
      });
    },
    { auth: true, body: t.Optional(t.Object({ reviewId: t.String({ format: 'uuid' }) })) },
  );
