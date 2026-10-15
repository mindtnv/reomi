import { newUuidV7 } from '@reomi/shared';
import { currentStorageKey, readBrowserValue, removeBrowserValue, writeBrowserValue } from './storage-migration';

export const MAX_DRAFT_BYTES = 256 * 1024;
export const MAX_DRAFTS = 10;
const MAX_OWNER_BYTES = 1024 * 1024;
export interface DraftScope { ownerId: string; kind: 'note' | 'type' | 'study-note'; entityId: string }
export interface EditorDraft<T = unknown> extends DraftScope { version: 1; revision: string; updatedAt: number; value: T }
type DraftStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;
export class DraftStorageError extends Error {
  constructor(readonly code: 'unavailable' | 'invalid' | 'too_large' | 'capacity' | 'changed') { super(code); }
}
const legacyPrefix = (owner: string) => `nn:editor-draft:1:${encodeURIComponent(owner)}:`;
const currentPrefix = (owner: string) => currentStorageKey(legacyPrefix(owner));
const legacyDraftKey = (scope: DraftScope) => `${legacyPrefix(scope.ownerId)}${scope.kind}:${encodeURIComponent(scope.entityId)}`;
export const editorDraftKey = (scope: DraftScope) => currentStorageKey(legacyDraftKey(scope));
const logicalDraftId = (scope: DraftScope) => `${scope.kind}:${encodeURIComponent(scope.entityId)}`;
function parseDraftCandidate(ownerId: string, candidate: string): DraftScope | null {
  const current = candidate.startsWith(currentPrefix(ownerId));
  const legacy = candidate.startsWith(legacyPrefix(ownerId));
  if (!current && !legacy) return null;
  const parts = candidate.slice((current ? currentPrefix(ownerId) : legacyPrefix(ownerId)).length).split(':');
  if (parts.length !== 2 || !['note', 'type', 'study-note'].includes(parts[0]!)) return null;
  try { return { ownerId, kind: parts[0] as DraftScope['kind'], entityId: decodeURIComponent(parts[1]!) }; } catch { return null; }
}
function draftSlots(store: DraftStorage, ownerId: string): Map<string, DraftScope> {
  const slots = new Map<string, DraftScope>();
  const tombstones = new Set<string>();
  for (let i = 0; i < store.length; i++) {
    const candidate = store.key(i);
    if (!candidate) continue;
    const scope = parseDraftCandidate(ownerId, candidate);
    if (!scope) continue;
    const id = logicalDraftId(scope);
    if (candidate.startsWith(currentPrefix(ownerId)) && store.getItem(candidate) === '') { tombstones.add(id); slots.delete(id); continue; }
    if (tombstones.has(id)) continue;
    if (!slots.has(id) || candidate.startsWith(currentPrefix(ownerId))) slots.set(id, scope);
  }
  for (const id of tombstones) slots.delete(id);
  return slots;
}
function backend(storage?: DraftStorage): DraftStorage {
  try { return storage ?? localStorage; } catch { throw new DraftStorageError('unavailable'); }
}
function guarded<T>(run: () => T): T {
  try { return run(); } catch (error) {
    if (error instanceof DraftStorageError) throw error;
    throw new DraftStorageError('unavailable');
  }
}
export function readEditorDraft<T = unknown>(scope: DraftScope, storage?: DraftStorage): EditorDraft<T> | null {
  return guarded(() => {
    if (!scope.ownerId || !scope.entityId) return null;
    const store = backend(storage);
    const legacy = legacyDraftKey(scope);
    store.getItem(currentStorageKey(legacy));
    store.getItem(legacy);
    const raw = readBrowserValue(store, legacy);
    if (!raw) return null;
    if (new TextEncoder().encode(raw).byteLength > MAX_DRAFT_BYTES) throw new DraftStorageError('invalid');
    let entry: EditorDraft<T>;
    try { entry = JSON.parse(raw); } catch { throw new DraftStorageError('invalid'); }
    if (!entry || entry.version !== 1 || entry.ownerId !== scope.ownerId || entry.kind !== scope.kind || entry.entityId !== scope.entityId ||
      typeof entry.revision !== 'string' || entry.revision.length > 64 || !Number.isFinite(entry.updatedAt) || !entry.value || typeof entry.value !== 'object') throw new DraftStorageError('invalid');
    return entry;
  });
}
export function writeEditorDraft<T extends object>(scope: DraftScope, value: T, expectedRevision: string | null, storage?: DraftStorage): EditorDraft<T> {
  return guarded(() => {
    if (!scope.ownerId || !scope.entityId) throw new DraftStorageError('unavailable');
    const store = backend(storage);
    const current = readEditorDraft(scope, store);
    if ((current?.revision ?? null) !== expectedRevision) throw new DraftStorageError('changed');
    const record: EditorDraft<T> = { version: 1, ...scope, revision: newUuidV7(), updatedAt: Date.now(), value };
    const raw = JSON.stringify(record);
    const bytes = new TextEncoder().encode(raw).byteLength;
    if (bytes > MAX_DRAFT_BYTES) throw new DraftStorageError('too_large');
    let count = 0; let total = bytes;
    for (const other of draftSlots(store, scope.ownerId).values()) {
      if (logicalDraftId(other) === logicalDraftId(scope)) continue;
      const occupied = readBrowserValue(store, legacyDraftKey(other));
      if (!occupied) continue;
      count++;
      total += new TextEncoder().encode(occupied).byteLength;
    }
    if (count >= MAX_DRAFTS || total > MAX_OWNER_BYTES) throw new DraftStorageError('capacity');
    writeBrowserValue(store, legacyDraftKey(scope), raw);
    return record;
  });
}
/** Revision check keeps a late save/discard from erasing another tab's work. */
export function clearEditorDraft(scope: DraftScope, expectedRevision: string | null, storage?: DraftStorage): boolean {
  return guarded(() => {
    const store = backend(storage);
    const current = readEditorDraft(scope, store);
    if ((current?.revision ?? null) !== expectedRevision) return false;
    removeBrowserValue(store, legacyDraftKey(scope));
    return true;
  });
}
/** Stable comparison of editable values; object-key order is not an edit. */
export function draftFingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
}

/** Explicit dismissal of an unreadable record, only in this owner's slot. */
export function clearInvalidEditorDraft(scope: DraftScope): void {
  guarded(() => {
    try { readEditorDraft(scope); } catch (error) {
      if (error instanceof DraftStorageError && error.code === 'invalid') { removeBrowserValue(backend(), legacyDraftKey(scope)); return; }
      throw error;
    }
  });
}

export interface DraftListEntry { scope: DraftScope; record: EditorDraft | null }
/** Includes unreadable slots without exposing an unverified payload. */
export function listEditorDrafts(ownerId: string, storage?: DraftStorage): DraftListEntry[] {
  return guarded(() => {
    if (!ownerId) return [];
    const store = backend(storage); const entries: DraftListEntry[] = [];
    for (const scope of draftSlots(store, ownerId).values()) {
      try { entries.push({ scope, record: readEditorDraft(scope, store) }); }
      catch (error) { if (error instanceof DraftStorageError && error.code === 'invalid') entries.push({ scope, record: null }); else throw error; }
    }
    return entries.sort((a, b) => (b.record?.updatedAt ?? 0) - (a.record?.updatedAt ?? 0));
  });
}

export function editorDraftDownload(value: unknown, kind: DraftScope['kind']): { filename: string; body: string } {
  return { filename: `reomi-${kind}-draft.json`, body: JSON.stringify(value, null, 2) };
}

/** Download the current in-memory value as well as already persisted drafts. */
export function downloadEditorDraft(value: unknown, kind: DraftScope['kind']): void {
  const file = editorDraftDownload(value, kind);
  const url = URL.createObjectURL(new Blob([file.body], { type: 'application/json' }));
  try {
    const link = document.createElement('a'); link.href = url; link.download = file.filename; link.click();
  } finally { URL.revokeObjectURL(url); }
}
