// Deck scheduling-config resolver (Milestone 3, Decision 1 + Principle 1).
//
// `resolveDeckConfig` is the SINGLE place per-deck scheduling config is
// computed. Both the grade handler (`reviews.ts`) and the regular queue
// (`cards.ts /queue`) call it with a PRE-LOADED snapshot — it does NO I/O of
// its own and re-uses the cycle-safe in-memory parent-walk pattern from
// `makeDeckResolver` (cards.ts). There is intentionally no async variant: the
// caller batches the snapshot reads once, so resolution inside the row-locked
// grade transaction adds zero round-trips.
//
// Resolution order per field: nearest-ancestor preset value (if set) → profile
// (`desiredRetention` only) → ANKI_DEFAULTS / the daily-limit defaults below.

import { ANKI_DEFAULTS, isValidLearningSteps as isValidSteps } from '@reomi/shared';
import type { Deck, DeckOptionsPreset, Profile } from '@reomi/db';

// Anki-style per-day caps used when no preset supplies them. These mirror the
// `deck_options_preset` schema defaults (newPerDay 20 / reviewsPerDay 200) and
// are the single source for the queue's hardcoded caps (cards.ts re-imports
// these instead of redefining DAILY_NEW_LIMIT / DAILY_REVIEW_LIMIT).
export const DEFAULT_NEW_PER_DAY = 20;
export const DEFAULT_REVIEWS_PER_DAY = 200;

export { isValidSteps };

export interface ResolvedDeckConfig {
  newPerDay: number;
  reviewsPerDay: number;
  learningSteps: string[];
  relearningSteps: string[];
  desiredRetention: number;
  leechThreshold: number;
  maximumInterval: number;
}

export interface DeckConfigSnapshot {
  userDecks: Deck[];
  presetsById: Map<string, DeckOptionsPreset>;
  profile: Profile | null;
}

/**
 * Walk `decks.parentId` in-memory from `deckId` up to the nearest ancestor that
 * has a non-null `presetId`, returning that preset (resolved via `presetsById`)
 * or null. Cycle-safe via a `seen` set — mirrors `makeDeckResolver`'s pathLabel
 * walk (cards.ts).
 */
function nearestPreset(
  deckId: string,
  snapshot: DeckConfigSnapshot,
): DeckOptionsPreset | null {
  const byId = new Map(snapshot.userDecks.map((d) => [d.id, d]));
  const seen = new Set<string>();
  let current = byId.get(deckId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.presetId) {
      const preset = snapshot.presetsById.get(current.presetId);
      if (preset) return preset;
    }
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return null;
}

/**
 * Resolve the effective scheduling config for a deck (or the whole collection
 * when `deckId` is null). Synchronous, pure over the snapshot.
 */
export function resolveDeckConfig(
  deckId: string | null,
  snapshot: DeckConfigSnapshot,
): ResolvedDeckConfig {
  const preset = deckId ? nearestPreset(deckId, snapshot) : null;

  // Steps fall back to ANKI_DEFAULTS when the preset is absent OR its stored
  // array is malformed (belt-and-suspenders; write-time validation is primary).
  const learningSteps =
    preset && isValidSteps(preset.learningSteps)
      ? preset.learningSteps
      : [...ANKI_DEFAULTS.learningSteps];
  const relearningSteps =
    preset && isValidSteps(preset.relearningSteps)
      ? preset.relearningSteps
      : [...ANKI_DEFAULTS.relearningSteps];

  // desiredRetention: preset override → profile → ANKI default.
  const desiredRetention =
    preset?.desiredRetention ??
    snapshot.profile?.desiredRetention ??
    ANKI_DEFAULTS.requestRetention;

  return {
    newPerDay: preset?.newPerDay ?? DEFAULT_NEW_PER_DAY,
    reviewsPerDay: preset?.reviewsPerDay ?? DEFAULT_REVIEWS_PER_DAY,
    learningSteps,
    relearningSteps,
    desiredRetention,
    leechThreshold: preset?.leechThreshold ?? ANKI_DEFAULTS.leechThreshold,
    maximumInterval: preset?.maximumInterval ?? ANKI_DEFAULTS.maximumInterval,
  };
}
