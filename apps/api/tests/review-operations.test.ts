import { beforeEach, expect, test } from 'bun:test';
import { newUuidV7 } from '@reomi/shared';
import { buildApp } from '../src/app';
import { callApp, resetTestDb, seedBasicCard, signUpAndCookie, uniqueEmail } from './helpers';

const app=buildApp();
beforeEach(resetTestDb);
async function fixture() {
  const {cookie}=await signUpAndCookie(app,uniqueEmail());
  await callApp(app,'GET','/profile',{cookie});
  const deck=await(await callApp(app,'POST','/decks',{cookie,body:{name:'Study operations'}})).json<{id:string}>();
  const card=await seedBasicCard(app,cookie,{deckId:deck.id,front:'Question',back:'Answer'});
  return {cookie,card};
}
test('a lost grade response is recoverable by operation identity without another grade',async()=>{
  const {cookie,card}=await fixture();const operationId=newUuidV7();
  const body={cardId:card.id,rating:3,durationMs:1234,expectedReps:0,expectedUpdatedAt:new Date(card.updatedAt).toISOString()};
  const first=await callApp(app,'POST',`/reviews/operations/${operationId}`,{cookie,body});
  expect(first.status).toBe(200);const saved=await first.json<any>();
  const retry=await callApp(app,'POST',`/reviews/operations/${operationId}`,{cookie,body});
  expect(retry.status).toBe(200);const replay=await retry.json<any>();
  expect(replay.review.id).toBe(saved.review.id);expect(replay.card).toEqual(saved.card);expect(replay.replayed).toBe(true);
  const receipt=await callApp(app,'GET',`/reviews/operations/${operationId}`,{cookie});
  expect(receipt.status).toBe(200);expect((await receipt.json<any>()).result.review.id).toBe(saved.review.id);
  const reviews=await(await callApp(app,'GET','/reviews',{cookie})).json<any[]>();expect(reviews).toHaveLength(1);
  const current=await(await callApp(app,'GET',`/cards/${card.id}`,{cookie})).json<any>();expect(current.reps).toBe(1);
});
test('concurrent retries serialize once and conflicting argument reuse is rejected',async()=>{
  const {cookie,card}=await fixture();const operationId=newUuidV7();const body={cardId:card.id,rating:3,durationMs:400};
  const responses=await Promise.all(Array.from({length:3},()=>callApp(app,'POST',`/reviews/operations/${operationId}`,{cookie,body})));
  expect(responses.map(r=>r.status)).toEqual([200,200,200]);
  const ids=await Promise.all(responses.map(async r=>(await r.json<any>()).review.id));expect(new Set(ids).size).toBe(1);
  const conflict=await callApp(app,'POST',`/reviews/operations/${operationId}`,{cookie,body:{...body,rating:4}});
  expect(conflict.status).toBe(409);expect((await conflict.json<any>()).error).toBe('operation_conflict');
});
test('another owner cannot read a receipt and can use its own independent operation identity',async()=>{
  const a=await fixture(),b=await fixture();const operationId=newUuidV7();
  expect((await callApp(app,'POST',`/reviews/operations/${operationId}`,{cookie:a.cookie,body:{cardId:a.card.id,rating:3}})).status).toBe(200);
  expect((await callApp(app,'GET',`/reviews/operations/${operationId}`,{cookie:b.cookie})).status).toBe(404);
  expect((await callApp(app,'POST',`/reviews/operations/${operationId}`,{cookie:b.cookie,body:{cardId:b.card.id,rating:4}})).status).toBe(200);
});
test('undo preserves the operation tombstone so retry cannot resurrect its grade',async()=>{
  const {cookie,card}=await fixture();const operationId=newUuidV7();const body={cardId:card.id,rating:3};
  const grade=await callApp(app,'POST',`/reviews/operations/${operationId}`,{cookie,body});expect(grade.status).toBe(200);
  const {review}=await grade.json<any>();expect((await callApp(app,'POST','/reviews/undo',{cookie,body:{reviewId:review.id}})).status).toBe(200);
  const retry=await callApp(app,'POST',`/reviews/operations/${operationId}`,{cookie,body});expect(retry.status).toBe(409);
  expect((await retry.json<any>()).error).toBe('operation_reverted');
  const receipt=await(await callApp(app,'GET',`/reviews/operations/${operationId}`,{cookie})).json<any>();expect(receipt.status).toBe('reverted');
  expect(await(await callApp(app,'GET','/reviews',{cookie})).json()).toEqual([]);
});

test('checkpoint history lookup is bounded, owner-scoped and excludes undo snapshots',async()=>{
  const a=await fixture(),b=await fixture();
  const grade=await(await callApp(app,'POST',`/reviews/operations/${newUuidV7()}`,{cookie:a.cookie,body:{cardId:a.card.id,rating:3}})).json<any>();
  const path=`/reviews/records?ids=${grade.review.id}`;
  const own=await(await callApp(app,'GET',path,{cookie:a.cookie})).json<any>();expect(own.items).toHaveLength(1);expect(own.items[0].undoSnapshot).toBeUndefined();
  expect((await(await callApp(app,'GET',path,{cookie:b.cookie})).json<any>()).items).toEqual([]);
  expect((await callApp(app,'GET','/reviews/records?ids=not-a-uuid',{cookie:a.cookie})).status).toBe(400);
});
