import { Elysia, t } from 'elysia';
import { and, count, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { db, personalAccessTokens, user as users } from '@reomi/db';
import { authPlugin } from '../auth-plugin.ts';
import { newPersonalToken, tokenMetadata } from '../mcp/tokens.ts';
import { env } from '../env.ts';
import { rateLimitCheck } from '../rate-limit.ts';

export const personalTokensModule = new Elysia({ prefix: '/profile/tokens' })
  .use(authPlugin)
  .onBeforeHandle(({ request, status }) => {
    const origin = request.headers.get('origin');
    if (origin && ![env.WEB_ORIGIN, new URL(env.BETTER_AUTH_URL).origin].includes(origin))
      return status(403, { error: 'untrusted_origin' });
  })
  .onAfterHandle(({ set }) => { set.headers['cache-control'] = 'no-store'; })
  .get('/', ({ user }) => db.select(tokenMetadata).from(personalAccessTokens)
    .where(eq(personalAccessTokens.userId, user.id))
    .orderBy(sql`(${personalAccessTokens.revokedAt} IS NULL AND ${personalAccessTokens.expiresAt} > now()) DESC`, desc(personalAccessTokens.createdAt))
    .limit(100), { auth: true })
  .post('/', async ({ user, body, status }) => {
    if (!rateLimitCheck(user.id, { bucket: 'tokens:create', limit: 20, windowMs: 3_600_000 }).allowed)
      return status(429, { error: 'rate_limited' });
    const name = body.name.trim();
    if (!name) return status(400, { error: 'invalid_name' });
    const result = await db.transaction(async (tx) => {
      await tx.select({ id: users.id }).from(users).where(eq(users.id, user.id)).for('update');
      const [active] = await tx.select({ n: count() }).from(personalAccessTokens)
        .where(and(eq(personalAccessTokens.userId, user.id), isNull(personalAccessTokens.revokedAt), gt(personalAccessTokens.expiresAt, new Date())));
      if (active!.n >= 30) return null;
      const secret = newPersonalToken();
      const [item] = await tx.insert(personalAccessTokens).values({
        userId: user.id, name, tokenHash: secret.tokenHash, prefix: secret.prefix,
        scope: body.scope ?? 'read', expiresAt: new Date(Date.now() + (body.expiresInDays ?? 90) * 86_400_000),
      }).returning(tokenMetadata);
      return { item: item!, token: secret.token };
    });
    return result ?? status(409, { error: 'token_limit' });
  }, { auth: true, body: t.Object({
    name: t.String({ minLength: 1, maxLength: 80 }),
    scope: t.Optional(t.Union([t.Literal('read'), t.Literal('write'), t.Literal('capture')])),
    expiresInDays: t.Optional(t.Integer({ minimum: 1, maximum: 365 })),
  }) })
  .delete('/:id', async ({ user, params, status }) => {
    const [item] = await db.update(personalAccessTokens).set({ revokedAt: new Date() })
      .where(and(eq(personalAccessTokens.userId, user.id), eq(personalAccessTokens.id, params.id))).returning({ id: personalAccessTokens.id });
    return item ? { ok: true } : status(404, { error: 'not_found' });
  }, { auth: true, params: t.Object({ id: t.String({ format: 'uuid' }) }) });
