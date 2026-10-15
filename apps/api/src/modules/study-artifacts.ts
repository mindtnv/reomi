import { newOperationRun } from '../operation-run';
import { isArtifactGenerationEnabled } from '../ai/openai-client';
import { isSourceTextReadable } from './source-readability';
import { cancelArtifactRequests } from '../ai/artifact-cancellation';
import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, notebookArtifacts, notebooks, notebookSources, sourceChunks, sources } from '@reomi/db';
import { NOTEBOOK_ARTIFACT_TYPES, type NotebookArtifactType } from '@reomi/shared';
import type { Logger } from 'pino';
import { env } from '../env';
import { ARTIFACT_TYPE_TITLE, clampQuestionCount, scheduleArtifactGeneration } from '../ai/artifacts';
import { StudyError, type StudyOwner } from './study-notes';
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
async function lockOwner(tx: Tx, userId: string, owner: StudyOwner): Promise<{title:string;sourceStatus?:string;sourceError?:string|null}> {
  if(owner.kind==='source') {
    const [row]=await tx.select({title:sources.title,status:sources.status,errorCode:sources.errorCode}).from(sources).where(and(eq(sources.userId,userId),eq(sources.id,owner.id))).for('update').limit(1);
    if(!row||row.status==='deleting')throw new StudyError(404,'not_found');
    return {title:row.title,sourceStatus:row.status,sourceError:row.errorCode};
  }
  const [row]=await tx.select({title:notebooks.title}).from(notebooks).where(and(eq(notebooks.userId,userId),eq(notebooks.id,owner.id))).for('update').limit(1);
  if(!row)throw new StudyError(404,'not_found');return row;
}
const ownerScope=(userId:string,owner?:StudyOwner)=>and(eq(notebookArtifacts.userId,userId),
  owner?.kind==='notebook'?and(eq(notebookArtifacts.ownerKind,'notebook'),eq(notebookArtifacts.notebookId,owner.id)):
    and(eq(notebookArtifacts.ownerKind,'source'),owner?eq(notebookArtifacts.sourceOriginId,owner.id):undefined));
async function bump(tx:Tx,userId:string,owner?:StudyOwner){
  if(owner?.kind==='notebook')await tx.update(notebooks).set({updatedAt:sql`GREATEST(now(), ${notebooks.updatedAt} + interval '1 millisecond')`})
    .where(and(eq(notebooks.userId,userId),eq(notebooks.id,owner.id)));
}
export async function listStudyArtifacts(userId:string,owner?:StudyOwner,options:{unavailable?:boolean;offset?:number;limit?:number}={}) {
  return db.transaction(async tx=>{
    if(owner)await lockOwner(tx,userId,owner);
    const query=tx.select({id:notebookArtifacts.id,notebookId:notebookArtifacts.notebookId,ownerKind:notebookArtifacts.ownerKind,
      sourceId:notebookArtifacts.sourceId,sourceOriginId:notebookArtifacts.sourceOriginId,sourceOriginTitle:notebookArtifacts.sourceOriginTitle,
      type:notebookArtifacts.type,status:notebookArtifacts.status,title:notebookArtifacts.title,sourceIds:notebookArtifacts.sourceIds,
      errorCode:notebookArtifacts.errorCode,model:notebookArtifacts.model,createdAt:notebookArtifacts.createdAt,updatedAt:notebookArtifacts.updatedAt,
      progressChars:sql<number>`CASE WHEN ${notebookArtifacts.status} IN ('pending','generating') THEN COALESCE(length(${notebookArtifacts.contentMd}),0) ELSE 0 END`,
    }).from(notebookArtifacts).where(and(ownerScope(userId,owner),options.unavailable?isNull(notebookArtifacts.sourceId):undefined))
      .orderBy(desc(notebookArtifacts.createdAt),desc(notebookArtifacts.id));
    if(owner?.kind==='notebook')return {items:await query,nextOffset:null};
    const limit=Math.max(1,Math.min(50,Math.floor(options.limit??50)));
    const rows=await query.offset(options.offset??0).limit(limit+1);
    return {items:rows.slice(0,limit),nextOffset:rows.length>limit?(options.offset??0)+limit:null};
  });
}
export async function getStudyArtifact(userId:string,id:string,owner?:StudyOwner) {
  const [row]=await db.select().from(notebookArtifacts).where(and(ownerScope(userId,owner),eq(notebookArtifacts.id,id))).limit(1);
  if(!row)throw new StudyError(404,'not_found');return row;
}
export async function createStudyArtifact(userId:string,owner:StudyOwner,input:{type:string;sourceIds?:string[];questionCount?:number},log?:Logger) {
  const created=await db.transaction(async tx=>{
    const parent=await lockOwner(tx,userId,owner);
    if(!(NOTEBOOK_ARTIFACT_TYPES as readonly string[]).includes(input.type))throw new StudyError(400,'invalid_type');
    if(owner.kind==='source'&&!isArtifactGenerationEnabled())throw new StudyError(503,'ai_disabled');
    let scope:string[];
    if(owner.kind==='source') {
      const [chunk]=await tx.select({id:sourceChunks.id}).from(sourceChunks).where(and(eq(sourceChunks.userId,userId),eq(sourceChunks.sourceId,owner.id))).limit(1);
      scope=isSourceTextReadable(parent.sourceStatus!,parent.sourceError)&&chunk?[owner.id]:[];
    } else {
      const rows=await tx.select({id:sources.id}).from(notebookSources).innerJoin(sources,and(eq(sources.id,notebookSources.sourceId),eq(sources.userId,userId)))
        .where(and(eq(notebookSources.userId,userId),eq(notebookSources.notebookId,owner.id),eq(sources.status,'ready'),input.sourceIds!==undefined?inArray(sources.id,input.sourceIds):undefined)).orderBy(sources.id);
      scope=rows.map(row=>row.id);
    }
    if(!scope.length)throw new StudyError(400,'no_sources');
    const [total]=await tx.select({n:count()}).from(notebookArtifacts).where(ownerScope(userId,owner));
    if(total!.n>=env.ai.MAX_ARTIFACTS_PER_NOTEBOOK)throw new StudyError(409,'too_many_artifacts');
    const [active]=await tx.select({id:notebookArtifacts.id}).from(notebookArtifacts).where(and(ownerScope(userId,owner),inArray(notebookArtifacts.status,['pending','generating']))).limit(1);
    if(active)throw new StudyError(409,'generation_in_progress');
    const [sameType]=await tx.select({n:count()}).from(notebookArtifacts).where(and(ownerScope(userId,owner),eq(notebookArtifacts.type,input.type)));
    const base=ARTIFACT_TYPE_TITLE[input.type as NotebookArtifactType];
    const title=owner.kind==='source'?`${parent.title.slice(0,160)} · ${input.type} ${total!.n+1}`:sameType!.n?`${base} (${sameType!.n+1})`:base;
    const [row]=await tx.insert(notebookArtifacts).values({userId,ownerKind:owner.kind,
      ...(owner.kind==='source'?{sourceId:owner.id,sourceOriginId:owner.id,sourceOriginTitle:parent.title.trim().slice(0,200)||'Source'}:{notebookId:owner.id}),
      sourceIds:scope,type:input.type,title,status:'pending',...newOperationRun(),
      generationOptions:input.type==='quiz'?{questionCount:clampQuestionCount(input.questionCount)}:{}}).returning();
    await bump(tx,userId,owner);return row!;
  });
  scheduleArtifactGeneration(created.id,{runId:created.operationRunId!,requestLog:log});return created;
}
export async function regenerateStudyArtifactInTransaction(
  tx: Tx, userId: string, id: string, owner?: StudyOwner,
  retry?: { runId: string; acceptDefaults?: boolean; beforeStart?: () => void },
) {
  const [original] = await tx.select().from(notebookArtifacts).where(and(ownerScope(userId, owner), eq(notebookArtifacts.id, id))).limit(1);
  if (!original) throw new StudyError(404, 'not_found');
  if (original.ownerKind === 'source' && !original.sourceId) throw new StudyError(409, 'source_unavailable');
  const actualOwner: StudyOwner = owner ?? { kind: 'source', id: original.sourceId! };
  let parent;
  try { parent = await lockOwner(tx, userId, actualOwner); }
  catch (error) { if (actualOwner.kind === 'source' && error instanceof StudyError) throw new StudyError(409, 'source_unavailable'); throw error; }
  const [current] = await tx.select().from(notebookArtifacts).where(and(ownerScope(userId, actualOwner), eq(notebookArtifacts.id, id))).for('update').limit(1);
  if (!current) throw new StudyError(404, 'not_found');
  if (retry && current.operationRunId !== retry.runId) return { row: current, stale: true };
  if (!['ready', 'error'].includes(current.status)) throw new StudyError(409, 'not_terminal');
  if (retry && current.status !== 'error') throw new StudyError(409, 'not_failed');
  if (actualOwner.kind === 'source' && !isSourceTextReadable(parent.sourceStatus!, parent.sourceError)) throw new StudyError(409, 'source_unavailable');
  if ((retry || actualOwner.kind === 'source') && !isArtifactGenerationEnabled()) throw new StudyError(503, 'ai_disabled');
  if (retry) {
    const available = await tx.select({ id: sources.id }).from(sources).where(and(eq(sources.userId, userId),
      inArray(sources.id, current.sourceIds), actualOwner.kind === 'source'
        ? sql`(${sources.status} IN ('ready','indexing') OR (${sources.status} = 'error' AND ${sources.errorCode} = 'index_failed'))`
        : eq(sources.status, 'ready'))).limit(1);
    if (!available.length) throw new StudyError(409, 'source_unavailable');
    if (current.type === 'quiz' && !current.generationOptions && !retry.acceptDefaults) throw new StudyError(409, 'confirm_defaults');
  }
  const [active] = await tx.select({ id: notebookArtifacts.id }).from(notebookArtifacts)
    .where(and(ownerScope(userId, actualOwner), inArray(notebookArtifacts.status, ['pending', 'generating']))).limit(1);
  if (active) throw new StudyError(409, 'generation_in_progress');
  retry?.beforeStart?.();
  const [row] = await tx.update(notebookArtifacts).set({ status: 'pending', errorCode: null, ...newOperationRun(),
    generationOptions: current.generationOptions ?? (current.type === 'quiz' ? { questionCount: clampQuestionCount(undefined) } : {}),
    updatedAt: sql`GREATEST(now(), ${notebookArtifacts.updatedAt} + interval '1 millisecond')` })
    .where(and(ownerScope(userId, actualOwner), eq(notebookArtifacts.id, id))).returning();
  await bump(tx, userId, actualOwner);
  return { row: row!, stale: false };
}

export async function regenerateStudyArtifact(userId: string, id: string, owner?: StudyOwner, log?: Logger) {
  const { row } = await db.transaction(tx => regenerateStudyArtifactInTransaction(tx, userId, id, owner));
  scheduleArtifactGeneration(row.id, { runId: row.operationRunId!, requestLog: log });
  return row;
}
export async function deleteStudyArtifact(userId:string,id:string,owner?:StudyOwner) {
  const result=await db.transaction(async tx=>{
    if(owner)await lockOwner(tx,userId,owner);
    const [row]=await tx.delete(notebookArtifacts).where(and(ownerScope(userId,owner),eq(notebookArtifacts.id,id))).returning({id:notebookArtifacts.id});
    if(!row)throw new StudyError(404,'not_found');await bump(tx,userId,owner);return {ok:true};
  });
  cancelArtifactRequests([id]);return result;
}
// Source routes and retained-work routes preserve their existing request shapes.
export const listSourceArtifacts=(userId:string,sourceId?:string,unavailable=false,offset=0,limit?:number)=>listStudyArtifacts(userId,sourceId?{kind:'source',id:sourceId}:undefined,{unavailable,offset,limit});
export const getSourceArtifact=(userId:string,id:string)=>getStudyArtifact(userId,id);
export const createSourceArtifact=(userId:string,sourceId:string,input:{type:string;questionCount?:number},log?:Logger)=>createStudyArtifact(userId,{kind:'source',id:sourceId},input,log);
export const regenerateSourceArtifact=(userId:string,id:string,log?:Logger)=>regenerateStudyArtifact(userId,id,undefined,log);
export const deleteSourceArtifact=(userId:string,id:string)=>deleteStudyArtifact(userId,id);
