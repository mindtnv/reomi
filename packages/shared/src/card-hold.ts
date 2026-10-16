export const HOLD_REASONS = ['user', 'sibling'] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

/** Active hold as the API and the card DTO show it. `until` is an ISO instant. */
export interface CardHoldView {
  until: string;
  reason: HoldReason;
}

/** `buried_until > now`. Reason does not affect visibility. */
export function holdIsActive(hold: CardHoldView | null | undefined, nowMs: number): boolean {
  if (!hold) return false;
  const until = Date.parse(hold.until);
  return Number.isFinite(until) && until > nowMs;
}
