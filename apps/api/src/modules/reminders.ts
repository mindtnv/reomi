import { Elysia, t } from 'elysia';
import { and, count, eq, isNull } from 'drizzle-orm';
import { db, notificationSettings, pushSubscriptions } from '@reomi/db';
import { authPlugin } from '../auth-plugin.ts';
import { env } from '../env.ts';
import { isValidTimeZone } from '../reminders/copy.ts';
import { pushConfigured, pushEndpointAllowed } from '../reminders/web-push.ts';

const MAX_ACTIVE_PUSH = 10;
const choiceBody = t.Object({
  digestEnabled: t.Boolean(),
  streakWarningEnabled: t.Boolean(),
  timeZone: t.String({ minLength: 1, maxLength: 100 }),
  digestHour: t.Integer({ minimum: 0, maximum: 23 }),
  streakHour: t.Integer({ minimum: 0, maximum: 23 }),
  emailEnabled: t.Boolean(),
  pushEnabled: t.Boolean(),
  locale: t.Union([t.Literal('ru'), t.Literal('en')]),
});

function publicSettings(row: typeof notificationSettings.$inferSelect | undefined) {
  return {
    saved: Boolean(row),
    digestEnabled: row?.digestEnabled ?? false,
    streakWarningEnabled: row?.streakWarningEnabled ?? false,
    timeZone: row?.timeZone ?? null,
    digestHour: row?.digestHour ?? null,
    streakHour: row?.streakHour ?? null,
    emailEnabled: row?.emailEnabled ?? false,
    pushEnabled: row?.pushEnabled ?? false,
    locale: row?.locale ?? null,
    updatedAt: row?.updatedAt.toISOString() ?? null,
    vapidPublicKey: env.VAPID_PUBLIC_KEY ?? null,
  };
}

function clipUserAgent(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 160);
  return cleaned || null;
}

export const remindersModule = new Elysia({ prefix: '/profile' })
  .use(authPlugin)
  .get('/reminders', async ({ user }) => {
    const [row] = await db.select().from(notificationSettings).where(eq(notificationSettings.userId, user.id));
    return publicSettings(row);
  }, { auth: true })
  .put('/reminders', async ({ user, body, status }) => {
    if (!isValidTimeZone(body.timeZone)) return status(400, { error: 'invalid_timezone' });
    const values = {
      userId: user.id,
      digestEnabled: body.digestEnabled,
      streakWarningEnabled: body.streakWarningEnabled,
      timeZone: body.timeZone,
      digestHour: body.digestHour,
      streakHour: body.streakHour,
      emailEnabled: body.emailEnabled,
      pushEnabled: body.pushEnabled,
      locale: body.locale,
      updatedAt: new Date(),
    };
    await db.insert(notificationSettings).values(values).onConflictDoUpdate({
      target: notificationSettings.userId,
      set: values,
    });
    const [row] = await db.select().from(notificationSettings).where(eq(notificationSettings.userId, user.id));
    return publicSettings(row);
  }, { auth: true, body: choiceBody })
  .get('/push-subscriptions', async ({ user }) => {
    const rows = await db.select({
      id: pushSubscriptions.id,
      createdAt: pushSubscriptions.createdAt,
      disabledAt: pushSubscriptions.disabledAt,
    }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, user.id));
    return {
      items: rows.map((row) => ({
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        disabled: row.disabledAt != null,
      })),
    };
  }, { auth: true })
  .post('/push-subscriptions', async ({ user, body, request, status }) => {
    if (!pushConfigured()) return status(503, { error: 'push_disabled' });
    if (!pushEndpointAllowed(body.endpoint)) return status(400, { error: 'invalid_endpoint' });
    const expiration = body.expirationTime == null ? null : new Date(body.expirationTime);
    if (expiration && Number.isNaN(expiration.getTime())) return status(400, { error: 'invalid_endpoint' });
    const userAgent = clipUserAgent(request.headers.get('user-agent'));
    const saved = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(pushSubscriptions).where(and(
        eq(pushSubscriptions.userId, user.id),
        eq(pushSubscriptions.endpoint, body.endpoint),
      ));
      const [active] = await tx.select({ n: count() }).from(pushSubscriptions).where(and(
        eq(pushSubscriptions.userId, user.id),
        isNull(pushSubscriptions.disabledAt),
      ));
      const activeCount = active?.n ?? 0;
      if (existing) {
        if (existing.disabledAt && activeCount >= MAX_ACTIVE_PUSH) return null;
        const [row] = await tx.update(pushSubscriptions).set({
          p256dh: body.keys.p256dh,
          auth: body.keys.auth,
          expiration,
          userAgent,
          disabledAt: null,
          failureCount: 0,
        }).where(eq(pushSubscriptions.id, existing.id)).returning({ id: pushSubscriptions.id });
        return row ?? null;
      }
      if (activeCount >= MAX_ACTIVE_PUSH) return null;
      const [row] = await tx.insert(pushSubscriptions).values({
        userId: user.id,
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        expiration,
        userAgent,
      }).returning({ id: pushSubscriptions.id });
      return row ?? null;
    });
    if (!saved) return status(409, { error: 'too_many_subscriptions' });
    return { id: saved.id };
  }, {
    auth: true,
    body: t.Object({
      endpoint: t.String({ minLength: 8, maxLength: 2000 }),
      keys: t.Object({
        p256dh: t.String({ minLength: 1, maxLength: 200 }),
        auth: t.String({ minLength: 1, maxLength: 200 }),
      }),
      expirationTime: t.Optional(t.Union([t.Number(), t.Null()])),
    }),
  })
  .delete('/push-subscriptions/:id', async ({ user, params, status }) => {
    const [row] = await db.delete(pushSubscriptions).where(and(
      eq(pushSubscriptions.userId, user.id),
      eq(pushSubscriptions.id, params.id),
    )).returning({ id: pushSubscriptions.id });
    if (!row) return status(404, { error: 'not_found' });
    return { ok: true };
  }, { auth: true, params: t.Object({ id: t.String({ format: 'uuid' }) }) });
