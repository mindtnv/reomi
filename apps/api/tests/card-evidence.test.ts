import { beforeEach, expect, test } from 'bun:test';
import { db, ensureBuiltins, sources, sourceChunks, cardSources, cards, decks } from '@reomi/db';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app';
import { resetTestDb, seedBasicCard, signUpAndCookie, uniqueEmail } from './helpers';
import { captureCardEvidence, writePerCardProvenance } from '../src/ai/card-evidence';
beforeEach(async () => { await resetTestDb(); await ensureBuiltins(db); });
async function fixture() {
  const app = buildApp(), { userId, cookie } = await signUpAndCookie(app, uniqueEmail());
  const [deck] = await db.insert(decks).values({ userId, name: 'Study' }).returning();
  const a = await seedBasicCard(app,cookie,{deckId:deck!.id,front:'A',back:'Answer A'}), b = await seedBasicCard(app,cookie,{deckId:deck!.id,front:'B',back:'Answer B'});
  const [source] = await db.insert(sources).values({ userId, kind: 'text', title: 'Original source' }).returning();
  const chunks = await db.insert(sourceChunks).values([{ userId, sourceId: source!.id, position: 0, text: 'Evidence A' }, { userId, sourceId: source!.id, position: 1, text: 'Evidence B' }]).returning();
  return { userId, cookie, deckId: deck!.id, a, b, source: source!, chunks };
}
test('card-specific evidence links different cards to their own passages and survives source deletion', async () => {
  const f = await fixture(), read = f.chunks.map(c => c.id);
  const first = await captureCardEvidence(f.userId,[read[0]!],read), second = await captureCardEvidence(f.userId,[read[1]!],read);
  await db.transaction(tx => writePerCardProvenance(tx,{ userId:f.userId, cards:[{ cardIds:[f.a.id], evidence:first },{ cardIds:[f.b.id], evidence:second }] }));
  let links = await db.select().from(cardSources).where(eq(cardSources.userId,f.userId));
  expect(links).toHaveLength(2);
  expect(links.find(l => l.cardId === f.a.id)!.sourceChunkId).toBe(read[0]);
  expect(links.find(l => l.cardId === f.b.id)!.sourceChunkId).toBe(read[1]);
  const { callApp } = await import('./helpers');
  const app = buildApp();
  const before = await callApp(app,'GET',`/cards/${f.a.id}/sources`,{cookie:f.cookie});
  expect((await before.json<any>()).items[0].locationAvailable).toBe(true);
  await db.delete(sources).where(eq(sources.id,f.source.id));
  links = await db.select().from(cardSources).where(eq(cardSources.userId,f.userId));
  expect(links.every(l => l.sourceId === null && l.sourceChunkId === null)).toBe(true);
  expect(links.find(l => l.cardId === f.a.id)!.sourceSnapshot!.quote).toBe('Evidence A');
  expect(links[0]!.sourceSnapshot!.sourceTitle).toBe('Original source');
  const after = await callApp(app,'GET',`/cards/${f.a.id}/sources`,{cookie:f.cookie});
  const historical = (await after.json<any>()).items[0];
  expect(historical.locationAvailable).toBe(false); expect(historical.sourceTitle).toBe('Original source'); expect(historical.snippet).toBe('Evidence A');
});
test('unread, foreign and changed evidence cannot be applied; a failed transaction leaves no links', async () => {
  const f = await fixture(), foreign = await fixture(), id = f.chunks[0]!.id;
  await expect(captureCardEvidence(f.userId,[id],[])).rejects.toThrow();
  await expect(captureCardEvidence(f.userId,[foreign.chunks[0]!.id],[foreign.chunks[0]!.id])).rejects.toThrow();
  const evidence = await captureCardEvidence(f.userId,[id],[id]);
  await expect(db.transaction(async tx => { await writePerCardProvenance(tx,{ userId:f.userId, cards:[{cardIds:[f.a.id],evidence}] }); throw new Error('rollback'); })).rejects.toThrow('rollback');
  expect(await db.select().from(cardSources).where(eq(cardSources.userId,f.userId))).toHaveLength(0);
  await db.update(sourceChunks).set({text:'Changed'}).where(eq(sourceChunks.id,id));
  await expect(db.transaction(tx => writePerCardProvenance(tx,{ userId:f.userId,cards:[{cardIds:[f.a.id],evidence}] }))).rejects.toThrow('stale_evidence');
  expect(await db.select().from(cardSources).where(eq(cardSources.userId,f.userId))).toHaveLength(0);
});

for (const stale of [false,true,'before'] as const) test(`source-only assistant proposal ${stale === 'before' ? 'rejects changes since reading' : stale ? 'rejects stale evidence' : 'applies only included card evidence'}`, async () => {
  const { __setAiClientForTests, __resetAiClientForTests } = await import('../src/ai/openai-client');
  const { callApp } = await import('./helpers');
  const f = await fixture(), app = buildApp(); let step = 0;
  __setAiClientForTests({ async *chatStreamAgentic() {
    const call = step++ === 0 ? { name:'read_source_chunks',id:'read',args:{id:f.source.id} }
      : step === 2 ? {name:'create_card',id:'make',args:{deckId:f.deckId,cards:[
        {fieldValues:{Front:'First',Back:'A'},evidenceChunkIds:[f.chunks[0]!.id]},
        {fieldValues:{Front:'Second',Back:'B'},evidenceChunkIds:[f.chunks[1]!.id]},
      ]}} : null;
    if (stale === 'before' && step === 2) await db.update(sourceChunks).set({text:'Changed since reading'}).where(eq(sourceChunks.id,f.chunks[0]!.id));
    if(call){yield {type:'tool_call_delta',index:0,id:call.id,name:call.name,argsFragment:JSON.stringify(call.args)};yield {type:'finish',reason:'tool_calls'};}
    else {yield {type:'content',text:'Done'};yield {type:'finish',reason:'stop'};}
  }});
  try {
    const thread = await (await callApp(app,'POST','/chat/conversations',{cookie:f.cookie,body:{context:{version:1,refs:[{kind:'source',id:f.source.id}]}}})).json<any>();
    const proposal = await callApp(app,'POST',`/chat/conversations/${thread.id}/stream`,{cookie:f.cookie,body:{content:'Create two cards from those passages'}});
    const text = await proposal.text();
    if (stale === 'before') { expect(text).toContain('invalid_evidence'); expect(text).not.toContain('await_confirmation'); expect(await db.select().from(cardSources).where(eq(cardSources.userId,f.userId))).toHaveLength(0); return; }
    expect(text).toContain('cardEvidence'); expect(text).toContain('await_confirmation');
    if (stale) await db.update(sourceChunks).set({text:'Changed after preview'}).where(eq(sourceChunks.id,f.chunks[0]!.id));
    const apply = await callApp(app,'POST',`/chat/conversations/${thread.id}/resume`,{cookie:f.cookie,body:{resumeToolCallId:'make',decision:'apply',cardSelections:[{index:1,include:false}]}});
    const applied = await apply.text(); expect(applied).toContain('event: done');
    if (stale) expect(applied).toContain('stale_evidence');
    const links = await db.select().from(cardSources).where(eq(cardSources.userId,f.userId));
    expect(links).toHaveLength(stale ? 0 : 1);
    if (stale) expect(await db.select().from(cards).where(eq(cards.userId,f.userId))).toHaveLength(2);
    else {
      expect(links[0]!.sourceChunkId).toBe(f.chunks[0]!.id); expect(links[0]!.conversationId).toBe(thread.id);
      const beforeReplay = await db.select({ id: cards.id }).from(cards).where(eq(cards.userId, f.userId));
      const replay = await callApp(app, 'POST', `/chat/conversations/${thread.id}/resume`, { cookie: f.cookie, body: { resumeToolCallId: 'make', decision: 'apply' } });
      expect(replay.status).toBe(200); await replay.text();
      expect(await db.select({ id: cards.id }).from(cards).where(eq(cards.userId, f.userId))).toEqual(beforeReplay);
      expect(await db.select().from(cardSources).where(eq(cardSources.userId, f.userId))).toEqual(links);
    }
  } finally { __resetAiClientForTests(); }
});

for(const deletedNotebook of [false,true]) test(`legacy pending grounding survives ${deletedNotebook?'notebook deletion':'reopening'}`, async () => {
  const { __setAiClientForTests, __resetAiClientForTests } = await import('../src/ai/openai-client');
  const { callApp } = await import('./helpers');
  const { notebooks, notebookSources, messages, conversations } = await import('@reomi/db');
  const f = await fixture(), app = buildApp();
  const [notebook] = await db.insert(notebooks).values({userId:f.userId,title:'Legacy notebook'}).returning();
  await db.update(sources).set({status:'ready'}).where(eq(sources.id,f.source.id));
  await db.insert(notebookSources).values({userId:f.userId,notebookId:notebook!.id,sourceId:f.source.id});
  const thread = await (await callApp(app,'POST','/chat/conversations',{cookie:f.cookie,body:{notebookId:notebook!.id}})).json<any>();
  await db.insert(messages).values({userId:f.userId,conversationId:thread.id,role:'assistant',content:'',
    toolCalls:[{id:'legacy-create',name:'create_card',arguments:JSON.stringify({deckId:f.deckId,fieldValues:{Front:'Legacy question',Back:'Answer'}})}],
    grounding:{chunkIds:[f.chunks[0]!.id]}});
  if(deletedNotebook){await db.delete(notebooks).where(eq(notebooks.id,notebook!.id));await db.update(conversations).set({contextPolicy:'focus',contextVersion:1}).where(eq(conversations.id,thread.id));}
  let step=0;__setAiClientForTests({async *chatStreamAgentic(){if(deletedNotebook && step++===0){yield {type:'tool_call_delta',index:0,id:'outside',name:'read_source_chunks',argsFragment:JSON.stringify({id:f.source.id})};yield {type:'finish',reason:'tool_calls'};}else{yield {type:'content',text:'Done'};yield {type:'finish',reason:'stop'};}}});
  try {
    const response = await callApp(app,'POST',`/chat/conversations/${thread.id}/resume`,{cookie:f.cookie,body:{resumeToolCallId:'legacy-create',decision:'apply',sourceIds:[f.source.id]}});
    const frames=await response.text();expect(frames).toContain('event: done');if(deletedNotebook)expect(frames).toContain('outside_context');
    const links = await db.select().from(cardSources).where(eq(cardSources.userId,f.userId));
    expect(links).toHaveLength(1); expect(links[0]!.sourceChunkId).toBe(f.chunks[0]!.id);
    expect(links[0]!.sourceSnapshot).toMatchObject({ kind: 'chunk', sourceId: f.source.id, sourceTitle: f.source.title, quote: f.chunks[0]!.text });
    await db.delete(sources).where(eq(sources.id, f.source.id));
    const [retained] = await db.select().from(cardSources).where(eq(cardSources.id, links[0]!.id));
    expect(retained!.sourceSnapshot).toEqual(links[0]!.sourceSnapshot);
  } finally {__resetAiClientForTests();}
});

test('an explicitly supplied unanchored quote stays source-level and is never presented as a verified chunk', async () => {
  const { captureQuotedEvidence } = await import('../src/ai/card-evidence');
  const f = await fixture(), quote = 'My excerpt from the illustrated page';
  const supplied = [{ ref: { kind: 'source_passage' as const, id: f.source.id, locator: { quote } }, label: 'Original source', available: true, excerpt: quote, verifiedQuote: false }];
  const evidence = await captureQuotedEvidence(f.userId,[{ sourceId:f.source.id,quote }],supplied);
  expect(evidence[0]!.kind).toBe('user_quote');
  await db.transaction(tx => writePerCardProvenance(tx,{ userId:f.userId,cards:[{ cardIds:[f.a.id],evidence }] }));
  const [link] = await db.select().from(cardSources).where(eq(cardSources.cardId,f.a.id));
  expect(link!.sourceChunkId).toBeNull();expect(link!.sourceId).toBe(f.source.id);expect(link!.sourceSnapshot!.quote).toBe(quote);
  await expect(captureQuotedEvidence(f.userId,[{sourceId:f.source.id,quote:'An invented quote'}],supplied)).rejects.toThrow('invalid_evidence');
  await db.delete(sources).where(eq(sources.id,f.source.id));
  const [retained] = await db.select().from(cardSources).where(eq(cardSources.cardId,f.a.id));
  expect(retained!.sourceSnapshot!.quote).toBe(quote);expect(retained!.sourceId).toBeNull();
});

test('the assistant can save supplied quote-only evidence without inventing a chunk', async () => {
  const { __setAiClientForTests, __resetAiClientForTests } = await import('../src/ai/openai-client');
  const { callApp } = await import('./helpers');
  const f = await fixture(), app = buildApp(), quote = 'My quote from an illustration'; let step=0;
  __setAiClientForTests({async *chatStreamAgentic(){
    if(step++===0){yield {type:'tool_call_delta',index:0,id:'quote-card',name:'create_card',argsFragment:JSON.stringify({deckId:f.deckId,fieldValues:{Front:'Question',Back:'Answer'},evidenceQuotes:[{sourceId:f.source.id,quote}]})};yield {type:'finish',reason:'tool_calls'};}
    else {yield {type:'content',text:'Done'};yield {type:'finish',reason:'stop'};}
  }});
  try {
    const thread=await(await callApp(app,'POST','/chat/conversations',{cookie:f.cookie,body:{context:{version:1,refs:[{kind:'source_passage',id:f.source.id,locator:{quote}}]}}})).json<any>();
    const proposal=await callApp(app,'POST',`/chat/conversations/${thread.id}/stream`,{cookie:f.cookie,body:{content:'Make a card about this excerpt'}});
    expect(await proposal.text()).toContain('user_quote');
    const applied=await callApp(app,'POST',`/chat/conversations/${thread.id}/resume`,{cookie:f.cookie,body:{resumeToolCallId:'quote-card',decision:'apply'}});
    expect(await applied.text()).toContain('event: done');
    const links=await db.select().from(cardSources).where(eq(cardSources.userId,f.userId));
    expect(links).toHaveLength(1);expect(links[0]!.sourceChunkId).toBeNull();expect(links[0]!.sourceSnapshot!.quote).toBe(quote);
  } finally {__resetAiClientForTests();}
});

test('a verified supplied passage can ground a card without a redundant read tool call', async () => {
  const { __setAiClientForTests, __resetAiClientForTests } = await import('../src/ai/openai-client');
  const { callApp } = await import('./helpers');
  const f=await fixture(), app=buildApp();let step=0;
  __setAiClientForTests({async *chatStreamAgentic(){
    if(step++===0){yield {type:'tool_call_delta',index:0,id:'supplied-card',name:'create_card',argsFragment:JSON.stringify({deckId:f.deckId,fieldValues:{Front:'What evidence?',Back:'Evidence A'},evidenceChunkIds:[f.chunks[0]!.id]})};yield {type:'finish',reason:'tool_calls'};}
    else {yield {type:'content',text:'Done'};yield {type:'finish',reason:'stop'};}
  }});
  try {
    const thread=await(await callApp(app,'POST','/chat/conversations',{cookie:f.cookie,body:{context:{version:1,refs:[{kind:'source_passage',id:f.source.id,locator:{chunkId:f.chunks[0]!.id,quote:'Evidence A'}}]}}})).json<any>();
    const proposal=await callApp(app,'POST',`/chat/conversations/${thread.id}/stream`,{cookie:f.cookie,body:{content:'Make a card from this quote'}});
    expect(await proposal.text()).toContain('await_confirmation');
    const applied = await callApp(app,'POST',`/chat/conversations/${thread.id}/resume`,{cookie:f.cookie,body:{resumeToolCallId:'supplied-card',decision:'apply'}});
    expect(await applied.text()).not.toContain('\"ok\":false');
    const links=await db.select().from(cardSources).where(eq(cardSources.userId,f.userId));
    expect(links).toHaveLength(1);expect(links[0]!.sourceSnapshot!.quote).toBe('Evidence A');
  } finally {__resetAiClientForTests();}
});

test('supplied evidence excludes adjacent chunks and stops being eligible when its version changes', async () => {
  const { captureSuppliedEvidence } = await import('../src/ai/card-evidence');
  const { resolveAssistantRefs } = await import('../src/ai/assistant-context');
  const f=await fixture();
  const refs=await resolveAssistantRefs(f.userId,[{kind:'source_passage',id:f.source.id,locator:{chunks:f.chunks.map(chunk=>({chunkId:chunk.id})),quote:'Evidence A'}}]);
  expect(refs[0]!.verifiedQuote).toBe(true);
  const supplied=await captureSuppliedEvidence(f.userId,refs);
  expect(supplied.map(item=>item.chunkId)).toEqual([f.chunks[0]!.id]);expect(supplied[0]!.quote).toBe('Evidence A');
  await db.update(sourceChunks).set({text:'Changed source text'}).where(eq(sourceChunks.id,f.chunks[0]!.id));
  expect(await captureSuppliedEvidence(f.userId,refs)).toEqual([]);
});

for(const staleAfterNote of [false,true]) test(`read evidence ${staleAfterNote?'rejects changes after':'survives'} an intermediate confirmation`,async()=>{
  const {__setAiClientForTests,__resetAiClientForTests}=await import('../src/ai/openai-client');const {callApp}=await import('./helpers');
  const f=await fixture(),app=buildApp();let step=0;
  const calls=[{id:'read',name:'read_source_chunks',args:{id:f.source.id}},{id:'note',name:'save_source_note',args:{sourceId:f.source.id,title:'Note',content:'Conclusions'}},
    {id:'card-after-note',name:'create_card',args:{deckId:f.deckId,fieldValues:{Front:'Question',Back:'Evidence A'},evidenceChunkIds:[f.chunks[0]!.id]}}];
  __setAiClientForTests({async *chatStreamAgentic(){const call=calls[step++];if(staleAfterNote && call?.id==='card-after-note')await db.update(sourceChunks).set({text:'Changed after the first confirmation'}).where(eq(sourceChunks.id,f.chunks[0]!.id));if(call){yield {type:'tool_call_delta',index:0,id:call.id,name:call.name,argsFragment:JSON.stringify(call.args)};yield {type:'finish',reason:'tool_calls'};}else{yield {type:'content',text:'Done'};yield {type:'finish',reason:'stop'};}}});
  try{
    const thread=await(await callApp(app,'POST','/chat/conversations',{cookie:f.cookie,body:{context:{version:1,refs:[{kind:'source',id:f.source.id}]}}})).json<any>();
    const first=await callApp(app,'POST',`/chat/conversations/${thread.id}/stream`,{cookie:f.cookie,body:{content:'Save a note and create a card from the material'}});
    expect(await first.text()).toContain('await_confirmation');
    const continued=await callApp(app,'POST',`/chat/conversations/${thread.id}/resume`,{cookie:f.cookie,body:{resumeToolCallId:'note',decision:'apply'}});
    const continuation=await continued.text();
    if(staleAfterNote){expect(continuation).toContain('invalid_evidence');expect(await db.select().from(cardSources).where(eq(cardSources.userId,f.userId))).toHaveLength(0);return;}
    expect(continuation).toContain('await_confirmation');
    const applied=await callApp(app,'POST',`/chat/conversations/${thread.id}/resume`,{cookie:f.cookie,body:{resumeToolCallId:'card-after-note',decision:'apply'}});
    expect(await applied.text()).toContain('event: done');
    const links=await db.select().from(cardSources).where(eq(cardSources.userId,f.userId));expect(links).toHaveLength(1);expect(links[0]!.sourceChunkId).toBe(f.chunks[0]!.id);
  }finally{__resetAiClientForTests();}
});

test('modern evidence snapshots preserve valid Unicode at the title and quote budgets', async () => {
  const f = await fixture();
  await db.update(sources).set({ title: 'T'.repeat(199) + '🧠extra' }).where(eq(sources.id, f.source.id));
  await db.update(sourceChunks).set({ text: 'Q'.repeat(319) + '🧠extra' }).where(eq(sourceChunks.id, f.chunks[0]!.id));
  const evidence = await captureCardEvidence(f.userId, [f.chunks[0]!.id], [f.chunks[0]!.id]);
  expect(evidence[0]!.sourceTitle).toBe('T'.repeat(199)); expect(evidence[0]!.quote).toBe('Q'.repeat(319));
  await db.transaction(tx => writePerCardProvenance(tx, { userId: f.userId, cards: [{ cardIds: [f.a.id], evidence }] }));
  const [row] = await db.select().from(cardSources).where(eq(cardSources.cardId, f.a.id));
  expect(row!.sourceSnapshot).toEqual(evidence[0]!);
});
