// chunkSource('document') — the NotebookLM M1 document chunker (T5 / AC1.5).
//
// Pure-TS unit tests (no DB, no AI). Verifies the token-windowed multi-chunk
// document path: multiple units → multiple chunks with overlap, preserved
// page/heading, monotonic positions; an oversized single unit splits; and
// `estimateTokens` sanity. The 'card' branch is exercised in kb-chunk.test.ts
// (kept unchanged here, only re-asserted that document does NOT regress it).

import { describe, expect, test } from 'bun:test';
import { chunkSource, estimateTokens, type SourceInput, type SourceUnit } from './kb-chunk.ts';

const SRC_ID = 'aaaaaaaa-0000-0000-0000-00000000d0c1';
const PARENT_ID = 'bbbbbbbb-0000-0000-0000-00000000n0b1'; // notebook id

function docInput(units: SourceUnit[], chunkOptions?: SourceInput['chunkOptions']): SourceInput {
  return {
    sourceType: 'document',
    sourceId: SRC_ID,
    parentId: PARENT_ID,
    text: '', // ignored on the document path
    units,
    chunkOptions,
  };
}

/**
 * Build a unit whose `estimateTokens` ≈ `tokens` (the chunker uses chars/4, so
 * len ≈ tokens*4). Space-separated short words give the oversized-split path
 * whitespace boundaries to cut on. We size on CHARS so the estimate matches the
 * request exactly (the chunker's packing reads the same heuristic).
 */
function unitOfTokens(tokens: number, opts: Partial<SourceUnit> = {}): SourceUnit {
  const targetChars = tokens * 4;
  // "word " repeated; each contributes 5 chars. Trim trailing space.
  const reps = Math.max(1, Math.round(targetChars / 5));
  const text = 'word '.repeat(reps).trim();
  return { text, ...opts };
}

describe('estimateTokens', () => {
  test('empty / whitespace → 0', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('   \n\t ')).toBe(0);
  });

  test('non-empty → at least 1, ~chars/4', () => {
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2); // 5 chars → ceil(5/4) = 2
    expect(estimateTokens('x'.repeat(400))).toBe(100);
  });
});

describe("chunkSource('document') — multi-unit windowing", () => {
  test('multiple small units pack into ONE chunk (under the token target)', () => {
    const chunks = chunkSource(
      docInput(
        [
          { text: 'Alpha beta gamma.', page: 1 },
          { text: 'Delta epsilon zeta.', page: 1 },
          { text: 'Eta theta iota.', page: 2 },
        ],
        { tokensPerChunk: 800, overlap: 0.12 },
      ),
    );
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.position).toBe(0);
    expect(chunks[0]!.sourceType).toBe('document');
    expect(chunks[0]!.sourceId).toBe(SRC_ID);
    expect(chunks[0]!.parentId).toBe(PARENT_ID);
    // The combined text contains every unit's text.
    expect(chunks[0]!.text).toContain('Alpha beta gamma.');
    expect(chunks[0]!.text).toContain('Eta theta iota.');
    // page preserved from the FIRST contributing unit.
    expect(chunks[0]!.page).toBe(1);
  });

  test('units exceeding the target produce MULTIPLE chunks with monotonic positions', () => {
    // Three ~300-token units, target 400 → packs into >1 chunk.
    const units = [
      unitOfTokens(300, { page: 1 }),
      unitOfTokens(300, { page: 2 }),
      unitOfTokens(300, { page: 3 }),
    ];
    const chunks = chunkSource(docInput(units, { tokensPerChunk: 400, overlap: 0.12 }));
    expect(chunks.length).toBeGreaterThan(1);
    // Positions are 0..n-1 strictly monotonic.
    for (let i = 0; i < chunks.length; i++) expect(chunks[i]!.position).toBe(i);
    // Every chunk is a document chunk carrying source/parent ids + a token count.
    for (const c of chunks) {
      expect(c.sourceType).toBe('document');
      expect(c.sourceId).toBe(SRC_ID);
      expect(c.parentId).toBe(PARENT_ID);
      expect(c.tokenCount).toBeGreaterThan(0);
    }
  });

  test('overlap re-includes a tail of the previous chunk in the next', () => {
    // A distinctive marker at the END of the first unit should reappear at the
    // START of the second chunk when overlap > 0. Each unit stays UNDER the
    // target so it is a single segment: unit-1 fills chunk 0 (crosses the
    // target), unit-2 opens chunk 1 — chunk 0's tail (incl. the marker) is
    // re-seeded into chunk 1 by the overlap.
    const marker = 'ZEBRAQUOKKA';
    const first = `${unitOfTokens(380).text} ${marker}`; // ~381 tok ≥ 380 → flush
    const second = unitOfTokens(380).text;
    const withOverlap = chunkSource(
      docInput([{ text: first }, { text: second }], { tokensPerChunk: 380, overlap: 0.4 }),
    );
    expect(withOverlap.length).toBeGreaterThanOrEqual(2);
    // The marker sits at the tail of chunk 0; a 0.4 overlap carries a slice of
    // chunk 0's text into chunk 1.
    expect(withOverlap[0]!.text).toContain(marker);
    expect(withOverlap[1]!.text).toContain(marker);

    // With ZERO overlap the marker is NOT duplicated into the next chunk.
    const noOverlap = chunkSource(
      docInput([{ text: first }, { text: second }], { tokensPerChunk: 380, overlap: 0 }),
    );
    expect(noOverlap.length).toBeGreaterThanOrEqual(2);
    expect(noOverlap[0]!.text).toContain(marker);
    expect(noOverlap[1]!.text).not.toContain(marker);
  });

  test('page AND heading metadata are preserved onto chunks', () => {
    // Each unit is ~400 tokens and the target is 380: a single un-split seg that
    // ALONE crosses the target, so unit-1 → chunk 0, unit-2 → chunk 1. (Overlap
    // 0 so chunk 1 opens cleanly with unit-2's metadata, not unit-1's tail.)
    const units = [
      unitOfTokens(400, { page: 7, heading: 'Chapter Seven' }),
      unitOfTokens(400, { page: 8, heading: 'Chapter Eight' }),
    ];
    const chunks = chunkSource(docInput(units, { tokensPerChunk: 380, overlap: 0 }));
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // First chunk inherits the first unit's page+heading.
    expect(chunks[0]!.page).toBe(7);
    expect(chunks[0]!.heading).toBe('Chapter Seven');
    // A later chunk that starts from the second unit carries its metadata.
    const eight = chunks.find((c) => c.heading === 'Chapter Eight');
    expect(eight).toBeTruthy();
    expect(eight!.page).toBe(8);
  });

  test('a SINGLE oversized unit is split into multiple target-sized chunks', () => {
    // One unit at ~5x the target — must split, not emit one giant chunk.
    const big = unitOfTokens(2000, { page: 3, heading: 'Big Section' });
    const chunks = chunkSource(docInput([big], { tokensPerChunk: 400, overlap: 0 }));
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length; i++) expect(chunks[i]!.position).toBe(i);
    // No single chunk wildly exceeds the target (allow window slack — the
    // chunker closes once a buffer crosses the target, never far past it).
    for (const c of chunks) {
      expect(estimateTokens(c.text)).toBeLessThanOrEqual(400 * 2);
      // page/heading of the source unit ride every split piece.
      expect(c.page).toBe(3);
      expect(c.heading).toBe('Big Section');
    }
  });

  test('empty / whitespace-only units are dropped', () => {
    const chunks = chunkSource(
      docInput([{ text: '   ' }, { text: 'Real content here.' }, { text: '\n\n' }]),
    );
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toContain('Real content here.');
  });

  test('no units → no chunks (empty array, never throws)', () => {
    expect(chunkSource(docInput([]))).toEqual([]);
  });

  test('a YouTube chunk keeps the first cue start and the next chunk does not inherit it', () => {
    const chunks = chunkSource(docInput(
      [
        { text: '0:12 hello', startSeconds: 12 },
        { text: '1:05 world', startSeconds: 65 },
      ],
      { tokensPerChunk: 3, overlap: 0 },
    ));
    expect(chunks[0]!.startSeconds).toBe(12);
    expect(chunks[1]!.startSeconds).toBe(65);
  });

  test('overlap is clamped to [0, 0.5] (does not explode chunk count)', () => {
    const units = [unitOfTokens(450), unitOfTokens(450)];
    // overlap 5 is nonsense — clamp to 0.5 → finite chunk count, still terminates.
    const chunks = chunkSource(docInput(units, { tokensPerChunk: 400, overlap: 5 }));
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks.length).toBeLessThan(20);
  });
});

describe("chunkSource('card') branch is UNCHANGED by the document branch", () => {
  test('card → exactly 1 chunk at position 0, text verbatim', () => {
    const chunks = chunkSource({
      sourceType: 'card',
      sourceId: 'cccccccc-0000-0000-0000-00000000ca11',
      parentId: 'cccccccc-0000-0000-0000-00000000ca11',
      text: 'The mitochondria is the powerhouse of the cell.',
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.position).toBe(0);
    expect(chunks[0]!.sourceType).toBe('card');
    expect(chunks[0]!.text).toBe('The mitochondria is the powerhouse of the cell.');
    // The card path never sets page/heading/tokenCount.
    expect(chunks[0]!.page).toBeUndefined();
    expect(chunks[0]!.heading).toBeUndefined();
  });
});
