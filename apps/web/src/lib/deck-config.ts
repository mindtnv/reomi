/**
 * Client-side deck scheduling config resolver.
 *
 * MIRRORS the server `apps/api/src/modules/deck-config.ts` `resolveDeckConfig`
 * logic exactly — walk `decks.parentId` to the nearest ancestor with a
 * `presetId`, look it up in `presets`, fall back per-field to
 * `profile.desiredRetention` then `ANKI_DEFAULTS`; cycle-safe with a `seen`
 * set; null deckId → collection defaults.
 *
 * DRIFT RISK: keep in sync with the server resolver when field fallback order
 * changes.
 */

import { ANKI_DEFAULTS, isValidLearningSteps as isValidSteps } from '@reomi/shared';
import type { Deck, DeckOptionsPreset, Profile } from '@/lib/types';

export interface ClientResolvedDeckConfig {
  learningSteps: string[];
  relearningSteps: string[];
  desiredRetention: number;
  maximumInterval: number;
}

function nearestPreset(
  deckId: string,
  decks: Deck[],
  presetsMap: Map<string, DeckOptionsPreset>,
): DeckOptionsPreset | null {
  const byId = new Map(decks.map((d) => [d.id, d]));
  const seen = new Set<string>();
  let current = byId.get(deckId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.presetId) {
      const preset = presetsMap.get(current.presetId);
      if (preset) return preset;
    }
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return null;
}

/**
 * Resolve effective scheduling config for a card's deck on the client.
 * Matches server `resolveDeckConfig` fallback order:
 *   preset value → profile.desiredRetention → ANKI_DEFAULTS
 */
export function resolveDeckConfigClient(
  deckId: string | null | undefined,
  decks: Deck[],
  presets: DeckOptionsPreset[],
  profile: Profile | null,
): ClientResolvedDeckConfig {
  const presetsMap = new Map(presets.map((p) => [p.id, p]));
  const preset = deckId ? nearestPreset(deckId, decks, presetsMap) : null;

  const learningSteps =
    preset && isValidSteps(preset.learningSteps)
      ? preset.learningSteps
      : [...ANKI_DEFAULTS.learningSteps];
  const relearningSteps =
    preset && isValidSteps(preset.relearningSteps)
      ? preset.relearningSteps
      : [...ANKI_DEFAULTS.relearningSteps];
  const desiredRetention =
    preset?.desiredRetention ??
    profile?.desiredRetention ??
    ANKI_DEFAULTS.requestRetention;
  const maximumInterval = preset?.maximumInterval ?? ANKI_DEFAULTS.maximumInterval;

  return { learningSteps, relearningSteps, desiredRetention, maximumInterval };
}
