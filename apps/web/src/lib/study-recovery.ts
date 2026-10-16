import {holdIsActive} from '@reomi/shared';
import {dropHeldCards,mergeStudyQueue,recordStudyAnswer,type StudyMode} from './review-session';
import type {PendingStudyGrade,StudyCheckpoint} from './study-checkpoint';
import type {Card,Review} from './types';

export type StudyOperationReceipt={status:'missing'|'reverted'}|{status:'committed';result:Review&{card:Card}};
export type StudyRecoveryReads={
  card:(id:string)=>Promise<Card|null>;
  reviews:(ids:string[])=>Promise<Review[]>;
  operation:(pending:PendingStudyGrade)=>Promise<StudyOperationReceipt>;
};
const timestamp=(value:string|undefined)=>value?new Date(value).getTime():null;
export function sameStudyCardVersion(a:Card,b:Card) {
  return a.updatedAt===b.updatedAt&&a.fsrs.reps===b.fsrs.reps&&a.deckId===b.deckId&&
    (!a.note?.updatedAt||timestamp(a.note.updatedAt)===timestamp(b.note?.updatedAt))&&
    (!a.noteType?.updatedAt||timestamp(a.noteType.updatedAt)===timestamp(b.noteType?.updatedAt));
}

/** Recovery only reads. An absent receipt never causes automatic grade replay. */
export async function reconcileStudyCheckpoint(checkpoint:StudyCheckpoint,queue:Card[],mode:StudyMode,now:number,heldCardIds:readonly string[],reads:StudyRecoveryReads,acceptUpdated=false) {
  let session={...checkpoint.session,history:[...checkpoint.session.history]};
  let view={...checkpoint.view};let pending=checkpoint.pending;
  if(session.history.length){
    const verified=new Map<string,Review>();
    for(let offset=0;offset<session.history.length;offset+=100){
      const rows=await reads.reviews(session.history.slice(offset,offset+100).map(row=>row.review.id));
      for(const row of rows)verified.set(row.id,row);
    }
    session.history=session.history.flatMap(row=>{const review=verified.get(row.review.id);return review?[{...row,review}]:[];});
  }
  if(pending){
    const receipt=await reads.operation(pending);
    if(receipt.status==='committed'){
      if(!session.history.some(row=>row.review.id===receipt.result.id))session=recordStudyAnswer(session,pending.before,receipt.result.card,receipt.result,mode,now);
      pending=null;view={...view,typedAnswer:'',revealed:false,submitted:false,elapsedMs:0,pendingPeek:null,finished:false};
    }else if(receipt.status==='reverted')pending=null;
  }
  const wanted=session.activeId;
  const previous=session.pending.find(card=>card.id===wanted);
  const order=new Map(session.pending.map((card,index)=>[card.id,index]));
  const merged=mergeStudyQueue(session,queue,mode,now,heldCardIds);
  merged.pending.sort((a,b)=>(order.get(a.id)??Infinity)-(order.get(b.id)??Infinity));
  let stale:'changed'|'missing'|null=null;
  let acceptedUpdate=false;
  if(wanted&&previous&&!view.finished){
    const live=await reads.card(wanted);
    if(live&&holdIsActive(live.hold,now)){
      return {...checkpoint,session:dropHeldCards(merged,[wanted],mode,now),view:{...view,typedAnswer:'',revealed:false,submitted:false,elapsedMs:0,pendingPeek:null},pending,stale:null,acceptedUpdate:false};
    }
    if(acceptUpdated&&!pending&&!queue.some(card=>card.id===wanted)&&!view.typedAnswer){
      return {...checkpoint,session:merged,view:{...view,revealed:false,submitted:false,elapsedMs:0,pendingPeek:null},pending,stale:null,acceptedUpdate:false};
    }
    if(!live)stale='missing';
    else if(!sameStudyCardVersion(previous,live)||!queue.some(card=>card.id===wanted))stale='changed';
    if(acceptUpdated&&live&&queue.some(card=>card.id===wanted)&&!pending){
      acceptedUpdate=!sameStudyCardVersion(previous,live);
      stale=null;if(acceptedUpdate)view={...view,revealed:false,submitted:false};
    }
    // A changed/deleted current question remains visible, with its typed input,
    // until an explicit skip/refresh decision. The reviewer disables grading.
    const active=stale?previous:live!;
    merged.pending=[active,...merged.pending.filter(card=>card.id!==wanted)];
    merged.activeId=wanted;
  }else if(merged.activeId!==checkpoint.session.activeId){
    view={...view,typedAnswer:'',revealed:false,submitted:false,elapsedMs:0,pendingPeek:null};
  }
  return {...checkpoint,session:merged,view,pending,stale,acceptedUpdate};
}
