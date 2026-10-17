import { expect, test } from 'bun:test';
import { cardFromApi,reviewFromApi } from './mappers';
import { reconcileStudyCheckpoint } from './study-recovery';
import type { StudyCheckpoint } from './study-checkpoint';
const now=Date.parse('2026-09-22T12:00:00Z');
const card=(id:string)=>cardFromApi({id,noteId:`note-${id}`,deckId:'deck',state:'new',reps:0,createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),due:new Date(now).toISOString(),renderFrontText:'Q',renderBackText:'A'});
const a=card('a'),b=card('b');
const base=():StudyCheckpoint=>({id:'session',owner:'alice',href:'/review',session:{pending:[a,b],activeId:'a',history:[]},view:{revealed:true,submitted:true,typedAnswer:'my answer',elapsedMs:2300,finished:false,infoOpen:true,pendingPeek:null},pending:null});
test('an unchanged card restores its answer while changed or deleted cards keep input and block grading',async()=>{
  const reads={reviews:async()=>[],card:async()=>a,operation:async()=>({status:'missing' as const})};
  const same=await reconcileStudyCheckpoint(base(),[a,b],'regular',now,[],reads);expect(same.view.typedAnswer).toBe('my answer');expect(same.view.revealed).toBe(true);expect(same.stale).toBeNull();
  const changed=await reconcileStudyCheckpoint(base(),[a,b],'regular',now,[],{...reads,card:async()=>({...a,updatedAt:now+1})});
  expect(changed.stale).toBe('changed');expect(changed.view.typedAnswer).toBe('my answer');
  const gone=await reconcileStudyCheckpoint(base(),[b],'regular',now,[],{...reads,card:async()=>null});
  expect(gone.stale).toBe('missing');expect(gone.session.activeId).toBe('a');expect(gone.view.typedAnswer).toBe('my answer');
});
test('a committed uncertain operation enters the ledger once using only read adapters',async()=>{
  const checkpoint=base();checkpoint.pending={id:'op',cardId:'a',rating:3,durationMs:2300,mode:'regular',before:a};
  const saved=reviewFromApi({id:'r',cardId:'a',rating:3,durationMs:2300,reviewedAt:new Date(now).toISOString(),nextDue:new Date(now+86400000).toISOString()});
  const result=await reconcileStudyCheckpoint(checkpoint,[b],'regular',now,[],{reviews:async()=>[],card:async id=>id==='b'?b:a,operation:async()=>({status:'committed',result:{...saved,card:{...a,suspended:true}}})});
  expect(result.pending).toBeNull();expect(result.session.history.map(x=>x.review.id)).toEqual(['r']);expect(result.session.activeId).toBe('b');expect(result.view.typedAnswer).toBe('');
});
test('missing operation receipts remain pending and removed reviews do not contribute to session totals',async()=>{
  const checkpoint=base();checkpoint.pending={id:'op',cardId:'a',rating:3,durationMs:2300,mode:'regular',before:a};
  checkpoint.session.history=[{before:a,after:a,review:reviewFromApi({id:'undone',cardId:'a',rating:3,reviewedAt:new Date(now).toISOString(),nextDue:new Date(now).toISOString()})}];
  const result=await reconcileStudyCheckpoint(checkpoint,[a,b],'regular',now,[],{reviews:async()=>[],card:async()=>a,operation:async()=>({status:'missing'})});
  expect(result.pending?.id).toBe('op');expect(result.session.history).toHaveLength(0);expect(result.view.typedAnswer).toBe('my answer');
});
