import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
