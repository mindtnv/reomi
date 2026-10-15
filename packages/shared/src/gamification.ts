export const PLANT_SPECIES = [
  'fern',
  'cactus',
  'succulent',
  'bonsai',
  'sakura',
  'mushroom',
] as const;
export type PlantSpecies = (typeof PLANT_SPECIES)[number];

export const MAX_STREAK_FREEZES = 5;

/** Cap the freeze counter at the configured maximum. */
export function clampFreezes(n: number): number {
  return Math.max(0, Math.min(MAX_STREAK_FREEZES, Math.floor(n)));
}
