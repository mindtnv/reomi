import { beforeEach, expect, test } from 'bun:test';
import { db, sources, notebookNotes, notebooks } from '@reomi/db';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app';
import { buildToolRegistry, type ToolContext } from '../src/ai/tools';
import { rootLogger } from '../src/logger';
import { resetTestDb, signUpAndCookie, uniqueEmail } from './helpers';
beforeEach(resetTestDb);
test('saving a source note requires its stored preview, participates in rollback, and creates no notebook',async()=>{
  const {userId}=await signUpAndCookie(buildApp(),uniqueEmail());
  const [source]=await db.insert(sources).values({userId,kind:'text',title:'My book'}).returning();
  const ctx:ToolContext={userId,log:rootLogger}; const args={sourceId:source!.id,title:'Study note',content:'Useful conclusions'};
  const tool=buildToolRegistry().find(tool=>tool.name==='save_source_note')!;expect(tool).toBeDefined();
  expect((await tool.validate!(ctx,args)).ok).toBe(true);
  const impact=await tool.dryRun!(ctx,args);expect(impact.resourcePreview?.fields.some(field=>field.after==='My book')).toBe(true);
  expect((await tool.execute(ctx,args)).ok).toBe(false);
  await expect(db.transaction(async tx=>{const result=await tool.execute({...ctx,tx,confirmationHash:impact.snapshotHash},args);expect(result.ok).toBe(true);throw new Error('rollback');})).rejects.toThrow('rollback');
  expect(await db.select().from(notebookNotes).where(eq(notebookNotes.userId,userId))).toEqual([]);
  const result=await db.transaction(tx=>tool.execute({...ctx,tx,confirmationHash:impact.snapshotHash},args));expect(result.ok).toBe(true);
  const saved=await db.select().from(notebookNotes).where(eq(notebookNotes.userId,userId));expect(saved).toHaveLength(1);expect(saved[0]!.sourceId).toBe(source!.id);expect(saved[0]!.notebookId).toBeNull();
  expect(await db.select().from(notebooks).where(eq(notebooks.userId,userId))).toEqual([]);
});
test('source note previews reject foreign targets and fail after relevant source state changes',async()=>{
  const app=buildApp(),alice=await signUpAndCookie(app,uniqueEmail()),bob=await signUpAndCookie(app,uniqueEmail());
  const [source]=await db.insert(sources).values({userId:alice.userId,kind:'text',title:'Original'}).returning();
  const tool=buildToolRegistry().find(tool=>tool.name==='save_source_note')!,args={sourceId:source!.id,title:'Note',content:'Body'};
  const ctx:ToolContext={userId:alice.userId,log:rootLogger};
  expect((await tool.validate!({...ctx,userId:bob.userId},args)).ok).toBe(false);
  const impact=await tool.dryRun!(ctx,args);await db.update(sources).set({title:'Renamed'}).where(eq(sources.id,source!.id));
  const applied=await db.transaction(tx=>tool.execute({...ctx,tx,confirmationHash:impact.snapshotHash},args));expect(applied.ok).toBe(false);
  expect(await db.select().from(notebookNotes).where(eq(notebookNotes.userId,alice.userId))).toEqual([]);
});

test('source note readers obey strict source context and expose retained notes only through explicit references',async()=>{
  const {userId}=await signUpAndCookie(buildApp(),uniqueEmail());
  const [source,other]=await db.insert(sources).values([{userId,kind:'text',title:'Selected'},{userId,kind:'text',title:'Other'}]).returning();
  const [note]=await db.insert(notebookNotes).values({userId,ownerKind:'source',sourceId:source!.id,sourceOriginId:source!.id,sourceOriginTitle:'Selected',title:'My note',content:'Useful conclusions'}).returning();
  const ctx:ToolContext={userId,log:rootLogger,assistantContext:{version:1,revision:0,policy:'strict',refs:[],sourceIds:[source!.id],deckIds:[]}};
  const registry=buildToolRegistry(),list=registry.find(tool=>tool.name==='list_source_notes')!,read=registry.find(tool=>tool.name==='get_source_note')!;
  const listed=await list.execute(ctx,{id:source!.id});expect(listed.ok).toBe(true);if(listed.ok)expect(listed.text).toContain('My note');
  expect((await list.execute(ctx,{id:other!.id})).ok).toBe(false);
  const readNote=await read.execute(ctx,{id:note!.id});expect(readNote.ok).toBe(true);if(readNote.ok)expect(readNote.text).toContain('Useful conclusions');
  await db.delete(sources).where(eq(sources.id,source!.id));
  expect((await read.execute(ctx,{id:note!.id})).ok).toBe(false);
  const explicit={...ctx,assistantContext:{...ctx.assistantContext!,sourceIds:[],refs:[{ref:{kind:'written_note' as const,id:note!.id},label:'My note',available:true}]}};
  expect((await read.execute(explicit,{id:note!.id})).ok).toBe(true);
});

test('a long source note can be read in bounded pages without losing text',async()=>{
  const {userId}=await signUpAndCookie(buildApp(),uniqueEmail());
  const [source]=await db.insert(sources).values({userId,kind:'text',title:'Book'}).returning();
  const content='A long note with "quotes" and code.\n'.repeat(300);
  const [note]=await db.insert(notebookNotes).values({userId,ownerKind:'source',sourceId:source!.id,sourceOriginId:source!.id,sourceOriginTitle:'Book',title:'Long note',content}).returning();
  const ctx:ToolContext={userId,log:rootLogger,assistantContext:{version:1,revision:0,policy:'strict',refs:[],sourceIds:[source!.id],deckIds:[]}};
  const reader=buildToolRegistry().find(tool=>tool.name==='get_source_note')!;
  let offset:number|null=0,serialized='',version:string|undefined;let pages=0;
  do {
    const result=await reader.execute(ctx,{id:note!.id,offset,version});expect(result.ok).toBe(true);if(!result.ok)throw new Error(result.error);
    expect(result.text.length).toBeLessThanOrEqual(4000);const page=JSON.parse(result.text);serialized+=page.content;offset=page.nextOffset;version=page.version;
    expect(++pages).toBeLessThan(30);
  } while(offset!==null);
  expect(JSON.parse(serialized).content).toBe(content);
  await db.update(notebookNotes).set({content:'Changed between reads'}).where(eq(notebookNotes.id,note!.id));
  const stale=await reader.execute(ctx,{id:note!.id,offset:2000,version});expect(stale.ok).toBe(false);if(!stale.ok)expect(stale.error).toContain('context_changed');
});

test('source artifacts are readable in source scope and retained artifacts require their explicit reference',async()=>{
  const {notebookArtifacts}=await import('@reomi/db');
  const {userId}=await signUpAndCookie(buildApp(),uniqueEmail());
  const [a,b]=await db.insert(sources).values([{userId,kind:'text',title:'A'},{userId,kind:'text',title:'B'}]).returning();
  const [artifact,other]=await db.insert(notebookArtifacts).values([
    {userId,ownerKind:'source',sourceId:a!.id,sourceOriginId:a!.id,sourceOriginTitle:'A',sourceIds:[a!.id],type:'summary',status:'ready',title:'Summary A',contentMd:'From source A'},
    {userId,ownerKind:'source',sourceId:b!.id,sourceOriginId:b!.id,sourceOriginTitle:'B',sourceIds:[b!.id],type:'summary',status:'ready',title:'Summary B',contentMd:'From source B'},
  ]).returning();
  const ctx:ToolContext={userId,log:rootLogger,assistantContext:{version:1,revision:0,policy:'strict',refs:[],sourceIds:[a!.id],deckIds:[]}};
  const registry=buildToolRegistry(),list=registry.find(tool=>tool.name==='list_source_artifacts')!,read=registry.find(tool=>tool.name==='get_source_artifact')!;
  expect(list).toBeDefined();expect(read).toBeDefined();
  const listed=await list.execute(ctx,{id:a!.id,limit:1});expect(listed.ok).toBe(true);if(listed.ok)expect(listed.text).toContain('Summary A');
  const first=await read.execute(ctx,{id:artifact!.id});expect(first.ok).toBe(true);if(first.ok)expect(first.text).toContain('From source A');
  expect((await read.execute(ctx,{id:other!.id})).ok).toBe(false);
  const generic=registry.find(tool=>tool.name==='read_context_object')!;
  expect((await generic.execute(ctx,{kind:'artifact',id:artifact!.id})).ok).toBe(true);
  await db.delete(sources).where(eq(sources.id,a!.id));
  expect((await read.execute(ctx,{id:artifact!.id})).ok).toBe(false);
  const explicit={...ctx,assistantContext:{...ctx.assistantContext!,sourceIds:[],refs:[{ref:{kind:'artifact' as const,id:artifact!.id},label:'Summary A',available:true}]}};
  expect((await read.execute(explicit,{id:artifact!.id})).ok).toBe(true);
});
