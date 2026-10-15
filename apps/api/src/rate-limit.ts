// Tiny in-memory IP rate limiter. Enforces "N requests per window" per
// (bucket, ip). Designed for the auth paths (sign-in / sign-up / forgot)
// where even single-digit RPS is catastrophic for brute force.
//
// Limitations:
//   - Single-process only. For multi-instance prod, swap the Map for a Redis
//     INCR/EXPIRE pair with the same interface.
//   - Keys live until their window elapses; lightweight sweep on each check.
//
// Disabled entirely under NODE_ENV=test so our integration tests (which hit
// sign-up hundreds of times in quick succession) don't false-trip limits.

export interface RateLimitRule {
  /** Logical name — same IP across different buckets is tracked separately. */
  bucket: string;
  /** Max requests allowed per window. */
  limit: number;
  /** Window length, milliseconds. */
  windowMs: number;
}

interface Hit {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Hit>();

export function rateLimitCheck(
  ip: string,
  rule: RateLimitRule,
  now: number = Date.now(),
): { allowed: true } | { allowed: false; retryAfterMs: number } {
  if (process.env.NODE_ENV === 'test') return { allowed: true };

  const key = `${rule.bucket}|${ip}`;
  const hit = buckets.get(key);

  if (!hit || hit.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + rule.windowMs });
    sweepIfNeeded(now);
    return { allowed: true };
  }

  if (hit.count >= rule.limit) {
    return { allowed: false, retryAfterMs: hit.resetAt - now };
  }

  hit.count += 1;
  return { allowed: true };
}

/** Reset all state. Exposed for tests or admin rotations. */
export function rateLimitReset(): void {
  buckets.clear();
}

let lastSweep = 0;
function sweepIfNeeded(now: number) {
  // Once per 30s clean up stale entries so the map doesn't grow forever.
  if (now - lastSweep < 30_000) return;
  lastSweep = now;
  for (const [key, hit] of buckets) {
    if (hit.resetAt <= now) buckets.delete(key);
  }
}

/** Extract the best-effort client IP from an incoming Request. */
export function clientIpFromRequest(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get('x-real-ip');
  if (real) return real.trim();
  return 'unknown';
}

// ── Pre-baked rules for the auth paths ──────────────────────────────────────

export const AUTH_RATE_RULES = {
  signIn: { bucket: 'auth:sign-in', limit: 5, windowMs: 60_000 } as RateLimitRule,
  signUp: { bucket: 'auth:sign-up', limit: 5, windowMs: 60 * 60_000 } as RateLimitRule,
  forgot: { bucket: 'auth:forgot', limit: 3, windowMs: 60 * 60_000 } as RateLimitRule,
};

export function authRateRuleFor(method: string, pathname: string): RateLimitRule | null {
  if (method !== 'POST') return null;
  if (pathname === '/api/auth/sign-in/email') return AUTH_RATE_RULES.signIn;
  if (pathname === '/api/auth/sign-up/email') return AUTH_RATE_RULES.signUp;
  if (
    pathname === '/api/auth/request-password-reset' ||
    pathname === '/api/auth/forget-password' ||
    pathname === '/api/auth/forgot-password'
  ) {
    return AUTH_RATE_RULES.forgot;
  }
  return null;
}
