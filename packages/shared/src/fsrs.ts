// FSRS helpers shared between apps/api (grading, queue construction) and
// apps/web (rating-button previews).
//
// Design notes:
//   * ts-fsrs schedulers are cheap but not free to construct; we cache one per
//     effective `request_retention` bucket. Per-user retention is honored
//     without allocating a new scheduler on every request.
//   * Anki-compatible defaults: `learning_steps: ['1m','10m']`,
//     `relearning_steps: ['10m']`, `maximum_interval: 36500` (100y — Anki's
//     effective cap), `enable_fuzz: true`, `enable_short_term: true`.
//   * Fuzz is on in production (prevents clustering of same-day reviews), and
//     can be deterministically seeded per-card for tests.

import {
  createEmptyCard,
  fsrs,
  GenSeedStrategyWithCardId,
  generatorParameters,
  Rating as FsrsRating,
  State,
  StrategyMode,
  type Card as FsrsCard,
  type FSRS,
  type Grade,
  type Steps,
} from 'ts-fsrs';

export { State, FsrsRating };
export type { FsrsCard };

export const RATINGS = [1, 2, 3, 4] as const;
export type Rating = (typeof RATINGS)[number];

// A forgotten browser tab must not count as hours spent on one answer.
export const MAX_REVIEW_DURATION_MS = 10 * 60 * 1000;

export const RATING_LABELS = {
  1: 'Again',
  2: 'Hard',
  3: 'Good',
  4: 'Easy',
} as const satisfies Record<Rating, string>;

const ratingMap: Record<Rating, Grade> = {
  1: FsrsRating.Again,
  2: FsrsRating.Hard,
  3: FsrsRating.Good,
  4: FsrsRating.Easy,
};

// ── defaults ────────────────────────────────────────────────────────────────
// These match Anki's out-of-the-box settings for a new user. Override
// per-user by passing `{ requestRetention, enableFuzz }` into `getScheduler`.

// Single source for the desired-retention clamp bounds. Used by
// `clampRetention` (the scheduler-side clamp) AND by preset/profile write-time
// validation (apps/api) so the accepted range can't drift from the clamp.
export const MIN_RETENTION = 0.7;
export const MAX_RETENTION = 0.99;

export const ANKI_DEFAULTS = {
  requestRetention: 0.9,
  maximumInterval: 36500, // days — effectively unbounded
  learningSteps: ['1m', '10m'] as const,
  relearningSteps: ['10m'] as const,
  enableFuzz: true,
  enableShortTerm: true,
  // Leech threshold: Anki's default is 8 consecutive (or total) lapses.
  leechThreshold: 8,
} as const;

/** Prevent zero-delay loops and date overflow in persisted study presets. */
export function isValidLearningSteps(steps: readonly string[] | null | undefined): boolean {
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > 20) return false;
  const seconds = { s: 1, m: 60, h: 3600, d: 86400 };
  return steps.every((step) => {
    const match = /^(\d+)(s|m|h|d)$/.exec(step);
    if (!match) return false;
    const amount = Number(match[1]);
    const duration = amount * seconds[match[2] as keyof typeof seconds];
    return Number.isSafeInteger(amount) && amount > 0 && duration <= ANKI_DEFAULTS.maximumInterval * 86400;
  });
}

export interface SchedulerOptions {
  /** Target recall probability, 0.7–0.99. Defaults to 0.9. */
  requestRetention?: number;
  /**
   * When true, adds a small random offset to scheduled intervals so cards
   * don't cluster on the same day. Disable in tests that assert exact `due`
   * times, or pair with `deterministicSeedCardId` for reproducible fuzz.
   */
  enableFuzz?: boolean;
  /**
   * If set, fuzz uses a seed derived from this card id. Same id + same state
   * always produces the same offset — makes tests deterministic while still
   * exercising the fuzz code path.
   */
  deterministicSeedCardId?: string;
  /**
   * Per-deck learning steps (e.g. `['1m','10m']` or `['1d','3d']`). Threaded
   * from the resolved deck config. Defaults to `ANKI_DEFAULTS.learningSteps`.
   * Distinct step sets get distinct memoized schedulers via the cache key.
   */
  learningSteps?: readonly string[];
  /**
   * Per-deck relearning steps. Threaded from the resolved deck config.
   * Defaults to `ANKI_DEFAULTS.relearningSteps`.
   */
  relearningSteps?: readonly string[];
  /**
   * Per-deck maximum interval cap (days). Defaults to
   * `ANKI_DEFAULTS.maximumInterval` (36500 ≈ 100y).
   */
  maximumInterval?: number;
}

const schedulerCache = new Map<string, FSRS>();

function cacheKey(opts: SchedulerOptions): string {
  const retention = clampRetention(opts.requestRetention ?? ANKI_DEFAULTS.requestRetention);
  const fuzz = opts.enableFuzz ?? ANKI_DEFAULTS.enableFuzz;
  const seed = opts.deterministicSeedCardId ?? '';
  const learning = (opts.learningSteps ?? ANKI_DEFAULTS.learningSteps).join(',');
  const relearning = (opts.relearningSteps ?? ANKI_DEFAULTS.relearningSteps).join(',');
  const maxIvl = opts.maximumInterval ?? ANKI_DEFAULTS.maximumInterval;
  // `enable_short_term` is deliberately NOT in the key: it is an invariant
  // (always `ANKI_DEFAULTS.enableShortTerm`) and never varies per-deck, so the
  // key is complete without it. If it ever became a preset field, the key
  // would mis-memoize across decks that share retention/fuzz/seed/steps but
  // differ on short-term clamping — so it is pinned invariant on purpose.
  return `${retention.toFixed(3)}|${fuzz ? 1 : 0}|${seed}|${learning}|${relearning}|${maxIvl}`;
}

function clampRetention(v: number): number {
  if (!Number.isFinite(v)) return ANKI_DEFAULTS.requestRetention;
  return Math.min(MAX_RETENTION, Math.max(MIN_RETENTION, v));
}

export function getScheduler(opts: SchedulerOptions = {}): FSRS {
  const key = cacheKey(opts);
  const cached = schedulerCache.get(key);
  if (cached) return cached;

  const params = generatorParameters({
    request_retention: clampRetention(opts.requestRetention ?? ANKI_DEFAULTS.requestRetention),
    maximum_interval: opts.maximumInterval ?? ANKI_DEFAULTS.maximumInterval,
    enable_fuzz: opts.enableFuzz ?? ANKI_DEFAULTS.enableFuzz,
    // Invariant — never sourced from opts (Principle 2); see cacheKey().
    enable_short_term: ANKI_DEFAULTS.enableShortTerm,
    // Per-deck preset steps arrive as plain `string[]` (stored as `text[]`,
    // grammar-validated upstream by the resolver); ts-fsrs types steps as a
    // `StepUnit` template-literal union, so cast at this boundary.
    learning_steps: [...(opts.learningSteps ?? ANKI_DEFAULTS.learningSteps)] as unknown as Steps,
    relearning_steps: [...(opts.relearningSteps ?? ANKI_DEFAULTS.relearningSteps)] as unknown as Steps,
  });
  const scheduler = fsrs(params);

  if (opts.deterministicSeedCardId) {
    // Seed fuzz deterministically — useful for tests. The cardId is embedded
    // in the cache key so swapping ids yields a fresh scheduler.
    scheduler.useStrategy(
      StrategyMode.SEED,
      GenSeedStrategyWithCardId(opts.deterministicSeedCardId),
    );
  }

  schedulerCache.set(key, scheduler);
  return scheduler;
}

// ── public API ──────────────────────────────────────────────────────────────

export function newFsrsCard(now: Date = new Date()): FsrsCard {
  return createEmptyCard(now);
}

/**
 * FSRS column values for a card reset to "new" (manual Forget). Maps a fresh
 * `newFsrsCard()` onto the flat Drizzle `cards` columns (camelCase), so the
 * defaults stay sourced from ts-fsrs — no hard-coded magic. `lastReview` is
 * explicitly nulled (the column is nullable; a never-reviewed card has none).
 */
export function fsrsResetColumns(now: Date = new Date()): {
  state: 'new';
  due: Date;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  lastReview: null;
} {
  const fresh = newFsrsCard(now);
  return {
    state: 'new',
    due: new Date(fresh.due),
    stability: fresh.stability,
    difficulty: fresh.difficulty,
    elapsedDays: fresh.elapsed_days,
    scheduledDays: fresh.scheduled_days,
    learningSteps: fresh.learning_steps,
    reps: fresh.reps,
    lapses: fresh.lapses,
    lastReview: null,
  };
}

export function previewGrades(card: FsrsCard, now: Date = new Date(), opts: SchedulerOptions = {}) {
  const all = getScheduler(opts).repeat(card, now);
  return {
    1: all[FsrsRating.Again].card,
    2: all[FsrsRating.Hard].card,
    3: all[FsrsRating.Good].card,
    4: all[FsrsRating.Easy].card,
  };
}

export function gradeFsrs(
  card: FsrsCard,
  rating: Rating,
  now: Date = new Date(),
  opts: SchedulerOptions = {},
) {
  return getScheduler(opts).next(card, now, ratingMap[rating]);
}

export function stateLabel(state: State): 'new' | 'learning' | 'review' | 'relearning' {
  switch (state) {
    case State.New:
      return 'new';
    case State.Learning:
      return 'learning';
    case State.Review:
      return 'review';
    case State.Relearning:
      return 'relearning';
  }
}

// ── XP / streak helpers ────────────────────────────────────────────────────
// Kept here (not in apps/api) so the web app can preview XP deltas client-side
// without double-defining the formula.

export const XP_BY_RATING: Record<Rating, number> = {
  1: 0, // Again — no reward
  2: 5,
  3: 10,
  4: 15,
};

export function xpForRating(rating: Rating): number {
  return XP_BY_RATING[rating];
}

export function levelFromXp(xp: number): number {
  return Math.max(1, Math.floor(xp / 500) + 1);
}

export function plantStageFromStreak(streakDays: number): 0 | 1 | 2 | 3 | 4 | 5 {
  return Math.max(0, Math.min(5, Math.floor(streakDays / 7))) as 0 | 1 | 2 | 3 | 4 | 5;
}

/**
 * Compute the next streak value given the previous review date and today's
 * date. Both inputs are ISO yyyy-mm-dd strings.
 *
 *   - same day → streak unchanged
 *   - yesterday → streak + 1
 *   - otherwise → reset to 1 (today counts)
 */
export function nextStreak(previousStreak: number, lastDate: string | null | undefined, today: string): number {
  if (lastDate === today) return previousStreak;
  const yesterday = addDays(today, -1);
  if (lastDate === yesterday) return previousStreak + 1;
  return 1;
}

function addDays(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function todayISO(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function isLeech(lapses: number, threshold: number = ANKI_DEFAULTS.leechThreshold): boolean {
  return lapses >= threshold;
}

/** A new lapse suspends at the threshold and every half of it, rounded up. */
export function leechSuspendsOnLapse(
  previousLapses: number,
  nextLapses: number,
  threshold: number = ANKI_DEFAULTS.leechThreshold,
): boolean {
  if (!(threshold > 0) || !(nextLapses > previousLapses)) return false;
  const step = Math.max(1, Math.ceil(threshold / 2));
  return nextLapses >= threshold && (nextLapses - threshold) % step === 0;
}
