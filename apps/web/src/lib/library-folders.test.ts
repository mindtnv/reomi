import { afterEach, beforeEach, expect, test } from 'bun:test';
import { libraryFoldersApi } from './library-folders';

let originalFetch: typeof fetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

test('folder names that look like dates remain literal user text', async () => {
  const names = ['2026-10-19', '2026-10-19T00:00:00.000Z', 'Research'];
  globalThis.fetch = (async () => Response.json({
    items: names.map((name, index) => ({ id: `01900000-0000-7000-8000-00000000000${index}`, parentId: null,
      name, revision: 0, purpose: null, count: 0, directCount: 0, createdAt: '2026-10-19T00:00:00.000Z' })),
    totalCount: 0, unfiledCount: 0,
  })) as unknown as typeof fetch;
  expect((await libraryFoldersApi.list()).items.map(folder => folder.name)).toEqual(names);
});
