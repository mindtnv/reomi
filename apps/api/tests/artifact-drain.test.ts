import { afterEach, beforeEach, expect, test } from 'bun:test';
import { db, sources, sourceChunks, notebookArtifacts } from '@reomi/db';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app';
import { scheduleArtifactGeneration, drainArtifactGeneration, reconcileArtifactsOnStartup } from '../src/ai/artifacts';
import { __setAiClientForTests, __resetAiClientForTests } from '../src/ai/openai-client';
import { artifactWorkerState, markRuntimeRunning, markRuntimeShuttingDown } from '../src/runtime-state';
import { resetTestDb, signUpAndCookie, uniqueEmail } from './helpers';
beforeEach(async () => { markRuntimeRunning(); await resetTestDb(); });
afterEach(() => { __resetAiClientForTests(); markRuntimeRunning(); });
async function fixture() {
  const { userId } = await signUpAndCookie(buildApp(), uniqueEmail());
  const [source] = await db.insert(sources).values({ userId, kind: 'text', title: 'Book', status: 'ready' }).returning();
  await db.insert(sourceChunks).values({ userId, sourceId: source!.id, position: 0, text: 'Pods group containers.' });
  const [artifact] = await db.insert(notebookArtifacts).values({ userId, ownerKind: 'source', sourceId: source!.id, sourceOriginId: source!.id,
    sourceOriginTitle: source!.title, sourceIds: [source!.id], title: 'Summary', type: 'summary', status: 'pending' }).returning();
  return artifact!;
}
for (const mode of ['completion', 'stream'] as const) test(`artifact drain aborts stalled ${mode} at the deadline and ignores its late result`, async () => {
  const artifact = await fixture();
  let started!: () => void, finish!: (text: string) => void, signal: AbortSignal | undefined;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<string>(resolve => { finish = resolve; });
  __setAiClientForTests(mode === 'completion'
    ? { complete: async (_messages, options) => { signal = options?.signal; started(); return pending; } }
    : { async *chatStream(_messages, options) { signal = options?.signal; started(); yield await pending; } });
  scheduleArtifactGeneration(artifact.id);
  try {
    await entered;
    await drainArtifactGeneration({ timeoutMs: 10 });
    expect(signal?.aborted).toBe(true);
  } finally { finish('Late provider answer'); await drainArtifactGeneration({ timeoutMs: 1000 }); }
  const [row] = await db.select().from(notebookArtifacts).where(eq(notebookArtifacts.id, artifact.id));
  expect(row!.status).not.toBe('ready'); expect(row!.contentMd ?? '').not.toContain('Late provider answer');
  expect(artifactWorkerState.snapshot().active).toBe(0);
  await reconcileArtifactsOnStartup();
  const [recovered] = await db.select().from(notebookArtifacts).where(eq(notebookArtifacts.id, artifact.id));
  expect(recovered!.status).toBe('error'); expect(recovered!.errorCode).toBe('interrupted');
});
test('shutdown prevents a late request from scheduling a new provider job', async () => {
  const artifact = await fixture(); let calls = 0;
  __setAiClientForTests({ complete: async () => { calls++; return 'Unexpected generation'; } });
  markRuntimeShuttingDown(); scheduleArtifactGeneration(artifact.id);
  await drainArtifactGeneration({ timeoutMs: 1000 });
  expect(calls).toBe(0);
  const [row] = await db.select().from(notebookArtifacts).where(eq(notebookArtifacts.id, artifact.id));
  expect(row!.status).toBe('pending');
});


test('drain cancellation during the claim phase prevents a later provider request', async () => {
  const artifact = await fixture(); let calls = 0;
  __setAiClientForTests({ complete: async () => { calls++; return 'Should not start'; } });
  let locked!: () => void, unlock!: () => void;
  const lockReady = new Promise<void>(resolve => { locked = resolve; });
  const release = new Promise<void>(resolve => { unlock = resolve; });
  const transaction = db.transaction(async tx => {
    await tx.select().from(notebookArtifacts).where(eq(notebookArtifacts.id, artifact.id)).for('update');
    locked(); await release;
  });
  await lockReady;
  try {
    scheduleArtifactGeneration(artifact.id);
    await drainArtifactGeneration({ timeoutMs: 10 });
  } finally { unlock(); await transaction; await drainArtifactGeneration({ timeoutMs: 1000 }); }
  expect(calls).toBe(0);
  const [row] = await db.select().from(notebookArtifacts).where(eq(notebookArtifacts.id, artifact.id));
  expect(row!.status).not.toBe('ready');
  expect(artifactWorkerState.snapshot().active).toBe(0);
});

test('cancellation while final source validation is blocked prevents a late ready commit', async () => {
  const artifact = await fixture();
  let entered!: () => void, finish!: (text: string) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const response = new Promise<string>(resolve => { finish = resolve; });
  __setAiClientForTests({ complete: async () => { entered(); return response; } });
  scheduleArtifactGeneration(artifact.id); await started;
  let locked!: () => void, unlock!: () => void;
  const lockReady = new Promise<void>(resolve => { locked = resolve; });
  const release = new Promise<void>(resolve => { unlock = resolve; });
  const transaction = db.transaction(async tx => {
    await tx.select().from(sources).where(eq(sources.id, artifact.sourceId!)).for('update');
    locked(); await release;
  });
  await lockReady;
  try { finish('A complete but cancelled summary'); await drainArtifactGeneration({ timeoutMs: 10 }); }
  finally { unlock(); await transaction; await drainArtifactGeneration({ timeoutMs: 1000 }); }
  const [row] = await db.select().from(notebookArtifacts).where(eq(notebookArtifacts.id, artifact.id));
  expect(row!.status).not.toBe('ready');
  expect(row!.contentMd ?? '').not.toContain('A complete but cancelled summary');
  expect(artifactWorkerState.snapshot().active).toBe(0);
});
