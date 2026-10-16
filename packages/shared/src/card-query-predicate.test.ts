import { describe, expect, test } from 'bun:test';
import { parseCardQuery } from './card-query.ts';
import {
  buildCardPredicate,
  type CardLike,
  type PredicateContext,
} from './card-query-predicate.ts';

// Pinned clock so all time-relative operators are deterministic (Critic C2).
const NOW = Date.parse('2026-06-06T12:00:00Z');
const DAY = 86_400_000;

// A deck graph for resolveDeckIds injection: Spanish (s1) → Verbs (s2).
function ctx(overrides: Partial<PredicateContext> = {}): PredicateContext {
  return {
    now: NOW,
    resolveDeckIds(value: string, nested: boolean): string[] {
      // Inject a tiny deck-name→id map with one nesting relationship.
      if (value === 'Spanish') return nested ? ['s1', 's2'] : ['s1'];
      if (value === 'Spanish::Verbs') return ['s2'];
      if (value === 'Empty') return ['e1'];
      return [];
    },
    ...overrides,
  };
}

function card(overrides: Partial<CardLike> = {}): CardLike {
  return {
    renderText: 'front text back text',
    renderFrontText: 'front text',
    renderBackText: 'back text',
    fieldValues: {},
    noteTypeKind: 'basic',
    noteTypeName: 'Basic',
    templateOrd: 0,
    tags: [],
    deckId: 's1',
    state: 'review',
    suspended: false,
    due: NOW,
    createdAt: NOW - 10 * DAY,
    updatedAt: NOW - 10 * DAY,
    lapses: 0,
    reps: 0,
    stability: 0,
    difficulty: 0,
    scheduledDays: 0,
    hold: null,
    ...overrides,
  };
}

function match(q: string, c: CardLike, c2 = ctx()): boolean {
  return buildCardPredicate(parseCardQuery(q), c2)(c);
}

describe('bareword / text', () => {
  test('matches the rendered plaintext (substring, case-insensitive)', () => {
    expect(match('FRONT', card())).toBe(true);
    expect(match('back', card())).toBe(true);
    expect(match('nope', card())).toBe(false);
    // cloze: aliases bareword — both read renderText verbatim.
    expect(match('hidden', card({ renderText: 'a HIDDEN thing' }))).toBe(true);
    expect(match('cloze:hidden', card({ renderText: 'a HIDDEN thing' }))).toBe(true);
  });
});

describe('field: matchers', () => {
  test('front:/back: substring over rendered plaintext', () => {
    expect(match('front:front', card())).toBe(true);
    expect(match('back:back', card())).toBe(true);
  });

  test('empty front:/back: matches only an empty rendered column', () => {
    expect(match('back:', card({ renderBackText: '' }))).toBe(true);
    expect(match('back:', card({ renderBackText: 'x' }))).toBe(false);
  });

  test('wildcard * (multi) and _ (single)', () => {
    expect(match('front:fr*t', card({ renderFrontText: 'front' }))).toBe(true);
    expect(match('front:fr_nt', card({ renderFrontText: 'front' }))).toBe(true);
    expect(match('front:fr_nt', card({ renderFrontText: 'frnt' }))).toBe(false);
  });

  test('case-insensitivity on field matches', () => {
    expect(match('front:FRONT', card({ renderFrontText: 'front text' }))).toBe(true);
  });
});

describe('field:Name=X — note field values', () => {
  test('matches the note field value (substring, case-insensitive)', () => {
    expect(match('field:Front=Hund', card({ fieldValues: { Front: 'Der Hund' } }))).toBe(true);
    expect(match('field:Front=Katze', card({ fieldValues: { Front: 'Der Hund' } }))).toBe(false);
  });

  test('unknown field name matches nothing', () => {
    expect(match('field:Nope=x', card({ fieldValues: { Front: 'Hund' } }))).toBe(false);
  });

  test('bare field:Name → field non-empty', () => {
    expect(match('field:Extra', card({ fieldValues: { Extra: 'note' } }))).toBe(true);
    expect(match('field:Extra', card({ fieldValues: { Extra: '' } }))).toBe(false);
  });
});

describe('note: / template:', () => {
  test('note: substring over note-type name', () => {
    expect(match('note:Basic', card({ noteTypeName: 'Basic' }))).toBe(true);
    expect(match('note:Cloze', card({ noteTypeName: 'Basic' }))).toBe(false);
  });

  test('template: matches the template ordinal', () => {
    expect(match('template:0', card({ templateOrd: 0 }))).toBe(true);
    expect(match('template:1', card({ templateOrd: 0 }))).toBe(false);
  });
});

describe('deck: via injected resolveDeckIds', () => {
  test('plain deck: includes descendants (nested default true)', () => {
    expect(match('deck:Spanish', card({ deckId: 's1' }))).toBe(true);
    expect(match('deck:Spanish', card({ deckId: 's2' }))).toBe(true);
    expect(match('deck:Spanish', card({ deckId: 'other' }))).toBe(false);
  });

  test('deck:"Spanish::Verbs" resolves the subdeck only', () => {
    expect(match('deck:"Spanish::Verbs"', card({ deckId: 's2' }))).toBe(true);
    expect(match('deck:"Spanish::Verbs"', card({ deckId: 's1' }))).toBe(false);
  });
});

describe('tag:', () => {
  test('exact membership (case-insensitive)', () => {
    expect(match('tag:math', card({ tags: ['Math', 'sci'] }))).toBe(true);
    expect(match('tag:bio', card({ tags: ['Math'] }))).toBe(false);
  });

  test('tag:none matches empty tags only', () => {
    expect(match('tag:none', card({ tags: [] }))).toBe(true);
    expect(match('tag:none', card({ tags: ['x'] }))).toBe(false);
  });

  test('prefix wildcard tag:foo*', () => {
    expect(match('tag:geo*', card({ tags: ['geography'] }))).toBe(true);
    expect(match('tag:geo*', card({ tags: ['biology'] }))).toBe(false);
  });
});

describe('is:', () => {
  test('new/review/suspended', () => {
    expect(match('is:new', card({ state: 'new' }))).toBe(true);
    expect(match('is:review', card({ state: 'review' }))).toBe(true);
    expect(match('is:suspended', card({ suspended: true }))).toBe(true);
    expect(match('is:suspended', card({ suspended: false }))).toBe(false);
  });

  test('is:learn covers learning AND relearning', () => {
    expect(match('is:learn', card({ state: 'learning' }))).toBe(true);
    expect(match('is:learn', card({ state: 'relearning' }))).toBe(true);
    expect(match('is:learn', card({ state: 'review' }))).toBe(false);
  });

  test('is:due boundary — due <= now && !suspended', () => {
    expect(match('is:due', card({ due: NOW, suspended: false }))).toBe(true); // inclusive
    expect(match('is:due', card({ due: NOW - 1, suspended: false }))).toBe(true);
    expect(match('is:due', card({ due: NOW + 1, suspended: false }))).toBe(false);
    // suspended is never due
    expect(match('is:due', card({ due: NOW - DAY, suspended: true }))).toBe(false);
  });
});

describe('variant:', () => {
  test('builtin-kind alias match', () => {
    expect(match('variant:cloze', card({ noteTypeKind: 'cloze' }))).toBe(true);
    expect(match('variant:basic', card({ noteTypeKind: 'cloze' }))).toBe(false);
    // legacy `type` aliases the `typein` kind.
    expect(match('variant:type', card({ noteTypeKind: 'typein' }))).toBe(true);
  });
});

describe('added: / edited: boundaries', () => {
  test('added:N — createdAt within last N days', () => {
    expect(match('added:7', card({ createdAt: NOW - 3 * DAY }))).toBe(true);
    expect(match('added:7', card({ createdAt: NOW - 7 * DAY }))).toBe(true); // inclusive lower
    expect(match('added:7', card({ createdAt: NOW - 8 * DAY }))).toBe(false);
    expect(match('added:7', card({ createdAt: NOW }))).toBe(true);
    expect(match('added:7', card({ createdAt: NOW + DAY }))).toBe(false); // future
  });

  test('edited:N — updatedAt within last N days', () => {
    expect(match('edited:1', card({ updatedAt: NOW - DAY }))).toBe(true);
    expect(match('edited:1', card({ updatedAt: NOW - DAY - 1 }))).toBe(false);
  });

  test('non-numeric / non-positive N never matches', () => {
    expect(match('added:abc', card({ createdAt: NOW }))).toBe(false);
    expect(match('added:0', card({ createdAt: NOW }))).toBe(false);
  });
});

describe('prop: all fields × comparators', () => {
  test('reps', () => {
    expect(match('prop:reps>=5', card({ reps: 5 }))).toBe(true);
    expect(match('prop:reps>5', card({ reps: 5 }))).toBe(false);
    expect(match('prop:reps<5', card({ reps: 4 }))).toBe(true);
    expect(match('prop:reps!=5', card({ reps: 4 }))).toBe(true);
    expect(match('prop:reps=4', card({ reps: 4 }))).toBe(true);
  });

  test('lapses', () => {
    expect(match('prop:lapses>2', card({ lapses: 3 }))).toBe(true);
    expect(match('prop:lapses<=2', card({ lapses: 2 }))).toBe(true);
  });

  test('s (stability) and d (difficulty)', () => {
    expect(match('prop:s>=1.5', card({ stability: 2 }))).toBe(true);
    expect(match('prop:d<3', card({ difficulty: 2.5 }))).toBe(true);
  });

  test('ivl maps to scheduledDays', () => {
    expect(match('prop:ivl>=10', card({ scheduledDays: 10 }))).toBe(true);
    expect(match('prop:ivl>=10', card({ scheduledDays: 9 }))).toBe(false);
  });

  test('due is a relative-day offset against now', () => {
    // prop:due<=3 → due within 3 days from now
    expect(match('prop:due<=3', card({ due: NOW + 2 * DAY }))).toBe(true);
    expect(match('prop:due<=3', card({ due: NOW + 4 * DAY }))).toBe(false);
    expect(match('prop:due<=0', card({ due: NOW }))).toBe(true);
  });

  test('non-numeric operand never matches', () => {
    expect(match('prop:reps>x', card({ reps: 100 }))).toBe(false);
  });
});

describe('boolean composition', () => {
  test('implicit AND', () => {
    expect(match('is:new tag:math', card({ state: 'new', tags: ['math'] }))).toBe(true);
    expect(match('is:new tag:math', card({ state: 'new', tags: [] }))).toBe(false);
  });

  test('OR', () => {
    expect(match('is:new OR is:suspended', card({ state: 'review', suspended: true }))).toBe(true);
    expect(match('is:new OR is:suspended', card({ state: 'review', suspended: false }))).toBe(false);
  });

  test('negation', () => {
    expect(match('-is:suspended', card({ suspended: false }))).toBe(true);
    expect(match('-is:suspended', card({ suspended: true }))).toBe(false);
  });

  test('grouped precedence: a (b OR c)', () => {
    const c = card({ state: 'new', tags: ['x'] });
    expect(match('is:new (tag:x OR tag:y)', c)).toBe(true);
    expect(match('is:new (tag:p OR tag:q)', c)).toBe(false);
  });

  test('empty query matches everything', () => {
    expect(match('', card())).toBe(true);
    expect(match('   ', card())).toBe(true);
  });
});

describe('injected now keeps results stable', () => {
  test('same card flips is:due when ctx.now moves past its due date', () => {
    const c = card({ due: NOW + DAY, suspended: false });
    expect(buildCardPredicate(parseCardQuery('is:due'), ctx({ now: NOW }))(c)).toBe(false);
    expect(buildCardPredicate(parseCardQuery('is:due'), ctx({ now: NOW + 2 * DAY }))(c)).toBe(true);
  });
});
