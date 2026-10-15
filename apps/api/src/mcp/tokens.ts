import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, isNull, or, lt } from 'drizzle-orm';
import { db, personalAccessTokens, user } from '@reomi/db';

export const tokenMetadata = {
  id: personalAccessTokens.id, name: personalAccessTokens.name, prefix: personalAccessTokens.prefix,
  scope: personalAccessTokens.scope, createdAt: personalAccessTokens.createdAt,
  expiresAt: personalAccessTokens.expiresAt, lastUsedAt: personalAccessTokens.lastUsedAt,
  revokedAt: personalAccessTokens.revokedAt,
};

export function newPersonalToken() {
  const token = `nn_pat_${randomBytes(32).toString('base64url')}`;
  return { token, tokenHash: hashToken(token), prefix: token.slice(0, 15) };
}

function hashToken(token: string) { return createHash('sha256').update(token).digest('hex'); }

export async function authenticateToken(request: Request) {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer (nn_pat_[A-Za-z0-9_-]{43})$/i.exec(header);
  if (!match) return null;
  const now = new Date();
  const [row] = await db.select({ token: personalAccessTokens, user }).from(personalAccessTokens)
    .innerJoin(user, eq(user.id, personalAccessTokens.userId))
    .where(and(eq(personalAccessTokens.tokenHash, hashToken(match[1]!)),
      isNull(personalAccessTokens.revokedAt), gt(personalAccessTokens.expiresAt, now))).limit(1);
  if (!row) return null;
  // Coalesce writes to at most once per minute for each credential.
  await db.update(personalAccessTokens).set({ lastUsedAt: now })
    .where(and(eq(personalAccessTokens.id, row.token.id),
      or(isNull(personalAccessTokens.lastUsedAt), lt(personalAccessTokens.lastUsedAt, new Date(now.getTime() - 60_000)))));
  return { user: row.user, tokenId: row.token.id, scope: row.token.scope };
}

export type McpPrincipal = NonNullable<Awaited<ReturnType<typeof authenticateToken>>>;
