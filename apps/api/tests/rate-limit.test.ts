import { describe, expect, test } from 'bun:test';
import { AUTH_RATE_RULES, authRateRuleFor, rateLimitCheck, rateLimitReset } from '../src/rate-limit.ts';

// These assertions bypass the NODE_ENV=test short-circuit by clearing state
// and calling the pure checker with deterministic times.

describe('rateLimitCheck (pure)', () => {
  test('allows up to `limit` requests in window, then blocks', () => {
    rateLimitReset();
    // Force the test-env early return off for this scope.
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const rule = AUTH_RATE_RULES.signIn; // 5 / minute
      const t0 = 1_000_000_000;
      for (let i = 0; i < rule.limit; i++) {
        const res = rateLimitCheck('1.2.3.4', rule, t0 + i);
        expect(res.allowed).toBe(true);
      }
      const blocked = rateLimitCheck('1.2.3.4', rule, t0 + rule.limit);
      expect(blocked.allowed).toBe(false);
      if (!blocked.allowed) {
        expect(blocked.retryAfterMs).toBeGreaterThan(0);
        expect(blocked.retryAfterMs).toBeLessThanOrEqual(rule.windowMs);
      }
    } finally {
      process.env.NODE_ENV = savedEnv;
    }
  });

  test('resets after the window passes', () => {
    rateLimitReset();
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const rule = AUTH_RATE_RULES.signIn;
      const t0 = 2_000_000_000;
      for (let i = 0; i < rule.limit; i++) rateLimitCheck('5.6.7.8', rule, t0);
      expect(rateLimitCheck('5.6.7.8', rule, t0).allowed).toBe(false);
      const later = t0 + rule.windowMs + 1;
      expect(rateLimitCheck('5.6.7.8', rule, later).allowed).toBe(true);
    } finally {
      process.env.NODE_ENV = savedEnv;
    }
  });

  test('independent tracking per IP', () => {
    rateLimitReset();
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const rule = AUTH_RATE_RULES.signIn;
      const t0 = 3_000_000_000;
      for (let i = 0; i < rule.limit; i++) rateLimitCheck('9.9.9.9', rule, t0);
      expect(rateLimitCheck('9.9.9.9', rule, t0).allowed).toBe(false);
      // different IP, same bucket — still fresh
      expect(rateLimitCheck('1.1.1.1', rule, t0).allowed).toBe(true);
    } finally {
      process.env.NODE_ENV = savedEnv;
    }
  });

  test('password reset posts share the forgot-password budget', () => {
    expect(authRateRuleFor('POST', '/api/auth/request-password-reset')).toEqual(AUTH_RATE_RULES.forgot);
    expect(authRateRuleFor('POST', '/api/auth/forget-password')).toEqual(AUTH_RATE_RULES.forgot);
    expect(authRateRuleFor('POST', '/api/auth/forgot-password')).toEqual(AUTH_RATE_RULES.forgot);
    expect(authRateRuleFor('GET', '/api/auth/request-password-reset')).toBeNull();
    expect(authRateRuleFor('POST', '/api/auth/sign-in/email')).toEqual(AUTH_RATE_RULES.signIn);
    expect(authRateRuleFor('POST', '/api/auth/reset-password')).toBeNull();
  });

  test('NODE_ENV=test short-circuits to allowed', () => {
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      const rule = AUTH_RATE_RULES.signIn;
      for (let i = 0; i < rule.limit * 3; i++) {
        expect(rateLimitCheck('10.10.10.10', rule).allowed).toBe(true);
      }
    } finally {
      process.env.NODE_ENV = savedEnv;
    }
  });
});
