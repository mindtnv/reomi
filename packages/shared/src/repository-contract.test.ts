import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '../../..');

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('repository contracts', () => {
  test('local tests apply migrations and CI bypasses that lifecycle hook', () => {
    const packageJson = JSON.parse(readRepoFile('package.json')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts.test).toBe('NODE_ENV=test bun --env-file=./.env test');
    expect(packageJson.scripts.pretest).toBe('bun run db:migrate:apply:test');
    expect(packageJson.scripts['test:ci']).toBe(
      'NODE_ENV=test bun --env-file=./.env test',
    );
    expect(packageJson.scripts['pretest:ci']).toBeUndefined();
    expect(packageJson.scripts.pretest).not.toContain('db:push');
  });

  test('schema push never selects DATABASE_URL', () => {
    const dbPackage = JSON.parse(readRepoFile('packages/db/package.json')) as {
      scripts: Record<string, string>;
    };
    for (const name of ['predb:push', 'db:push', 'predb:push:test', 'db:push:test']) {
      const script = dbPackage.scripts[name];
      expect(script, name).not.toContain('DATABASE_URL');
      expect(script, name).toContain('NODE_ENV=test');
    }
    expect(dbPackage.scripts['db:push']).toContain('DRIZZLE_COMMAND=push');
    expect(dbPackage.scripts['db:push:test']).toContain('DRIZZLE_COMMAND=push');
    expect(dbPackage.scripts['db:push']).toContain('drizzle-kit push --force');
    expect(dbPackage.scripts['db:migrate:apply:test']).toContain('src/migrate.ts');

    const config = readRepoFile('packages/db/drizzle.config.ts');
    expect(config).toContain('resolveDrizzleDatabaseUrl(process.env, process.argv)');
    expect(config).not.toContain('process.env.DATABASE_URL');
    expect(config).not.toContain("process.env['DATABASE_URL']");

    const resolver = readRepoFile('packages/db/src/drizzle-url.ts');
    expect(resolver).toContain("env['TEST_DATABASE_URL']");
    expect(resolver).toContain('schema push refuses DATABASE_URL');
    expect(resolver).toContain("env['DRIZZLE_COMMAND'] === 'push' || argv.includes('push')");
  });

  test('push warning tracks the migration chain head and the SQL push drops', () => {
    const journal = JSON.parse(
      readRepoFile('packages/db/src/migrations/meta/_journal.json'),
    ) as { entries: Array<{ tag: string }> };
    const head = journal.entries.at(-1)?.tag;
    expect(head).toBe('0039_daily_ken_ellis');

    const backfill = readRepoFile('packages/db/src/migrations/0020_known_klaw.sql');
    const insertAt = backfill.indexOf('INSERT INTO "notebook_sources"');
    const dropAt = backfill.indexOf('DROP COLUMN "notebook_id"');
    expect(insertAt).toBeGreaterThan(-1);
    expect(dropAt).toBeGreaterThan(insertAt);
    expect(backfill).toContain('UPDATE "kb_chunk" SET "parent_id" = "source_id"');

    expect(readRepoFile('packages/db/src/migrations/0027_dazzling_madame_masque.sql')).toContain(
      'UNIQUE NULLS NOT DISTINCT("note_id","template_ord","cloze_number")',
    );
    const triggers = readRepoFile('packages/db/src/migrations/0038_fancy_yellowjacket.sql');
    for (const name of [
      'sources_metadata_revision',
      'notebook_notes_metadata_revision',
      'notebooks_metadata_revision',
      'decks_metadata_revision',
      'decks_hierarchy_revision',
    ]) {
      expect(triggers).toContain(`CREATE TRIGGER ${name}`);
    }

    for (const guide of ['CLAUDE.md', 'AGENTS.md']) {
      const text = readRepoFile(guide);
      expect(text, guide).toContain('0039_daily_ken_ellis.sql');
      expect(text, guide).toContain('0020_known_klaw.sql');
      expect(text, guide).toContain('0027_dazzling_madame_masque.sql');
      expect(text, guide).toContain('0038_fancy_yellowjacket.sql');
      expect(text, guide).not.toContain('still use `db:push --force` for speed');
      expect(text, guide).not.toContain('Tests run on `db:push:test`');
    }
  });

  test('migration-gated workflows use the CI test path and validate OpenSpec', () => {
    for (const path of ['.github/workflows/ci.yml', '.github/workflows/deploy.yml']) {
      const workflow = readRepoFile(path);
      const migrateAt = workflow.indexOf('run: bun run db:migrate:apply:test');
      const testAt = workflow.indexOf('run: bun run test:ci');

      expect(migrateAt, `${path} must apply migrations`).toBeGreaterThan(-1);
      expect(testAt, `${path} must use test:ci`).toBeGreaterThan(migrateAt);
      expect(workflow).not.toMatch(/^\s*run:\s*bun run test\s*$/m);
      expect(workflow).toContain('run: bun run spec:validate');
    }
  });

  test('CI hard-gates real S3 round trips against pinned disposable MinIO', () => {
    const packageJson = JSON.parse(readRepoFile('package.json')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['test:s3:ci']).toContain(
      'S3_INTEGRATION_REQUIRED=true',
    );

    const compose = readRepoFile('docker-compose.yml');
    expect(compose).toContain(
      'docker.io/pgsty/silo:RELEASE.2026-09-16T00-00-00Z@sha256:635197cb9f36d01bee221d34d1c7d7960f6a95c48b0b6c01d99cd13bdae51a46',
    );
    expect(compose).toContain(
      'docker.io/pgsty/mc:RELEASE.2026-09-16T00-00-00Z@sha256:cfc83108c3abb371f8fb84d99c1fdc88f8c237e022409b0081fb7c0a3be634dd',
    );
    expect(compose).not.toContain('quay.io/minio/');

    for (const path of ['.github/workflows/ci.yml', '.github/workflows/deploy.yml']) {
      const workflow = readRepoFile(path);
      expect(workflow).toContain('s3-integration:');
      expect(workflow).toContain('docker compose up -d --wait minio');
      expect(workflow).toContain('docker compose run --rm --no-deps createbuckets');
      expect(workflow).toContain('run: bun run test:s3:ci');
    }

    expect(readRepoFile('.github/workflows/deploy.yml')).toContain(
      'needs: [test, s3-integration, build-api, build-web]',
    );
  });
  test('deployment stops the old API writer before migration-bearing replacement', () => {
    const workflow = readRepoFile('.github/workflows/deploy.yml');
    const stop = workflow.indexOf('$COOLIFY_URL/applications/$API_APP_UUID/stop');
    const deploy = workflow.indexOf('$COOLIFY_URL/deploy?uuid=$uuid');
    expect(stop).toBeGreaterThan(-1);
    expect(deploy).toBeGreaterThan(stop);
    expect(workflow).toContain('old API did not stop');
    expect(workflow).toContain('-X POST "$COOLIFY_URL/applications/$API_APP_UUID/stop?docker_cleanup=false"');
  });

});
