import { describe, expect, test } from 'bun:test';
import { normalizeNoteTags } from './note-tags.ts';

const cafe = 'caf\u00e9';

describe('normalizeNoteTags', () => {
  test('splits, trims, folds unicode, and keeps case variants', () => {
    expect(normalizeNoteTags([
      '  Grammar ', 'grammar', 'Grammar', 'a, b', '', '  ', 'hello   world', cafe, 'cafe\u0301', 'hello\nworld',
    ])).toEqual({ ok: true, tags: ['Grammar', 'grammar', 'a', 'b', 'hello world', cafe] });
  });

  test('strips a NUL instead of keeping it inside the tag', () => {
    expect(normalizeNoteTags(['gram\u0000mar'])).toEqual({ ok: true, tags: ['grammar'] });
  });

  test('rejects a cleaned tag over 128 characters and a 101st distinct tag', () => {
    expect(normalizeNoteTags(['a'.repeat(129)])).toEqual({ ok: false, error: 'tag_too_long' });
    expect(normalizeNoteTags(`  ${'a'.repeat(128)}  `)).toEqual({ ok: true, tags: ['a'.repeat(128)] });
    expect(normalizeNoteTags(Array.from({ length: 101 }, (_, i) => `t${i}`))).toEqual({ ok: false, error: 'too_many_tags' });
    expect(normalizeNoteTags(Array.from({ length: 100 }, () => 'Same'))).toEqual({ ok: true, tags: ['Same'] });
  });
});
