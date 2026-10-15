// Elysia plugin that:
//   1. mounts BetterAuth's HTTP handler under /api/auth/*
//   2. exposes an `auth: true` macro that resolves { user, session } or 401
//
// Usage:
//   new Elysia()
//     .use(authPlugin)
//     .get('/me', ({ user }) => user, { auth: true })

import { Elysia } from 'elysia';
import { auth } from '@reomi/auth/server';
import { internalReadUser } from './mcp/internal-read.ts';

export const authPlugin = new Elysia({ name: 'better-auth' })
  .mount(auth.handler)
  .macro({
    auth: {
      async resolve({ status, request }) {
        const internal = internalReadUser(request);
        const session = internal ? null : await auth.api.getSession({ headers: request.headers });
        if (!internal && !session) return status(401, { error: 'Unauthorized' });
        return { user: internal ?? session!.user, session: session?.session ?? null };
      },
    },
  });

export { auth };
