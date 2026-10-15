import { describe, expect, test } from 'bun:test';
import { AI_COOLDOWN_MS, cooldownCheck, cooldownReset } from '../src/ai-cooldown.ts';

// These assertions bypass the NODE_ENV=test short-circuit by clearing state
// and calling the pure checker with deterministic times (mirror rate-limit.test.ts).

describe('cooldownCheck (pure)', () => {
  test('first call arms the window (ok), an immediate second call is blocked', () => {
    cooldownReset();
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const ms = AI_COOLDOWN_MS.overview; // 30s
      const t0 = 1_000_000_000;
      const first = cooldownCheck('overview:nb-1', ms, t0);
      expect(first.ok).toBe(true);

      const second = cooldownCheck('overview:nb-1', ms, t0 + 1);
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.retryAfterMs).toBeGreaterThan(0);
        expect(second.retryAfterMs).toBeLessThanOrEqual(ms);
      }
    } finally {
      process.env.NODE_ENV = savedEnv;
    }
  });

  test('the window does NOT slide — retryAfterMs shrinks as time passes', () => {
    cooldownReset();
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const ms = 5_000;
      const t0 = 2_000_000_000;
      expect(cooldownCheck('suggest:s-1', ms, t0).ok).toBe(true);
      const mid = cooldownCheck('suggest:s-1', ms, t0 + 1_000);
      expect(mid.ok).toBe(false);
      // A second blocked check 1s later reports less time remaining (no reset).
      if (!mid.ok) expect(mid.retryAfterMs).toBe(4_000);
    } finally {
      process.env.NODE_ENV = savedEnv;
    }
  });

  test('a fresh window is allowed once the previous one elapses', () => {
    cooldownReset();
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const ms = AI_COOLDOWN_MS.reindex; // 60s
      const t0 = 3_000_000_000;
      expect(cooldownCheck('reindex:u-1', ms, t0).ok).toBe(true);
      expect(cooldownCheck('reindex:u-1', ms, t0).ok).toBe(false);
      const later = t0 + ms + 1;
      expect(cooldownCheck('reindex:u-1', ms, later).ok).toBe(true);
    } finally {
      process.env.NODE_ENV = savedEnv;
    }
  });

  test('independent tracking per key', () => {
    cooldownReset();
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const ms = 10_000;
      const t0 = 4_000_000_000;
      expect(cooldownCheck('reindex:u-A', ms, t0).ok).toBe(true);
      expect(cooldownCheck('reindex:u-A', ms, t0).ok).toBe(false);
      // A different key (e.g. another user) is still fresh.
      expect(cooldownCheck('reindex:u-B', ms, t0).ok).toBe(true);
    } finally {
      process.env.NODE_ENV = savedEnv;
    }
  });

  test('plan-draft:<userId> rejects a second call inside 30 seconds', () => {
    cooldownReset();
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const userId = '018f3b2a-7c31-7b2a-8c11-111111111111';
      const ms = AI_COOLDOWN_MS.planDraft;
      expect(ms).toBe(30_000);
      const t0 = 5_000_000_000;
      expect(cooldownCheck(`plan-draft:${userId}`, ms, t0).ok).toBe(true);
      const again = cooldownCheck(`plan-draft:${userId}`, ms, t0 + 29_999);
      expect(again.ok).toBe(false);
      if (!again.ok) expect(again.retryAfterMs).toBe(1);
      expect(cooldownCheck(`plan-draft:${userId}`, ms, t0 + 30_000).ok).toBe(true);
    } finally {
      process.env.NODE_ENV = savedEnv;
    }
  });

  test('NODE_ENV=test short-circuits to ok', () => {
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      for (let i = 0; i < 10; i++) {
        expect(cooldownCheck('overview:nb-test', AI_COOLDOWN_MS.overview).ok).toBe(true);
      }
    } finally {
      process.env.NODE_ENV = savedEnv;
    }
  });
});
