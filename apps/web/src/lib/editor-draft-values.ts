import { isRecoveryAction, type RecoveryAction } from './recovery-action';
import type { PendingSave } from './recoverable-save';
import type { NoteType } from './types';
import type { FieldValues } from '@reomi/shared';

const operationId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type NoteDraftValue = { fieldValues: FieldValues; deckId: string; noteTypeId: string; tagsText: string; acceptedAnswersText: string; createOperationId?: string;
  pendingSave?: PendingSave<RecoveryAction> | null; savedNoteId?: string; baseVersion?: string; baseDeckId?: string; cardId?: string; label?: string; noteType?: NoteType; clozeRetainHistoryFor?: Record<string, number> };
export type TypeDraftValue = { pendingSave?: PendingSave<RecoveryAction> | null; savedType?: NoteType; name: string; fields: NoteType['fields']; templates: NoteType['templates']; styling: string; baseVersion?: string; kind?: NoteType['kind'] };
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const text = (x: unknown): x is string => typeof x === 'string';
const version = (x: unknown) => x === undefined || text(x) && Number.isFinite(Date.parse(x));
function fields(x: unknown): boolean {
  return Array.isArray(x) && x.length <= 64 && x.every(f => object(f) && text(f.name) && Number.isInteger(f.ord) && (f.id === undefined || text(f.id)) && (f.draftKey === undefined || text(f.draftKey) && f.draftKey.length <= 128) && (f.typeinAnswer === undefined || typeof f.typeinAnswer === 'boolean'));
}
function templates(x: unknown): boolean {
  return Array.isArray(x) && x.length <= 32 && x.every(t => object(t) && text(t.name) && Number.isInteger(t.ord) && text(t.frontTemplate) && text(t.backTemplate) && (t.id === undefined || text(t.id)) && (t.draftKey === undefined || text(t.draftKey) && t.draftKey.length <= 128));
}
function pending(x: unknown): boolean {
  return x == null || object(x) && text(x.owner) && text(x.requestId) && x.requestId.length <= 64 && text(x.fingerprint) && isRecoveryAction(x.payload);
}
export function isTypeDraftValue(x: unknown): x is TypeDraftValue {
  return object(x) && pending(x.pendingSave) && (x.savedType === undefined || object(x.savedType) && text(x.savedType.id) && text(x.savedType.name) && text(x.savedType.styling) && typeof x.savedType.isBuiltin === 'boolean' && ['basic', 'custom', 'cloze', 'typein'].includes(String(x.savedType.kind)) && fields(x.savedType.fields) && templates(x.savedType.templates) && version(x.savedType.updatedAt)) && (x.kind === undefined || ['basic', 'custom', 'cloze', 'typein'].includes(String(x.kind))) && text(x.name) && text(x.styling) && fields(x.fields) && templates(x.templates) && version(x.baseVersion);
}
export function isNoteDraftValue(x: unknown): x is NoteDraftValue {
  return object(x) && pending(x.pendingSave) && (x.savedNoteId === undefined || text(x.savedNoteId)) && object(x.fieldValues) && Object.values(x.fieldValues).every(text) &&
    (x.label === undefined || text(x.label)) && (x.cardId === undefined || text(x.cardId)) && (x.baseDeckId === undefined || text(x.baseDeckId)) && (x.createOperationId === undefined || text(x.createOperationId) && operationId.test(x.createOperationId)) && text(x.deckId) && text(x.noteTypeId) && text(x.tagsText) && text(x.acceptedAnswersText) && version(x.baseVersion) &&
    (x.clozeRetainHistoryFor === undefined || object(x.clozeRetainHistoryFor) && Object.values(x.clozeRetainHistoryFor).every(n => Number.isInteger(n) && Number(n) > 0)) &&
    (x.noteType === undefined || object(x.noteType) && text(x.noteType.id) && text(x.noteType.name) && text(x.noteType.styling) &&
      ['basic', 'custom', 'cloze', 'typein'].includes(String(x.noteType.kind)) && fields(x.noteType.fields) && templates(x.noteType.templates) && version(x.noteType.updatedAt));
}
