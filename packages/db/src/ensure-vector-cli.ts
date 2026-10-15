// CLI entry for the `predb:push` / `predb:push:test` package scripts. Both set
// NODE_ENV=test, so this ensures pgvector on TEST_DATABASE_URL before
// `drizzle-kit push --force` creates the `vector(N)` column. It does not open
// DATABASE_URL. Exits non-zero on failure so a missing extension fails the
// push loudly instead of silently producing a broken schema.

import { ensureVectorExtension } from './ensure-vector.ts';
import { getDatabaseUrl } from './env.ts';

ensureVectorExtension()
  .then(() => {
    // eslint-disable-next-line no-console
    console.log(`[db] pgvector extension ensured on ${getDatabaseUrl().replace(/:\/\/.*@/, '://***@')}`);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[db] ensure-vector failed', err);
    process.exit(1);
  });
