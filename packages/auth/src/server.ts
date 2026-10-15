// BetterAuth server instance. Shared between apps/api (which mounts auth.handler)
// and apps/web (which calls auth.api.getSession() from Server Components / Route
// Handlers when SSR-side session reads are needed).
//
// Keep this file env-light: it reads BETTER_AUTH_SECRET / BETTER_AUTH_URL /
// WEB_ORIGIN at construction time. Both apps must provide them.

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { db } from '@reomi/db/client';
import { newUuidV7 } from '@reomi/shared';
import { __setEmailSinkForTests, sendEmail } from './email.ts';
import { passwordResetMessage } from './password-reset.ts';

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

const trustedOrigins = [process.env.WEB_ORIGIN ?? 'http://localhost:3001'];
const WEB_ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:3001';

export const auth = betterAuth({
  baseURL: requireEnv('BETTER_AUTH_URL'),
  secret: requireEnv('BETTER_AUTH_SECRET'),
  trustedOrigins,
  database: drizzleAdapter(db, { provider: 'pg' }),
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
    requireEmailVerification: false,
    minPasswordLength: 8,
    sendResetPassword: async ({ user, url, token }) => {
      const message = passwordResetMessage({ name: user.name, url, token, webOrigin: WEB_ORIGIN });
      await sendEmail({
        to: user.email,
        subject: message.subject,
        tag: 'password-reset',
        text: message.text,
      });
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    updateAge: 60 * 60 * 24, // refresh token daily
  },
  advanced: {
    database: {
      // Better Auth owns its text PKs, so use the same UUIDv7 contract as the
      // domain schema instead of its default base62 generator.
      generateId: () => newUuidV7(),
    },
    // Different origins for api (:3000) and web (:3001) in dev.
    defaultCookieAttributes: {
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
    },
  },
});

export type Auth = typeof auth;
export type { SendEmailInput } from './email.ts';
export { sendEmail, __setEmailSinkForTests };
