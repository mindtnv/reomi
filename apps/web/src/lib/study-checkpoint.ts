import type { Card, CardSourceLink, Rating } from './types';
import type { StudyMode, StudySession } from './review-session';
import { readBrowserValue, removeBrowserValue, writeBrowserValue, type MigratingStorage } from './storage-migration';

/** Persistence helper for the existing study-session owner, never the navigation journal. */
export const STUDY_CHECKPOINT_LIMITS = { entryBytes:512*1024, totalBytes:3*1024*1024, entries:16, answers:1000, pendingCards:1000, answerChars:16000 } as const;
export type PendingStudyGrade = {id:string;cardId:string;rating:Rating;durationMs:number;mode:StudyMode;before:Card};
export type StudyViewCheckpoint = {revealed:boolean;submitted:boolean;typedAnswer:string;elapsedMs:number;finished:boolean;infoOpen:boolean;pendingPeek:CardSourceLink|null;editingCardId?:string|null};
export type StudyCheckpoint = {id:string;owner:string;href:string;session:StudySession;view:StudyViewCheckpoint;pending:PendingStudyGrade|null;updatedAt?:number};
type StoragePort=MigratingStorage;
const key=(owner:string)=>`nn:study:checkpoint:v1:${owner}`;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const id=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=200&&!/[\u0000-\u001f]/.test(value);
const number=(value:unknown):value is number=>typeof value==='number'&&Number.isFinite(value);
const size=(value:string)=>new TextEncoder().encode(value).byteLength;
const disk=(provided?:StoragePort)=>provided??(typeof localStorage==='undefined'?undefined:localStorage);
function studyHref(href:unknown):href is string {
  if(typeof href!=='string'||href.length>1000||!/^\/review(?:\?|$)/.test(href)||href.includes('#'))return false;
  const url=new URL(href,'https://study.invalid');
  return url.pathname==='/review'&&[...url.searchParams].every(([name,value])=>['deck','filteredDeckId'].includes(name)&&id(value));
}
function compact(card:Card):Card {
  return {id:card.id,deckId:card.deckId,noteId:card.noteId,templateOrd:card.templateOrd,clozeNumber:card.clozeNumber,
    renderKind:card.renderKind,renderText:'',renderFrontText:'',renderBackText:'',tags:[],suspended:card.suspended,
    createdAt:card.createdAt,updatedAt:card.updatedAt,fsrs:card.fsrs};
}
function decodeCard(value:unknown):Card|null {
  if(!object(value)||!id(value.id)||typeof value.deckId!=='string'||!object(value.fsrs)||!number(value.updatedAt)||!number(value.createdAt))return null;
  const fsrs=value.fsrs;
  if(!number(fsrs.reps)||!number(fsrs.state)||!number(new Date(fsrs.due as string).getTime()))return null;
  if(!['basic','cloze','typein','custom'].includes(String(value.renderKind)))return null;
  for(const field of ['renderText','renderFrontText','renderBackText'])if(typeof value[field]!=='string')return null;
  if(!Array.isArray(value.tags)||!value.tags.every(tag=>typeof tag==='string'))return null;
  if(value.note!=null&&(!object(value.note)||!object(value.note.fieldValues)||!Object.values(value.note.fieldValues).every(v=>typeof v==='string')))return null;
  if(value.noteType!=null&&(!object(value.noteType)||!Array.isArray(value.noteType.templates)||!value.noteType.templates.every(t=>object(t)&&typeof t.frontTemplate==='string'&&typeof t.backTemplate==='string')))return null;
  return {...value,fsrs:{...fsrs,due:new Date(fsrs.due as string),last_review:fsrs.last_review?new Date(fsrs.last_review as string):undefined}} as unknown as Card;
}
function decode(value:unknown,owner:string):StudyCheckpoint|null {
  if(!object(value)||value.owner!==owner||!id(value.id)||!studyHref(value.href)||!object(value.session)||!object(value.view))return null;
  const s=value.session,v=value.view;
  if(!Array.isArray(s.pending)||s.pending.length>STUDY_CHECKPOINT_LIMITS.pendingCards||!Array.isArray(s.history)||s.history.length>STUDY_CHECKPOINT_LIMITS.answers)return null;
  if(s.activeId!==null&&!id(s.activeId))return null;
  const pending=s.pending.map(decodeCard);if(pending.some(c=>c===null))return null;
  const history:StudySession['history']=[];
  for(const row of s.history){
    if(!object(row)||!object(row.review))return null;
    const before=decodeCard(row.before),after=decodeCard(row.after),r=row.review;
    if(!before||!after||!id(r.id)||!id(r.cardId)||![1,2,3,4].includes(Number(r.rating))||!number(r.durationMs)||!number(r.reviewedAt))return null;
    history.push({before,after,review:r as unknown as StudySession['history'][number]['review']});
  }
  if(['revealed','submitted','finished','infoOpen'].some(k=>typeof v[k]!=='boolean')||typeof v.typedAnswer!=='string'||v.typedAnswer.length>STUDY_CHECKPOINT_LIMITS.answerChars||!number(v.elapsedMs)||v.elapsedMs<0)return null;
  if(v.pendingPeek!==null&&!object(v.pendingPeek))return null;
  if(v.editingCardId!=null&&!id(v.editingCardId))return null;
  let operation:PendingStudyGrade|null=null;
  if(value.pending!==null){
    const op=value.pending;
    if(!object(op)||!id(op.id)||!id(op.cardId)||![1,2,3,4].includes(Number(op.rating))||!number(op.durationMs)||op.durationMs<0||!['regular','filtered'].includes(String(op.mode)))return null;
    const before=decodeCard(op.before);if(!before||before.id!==op.cardId)return null;
    operation={id:op.id,cardId:op.cardId,rating:op.rating as Rating,durationMs:op.durationMs,mode:op.mode as StudyMode,before};
  }
  return {id:value.id,owner,href:value.href,session:{activeId:s.activeId as string|null,pending:pending as Card[],history},view:v as unknown as StudyViewCheckpoint,pending:operation,updatedAt:number(value.updatedAt)?value.updatedAt:0};
}
function readEntries(owner:string,storage:StoragePort):StudyCheckpoint[] {
  const raw=readBrowserValue(storage,key(owner));if(!raw||size(raw)>STUDY_CHECKPOINT_LIMITS.totalBytes)return [];
  const envelope:unknown=JSON.parse(raw);
  if(!object(envelope)||envelope.version!==1||envelope.owner!==owner||!Array.isArray(envelope.entries)||envelope.entries.length>STUDY_CHECKPOINT_LIMITS.entries)return [];
  return envelope.entries.flatMap(value=>{const entry=decode(value,owner);return entry?[entry]:[];});
}
export function readStudyCheckpoint(owner:string|undefined,href:string,sessionId?:string,storage?:StoragePort):StudyCheckpoint|null {
  if(!owner||!studyHref(href))return null;
  try {
    const port=disk(storage);if(!port)return null;
    return readEntries(owner,port).filter(entry=>entry.href===href&&(sessionId?entry.id===sessionId:!entry.view.finished)).sort((a,b)=>(b.updatedAt??0)-(a.updatedAt??0))[0]??null;
  } catch {return null;}
}
function pack(checkpoint:StudyCheckpoint):StudyCheckpoint {
  const activeId=checkpoint.session.activeId;
  const peekId=checkpoint.view.pendingPeek?checkpoint.session.history.at(-1)?.before.id:null;
  return {...checkpoint,updatedAt:checkpoint.updatedAt??Date.now(),session:{activeId,
    pending:checkpoint.session.pending.map(card=>card.id===activeId?card:compact(card)),
    history:checkpoint.session.history.map((row,i)=>({...row,before:peekId===row.before.id&&i===checkpoint.session.history.length-1?row.before:compact(row.before),after:compact(row.after)})),
  }};
}
export function writeStudyCheckpoint(checkpoint:StudyCheckpoint,storage?:StoragePort):boolean {
  if(!id(checkpoint.owner)||!id(checkpoint.id)||!studyHref(checkpoint.href)||checkpoint.view.typedAnswer.length>STUDY_CHECKPOINT_LIMITS.answerChars||checkpoint.session.history.length>STUDY_CHECKPOINT_LIMITS.answers||checkpoint.session.pending.length>STUDY_CHECKPOINT_LIMITS.pendingCards)return false;
  try {
    const port=disk(storage);if(!port)return false;
    const packed=pack({...checkpoint,updatedAt:Date.now()});
    if(size(JSON.stringify(packed))>STUDY_CHECKPOINT_LIMITS.entryBytes)return false;
    let entries=readEntries(checkpoint.owner,port).filter(entry=>entry.id!==checkpoint.id).map(pack);
    entries.push(packed);
    const encode=()=>JSON.stringify({version:1,owner:checkpoint.owner,entries});
    let raw=encode();
    while(entries.length>STUDY_CHECKPOINT_LIMITS.entries||size(raw)>STUDY_CHECKPOINT_LIMITS.totalBytes){
      const completed=entries.find(entry=>entry.id!==checkpoint.id&&entry.view.finished);
      if(!completed)return false;
      entries=entries.filter(entry=>entry.id!==completed.id);raw=encode();
    }
    writeBrowserValue(port,key(checkpoint.owner),raw);return true;
  } catch {return false;}
}
export function clearStudyCheckpoints(owner:string,storage?:StoragePort) {try{const port=disk(storage);if(port)removeBrowserValue(port,key(owner));}catch{/* Isolated live study remains usable. */}}
