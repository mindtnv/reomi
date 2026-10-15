import { cardEvidenceFingerprint, evidenceExcerpt } from './legacy-evidence';
export { cardEvidenceFingerprint } from './legacy-evidence';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { cards, cardSources, db, sourceChunks, sources } from '@reomi/db';
import { normalizeSourceText } from '@reomi/shared';
import { resolveAssistantRefs } from './assistant-context';
import type { AssistantObjectSnapshot, CardEvidenceSnapshot, ChunkCardEvidenceSnapshot } from '@reomi/shared';
import { env } from '../env';
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];


/** Called with the turn's server-owned read accumulator, never model-supplied
 * permissions. Each card explicitly selects a bounded subset of those reads. */
export interface ReadEvidenceChunk { id: string; text: string; position: number; page?: number | null }
export async function captureCardEvidence(userId: string, selected: string[], readChunkIds: readonly string[], readSnapshots?: readonly CardEvidenceSnapshot[]): Promise<CardEvidenceSnapshot[]> {
  const ids = [...new Set(selected)];
  if (ids.length > env.ai.CARD_SOURCE_LINK_CAP || ids.some(id => !readChunkIds.includes(id))) throw new Error('invalid_evidence');
  const current = await resolveEvidence(userId, ids);
  if (readSnapshots) return current.map(item => {
    const read = readSnapshots.find(snapshot => snapshot.chunkId === item.chunkId);
    if (!read || read.textHash !== item.textHash) throw new Error('stale_evidence');
    return read;
  });
  return current;
}
export async function captureReadEvidence(userId: string, observed: ReadEvidenceChunk[]): Promise<ChunkCardEvidenceSnapshot[]> {
  return resolveEvidence(userId, [...new Set(observed.map(chunk => chunk.id))].slice(0,24), observed);
}
async function resolveEvidence(userId: string, ids: string[], observed?: ReadEvidenceChunk[]): Promise<ChunkCardEvidenceSnapshot[]> {
  if (!ids.length) return [];
  const rows = await db.select({ id: sourceChunks.id, sourceId: sources.id, sourceTitle: sources.title,
    text: sourceChunks.text, sourceHash: sourceChunks.sourceHash, position: sourceChunks.position, page: sourceChunks.page, startSeconds: sourceChunks.startSeconds })
    .from(sourceChunks).innerJoin(sources,and(eq(sources.id,sourceChunks.sourceId),eq(sources.userId,userId)))
    .where(and(eq(sourceChunks.userId,userId),inArray(sourceChunks.id,ids)));
  if (rows.length !== ids.length) throw new Error('invalid_evidence');
  return ids.map(id => {
    const row = rows.find(row => row.id === id)!;
    if (observed) {
      const read = observed.find(chunk => chunk.id === id);
      if (!read || read.text !== row.text || read.position !== row.position || (read.page ?? null) !== row.page) throw new Error('stale_evidence');
    }
    return { version:1, sourceId:row.sourceId, sourceTitle:evidenceExcerpt(row.sourceTitle,200), chunkId:id,
      position:row.position, ...(row.page != null ? {page:row.page} : {}), ...(row.startSeconds != null ? {startSeconds:row.startSeconds} : {}), quote:evidenceExcerpt(row.text,320), textHash:cardEvidenceFingerprint(row) };
  });
}

/** A supplied excerpt has already been verified at context admission. Recheck
 * its exact version while holding source/chunk read locks, then record only the
 * chunks intersecting that excerpt as evidence for this turn. */
export async function captureSuppliedEvidence(userId: string, refs: readonly AssistantObjectSnapshot[]): Promise<ChunkCardEvidenceSnapshot[]> {
  const collected = new Map<string,ChunkCardEvidenceSnapshot>();
  for (const supplied of refs) {
    if (!supplied.available || !supplied.verifiedQuote || !supplied.excerpt || !supplied.version || supplied.ref.kind !== 'source_passage') continue;
    const ref = supplied.ref;
    const captured = await db.transaction(async tx => {
      const [source] = await tx.select({id:sources.id,title:sources.title}).from(sources)
        .where(and(eq(sources.userId,userId),eq(sources.id,ref.id),ne(sources.status,'deleting'))).for('share').limit(1);
      if (!source) return [];
      const locator=ref.locator, ids=locator.chunkId?[locator.chunkId]:locator.chunks?.map(chunk=>chunk.chunkId);
      const rows=await tx.select().from(sourceChunks).where(and(eq(sourceChunks.userId,userId),eq(sourceChunks.sourceId,ref.id),
        ids?inArray(sourceChunks.id,ids):undefined,locator.page!==undefined?eq(sourceChunks.page,locator.page):undefined,
        locator.position!==undefined?eq(sourceChunks.position,locator.position):undefined,locator.section?eq(sourceChunks.heading,locator.section):undefined))
        .orderBy(sourceChunks.position).limit(16).for('share');
      const [current]=await resolveAssistantRefs(userId,[ref],{ex:tx,allowUnavailable:true});
      if (!current?.available || !current.verifiedQuote || current.version!==supplied.version) return [];
      const parts=rows.map(row=>{
        const range=locator.chunks?.find(chunk=>chunk.chunkId===row.id)??(locator.chunkId?locator:undefined);
        return {row,text:normalizeSourceText(range?.start!==undefined?row.text.slice(range.start,range.end):row.text)};
      }).filter(part=>part.text.length>0);
      const needle=normalizeSourceText(supplied.excerpt!),joined=parts.map(part=>part.text).join(' '),start=joined.indexOf(needle);
      if(start<0)return [];
      const end=start+needle.length;let position=0;
      const evidence:ChunkCardEvidenceSnapshot[]=[];
      for(const part of parts){
        const left=Math.max(0,start-position),right=Math.min(part.text.length,end-position);
        if(right>left)evidence.push({version:1,sourceId:source.id,sourceTitle:evidenceExcerpt(source.title,200),chunkId:part.row.id,
          position:part.row.position,...(part.row.page!=null?{page:part.row.page}:{}),quote:part.text.slice(left,right).slice(0,320),textHash:cardEvidenceFingerprint(part.row)});
        position+=part.text.length+1;
      }
      return evidence;
    });
    for(const snapshot of captured){if(collected.size>=24)break;if(!collected.has(snapshot.chunkId))collected.set(snapshot.chunkId,snapshot);}
  }
  return [...collected.values()];
}

export interface QuotedEvidenceInput { sourceId: string; quote: string }
export async function captureQuotedEvidence(userId: string, selected: QuotedEvidenceInput[], supplied: readonly AssistantObjectSnapshot[]): Promise<CardEvidenceSnapshot[]> {
  if (selected.length > env.ai.CARD_SOURCE_LINK_CAP) throw new Error('invalid_evidence');
  const snapshots: CardEvidenceSnapshot[] = [];
  for (const selection of selected) {
    const original = supplied.find(item => item.available && item.ref.kind === 'source_passage' && item.ref.id === selection.sourceId && item.excerpt === selection.quote);
    if (!original || !selection.quote.trim() || selection.quote.length > 4000) throw new Error('invalid_evidence');
    const [source] = await db.select({ id:sources.id,title:sources.title,updatedAt:sources.updatedAt }).from(sources)
      .where(and(eq(sources.userId,userId),eq(sources.id,selection.sourceId),ne(sources.status,'deleting'))).limit(1);
    if (!source) throw new Error('invalid_evidence');
    snapshots.push({ kind:'user_quote',version:1,sourceId:source.id,sourceTitle:evidenceExcerpt(source.title,200),quote:selection.quote,
      sourceVersion:source.updatedAt.toISOString(), ...(original.ref.kind === 'source_passage' && original.ref.locator.page !== undefined ? {page:original.ref.locator.page} : {}) });
  }
  return snapshots;
}

/** Verify before inserting any links. The caller owns the same transaction as
 * card creation and approval consumption, so stale evidence rolls it all back. */
export async function writePerCardProvenance(tx: Tx, input: {
  userId: string;
  cards: { cardIds: string[]; evidence: CardEvidenceSnapshot[] }[];
  notebookId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
}) {
  const evidence = input.cards.flatMap(card => card.evidence);
  if (!evidence.length) return;
  const sourceIds = [...new Set(evidence.map(item => item.sourceId))];
  const liveSources = await tx.select({ id:sources.id,updatedAt:sources.updatedAt }).from(sources)
    .where(and(eq(sources.userId,input.userId),ne(sources.status,'deleting'),inArray(sources.id,sourceIds))).orderBy(sources.id).for('share');
  if (liveSources.length !== sourceIds.length) throw new Error('stale_evidence');
  const ids = [...new Set(evidence.flatMap(item => item.kind === 'user_quote' ? [] : [item.chunkId]))];
  const chunks = await tx.select().from(sourceChunks).where(and(eq(sourceChunks.userId,input.userId),inArray(sourceChunks.id,ids)))
    .orderBy(sourceChunks.id).for('share');
  for (const item of evidence) {
    if (item.kind === 'user_quote') {
      if (liveSources.find(source => source.id === item.sourceId)?.updatedAt.toISOString() !== item.sourceVersion) throw new Error('stale_evidence');
      continue;
    }
    const chunk = chunks.find(chunk => chunk.id === item.chunkId);
    if (!chunk || chunk.sourceId !== item.sourceId || cardEvidenceFingerprint(chunk) !== item.textHash) throw new Error('stale_evidence');
  }
  const cardIds = [...new Set(input.cards.flatMap(card => card.cardIds))];
  if (!cardIds.length) return;
  const owned = await tx.select({id:cards.id}).from(cards).where(and(eq(cards.userId,input.userId),inArray(cards.id,cardIds))).for('share');
  if (owned.length !== cardIds.length) throw new Error('card_not_found');
  const values = input.cards.flatMap(entry => entry.cardIds.flatMap(cardId => entry.evidence.map(item => ({
    userId: input.userId, cardId, sourceId: item.sourceId, sourceChunkId: item.chunkId ?? null, sourceSnapshot:item,
    notebookId:input.notebookId ?? null, conversationId:input.conversationId ?? null, messageId:input.messageId ?? null,
  }))));
  if (values.length) await tx.insert(cardSources).values(values).onConflictDoNothing({ target:[cardSources.cardId,cardSources.sourceChunkId], where:sql`source_chunk_id IS NOT NULL` });
}
