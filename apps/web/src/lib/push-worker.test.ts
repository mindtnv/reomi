import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyPushBadge, pushNotificationFromPayload } from './push-display';

const webRoot = resolve(import.meta.dir, '../..');

describe('cache-free push worker', () => {
  test('push and notificationclick are present and Serwist still caches nothing', () => {
    const sw = readFileSync(resolve(import.meta.dir, '../app/sw.ts'), 'utf8');
    const config = readFileSync(resolve(webRoot, 'next.config.ts'), 'utf8');
    expect(sw).toContain("addEventListener('push'");
    expect(sw).toContain("addEventListener('notificationclick'");
    expect(sw).toContain("openWindow('/review')");
    expect(sw).toContain('showNotification');
    expect(sw).not.toContain('caches.open');
    expect(sw).not.toMatch(/runtimeCaching\s*:/);
    expect(config).toContain('globPublicPatterns: []');
    expect(config).toContain('manifestTransforms');
    expect(config).not.toMatch(/runtimeCaching\s*:/);
    expect(config).not.toMatch(/defaultCache\s*:/);
  });

  test('an empty push body is a generic notification and a missing badge API still returns it', () => {
    const note = pushNotificationFromPayload('');
    expect(note).toEqual({ title: 'Reomi', body: 'Open Reomi to review.', url: '/review', badge: null });
    expect(note.body).not.toMatch(/\d/);
    expect(pushNotificationFromPayload('not-json').body).not.toMatch(/\d/);
    expect(() => applyPushBadge(4, {})).not.toThrow();
    const calls: number[] = [];
    applyPushBadge(4, { setAppBadge: (count) => { calls.push(count); } });
    expect(calls).toEqual([4]);
    applyPushBadge(null, { setAppBadge: () => { calls.push(0); } });
    expect(calls).toEqual([4]);
  });
});
