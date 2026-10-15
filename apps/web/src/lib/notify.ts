// Local notification helper — opt-in only, feature-detected, best-effort.
//
// What this delivers:
//   - A client-side Notification fired on app-open when due > 0 AND user opted in.
//
// What this does NOT deliver:
//   - Background / while-closed notifications (requires server Web Push — NON-GOAL).
//   - Periodic Background Sync (Chromium-only, throttled, flaky — see hook below).
//
// The opt-in flag is persisted in localStorage so it survives page reloads.
// No API/store schema change — this is purely client-side state.
//
// iOS note: granting notification permission here also enables the iOS app badge
// (navigator.setAppBadge) — the two features share the same permission gate.

import { readBrowserValue, removeBrowserValue, writeBrowserValue } from './storage-migration';

const OPT_IN_KEY = 'nn:notifications:enabled';

/** Returns true only when Notification API is present in this context. */
function notificationsAvailable(): boolean {
  return typeof Notification !== 'undefined';
}

/**
 * Returns the persisted opt-in flag.
 * Safe to call during SSR (returns false when localStorage is unavailable).
 */
export function isNotificationsEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return readBrowserValue(localStorage, OPT_IN_KEY) === 'true';
}

/**
 * Persist the opt-in flag (does not request permission — call
 * requestNotificationPermission() for that).
 */
export function setNotificationsEnabled(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return;
  if (enabled) {
    writeBrowserValue(localStorage, OPT_IN_KEY, 'true');
  } else {
    removeBrowserValue(localStorage, OPT_IN_KEY);
  }
}

/**
 * Explicitly opt the user IN: persists the flag AND requests browser permission.
 * Call ONLY in response to a user gesture (e.g. clicking a toggle).
 * Never call at import time or on page load — that would auto-prompt.
 *
 * Returns 'granted' | 'denied' | 'default' | 'unavailable'.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission | 'unavailable'> {
  if (!notificationsAvailable()) return 'unavailable';
  const result = await Notification.requestPermission();
  setNotificationsEnabled(result === 'granted');
  return result;
}

/**
 * Fire a best-effort local Notification for the due-card count.
 * Guards:
 *   - Notification API must be present
 *   - Permission must be 'granted'
 *   - User must have opted in (isNotificationsEnabled())
 *   - n must be > 0
 *
 * Does NOT deliver notifications while the app is closed/backgrounded — that
 * requires server Web Push (NON-GOAL for this milestone).
 *
 * // HOOK: Periodic Background Sync trigger would go here when/if implemented.
 * // At that point, move the Notification dispatch into the SW message handler
 * // and keep this function as a fallback for the on-open path only.
 */
export function notifyDue(n: number): void {
  if (n <= 0) return;
  if (!isNotificationsEnabled()) return;
  if (!notificationsAvailable()) return;
  if (Notification.permission !== 'granted') return;

  try {
    // eslint-disable-next-line no-new
    new Notification('Reomi', {
      body: `${n} card${n === 1 ? '' : 's'} due for review`,
      icon: '/icons/icon-192.png',
      tag: 'nn-due', // dedup: replaces a previous due notification
    });
  } catch {
    // silent — notification is advisory
    if (process.env.NODE_ENV === 'development') {
      console.debug('[notify] Notification() failed');
    }
  }
}
