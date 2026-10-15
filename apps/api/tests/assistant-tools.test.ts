import { afterEach, beforeEach, expect, test } from 'bun:test';
import { cards, db, decks, reviews, sources, sourceChunks, user } from '@reomi/db';
import { eq } from 'drizzle-orm';
import { newUuidV7, type AssistantContextSnapshot } from '@reomi/shared';
import { buildToolRegistry, type ToolContext } from '../src/ai/tools';
import { rootLogger } from '../src/logger';
import { callApp, resetTestDb, seedBasicCard, signUpAndCookie, uniqueEmail } from './helpers';
import { buildApp } from '../src/app';
import { __setAiClientForTests, __resetAiClientForTests } from '../src/ai/openai-client';

beforeEach(resetTestDb);
afterEach(__resetAiClientForTests);

test('strict progress tools do not expand a frozen deck selection after another deck is moved under it', async () => {
  const app = buildApp();
  const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
  const [selected, moved] = await db.insert(decks).values([
    { userId, name: 'Selected' }, { userId, name: 'Later moved' },
  ]).returning();
  const card = await seedBasicCard(app, cookie, { deckId: moved!.id, front: 'Outside', back: 'Evidence' });
  await db.insert(reviews).values({ userId, cardId: card.id, deckId: moved!.id, rating: 3,
    nextDue: new Date(), nextStability: 1, nextDifficulty: 5 });
  await db.update(cards).set({ state: 'review', due: new Date(Date.now() + 86400000) }).where(eq(cards.id, card.id));
  const context: AssistantContextSnapshot = { version: 1, revision: 0, policy: 'strict',
    sourceIds: [], deckIds: [selected!.id],
    refs: [{ ref: { kind: 'deck', id: selected!.id }, label: 'Selected', available: true }] };
  await db.update(decks).set({ parentId: selected!.id }).where(eq(decks.id, moved!.id));
  const ctx: ToolContext = { userId, log: rootLogger, assistantContext: context };
  const registry = buildToolRegistry();
  for (const [name, args, empty, populated] of [
    ['study_stats', { scope: 'deck', deckId: selected!.id }, 'No reviews recorded', 'Reviews: 1'],
    ['due_forecast', { deckId: selected!.id }, 'No reviews scheduled', '1 reviews due'],
  ] as const) {
    const tool = registry.find(t => t.name === name)!;
    const strict = await tool.execute(ctx, args);
    expect(strict.ok).toBe(true);
    if (strict.ok) expect(strict.text).toContain(empty);
    const focus = await tool.execute({ ...ctx, assistantContext: { ...context, policy: 'focus' } }, args);
    expect(focus.ok).toBe(true);
    if (focus.ok) expect(focus.text).toContain(populated);
  }
  await db.update(cards).set({ due: new Date(Date.now() - 1000) }).where(eq(cards.id, card.id));
  await db.insert(reviews).values({ userId, cardId: card.id, deckId: moved!.id, rating: 3,
    reviewedAt: new Date(Date.now() - 86400000), nextDue: new Date(), nextStability: 1, nextDifficulty: 5 });
  for (const name of ['get_review_queue', 'get_retention']) {
    const tool = registry.find(t => t.name === name)!;
    const result = await tool.execute(ctx, { deckId: selected!.id });
    expect(result.ok).toBe(true);
    if (!result.ok) continue;
    const value = JSON.parse(result.text);
    if (name === 'get_review_queue') {
      expect(value.total).toBe(0);
      expect(result.text).not.toContain(card.id);
    } else expect(value.buckets.every((b: { count: number }) => b.count === 0)).toBe(true);
    const focus = await tool.execute({ ...ctx, assistantContext: { ...context, policy: 'focus' } }, { deckId: selected!.id });
    expect(focus.ok).toBe(true);
    if (!focus.ok) continue;
    const unrestricted = JSON.parse(focus.text);
    if (name === 'get_review_queue') expect(unrestricted.total).toBe(1);
    else expect(unrestricted.buckets.some((b: { count: number }) => b.count > 0)).toBe(true);
  }
});

test('strict statistics cannot request global history using an allowed deck as a decoy', async () => {
  const owner = newUuidV7();
  await db.insert(user).values({ id: owner, name: 'Owner', email: `${owner}@test.dev` });
  const [deck] = await db.insert(decks).values({ userId: owner, name: 'Selected' }).returning();
  const context: AssistantContextSnapshot = {
    version: 1, revision: 0, policy: 'strict', sourceIds: [], deckIds: [deck!.id],
    refs: [{ ref: { kind: 'deck', id: deck!.id }, label: 'Selected', available: true }],
  };
  const ctx: ToolContext = { userId: owner, log: rootLogger, assistantContext: context };
  const stats = buildToolRegistry().find(t => t.name === 'study_stats')!;
  for (const args of [{ scope: 'global', deckId: deck!.id }, { deckId: deck!.id }]) {
    const result = await stats.execute(ctx, args);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('outside_context');
  }
  const allowed = await stats.execute(ctx, { scope: 'deck', deckId: deck!.id });
  expect(allowed.ok).toBe(true);
  const focus = await stats.execute({ ...ctx, assistantContext: { ...context, policy: 'focus' } }, { scope: 'global' });
  expect(focus.ok).toBe(true);
});
test('normal chat surfaces share one deduplicated catalog while MCP keeps its legacy adapter boundary', () => {
  const global = buildToolRegistry({ webSearchEnabled: false, fetchPageEnabled: false });
  const notebook = buildToolRegistry({ notebook: true, webSearchEnabled: false, fetchPageEnabled: false });
  expect(notebook.map(t => t.name).sort()).toEqual(global.map(t => t.name).sort());
  expect(new Set(global.map(t => t.name)).size).toBe(global.length);
  expect(global.map(t => t.name)).toContain('create_deck');
  expect(global.map(t => t.name)).toContain('read_source');
  expect(buildToolRegistry({ notebook: true, knowledge: false }).map(t => t.name)).toContain('save_note');
});

test('source conversation can create a deck, and resume retains its original strict scope after pins change', async () => {
  const app = buildApp();
  const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
  const [a,b] = await db.insert(sources).values([
    { userId, kind: 'text', title: 'Original', status: 'ready' }, { userId, kind: 'text', title: 'Replacement', status: 'ready' },
  ]).returning();
  await db.insert(sourceChunks).values([
    { userId, sourceId: a!.id, position: 0, text: 'Original evidence' },
    { userId, sourceId: b!.id, position: 0, text: 'Outside evidence must remain unread' },
  ]);
  let step = 0;
  const calls = [
    { id: 'read_first', name: 'read_source', args: { sourceId: a!.id } },
    { id: 'make_deck', name: 'create_deck', args: { name: 'From source' } },
    { id: 'outside', name: 'read_source_chunks', args: { id: b!.id } },
    { id: 'inside', name: 'read_source', args: { sourceId: a!.id } },
  ];
  __setAiClientForTests({ async *chatStreamAgentic() {
    const call = calls[step++];
    if (call) {
      yield { type: 'tool_call_delta', index: 0, id: call.id, name: call.name, argsFragment: JSON.stringify(call.args) };
      yield { type: 'finish', reason: 'tool_calls' };
    } else { yield { type: 'content', text: 'Done' }; yield { type: 'finish', reason: 'stop' }; }
  } });
  const thread = await (await callApp(app, 'POST', '/chat/conversations', { cookie, body: {
    context: { version: 1, policy: 'strict', refs: [{ kind: 'source', id: a!.id }] },
  } })).json<any>();
  const first = await callApp(app, 'POST', `/chat/conversations/${thread.id}/stream`, { cookie, body: { content: 'Read and create a deck' } });
  const firstFrames = await first.text();
  expect(firstFrames).toContain('await_confirmation');
  expect(firstFrames).toContain('Original evidence');
  await callApp(app, 'PATCH', `/chat/conversations/${thread.id}`, { cookie, body: {
    expectedContextRevision: 0, context: { version: 1, policy: 'focus', refs: [{ kind: 'source', id: b!.id }] },
  } });
  const resumed = await callApp(app, 'POST', `/chat/conversations/${thread.id}/resume`, { cookie,
    body: { resumeToolCallId: 'make_deck', decision: 'apply' } });
  const frames = await resumed.text();
  expect(frames).toContain('outside_context');
  expect(frames).toContain('Original evidence');
  expect(frames).not.toContain('Outside evidence must remain unread');
  expect(frames).toContain('event: done');
  const detail = await (await callApp(app, 'GET', `/chat/conversations/${thread.id}`, { cookie })).json<any>();
  const pending = detail.messages.find((m: any) => m.toolCalls?.some((c: any) => c.id === 'make_deck'));
  expect(pending.context.policy).toBe('strict');
  expect(pending.context.sourceIds).toEqual([a!.id]);
});

test('focus conversation can read supplementary owned material and tells the model to distinguish its evidence', async () => {
  const app = buildApp();
  const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
  const [a,b] = await db.insert(sources).values([
    { userId, kind: 'text', title: 'Primary', status: 'ready' }, { userId, kind: 'text', title: 'Supplementary', status: 'ready' },
  ]).returning();
  await db.insert(sourceChunks).values({ userId, sourceId: b!.id, position: 0, text: 'Additional evidence from another owned source' });
  let system = '', step = 0;
  __setAiClientForTests({ async *chatStreamAgentic(messages) {
    system = String(messages[0]!.content);
    if (step++ === 0) {
      yield { type: 'tool_call_delta', index: 0, id: 'read_supplement', name: 'read_source_chunks', argsFragment: JSON.stringify({ id: b!.id }) };
      yield { type: 'finish', reason: 'tool_calls' };
    } else { yield { type: 'content', text: 'Additional explanation.' }; yield { type: 'finish', reason: 'stop' }; }
  } });
  const thread = await (await callApp(app, 'POST', '/chat/conversations', { cookie, body: { context: {
    version: 1, refs: [{ kind: 'source', id: a!.id }],
  } } })).json<any>();
  const response = await callApp(app, 'POST', `/chat/conversations/${thread.id}/stream`, { cookie, body: { content: 'Help me understand, using additional material if useful' } });
  const frames = await response.text();
  expect(system).toContain('Current context policy: focus');
  expect(system).toContain('Clearly distinguish supplementary explanation');
  expect(frames).toContain('Additional evidence from another owned source');
  expect(frames).not.toContain('outside_context');
});

test('standalone source reading works without notebook or embeddings and strict scope guards curated aliases', async () => {
  const owner = newUuidV7();
  await db.insert(user).values({ id: owner, name: 'Owner', email: `${owner}@test.dev` });
  const [a,b] = await db.insert(sources).values([
    { userId: owner, kind: 'text', title: 'Selected source', status: 'error', errorCode: 'index_failed' },
    { userId: owner, kind: 'text', title: 'Unselected source', status: 'ready' },
  ]).returning();
  await db.insert(sourceChunks).values([
    { userId: owner, sourceId: a!.id, position: 0, text: 'Selected readable passage' },
    { userId: owner, sourceId: b!.id, position: 0, text: 'Never read this outside scope' },
  ]);
  const context: AssistantContextSnapshot = { version: 1, revision: 0, policy: 'strict', sourceIds: [a!.id], deckIds: [],
    refs: [{ ref: { kind: 'source', id: a!.id }, label: a!.title, available: true }] };
  const ctx: ToolContext = { userId: owner, log: rootLogger, assistantContext: context, grounding: { chunkIds: [] } };
  const registry = buildToolRegistry({ webSearchEnabled: false, fetchPageEnabled: false });
  const read = registry.find(t => t.name === 'read_source')!;
  expect(read).toBeDefined();
  const result = await read.execute(ctx, { sourceId: a!.id });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.text).toContain('Selected readable passage');
  for (const [name,args] of [
    ['read_source', { sourceId: b!.id }], ['read_source_chunks', { id: b!.id }],
    ['get_source_marks', { id: b!.id }], ['get_source_annotations', { id: b!.id }],
  ] as const) {
    const denied = await registry.find(t => t.name === name)!.execute(ctx,args);
    expect(denied.ok).toBe(false);
    expect(JSON.stringify(denied)).not.toContain('Never read');
  }
  const focus = await read.execute({ ...ctx, assistantContext: { ...context, policy: 'focus' } }, { sourceId: b!.id });
  expect(focus.ok).toBe(true);
  const empty = await read.execute({ ...ctx, assistantContext: { ...context, refs: [], sourceIds: [] } }, { sourceId: a!.id });
  expect(empty.ok).toBe(false);
  const semantic = await registry.find(t => t.name === 'search_source')!.execute(ctx, { query: 'passage' });
  expect(semantic.ok).toBe(false);
  if (!semantic.ok) expect(semantic.error).toContain('embeddings_unavailable');
});

test('a strict notebook context reads an explicitly selected parsed source before embeddings finish', async () => {
  const { notebooks, notebookSources } = await import('@reomi/db');
  const app = buildApp(), { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
  const [notebook] = await db.insert(notebooks).values({ userId, title: 'Parsed collection' }).returning();
  const [source] = await db.insert(sources).values({ userId, kind: 'text', title: 'Parsed source', status: 'indexing' }).returning();
  await db.insert(sourceChunks).values({ userId, sourceId: source!.id, position: 0, text: 'Readable before embeddings finish.' });
  await db.insert(notebookSources).values({ userId, notebookId: notebook!.id, sourceId: source!.id });
  let step = 0, observed = '';
  __setAiClientForTests({ async *chatStreamAgentic(history) {
    if (step++ === 0) {
      yield { type: 'tool_call_delta', index: 0, id: 'parsed-read', name: 'read_source', argsFragment: JSON.stringify({ sourceId: source!.id }) };
      yield { type: 'finish', reason: 'tool_calls' };
    } else {
      observed = String(history.findLast(message => message.role === 'tool')?.content);
      yield { type: 'content', text: 'Read the selected source.' }; yield { type: 'finish', reason: 'stop' };
    }
  } });
  const thread = await (await callApp(app, 'POST', '/chat/context-v1/conversations', { cookie, body: { title: 'Parsed scope', context: {
    version: 1, policy: 'strict', refs: [{ kind: 'notebook', id: notebook!.id, sourceIds: [source!.id] }],
  } } })).json<any>();
  const response = await callApp(app, 'POST', `/chat/context-v1/conversations/${thread.id}/stream`, { cookie, body: { content: 'Read the selected passage.' } });
  expect(response.status).toBe(200); await response.text();
  expect(observed).toContain('Readable before embeddings finish.');
  const detail = await (await callApp(app, 'GET', `/chat/context-v1/conversations/${thread.id}`, { cookie })).json<any>();
  const question = detail.messages.find((message: any) => message.role === 'user');
  expect(question.context.policy).toBe('strict'); expect(question.context.sourceIds).toEqual([source!.id]);
});
