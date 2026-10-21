import { beforeEach, describe, expect, test } from 'bun:test';
import {
  artifactWorkerState,
  documentationWorkerState,
  indexWorkerState,
  markRuntimeRunning,
  markRuntimeShuttingDown,
  reminderWorkerState,
  sourceIngestWorkerState,
} from './runtime-state.ts';

process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/neuronexus_test';
process.env.TEST_DATABASE_URL ??= process.env.DATABASE_URL;
process.env.BETTER_AUTH_URL ??= 'http://localhost:3000';
process.env.BETTER_AUTH_SECRET ??= 'readiness-test-secret-32-bytes';
process.env.S3_ENDPOINT ??= 'http://localhost:9000';
process.env.S3_BUCKET ??= 'test';
process.env.S3_ACCESS_KEY_ID ??= 'test';
process.env.S3_SECRET_ACCESS_KEY ??= 'test-secret';
process.env.S3_PUBLIC_BASE_URL ??= 'http://localhost:9000/test';

const { buildApp } = await import('./app.ts');

async function ready(app: ReturnType<typeof buildApp>) {
  const response = await app.handle(new Request('http://localhost/ready'));
  return { response, body: (await response.json()) as Record<string, any> };
}

describe('runtime readiness', () => {
  beforeEach(() => {
    markRuntimeRunning();
    indexWorkerState.reset();
    sourceIngestWorkerState.reset();
    artifactWorkerState.reset();
    reminderWorkerState.reset();
    documentationWorkerState.reset();
  });

  test('reports ready with idle workers and a reachable database', async () => {
    const app = buildApp({ pingDb: async () => ({ ok: true as const, latencyMs: 3 }) });
    const { response, body } = await ready(app);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      status: 'ready',
      db: { ok: true, latencyMs: 3 },
      lifecycle: { state: 'running' },
      workers: {
        index: { queued: 0, active: 0, degraded: false },
        sourceIngest: { queued: 0, active: 0, degraded: false },
        artifact: { queued: 0, active: 0, degraded: false },
        reminder: { queued: 0, active: 0, degraded: false },
        documentation: { queued: 0, active: 0, degraded: false },
      },
    });
  });

  test('remains ready while workers are busy', async () => {
    indexWorkerState.enqueue(3);
    indexWorkerState.start();
    sourceIngestWorkerState.enqueue();
    const app = buildApp({ pingDb: async () => ({ ok: true as const, latencyMs: 1 }) });
    const { response, body } = await ready(app);

    expect(response.status).toBe(200);
    expect(body.status).toBe('ready');
    expect(body.workers.index).toMatchObject({ queued: 2, active: 1 });
    expect(body.workers.sourceIngest).toMatchObject({ queued: 1, active: 0 });
  });

  test('reports safe recoverable degradation without failing core readiness', async () => {
    artifactWorkerState.recordFailure('generation_failed');
    const app = buildApp({
      pingDb: async () => ({ ok: true as const, latencyMs: 1 }),
      embeddingIsDegraded: () => true,
    });
    const { response, body } = await ready(app);
    const encoded = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body.status).toBe('degraded');
    expect(body.degraded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'embedding_dimension_mismatch' }),
        expect.objectContaining({ code: 'artifact:generation_failed' }),
      ]),
    );
    expect(encoded).not.toContain('DATABASE_URL');
    expect(encoded).not.toContain('userId');
  });

  test('returns not-ready when postgres is unavailable or shutdown started', async () => {
    const dbDown = buildApp({
      pingDb: async () => {
        throw new Error('postgresql://admin:secret@db/private');
      },
    });
    const down = await ready(dbDown);
    expect(down.response.status).toBe(503);
    expect(down.body).toMatchObject({
      ok: false,
      status: 'not_ready',
      db: { ok: false, error: 'unavailable' },
    });
    expect(JSON.stringify(down.body)).not.toContain('secret');

    markRuntimeShuttingDown('SIGTERM');
    const shuttingDown = buildApp({ pingDb: async () => ({ ok: true as const, latencyMs: 1 }) });
    const stopping = await ready(shuttingDown);
    expect(stopping.response.status).toBe(503);
    expect(stopping.body).toMatchObject({
      ok: false,
      status: 'not_ready',
      lifecycle: { state: 'shutting_down' },
    });
  });
});
