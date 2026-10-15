import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { db, decks, sources, notebookSources, conversations, conversationContexts, messages } from '@reomi/db';
import { eq } from 'drizzle-orm';
import { newUuidV7 } from '@reomi/shared';
import { buildApp } from '../src/app';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers';
import { __setAiClientForTests, __resetAiClientForTests, type AgentChatMessage } from '../src/ai/openai-client';

const app = buildApp();
describe('durable conversation context', () => {
  beforeEach(resetTestDb);
  afterEach(__resetAiClientForTests);

  test('creates and reloads typed context with server-derived labels', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const [source] = await db.insert(sources).values({ userId, title: 'Kubernetes', kind: 'text', status: 'ready' }).returning();
    const res = await callApp(app, 'POST', '/chat/conversations', { cookie, body: { context: { version: 1, refs: [{ kind: 'source', id: source!.id }] } } });
    expect(res.status).toBe(200);
    const created = await res.json<any>();
    expect(created.contextVersion).toBe(1);
    expect(created.contextPolicy).toBe('focus');
    expect(created.context.refs[0].label).toBe('Kubernetes');
    const reloaded = await (await callApp(app, 'GET', `/chat/conversations/${created.id}`, { cookie })).json<any>();
    expect(reloaded.conversation.context).toEqual(created.context);
    expect(await db.select().from(conversationContexts).where(eq(conversationContexts.conversationId, created.id))).toHaveLength(1);
  });

  test('context edits are atomic and compare their revision', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const created = await (await callApp(app, 'POST', '/chat/conversations', { cookie, body: { context: { version: 1, refs: [] } } })).json<any>();
    const body = { context: { version: 1, policy: 'strict', refs: [] }, expectedContextRevision: 0 };
    const results = await Promise.all([
      callApp(app, 'PATCH', `/chat/conversations/${created.id}`, { cookie, body }),
      callApp(app, 'PATCH', `/chat/conversations/${created.id}`, { cookie, body }),
    ]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    const reloaded = await (await callApp(app, 'GET', `/chat/conversations/${created.id}`, { cookie })).json<any>();
    expect(reloaded.conversation.contextPolicy).toBe('strict');
    expect(reloaded.conversation.contextRevision).toBe(1);
    expect(reloaded.conversation.context.refs).toEqual([]);
  });

  test('invalid context cannot partially rename a conversation or leak a foreign label', async () => {
    const alice = await signUpAndCookie(app, uniqueEmail('alice'));
    const bob = await signUpAndCookie(app, uniqueEmail('bob'));
    const [source] = await db.insert(sources).values({ userId: bob.userId, title: 'Private secret title', kind: 'text' }).returning();
    const created = await (await callApp(app, 'POST', '/chat/conversations', { cookie: alice.cookie, body: { title: 'Original', context: { version: 1, refs: [] } } })).json<any>();
    const result = await callApp(app, 'PATCH', `/chat/conversations/${created.id}`, { cookie: alice.cookie, body: {
      title: 'Changed', expectedContextRevision: 0, context: { version: 1, refs: [{ kind: 'source', id: source!.id }] },
    } });
    expect(result.status).toBe(400);
    expect(await result.text()).not.toContain('Private secret title');
    const reloaded = await (await callApp(app, 'GET', `/chat/conversations/${created.id}`, { cookie: alice.cookie })).json<any>();
    expect(reloaded.conversation.title).toBe('Original');
    expect(reloaded.conversation.contextRevision).toBe(0);
  });

  test('legacy notebook creates strict context and mixed inputs are rejected', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const book = await (await callApp(app, 'POST', '/notebooks', { cookie, body: { title: 'Legacy' } })).json<any>();
    const created = await (await callApp(app, 'POST', '/chat/conversations', { cookie, body: { notebookId: book.id } })).json<any>();
    expect(created.notebookId).toBe(book.id);
    expect(created.contextPolicy).toBe('strict');
    const mixed = await callApp(app, 'POST', '/chat/conversations', { cookie, body: { notebookId: book.id, context: { version: 1, refs: [] } } });
    expect(mixed.status).toBe(400);
  });

  test('foreign conversation cannot have context edited', async () => {
    const alice = await signUpAndCookie(app, uniqueEmail('alice'));
    const bob = await signUpAndCookie(app, uniqueEmail('bob'));
    const created = await (await callApp(app, 'POST', '/chat/conversations', { cookie: alice.cookie, body: {} })).json<any>();
    const result = await callApp(app, 'PATCH', `/chat/conversations/${created.id}`, { cookie: bob.cookie, body: { context: { version: 1, refs: [] }, expectedContextRevision: 0 } });
    expect(result.status).toBe(404);
    const missing = await callApp(app, 'POST', '/chat/conversations', { cookie: alice.cookie, body: { context: { version: 1, refs: [{ kind: 'source', id: newUuidV7() }] } } });
    expect(missing.status).toBe(400);
  });

  test('stream freezes context, keeps stored content clean, and regenerate retains original context after pins change', async () => {
    const captured: AgentChatMessage[][] = [];
    __setAiClientForTests({ async *chatStreamAgentic(messages) {
      captured.push(messages); yield { type: 'content', text: 'Answer' }; yield { type: 'finish', reason: 'stop' };
    } });
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const [source] = await db.insert(sources).values({ userId, title: 'Original book', kind: 'text', status: 'ready' }).returning();
    const created = await (await callApp(app, 'POST', '/chat/conversations', { cookie, body: {
      context: { version: 1, policy: 'strict', refs: [{ kind: 'source', id: source!.id }] },
    } })).json<any>();
    const sent = await callApp(app, 'POST', `/chat/conversations/${created.id}/stream`, { cookie, body: { content: 'Explain this', expectedContextRevision: 0 } });
    expect(sent.status).toBe(200); await sent.text();
    const detail = await (await callApp(app, 'GET', `/chat/conversations/${created.id}`, { cookie })).json<any>();
    expect(detail.messages[0].content).toBe('Explain this');
    expect(detail.messages[0].context.sourceIds).toEqual([source!.id]);
    expect(detail.messages[0].context.policy).toBe('strict');
    expect(JSON.stringify(captured[0])).toContain('Original book');
    await callApp(app, 'PATCH', `/chat/conversations/${created.id}`, { cookie, body: { context: { version: 1, policy: 'focus', refs: [] }, expectedContextRevision: 0 } });
    const replay = await callApp(app, 'POST', `/chat/conversations/${created.id}/regenerate`, { cookie, body: {} });
    expect(replay.status).toBe(200); await replay.text();
    expect(JSON.stringify(captured.at(-1))).toContain('Original book');
    const after = await (await callApp(app, 'GET', `/chat/conversations/${created.id}`, { cookie })).json<any>();
    expect(after.messages[0].context).toEqual(detail.messages[0].context);
  });

  test('invalid stream mentions and stale pin revision do not insert a user message', async () => {
    __setAiClientForTests({ async *chatStreamAgentic() { yield { type: 'finish', reason: 'stop' }; } });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const created = await (await callApp(app, 'POST', '/chat/conversations', { cookie, body: { context: { version: 1, refs: [] } } })).json<any>();
    const invalid = await callApp(app, 'POST', `/chat/conversations/${created.id}/stream`, { cookie, body: {
      content: 'Explain', context: { version: 1, refs: [{ kind: 'source', id: newUuidV7() }] },
    } });
    expect(invalid.status).toBe(400);
    const stale = await callApp(app, 'POST', `/chat/conversations/${created.id}/stream`, { cookie, body: { content: 'Explain', expectedContextRevision: 99 } });
    expect(stale.status).toBe(409);
    const detail = await (await callApp(app, 'GET', `/chat/conversations/${created.id}`, { cookie })).json<any>();
    expect(detail.messages).toEqual([]);
  });

  test('unified listing includes notebook chats, filters objects and supports legacy global scope', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const book = await (await callApp(app, 'POST', '/notebooks', { cookie, body: { title: 'My notebook' } })).json<any>();
    const [source] = await db.insert(sources).values({ userId, title: 'Book', kind: 'text' }).returning();
    const normal = await (await callApp(app, 'POST', '/chat/conversations', { cookie, body: { title: 'General' } })).json<any>();
    const legacy = await (await callApp(app, 'POST', '/chat/conversations', { cookie, body: { notebookId: book.id } })).json<any>();
    const contextual = await (await callApp(app, 'POST', '/chat/conversations', { cookie, body: { context: { version: 1, refs: [{ kind: 'source', id: source!.id }] } } })).json<any>();
    const all = await (await callApp(app, 'GET', '/chat/conversations', { cookie })).json<any>();
    expect(new Set(all.items.map((c: any) => c.id))).toEqual(new Set([normal.id, legacy.id, contextual.id]));
    const filtered = await (await callApp(app, 'GET', `/chat/conversations?contextKind=source&contextId=${source!.id}`, { cookie })).json<any>();
    expect(filtered.items.map((c: any) => c.id)).toEqual([contextual.id]);
    expect(filtered.items[0].context.refs[0].label).toBe('Book');
    const global = await (await callApp(app, 'GET', '/chat/conversations?scope=global', { cookie })).json<any>();
    expect(global.items.map((c: any) => c.id)).not.toContain(legacy.id);
    const missing = await callApp(app, 'GET', `/chat/conversations?contextKind=source&contextId=${newUuidV7()}`, { cookie });
    expect(missing.status).toBe(404);
  });

  test('conversation pages use a total order through equal timestamps and pins', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const rows = await db.insert(conversations).values(Array.from({ length: 7 }, (_, i) => ({
      userId, title: `Conversation ${i}`, pinned: i < 2, updatedAt: new Date('2026-01-01T12:00:00Z'),
    }))).returning();
    const expected = rows.sort((a,b) => Number(b.pinned) - Number(a.pinned) || b.id.localeCompare(a.id)).map(r => r.id);
    const found: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await (await callApp(app, 'GET', `/chat/conversations?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { cookie })).json<any>();
      expect(page.items.length).toBeLessThanOrEqual(2);
      found.push(...page.items.map((r: any) => r.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(found).toEqual(expected);
    expect((await callApp(app, 'GET', '/chat/conversations?cursor=broken', { cookie })).status).toBe(400);
    expect((await callApp(app, 'GET', '/chat/conversations?limit=1.5', { cookie })).status).toBe(400);
    const filtered=await (await callApp(app,'GET','/chat/conversations?q=Conversation%206&limit=1',{cookie})).json<any>();
    expect(filtered.items.map((row:any)=>row.title)).toEqual(['Conversation 6']);
  });

  test('object filters include message-only references after deletion and never match another account', async () => {
    __setAiClientForTests({ async *chatStreamAgentic() { yield { type: 'finish', reason: 'stop' }; } });
    const alice = await signUpAndCookie(app, uniqueEmail('alice'));
    const bob = await signUpAndCookie(app, uniqueEmail('bob'));
    const [source] = await db.insert(sources).values({ userId: alice.userId, title: 'Mention only', kind: 'text' }).returning();
    const thread = await (await callApp(app, 'POST', '/chat/conversations', { cookie: alice.cookie, body: { context: { version: 1, refs: [] } } })).json<any>();
    const response = await callApp(app, 'POST', `/chat/conversations/${thread.id}/stream`, { cookie: alice.cookie, body: { content: 'Discuss', context: { version: 1, refs: [{ kind: 'source', id: source!.id }] } } });
    await response.text();
    await db.delete(sources).where(eq(sources.id, source!.id));
    const path = `/chat/conversations?contextKind=source&contextId=${source!.id}`;
    const own = await (await callApp(app, 'GET', path, { cookie: alice.cookie })).json<any>();
    expect(own.items.map((c: any) => c.id)).toEqual([thread.id]);
    expect((await callApp(app, 'GET', path, { cookie: bob.cookie })).status).toBe(404);
  });

  test('unknown historical notebook selection is resolved before regeneration removes the old answer', async () => {
    __setAiClientForTests({ async *chatStreamAgentic() { yield { type: 'finish', reason: 'stop' }; } });
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebook = await (await callApp(app, 'POST', '/notebooks', { cookie, body: { title: 'Old notebook' } })).json<any>();
    const thread = await (await callApp(app, 'POST', '/chat/conversations', { cookie, body: { notebookId: notebook.id } })).json<any>();
    await db.insert(messages).values([
      { userId, conversationId: thread.id, role: 'user', content: 'Old question', createdAt: new Date(1000) },
      { userId, conversationId: thread.id, role: 'assistant', content: 'Keep this answer until scope is chosen', createdAt: new Date(2000) },
    ]);
    const unresolved = await callApp(app, 'POST', `/chat/conversations/${thread.id}/regenerate`, { cookie, body: {} });
    expect(unresolved.status).toBe(400);
    expect(await unresolved.json()).toEqual({ error: 'context_selection_required' });
    const intact = await (await callApp(app, 'GET', `/chat/conversations/${thread.id}`, { cookie })).json<any>();
    expect(intact.messages).toHaveLength(2);
    const resolved = await callApp(app, 'POST', `/chat/conversations/${thread.id}/regenerate`, { cookie, body: { sourceIds: [] } });
    expect(resolved.status).toBe(200); await resolved.text();
    const final = await (await callApp(app, 'GET', `/chat/conversations/${thread.id}`, { cookie })).json<any>();
    expect(final.messages[0].context.sourceIds).toEqual([]);
    expect(final.messages[0].context.policy).toBe('strict');
  });

  test('legacy source selection becomes durable pins and survives a reply from a different surface', async () => {
    __setAiClientForTests({ async *chatStreamAgentic() { yield { type: 'finish', reason: 'stop' }; } });
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const book = await (await callApp(app, 'POST', '/notebooks', { cookie, body: { title: 'Selected material' } })).json<any>();
    const sourceRows = await db.insert(sources).values(['A','B'].map(title => ({ userId, title, kind: 'text', status: 'ready' }))).returning();
    await db.insert(notebookSources).values(sourceRows.map(source => ({ userId, notebookId: book.id, sourceId: source.id })));
    const thread = await (await callApp(app, 'POST', '/chat/conversations', { cookie, body: { notebookId: book.id } })).json<any>();
    const first = await callApp(app, 'POST', `/chat/conversations/${thread.id}/stream`, { cookie, body: { content: 'Only A', sourceIds: [sourceRows[0]!.id] } });
    await first.text();
    const pinned = await (await callApp(app, 'GET', `/chat/conversations/${thread.id}`, { cookie })).json<any>();
    expect(pinned.conversation.context.refs[0].ref.sourceIds).toEqual([sourceRows[0]!.id]);
    expect(pinned.conversation.contextRevision).toBeGreaterThan(0);
    const second = await callApp(app, 'POST', `/chat/conversations/${thread.id}/stream`, { cookie, body: { content: 'Continue' } });
    await second.text();
    const after = await (await callApp(app, 'GET', `/chat/conversations/${thread.id}`, { cookie })).json<any>();
    expect(after.messages.filter((m: any) => m.role === 'user').at(-1).context.sourceIds).toEqual([sourceRows[0]!.id]);
    const empty = await callApp(app, 'POST', `/chat/conversations/${thread.id}/stream`, { cookie, body: { content: 'Clear sources', sourceIds: [] } });
    await empty.text();
    const cleared = await (await callApp(app, 'GET', `/chat/conversations/${thread.id}`, { cookie })).json<any>();
    expect(cleared.conversation.context.refs[0].ref.sourceIds).toEqual([]);
    expect(cleared.conversation.contextRevision).toBeGreaterThan(pinned.conversation.contextRevision);
    await callApp(app, 'PATCH', `/chat/conversations/${thread.id}`, { cookie, body: {
      expectedContextRevision: cleared.conversation.contextRevision,
      context: { version: 1, policy: 'strict', refs: [{ kind: 'notebook', id: book.id, sourceIds: sourceRows.map(s => s.id) }] },
    } });
    const typedSubset = await callApp(app, 'POST', `/chat/conversations/${thread.id}/stream`, { cookie, body: {
      content: 'Explicit typed subset', context: { version: 1, policy: 'strict', refs: [{ kind: 'notebook', id: book.id, sourceIds: [] }] },
    } });
    await typedSubset.text();
    const legacySubset = await callApp(app, 'POST', `/chat/conversations/${thread.id}/stream`, { cookie, body: { content: 'Legacy subset on upgraded thread', sourceIds: [] } });
    await legacySubset.text();
    const mixedClients = await (await callApp(app, 'GET', `/chat/conversations/${thread.id}`, { cookie })).json<any>();
    const lastTwo = mixedClients.messages.filter((m: any) => m.role === 'user').slice(-2);
    expect(lastTwo.map((m: any) => m.context.sourceIds)).toEqual([[], []]);
  });

  test('an unsupported persisted tool cannot execute through an older confirmation client',async()=>{
    __setAiClientForTests({async *chatStreamAgentic(){yield {type:'finish',reason:'stop'};}});
    const {cookie,userId}=await signUpAndCookie(app,uniqueEmail());
    const [deck]=await db.insert(decks).values({userId,name:'Preserved'}).returning();
    const thread=await (await callApp(app,'POST','/chat/conversations',{cookie,body:{}})).json<any>();
    await db.insert(messages).values([
      {userId,conversationId:thread.id,role:'user',content:'Old request',createdAt:new Date(1000)},
      {userId,conversationId:thread.id,role:'assistant',content:'',toolCalls:[{id:'future-call',name:'future_destructive_operation',arguments:JSON.stringify({id:deck!.id})}],createdAt:new Date(2000)},
    ]);
    const result=await callApp(app,'POST',`/chat/conversations/${thread.id}/resume`,{cookie,body:{resumeToolCallId:'future-call',decision:'apply'}});
    expect((await result.text())).toContain('not a confirmable tool');
    expect(await db.select().from(decks).where(eq(decks.id,deck!.id))).toHaveLength(1);
  });
});

test('typed continuation cannot widen an unresolved legacy notebook selection to all sources',async()=>{
  await resetTestDb();const {notebooks}=await import('@reomi/db');
  const {cookie,userId}=await signUpAndCookie(app,uniqueEmail());
  const [notebook]=await db.insert(notebooks).values({userId,title:'Legacy notebook'}).returning();
  const thread=await(await callApp(app,'POST','/chat/conversations',{cookie,body:{notebookId:notebook!.id}})).json<any>();
  await db.insert(messages).values({userId,conversationId:thread.id,role:'user',content:'Historical question without stored selection'});
  let runs=0;__setAiClientForTests({async *chatStreamAgentic(){runs++;yield {type:'content',text:'Done'};yield {type:'finish',reason:'stop'};}});
  try{
    const missing=await callApp(app,'POST',`/chat/conversations/${thread.id}/stream`,{cookie,body:{content:'Continue',context:{version:1,policy:'strict',refs:[]}}});
    expect(missing.status).toBe(400);expect(await missing.json()).toEqual({error:'context_selection_required'});expect(runs).toBe(0);
    const explicit=await callApp(app,'POST',`/chat/conversations/${thread.id}/stream`,{cookie,body:{content:'Continue',context:{version:1,policy:'strict',refs:[{kind:'notebook',id:notebook!.id,sourceIds:[]}]}}});
    expect(explicit.status).toBe(200);expect(await explicit.text()).toContain('event: done');
  }finally{__resetAiClientForTests();}
});
