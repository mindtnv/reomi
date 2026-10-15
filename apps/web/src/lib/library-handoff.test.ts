// L2 — unit tests for the library→notebook handoff helpers (pure, no DOM).

import { describe, expect, test } from 'bun:test';
import {
  formatHandoffPrefill,
  planHandoff,
  prefillKey,
  type HandoffNotebook,
} from './library-handoff';

describe('planHandoff', () => {
  test('zero notebooks → create', () => {
    expect(planHandoff([])).toEqual({ kind: 'create' });
  });

  test('one notebook → single (goes straight to it)', () => {
    const nbs: HandoffNotebook[] = [{ id: 'nb1', title: 'A' }];
    expect(planHandoff(nbs)).toEqual({ kind: 'single', notebookId: 'nb1' });
  });

  test('multiple notebooks → pick (returns the list)', () => {
    const nbs: HandoffNotebook[] = [
      { id: 'nb1', title: 'A' },
      { id: 'nb2', title: 'B' },
    ];
    expect(planHandoff(nbs)).toEqual({ kind: 'pick', notebooks: nbs });
  });
});

describe('prefillKey', () => {
  test('is per-notebook namespaced', () => {
    expect(prefillKey('nb-123')).toBe('reomi:nb:prefill:nb-123');
    expect(prefillKey('a')).not.toBe(prefillKey('b'));
  });
});

describe('formatHandoffPrefill', () => {
  test('quotes the fragment as a blockquote under a titled lead', () => {
    const out = formatHandoffPrefill('Hello world', 'My Book');
    expect(out).toContain('«My Book»');
    expect(out).toContain('> Hello world');
  });

  test('trims the quote', () => {
    const out = formatHandoffPrefill('   spaced   ', 'Book');
    expect(out).toContain('> spaced');
    expect(out).not.toContain('> spaced   ');
  });

  test('degrades gracefully without a source title', () => {
    const out = formatHandoffPrefill('Quote', null);
    expect(out).not.toContain('«');
    expect(out).toContain('> Quote');
  });

  test('ends with a trailing blank line so the user can keep typing', () => {
    expect(formatHandoffPrefill('q', 'B').endsWith('\n\n')).toBe(true);
  });
});
