// T4 — app badge feature-detect guard tests.
//
// happy-dom lacks navigator.setAppBadge / clearAppBadge, so:
//   - "undefined → no-op (no throw)" paths are free (the guards handle it).
//   - "present → calls" paths inject mock functions onto navigator.

import { describe, expect, test, afterEach } from 'bun:test';
import { setBadge, clearBadge } from './app-badge';

// ── Snapshot of original navigator descriptor so we can restore after each test ──
const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function restoreNavigator(): void {
  if (originalDescriptor) {
    Object.defineProperty(globalThis, 'navigator', originalDescriptor);
  } else {
    delete (globalThis as Record<string, unknown>).navigator;
  }
}

afterEach(() => {
  restoreNavigator();
});

// ── Helpers to inject mock API ────────────────────────────────────────────────

type MockNavigator = Navigator & {
  setAppBadge?: (n: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
};

function patchNavigator(patch: Partial<MockNavigator>): void {
  const base: MockNavigator = { ...globalThis.navigator, ...patch };
  Object.defineProperty(globalThis, 'navigator', {
    value: base,
    configurable: true,
    writable: true,
  });
}

// ── "undefined → no-op (no throw)" ──────────────────────────────────────────

describe('setBadge / clearBadge — no API present (default happy-dom)', () => {
  test('setBadge(5) does not throw when setAppBadge is absent', () => {
    expect(() => setBadge(5)).not.toThrow();
  });

  test('setBadge(0) does not throw when clearAppBadge is absent', () => {
    expect(() => setBadge(0)).not.toThrow();
  });

  test('clearBadge() does not throw when clearAppBadge is absent', () => {
    expect(() => clearBadge()).not.toThrow();
  });

  test('a push payload still describes a notification when setAppBadge is absent', async () => {
    const { applyPushBadge, pushNotificationFromPayload } = await import('./push-display');
    const note = pushNotificationFromPayload('');
    expect(note.body).not.toMatch(/\d/);
    expect(() => applyPushBadge(note.badge, {})).not.toThrow();
    expect(() => setBadge(5)).not.toThrow();
  });
});

// ── "present → calls" ────────────────────────────────────────────────────────

describe('setBadge — API present', () => {
  test('n > 0 calls setAppBadge(n)', () => {
    const calls: number[] = [];
    patchNavigator({
      setAppBadge: async (n: number) => { calls.push(n); },
      clearAppBadge: async () => {},
    });

    setBadge(3);
    expect(calls).toEqual([3]);
  });

  test('n === 0 calls clearAppBadge (not setAppBadge)', () => {
    const setBadgeCalls: number[] = [];
    const clearCalls: number[] = [];
    patchNavigator({
      setAppBadge: async (n: number) => { setBadgeCalls.push(n); },
      clearAppBadge: async () => { clearCalls.push(0); },
    });

    setBadge(0);
    expect(setBadgeCalls).toHaveLength(0);
    expect(clearCalls).toHaveLength(1);
  });

  test('a throwing setAppBadge is swallowed silently', () => {
    patchNavigator({
      setAppBadge: async () => { throw new Error('permission denied'); },
      clearAppBadge: async () => {},
    });

    expect(() => setBadge(7)).not.toThrow();
  });
});

describe('clearBadge — API present', () => {
  test('calls clearAppBadge()', () => {
    const clearCalls: number[] = [];
    patchNavigator({
      setAppBadge: async () => {},
      clearAppBadge: async () => { clearCalls.push(0); },
    });

    clearBadge();
    expect(clearCalls).toHaveLength(1);
  });

  test('a throwing clearAppBadge is swallowed silently', () => {
    patchNavigator({
      setAppBadge: async () => {},
      clearAppBadge: async () => { throw new Error('not allowed'); },
    });

    expect(() => clearBadge()).not.toThrow();
  });
});
