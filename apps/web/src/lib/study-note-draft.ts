import { NOTE_CONTENT_MAX, NOTE_TITLE_MAX } from '@reomi/shared';
import type { PendingSave } from './recoverable-save';
import { MAX_DRAFT_BYTES } from './editor-drafts';

export interface StudyNoteSave {
  id?: string;
  owner?: { kind: 'source' | 'notebook'; id: string };
  expectedRevision: number;
  title: string;
  content: string;
}
export interface StudyNoteDraft extends StudyNoteSave {
  version: 1;
  pendingSave?: PendingSave<StudyNoteSave> | null;
}
export function isStudyNoteSave(value: unknown, maxContent = NOTE_CONTENT_MAX): value is StudyNoteSave {
  if (!value || typeof value !== 'object') return false;
  const v = value as StudyNoteSave;
  return typeof v.title === 'string' && v.title.length <= NOTE_TITLE_MAX && typeof v.content === 'string' && v.content.length <= maxContent
    && Number.isSafeInteger(v.expectedRevision) && v.expectedRevision >= 0 && (v.id === undefined || typeof v.id === 'string')
    && (v.owner === undefined || v.owner && ['source', 'notebook'].includes(v.owner.kind) && typeof v.owner.id === 'string')
    && Boolean(v.id || v.owner);
}
export function isStudyNoteDraft(value: unknown): value is StudyNoteDraft {
  // A draft may contain over-limit input that the server has rejected. Keep it
  // recoverable; the shared byte budget, not the server note limit, bounds storage.
  if (!isStudyNoteSave(value, MAX_DRAFT_BYTES) || (value as StudyNoteDraft).version !== 1) return false;
  const pending = (value as StudyNoteDraft).pendingSave;
  return !pending || typeof pending.owner === 'string' && typeof pending.requestId === 'string' && pending.requestId.length <= 64
    && typeof pending.fingerprint === 'string' && isStudyNoteSave(pending.payload);
}
