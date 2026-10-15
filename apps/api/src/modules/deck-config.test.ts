import { describe, expect, test } from 'bun:test';
import { ANKI_DEFAULTS } from '@reomi/shared';
import type { Deck, DeckOptionsPreset, Profile } from '@reomi/db';
import {
  DEFAULT_NEW_PER_DAY,
  DEFAULT_REVIEWS_PER_DAY,
  isValidSteps,
  resolveDeckConfig,
  type DeckConfigSnapshot,
} from './deck-config.ts';

// Minimal builders — resolveDeckConfig only reads a few fields, so we cast
// partial shapes to the full row types (it never touches the rest).
function deck(id: string, parentId: string | null, presetId: string | null): Deck {
  return { id, parentId, presetId, userId: 'u', name: id } as unknown as Deck;
}

function preset(id: string, over: Partial<DeckOptionsPreset> = {}): DeckOptionsPreset {
  return {
    id,
    userId: 'u',
    name: id,
    newPerDay: 20,
    reviewsPerDay: 200,
    learningSteps: ['1m', '10m'],
    relearningSteps: ['10m'],
    desiredRetention: null,
    leechThreshold: 8,
    maximumInterval: 36500,
    ...over,
  } as unknown as DeckOptionsPreset;
}

function snapshot(
  decks: Deck[],
  presets: DeckOptionsPreset[],
  profile: Profile | null = null,
): DeckConfigSnapshot {
  return {
    userDecks: decks,
    presetsById: new Map(presets.map((p) => [p.id, p])),
    profile,
  };
}

describe('isValidSteps', () => {
  test('accepts valid ts-fsrs duration strings', () => {
    expect(isValidSteps(['1m', '10m'])).toBe(true);
    expect(isValidSteps(['1s', '1h', '1d', '3d'])).toBe(true);
  });
  test('rejects empty / null / malformed', () => {
    expect(isValidSteps([])).toBe(false);
    expect(isValidSteps(null)).toBe(false);
    expect(isValidSteps(undefined)).toBe(false);
    expect(isValidSteps(['banana'])).toBe(false);
    expect(isValidSteps(['1m', 'x'])).toBe(false);
    expect(isValidSteps(['1'])).toBe(false);
  });
});

describe('resolveDeckConfig', () => {
  test('null deckId → all defaults (no walk)', () => {
    const cfg = resolveDeckConfig(null, snapshot([], []));
    expect(cfg.newPerDay).toBe(DEFAULT_NEW_PER_DAY);
    expect(cfg.reviewsPerDay).toBe(DEFAULT_REVIEWS_PER_DAY);
    expect(cfg.learningSteps).toEqual([...ANKI_DEFAULTS.learningSteps]);
    expect(cfg.relearningSteps).toEqual([...ANKI_DEFAULTS.relearningSteps]);
    expect(cfg.desiredRetention).toBe(ANKI_DEFAULTS.requestRetention);
    expect(cfg.leechThreshold).toBe(ANKI_DEFAULTS.leechThreshold);
    expect(cfg.maximumInterval).toBe(ANKI_DEFAULTS.maximumInterval);
  });

  test('null deckId → profile desiredRetention overrides the ANKI default', () => {
    const profile = { desiredRetention: 0.85 } as unknown as Profile;
    const cfg = resolveDeckConfig(null, snapshot([], [], profile));
    expect(cfg.desiredRetention).toBe(0.85);
  });

  test("deck with its own preset → uses the preset's values", () => {
    const p = preset('p1', {
      newPerDay: 5,
      reviewsPerDay: 50,
      learningSteps: ['1d', '3d'],
      relearningSteps: ['1d'],
      desiredRetention: 0.95,
      leechThreshold: 3,
      maximumInterval: 365,
    });
    const cfg = resolveDeckConfig('d1', snapshot([deck('d1', null, 'p1')], [p]));
    expect(cfg.newPerDay).toBe(5);
    expect(cfg.reviewsPerDay).toBe(50);
    expect(cfg.learningSteps).toEqual(['1d', '3d']);
    expect(cfg.relearningSteps).toEqual(['1d']);
    expect(cfg.desiredRetention).toBe(0.95);
    expect(cfg.leechThreshold).toBe(3);
    expect(cfg.maximumInterval).toBe(365);
  });

  test('preset with null desiredRetention falls through to profile then ANKI', () => {
    const p = preset('p1', { desiredRetention: null });
    const profile = { desiredRetention: 0.8 } as unknown as Profile;
    const withProfile = resolveDeckConfig('d1', snapshot([deck('d1', null, 'p1')], [p], profile));
    expect(withProfile.desiredRetention).toBe(0.8);
    const noProfile = resolveDeckConfig('d1', snapshot([deck('d1', null, 'p1')], [p], null));
    expect(noProfile.desiredRetention).toBe(ANKI_DEFAULTS.requestRetention);
  });

  test('3-level inheritance → resolves the grandparent preset', () => {
    const gp = preset('pgp', { learningSteps: ['1d', '3d'], newPerDay: 7 });
    const decks = [
      deck('child', 'parent', null), // no preset
      deck('parent', 'grand', null), // no preset
      deck('grand', null, 'pgp'), // HAS preset
    ];
    const cfg = resolveDeckConfig('child', snapshot(decks, [gp]));
    expect(cfg.learningSteps).toEqual(['1d', '3d']);
    expect(cfg.newPerDay).toBe(7);
  });

  test('nearest ancestor wins over a farther one', () => {
    const near = preset('near', { newPerDay: 11 });
    const far = preset('far', { newPerDay: 99 });
    const decks = [
      deck('child', 'parent', null),
      deck('parent', 'grand', 'near'),
      deck('grand', null, 'far'),
    ];
    const cfg = resolveDeckConfig('child', snapshot(decks, [near, far]));
    expect(cfg.newPerDay).toBe(11);
  });

  test('malformed stored steps → ANKI fallback for THAT field only', () => {
    const p = preset('p1', {
      learningSteps: ['banana'], // malformed
      relearningSteps: ['5m'], // valid
      newPerDay: 3,
    });
    const cfg = resolveDeckConfig('d1', snapshot([deck('d1', null, 'p1')], [p]));
    expect(cfg.learningSteps).toEqual([...ANKI_DEFAULTS.learningSteps]);
    expect(cfg.relearningSteps).toEqual(['5m']);
    expect(cfg.newPerDay).toBe(3); // non-steps preset values still apply
  });

  test('cycle in parentId terminates (no infinite loop)', () => {
    const decks = [deck('a', 'b', null), deck('b', 'a', null)];
    const cfg = resolveDeckConfig('a', snapshot(decks, []));
    // No preset found anywhere in the cycle → defaults, and it returns.
    expect(cfg.newPerDay).toBe(DEFAULT_NEW_PER_DAY);
    expect(cfg.learningSteps).toEqual([...ANKI_DEFAULTS.learningSteps]);
  });

  test('deckId not in snapshot → defaults', () => {
    const cfg = resolveDeckConfig('missing', snapshot([], []));
    expect(cfg.newPerDay).toBe(DEFAULT_NEW_PER_DAY);
  });
});
