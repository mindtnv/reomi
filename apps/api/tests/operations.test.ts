import { afterEach, beforeEach, expect, test } from 'bun:test';
import { db, sources, notebooks, notebookArtifacts, sourceChunks } from '@reomi/db';
import { eq, sql } from 'drizzle-orm';
import { newUuidV7 } from '@reomi/shared';
import { buildApp } from '../src/app';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers';
import { ingestSource, stashInlineText } from '../src/ai/source-ingest';
import { __resetAiClientForTests, __setAiClientForTests } from '../src/ai/openai-client';
import { __setPdfExtractorForTests } from '../src/ai/source-parsers';
import { drainArtifactGeneration, generateArtifact, reconcileArtifactsOnStartup } from '../src/ai/artifacts';
import { drainSourceIngest } from '../src/ai/source-ingest';
import { OperationCooldownError, retryOperation } from '../src/modules/operation-retry';

const app = buildApp();
beforeEach(resetTestDb);
afterEach(async () => { await drainArtifactGeneration({ timeoutMs: 1000 }); await drainSourceIngest({ timeoutMs: 1000 }); __resetAiClientForTests(); __setPdfExtractorForTests(null); });
const feed = async (cookie: string, query = '') => {
  const response = await callApp(app, 'GET', `/operations/v1${query}`, { cookie });
  expect(response.status).toBe(200);
  return response.json<any>();
};

test('source processing remains discoverable without the initiating screen and separates reading from search', async () => {
  const owner = await signUpAndCookie(app, uniqueEmail());
  const [source] = await db.insert(sources).values({ userId: owner.userId, kind: 'text', title: 'A book', verified: true }).returning();
  stashInlineText(source!.id, 'A readable book with some searchable text.');
  await ingestSource(source!.id);
  const list = await feed(owner.cookie);
  const row = list.attention.items.find((item: any) => item.id === source!.id);
  expect(row).toMatchObject({ kind: 'source', phase: 'search_unavailable', canRead: true, canSearch: false });
  expect(row.runId).toBeString();
  expect(list.active.total).toBe(0);
  expect(JSON.stringify(list)).not.toContain('A readable book with');
  const stranger = await signUpAndCookie(app, uniqueEmail());
  expect((await feed(stranger.cookie)).attention.total).toBe(0);
});

test('terminal time belongs to the run and is not refreshed by metadata edits', async () => {
  const owner = await signUpAndCookie(app, uniqueEmail());
  __setAiClientForTests({ embed: async texts => texts.map(() => Array.from({ length: 1536 }, (_, i) => i === 0 ? 1 : 0)) });
  const [source] = await db.insert(sources).values({ userId: owner.userId, kind: 'text', title: 'Book', verified: true }).returning();
  stashInlineText(source!.id, 'A book for indexing.');
  await ingestSource(source!.id);
  const ready = (await feed(owner.cookie)).recent.items[0];
  expect(ready).toMatchObject({ id: source!.id, phase: 'ready', canRead: true, canSearch: true });
  expect(ready.finishedAt).toBeString();
  await db.update(sources).set({ title: 'Renamed', updatedAt: new Date() }).where(eq(sources.id, source!.id));
  expect((await feed(owner.cookie)).recent.items[0].finishedAt).toBe(ready.finishedAt);
});

test('a superseded indexing response cannot mark a replacement run ready or embed its chunks', async () => {
  const owner = await signUpAndCookie(app, uniqueEmail());
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<number[][]>();
  __setAiClientForTests({ embed: async () => { entered.resolve(); return release.promise; } });
  const [source] = await db.insert(sources).values({ userId: owner.userId, kind: 'text', title: 'Book', verified: true }).returning();
  stashInlineText(source!.id, 'Original book.');
  const worker = ingestSource(source!.id);
  await entered.promise;
  const nextRun = newUuidV7();
  await db.execute(sql`UPDATE sources SET operation_run_id = ${nextRun}, status = 'indexing' WHERE id = ${source!.id}`);
  release.resolve([Array.from({ length: 1536 }, (_, i) => i === 0 ? 1 : 0)]);
  await worker;
  const [current] = await db.select().from(sources).where(eq(sources.id, source!.id));
  expect(current!.status).toBe('indexing');
  expect(current!.operationRunId).toBe(nextRun);
  expect(current!.operationFinishedAt).toBeNull();
  const chunks = await db.select().from(sourceChunks).where(eq(sourceChunks.sourceId, source!.id));
  expect(chunks.every(chunk => !chunk.embedded)).toBe(true);
});

test('artifact and source groups paginate without hiding old active work or leaking another account', async () => {
  const owner = await signUpAndCookie(app, uniqueEmail());
  const [notebook] = await db.insert(notebooks).values({ userId: owner.userId, title: 'Notebook' }).returning();
  await db.insert(notebookArtifacts).values(Array.from({ length: 24 }, (_, i) => ({
    userId: owner.userId, notebookId: notebook!.id, sourceIds: [], type: 'quiz', title: `Quiz ${i}`, status: 'pending',
    operationRunId: newUuidV7(), operationStartedAt: new Date('2020-01-01'),
  })));
  const first = await feed(owner.cookie);
  expect(first.active.total).toBe(24);
  expect(first.active.items).toHaveLength(20);
  const second = await feed(owner.cookie, `?activeCursor=${encodeURIComponent(first.active.nextCursor)}`);
  expect(second.active.items).toHaveLength(4);
  expect(new Set([...first.active.items, ...second.active.items].map((x: any) => x.id)).size).toBe(24);
  expect(second.active.nextCursor).toBeNull();
  expect((await callApp(app, 'GET', '/operations/v1?activeCursor=not-a-cursor', { cookie: owner.cookie })).status).toBe(400);
});

async function failedArtifact(userId: string, options: { questionCount?: number } | null = { questionCount: 7 }) {
  const [source] = await db.insert(sources).values({ userId, title: 'Study source', kind: 'text', status: 'ready', verified: true }).returning();
  await db.insert(sourceChunks).values({ userId, sourceId: source!.id, position: 0, text: 'Safe fixture text', embedded: true });
  const [artifact] = await db.insert(notebookArtifacts).values({ userId, ownerKind: 'source', sourceId: source!.id,
    sourceOriginId: source!.id, sourceOriginTitle: source!.title, sourceIds: [source!.id], title: 'Quiz', type: 'quiz',
    status: 'error', errorCode: 'timeout', operationRunId: newUuidV7(), operationFinishedAt: new Date(), generationOptions: options }).returning();
  return { source: source!, artifact: artifact! };
}

test('concurrent retry and lost-response replay schedule once and preserve quiz settings', async () => {
  const owner = await signUpAndCookie(app, uniqueEmail());
  const { artifact } = await failedArtifact(owner.userId);
  let calls = 0;
  let prompt = '';
  __setAiClientForTests({ complete: async messages => { calls++; prompt = messages.map(message => message.content).join('\n'); return 'invalid quiz'; } });
  const input = { kind: 'artifact' as const, id: artifact.id, runId: artifact.operationRunId!, requestId: newUuidV7() };
  const [a, b] = await Promise.all([retryOperation(owner.userId, input), retryOperation(owner.userId, input)]);
  expect(a.runId).toBe(b.runId);
  expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
  await drainArtifactGeneration({ timeoutMs: 2000 });
  expect(calls).toBe(1);
  expect(prompt).toContain('7');
  const stale = await retryOperation(owner.userId, { ...input, requestId: newUuidV7() });
  expect(stale).toMatchObject({ stale: true, runId: a.runId });
  expect((await retryOperation(owner.userId, input)).replayed).toBe(true);
  await expect(retryOperation(owner.userId, { ...input, acceptDefaults: true })).rejects.toThrow('request_changed');
  expect(calls).toBe(1);
});

test('retry checks ownership, missing AI, explicit legacy defaults and cooldown before mutating', async () => {
  const owner = await signUpAndCookie(app, uniqueEmail());
  const other = await signUpAndCookie(app, uniqueEmail());
  const { artifact } = await failedArtifact(owner.userId, null);
  const input = { kind: 'artifact' as const, id: artifact.id, runId: artifact.operationRunId!, requestId: newUuidV7() };
  expect((await callApp(app, 'POST', '/operations/v1/retry', { cookie: other.cookie, body: input })).status).toBe(404);
  expect((await callApp(app, 'POST', '/operations/v1/retry', { cookie: owner.cookie, body: input })).status).toBe(503);
  __setAiClientForTests({ complete: async () => 'invalid quiz' });
  expect((await callApp(app, 'POST', '/operations/v1/retry', { cookie: owner.cookie, body: input })).status).toBe(409);
  await expect(retryOperation(owner.userId, { ...input, acceptDefaults: true }, undefined,
    () => ({ ok: false, retryAfterMs: 1234 }))).rejects.toBeInstanceOf(OperationCooldownError);
  const [unchanged] = await db.select().from(notebookArtifacts).where(eq(notebookArtifacts.id, artifact.id));
  expect(unchanged!.operationRunId).toBe(artifact.operationRunId);
  expect(unchanged!.status).toBe('error');
});

test('startup interruption is a recent failed run; retained completed quizzes still have exact destinations', async () => {
  const owner = await signUpAndCookie(app, uniqueEmail());
  const { artifact, source } = await failedArtifact(owner.userId);
  await db.update(notebookArtifacts).set({ status: 'generating', operationFinishedAt: null }).where(eq(notebookArtifacts.id, artifact.id));
  await reconcileArtifactsOnStartup();
  const interrupted = (await feed(owner.cookie)).attention.items[0];
  expect(interrupted).toMatchObject({ id: artifact.id, runId: artifact.operationRunId, phase: 'failed' });
  await db.update(notebookArtifacts).set({ status: 'ready' }).where(eq(notebookArtifacts.id, artifact.id));
  await db.delete(sources).where(eq(sources.id, source.id));
  const retained = (await feed(owner.cookie)).recent.items[0];
  expect(retained.destination).toEqual({ kind: 'source-artifact', id: artifact.id, sourceId: null });
});

test('an old artifact completion cannot overwrite a replacement run', async () => {
  const owner = await signUpAndCookie(app, uniqueEmail());
  const { artifact } = await failedArtifact(owner.userId);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<string>();
  __setAiClientForTests({ complete: async () => { entered.resolve(); return release.promise; } });
  await db.update(notebookArtifacts).set({ type: 'summary', status: 'pending' }).where(eq(notebookArtifacts.id, artifact.id));
  const worker = generateArtifact(artifact.id);
  await entered.promise;
  const nextRun = newUuidV7();
  await db.update(notebookArtifacts).set({ operationRunId: nextRun, status: 'generating', contentMd: 'New run output' }).where(eq(notebookArtifacts.id, artifact.id));
  release.resolve('Old run output');
  await worker;
  const [current] = await db.select().from(notebookArtifacts).where(eq(notebookArtifacts.id, artifact.id));
  expect(current).toMatchObject({ operationRunId: nextRun, status: 'generating', contentMd: 'New run output' });
});

test('recent pagination uses completion time, ignores historical untimed work and hides expired waiting rows', async () => {
  const owner = await signUpAndCookie(app, uniqueEmail());
  const now = new Date();
  await db.insert(sources).values([
    ...Array.from({ length: 22 }, (_, i) => ({ userId: owner.userId, kind: 'text', title: `Recent ${i}`, verified: true,
      status: 'ready', operationRunId: newUuidV7(), operationFinishedAt: now })),
    { userId: owner.userId, kind: 'text', title: 'Old', verified: true, status: 'ready', operationRunId: newUuidV7(), operationFinishedAt: new Date('2020-01-01') },
    { userId: owner.userId, kind: 'text', title: 'Untimed', verified: true, status: 'ready' },
    { userId: owner.userId, kind: 'text', title: 'Old parked', verified: true, status: 'indexing', operationRunId: newUuidV7(), operationFinishedAt: new Date('2020-01-01') },
  ]);
  const a = await feed(owner.cookie);
  const b = await feed(owner.cookie, `?recentCursor=${encodeURIComponent(a.recent.nextCursor)}`);
  expect(a.recent.total).toBe(22);
  expect(b.recent.items).toHaveLength(2);
  expect(new Set([...a.recent.items, ...b.recent.items].map(x => x.id)).size).toBe(22);
  expect(a.attention.total).toBe(0);
  const stranger = await signUpAndCookie(app, uniqueEmail());
  expect((await feed(stranger.cookie)).recent.total).toBe(0);
});

test('legacy source creation is tracked at acceptance and source retry preserves parsed text for index failures', async () => {
  const owner = await signUpAndCookie(app, uniqueEmail());
  const created = await callApp(app, 'POST', '/library/items', { cookie: owner.cookie, body: { kind: 'text', title: 'Inline', text: 'Retained parsed text.' } });
  expect(created.status).toBe(200);
  await drainSourceIngest({ timeoutMs: 2000 });
  const [source] = await db.select().from(sources).where(eq(sources.userId, owner.userId));
  expect(source!.operationRunId).toBeString(); expect(source!.operationStartedAt).not.toBeNull();
  await db.update(sources).set({ status: 'error', errorCode: 'index_failed' }).where(eq(sources.id, source!.id));
  __setAiClientForTests({ embed: async texts => texts.map(() => Array.from({ length: 1536 }, (_, i) => i === 0 ? 1 : 0)) });
  const retry = await callApp(app, 'POST', '/operations/v1/retry', { cookie: owner.cookie, body: {
    kind: 'source', id: source!.id, runId: source!.operationRunId, requestId: newUuidV7(),
  } });
  expect(retry.status).toBe(200);
  await drainSourceIngest({ timeoutMs: 2000 });
  const [ready] = await db.select().from(sources).where(eq(sources.id, source!.id));
  expect(ready!.status).toBe('ready'); expect(ready!.operationRunId).not.toBe(source!.operationRunId);
  const chunks = await db.select().from(sourceChunks).where(eq(sourceChunks.sourceId, source!.id));
  expect(chunks.map(x => x.text).join(' ')).toContain('Retained parsed text.');
});

test('legacy regeneration racing a versioned retry shares the domain lock and starts only one job', async () => {
  const owner = await signUpAndCookie(app, uniqueEmail()), { artifact } = await failedArtifact(owner.userId);
  const release = Promise.withResolvers<string>(); let calls = 0;
  __setAiClientForTests({ complete: async () => { calls++; return release.promise; } });
  try {
    const input = { kind: 'artifact' as const, id: artifact.id, runId: artifact.operationRunId!, requestId: newUuidV7() };
    const [retry, legacy] = await Promise.all([
      retryOperation(owner.userId, input),
      callApp(app, 'POST', `/study/artifacts/${artifact.id}/regenerate`, { cookie: owner.cookie }),
    ]);
    expect([200, 409]).toContain(legacy.status);
    if (legacy.status === 200) expect(retry.stale).toBe(true);
    const [current] = await db.select().from(notebookArtifacts).where(eq(notebookArtifacts.id, artifact.id));
    expect(current!.operationRunId).toBe(retry.runId);
  } finally { release.resolve('invalid quiz'); await drainArtifactGeneration({ timeoutMs: 2000 }); }
  expect(calls).toBe(1);
});

test('commit-before-dispatch interruption leaves one reconcilable failed run and requires a new explicit retry', async () => {
  const owner = await signUpAndCookie(app, uniqueEmail()), { artifact } = await failedArtifact(owner.userId);
  let calls = 0;
  __setAiClientForTests({ complete: async () => { calls++; return 'invalid quiz'; } });
  const input = { kind: 'artifact' as const, id: artifact.id, runId: artifact.operationRunId!, requestId: newUuidV7() };
  await expect(retryOperation(owner.userId, input, undefined, () => ({ ok: true }), () => { throw new Error('dispatch interrupted'); })).rejects.toThrow('dispatch interrupted');
  const [accepted] = await db.select().from(notebookArtifacts).where(eq(notebookArtifacts.id, artifact.id));
  expect(accepted!.status).toBe('pending'); expect(accepted!.operationRunId).not.toBe(input.runId); expect(calls).toBe(0);
  await reconcileArtifactsOnStartup();
  const [interrupted] = await db.select().from(notebookArtifacts).where(eq(notebookArtifacts.id, artifact.id));
  expect(interrupted!.status).toBe('error'); expect(interrupted!.errorCode).toBe('interrupted');
  expect(await retryOperation(owner.userId, input)).toMatchObject({ replayed: true, runId: accepted!.operationRunId }); expect(calls).toBe(0);
  await retryOperation(owner.userId, { ...input, runId: accepted!.operationRunId!, requestId: newUuidV7() });
  await drainArtifactGeneration({ timeoutMs: 2000 }); expect(calls).toBe(1);
});

test('retry after source deletion preserves retained work without scheduling unavailable input', async () => {
  const owner = await signUpAndCookie(app, uniqueEmail()), { artifact, source } = await failedArtifact(owner.userId);
  let calls = 0; __setAiClientForTests({ complete: async () => { calls++; return 'invalid quiz'; } });
  await db.delete(sources).where(eq(sources.id, source.id));
  await expect(retryOperation(owner.userId, { kind: 'artifact', id: artifact.id, runId: artifact.operationRunId!, requestId: newUuidV7() })).rejects.toThrow('source_unavailable');
  const [current] = await db.select().from(notebookArtifacts).where(eq(notebookArtifacts.id, artifact.id));
  expect(current!.operationRunId).toBe(artifact.operationRunId); expect(calls).toBe(0);
});

test('result resolution exposes only owned navigation metadata and handles deletion or a newer active run', async () => {
  const owner = await signUpAndCookie(app, uniqueEmail()), other = await signUpAndCookie(app, uniqueEmail());
  const { artifact, source } = await failedArtifact(owner.userId);
  await db.update(notebookArtifacts).set({ status: 'ready', contentMd: 'PRIVATE GENERATED BODY' }).where(eq(notebookArtifacts.id, artifact.id));
  const resolve = (cookie = owner.cookie) => callApp(app, 'GET', `/operations/v1/artifacts/${artifact.id}`, { cookie });
  const response = await resolve(); expect(response.status).toBe(200);
  const body = await response.json<any>(); expect(Object.keys(body)).toEqual(['destination']);
  expect(body.destination).toEqual({ kind: 'source-artifact', id: artifact.id, sourceId: source.id });
  expect(JSON.stringify(body)).not.toContain('PRIVATE GENERATED BODY'); expect((await resolve(other.cookie)).status).toBe(404);
  const [notebook] = await db.insert(notebooks).values({ userId: owner.userId, title: 'Owned notebook' }).returning();
  const [notebookResult] = await db.insert(notebookArtifacts).values({ userId: owner.userId, notebookId: notebook!.id,
    type: 'summary', title: 'Notebook result', status: 'ready', sourceIds: [source.id], contentMd: 'PRIVATE NOTEBOOK BODY' }).returning();
  const notebookResolution = await callApp(app, 'GET', `/operations/v1/artifacts/${notebookResult!.id}`, { cookie: owner.cookie });
  expect(await notebookResolution.json<any>()).toEqual({ destination: { kind: 'notebook-artifact', id: notebookResult!.id, notebookId: notebook!.id } });
  await db.update(sources).set({ status: 'deleting' }).where(eq(sources.id, source.id));
  expect((await (await resolve()).json<any>()).destination.sourceId).toBeNull();
  await db.delete(sources).where(eq(sources.id, source.id));
  expect((await (await resolve()).json<any>()).destination).toEqual({ kind: 'source-artifact', id: artifact.id, sourceId: null });
  await db.update(notebookArtifacts).set({ status: 'pending' }).where(eq(notebookArtifacts.id, artifact.id));
  expect((await resolve()).status).toBe(409);
  await db.delete(notebookArtifacts).where(eq(notebookArtifacts.id, artifact.id)); expect((await resolve()).status).toBe(404);
});
