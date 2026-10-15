import { parseAssistantContext, type AssistantObjectSnapshot, type MessageAttachmentInput } from '@reomi/shared';
import type { AssistantConversation, AssistantSession } from './assistant-controller';
import { currentStorageKey, readBrowserValue, writeBrowserValue, type MigratingStorage } from './storage-migration';

export type AssistantDraftRecord = Pick<AssistantSession, 'key' | 'conversationId' | 'draft' | 'refs' | 'pins' | 'policy' | 'policySelection' | 'attachments' | 'model' | 'research' | 'queue'> & { conversation?: AssistantConversation };
const MAX_BYTES = 1024 * 1024;
export const MAX_ASSISTANT_DRAFTS = 10;
const legacyAssistantDraftKey = (ownerId: string) => `nn:assistant:drafts:v1:${encodeURIComponent(ownerId)}`;
export const assistantDraftStorageKey = (ownerId: string) => currentStorageKey(legacyAssistantDraftKey(ownerId));
type Failure = { ok: false; error: 'draft_storage_invalid' | 'draft_storage_full' | 'draft_storage_unavailable' };
const text = (value: unknown, max: number) => typeof value === 'string' && value.length <= max;
function snapshots(value: unknown): value is AssistantObjectSnapshot[] {
  if (!Array.isArray(value) || value.length > 16) return false;
  try {
    parseAssistantContext({ version:1,refs:value.map(s => s.ref) });
    return value.every(s => s && text(s.label,200) && typeof s.available === 'boolean' && (s.excerpt === undefined || text(s.excerpt,4000)));
  } catch { return false; }
}
function attachments(value: unknown): value is MessageAttachmentInput[] {
  return Array.isArray(value) && value.length <= 4 && value.every(a => a &&
    (a.kind === 'text' ? text(a.name,200) && text(a.text,20000) : a.kind === 'image' && text(a.mediaId,100) && (a.name === undefined || text(a.name,200))));
}
function valid(records: unknown): records is AssistantDraftRecord[] {
  if (!Array.isArray(records) || records.length > MAX_ASSISTANT_DRAFTS) return false;
  const keys = new Set<string>();
  return records.every(r => {
    if (!r || !text(r.key,100) || !/^draft-[\w-]+$/.test(r.key) || keys.has(r.key)) return false;
    keys.add(r.key);
    if (!(r.conversationId === null || text(r.conversationId,100)) || !text(r.draft,MAX_BYTES) || !snapshots(r.refs) || !snapshots(r.pins)
      || (r.policySelection !== undefined && !['focus','strict'].includes(r.policySelection)) || !['focus','strict'].includes(r.policy) || !attachments(r.attachments) || typeof r.research !== 'boolean'
      || (r.model !== undefined && !text(r.model,200)) || !Array.isArray(r.queue) || r.queue.length > 20) return false;
    if (r.conversation && (r.conversation.id !== r.conversationId || !text(r.conversation.updatedAt,100)
      || !(r.conversation.title === null || text(r.conversation.title,200)))) return false;
    if (r.conversation?.context && (!snapshots(r.conversation.context.refs) || !['focus','strict'].includes(r.conversation.context.policy)
      || !Number.isSafeInteger(r.conversation.context.revision) || r.conversation.context.revision < 0)) return false;
    return r.queue.every((q: any) => q && text(q.id,100) && text(q.content,8000) && snapshots(q.refs) && snapshots(q.pins)
      && attachments(q.attachments) && typeof q.research === 'boolean' && ['focus','strict'].includes(q.policy)
      && (q.policySelection === undefined || ['focus','strict'].includes(q.policySelection))
      && (q.editing===undefined||typeof q.editing==='boolean')
      && Number.isSafeInteger(q.expectedRevision) && q.expectedRevision >= 0 && (q.model === undefined || text(q.model,200)));
  });
}
export function readAssistantDrafts(storage: MigratingStorage, ownerId: string): { ok:true;records:AssistantDraftRecord[] } | Failure {
  try {
    const raw = readBrowserValue(storage, legacyAssistantDraftKey(ownerId));
    if (!raw) return {ok:true,records:[]};
    if (new TextEncoder().encode(raw).length > MAX_BYTES) return {ok:false,error:'draft_storage_full'};
    const data = JSON.parse(raw);
    if (data.version !== 1 || data.ownerId !== ownerId || !valid(data.records)) return {ok:false,error:'draft_storage_invalid'};
    return {ok:true,records:data.records};
  } catch { return {ok:false,error:'draft_storage_unavailable'}; }
}
export function writeAssistantDrafts(storage: MigratingStorage, ownerId: string, records: AssistantDraftRecord[]): {ok:true} | Failure {
  if (records.length > MAX_ASSISTANT_DRAFTS) return {ok:false,error:'draft_storage_full'};
  if (!valid(records)) return {ok:false,error:'draft_storage_invalid'};
  try {
    const raw=JSON.stringify({version:1,ownerId,records});
    if (new TextEncoder().encode(raw).length>MAX_BYTES) return {ok:false,error:'draft_storage_full'};
    writeBrowserValue(storage, legacyAssistantDraftKey(ownerId), raw); return {ok:true};
  } catch { return {ok:false,error:'draft_storage_unavailable'}; }
}
