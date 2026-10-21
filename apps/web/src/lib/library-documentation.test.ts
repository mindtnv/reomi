import { describe, expect, test } from 'bun:test';
import { documentationRuleSelected } from '@reomi/shared';
import { documentationSelection, type DocumentationPreview } from './library-documentation';

const preview: DocumentationPreview = { id: 'preview', title: 'Docs', rootUrl: 'https://example.com/docs/', locale: 'en', total: 5, available: 3, expiresAt: '', sections: [
  { prefix: '/docs/', parent: null, title: 'Docs', pageCount: 5, newPageCount: 4, reference: false },
  { prefix: '/docs/concepts/', parent: '/docs/', title: 'Concepts', pageCount: 3, newPageCount: 2, reference: false },
  { prefix: '/docs/concepts/pods/', parent: '/docs/concepts/', title: 'Pods', pageCount: 1, newPageCount: 1, reference: false },
  { prefix: '/docs/tasks/', parent: '/docs/', title: 'Tasks', pageCount: 1, newPageCount: 1, reference: false },
] };
describe('documentation selection', () => {
  test('counts overlapping branches once, retaining direct pages', () => {
    expect(documentationSelection(preview, new Set(['/docs/', '/docs/concepts/']))).toEqual({ pages: 5, added: 4 });
    expect(documentationSelection(preview, new Set(['/docs/concepts/']))).toEqual({ pages: 3, added: 2 });
  });
  test('a child exclusion retains siblings and direct parent pages', () => {
    expect(documentationSelection(preview, new Set(['/docs/', '!/docs/concepts/pods/']))).toEqual({ pages: 4, added: 3 });
    expect(documentationRuleSelected('/docs/concepts/pods/', ['/docs/', '!/docs/concepts/', '/docs/concepts/pods/'])).toBe(true);
    expect(documentationRuleSelected('/docs/tasks/', ['/docs/concepts/'])).toBe(false);
  });
});
