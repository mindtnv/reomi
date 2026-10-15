// pgvector bootstrap. `CREATE EXTENSION vector` is PER-DATABASE. Migration
// `0010` creates it, and an explicit schema push still needs it first because
// push does not run that migration. This helper opens its OWN short-lived
// connection (not the shared pool) so the `predb:push` / `predb:push:test`
// scripts can run it before push. Those scripts set NODE_ENV=test, so the
// default URL is TEST_DATABASE_URL and they do not open DATABASE_URL.

import postgres from 'postgres';
import { getDatabaseUrl } from './env.ts';

/**
 * Ensure the pgvector `vector` extension exists on the target database.
 * Idempotent (`IF NOT EXISTS`). Defaults to the env-selected DB
 * (`getDatabaseUrl()` → TEST_DATABASE_URL when NODE_ENV=test, else
 * DATABASE_URL), but a `url` override lets callers target a specific DB.
 */
export async function ensureVectorExtension(url?: string): Promise<void> {
  const target = url ?? getDatabaseUrl();
  const client = postgres(target, { max: 1 });
  try {
    await client`CREATE EXTENSION IF NOT EXISTS vector`;
  } finally {
    await client.end({ timeout: 5 });
  }
}
