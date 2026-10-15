import { and, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import {
  db,
  notificationDeliveries,
  notificationSettings,
  profile,
  pushSubscriptions,
  reviews,
  user,
} from '@reomi/db';
import { sendEmail } from '@reomi/auth/server';
import { todayISO } from '@reomi/shared';
import { env } from '../env.ts';
import { rootLogger } from '../logger.ts';
import { isRuntimeShuttingDown, reminderWorkerState } from '../runtime-state.ts';
import { loadStudyOverview } from '../modules/study-summary.ts';
import { digestCopy, localHour, streakCopy, type ReminderLocale } from './copy.ts';
import {
  buildPushPayload,
  classifyPushService,
  deliverWebPush,
  pushConfigured,
  type PushDelivery,
  type PushService,
} from './web-push.ts';

const RESERVE_MS = 2 * 60 * 1000;
const UNCONFIGURED_MS = 15 * 60 * 1000;

export interface ReminderEmail {
  send(input: { to: string; subject: string; text: string }): Promise<void>;
}

export interface ReminderPush {
  configured(): boolean;
  deliver(
    subscription: { endpoint: string; p256dh: string; auth: string },
    payload: string,
  ): Promise<PushDelivery>;
}

export interface ReminderTickOptions {
  now?: Date;
  email?: ReminderEmail | null;
  push?: ReminderPush;
}

function reviewUrl(): string {
  return `${env.WEB_ORIGIN.replace(/\/$/, '')}/review`;
}

function defaultEmail(): ReminderEmail | null {
  if (!process.env.RESEND_API_KEY?.trim()) return null;
  return {
    async send(input) {
      await sendEmail({ ...input, tag: 'notification' });
    },
  };
}

function defaultPush(): ReminderPush {
  return { configured: pushConfigured, deliver: deliverWebPush };
}

async function claimSlot(
  userId: string,
  kind: 'due_digest' | 'streak_warning',
  channel: 'web_push' | 'email',
  studyDay: string,
  now: Date,
): Promise<string | null> {
  if (isRuntimeShuttingDown()) return null;
  const leaseUntil = new Date(now.getTime() + RESERVE_MS);
  const inserted = await db.insert(notificationDeliveries).values({
    userId, kind, channel, studyDay, status: 'reserved', leaseUntil,
  }).onConflictDoNothing({
    target: [
      notificationDeliveries.userId,
      notificationDeliveries.kind,
      notificationDeliveries.channel,
      notificationDeliveries.studyDay,
    ],
  }).returning({ id: notificationDeliveries.id });
  if (inserted[0]) return inserted[0].id;

  const [row] = await db.select().from(notificationDeliveries).where(and(
    eq(notificationDeliveries.userId, userId),
    eq(notificationDeliveries.kind, kind),
    eq(notificationDeliveries.channel, channel),
    eq(notificationDeliveries.studyDay, studyDay),
  ));
  if (!row?.leaseUntil || row.leaseUntil.getTime() >= now.getTime()) return null;
  if (row.status === 'sent' || row.status === 'skipped') return null;

  const crashRetry = row.status === 'reserved' && row.errorCode == null;
  const configRetry = row.errorCode === 'email_unconfigured' || row.errorCode === 'push_disabled';
  if (!crashRetry && !configRetry) return null;

  const nextError = crashRetry ? 'retried' : null;
  const reclaimed = await db.update(notificationDeliveries).set({
    status: 'reserved',
    errorCode: nextError,
    leaseUntil,
    pushService: null,
  }).where(and(
    eq(notificationDeliveries.id, row.id),
    lt(notificationDeliveries.leaseUntil, now),
    eq(notificationDeliveries.status, row.status),
    row.errorCode == null
      ? isNull(notificationDeliveries.errorCode)
      : eq(notificationDeliveries.errorCode, row.errorCode),
  )).returning({ id: notificationDeliveries.id });
  return reclaimed[0]?.id ?? null;
}

async function finishSlot(
  id: string,
  userId: string,
  kind: string,
  channel: string,
  status: 'sent' | 'skipped' | 'failed',
  errorCode: string | null,
  leaseUntil: Date | null,
  pushService: PushService | null,
): Promise<void> {
  await db.update(notificationDeliveries).set({
    status, errorCode, leaseUntil, pushService,
  }).where(eq(notificationDeliveries.id, id));
  rootLogger.info({
    event: 'reminder.slot',
    userId,
    kind,
    channel,
    status,
    code: errorCode,
    pushService,
  }, 'reminder.slot');
}

async function reviewedToday(userId: string, now: Date): Promise<boolean> {
  const day = todayISO(now);
  const start = new Date(`${day}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 86_400_000);
  const [hit] = await db.select({ id: reviews.id }).from(reviews).where(and(
    eq(reviews.userId, userId),
    gte(reviews.reviewedAt, start),
    lt(reviews.reviewedAt, end),
  )).limit(1);
  return Boolean(hit);
}

async function deliverEmailSlot(
  id: string,
  userId: string,
  kind: 'due_digest' | 'streak_warning',
  to: string,
  copy: { subject: string; text: string },
  email: ReminderEmail | null,
  now: Date,
): Promise<void> {
  if (!email) {
    await finishSlot(id, userId, kind, 'email', 'failed', 'email_unconfigured', new Date(now.getTime() + UNCONFIGURED_MS), null);
    return;
  }
  try {
    await email.send({ to, subject: copy.subject, text: copy.text });
    await finishSlot(id, userId, kind, 'email', 'sent', null, null, null);
  } catch {
    await finishSlot(id, userId, kind, 'email', 'failed', 'email_failed', null, null);
  }
}

async function deliverPushSlot(
  id: string,
  userId: string,
  kind: 'due_digest' | 'streak_warning',
  copy: { subject: string; text: string },
  badge: number,
  push: ReminderPush,
  now: Date,
): Promise<void> {
  if (!push.configured()) {
    await finishSlot(id, userId, kind, 'web_push', 'failed', 'push_disabled', new Date(now.getTime() + UNCONFIGURED_MS), null);
    return;
  }
  const subs = await db.select().from(pushSubscriptions).where(and(
    eq(pushSubscriptions.userId, userId),
    isNull(pushSubscriptions.disabledAt),
  ));
  if (subs.length === 0) {
    await finishSlot(id, userId, kind, 'web_push', 'skipped', 'no_subscription', null, null);
    return;
  }
  const payload = buildPushPayload({ title: copy.subject, body: copy.text, badge, kind });
  let sent = 0;
  let gone = 0;
  let failed = 0;
  let service: PushService | null = null;
  for (const sub of subs) {
    service = classifyPushService(sub.endpoint);
    const result = await push.deliver(
      { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
      payload,
    );
    if (result.ok) {
      sent += 1;
      continue;
    }
    if (result.code === 'push_disabled') {
      await finishSlot(id, userId, kind, 'web_push', 'failed', 'push_disabled', new Date(now.getTime() + UNCONFIGURED_MS), null);
      return;
    }
    if (result.code === 'gone') {
      gone += 1;
      await db.update(pushSubscriptions).set({
        disabledAt: now,
        failureCount: sql`${pushSubscriptions.failureCount} + 1`,
      }).where(eq(pushSubscriptions.id, sub.id));
      continue;
    }
    failed += 1;
  }
  if (sent > 0) {
    await finishSlot(id, userId, kind, 'web_push', 'sent', null, null, service);
    return;
  }
  if (gone > 0 && failed === 0) {
    await finishSlot(id, userId, kind, 'web_push', 'skipped', 'no_subscription', null, service);
    return;
  }
  await finishSlot(id, userId, kind, 'web_push', 'failed', 'push_failed', null, service);
}

async function sendKind(
  settings: typeof notificationSettings.$inferSelect,
  emailAddress: string,
  kind: 'due_digest' | 'streak_warning',
  copy: { subject: string; text: string },
  badge: number,
  now: Date,
  email: ReminderEmail | null,
  push: ReminderPush,
): Promise<void> {
  const studyDay = todayISO(now);
  if (isRuntimeShuttingDown()) return;
  if (settings.emailEnabled) {
    const id = await claimSlot(settings.userId, kind, 'email', studyDay, now);
    if (id) await deliverEmailSlot(id, settings.userId, kind, emailAddress, copy, email, now);
  }
  if (isRuntimeShuttingDown()) return;
  if (settings.pushEnabled) {
    const id = await claimSlot(settings.userId, kind, 'web_push', studyDay, now);
    if (id) await deliverPushSlot(id, settings.userId, kind, copy, badge, push, now);
  }
}

async function processUser(
  settings: typeof notificationSettings.$inferSelect,
  emailAddress: string,
  streakDays: number,
  streakFreezes: number,
  now: Date,
  email: ReminderEmail | null,
  push: ReminderPush,
): Promise<void> {
  let hour: number;
  try {
    hour = localHour(now, settings.timeZone);
  } catch {
    reminderWorkerState.recordFailure('invalid_timezone');
    return;
  }
  const locale: ReminderLocale = settings.locale === 'ru' ? 'ru' : 'en';
  const link = reviewUrl();
  if (settings.digestEnabled && hour === settings.digestHour) {
    const overview = await loadStudyOverview(settings.userId, now);
    if (overview.overall.totalAvailable > 0) {
      const copy = digestCopy(locale, overview.overall.totalAvailable, link);
      await sendKind(settings, emailAddress, 'due_digest', copy, overview.overall.totalAvailable, now, email, push);
    }
  }
  if (isRuntimeShuttingDown()) return;
  if (settings.streakWarningEnabled && hour === settings.streakHour && streakDays > 0) {
    if (await reviewedToday(settings.userId, now)) return;
    const copy = streakCopy(locale, streakDays, streakFreezes, link);
    await sendKind(settings, emailAddress, 'streak_warning', copy, streakDays, now, email, push);
  }
}

export async function runReminderTick(options: ReminderTickOptions = {}): Promise<void> {
  if (isRuntimeShuttingDown()) return;
  const now = options.now ?? new Date();
  const email = options.email === undefined ? defaultEmail() : options.email;
  const push = options.push ?? defaultPush();
  reminderWorkerState.start();
  try {
    const rows = await db.select({
      settings: notificationSettings,
      email: user.email,
      streakDays: profile.streakDays,
      streakFreezes: profile.streakFreezes,
    }).from(notificationSettings)
      .innerJoin(user, eq(user.id, notificationSettings.userId))
      .leftJoin(profile, eq(profile.userId, notificationSettings.userId));
    for (const row of rows) {
      if (isRuntimeShuttingDown()) return;
      try {
        await processUser(
          row.settings,
          row.email,
          row.streakDays ?? 0,
          row.streakFreezes ?? 0,
          now,
          email,
          push,
        );
      } catch {
        reminderWorkerState.recordFailure('reminder_user_failed');
      }
    }
  } finally {
    reminderWorkerState.complete();
  }
}
