// Programmatic migrator. Applies src/migrations to TEST_DATABASE_URL when
// NODE_ENV=test, otherwise DATABASE_URL. Invoked from:
//   - Local `bun run test` pretest and CI: `db:migrate:apply:test`
//   - Dev/prod: `db:migrate:apply` and the API image entrypoint
//
// `drizzle-kit push` is not this path. Push targets TEST_DATABASE_URL only and
// cannot replay ordered backfills, partial constraints, or triggers.

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { getDatabaseUrl } from './env.ts';

async function main() {
  const url = getDatabaseUrl();
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);

  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(here, 'migrations');

  // eslint-disable-next-line no-console
  console.log(`[db] applying migrations from ${migrationsFolder}`);
  await migrate(db, { migrationsFolder });
  // eslint-disable-next-line no-console
  console.log('[db] migrations applied');

  await client.end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[db] migration failed', err);
  process.exit(1);
});
