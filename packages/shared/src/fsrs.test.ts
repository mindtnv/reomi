import { describe, expect, test } from 'bun:test';
import {
  ANKI_DEFAULTS,
  gradeFsrs,
  isLeech,
  leechSuspendsOnLapse,
  levelFromXp,
  nextStreak,
  newFsrsCard,
  plantStageFromStreak,
  previewGrades,
  stateLabel,
  State,
  xpForRating,
} from './fsrs.ts';

// All scheduling tests disable fuzz via the deterministic seed hook so `due`
// deltas are reproducible.
const DETERMINISTIC = { enableFuzz: false } as const;

describe('newFsrsCard', () => {
  test('returns a fresh card in State.New with 0 reps/lapses', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const c = newFsrsCard(now);
    expect(c.state).toBe(State.New);
    expect(c.reps).toBe(0);
    expect(c.lapses).toBe(0);
    expect(c.stability).toBe(0);
    expect(c.difficulty).toBe(0);
    expect(c.learning_steps).toBe(0);
    expect(c.last_review).toBeUndefined();
  });
});

describe('gradeFsrs', () => {
  test('New + Good → Learning, reps=1, due in the future', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const card = newFsrsCard(now);
    const { card: next } = gradeFsrs(card, 3, now, DETERMINISTIC);
    expect(next.state).toBe(State.Learning);
    expect(next.reps).toBe(1);
    expect(next.lapses).toBe(0);
    expect(next.due.getTime()).toBeGreaterThan(now.getTime());
  });

  test('Again on a new card keeps state=Learning and increments reps', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const card = newFsrsCard(now);
    const { card: next } = gradeFsrs(card, 1, now, DETERMINISTIC);
    expect(next.reps).toBe(1);
    // On a brand-new card Again does NOT increment lapses (a "lapse" is a
    // fail on a Review card, not on a card that was never mature).
    expect(next.lapses).toBe(0);
    // Still in Learning, not promoted.
    expect(next.state).toBe(State.Learning);
  });

  test('Easy on a new card graduates directly to Review', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const card = newFsrsCard(now);
    const { card: next } = gradeFsrs(card, 4, now, DETERMINISTIC);
    expect(next.state).toBe(State.Review);
    expect(next.reps).toBe(1);
    expect(next.scheduled_days).toBeGreaterThan(0);
  });

  test('Review card rated Again → Relearning, lapses+1', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    let card = newFsrsCard(now);
    // Graduate card quickly: Easy → Review.
    card = gradeFsrs(card, 4, now, DETERMINISTIC).card;
    expect(card.state).toBe(State.Review);
    const reviewAt = new Date(card.due.getTime() + 1_000);
    const { card: lapsed } = gradeFsrs(card, 1, reviewAt, DETERMINISTIC);
    expect(lapsed.state).toBe(State.Relearning);
    expect(lapsed.lapses).toBe(1);
  });

  test('higher desired retention schedules sooner than lower retention', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const card = newFsrsCard(now);
    // Use Good rating, compare intervals across different retention targets.
    const tight = gradeFsrs(card, 3, now, { enableFuzz: false, requestRetention: 0.95 }).card;
    const loose = gradeFsrs(card, 3, now, { enableFuzz: false, requestRetention: 0.8 }).card;
    // Higher retention ⇒ review more often ⇒ earlier due date.
    expect(tight.due.getTime()).toBeLessThanOrEqual(loose.due.getTime());
  });
});

describe('per-deck steps + maxInterval threading (Phase 2)', () => {
  const now = new Date('2026-01-01T00:00:00Z');

  // Each set pairs a learning + relearning step set. Per the Phase-0 caveat:
  // under the invariant `enable_short_term:true`, day-scale cards may graduate
  // to Review earlier than a naive step-walk — so we assert on the configured
  // `due` VALUE (which tracks the first step), NOT on `state`.
  const STEP_SETS = [
    { learningSteps: ['1m', '10m'], relearningSteps: ['10m'] },
    { learningSteps: ['1m', '5m', '30m'], relearningSteps: ['5m'] },
    { learningSteps: ['1d'], relearningSteps: ['1d'] },
    { learningSteps: ['1d', '3d'], relearningSteps: ['1d'] },
  ] as const;

  test('four step-sets each produce a distinct first-grade due for Rating.Good', () => {
    const dues = STEP_SETS.map((set) => {
      const card = newFsrsCard(now);
      const { card: next } = gradeFsrs(card, 3, now, { enableFuzz: false, ...set });
      return next.due.getTime();
    });
    // All four due values must be distinct (no cross-contamination between
    // step sets via the shared scheduler cache).
    expect(new Set(dues).size).toBe(STEP_SETS.length);
  });

  test('first-grade due tracks the configured first learning step', () => {
    // `['1m', ...]` → first Good step ≈ +10m (second step); `['1d', ...]` →
    // first Good step ≈ +1 day. The day-scale set must schedule far further out
    // than the sub-day set regardless of state under enable_short_term.
    const subDay = gradeFsrs(newFsrsCard(now), 3, now, {
      enableFuzz: false,
      learningSteps: ['1m', '10m'],
      relearningSteps: ['10m'],
    }).card;
    const dayScale = gradeFsrs(newFsrsCard(now), 3, now, {
      enableFuzz: false,
      learningSteps: ['1d'],
      relearningSteps: ['1d'],
    }).card;
    expect(dayScale.due.getTime()).toBeGreaterThan(subDay.due.getTime());
    // Sub-day: due lands within the same calendar day (well under 24h).
    expect(subDay.due.getTime() - now.getTime()).toBeLessThan(24 * 60 * 60 * 1000);
    // Day-scale: due lands at least ~a day out.
    expect(dayScale.due.getTime() - now.getTime()).toBeGreaterThanOrEqual(20 * 60 * 60 * 1000);
  });

  test('cache: identical opts produce identical due sequences (cache hit)', () => {
    const opts = {
      enableFuzz: false,
      learningSteps: ['1m', '5m', '30m'],
      relearningSteps: ['5m'],
    } as const;
    const a = gradeFsrs(newFsrsCard(now), 3, now, opts).card.due.getTime();
    const b = gradeFsrs(newFsrsCard(now), 3, now, opts).card.due.getTime();
    expect(a).toBe(b);
  });

  test('cache: distinct step-sets do NOT contaminate each other', () => {
    const setA = {
      enableFuzz: false,
      learningSteps: ['1m', '10m'],
      relearningSteps: ['10m'],
    } as const;
    const setB = {
      enableFuzz: false,
      learningSteps: ['1d', '3d'],
      relearningSteps: ['1d'],
    } as const;
    // Grade A, then B, then A again — A's result must be stable (B did not
    // overwrite A's memoized scheduler).
    const a1 = gradeFsrs(newFsrsCard(now), 3, now, setA).card.due.getTime();
    gradeFsrs(newFsrsCard(now), 3, now, setB);
    const a2 = gradeFsrs(newFsrsCard(now), 3, now, setA).card.due.getTime();
    expect(a1).toBe(a2);
  });

  test('maximumInterval clamps the first matured interval and suppresses growth', () => {
    // An Easy grade graduates a new card straight to Review with a scheduled
    // interval. A small `maximumInterval` clamps that first interval exactly to
    // the cap; an uncapped scheduler schedules far further out. Driving several
    // more Easy grades, the capped interval plateaus while the uncapped one
    // explodes — proving maxInterval reaches the scheduler via the cache key.
    function intervals(maximumInterval: number): number[] {
      let card = newFsrsCard(now);
      let at = now;
      const out: number[] = [];
      for (let i = 0; i < 5; i++) {
        const res = gradeFsrs(card, 4, at, { enableFuzz: false, maximumInterval });
        card = res.card;
        out.push(card.scheduled_days);
        at = new Date(card.due.getTime() + 1_000);
      }
      return out;
    }
    const capped = intervals(5); // 5-day cap
    const uncapped = intervals(ANKI_DEFAULTS.maximumInterval);
    // First graduated interval is clamped exactly to the cap.
    expect(capped[0]).toBe(5);
    // Capped run plateaus low; uncapped run grows far past it.
    expect(Math.max(...capped)).toBeLessThan(20);
    expect(uncapped[uncapped.length - 1]).toBeGreaterThan(Math.max(...capped));
  });
});

describe('default-path determinism regression (Phase 2 guard)', () => {
  // Guards that the existing apps/api reviews/cards exact-`due` assertions
  // won't regress: the default call (no steps) must be byte-identical to an
  // explicit call with the ANKI_DEFAULTS step set + maxInterval.
  test('no-opts grade equals explicit ANKI_DEFAULTS grade (byte-identical due)', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const implicit = gradeFsrs(newFsrsCard(now), 3, now, { enableFuzz: false }).card;
    const explicit = gradeFsrs(newFsrsCard(now), 3, now, {
      enableFuzz: false,
      learningSteps: ANKI_DEFAULTS.learningSteps,
      relearningSteps: ANKI_DEFAULTS.relearningSteps,
      maximumInterval: ANKI_DEFAULTS.maximumInterval,
    }).card;
    expect(implicit.due.getTime()).toBe(explicit.due.getTime());
    expect(implicit.stability).toBe(explicit.stability);
    expect(implicit.difficulty).toBe(explicit.difficulty);
    expect(implicit.scheduled_days).toBe(explicit.scheduled_days);
  });

  test('all four ratings: no-opts equals explicit ANKI_DEFAULTS (regression guard)', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    for (const rating of [1, 2, 3, 4] as const) {
      const implicit = gradeFsrs(newFsrsCard(now), rating, now, { enableFuzz: false }).card;
      const explicit = gradeFsrs(newFsrsCard(now), rating, now, {
        enableFuzz: false,
        learningSteps: ANKI_DEFAULTS.learningSteps,
        relearningSteps: ANKI_DEFAULTS.relearningSteps,
        maximumInterval: ANKI_DEFAULTS.maximumInterval,
      }).card;
      expect(implicit.due.getTime()).toBe(explicit.due.getTime());
    }
  });
});

describe('previewGrades', () => {
  test('returns four distinct cards, one per rating', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    const card = newFsrsCard(now);
    const previews = previewGrades(card, now, DETERMINISTIC);
    expect(Object.keys(previews).sort()).toEqual(['1', '2', '3', '4']);
    // Monotonic-ish: Easy schedules furthest out, Again soonest.
    expect(previews[1].due.getTime()).toBeLessThanOrEqual(previews[2].due.getTime());
    expect(previews[2].due.getTime()).toBeLessThanOrEqual(previews[3].due.getTime());
    expect(previews[3].due.getTime()).toBeLessThanOrEqual(previews[4].due.getTime());
  });
});

describe('stateLabel', () => {
  test('maps all 4 FSRS states to string labels', () => {
    expect(stateLabel(State.New)).toBe('new');
    expect(stateLabel(State.Learning)).toBe('learning');
    expect(stateLabel(State.Review)).toBe('review');
    expect(stateLabel(State.Relearning)).toBe('relearning');
  });
});

describe('xp / level / plant-stage helpers', () => {
  test('xpForRating gives 0 for Again, ramps to 15 for Easy', () => {
    expect(xpForRating(1)).toBe(0);
    expect(xpForRating(2)).toBe(5);
    expect(xpForRating(3)).toBe(10);
    expect(xpForRating(4)).toBe(15);
  });

  test('levelFromXp is floor(xp/500)+1, minimum 1', () => {
    expect(levelFromXp(0)).toBe(1);
    expect(levelFromXp(499)).toBe(1);
    expect(levelFromXp(500)).toBe(2);
    expect(levelFromXp(2500)).toBe(6);
  });

  test('plantStage is floor(streak/7) clamped to 0..5', () => {
    expect(plantStageFromStreak(0)).toBe(0);
    expect(plantStageFromStreak(6)).toBe(0);
    expect(plantStageFromStreak(7)).toBe(1);
    expect(plantStageFromStreak(30)).toBe(4);
    expect(plantStageFromStreak(60)).toBe(5); // clamped
  });
});

describe('nextStreak', () => {
  test('same day → unchanged', () => {
    expect(nextStreak(5, '2026-04-18', '2026-04-18')).toBe(5);
  });
  test('yesterday → +1', () => {
    expect(nextStreak(5, '2026-04-17', '2026-04-18')).toBe(6);
  });
  test('gap → reset to 1', () => {
    expect(nextStreak(20, '2026-04-10', '2026-04-18')).toBe(1);
  });
  test('null last-date → reset to 1', () => {
    expect(nextStreak(0, null, '2026-04-18')).toBe(1);
  });
  test('month boundary is respected', () => {
    // 2026-03-31 → 2026-04-01 is yesterday
    expect(nextStreak(3, '2026-03-31', '2026-04-01')).toBe(4);
  });
});

describe('leechSuspendsOnLapse', () => {
  test('suspends at the threshold and every half of it, rounded up', () => {
    for (const n of [8, 12, 16, 20]) expect(leechSuspendsOnLapse(n - 1, n)).toBe(true);
    for (const n of [9, 10, 11, 13, 15]) expect(leechSuspendsOnLapse(n - 1, n)).toBe(false);
    for (const n of [3, 5, 7]) expect(leechSuspendsOnLapse(n - 1, n, 3)).toBe(true);
    for (const n of [4, 6]) expect(leechSuspendsOnLapse(n - 1, n, 3)).toBe(false);
    for (const n of [4, 6, 8, 10]) expect(leechSuspendsOnLapse(n - 1, n, 4)).toBe(true);
    expect(leechSuspendsOnLapse(4, 5, 4)).toBe(false);
    for (const n of [5, 8, 11, 14]) expect(leechSuspendsOnLapse(n - 1, n, 5)).toBe(true);
    for (const n of [6, 7, 9, 10, 12]) expect(leechSuspendsOnLapse(n - 1, n, 5)).toBe(false);
    expect(leechSuspendsOnLapse(0, 1, 1)).toBe(true);
    expect(leechSuspendsOnLapse(4, 5, 1)).toBe(true);
  });

  test('uses the threshold of this grade', () => {
    expect(leechSuspendsOnLapse(4, 5, 6)).toBe(false);
    expect(leechSuspendsOnLapse(5, 6, 6)).toBe(true);
    expect(leechSuspendsOnLapse(7, 8, 5)).toBe(true);
    expect(leechSuspendsOnLapse(8, 9, 5)).toBe(false);
    expect(leechSuspendsOnLapse(10, 11, 5)).toBe(true);
  });

  test('ignores a grade that does not add a lapse', () => {
    expect(leechSuspendsOnLapse(8, 8)).toBe(false);
    expect(leechSuspendsOnLapse(8, 4, 4)).toBe(false);
    expect(leechSuspendsOnLapse(3, 4, 0)).toBe(false);
  });
});

describe('isLeech', () => {
  test('flags cards at or above the Anki default threshold (8)', () => {
    expect(isLeech(0)).toBe(false);
    expect(isLeech(7)).toBe(false);
    expect(isLeech(8)).toBe(true);
    expect(isLeech(20)).toBe(true);
  });
  test('threshold is overridable', () => {
    expect(isLeech(3, 3)).toBe(true);
    expect(isLeech(3, 4)).toBe(false);
  });
});

describe('ANKI_DEFAULTS sanity', () => {
  test('canonical defaults match Anki out-of-the-box', () => {
    expect(ANKI_DEFAULTS.requestRetention).toBe(0.9);
    expect(ANKI_DEFAULTS.leechThreshold).toBe(8);
    expect(ANKI_DEFAULTS.learningSteps).toEqual(['1m', '10m']);
    expect(ANKI_DEFAULTS.relearningSteps).toEqual(['10m']);
  });
});
