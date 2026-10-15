import { beforeEach, expect, test } from 'bun:test';
import { db, sources, notebooks, notebookNotes, notebookArtifacts, quizAttempts, conversations, messages } from '@reomi/db';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers';
const app = buildApp();
beforeEach(resetTestDb);

test('saving an answer requires owned assistant text with the matching effective source context', async () => {
  const { userId, cookie } = await signUpAndCookie(app, uniqueEmail());
  const [source, other] = await db.insert(sources).values([{ userId, kind: 'text', title: 'Selected' }, { userId, kind: 'text', title: 'Other' }]).returning();
  const [conversation] = await db.insert(conversations).values({ userId }).returning();
  const [question] = await db.insert(messages).values({ userId, conversationId: conversation!.id, role: 'user', content: 'Explain',
    createdAt: new Date(Date.now() - 1000), context: { version: 1, revision: 0, policy: 'focus', refs: [], sourceIds: [source!.id], deckIds: [] } }).returning();
  const [answer] = await db.insert(messages).values({ userId, conversationId: conversation!.id, role: 'assistant', content: 'Answer' }).returning();
  for (const [sourceId, messageId, expected] of [[source!.id, answer!.id, 200], [other!.id, answer!.id, 400], [source!.id, question!.id, 400]] as const) {
    const result = await callApp(app, 'POST', `/sources/${sourceId}/notes`, { cookie, body: { title: 'Saved answer', content: 'Answer', kind: 'answer', messageId } });
    expect(result.status).toBe(expected);
  }
  const [notebook, unrelated] = await db.insert(notebooks).values([{ userId, title: 'Mentioned notebook' }, { userId, title: 'Unrelated notebook' }]).returning();
  await db.update(messages).set({ context: { version: 1, revision: 0, policy: 'focus', sourceIds: [source!.id], deckIds: [],
    refs: [{ ref: { kind: 'notebook', id: notebook!.id }, label: 'Mentioned notebook', available: true }] } }).where(eq(messages.id, question!.id));
  for (const [notebookId, expected] of [[notebook!.id, 200], [unrelated!.id, 400]] as const) {
    const saved = await callApp(app, 'POST', `/notebooks/${notebookId}/notes`, { cookie,
      body: { title: 'From a global chat', content: 'Answer', kind: 'answer', messageId: answer!.id } });
    expect(saved.status).toBe(expected);
  }
  await db.update(sources).set({ status: 'deleting' }).where(eq(sources.id, source!.id));
  expect((await callApp(app, 'POST', `/sources/${source!.id}/notes`, { cookie, body: { title: 'Too late', content: 'x' } })).status).toBe(404);
});

test('source notes retain identity after attachment, detachment and source deletion', async () => {
  const { userId, cookie } = await signUpAndCookie(app, uniqueEmail());
  const [source] = await db.insert(sources).values({ userId, kind: 'text', title: 'Kubernetes' }).returning();
  const created = await callApp(app, 'POST', `/sources/${source!.id}/notes`, { cookie, body: { title: 'My note', content: 'Pods group containers.' } });
  expect(created.status).toBe(200);
  const note = await created.json<any>();
  expect(note.ownerKind).toBe('source'); expect(note.notebookId).toBeNull(); expect(note.sourceOriginTitle).toBe('Kubernetes');
  expect(await db.select().from(notebooks).where(eq(notebooks.userId, userId))).toEqual([]);
  const [notebook] = await db.insert(notebooks).values({ userId, title: 'Optional collection' }).returning();
  const [artifact] = await db.insert(notebookArtifacts).values({ userId, ownerKind: 'source', sourceId: source!.id,
    sourceOriginId: source!.id, sourceOriginTitle: source!.title, sourceIds: [source!.id],
    type: 'quiz', title: 'Retained quiz', status: 'ready', contentJson: { questions: [] } }).returning();
  const [attempt] = await db.insert(quizAttempts).values({ userId, artifactId: artifact!.id, answers: [], correct: 0, total: 0 }).returning();
  const assertWorkUnchanged = async () => {
    expect((await db.select().from(notebookNotes).where(eq(notebookNotes.userId, userId))).map(row => row.id)).toEqual([note.id]);
    expect(await db.select().from(notebookArtifacts).where(eq(notebookArtifacts.userId, userId))).toEqual([artifact!]);
    expect(await db.select().from(quizAttempts).where(eq(quizAttempts.userId, userId))).toEqual([attempt!]);
  };
  const attach = () => callApp(app, 'POST', `/notebooks/${notebook!.id}/sources/attach`, { cookie, body: { sourceIds: [source!.id] } });
  expect((await attach()).status).toBe(200);
  await assertWorkUnchanged();
  expect((await callApp(app, 'DELETE', `/notebooks/${notebook!.id}/sources/${source!.id}`, { cookie })).status).toBe(200);
  await assertWorkUnchanged();
  expect((await attach()).status).toBe(200);
  expect((await callApp(app, 'DELETE', `/notebooks/${notebook!.id}`, { cookie })).status).toBe(200);
  await assertWorkUnchanged();
  const listed = await callApp(app, 'GET', `/sources/${source!.id}/notes`, { cookie });
  expect((await listed.json<any>()).items.map((n: any) => n.id)).toEqual([note.id]);
  expect((await callApp(app, 'DELETE', `/library/items/${source!.id}`, { cookie })).status).toBe(200);
  expect(await db.select().from(notebookArtifacts).where(eq(notebookArtifacts.id, artifact!.id))).toEqual([{ ...artifact!, sourceId: null }]);
  expect(await db.select().from(quizAttempts).where(eq(quizAttempts.id, attempt!.id))).toEqual([attempt!]);
  expect((await callApp(app, 'GET', `/sources/${source!.id}/notes`, { cookie })).status).toBe(404);
  const retained = await callApp(app, 'GET', `/study/notes/${note.id}`, { cookie });
  expect(retained.status).toBe(200); expect((await retained.json<any>()).sourceId).toBeNull();
  const edited = await callApp(app, 'PATCH', `/study/notes/${note.id}`, { cookie, body: { content: 'Still editable' } });
  expect(edited.status).toBe(200); expect((await edited.json<any>()).content).toBe('Still editable');
  const saved = await callApp(app, 'GET', '/study/notes?unavailable=true', { cookie });
  expect((await saved.json<any>()).items.map((n: any) => n.id)).toContain(note.id);
  const search = await callApp(app, 'GET', '/chat/context/search?q=My%20note&kind=written_note', { cookie });
  expect(search.status).toBe(200);
  const found = (await search.json<any>()).items.find((item: any) => item.ref.id === note.id);
  expect(found.href).toBe(`/library/study?note=${note.id}`);
  expect(found.parent.label).toBe('Kubernetes');
  const resolved = await callApp(app, 'POST', '/chat/context/resolve', { cookie, body: { refs: [{ kind: 'written_note', id: note.id }] } });
  expect((await resolved.json<any>()).items[0].href).toBe(found.href);
  expect((await callApp(app, 'DELETE', `/study/notes/${note.id}`, { cookie })).status).toBe(200);
  expect(await db.select().from(notebookNotes).where(eq(notebookNotes.id, note.id))).toEqual([]);
  expect(await db.select().from(notebookArtifacts).where(eq(notebookArtifacts.id, artifact!.id))).toHaveLength(1);
  expect((await callApp(app, 'DELETE', `/study/artifacts/${artifact!.id}`, { cookie })).status).toBe(200);
  expect(await db.select().from(notebookArtifacts).where(eq(notebookArtifacts.id, artifact!.id))).toEqual([]);
  expect(await db.select().from(quizAttempts).where(eq(quizAttempts.id, attempt!.id))).toEqual([]);
});

test('source note endpoints do not expose or mutate another owner or accept forged ownership', async () => {
  const alice = await signUpAndCookie(app, uniqueEmail()), bob = await signUpAndCookie(app, uniqueEmail());
  const [source] = await db.insert(sources).values({ userId: alice.userId, kind: 'text', title: 'Private title' }).returning();
  const response = await callApp(app, 'POST', `/sources/${source!.id}/notes`, { cookie: alice.cookie, body: { title: 'Private', content: 'Private content' } });
  expect(response.status).toBe(200); const note = await response.json<any>();
  for (const [method,path,body] of [
    ['GET', `/sources/${source!.id}/notes`, undefined], ['POST', `/sources/${source!.id}/notes`, { title: 'Attack', content: 'x' }],
    ['GET', `/study/notes/${note.id}`, undefined], ['PATCH', `/study/notes/${note.id}`, { title: 'Changed' }],
    ['DELETE', `/study/notes/${note.id}`, undefined],
  ] as const) {
    const result = await callApp(app, method, path, { cookie: bob.cookie, ...(body ? { body } : {}) });
    expect(result.status).toBe(404); expect(await result.text()).not.toContain('Private');
  }
  const invalid = await callApp(app, 'POST', `/sources/${source!.id}/notes`, { cookie: alice.cookie, body: { title: ' ', content: 'x' } });
  expect(invalid.status).toBe(400);
  expect((await callApp(app, 'PATCH', `/study/notes/${note.id}`, { cookie: alice.cookie, body: {} })).status).toBe(400);
});
