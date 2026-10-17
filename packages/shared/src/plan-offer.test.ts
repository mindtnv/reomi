import { expect, test } from 'bun:test';
import {
  applyPlanSelections,
  handUrls,
  isDiscoverySeed,
  keepLocalePages,
  namedDocVersion,
  preferDocVersions,
  readKeptPages,
  storedDocVersion,
} from './plan-offer';

test('a docs root is a discovery seed and a leaf page is not', () => {
  expect(isDiscoverySeed('/')).toBe(true);
  expect(isDiscoverySeed('/docs/')).toBe(true);
  expect(isDiscoverySeed('https://kubernetes.io/docs/')).toBe(true);
  expect(isDiscoverySeed('https://kubernetes.io/docs/concepts/workloads/pods/')).toBe(false);
});

test('version path labels are seeds, and v1-34.docs.example records v1.34', () => {
  expect(isDiscoverySeed('https://docs.example/docs/stable/')).toBe(true);
  expect(isDiscoverySeed('https://docs.example/docs/latest/')).toBe(true);
  expect(isDiscoverySeed('https://docs.example/docs/current/')).toBe(true);
  expect(isDiscoverySeed('https://docs.example/docs/next/')).toBe(true);
  expect(isDiscoverySeed('https://docs.example/v1/')).toBe(true);
  expect(isDiscoverySeed('https://docs.example/2.x/')).toBe(true);
  expect(isDiscoverySeed('https://docs.example/3.1/documentation/')).toBe(true);
  expect(isDiscoverySeed('https://docs.example/docs/v1-34/')).toBe(true);
  expect(isDiscoverySeed('https://docs.example/docs/concepts/overview')).toBe(false);

  const versions = [
    'https://docs.example/docs/next/workloads/',
    'https://docs.example/docs/v1.33/workloads/',
    'https://docs.example/docs/v1.34/workloads/',
    'https://docs.example/docs/current/workloads/',
    'https://docs.example/docs/latest/workloads/',
    'https://docs.example/docs/stable/workloads/',
  ];
  expect(preferDocVersions(versions, null)).toEqual(['https://docs.example/docs/stable/workloads/']);
  expect(preferDocVersions(versions.filter((url) => !url.includes('/stable/')), null)).toEqual([
    'https://docs.example/docs/latest/workloads/',
  ]);
  expect(
    preferDocVersions(
      versions.filter((url) => url.includes('/current/') || url.includes('/v1.') || url.includes('/next/')),
      null,
    ),
  ).toEqual(['https://docs.example/docs/current/workloads/']);
  expect(
    preferDocVersions(
      versions.filter((url) => url.includes('/v1.') || url.includes('/next/')),
      null,
    ),
  ).toEqual(['https://docs.example/docs/v1.34/workloads/']);
  expect(preferDocVersions(['https://docs.example/docs/next/workloads/'], null)).toEqual([
    'https://docs.example/docs/next/workloads/',
  ]);
  expect(preferDocVersions(versions, namedDocVersion('Study the v1.33 release'))).toEqual([
    'https://docs.example/docs/v1.33/workloads/',
  ]);
  expect(namedDocVersion('Run pods and deployments')).toBeNull();

  expect(storedDocVersion('v1-34.docs.example')).toBe('v1.34');
  expect(storedDocVersion('v1-34.docs.kubernetes.io')).toBe('v1.34');
  expect(storedDocVersion('docs.example')).toBeNull();
  expect(storedDocVersion('kubernetes.io')).toBeNull();
});

test('english drops translated prefixes and russian keeps ru when those pages exist', () => {
  const urls = [
    'https://kubernetes.io/docs/concepts/workloads/',
    'https://kubernetes.io/zh-cn/docs/concepts/workloads/',
    'https://kubernetes.io/ru/docs/concepts/workloads/',
  ];
  expect(keepLocalePages(urls, 'en')).toEqual(['https://kubernetes.io/docs/concepts/workloads/']);
  expect(keepLocalePages(urls, 'ru')).toEqual(['https://kubernetes.io/ru/docs/concepts/workloads/']);
  expect(
    keepLocalePages(
      [
        'https://kubernetes.io/docs/concepts/workloads/',
        'https://kubernetes.io/zh-cn/docs/concepts/workloads/',
      ],
      'ru',
    ),
  ).toEqual(['https://kubernetes.io/docs/concepts/workloads/']);
});

test('a dropped section and a dropped page stay out, and a reference include adds nothing', () => {
  const offer = {
    modules: [{
      sections: [
        {
          prefix: '/docs/alpha/',
          kind: 'content' as const,
          selected: true,
          pages: [
            { url: 'https://docs.example/docs/alpha/one/', title: 'one', estimatedTokens: 100 },
            { url: 'https://docs.example/docs/alpha/two/', title: 'two', estimatedTokens: 100 },
          ],
        },
        {
          prefix: '/docs/tasks/',
          kind: 'content' as const,
          selected: true,
          pages: [{ url: 'https://docs.example/docs/tasks/run/', title: 'run', estimatedTokens: 100 }],
        },
        {
          prefix: '/docs/reference/kubernetes-api/',
          kind: 'reference' as const,
          selected: false,
          pages: [{ url: 'https://docs.example/docs/reference/kubernetes-api/pod/', title: 'Pod', estimatedTokens: 100 }],
        },
      ],
      ignoredUrls: ['https://docs.example/docs/'],
      docVersion: null,
      catalog: { v: 1 as const, remainingTokens: 1000, entries: [], pending: [] },
      needsPages: false,
    }],
  };
  const kept = applyPlanSelections(
    {
      goal: 'Learn',
      modules: [{
        title: 'Alpha',
        outcome: 'Read alpha',
        urls: ['https://docs.example/docs/', 'https://leaf.example/notes'],
        pages: [{ url: 'https://evil.example/injected/', title: 'Injected', estimatedTokens: 1 }],
      }],
    },
    offer,
    [
      { moduleIndex: 0, prefix: '/docs/tasks/', include: false },
      {
        moduleIndex: 0,
        prefix: '/docs/alpha/',
        include: true,
        pages: [{ url: 'https://docs.example/docs/alpha/two/', include: false }],
      },
      { moduleIndex: 0, prefix: '/docs/reference/kubernetes-api/', include: true },
    ],
  );
  expect(kept?.modules[0]?.pages.map((page) => page.url)).toEqual(['https://docs.example/docs/alpha/one/']);
  expect(handUrls(kept?.modules[0])).toEqual(['https://leaf.example/notes']);
  const reread = readKeptPages({
    ...kept,
    modules: [{
      ...kept!.modules[0],
      pages: [...(kept?.modules[0]?.pages ?? []), { url: 'not a url', title: 'x', estimatedTokens: 1 }],
    }],
  });
  expect(reread?.modules[0]?.pages.map((page) => page.url)).toEqual(['https://docs.example/docs/alpha/one/']);
});

test('a missing offer keeps a hand-entered page and drops a docs root', () => {
  const kept = applyPlanSelections({
    goal: 'Learn',
    level: 'beginner',
    modules: [{
      title: 'Notes',
      outcome: 'Read the notes',
      urls: ['https://leaf.example/a', 'https://docs.example/docs/'],
    }],
  }, undefined, undefined);
  expect(kept?.modules[0]?.pages).toEqual([]);
  expect(kept?.modules[0]?.ignoredUrls).toEqual([]);
  expect(kept?.level).toBe('beginner');
  expect(handUrls(kept?.modules[0])).toEqual(['https://leaf.example/a']);
});
