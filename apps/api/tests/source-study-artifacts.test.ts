import { afterEach, beforeEach, expect, test } from 'bun:test';
import { db, sources, sourceChunks, notebookArtifacts, quizAttempts } from '@reomi/db';
import { eq } from 'drizzle-orm';
import { newUuidV7 } from '@reomi/shared';
import { buildApp } from '../src/app';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers';
import { deleteSourceCompletely } from '../src/modules/sources-shared';
import { generateArtifact, drainArtifactGeneration } from '../src/ai/artifacts';
import { __setAiClientForTests, __resetAiClientForTests } from '../src/ai/openai-client';
beforeEach(resetTestDb); afterEach(__resetAiClientForTests);
async function fixture() {
  const { userId } = await signUpAndCookie(buildApp(), uniqueEmail());
  const [source] = await db.insert(sources).values({ userId, kind: 'text', title: 'Book', status: 'ready' }).returning();
  await db.insert(sourceChunks).values({ userId, sourceId: source!.id, position: 0, text: 'A Pod groups containers.' });
  const owner = { userId, ownerKind: 'source' as const, sourceId: source!.id, sourceOriginId: source!.id, sourceOriginTitle: 'Book', sourceIds: [source!.id] };
  const [pending, ready] = await db.insert(notebookArtifacts).values([
    { ...owner, title: 'Working', type: 'summary', status: 'pending' },
    { ...owner, title: 'Ready quiz', type: 'quiz', status: 'ready', contentJson: { questions: [] } as any },
  ]).returning();
  const [attempt] = await db.insert(quizAttempts).values({ userId, artifactId: ready!.id, answers: [], correct: 1, total: 1 }).returning();
  return { userId, source: source!, pending: pending!, ready: ready!, attempt: attempt! };
}
test('deleting a source terminalizes unfinished work and retains completed quiz attempts', async () => {
  const f = await fixture();
  expect(await deleteSourceCompletely(f.userId, f.source.id)).toBe(true);
  const [pending] = await db.select().from(notebookArtifacts).where(eq(notebookArtifacts.id, f.pending.id));
  expect(pending!.status).toBe('error'); expect(pending!.errorCode).toBe('source_unavailable'); expect(pending!.sourceId).toBeNull();
  const [ready] = await db.select().from(notebookArtifacts).where(eq(notebookArtifacts.id, f.ready.id));
  expect(ready!.status).toBe('ready'); expect(ready!.contentJson).toEqual(f.ready.contentJson);
  expect(await db.select().from(quizAttempts).where(eq(quizAttempts.id, f.attempt.id))).toHaveLength(1);
});
for (const externalDelete of [false, true]) test(`late artifact result cannot commit after ${externalDelete ? 'direct' : 'service'} source deletion`, async () => {
  const f = await fixture(); let entered!: () => void, finish!: (s: string) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  __setAiClientForTests({ complete: async () => { entered(); return new Promise<string>(resolve => { finish = resolve; }); } });
  const running = generateArtifact(f.pending.id);
  await started;
  if (externalDelete) await db.delete(sources).where(eq(sources.id, f.source.id));
  else await deleteSourceCompletely(f.userId, f.source.id);
  finish('A late generated summary'); await running;
  const [row] = await db.select().from(notebookArtifacts).where(eq(notebookArtifacts.id, f.pending.id));
  expect(row!.status).toBe('error'); expect(row!.errorCode).toBe('source_unavailable');
  expect(row!.contentMd).not.toBe('A late generated summary');
});

test('source routes admit one active generation and expose retained results without a notebook', async () => {
  const app = buildApp();
  const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
  const [source] = await db.insert(sources).values({ userId, kind: 'text', title: 'New book', status: 'ready' }).returning();
  await db.insert(sourceChunks).values({ userId, sourceId: source!.id, position: 0, text: 'Study evidence' });
  let finish!: () => void;
  const hold = new Promise<void>(resolve => { finish = resolve; });
  __setAiClientForTests({ complete: async () => { await hold; return 'A source summary'; } });
  try {
    const results = await Promise.all([1,2].map(() => callApp(app, 'POST', `/sources/${source!.id}/artifacts`, { cookie, body: { type: 'summary' } })));
    expect(results.map(r => r.status).sort()).toEqual([200,409]);
    const created = await results.find(r => r.status === 200)!.json<any>();
    expect(created.notebookId).toBeNull(); expect(created.ownerKind).toBe('source');
    const listed = await callApp(app, 'GET', `/sources/${source!.id}/artifacts`, { cookie });
    expect((await listed.json<any>()).items.map((r: any) => r.id)).toContain(created.id);
    await deleteSourceCompletely(userId, source!.id);
    const retained = await callApp(app, 'GET', `/study/artifacts/${created.id}`, { cookie });
    expect(retained.status).toBe(200); expect((await retained.json<any>()).errorCode).toBe('source_unavailable');
    expect((await callApp(app, 'POST', `/study/artifacts/${created.id}/regenerate`, { cookie, body: {} })).status).toBe(409);
  } finally { finish(); await drainArtifactGeneration({ timeoutMs: 1000 }); }
});

test('a retained quiz stays playable, scores on the server, and isolates attempts by owner', async () => {
  const f = await fixture(), app = buildApp();
  const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
  const questionId = newUuidV7();
  const [quiz] = await db.insert(notebookArtifacts).values({ userId, ownerKind: 'source', sourceOriginId: newUuidV7(), sourceOriginTitle: 'Deleted book',
    type: 'quiz', title: 'Retained quiz', status: 'ready', sourceIds: [], contentJson: { questions: [{ id: questionId, kind: 'tf', prompt: 'A Pod groups containers', answer: true, explanation: 'Yes' }] } }).returning();
  const result = await callApp(app, 'POST', `/study/artifacts/${quiz!.id}/attempts`, { cookie,
    body: { answers: [{ questionId, answer: false }], correct: 999 } });
  expect(result.status).toBe(200); const attempt = await result.json<any>();
  expect(attempt.correct).toBe(0); expect(attempt.total).toBe(1);
  const history = await callApp(app, 'GET', `/study/artifacts/${quiz!.id}/attempts`, { cookie });
  expect((await history.json<any>()).items[0].id).toBe(attempt.id);
  const invalid = await callApp(app, 'POST', `/study/artifacts/${quiz!.id}/attempts`, { cookie, body: { answers: [{ questionId: newUuidV7(), answer: true }] } });
  expect(invalid.status).toBe(400);
  expect((await callApp(app, 'GET', `/study/artifacts/${f.ready.id}/attempts`, { cookie })).status).toBe(404);
  expect((await callApp(app, 'POST', `/study/artifacts/${f.ready.id}/attempts`, { cookie, body: { answers: [] } })).status).toBe(404);
  await db.update(notebookArtifacts).set({ status: 'generating' }).where(eq(notebookArtifacts.id, quiz!.id));
  expect((await callApp(app, 'POST', `/study/artifacts/${quiz!.id}/attempts`, { cookie, body: { answers: [] } })).status).toBe(400);
});

test('source and retained artifact routes reject every foreign read and mutation',async()=>{
  const f=await fixture(),app=buildApp(),other=await signUpAndCookie(app,uniqueEmail());
  for(const [method,path,body] of [
    ['GET',`/sources/${f.source.id}/artifacts`,undefined],
    ['POST',`/sources/${f.source.id}/artifacts`,{type:'summary'}],
    ['GET',`/study/artifacts/${f.ready.id}`,undefined],
    ['POST',`/study/artifacts/${f.ready.id}/regenerate`,{}],
    ['DELETE',`/study/artifacts/${f.ready.id}`,undefined],
  ] as const){
    const response=await callApp(app,method,path,{cookie:other.cookie,...(body?{body}:{})});
    expect(response.status).toBe(404);expect(await response.text()).not.toContain('Ready quiz');
  }
  const listing=await callApp(app,'GET','/study/artifacts',{cookie:other.cookie});
  expect((await listing.json<any>()).items).toEqual([]);
  expect(await db.select().from(notebookArtifacts).where(eq(notebookArtifacts.id,f.ready.id))).toHaveLength(1);
});

for(const streaming of [false,true]) test(`source deletion aborts the in-flight ${streaming?'stream':'completion'} after commit`,async()=>{
  const f=await fixture();let entered!:()=>void,signal:AbortSignal|undefined;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  __setAiClientForTests(streaming?{async *chatStream(_messages,opts){signal=opts?.signal;entered();yield 'Partial';await new Promise<void>(()=>{});}}:{complete:async(_messages,opts)=>{signal=opts?.signal;entered();return new Promise<string>(()=>{});}});
  const running=generateArtifact(f.pending.id);
  await started;
  expect(await deleteSourceCompletely(f.userId,f.source.id)).toBe(true);
  expect(signal?.aborted).toBe(true);
  await Promise.race([running,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new Error('generation did not cancel')),500);running.finally(()=>clearTimeout(timer));})]);
  const [row]=await db.select().from(notebookArtifacts).where(eq(notebookArtifacts.id,f.pending.id));
  expect(row!.status).toBe('error');expect(row!.errorCode).toBe('source_unavailable');
});

for (const state of [{ status: 'indexing', errorCode: null }, { status: 'error', errorCode: 'index_failed' }]) test(`source study generates and regenerates from parsed text while ${state.errorCode ?? state.status}`, async () => {
  const app = buildApp(), { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
  const [source] = await db.insert(sources).values({ userId, kind: 'text', title: 'Parsed without embeddings', ...state }).returning();
  await db.insert(sourceChunks).values({ userId, sourceId: source!.id, position: 0, text: 'Pods share networking.' });
  __setAiClientForTests({ complete: async () => 'Summary of parsed source text.' });
  const created = await callApp(app, 'POST', `/sources/${source!.id}/artifacts`, { cookie, body: { type: 'summary' } });
  expect(created.status).toBe(200);
  const artifact = await created.json<any>();
  await drainArtifactGeneration({ timeoutMs: 1000 });
  const read = async () => (await callApp(app, 'GET', `/study/artifacts/${artifact.id}`, { cookie })).json<any>();
  expect((await read()).status).toBe('ready');
  expect((await callApp(app, 'POST', `/study/artifacts/${artifact.id}/regenerate`, { cookie, body: {} })).status).toBe(200);
  await drainArtifactGeneration({ timeoutMs: 1000 }); expect((await read()).status).toBe('ready');
  await db.update(sources).set({ status: 'error', errorCode: 'parse_failed' }).where(eq(sources.id, source!.id));
  expect((await callApp(app, 'POST', `/study/artifacts/${artifact.id}/regenerate`, { cookie, body: {} })).status).toBe(409);
});

test('source generation is unavailable without chat while saved work remains readable', async () => {
  const f = await fixture(), app = buildApp();
  // fixture's owner needs a session for the routes; use a fresh owned source.
  const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
  const [source] = await db.insert(sources).values({ userId, kind: 'text', title: 'Manual source', status: 'ready' }).returning();
  await db.insert(sourceChunks).values({ userId, sourceId: source!.id, position: 0, text: 'Readable text' });
  const result = await callApp(app, 'POST', `/sources/${source!.id}/artifacts`, { cookie, body: { type: 'summary' } });
  expect(result.status).toBe(503); expect(await result.json()).toEqual({ error: 'ai_disabled' });
  expect(await db.select().from(notebookArtifacts).where(eq(notebookArtifacts.userId, userId))).toHaveLength(0);
  expect((await callApp(app, 'GET', `/sources/${source!.id}/artifacts`, { cookie })).status).toBe(200);
  expect((await callApp(app, 'POST', `/sources/${f.source.id}/artifacts`, { cookie, body: { type: 'summary' } })).status).toBe(404);
});
