import { expect, test } from 'bun:test';
import { isDiscoverySeed, keepLocalePages, namedDocVersion, preferDocVersions, storedDocVersion } from './plan-offer';

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
