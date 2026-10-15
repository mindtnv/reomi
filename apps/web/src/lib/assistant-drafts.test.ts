import { expect, test } from 'bun:test';
import { assistantDraftStorageKey, readAssistantDrafts, writeAssistantDrafts } from './assistant-drafts';
import { AssistantController, type AssistantTransport } from './assistant-controller';

const transport = { create: async()=>{throw new Error('unused');},load:async()=>{throw new Error('unused');},stream:async()=>{},resume:async()=>{},regenerate:async()=>{} } satisfies AssistantTransport;
function storage() { const map=new Map<string,string>();return {getItem:(key:string)=>map.get(key)??null,setItem:(key:string,value:string)=>{map.set(key,value);},map}; }

test('draft persistence is versioned, owner-scoped and retains context and unsent text',()=>{
  const disk=storage(),controller=new AssistantController({ownerId:'alice',transport,contextVersion:1});
  const key=controller.newConversation();controller.setDraft(key,'Keep my question');controller.setPolicy(key,'strict');
  const records=controller.drafts();
  expect(writeAssistantDrafts(disk,'alice',records).ok).toBe(true);
  const loaded=readAssistantDrafts(disk,'alice');expect(loaded.ok).toBe(true);
  if(!loaded.ok)throw new Error('expected saved drafts');
  const restored=new AssistantController({ownerId:'alice',transport});restored.restoreDrafts(loaded.records);
  expect(restored.getSnapshot().sessions[key]!.draft).toBe('Keep my question');
  expect(restored.getSnapshot().sessions[key]!.policy).toBe('strict');
  expect(readAssistantDrafts(disk,'bob')).toEqual({ok:true,records:[]});
  controller.dispose();restored.dispose();
});

test('invalid or over-budget storage never erases the last good value',()=>{
  const disk=storage(),controller=new AssistantController({ownerId:'alice',transport});
  const key=controller.newConversation();controller.setDraft(key,'Good draft');
  const records=controller.drafts();writeAssistantDrafts(disk,'alice',records);
  const before=disk.getItem(assistantDraftStorageKey('alice'));
  const tooMany=Array.from({length:11},(_,i)=>({...records[0]!,key:`draft-${i}`}));
  expect(writeAssistantDrafts(disk,'alice',tooMany).ok).toBe(false);
  expect(disk.getItem(assistantDraftStorageKey('alice'))).toBe(before);
  disk.setItem(assistantDraftStorageKey('alice'),'{broken');
  expect(readAssistantDrafts(disk,'alice').ok).toBe(false);
  expect(disk.getItem(assistantDraftStorageKey('alice'))).toBe('{broken');
  expect(writeAssistantDrafts({getItem(){return null;},setItem(){throw new Error('disabled');}},'alice',records).ok).toBe(false);
  expect(controller.getSnapshot().sessions[key]!.draft).toBe('Good draft');
  controller.dispose();
});
