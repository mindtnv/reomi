import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

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
    expect(head).toBe('0045_card_holds');
    expect(journal.entries.some((row) => row.tag === '0044_study_day')).toBe(true);
    expect(journal.entries.some((row) => row.tag === '0042_youtube_source')).toBe(true);
    expect(journal.entries.some((row) => row.tag === '0043_topic_plan')).toBe(true);

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
    expect(compose).toContain('mc anonymous set none');
    expect(compose).not.toContain('mc anonymous set download');

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

  test('deploy publishes reomi images and keeps the Coolify application ids', () => {
    const workflow = readRepoFile('.github/workflows/deploy.yml');
    for (const name of ['reomi-api', 'reomi-web']) {
      expect(workflow).toContain(`ghcr.io/\${{ github.repository_owner }}/${name}:\${{ github.sha }}`);
      expect(workflow).toContain(`ghcr.io/\${{ github.repository_owner }}/${name}:latest`);
    }
    expect(workflow).not.toContain('neuronexus-api');
    expect(workflow).not.toContain('neuronexus-web');
    expect(workflow).toContain('API_APP_UUID: u6kweu7gzzw9kidpuq7i0n7y');
    expect(workflow).toContain('WEB_APP_UUID: tmc5k98iayyj0g28qr7inbaj');
    expect(workflow.indexOf('reomi-api:${{ github.sha }}')).toBeLessThan(
      workflow.indexOf('reomi-web:${{ github.sha }}'),
    );
    expect(workflow).toContain('"neuronexus" in name or "reomi" in name');
    const apiStop = workflow.indexOf('applications/$API_APP_UUID/stop');
    const webUuidLoop = workflow.indexOf('for uuid in "$API_APP_UUID" "$WEB_APP_UUID"');
    expect(webUuidLoop).toBeGreaterThan(apiStop);
  });

  test('browser smoke follows a pull request locally and a finished deploy in production', () => {
    const packageJson = JSON.parse(readRepoFile('package.json')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts.e2e).toBe('bash scripts/verify-reomi.sh');
    expect(packageJson.scripts['e2e:prod']).toBe('E2E_TARGET=prod bash scripts/verify-reomi.sh');

    const ci = readRepoFile('.github/workflows/ci.yml');
    expect(ci).toMatch(/^ {8}run: bun run e2e$/m);
    expect(ci).toContain('path: e2e/artifacts/*.png');
    expect(ci).not.toContain('test-results');
    expect(ci).not.toContain('playwright-report');

    const playwright = readRepoFile('playwright.config.ts');
    expect(playwright).toContain("trace: 'off'");
    expect(playwright).toContain('PLAYWRIGHT_NO_COPY_PROMPT');
    expect(readRepoFile('scripts/verify-reomi.sh')).toContain('bun e2e/secret-scan-cli.ts');
    expect(readRepoFile('e2e/smoke.e2e.ts')).toContain('clearPasswordFields');

    const deploy = readRepoFile('.github/workflows/deploy.yml');
    expect(deploy).toMatch(/^name: deploy$/m);
    expect(deploy).toContain('group: deploy-main');
    expect(deploy).toContain('cancel-in-progress: false');
    expect(deploy).not.toContain('e2e-prod');
    expect(deploy).not.toContain('bun run e2e:prod');

    const smoke = readRepoFile('.github/workflows/e2e-prod.yml');
    expect(smoke).toContain('workflows: [deploy]');
    expect(smoke).toContain('types: [completed]');
    expect(smoke).toContain('branches: [main]');
    expect(smoke).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(smoke).toContain('group: e2e-prod');
    expect(smoke).toContain('cancel-in-progress: true');
    expect(smoke).toContain('ref: ${{ github.event.workflow_run.head_sha }}');
    expect(smoke).toMatch(/^ {8}run: bun run e2e:prod$/m);
    expect(smoke).toContain('::add-mask::');
    expect(smoke).not.toContain('upload-artifact');
    expect(smoke).not.toContain('deploy-main');
    expect(smoke).not.toContain('COOLIFY');
    expect(smoke).not.toContain('docker_registry_image_tag');
    expect(smoke).not.toContain('CHAT_BASE_URL');

    const shell = readRepoFile('scripts/verify-reomi.sh');
    const warningAt = shell.indexOf(
      '::warning::E2E_EMAIL or E2E_PASSWORD is unset. Skipping production smoke.',
    );
    expect(warningAt).toBeGreaterThan(-1);
    expect(shell.slice(warningAt, warningAt + 160)).toContain('exit 0');

    const assistantE2e = readRepoFile('e2e/assistant-settings.e2e.ts');
    expect(assistantE2e).toContain('CHAT_API_KEY unset; skipping live assistant assertion');
    expect(assistantE2e).not.toContain('CHAT_BASE_URL');

    const phrases = [
      'chat, and settings',
      'cookie-authenticated GET /ai/chat-probe',
      'expects the Notifications heading',
      'attention or unavailable state',
      'when chat is disabled',
      'installed or standalone PWA',
      'Display-mode emulation counts',
      'request for changes',
    ];
    for (const guide of ['CLAUDE.md', 'AGENTS.md']) {
      const text = readRepoFile(guide);
      expect(text, guide).toContain('.cursor/skills/verify-reomi/SKILL.md');
      expect(text, guide).toContain('bun run e2e');
    }
    for (const guide of ['CLAUDE.md', 'AGENTS.md', '.cursor/skills/verify-reomi/SKILL.md']) {
      const text = readRepoFile(guide);
      for (const phrase of phrases) expect(text, `${guide} missing ${phrase}`).toContain(phrase);
    }
  });

  test('production visual audit is dispatched only on the default branch', () => {
    const audit = readRepoFile('.github/workflows/visual-audit.yml');
    expect(audit).toContain('workflow_dispatch:');
    expect(audit).not.toContain('pull_request');
    expect(audit).toContain(
      "github.ref == format('refs/heads/{0}', github.event.repository.default_branch)",
    );
    expect(audit).toContain('ref: ${{ github.event.repository.default_branch }}');
    expect(audit).toContain('secrets.E2E_PASSWORD');

    const smoke = readRepoFile('.github/workflows/e2e-prod.yml');
    expect(smoke).toContain('workflows: [deploy]');
    expect(smoke).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(smoke).toContain('ref: ${{ github.event.workflow_run.head_sha }}');
    expect(smoke).not.toContain('pull_request');
    expect(smoke).not.toContain('upload-artifact');
  });

  test('workspace packages are named reomi', () => {
    const root = JSON.parse(readRepoFile('package.json')) as { name: string };
    expect(root.name).toBe('reomi');
    const expected = {
      'packages/shared/package.json': '@reomi/shared',
      'packages/db/package.json': '@reomi/db',
      'packages/auth/package.json': '@reomi/auth',
      'apps/api/package.json': '@reomi/api',
      'apps/web/package.json': '@reomi/web',
    } as const;
    for (const [path, name] of Object.entries(expected)) {
      const pkg = JSON.parse(readRepoFile(path)) as { name: string };
      expect(pkg.name, path).toBe(name);
    }
    expect(readRepoFile('apps/web/next.config.ts')).toContain(
      "transpilePackages: ['@reomi/auth', '@reomi/shared', '@reomi/api']",
    );
    expect(readRepoFile('apps/api/src/logger.ts')).toContain("app: 'neuronexus-api'");
    expect(readRepoFile('bun.lock')).toMatch(/"workspaces":\s*\{\s*"":\s*\{\s*"name":\s*"reomi"/);
  });

  test('imports no longer use the old package scope', () => {
    const allowed = new Set(['packages/db/src/migrations/0007_builtin_note_types.sql']);
    const hits: string[] = [];
    const skip = new Set(['.git', 'node_modules', '.next', 'dist']);
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (skip.has(entry)) continue;
        const path = join(dir, entry);
        const rel = relative(repoRoot, path);
        if (rel.startsWith('openspec/changes') || rel === 'packages/shared/src/repository-contract.test.ts') continue;
        const stat = statSync(path);
        if (stat.isDirectory()) {
          walk(path);
          continue;
        }
        if (!stat.isFile() || stat.size > 2_000_000) continue;
        const text = readFileSync(path, 'utf8');
        if (text.includes('@neuronexus/') && !allowed.has(rel)) hits.push(rel);
      }
    };
    walk(repoRoot);
    expect(hits).toEqual([]);
    expect(readRepoFile('packages/db/src/migrations/0007_builtin_note_types.sql')).toContain('@neuronexus/shared');
  });

  test('card hold writes stay in card-holds.ts', () => {
    const hits: string[] = [];
    const skip = new Set(['.git', 'node_modules', '.next', 'dist']);
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (skip.has(entry)) continue;
        const path = join(dir, entry);
        const rel = relative(repoRoot, path);
        const stat = statSync(path);
        if (stat.isDirectory()) {
          walk(path);
          continue;
        }
        if (!stat.isFile() || !/\.(ts|tsx|sql)$/.test(entry) || stat.size > 2_000_000) continue;
        const text = readFileSync(path, 'utf8');
        if (/(insert|update|delete)\(cardHolds\)/.test(text) && rel !== 'apps/api/src/modules/card-holds.ts') {
          hits.push(rel);
        }
      }
    };
    walk(repoRoot);
    expect(hits).toEqual([]);
  });

});
