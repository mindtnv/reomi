import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  PERSISTENT_STORAGE_KEYS,
  WINDOW_EVENT_NAMES,
  currentStorageKey,
  readBrowserValue,
  removeBrowserValue,
  writeBrowserValue,
} from './storage-migration';

function memory() {
  const data = new Map<string, string>();
  return {
    data,
    getItem(key: string) { return data.has(key) ? data.get(key)! : null; },
    setItem(key: string, value: string) { data.set(key, value); },
  };
}

describe('browser storage migration', () => {
  test('prefers an existing reomi value and does not overwrite it from nn', () => {
    const store = memory();
    store.setItem('nn:locale', 'en');
    store.setItem('reomi:locale', 'ru');
    expect(readBrowserValue(store, 'nn:locale')).toBe('ru');
    expect(store.data.get('nn:locale')).toBe('en');
    expect(store.data.get('reomi:locale')).toBe('ru');
  });

  test('copies a missing reomi key once and leaves the nn snapshot', () => {
    const store = memory();
    store.setItem('nn:theme', '{"version":2,"mode":"dark","palette":"dracula"}');
    expect(readBrowserValue(store, 'nn:theme')).toBe('{"version":2,"mode":"dark","palette":"dracula"}');
    expect(store.data.get('reomi:theme')).toBe(store.data.get('nn:theme'));
    store.setItem('nn:theme', 'later');
    expect(readBrowserValue(store, 'nn:theme')).toBe('{"version":2,"mode":"dark","palette":"dracula"}');
  });

  test('a write error keeps the old key and still returns it', () => {
    const store = memory();
    store.setItem('nn:locale', 'ru');
    const failing = {
      getItem: store.getItem.bind(store),
      setItem() { throw new Error('quota'); },
    };
    expect(readBrowserValue(failing, 'nn:locale')).toBe('ru');
    expect(store.data.has('reomi:locale')).toBe(false);
    expect(store.data.get('nn:locale')).toBe('ru');
  });

  test('broken JSON is not copied and is not deleted', () => {
    const store = memory();
    store.setItem('nn:assistant:window', '{broken');
    expect(readBrowserValue(store, 'nn:assistant:window')).toBeNull();
    expect(store.data.get('nn:assistant:window')).toBe('{broken');
    expect(store.data.has('reomi:assistant:window')).toBe(false);
  });

  test('broken JSON already on the reomi key is returned unchanged', () => {
    const store = memory();
    store.setItem('nn:assistant:window', '{"version":1}');
    store.setItem('reomi:assistant:window', '{broken');
    expect(readBrowserValue(store, 'nn:assistant:window')).toBe('{broken');
    expect(store.data.get('nn:assistant:window')).toBe('{"version":1}');
  });

  test('an empty reomi value is a tombstone and does not resurrect nn', () => {
    const store = memory();
    store.setItem('nn:notifications:enabled', 'true');
    writeBrowserValue(store, 'nn:notifications:enabled', 'true');
    removeBrowserValue(store, 'nn:notifications:enabled');
    expect(store.data.get('nn:notifications:enabled')).toBe('true');
    expect(readBrowserValue(store, 'nn:notifications:enabled')).toBeNull();
    expect(store.data.get('reomi:notifications:enabled')).toBe('');
  });

  test('writes only the current key', () => {
    const store = memory();
    writeBrowserValue(store, 'nn:graph:edges', 'semantic');
    expect(store.data.get('reomi:graph:edges')).toBe('semantic');
    expect(store.data.has('nn:graph:edges')).toBe(false);
  });

  test('every inventoried prefix round-trips through the helper', () => {
    for (const key of PERSISTENT_STORAGE_KEYS) {
      const store = memory();
      store.setItem(key, 'kept');
      expect(currentStorageKey(key)).toBe(`reomi:${key.slice(3)}`);
      expect(readBrowserValue(store, key)).toBe('kept');
      expect(store.data.get(key)).toBe('kept');
      expect(store.data.get(currentStorageKey(key))).toBe('kept');
    }
    expect(PERSISTENT_STORAGE_KEYS).toContain('nn:chat:draft:new');
  });
});

const STORAGE_PREFIXES = [
  'nn:theme', 'nn:locale', 'nn:sidebar-collapsed', 'nn:sidebar-width',
  'nn:review:inspector-width', 'nn:wco:hint', 'nn:notifications:enabled',
  'nn:cards:columns:', 'nn:cards:filters-width', 'nn:cards:panel-width',
  'nn:decks:collapsed', 'nn:graph:edges', 'nn:chat:model', 'nn:chat:rail-width',
  'nn:chat:research', 'nn:assistant:drafts:v1:', 'nn:assistant:window',
  'nn:lib:view', 'nn:lib:searchmode', 'nn:lib:toc:', 'nn:nb:dock:', 'nn:nb:docktab:',
  'nn:nb:scope:', 'nn:nb:quickdeck', 'nn:nb:readermode:', 'nn:pdf:pos:', 'nn:pdf:tools',
  'nn:lastSession:', 'nn:study:checkpoint:v1:', 'nn:study:changed:',
  'nn:editor-draft:1:', 'nn:navigation:v1:', 'nn:navigation:auth-return:v1',
  'nn:navigation:reload:v1', 'nn:nb:prefill:', 'nn:ui-actions:session:v1:',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

describe('persistent key and event contract', () => {
  test('live nn: literals are events, nnNavigation, or a known storage prefix', () => {
    const root = join(import.meta.dir, '..');
    const files = walk(root).filter(path => !path.endsWith(`${join('lib', 'storage-migration.ts')}`));
    let sawNavigation = false;
    const unknown: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (text.includes('nnNavigation')) sawNavigation = true;
      if (text.includes('nn:chat:draft')) unknown.push(`${relative(root, file)} mentions nn:chat:draft`);
      for (const match of text.matchAll(/nn:[A-Za-z0-9_:-]*/g)) {
        const token = match[0];
        if (token === 'nn:') continue;
        const event = (WINDOW_EVENT_NAMES as readonly string[]).includes(token);
        const stored = STORAGE_PREFIXES.some(prefix => token === prefix || token.startsWith(prefix) || (prefix.endsWith(':') && prefix === `${token}:`));
        if (!event && !stored) unknown.push(`${relative(root, file)}: ${token}`);
      }
    }
    expect(sawNavigation).toBe(true);
    expect(unknown).toEqual([]);
  });
});
