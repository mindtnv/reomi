import { beforeEach, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db, notebooks } from '@reomi/db';
import { buildApp } from '../src/app.ts';
import { buildToolRegistry, type ToolContext } from '../src/ai/tools.ts';
import { rootLogger } from '../src/logger.ts';
import { resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';
const app = buildApp();
beforeEach(resetTestDb);
const tool = (name: string) => { const found = buildToolRegistry({ webSearchEnabled: false, fetchPageEnabled: false }).find(t => t.name === name); expect(found).toBeDefined(); return found!; };
test('global knowledge registry is complete and notebook mode keeps its scope', () => {
  for (const name of ['list_library','read_source_chunks','list_notebooks','get_notebook','save_note','create_notebook','attach_source','create_text_source','update_source']) tool(name);
  const names = buildToolRegistry().map(t=>t.name);
  expect(new Set(names).size).toBe(names.length);
  expect(buildToolRegistry({ notebook: true }).map(t=>t.name).sort()).toEqual([...names].sort());
});
test('reads and previews are user-scoped; write requires matching confirmation', async () => {
  const a = await signUpAndCookie(app, uniqueEmail()), b = await signUpAndCookie(app, uniqueEmail());
  const [foreign] = await db.insert(notebooks).values({userId:b.userId,title:'Private notebook'}).returning();
  const ctx: ToolContext = { userId:a.userId,log:rootLogger };
  expect((await tool('get_notebook').execute(ctx,{id:foreign!.id})).ok).toBe(false);
  expect((await tool('update_notebook').validate!(ctx,{id:foreign!.id,title:'wrong'})).ok).toBe(false);
  const create = tool('create_notebook'), args={title:'Created through chat'};
  const preview = await create.dryRun!(ctx,args);
  expect(preview.resourcePreview?.fields.some(f=>f.after==='Created through chat')).toBe(true);
  expect((await create.execute(ctx,args)).ok).toBe(false);
  const result = await db.transaction(tx=>create.execute({...ctx,tx,confirmationHash:preview.snapshotHash},args));
  expect(result.ok).toBe(true);
  expect(await db.select().from(notebooks).where(eq(notebooks.userId,a.userId))).toHaveLength(1);
});
test('stale preview is rejected and rollback leaves no created notebook', async () => {
  const {userId}=await signUpAndCookie(app,uniqueEmail()); const ctx: ToolContext={userId,log:rootLogger};
  const [nb]=await db.insert(notebooks).values({userId,title:'Before'}).returning();
  const update=tool('update_notebook'),args={id:nb!.id,title:'Proposed'};
  const preview=await update.dryRun!(ctx,args);
  await db.update(notebooks).set({title:'Concurrent change'}).where(eq(notebooks.id,nb!.id));
  const stale=await db.transaction(tx=>update.execute({...ctx,tx,confirmationHash:preview.snapshotHash},args));
  expect(stale.ok).toBe(false);
  expect((await db.select().from(notebooks).where(eq(notebooks.id,nb!.id)))[0]!.title).toBe('Concurrent change');
  const create=tool('create_notebook'),newArgs={title:'Rolled back'},p=await create.dryRun!(ctx,newArgs);
  await expect(db.transaction(async tx=>{ expect((await create.execute({...ctx,tx,confirmationHash:p.snapshotHash},newArgs)).ok).toBe(true); throw Error('rollback'); })).rejects.toThrow('rollback');
  expect(await db.select().from(notebooks).where(eq(notebooks.userId,userId))).toHaveLength(1);
});

test('every exposed tool has localized activity text and the correct confirmation classification', async () => {
  const { TOOL_LABEL_KEY, WRITE_SRS_TOOL_NAMES }=await import('../../web/src/lib/chat-activity.ts');
  const ru=(await import('../../web/src/lib/messages/ru/chat.ts')).default;
  const en=(await import('../../web/src/lib/messages/en/chat.ts')).default;
  for(const entry of buildToolRegistry({webSearchEnabled:true,fetchPageEnabled:true})) {
    expect((ru.tool as Record<string,string>)[entry.name]).toBeDefined();
    expect((en.tool as Record<string,string>)[entry.name]).toBeDefined();
    expect(TOOL_LABEL_KEY[entry.name] ?? `chat.tool.${entry.name}`).toBe(`chat.tool.${entry.name}`);
    expect(WRITE_SRS_TOOL_NAMES.has(entry.name)).toBe(entry.kind!=='read');
  }
});

test('library reads work from parsed chunks without embeddings and exclude foreign sources', async () => {
  const {sources,sourceChunks}=await import('@reomi/db');
  const a=await signUpAndCookie(app,uniqueEmail()),b=await signUpAndCookie(app,uniqueEmail());
  const [own]=await db.insert(sources).values({userId:a.userId,kind:'text',title:'Owned source',status:'error',errorCode:'index_failed',verified:true}).returning();
  const [foreign]=await db.insert(sources).values({userId:b.userId,kind:'text',title:'Secret foreign source',status:'ready',verified:true}).returning();
  await db.insert(sourceChunks).values({userId:a.userId,sourceId:own!.id,position:0,text:'Binary search halves a sorted range.',sourceHash:'test'});
  const ctx: ToolContext={userId:a.userId,log:rootLogger};
  const read=await tool('read_source_chunks').execute(ctx,{id:own!.id,limit:1});
  expect(read.ok).toBe(true);
  if(read.ok) { expect(read.text).toContain('Binary search'); expect(read.text).toContain(`/library/${own!.id}`); }
  expect((await tool('read_source_chunks').execute(ctx,{id:foreign!.id,limit:1})).ok).toBe(false);
  const list=await tool('list_library').execute(ctx,{limit:10});
  expect(list.ok).toBe(true);
  if(list.ok) { expect(list.text).toContain('Owned source'); expect(list.text).not.toContain('Secret foreign'); expect(list.text).not.toContain('storageKey'); }
});

test('notebook deletion preview identifies conversations as retained instead of deleted',async()=>{
  const {conversations,notebookNotes}=await import('@reomi/db');
  const {userId}=await signUpAndCookie(app,uniqueEmail());
  const [notebook]=await db.insert(notebooks).values({userId,title:'Notebook'}).returning();
  await db.insert(conversations).values({userId,notebookId:notebook!.id,title:'Retained conversation'});
  await db.insert(notebookNotes).values({userId,notebookId:notebook!.id,title:'Notebook-owned note',content:'Deleted with its notebook'});
  const impact=await tool('delete_notebook').dryRun!({userId,log:rootLogger},{id:notebook!.id});
  expect(impact.resourcePreview!.affected).not.toContainEqual({kind:'conversations',count:1});
  expect(impact.resourcePreview!.retained).toContainEqual({kind:'conversations',count:1});
  expect(impact.resourcePreview!.affected).toContainEqual({kind:'notes',count:1});
});
