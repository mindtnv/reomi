import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '../../..');

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

describe('repository contracts', () => {
  test('CI test script bypasses the local schema-push lifecycle hook', () => {
    const packageJson = JSON.parse(readRepoFile('package.json')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts.test).toBe('NODE_ENV=test bun --env-file=./.env test');
    expect(packageJson.scripts.pretest).toBe('bun run db:push:test');
    expect(packageJson.scripts['test:ci']).toBe(
      'NODE_ENV=test bun --env-file=./.env test',
    );
    expect(packageJson.scripts['pretest:ci']).toBeUndefined();
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
    expect(compose).toContain('quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z');
    expect(compose).toContain('quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z');

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

  test('deploy publishes both image names and keeps the Coolify application ids', () => {
    const workflow = readRepoFile('.github/workflows/deploy.yml');
    for (const name of ['neuronexus-api', 'neuronexus-web', 'reomi-api', 'reomi-web']) {
      expect(workflow).toContain(`ghcr.io/\${{ github.repository_owner }}/${name}:\${{ github.sha }}`);
      expect(workflow).toContain(`ghcr.io/\${{ github.repository_owner }}/${name}:latest`);
    }
    expect(workflow).toContain('API_APP_UUID: u6kweu7gzzw9kidpuq7i0n7y');
    expect(workflow).toContain('WEB_APP_UUID: tmc5k98iayyj0g28qr7inbaj');
    expect(workflow.indexOf('neuronexus-api:${{ github.sha }}')).toBeLessThan(workflow.indexOf('reomi-web:${{ github.sha }}'));
    expect(workflow).toContain('"neuronexus" in name or "reomi" in name');
    const apiStop = workflow.indexOf('applications/$API_APP_UUID/stop');
    const webUuidLoop = workflow.indexOf('for uuid in "$API_APP_UUID" "$WEB_APP_UUID"');
    expect(webUuidLoop).toBeGreaterThan(apiStop);
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

});
