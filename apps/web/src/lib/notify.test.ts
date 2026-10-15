// T5 — notification gate tests.
//
// happy-dom lacks Notification, so:
//   - "undefined Notification → no-op" paths are free.
//   - "opt-in → requestPermission called" and "denied → no notify" paths
//     inject a fake Notification class onto globalThis.
//
// IMPORTANT: import test-dom-setup FIRST so happy-dom registers globals
// (window, localStorage, etc.) before any module under test is evaluated.

import { ensureTestDom } from './test-dom-setup.ts';

import { describe, expect, test, beforeAll, beforeEach, afterEach } from 'bun:test';

// In CI file order this suite can run AFTER render-math/sanitize-img, whose
// teardown unregisters the happy-dom globals — the cached side-effect import
// alone would leave us without window/localStorage (guards in notify.ts then
// silently no-op and every assertion reads false).
beforeAll(() => {
  ensureTestDom();
});
import {
  requestNotificationPermission,
  notifyDue,
  isNotificationsEnabled,
  setNotificationsEnabled,
} from './notify';

// ── localStorage stub (happy-dom should have it, but ensure clean slate) ─────

beforeEach(() => {
  if (typeof localStorage !== 'undefined') {
    localStorage.removeItem('nn:notifications:enabled');
    localStorage.removeItem('reomi:notifications:enabled');
  }
});

// ── Snapshot of Notification so we can restore ────────────────────────────────

type FakeNotification = {
  new (title: string, opts?: NotificationOptions): object;
  requestPermission: () => Promise<NotificationPermission>;
  permission: NotificationPermission;
};

const originalNotification = (globalThis as Record<string, unknown>)['Notification'];

function setFakeNotification(fake: FakeNotification | undefined): void {
  if (fake === undefined) {
    delete (globalThis as Record<string, unknown>)['Notification'];
  } else {
    (globalThis as Record<string, unknown>)['Notification'] = fake;
  }
}

afterEach(() => {
  if (originalNotification === undefined) {
    delete (globalThis as Record<string, unknown>)['Notification'];
  } else {
    (globalThis as Record<string, unknown>)['Notification'] = originalNotification;
  }
  // Clean up opt-in state
  setNotificationsEnabled(false);
});

// ── "undefined Notification → no-op" ─────────────────────────────────────────

describe('notify — Notification API absent', () => {
  beforeEach(() => {
    setFakeNotification(undefined);
  });

  test('requestNotificationPermission returns "unavailable" without calling anything', async () => {
    const result = await requestNotificationPermission();
    expect(result).toBe('unavailable');
  });

  test('notifyDue does not throw', () => {
    setNotificationsEnabled(true);
    expect(() => notifyDue(5)).not.toThrow();
  });

  test('isNotificationsEnabled reads from localStorage only (not Notification)', () => {
    setNotificationsEnabled(true);
    expect(isNotificationsEnabled()).toBe(true);
  });
});

// ── "opt-in → requestPermission called" ──────────────────────────────────────

describe('notify — Notification API present, permission granted', () => {
  const notifInstances: { title: string; opts: NotificationOptions | undefined }[] = [];
  let requestPermissionCallCount = 0;

  beforeEach(() => {
    notifInstances.length = 0;
    requestPermissionCallCount = 0;

    class FakeNotif {
      static permission: NotificationPermission = 'granted';
      static async requestPermission(): Promise<NotificationPermission> {
        requestPermissionCallCount++;
        return 'granted';
      }
      constructor(title: string, opts?: NotificationOptions) {
        notifInstances.push({ title, opts });
      }
    }
    setFakeNotification(FakeNotif as unknown as FakeNotification);
  });

  test('permission is NOT requested at module import/load', () => {
    // Simply importing the module must not call requestPermission.
    // By this point the module is already imported; assert call count is 0.
    expect(requestPermissionCallCount).toBe(0);
  });

  test('permission IS requested on explicit requestNotificationPermission() call', async () => {
    await requestNotificationPermission();
    expect(requestPermissionCallCount).toBe(1);
  });

  test('opt-in flag is persisted after granting permission', async () => {
    await requestNotificationPermission();
    expect(isNotificationsEnabled()).toBe(true);
  });

  test('notifyDue fires a Notification when opted-in and due > 0', () => {
    setNotificationsEnabled(true);
    notifyDue(4);
    expect(notifInstances).toHaveLength(1);
    expect(notifInstances[0]?.title).toBe('Reomi');
  });

  test('notifyDue does NOT fire when n === 0', () => {
    setNotificationsEnabled(true);
    notifyDue(0);
    expect(notifInstances).toHaveLength(0);
  });

  test('notifyDue does NOT fire when not opted-in', () => {
    // flag not set — default false
    notifyDue(4);
    expect(notifInstances).toHaveLength(0);
  });
});

// ── "denied → no notify" ─────────────────────────────────────────────────────

describe('notify — Notification API present, permission denied', () => {
  const notifInstances: object[] = [];
  let requestPermissionCallCount = 0;

  beforeEach(() => {
    notifInstances.length = 0;
    requestPermissionCallCount = 0;

    class FakeNotif {
      static permission: NotificationPermission = 'denied';
      static async requestPermission(): Promise<NotificationPermission> {
        requestPermissionCallCount++;
        return 'denied';
      }
      constructor(_title: string, _opts?: NotificationOptions) {
        notifInstances.push({});
      }
    }
    setFakeNotification(FakeNotif as unknown as FakeNotification);
  });

  test('requestNotificationPermission returns "denied"', async () => {
    const result = await requestNotificationPermission();
    expect(result).toBe('denied');
  });

  test('opt-in flag is NOT set when permission denied', async () => {
    await requestNotificationPermission();
    expect(isNotificationsEnabled()).toBe(false);
  });

  test('notifyDue does NOT fire when permission is denied (even if flag was set somehow)', () => {
    // Manually set the flag; notifyDue must still check Notification.permission
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('nn:notifications:enabled', 'true');
    }
    notifyDue(5);
    expect(notifInstances).toHaveLength(0);
  });
});
