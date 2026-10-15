import { defineConfig } from 'drizzle-kit';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveDrizzleDatabaseUrl } from './src/drizzle-url.ts';

// drizzle-kit spawns a Node subprocess and doesn't inherit Bun's auto-loaded
// env. Walk up from packages/db and load the root .env manually. Existing
// process env wins, so a push script can force TEST_DATABASE_URL.
function loadRootEnv() {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) {
      const content = readFileSync(candidate, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq < 0) continue;
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
        if (!process.env[key]) process.env[key] = val;
      }
      return;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
}
loadRootEnv();

// Push never reads DATABASE_URL. Studio and generate keep the non-test URL.
const connectionUrl = resolveDrizzleDatabaseUrl(process.env, process.argv);

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './src/migrations',
  dbCredentials: { url: connectionUrl },
  strict: true,
  verbose: true,
});
