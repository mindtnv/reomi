// Unit tests for the pure numbered-citation helpers (Notebooks redesign A2).

import { describe, expect, test } from 'bun:test';
import type { Citation, SourceCitation } from '@reomi/shared';
import {
  buildCitationNumbering,
  CITATION_COVER_TONES,
  citationCoverLetter,
  citationCoverTone,
  citationLocation,
  hasNumberedCitations,
} from './chat-citations';

const t = (key: string, params?: Record<string, string | number>): string =>
  params ? `${key}|${JSON.stringify(params)}` : key;

function src(chunkId: string, over: Partial<SourceCitation> = {}): SourceCitation {
  return {
    kind: 'source',
    sourceId: `source-${chunkId}`,
    sourceChunkId: chunkId,
    ...over,
  };
}

const card: Citation = { cardId: 'c1', chunkId: 'k1' };

describe('buildCitationNumbering', () => {
  test('numbers by first appearance in prose', () => {
    const content = 'Alpha [src:bbb] beta [src:aaa] gamma [src:bbb].';
    const { numberOf, ordered } = buildCitationNumbering(content, [src('aaa'), src('bbb')]);
    // bbb appears first → 1, aaa second → 2; repeat bbb keeps 1.
    expect(numberOf.get('bbb')).toBe(1);
    expect(numberOf.get('aaa')).toBe(2);
    expect(ordered.map((o) => o.n)).toEqual([1, 2]);
    expect(ordered.map((o) => o.citation.sourceChunkId)).toEqual(['bbb', 'aaa']);
  });

  test('ignores tokens with no matching citation', () => {
    const content = 'X [src:ghost] Y [src:real]';
    const { numberOf, ordered } = buildCitationNumbering(content, [src('real')]);
    expect(numberOf.has('ghost')).toBe(false);
    expect(numberOf.get('real')).toBe(1);
    expect(ordered).toHaveLength(1);
  });

  test('appends citations not referenced inline, after inline ones', () => {
    const content = 'Only [src:inline] here.';
    const { numberOf, ordered } = buildCitationNumbering(content, [src('inline'), src('orphan')]);
    expect(numberOf.get('inline')).toBe(1);
    expect(numberOf.get('orphan')).toBe(2);
    expect(ordered).toHaveLength(2);
  });

  test('ignores card citations entirely', () => {
    const content = 'No source tokens, just [card:c1] prose.';
    const { ordered } = buildCitationNumbering(content, [card]);
    expect(ordered).toHaveLength(0);
    expect(hasNumberedCitations(buildCitationNumbering(content, [card]))).toBe(false);
  });

  test('de-dups repeated citation objects for the same chunk', () => {
    const content = '[src:dup] and [src:dup]';
    const { ordered } = buildCitationNumbering(content, [src('dup'), src('dup')]);
    expect(ordered).toHaveLength(1);
    expect(ordered[0].n).toBe(1);
  });

  test('empty inputs yield empty numbering', () => {
    expect(hasNumberedCitations(buildCitationNumbering('', []))).toBe(false);
    expect(buildCitationNumbering('text', []).ordered).toHaveLength(0);
  });
});

describe('citationCoverTone', () => {
  test('is deterministic and within the palette', () => {
    const a = citationCoverTone('source-abc');
    const b = citationCoverTone('source-abc');
    expect(a).toBe(b);
    expect(CITATION_COVER_TONES).toContain(a);
  });

  test('different ids spread across tones (not all identical)', () => {
    const tones = new Set(
      Array.from({ length: 20 }, (_, i) => citationCoverTone(`source-${i}`)),
    );
    expect(tones.size).toBeGreaterThan(1);
  });
});

describe('citationCoverLetter', () => {
  test('uppercases the first letter', () => {
    expect(citationCoverLetter('здоровый сон')).toBe('З');
    expect(citationCoverLetter('atlas')).toBe('A');
  });

  test('falls back to ? for empty/undefined', () => {
    expect(citationCoverLetter('')).toBe('?');
    expect(citationCoverLetter('   ')).toBe('?');
    expect(citationCoverLetter(undefined)).toBe('?');
  });
});

describe('citationLocation', () => {
  test('renders page when present', () => {
    expect(citationLocation(src('x', { page: 41 }), t)).toBe('chat.source.page|{"n":41}');
  });

  test('null when no page', () => {
    expect(citationLocation(src('x'), t)).toBeNull();
  });
});
