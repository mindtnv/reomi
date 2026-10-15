// drizzle-kit evaluates this config in its own process. Do not branch the push
// URL on `process.env.NODE_ENV`: kit has historically loaded configs where that
// value is not `test`, which made `db:push:test` open DATABASE_URL. Push always
// uses TEST_DATABASE_URL and refuses to fall back to, or alias, DATABASE_URL.

const PUSH_MISSING_TEST_URL =
  'TEST_DATABASE_URL is not set — schema push refuses DATABASE_URL';
const PUSH_REFUSES_APP_URL =
  'schema push refuses DATABASE_URL — TEST_DATABASE_URL must name a different database';

export function resolveDrizzleDatabaseUrl(
  env: Record<string, string | undefined>,
  argv: readonly string[] = [],
): string {
  const pushing = env['DRIZZLE_COMMAND'] === 'push' || argv.includes('push');
  if (pushing) {
    const testUrl = env['TEST_DATABASE_URL']?.trim();
    if (!testUrl) throw new Error(PUSH_MISSING_TEST_URL);
    const appUrl = env['DATABASE_URL']?.trim();
    if (appUrl && testUrl === appUrl) throw new Error(PUSH_REFUSES_APP_URL);
    return testUrl;
  }

  if (env['NODE_ENV'] === 'test') {
    const testUrl = env['TEST_DATABASE_URL']?.trim();
    if (!testUrl) {
      throw new Error('TEST_DATABASE_URL is not set — add it to .env');
    }
    return testUrl;
  }

  const appUrl = env['DATABASE_URL']?.trim();
  if (!appUrl) {
    throw new Error(
      'DATABASE_URL is not set — copy .env.example to .env in repo root',
    );
  }
  return appUrl;
}
