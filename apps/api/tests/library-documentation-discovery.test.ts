import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { __setDnsLookupForTests, __setPageFetchForTests, DirectPageReader } from '../src/ai/page-reader';
import { discoverDocumentation, documentationSections, normalizeDocumentationRoot, selectedDocumentationPages } from '../src/ai/library-documentation-discovery';

beforeEach(() => {
  __setDnsLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
});
afterEach(() => { __setDnsLookupForTests(null); __setPageFetchForTests(null); });

describe('library documentation discovery', () => {
  test('landing normalization is explicit, strips fragments and rejects credentials', () => {
    expect(normalizeDocumentationRoot('https://kubernetes.io/docs/home/?utm_source=x#about')).toBe('https://kubernetes.io/docs/');
    expect(normalizeDocumentationRoot('https://example.com/docs/index.html')).toBe('https://example.com/docs/');
    expect(() => normalizeDocumentationRoot('https://user:password@example.com/docs')).toThrow();
    expect(() => normalizeDocumentationRoot('http://localhost/docs')).toThrow();
  });
  test('uses the index, keeps one scope and locale, and never fetches candidate bodies', async () => {
    const fetched: string[] = [];
    __setPageFetchForTests(async input => {
      const url = String(input); fetched.push(url);
      if (url.endsWith('/sitemap.xml')) return new Response(`<urlset>${[
        'https://kubernetes.io/docs/concepts/workloads/pods/',
        'https://kubernetes.io/docs/tasks/run-application/deployment/',
        'https://kubernetes.io/docs/reference/kubectl/',
        'https://kubernetes.io/ru/docs/concepts/workloads/pods/',
        'https://v1-34.docs.kubernetes.io/docs/concepts/workloads/pods/',
        'https://kubernetes.io/blog/post/',
      ].map(url => `<url><loc>${url}</loc></url>`).join('')}</urlset>`, { headers: { 'content-type': 'application/xml' } });
      return new Response('', { status: 404 });
    });
    const manifest = await discoverDocumentation('https://kubernetes.io/docs/home/', 'en');
    expect(manifest.pages).toHaveLength(3);
    expect(fetched.every(url => /\/(llms(?:-full)?\.txt|sitemap\.xml)$/.test(url))).toBe(true);
    const sections = documentationSections(manifest);
    expect(sections.find(s => s.prefix === '/docs/concepts/')?.pageCount).toBe(1);
    expect(sections.find(s => s.prefix === '/docs/reference/')?.reference).toBe(true);
    expect(selectedDocumentationPages(manifest, ['/docs/concepts/']).map(p => p.title)).toEqual(['pods']);
    expect(() => selectedDocumentationPages(manifest, ['/blog/'])).toThrow();
  });
  test('a scoped reader rejects an off-origin redirect before fetching its target', async () => {
    const fetched: string[] = [];
    __setPageFetchForTests(async input => { fetched.push(String(input)); return new Response('', { status: 302, headers: { location: 'https://elsewhere.example/docs/page/' } }); });
    await expect(new DirectPageReader().read('https://example.com/docs/page/', { scope: { origin: 'https://example.com', pathPrefix: '/docs/' } })).rejects.toThrow();
    expect(fetched).toEqual(['https://example.com/docs/page/']);
  });
  test('a page redirect cannot silently switch documentation versions', async () => {
    const fetched: string[] = [];
    __setPageFetchForTests(async input => { fetched.push(String(input)); return new Response('', { status: 302, headers: { location: '/docs/v1/page/' } }); });
    await expect(new DirectPageReader().read('https://example.com/docs/v2/page', { scope: {
      origin: 'https://example.com', pathPrefix: '/docs/', canonicalPath: '/docs/v2/page',
    } })).rejects.toThrow('outside documentation scope');
    expect(fetched).toEqual(['https://example.com/docs/v2/page']);
  });
});
