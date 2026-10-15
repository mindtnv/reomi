import { expect, test } from 'bun:test';
import { cardFromApi, reviewFromApi } from './mappers';
import { emptyStudySession, mergeStudyQueue, recordStudyAnswer, studyTotals } from './review-session';
import { readStudyCheckpoint, writeStudyCheckpoint, STUDY_CHECKPOINT_LIMITS } from './study-checkpoint';
const now=Date.parse('2026-09-22T12:00:00Z');
function storage(){const rows=new Map<string,string>();return {rows,getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value);},removeItem:(key:string)=>{rows.delete(key);}};}
const card=(id:string)=>cardFromApi({id,deckId:'deck',noteId:`note-${id}`,state:'new',createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),due:new Date(now).toISOString(),renderFrontText:'Question',renderBackText:'Answer'});
test('a checkpoint restores confirmed history, active question and answer state with dates',()=>{
  const disk=storage(),a=card('a'),b=card('b');
  const review=reviewFromApi({id:'review-a',cardId:'a',rating:3,reviewedAt:new Date(now).toISOString(),durationMs:1700,nextDue:new Date(now+60000).toISOString()});
  const session=recordStudyAnswer(mergeStudyQueue(emptyStudySession(),[a,b],'regular',now),a,{...a,suspended:true},review,'regular',now);
  const view={revealed:true,submitted:true,typedAnswer:'unfinished answer',elapsedMs:4300,finished:false,infoOpen:true,pendingPeek:null};
  expect(writeStudyCheckpoint({id:'session',owner:'alice',href:'/review',session,view,pending:null},disk)).toBe(true);
  const loaded=readStudyCheckpoint('alice','/review','session',disk)!;
  expect(loaded.session.activeId).toBe('b');expect(loaded.session.pending[0]!.fsrs.due).toBeInstanceOf(Date);
  expect(loaded.view).toEqual(view);expect(studyTotals(loaded.session.history).answers).toBe(1);
  expect(readStudyCheckpoint('bob','/review','session',disk)).toBeNull();
  expect(readStudyCheckpoint('alice','/review?deck=another','session',disk)).toBeNull();
});
test('confirmed history never stores repeated note bodies or the whole collection',()=>{
  const disk=storage();const a={...card('a'),note:{id:'n',fieldValues:{Front:'secret body '.repeat(5000)},tags:[]}};
  const session=mergeStudyQueue(emptyStudySession(),[a,card('b')],'regular',now);
  session.history=Array.from({length:100},(_,i)=>({before:a,after:a,review:reviewFromApi({id:`r${i}`,cardId:'a',rating:3,reviewedAt:new Date(now).toISOString(),nextDue:new Date(now).toISOString()})}));
  expect(writeStudyCheckpoint({id:'s',owner:'alice',href:'/review',session,view:{revealed:false,submitted:false,typedAnswer:'',elapsedMs:0,finished:false,infoOpen:false,pendingPeek:null},pending:null},disk)).toBe(true);
  const raw=[...disk.rows.values()][0]!;expect(raw.split('secret body ').length-1).toBe(5000);
  expect(raw.length).toBeLessThan(STUDY_CHECKPOINT_LIMITS.entryBytes);
});
test('an uncertain grade keeps its original operation arguments and storage failure never truncates input',()=>{
  const disk=storage(),a=card('a');const session=mergeStudyQueue(emptyStudySession(),[a],'regular',now);
  const pending={id:'op',cardId:a.id,rating:3 as const,durationMs:1000,mode:'regular' as const,before:a};
  const value={id:'s',owner:'alice',href:'/review',session,view:{revealed:true,submitted:false,typedAnswer:'draft',elapsedMs:1000,finished:false,infoOpen:false,pendingPeek:null},pending};
  expect(writeStudyCheckpoint(value,disk)).toBe(true);
  expect(readStudyCheckpoint('alice','/review','s',disk)?.pending).toEqual(pending);
  expect(writeStudyCheckpoint({...value,view:{...value.view,typedAnswer:'x'.repeat(STUDY_CHECKPOINT_LIMITS.entryBytes)}},disk)).toBe(false);
  expect(readStudyCheckpoint('alice','/review','s',disk)?.view.typedAnswer).toBe('draft');
  expect(writeStudyCheckpoint(value,{getItem(){throw Error();},setItem(){throw Error();}})).toBe(false);
});
