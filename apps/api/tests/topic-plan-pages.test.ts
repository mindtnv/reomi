import { afterEach, expect, test } from 'bun:test';
import { discoverPlanPages, planSummary, toPlanOffer, __resetDocsIndexCacheForTests } from '../src/ai/docs-index.ts';
import { __setDnsLookupForTests, __setPageFetchForTests } from '../src/ai/page-reader.ts';

const PUBLIC_IP = [{ address: '93.184.216.34', family: 4 }];
const SEED = 'https://docs.example/docs/';
const POD = 'https://docs.example/docs/concepts/workloads/pods/';
const DEPLOYMENTS = 'https://docs.example/docs/concepts/workloads/deployments/';
const LATE = 'https://docs.example/docs/concepts/workloads/late/';
const LLMS_ONLY = 'https://docs.example/docs/concepts/workloads/llms-only/';
const POD_DESCRIPTION = 'A pod is a group of containers.';

function pathname(url: string): string {
  return new URL(url).pathname;
}

function install(routes: Record<string, Response>): string[] {
  return installHandler((url) => routes[pathname(url)] ?? new Response('missing', { status: 404 }));
}

function installHandler(handler: (url: string) => Response): string[] {
  const calls: string[] = [];
  __setDnsLookupForTests(async () => PUBLIC_IP);
  __setPageFetchForTests(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return handler(url);
  });
  return calls;
}

function text(body: string, contentType: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

afterEach(() => {
  __setPageFetchForTests(null);
  __setDnsLookupForTests(null);
  __resetDocsIndexCacheForTests();
});

test('llms titles survive a 256 KiB cutoff and the sitemap still fills the tree', async () => {
  const early = [
    `- [Pod](${POD}): ${POD_DESCRIPTION}`,
    `- [Llms Only](${LLMS_ONLY}): This page is not in the sitemap.`,
    '',
  ].join('\n');
  const late = `- [Late Page](${LATE}): This link starts after the llms cutoff.\n`;
  const llms = early + 'x'.repeat(256 * 1024 - early.length + 8) + late;
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${POD}</loc></url>
  <url><loc>${DEPLOYMENTS}</loc></url>
  <url><loc>${LATE}</loc></url>
</urlset>`;
  const calls = install({
    '/llms.txt': text(llms, 'text/plain; charset=utf-8'),
    '/llms-full.txt': new Response('no', { status: 404 }),
    '/sitemap.xml': text(sitemap, 'application/xml'),
    [pathname(SEED)]: text('<a href="/docs/concepts/workloads/from-html/">HTML</a>', 'text/html'),
  });

  const input = {
    goal: 'Learn workloads',
    level: null,
    locale: 'en' as const,
    modules: [
      {
        title: 'Workloads',
        outcome: 'Run pods and deployments',
        prerequisiteIndexes: [],
        urls: [SEED],
      },
    ],
  };
  const discovered = await discoverPlanPages(input);
  const before = calls.length;
  await discoverPlanPages(input);
  expect(calls.length).toBe(before);
  expect(calls.map(pathname)).toEqual(['/llms.txt', '/llms-full.txt', '/sitemap.xml']);

  const summary = planSummary(discovered);
  expect(summary.modules[0]?.urls).toEqual([SEED]);
  expect(JSON.stringify(summary)).not.toContain(DEPLOYMENTS);
  expect(summary.modules[0]?.needsPages).toBe(false);

  const pages = toPlanOffer(discovered).modules[0]?.sections.flatMap((section) => section.pages) ?? [];
  const pod = pages.find((page) => page.url === POD);
  const deployments = pages.find((page) => page.url === DEPLOYMENTS);
  const latePage = pages.find((page) => page.url === LATE);
  expect(pod?.title).toBe('Pod');
  expect(pod?.estimatedTokens).toBe(100);
  expect(deployments?.estimatedTokens).toBe(1200);
  expect(latePage?.title).not.toBe('Late Page');
  expect(latePage?.estimatedTokens).toBe(1200);
  expect(pages.some((page) => page.url === LLMS_ONLY)).toBe(false);
  expect(pages.some((page) => page.url.includes('/from-html/'))).toBe(false);
  expect(toPlanOffer(discovered).modules[0]?.ignoredUrls).toContain(SEED);
});

test('a missing sitemap uses llms links and does not fetch them', async () => {
  const origin = 'https://llms.example';
  const seed = `${origin}/docs/`;
  const pods = `${origin}/docs/concepts/pods/`;
  const services = `${origin}/docs/concepts/services/`;
  const late = `${origin}/docs/concepts/late/`;
  const offHost = 'https://other.example/docs/concepts/pods/';
  const early = [`- [Pods](${pods}): Run a pod.`, `- [Services](${services})`, `- [Off](${offHost})`, ''].join('\n');
  const body = early + 'x'.repeat(256 * 1024 - early.length + 8) + `- [Late](${late})\n`;
  const calls = install({
    '/llms.txt': text(body, 'text/plain'),
    '/llms-full.txt': new Response('no', { status: 404 }),
    '/sitemap.xml': new Response('no', { status: 404 }),
    '/docs/': text(`<a href="${pods}">again</a>`, 'text/html'),
  });

  const discovered = await discoverPlanPages({
    goal: 'Concepts',
    level: null,
    locale: 'en',
    modules: [{ title: 'Concepts', outcome: 'Read the concept pages', prerequisiteIndexes: [], urls: [seed] }],
  });
  expect(calls.map(pathname)).toEqual(['/llms.txt', '/llms-full.txt', '/sitemap.xml']);
  const pages = toPlanOffer(discovered).modules[0]?.sections.flatMap((section) => section.pages) ?? [];
  expect(pages.map((page) => page.url).sort()).toEqual([pods, services].sort());
  expect(pages.find((page) => page.url === pods)?.title).toBe('Pods');
  expect(pages.some((page) => page.url === late || page.url === offHost)).toBe(false);
});

test('llms and sitemap misses use one seed page and do not follow its links', async () => {
  const origin = 'https://html.example';
  const seed = `${origin}/docs/`;
  const pods = `${origin}/docs/concepts/pods/`;
  const services = `${origin}/docs/concepts/services/`;
  const calls = install({
    '/llms.txt': new Response('no', { status: 404 }),
    '/llms-full.txt': new Response('no', { status: 404 }),
    '/sitemap.xml': new Response('no', { status: 404 }),
    '/docs/': text(
      `<a href="/docs/concepts/pods/">Pods</a><a href="/docs/concepts/services/">Services</a><a href="https://other.example/docs/x">Off</a>`,
      'text/html',
    ),
    '/docs/concepts/pods/': text('should not be fetched', 'text/html'),
    '/docs/concepts/services/': text('should not be fetched', 'text/html'),
  });

  const discovered = await discoverPlanPages({
    goal: 'Concepts',
    level: null,
    locale: 'en',
    modules: [{ title: 'Concepts', outcome: 'Read the concept pages', prerequisiteIndexes: [], urls: [seed] }],
  });
  expect(calls.map(pathname)).toEqual(['/llms.txt', '/llms-full.txt', '/sitemap.xml', '/docs/']);
  const pages = toPlanOffer(discovered).modules[0]?.sections.flatMap((section) => section.pages) ?? [];
  expect(pages.map((page) => page.url).sort()).toEqual([pods, services].sort());
});

test('off-host locs, versioned hosts, private redirects, and extra sitemap children are dropped', async () => {
  const origin = 'https://index.example';
  const seed = `${origin}/docs/`;
  const kept = (n: number) => `${origin}/docs/kept/part-${n}/`;
  const leaked = `${origin}/docs/leaked/private/`;
  const translated = `${origin}/docs/leaked/zh/`;
  const offHost = 'https://other.example/docs/off/';
  const versioned = 'https://v1-33.docs.index.example/docs/concepts/pods/';
  const children = [
    `${origin}/sitemaps/sitemap-zh-cn.xml`,
    'https://cdn.example/sitemap.xml',
    'https://v1-33.docs.index.example/sitemap.xml',
  ];
  for (let n = 1; n <= 17; n += 1) children.push(`${origin}/sitemaps/chunk-${n}.xml`);
  const index = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${children.map((loc) => `  <sitemap><loc>${loc}</loc></sitemap>`).join('\n')}
</sitemapindex>`;
  const calls = installHandler((url) => {
    const path = pathname(url);
    if (path === '/llms.txt' || path === '/llms-full.txt') return new Response('no', { status: 404 });
    if (path === '/sitemap.xml') return text(index, 'application/xml');
    if (path === '/sitemaps/chunk-2.xml') {
      return new Response('redirect', { status: 302, headers: { location: 'http://127.0.0.1/secret.xml' } });
    }
    const chunk = /^\/sitemaps\/chunk-(\d+)\.xml$/.exec(path);
    if (chunk) {
      const n = chunk[1];
      const extra =
        n === '1'
          ? `<url><loc>${offHost}</loc></url><url><loc>${versioned}</loc></url>`
          : '';
      return text(
        `<urlset><url><loc>${kept(Number(n))}</loc></url>${extra}</urlset>`,
        'application/xml',
      );
    }
    if (path === '/sitemaps/sitemap-zh-cn.xml') {
      return text(`<urlset><url><loc>${translated}</loc></url></urlset>`, 'application/xml');
    }
    if (url.includes('127.0.0.1')) {
      return text(`<urlset><url><loc>${leaked}</loc></url></urlset>`, 'application/xml');
    }
    return new Response('missing', { status: 404 });
  });

  const discovered = await discoverPlanPages({
    goal: 'Kept pages',
    level: null,
    locale: 'en',
    modules: [{ title: 'Kept', outcome: 'Read the kept pages', prerequisiteIndexes: [], urls: [seed] }],
  });
  const paths = calls.map(pathname);
  expect(paths).toContain('/sitemaps/chunk-1.xml');
  expect(paths).toContain('/sitemaps/chunk-16.xml');
  expect(paths).not.toContain('/sitemaps/chunk-17.xml');
  expect(paths).not.toContain('/sitemaps/sitemap-zh-cn.xml');
  expect(calls.some((url) => url.includes('127.0.0.1'))).toBe(false);
  expect(calls.some((url) => url.includes('v1-33.docs.'))).toBe(false);
  expect(calls.some((url) => url.includes('cdn.example'))).toBe(false);
  expect(calls.some((url) => url.includes('other.example'))).toBe(false);

  const pages = toPlanOffer(discovered).modules[0]?.sections.flatMap((section) => section.pages) ?? [];
  const urls = new Set(pages.map((page) => page.url));
  expect(urls.has(kept(1))).toBe(true);
  expect(urls.has(kept(16))).toBe(true);
  expect(urls.has(kept(17))).toBe(false);
  expect(urls.has(kept(2))).toBe(false);
  expect(urls.has(leaked)).toBe(false);
  expect(urls.has(translated)).toBe(false);
  expect(urls.has(offHost)).toBe(false);
  expect(urls.has(versioned)).toBe(false);
});

test('a sitemap stops at 8 MiB and at 20000 loc entries', async () => {
  const origin = 'https://cap.example';
  const seed = `${origin}/docs/`;
  const early = `${origin}/docs/early/`;
  const late = `${origin}/docs/late/`;
  const huge = `<urlset><url><loc>${early}</loc></url>${' '.repeat(8 * 1024 * 1024)}<url><loc>${late}</loc></url></urlset>`;
  const manyOrigin = 'https://many.example';
  const locs: string[] = [];
  for (let n = 1; n <= 20_001; n += 1) locs.push(`<url><loc>${manyOrigin}/docs/page-${n}/</loc></url>`);
  const many = `<urlset>${locs.join('')}</urlset>`;
  const calls = install({
    '/llms.txt': new Response('no', { status: 404 }),
    '/llms-full.txt': new Response('no', { status: 404 }),
    '/sitemap.xml': text(huge, 'application/xml'),
  });
  const hugeDiscovery = await discoverPlanPages({
    goal: 'Cap',
    level: null,
    locale: 'en',
    modules: [{ title: 'Cap', outcome: 'Stay inside the sitemap cap', prerequisiteIndexes: [], urls: [seed] }],
  });
  const hugePages = toPlanOffer(hugeDiscovery).modules[0]?.sections.flatMap((section) => section.pages) ?? [];
  expect(hugePages.some((page) => page.url === early)).toBe(true);
  expect(hugePages.some((page) => page.url === late)).toBe(false);
  expect(calls.map(pathname)).toEqual(['/llms.txt', '/llms-full.txt', '/sitemap.xml']);

  __resetDocsIndexCacheForTests();
  install({
    '/llms.txt': new Response('no', { status: 404 }),
    '/llms-full.txt': new Response('no', { status: 404 }),
    '/sitemap.xml': text(many, 'application/xml'),
  });
  const manyDiscovery = await discoverPlanPages({
    goal: 'Cap',
    level: null,
    locale: 'en',
    modules: [
      {
        title: 'Cap',
        outcome: 'Stay inside the sitemap cap',
        prerequisiteIndexes: [],
        urls: ['https://many.example/docs/'],
      },
    ],
  });
  const manyPages = toPlanOffer(manyDiscovery).modules[0]?.sections.flatMap((section) => section.pages) ?? [];
  const manyUrls = new Set(manyPages.map((page) => page.url));
  expect(manyUrls.has('https://many.example/docs/page-1/')).toBe(true);
  expect(manyUrls.has('https://many.example/docs/page-20000/')).toBe(true);
  expect(manyUrls.has('https://many.example/docs/page-20001/')).toBe(false);
});

test('a fifth documentation root adds no pages and a leaf does not take a seed slot', async () => {
  const page = (host: string) => `https://${host}/docs/item/`;
  const seed = (host: string) => `https://${host}/docs/`;
  const hosts = ['one.example', 'two.example', 'three.example', 'four.example', 'five.example'];
  const leaf = 'https://leaf.example/docs/concepts/pods/';
  const calls = installHandler((url) => {
    const parsed = new URL(url);
    if (parsed.pathname === '/sitemap.xml') {
      return text(`<urlset><url><loc>${page(parsed.hostname)}</loc></url></urlset>`, 'application/xml');
    }
    return new Response('no', { status: 404 });
  });

  const discovered = await discoverPlanPages({
    goal: 'Five roots',
    level: null,
    locale: 'en',
    modules: [
      {
        title: 'Roots',
        outcome: 'Index only four roots',
        prerequisiteIndexes: [],
        urls: [seed(hosts[0]!), seed(hosts[1]!), leaf, seed(hosts[2]!), seed(hosts[3]!), seed(hosts[4]!)],
      },
    ],
  });
  const pages = toPlanOffer(discovered).modules[0]?.sections.flatMap((section) => section.pages) ?? [];
  const urls = new Set(pages.map((item) => item.url));
  for (const host of hosts.slice(0, 4)) expect(urls.has(page(host))).toBe(true);
  expect(urls.has(page('five.example'))).toBe(false);
  expect(urls.has(leaf)).toBe(false);
  expect(calls.some((url) => url.includes('leaf.example'))).toBe(false);
  expect(calls.some((url) => url.includes('five.example'))).toBe(false);
});
