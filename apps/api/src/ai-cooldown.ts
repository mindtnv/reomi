// Tiny in-memory per-key cooldown for PAID AI endpoints. Enforces "at most one
// call per `ms` window per key". Designed for the expensive, user-triggered AI
// surfaces (overview generation, full reindex, card formulation) where a rapid
// double-tap (or a retry storm after a failure) burns real money for no gain.
//
// Mirrors rate-limit.ts in shape and lifecycle:
//   - Single-process only. For multi-instance prod, swap the Map for a Redis
//     SET key val NX PX <ms> with the same interface.
//   - Keys live until their window elapses; lightweight sweep on each check.
//
// IMPORTANT (caller contract): set the cooldown AFTER all ownership/404 checks
// (a foreign id must never burn a cooldown on someone else's resource) and ONLY
// right before the paid call. On a FAILED paid call do NOT clear the cooldown —
// that is the whole point (it dampens retry storms against a flaky gateway).
//
// Disabled entirely under NODE_ENV=test so integration tests don't false-trip;
// the pure `cooldownCheck` accepts an injectable `now` so it's unit-testable
// regardless of env (tests flip NODE_ENV off the same way rate-limit.test.ts does).

interface CooldownHit {
  /** Epoch ms at which the cooldown for this key expires. */
  resetAt: number;
}

const cooldowns = new Map<string, CooldownHit>();

/**
 * Check (and arm) the cooldown for `key`. When the key is fresh (or its previous
 * window already elapsed), arms a new `ms` window and returns `{ ok: true }`.
 * When the key is still cooling down, returns `{ ok: false, retryAfterMs }` and
 * does NOT extend the window. Short-circuits to `{ ok: true }` under
 * NODE_ENV=test.
 */
export function cooldownCheck(
  key: string,
  ms: number,
  now: number = Date.now(),
): { ok: true } | { ok: false; retryAfterMs: number } {
  if (process.env.NODE_ENV === 'test') return { ok: true };

  const hit = cooldowns.get(key);
  if (!hit || hit.resetAt <= now) {
    cooldowns.set(key, { resetAt: now + ms });
    sweepIfNeeded(now);
    return { ok: true };
  }
  return { ok: false, retryAfterMs: hit.resetAt - now };
}

/** Reset all state. Exposed for tests or admin rotations. */
export function cooldownReset(): void {
  cooldowns.clear();
}

let lastSweep = 0;
function sweepIfNeeded(now: number) {
  // Once per 60s clean up expired entries so the map doesn't grow forever.
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, hit] of cooldowns) {
    if (hit.resetAt <= now) cooldowns.delete(key);
  }
}

// ── Pre-baked window lengths for the paid AI paths ──────────────────────────

export const AI_COOLDOWN_MS = {
  /** POST /notebooks/:id/overview — per-notebook. */
  overview: 30_000,
  /** POST /ai/reindex — per-user. */
  reindex: 60_000,
  /** POST /sources/:id/suggest-card — per-source. */
  suggestCard: 5_000,
  /** POST /sources/:id/harvest-cards — per-source (a batch generation). */
  harvest: 15_000,
  /** POST /notebooks/plan-drafts — per-user. */
  planDraft: 30_000,
  /** GET /ai/chat-probe — per-user. */
  chatProbe: 10_000,
} as const;
