import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(
  resolve(import.meta.dir, '../components/screens/cards-browser.tsx'),
  'utf8',
);

describe('cards search lifecycle contract', () => {
  test('ignores stale search and pagination responses', () => {
    expect(source).toContain('const generation = ++searchGeneration.current;');
    expect(source).toContain('if (generation !== searchGeneration.current || account !== mirrorAccountGeneration()) return;');
    expect(source).toContain('const generation = ++loadMoreGeneration.current;');
    expect(source).toContain('if (generation !== loadMoreGeneration.current || account !== mirrorAccountGeneration()) return;');
  });

  test('retains previous rows while a new authoritative query resolves', () => {
    expect(source).toContain('if (serverResults !== null)');
    expect(source).not.toContain('setServerResults(null);');
    expect(source).toContain('rows.length === 0 && !serverActive');
  });

  test('keeps pagination busy state independent from query refresh', () => {
    expect(source).toContain('const [searching, setSearching] = useState(false);');
    expect(source).toContain('const [loadingMore, setLoadingMore] = useState(false);');
    expect(source).toContain('loading={loadingMore}');
  });
});
