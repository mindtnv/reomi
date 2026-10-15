/** Copy-once browser storage migration from `nn:` to `reomi:`.
 * Old keys stay as a rollback snapshot. A newer `reomi:` value is never overwritten.
 * An empty `reomi:` value is a tombstone so a delete does not resurrect `nn:`.
 */

export type MigratingStorage = {
  getItem(key: string): string | null;
  setItem?(key: string, value: string): void;
};

export function currentStorageKey(key: string): string {
  return key.startsWith('nn:') ? `reomi:${key.slice(3)}` : key;
}

function brokenJson(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try { JSON.parse(value); return false; } catch { return true; }
}

export function readBrowserValue(storage: MigratingStorage, key: string): string | null {
  const current = currentStorageKey(key);
  let existing: string | null;
  try { existing = storage.getItem(current); } catch { return null; }
  if (existing !== null) return existing === '' ? null : existing;
  if (current === key) return null;
  let legacy: string | null;
  try { legacy = storage.getItem(key); } catch { return null; }
  if (legacy == null || legacy === '' || brokenJson(legacy)) return null;
  if (typeof storage.setItem === 'function') {
    try { storage.setItem(current, legacy); } catch { return legacy; }
  }
  return legacy;
}

export function writeBrowserValue(storage: MigratingStorage, key: string, value: string): void {
  if (typeof storage.setItem !== 'function') throw new Error('storage_unavailable');
  storage.setItem(currentStorageKey(key), value);
}

export function removeBrowserValue(storage: MigratingStorage, key: string): void {
  if (typeof storage.setItem !== 'function') throw new Error('storage_unavailable');
  storage.setItem(currentStorageKey(key), '');
}

/** Logical `nn:` keys from the rename design. `nn:chat:draft` is inventoried but not stored. */
export const PERSISTENT_STORAGE_KEYS = [
  'nn:theme',
  'nn:locale',
  'nn:sidebar-collapsed',
  'nn:sidebar-width',
  'nn:review:inspector-width',
  'nn:wco:hint',
  'nn:notifications:enabled',
  'nn:pwa:install-dismissed',
  'nn:cards:columns:desktop',
  'nn:cards:columns:mobile',
  'nn:cards:filters-width',
  'nn:cards:panel-width',
  'nn:decks:collapsed',
  'nn:graph:edges',
  'nn:chat:model',
  'nn:chat:rail-width',
  'nn:chat:research',
  'nn:chat:draft:new',
  'nn:assistant:drafts:v1:owner',
  'nn:assistant:window',
  'nn:lib:view',
  'nn:lib:searchmode',
  'nn:lib:toc:source',
  'nn:nb:dock:notebook',
  'nn:nb:docktab:notebook',
  'nn:nb:scope:notebook',
  'nn:nb:quickdeck',
  'nn:nb:readermode:source',
  'nn:pdf:pos:source',
  'nn:pdf:tools',
  'nn:lastSession:user',
  'nn:study:checkpoint:v1:owner',
  'nn:study:changed:owner',
  'nn:editor-draft:1:owner:note:entity',
  'nn:navigation:v1:owner',
  'nn:navigation:auth-return:v1',
  'nn:navigation:reload:v1',
  'nn:nb:prefill:notebook',
  'nn:ui-actions:session:v1:owner',
] as const;

export const WINDOW_EVENT_NAMES = [
  'nn:toast',
  'nn:knowledge-changed',
  'nn:open-palette',
  'nn:open-cheatsheet',
  'nn:open-drawer',
  'nn:close-drawer',
  'nn:navigation-clear',
  'nn:assistant:ask',
  'nn:ui-action',
  'nn:ui-action-storage-unavailable',
  'nn:operations-changed',
  'nn:pdf-marks-changed',
  'nn:appearance',
] as const;
