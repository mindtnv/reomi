import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  cards,
  db,
  notificationDeliveries,
  notificationSettings,
  profile,
  pushSubscriptions,
} from '@reomi/db';
import { buildApp } from '../src/app.ts';
import { markRuntimeRunning, markRuntimeShuttingDown } from '../src/runtime-state.ts';
import { reminderSchedulerActive, startReminderScheduler } from '../src/reminders/scheduler.ts';
import { runReminderTick, type ReminderEmail } from '../src/reminders/tick.ts';
import { __setDnsLookupForTests, deliverWebPush, generateVapidKeys } from '../src/reminders/web-push.ts';
import { callApp, resetTestDb, seedBasicCard, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

const choice = {
  digestEnabled: true,
  streakWarningEnabled: false,
  timeZone: 'America/New_York',
  digestHour: 9,
  streakHour: 21,
  emailEnabled: true,
  pushEnabled: false,
  locale: 'en' as const,
};

beforeEach(async () => {
  markRuntimeRunning();
  __setDnsLookupForTests(null);
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
  await resetTestDb();
});

async function account() {
  const email = uniqueEmail('rem');
  const { cookie, userId } = await signUpAndCookie(app, email);
  await callApp(app, 'GET', '/profile', { cookie });
  const deck = await (await callApp(app, 'POST', '/decks', { cookie, body: { name: 'D' } })).json<{ id: string }>();
  return { email, cookie, userId, deckId: deck.id };
}

async function save(cookie: string, body: Record<string, unknown> = choice) {
  return callApp(app, 'PUT', '/profile/reminders', { cookie, body });
}

async function alignDue(userId: string, now: Date) {
  await db.update(cards).set({ due: now }).where(eq(cards.userId, userId));
}

function captureEmail(): { email: ReminderEmail; sent: { to: string; subject: string; text: string }[] } {
  const sent: { to: string; subject: string; text: string }[] = [];
  return { sent, email: { send: async (input) => { sent.push(input); } } };
}

describe('study reminder settings', () => {
  test('starts unsaved and rejects a bad zone, hour, and locale without writing', async () => {
    const { cookie } = await account();
    const first = await (await callApp(app, 'GET', '/profile/reminders', { cookie })).json<{ saved: boolean; digestEnabled: boolean; vapidPublicKey: string | null }>();
    expect(first).toMatchObject({ saved: false, digestEnabled: false, emailEnabled: false, pushEnabled: false, vapidPublicKey: null });

    expect((await callApp(app, 'GET', '/profile/reminders')).status).toBe(401);
    expect((await callApp(app, 'PUT', '/profile/reminders', { body: choice })).status).toBe(401);

    for (const body of [
      { ...choice, digestHour: 24 },
      { ...choice, streakHour: -1 },
      { ...choice, locale: 'de' },
    ]) {
      const rejected = await save(cookie, body);
      expect(rejected.status).toBe(400);
    }
    const zone = await save(cookie, { ...choice, timeZone: 'Mars/Phobos' });
    expect(zone.status).toBe(400);
    expect(await db.select().from(notificationSettings)).toHaveLength(0);

    expect((await save(cookie)).status).toBe(200);
    const badAgain = await save(cookie, { ...choice, timeZone: 'Mars/Phobos', digestHour: 4 });
    expect(badAgain.status).toBe(400);
    const [row] = await db.select().from(notificationSettings);
    expect(row!.timeZone).toBe('America/New_York');
    expect(row!.digestHour).toBe(9);
  });

  test('one account cannot read or write another, and a personal token cannot write', async () => {
    const alice = await account();
    const bob = await account();
    expect((await save(alice.cookie)).status).toBe(200);
    const seen = await (await callApp(app, 'GET', '/profile/reminders', { cookie: bob.cookie })).json<{ saved: boolean; timeZone: string | null }>();
    expect(seen).toMatchObject({ saved: false, timeZone: null });
    expect((await save(bob.cookie, { ...choice, timeZone: 'UTC', digestHour: 3 })).status).toBe(200);
    const aliceStill = await (await callApp(app, 'GET', '/profile/reminders', { cookie: alice.cookie })).json<{ timeZone: string }>();
    expect(aliceStill.timeZone).toBe('America/New_York');

    const token = await (await callApp(app, 'POST', '/profile/tokens', {
      cookie: alice.cookie,
      body: { name: 'agent', scope: 'write', expiresInDays: 7 },
    })).json<{ token: string }>();
    const denied = await callApp(app, 'PUT', '/profile/reminders', {
      headers: { authorization: `Bearer ${token.token}` },
      body: { ...choice, digestHour: 1 },
    });
    expect(denied.status).toBe(401);
    const [row] = await db.select().from(notificationSettings).where(eq(notificationSettings.userId, alice.userId));
    expect(row!.digestHour).toBe(9);
  });

  test('undo restores the grade and leaves the saved hour in place', async () => {
    const { cookie, deckId } = await account();
    const card = await seedBasicCard(app, cookie, { deckId, front: 'Q', back: 'A' });
    expect((await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: card.id, rating: 3 } })).status).toBe(200);
    expect((await save(cookie, { ...choice, digestHour: 11 })).status).toBe(200);
    expect((await callApp(app, 'POST', '/reviews/undo', { cookie, body: {} })).status).toBe(200);
    const saved = await (await callApp(app, 'GET', '/profile/reminders', { cookie })).json<{ digestHour: number }>();
    expect(saved.digestHour).toBe(11);
  });

  test('export includes the reminder choice and delete removes settings, subscriptions, and receipts', async () => {
    const owner = await account();
    process.env.VAPID_PUBLIC_KEY = 'vapid-public-fixture';
    process.env.VAPID_PRIVATE_KEY = 'vapid-private-secret';
    expect((await save(owner.cookie)).status).toBe(200);
    const endpoint = 'https://fcm.googleapis.com/fcm/send/EXPORTSECRETPATH';
    expect((await callApp(app, 'POST', '/profile/push-subscriptions', {
      cookie: owner.cookie,
      body: { endpoint, keys: { p256dh: 'p', auth: 'a' } },
    })).status).toBe(200);
    await db.insert(notificationDeliveries).values({
      userId: owner.userId, kind: 'due_digest', channel: 'email', studyDay: '2026-01-15', status: 'sent',
    });
    const exported = await callApp(app, 'GET', '/profile/export', { cookie: owner.cookie });
    const text = await exported.text();
    expect(exported.status).toBe(200);
    expect(text).toContain('America/New_York');
    expect(text).not.toContain('EXPORTSECRETPATH');
    expect(text).not.toContain('vapid-private-secret');

    const removed = await callApp(app, 'DELETE', '/profile', { cookie: owner.cookie, body: { confirmEmail: owner.email } });
    expect(removed.status).toBe(200);
    expect(await db.select().from(notificationSettings)).toHaveLength(0);
    expect(await db.select().from(pushSubscriptions)).toHaveLength(0);
    expect(await db.select().from(notificationDeliveries)).toHaveLength(0);
  });
});

describe('study reminder tick', () => {
  test('sends one digest after the local hour, including across DST, and stays quiet otherwise', async () => {
    const owner = await account();
    const card = await seedBasicCard(app, owner.cookie, {
      deckId: owner.deckId, front: 'ZEBRAFRONTTOKEN', back: 'ZEBRADECKTOKEN',
    });
    expect((await save(owner.cookie)).status).toBe(200);
    const early = new Date('2026-01-15T13:30:00.000Z');
    const winter = new Date('2026-01-15T14:30:00.000Z');
    const summer = new Date('2026-07-15T13:30:00.000Z');
    await alignDue(owner.userId, early);
    const { email, sent } = captureEmail();

    await runReminderTick({ now: early, email });
    expect(sent).toHaveLength(0);
    expect(await db.select().from(notificationDeliveries)).toHaveLength(0);

    await db.delete(cards).where(eq(cards.id, card.id));
    await runReminderTick({ now: winter, email });
    expect(sent).toHaveLength(0);
    expect(await db.select().from(notificationDeliveries)).toHaveLength(0);

    await seedBasicCard(app, owner.cookie, {
      deckId: owner.deckId, front: 'ZEBRAFRONTTOKEN', back: 'ZEBRADECKTOKEN',
    });
    await alignDue(owner.userId, winter);
    await runReminderTick({ now: winter, email });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('/review');
    expect(sent[0]!.text).toContain('1');
    expect(sent[0]!.text).not.toContain('ZEBRAFRONTTOKEN');
    expect(sent[0]!.text).not.toContain('ZEBRADECKTOKEN');
    await runReminderTick({ now: winter, email });
    expect(sent).toHaveLength(1);

    await runReminderTick({ now: summer, email });
    expect(sent).toHaveLength(2);
    const rows = await db.select().from(notificationDeliveries);
    expect(rows.filter((row) => row.status === 'sent')).toHaveLength(2);
  });

  test('cards that appear after the chosen hour still produce one digest, and a zero count does not burn the day', async () => {
    const owner = await account();
    expect((await save(owner.cookie)).status).toBe(200);
    const atHour = new Date('2026-01-15T14:30:00.000Z');
    const later = new Date('2026-01-15T16:30:00.000Z');
    const { email, sent } = captureEmail();

    await runReminderTick({ now: atHour, email });
    expect(sent).toHaveLength(0);
    expect(await db.select().from(notificationDeliveries)).toHaveLength(0);

    await seedBasicCard(app, owner.cookie, { deckId: owner.deckId, front: 'LATER', back: 'CARD' });
    await alignDue(owner.userId, later);
    await runReminderTick({ now: later, email });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('1');
    await runReminderTick({ now: later, email });
    expect(sent).toHaveLength(1);
    expect(await db.select().from(notificationDeliveries)).toHaveLength(1);
  });

  test('a digest hour skipped by the spring-forward jump is sent once that afternoon', async () => {
    const owner = await account();
    await seedBasicCard(app, owner.cookie, { deckId: owner.deckId, front: 'DST', back: 'CARD' });
    expect((await save(owner.cookie, { ...choice, digestHour: 2 })).status).toBe(200);
    const beforeJump = new Date('2026-03-08T06:30:00.000Z');
    const afterJump = new Date('2026-03-08T07:30:00.000Z');
    await alignDue(owner.userId, afterJump);
    const { email, sent } = captureEmail();

    await runReminderTick({ now: beforeJump, email });
    expect(sent).toHaveLength(0);
    expect(await db.select().from(notificationDeliveries)).toHaveLength(0);

    await runReminderTick({ now: afterJump, email });
    expect(sent).toHaveLength(1);
    await runReminderTick({ now: afterJump, email });
    expect(sent).toHaveLength(1);
    const [row] = await db.select().from(notificationDeliveries);
    expect(row).toMatchObject({ kind: 'due_digest', status: 'sent', studyDay: '2026-03-08' });
  });

  test('a send that outlives its lease cannot overwrite the replica that reclaimed the slot', async () => {
    const owner = await account();
    await seedBasicCard(app, owner.cookie, { deckId: owner.deckId, front: 'RACE', back: 'CARD' });
    const now = new Date('2026-01-15T14:30:00.000Z');
    await alignDue(owner.userId, now);
    expect((await save(owner.cookie)).status).toBe(200);

    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const first = runReminderTick({
      now,
      email: {
        send: async () => {
          entered();
          await hold;
          throw new Error('late');
        },
      },
    });
    await inside;

    const secondSends: string[] = [];
    const later = new Date(now.getTime() + 3 * 60 * 1000);
    await runReminderTick({
      now: later,
      email: { send: async () => { secondSends.push('second'); } },
    });
    expect(secondSends).toEqual(['second']);
    release();
    await first;

    const [row] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.userId, owner.userId));
    expect(row).toMatchObject({ status: 'sent', errorCode: null });
  });

  test('parallel passes produce one send, a missing provider can be retried, and one failure does not stop the next user', async () => {
    const owner = await account();
    await seedBasicCard(app, owner.cookie, { deckId: owner.deckId, front: 'Q', back: 'A' });
    const now = new Date('2026-01-15T14:30:00.000Z');
    await alignDue(owner.userId, now);
    expect((await save(owner.cookie)).status).toBe(200);
    const { email, sent } = captureEmail();
    await Promise.all([
      runReminderTick({ now, email }),
      runReminderTick({ now, email }),
    ]);
    expect(sent).toHaveLength(1);
    expect(await db.select().from(notificationDeliveries)).toHaveLength(1);

    await db.delete(notificationDeliveries);
    await runReminderTick({ now, email: null });
    const [waiting] = await db.select().from(notificationDeliveries);
    expect(waiting).toMatchObject({ status: 'failed', errorCode: 'email_unconfigured' });
    await runReminderTick({ now, email });
    expect(sent).toHaveLength(1);
    const later = new Date(now.getTime() + 16 * 60 * 1000);
    await runReminderTick({ now: later, email });
    expect(sent).toHaveLength(2);
    const [retried] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.userId, owner.userId));
    expect(retried!.status).toBe('sent');

    const other = await account();
    await seedBasicCard(app, other.cookie, { deckId: other.deckId, front: 'Q2', back: 'A2' });
    await alignDue(other.userId, now);
    expect((await save(other.cookie, { ...choice, timeZone: 'UTC', digestHour: now.getUTCHours() })).status).toBe(200);
    await db.delete(notificationDeliveries);
    const delivered: string[] = [];
    await runReminderTick({
      now,
      email: {
        send: async (input) => {
          if (input.to === owner.email) throw new Error('smtp down');
          delivered.push(input.to);
        },
      },
    });
    expect(delivered).toEqual([other.email]);
    const failed = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.userId, owner.userId));
    expect(failed[0]).toMatchObject({ status: 'failed', errorCode: 'email_failed' });
    const ok = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.userId, other.userId));
    expect(ok[0]!.status).toBe('sent');
  });

  test('streak warning follows the UTC study day and does not change streak or FSRS', async () => {
    const owner = await account();
    const card = await seedBasicCard(app, owner.cookie, { deckId: owner.deckId, front: 'Q', back: 'A' });
    const now = new Date('2026-03-01T18:10:00.000Z');
    expect((await save(owner.cookie, {
      ...choice,
      digestEnabled: false,
      streakWarningEnabled: true,
      timeZone: 'UTC',
      streakHour: now.getUTCHours(),
    })).status).toBe(200);
    const [beforeCard] = await db.select().from(cards).where(eq(cards.id, card.id));
    const { email, sent } = captureEmail();
    await db.update(profile).set({ streakDays: 0, streakFreezes: 2, xp: 15 }).where(eq(profile.userId, owner.userId));
    await runReminderTick({ now, email });
    expect(sent).toHaveLength(0);
    expect(await db.select().from(notificationDeliveries)).toHaveLength(0);

    await db.update(profile).set({ streakDays: 4, streakFreezes: 2, xp: 15 }).where(eq(profile.userId, owner.userId));
    await runReminderTick({ now, email });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('4');
    expect(sent[0]!.text).toContain('2');
    expect(sent[0]!.text).toContain('/review');
    const [afterProfile] = await db.select().from(profile).where(eq(profile.userId, owner.userId));
    const [afterCard] = await db.select().from(cards).where(eq(cards.id, card.id));
    expect(afterProfile).toMatchObject({ streakDays: 4, streakFreezes: 2, xp: 15 });
    expect(afterCard!.due.toISOString()).toBe(beforeCard!.due.toISOString());
    expect(afterCard!.stability).toBe(beforeCard!.stability);
    expect(afterCard!.reps).toBe(beforeCard!.reps);

    expect((await callApp(app, 'POST', '/reviews', { cookie: owner.cookie, body: { cardId: card.id, rating: 3 } })).status).toBe(200);
    const reviewedAt = new Date();
    await save(owner.cookie, {
      ...choice,
      digestEnabled: false,
      streakWarningEnabled: true,
      timeZone: 'UTC',
      streakHour: reviewedAt.getUTCHours(),
    });
    const before = sent.length;
    await runReminderTick({ now: reviewedAt, email });
    expect(sent).toHaveLength(before);
  });

  test('after shutdown a new pass reserves nothing, and the scheduler stays idle in test', () => {
    startReminderScheduler();
    expect(reminderSchedulerActive()).toBe(false);
  });

  test('a shutdown signal blocks a new reservation and readiness hides user content', async () => {
    const owner = await account();
    await seedBasicCard(app, owner.cookie, { deckId: owner.deckId, front: 'Q', back: 'A' });
    const now = new Date('2026-01-15T14:30:00.000Z');
    await alignDue(owner.userId, now);
    expect((await save(owner.cookie)).status).toBe(200);
    markRuntimeShuttingDown();
    await runReminderTick({ now, email: captureEmail().email });
    expect(await db.select().from(notificationDeliveries)).toHaveLength(0);
    const ready = await callApp(app, 'GET', '/ready');
    const text = await ready.text();
    expect(ready.status).toBe(503);
    expect(text).toContain('"reminder"');
    expect(text).not.toContain(owner.userId);
    expect(text).not.toContain(owner.email);
    expect(text).not.toContain('endpoint');
  });
});

describe('web push subscriptions', () => {
  const keys = { p256dh: 'cHVzaC1rZXk', auth: 'YXV0aC1zZWNyZXQ' };

  function armVapid() {
    process.env.VAPID_PUBLIC_KEY = 'vapid-public-fixture';
    process.env.VAPID_PRIVATE_KEY = 'vapid-private-secret';
  }

  async function subscribe(cookie: string, endpoint: string) {
    return callApp(app, 'POST', '/profile/push-subscriptions', {
      cookie,
      body: { endpoint, keys },
    });
  }

  test('hides endpoint material, caps active rows, and disables a 410', async () => {
    const owner = await account();
    const other = await account();
    armVapid();
    const endpoint = 'https://fcm.googleapis.com/fcm/send/SECRETPATHTOKEN';
    expect((await subscribe(owner.cookie, endpoint)).status).toBe(200);
    const listed = await callApp(app, 'GET', '/profile/push-subscriptions', { cookie: owner.cookie });
    const listText = await listed.text();
    expect(listText).not.toContain('SECRETPATHTOKEN');
    expect(listText).not.toContain(keys.p256dh);
    expect(listText).not.toContain(keys.auth);
    const { items } = await listed.json<{ items: { id: string; disabled: boolean }[] }>();
    expect(items[0]!.disabled).toBe(false);
    expect((await callApp(app, 'DELETE', `/profile/push-subscriptions/${items[0]!.id}`, { cookie: other.cookie })).status).toBe(404);
    expect(await db.select().from(pushSubscriptions)).toHaveLength(1);

    for (let i = 0; i < 9; i += 1) {
      expect((await subscribe(owner.cookie, `https://updates.push.services.mozilla.com/wpush/${i}`)).status).toBe(200);
    }
    const extra = await subscribe(owner.cookie, 'https://web.push.apple.com/extra');
    expect(extra.status).toBe(409);
    expect(await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, owner.userId))).toHaveLength(10);

    const now = new Date('2026-01-15T14:30:00.000Z');
    await db.update(notificationSettings).set({ pushEnabled: true }).where(eq(notificationSettings.userId, owner.userId));
    await save(owner.cookie, { ...choice, pushEnabled: true, emailEnabled: false });
    await seedBasicCard(app, owner.cookie, { deckId: owner.deckId, front: 'Q', back: 'A' });
    await alignDue(owner.userId, now);
    await db.update(pushSubscriptions).set({ disabledAt: now }).where(eq(pushSubscriptions.userId, owner.userId));
    await db.update(pushSubscriptions).set({ disabledAt: null }).where(eq(pushSubscriptions.endpoint, endpoint));
    await runReminderTick({
      now,
      email: null,
      push: {
        configured: () => true,
        deliver: async () => ({ ok: false, code: 'gone', statusCode: 410 }),
      },
    });
    const [disabled] = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
    expect(disabled!.disabledAt).toBeTruthy();
    const [receipt] = await db.select().from(notificationDeliveries);
    expect(receipt).toMatchObject({ status: 'skipped', errorCode: 'no_subscription', pushService: 'fcm' });
    expect(JSON.stringify(receipt)).not.toContain('SECRETPATHTOKEN');
  });

  test('registration rejects loopback written as IPv6 and hosts outside the push allowlist', async () => {
    const owner = await account();
    armVapid();
    const blocked = [
      'https://[::ffff:127.0.0.1]/push',
      'https://[::ffff:7f00:1]/push',
      'https://[::127.0.0.1]/push',
      'https://[::7f00:1]/push',
      'https://[64:ff9b::127.0.0.1]/push',
      'https://[64:ff9b::7f00:1]/push',
      'https://[64:ff9b:1::7f00:1]/push',
      'https://[2002:7f00:1::]/push',
      'https://[fd00::1]/push',
      'https://[fe80::1]/push',
      'https://10.0.0.1/push',
      'https://example.com/push',
      'https://fcm.googleapis.com.evil.com/push',
      'https://user:pass@fcm.googleapis.com/push',
    ];
    for (const endpoint of blocked) {
      const response = await subscribe(owner.cookie, endpoint);
      expect(response.status, endpoint).toBe(400);
    }
    expect(await db.select().from(pushSubscriptions)).toHaveLength(0);
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/ok',
      'https://updates.push.services.mozilla.com/wpush/1',
      'https://web.push.apple.com/1',
      'https://wns2-pn1.notify.windows.com/1',
    ]) {
      expect((await subscribe(owner.cookie, endpoint)).status, endpoint).toBe(200);
    }
  });

  test('delivery resolves an allowlisted host and refuses a private answer', async () => {
    const lookups: string[] = [];
    const keys = generateVapidKeys();
    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;
    process.env.VAPID_SUBJECT = 'https://app.reomi.ru';
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const subscription = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/dns-check',
      p256dh: Buffer.from(raw).toString('base64url'),
      auth: Buffer.from(auth).toString('base64url'),
    };
    const blocked = [
      '127.0.0.1',
      '10.1.2.3',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::7f00:1',
      '64:ff9b::7f00:1',
      '64:ff9b:1::7f00:1',
      '2002:7f00:1::',
      '2001:0::ffff:ffff',
      'fd00::1',
      'fe80::1',
    ];
    try {
      for (const address of blocked) {
        lookups.length = 0;
        __setDnsLookupForTests(async (host) => {
          lookups.push(host);
          return [{ address, family: address.includes(':') ? 6 : 4 }];
        });
        const result = await deliverWebPush(subscription, '{}');
        expect(lookups, address).toEqual(['fcm.googleapis.com']);
        expect(result, address).toEqual({ ok: false, code: 'push_failed' });
      }
    } finally {
      __setDnsLookupForTests(null);
    }
  });

  test('missing VAPID returns push_disabled and deck reads stay up', async () => {
    const owner = await account();
    const denied = await subscribe(owner.cookie, 'https://fcm.googleapis.com/fcm/send/no-keys');
    expect(denied.status).toBe(503);
    expect(await denied.json()).toEqual({ error: 'push_disabled' });
    expect((await callApp(app, 'GET', '/decks', { cookie: owner.cookie })).status).toBe(200);
    const token = await (await callApp(app, 'POST', '/profile/tokens', {
      cookie: owner.cookie,
      body: { name: 'agent', scope: 'write' },
    })).json<{ token: string }>();
    armVapid();
    const pat = await callApp(app, 'POST', '/profile/push-subscriptions', {
      headers: { authorization: `Bearer ${token.token}` },
      body: { endpoint: 'https://fcm.googleapis.com/fcm/send/pat', keys },
    });
    expect(pat.status).toBe(401);
    expect(await db.select().from(pushSubscriptions)).toHaveLength(0);
  });

  test('a failed receipt records only the push service class', async () => {
    const cases = [
      ['https://fcm.googleapis.com/fcm/send/FCMSECRETPATH', 'fcm'],
      ['https://updates.push.services.mozilla.com/wpush/v2/MOZSECRETPATH', 'mozilla'],
      ['https://web.push.apple.com/APPLESECRETPATH', 'apple'],
      ['https://wns2-pn1.notify.windows.com/w/?token=OTHERSECRETPATH', 'other'],
    ] as const;
    armVapid();
    const now = new Date('2026-04-02T09:15:00.000Z');
    for (const [endpoint, service] of cases) {
      const owner = await account();
      await seedBasicCard(app, owner.cookie, { deckId: owner.deckId, front: 'Q', back: 'A' });
      await alignDue(owner.userId, now);
      expect((await save(owner.cookie, {
        ...choice, emailEnabled: false, pushEnabled: true, timeZone: 'UTC', digestHour: now.getUTCHours(),
      })).status).toBe(200);
      expect((await subscribe(owner.cookie, endpoint)).status).toBe(200);
      await runReminderTick({
        now,
        email: null,
        push: { configured: () => true, deliver: async () => ({ ok: false, code: 'push_failed', statusCode: 500 }) },
      });
      const [receipt] = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.userId, owner.userId));
      expect(receipt).toMatchObject({ status: 'failed', errorCode: 'push_failed', pushService: service });
      expect(JSON.stringify(receipt)).not.toContain(endpoint.split('/').pop());
    }
  });
});
