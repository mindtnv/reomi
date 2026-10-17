import { readFileSync } from 'node:fs';
import { afterEach, expect, test } from 'bun:test';
import { referenceLinksToAdd } from '@reomi/shared';
import { discoverPlanPages, planSummary, toPlanOffer, __resetDocsIndexCacheForTests } from '../src/ai/docs-index.ts';
import { __setDnsLookupForTests, __setPageFetchForTests } from '../src/ai/page-reader.ts';
import { capStoredToolResult } from '../src/ai/tool-result-cap.ts';

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
  const early = `${origin}/docs/kept/early/`;
  const late = `${origin}/docs/kept/late/`;
  const huge = `<urlset><url><loc>${early}</loc></url>${' '.repeat(8 * 1024 * 1024)}<url><loc>${late}</loc></url></urlset>`;
  const manyOrigin = 'https://many.example';
  const locs: string[] = [];
  for (let n = 1; n <= 19_998; n += 1) locs.push(`<url><loc>${manyOrigin}/docs/other/page-${n}/</loc></url>`);
  locs.push(`<url><loc>${manyOrigin}/docs/kept/alpha/</loc></url>`);
  locs.push(`<url><loc>${manyOrigin}/docs/kept/beta/</loc></url>`);
  locs.push(`<url><loc>${manyOrigin}/docs/kept/gamma/</loc></url>`);
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
    modules: [{ title: 'Kept', outcome: 'Read the kept pages', prerequisiteIndexes: [], urls: [seed] }],
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
        title: 'Kept',
        outcome: 'Read the kept pages',
        prerequisiteIndexes: [],
        urls: ['https://many.example/docs/'],
      },
    ],
  });
  const manyPages = toPlanOffer(manyDiscovery).modules[0]?.sections.flatMap((section) => section.pages) ?? [];
  const manyUrls = new Set(manyPages.map((page) => page.url));
  expect(manyUrls.has(`${manyOrigin}/docs/kept/alpha/`)).toBe(true);
  expect(manyUrls.has(`${manyOrigin}/docs/kept/beta/`)).toBe(true);
  expect(manyUrls.has(`${manyOrigin}/docs/kept/gamma/`)).toBe(false);
  expect(manyUrls.has(`${manyOrigin}/docs/other/page-1/`)).toBe(false);
});

test('a sitemap index that lists itself is fetched once and still contributes its child page', async () => {
  const origin = 'https://self.example';
  const seed = `${origin}/docs/`;
  const page = `${origin}/docs/concepts/pods/`;
  let rootFetches = 0;
  const calls = installHandler((url) => {
    const path = pathname(url);
    if (path === '/llms.txt' || path === '/llms-full.txt') return new Response('no', { status: 404 });
    if (path === '/sitemap.xml') {
      rootFetches += 1;
      if (rootFetches > 3) return new Response('loop', { status: 404 });
      return text(
        `<sitemapindex><sitemap><loc>${origin}/sitemap.xml</loc></sitemap><sitemap><loc>${origin}/sitemaps/one.xml</loc></sitemap></sitemapindex>`,
        'application/xml',
      );
    }
    if (path === '/sitemaps/one.xml') return text(`<urlset><url><loc>${page}</loc></url></urlset>`, 'application/xml');
    return new Response('missing', { status: 404 });
  });

  const discovered = await discoverPlanPages({
    goal: 'Pods',
    level: null,
    locale: 'en',
    modules: [{ title: 'Pods', outcome: 'Read the pods page', prerequisiteIndexes: [], urls: [seed] }],
  });
  const pages = toPlanOffer(discovered).modules[0]?.sections.flatMap((section) => section.pages) ?? [];
  expect(pages.some((item) => item.url === page)).toBe(true);
  expect(calls.filter((url) => pathname(url) === '/sitemap.xml')).toHaveLength(1);
  expect(calls.filter((url) => pathname(url) === '/sitemaps/one.xml')).toHaveLength(1);
});

test('a chain of nested sitemap indexes stops at 16 child documents for the seed', async () => {
  const origin = 'https://chain.example';
  const seed = `${origin}/docs/`;
  const page = (n: number) => `${origin}/docs/concepts/part-${n}/`;
  let childFetches = 0;
  const calls = installHandler((url) => {
    const path = pathname(url);
    if (path === '/llms.txt' || path === '/llms-full.txt') return new Response('no', { status: 404 });
    if (path === '/sitemap.xml') {
      return text(
        `<sitemapindex><sitemap><loc>${origin}/sitemaps/node-1.xml</loc></sitemap></sitemapindex>`,
        'application/xml',
      );
    }
    const node = /^\/sitemaps\/node-(\d+)\.xml$/.exec(path);
    if (node) {
      childFetches += 1;
      if (childFetches > 40) return new Response('cap', { status: 404 });
      const n = Number(node[1]);
      return text(
        `<sitemapindex><sitemap><loc>${origin}/sitemaps/page-${n}.xml</loc></sitemap><sitemap><loc>${origin}/sitemaps/node-${n + 1}.xml</loc></sitemap></sitemapindex>`,
        'application/xml',
      );
    }
    const leaf = /^\/sitemaps\/page-(\d+)\.xml$/.exec(path);
    if (leaf) {
      childFetches += 1;
      if (childFetches > 40) return new Response('cap', { status: 404 });
      return text(`<urlset><url><loc>${page(Number(leaf[1]))}</loc></url></urlset>`, 'application/xml');
    }
    return new Response('missing', { status: 404 });
  });

  const discovered = await discoverPlanPages({
    goal: 'Parts',
    level: null,
    locale: 'en',
    modules: [{ title: 'Parts', outcome: 'Read the part pages', prerequisiteIndexes: [], urls: [seed] }],
  });
  expect(discovered.modules).toHaveLength(1);
  const childCalls = calls.filter((url) => pathname(url).startsWith('/sitemaps/'));
  expect(childCalls.length).toBeLessThanOrEqual(16);
  expect(childCalls.some((url) => pathname(url) === '/sitemaps/node-9.xml')).toBe(false);
  expect(childCalls.some((url) => pathname(url) === '/sitemaps/page-1.xml')).toBe(true);
});

test('a sitemap with no in-scope url yields to llms links', async () => {
  const origin = 'https://fallback.example';
  const seed = `${origin}/docs/`;
  const kept = `${origin}/docs/concepts/pods/`;
  const htmlOnly = `${origin}/docs/concepts/from-html/`;
  const calls = install({
    '/llms.txt': text(`- [Pods](${kept}): Run a pod.\n`, 'text/plain'),
    '/llms-full.txt': new Response('no', { status: 404 }),
    '/sitemap.xml': text(
      `<urlset><url><loc>https://other.example/docs/concepts/pods/</loc></url><url><loc>${origin}/blog/off/</loc></url><url><loc>${origin}/ru/docs/concepts/pods/</loc></url></urlset>`,
      'application/xml',
    ),
    '/docs/': text(`<a href="${htmlOnly}">HTML</a>`, 'text/html'),
  });

  const discovered = await discoverPlanPages({
    goal: 'Pods',
    level: null,
    locale: 'en',
    modules: [{ title: 'Pods', outcome: 'Read the pods page', prerequisiteIndexes: [], urls: [seed] }],
  });
  const pages = toPlanOffer(discovered).modules[0]?.sections.flatMap((section) => section.pages) ?? [];
  expect(pages.map((item) => item.url)).toEqual([kept]);
  expect(calls.map(pathname)).toEqual(['/llms.txt', '/llms-full.txt', '/sitemap.xml']);
});

test('a russian alternate survives when its canonical is the english page', async () => {
  const origin = 'https://locale.example';
  const seed = `${origin}/`;
  const russian = `${origin}/ru/docs/concepts/pods/`;
  const english = `${origin}/docs/concepts/pods/`;
  install({
    '/llms.txt': new Response('no', { status: 404 }),
    '/llms-full.txt': new Response('no', { status: 404 }),
    '/sitemap.xml': text(
      `<urlset xmlns:xhtml="http://www.w3.org/1999/xhtml"><url><loc>${russian}</loc><xhtml:link rel="canonical" href="${english}"/></url><url><loc>${english}</loc><xhtml:link rel="canonical" href="${english}"/></url></urlset>`,
      'application/xml',
    ),
  });

  const discovered = await discoverPlanPages({
    goal: 'Pods',
    level: null,
    locale: 'ru',
    modules: [{ title: 'Pods', outcome: 'Read the pods page', prerequisiteIndexes: [], urls: [seed] }],
  });
  const pages = toPlanOffer(discovered).modules[0]?.sections.flatMap((section) => section.pages) ?? [];
  expect(pages.map((item) => item.url)).toContain(russian);
  expect(pages.map((item) => item.url)).not.toContain(english);
});

test('sitemap child documents count bytes and stop at 8 MiB', async () => {
  const origin = 'https://bytes.example';
  const seed = `${origin}/docs/`;
  const early = `${origin}/docs/concepts/early/`;
  const late = `${origin}/docs/concepts/late/`;
  const calls = installHandler((url) => {
    const path = pathname(url);
    if (path === '/llms.txt' || path === '/llms-full.txt') return new Response('no', { status: 404 });
    if (path === '/sitemap.xml') {
      return text(
        `<sitemapindex><sitemap><loc>${origin}/sitemaps/early.xml</loc></sitemap><sitemap><loc>${origin}/sitemaps/late.xml</loc></sitemap></sitemapindex>`,
        'application/xml',
      );
    }
    if (path === '/sitemaps/early.xml') {
      return text(`<urlset><url><loc>${early}</loc></url>${'€'.repeat(3 * 1024 * 1024)}</urlset>`, 'application/xml');
    }
    if (path === '/sitemaps/late.xml') return text(`<urlset><url><loc>${late}</loc></url></urlset>`, 'application/xml');
    return new Response('missing', { status: 404 });
  });

  const discovered = await discoverPlanPages({
    goal: 'Early',
    level: null,
    locale: 'en',
    modules: [{ title: 'Early', outcome: 'Read the early page', prerequisiteIndexes: [], urls: [seed] }],
  });
  const pages = toPlanOffer(discovered).modules[0]?.sections.flatMap((section) => section.pages) ?? [];
  expect(pages.some((item) => item.url === early)).toBe(true);
  expect(pages.some((item) => item.url === late)).toBe(false);
  expect(calls.some((url) => pathname(url) === '/sitemaps/late.xml')).toBe(false);
});

test('a fifth documentation root adds no pages and a leaf does not take a seed slot', async () => {
  const page = (host: string) => `https://${host}/docs/roots/overview/`;
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
        outcome: 'Read the roots',
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

const K8S_SITEMAP = readFileSync(new URL('./fixtures/kubernetes-docs-sitemap.xml', import.meta.url), 'utf8');
const K8S_LLMS = readFileSync(new URL('./fixtures/kubernetes-docs-llms.txt', import.meta.url), 'utf8');
const K8S_SEED = 'https://kubernetes.io/docs/';
const K8S_POD = 'https://kubernetes.io/docs/concepts/workloads/pods/';
const K8S_DEPLOYMENT = 'https://kubernetes.io/docs/concepts/workloads/deployments/';
const K8S_SERVICE = 'https://kubernetes.io/docs/concepts/services-networking/service/';
const K8S_TASK_POD = 'https://kubernetes.io/docs/tasks/run-application/run-a-pod/';
const K8S_TASK_DEPLOY = 'https://kubernetes.io/docs/tasks/run-application/deploy-an-app/';
const K8S_API_POD = 'https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/pod-v1/';
const K8S_API_INGRESS = 'https://kubernetes.io/docs/reference/kubernetes-api/service-resources/ingress-v1/';

function installKubernetes(): string[] {
  return installHandler((url) => {
    const parsed = new URL(url);
    if (parsed.hostname !== 'kubernetes.io') return new Response('no', { status: 404 });
    if (parsed.pathname === '/llms.txt') return text(K8S_LLMS, 'text/plain');
    if (parsed.pathname === '/sitemap.xml') return text(K8S_SITEMAP, 'application/xml');
    return new Response('no', { status: 404 });
  });
}

function workloadsDiscovery(locale: 'en' | 'ru' = 'en') {
  return discoverPlanPages({
    goal: 'Learn Kubernetes workloads',
    level: null,
    locale,
    modules: [
      {
        title: 'Workloads',
        outcome: 'Schedule a Pod and a Deployment',
        prerequisiteIndexes: [],
        urls: [K8S_SEED],
      },
    ],
  });
}

test('a Workloads module offers the concept and task subtrees and leaves services and API reference unselected', async () => {
  const calls = installKubernetes();
  const discovered = await workloadsDiscovery();
  const offer = toPlanOffer(discovered).modules[0];
  const selected = offer?.sections.filter((section) => section.selected) ?? [];
  expect(selected.map((section) => section.prefix)).toEqual([
    '/docs/concepts/workloads/',
    '/docs/tasks/run-application/',
  ]);
  expect(selected[0]?.pages.map((page) => page.url).sort()).toEqual([K8S_DEPLOYMENT, K8S_POD].sort());
  expect(selected[1]?.pages.map((page) => page.url).sort()).toEqual([K8S_TASK_DEPLOY, K8S_TASK_POD].sort());
  expect(selected[0]?.pages.reduce((sum, page) => sum + page.estimatedTokens, 0)).toBe(2400);
  const urls = new Set(offer?.sections.flatMap((section) => section.pages.map((page) => page.url)) ?? []);
  expect(urls.has(K8S_SERVICE)).toBe(false);
  expect(urls.has('https://kubernetes.io/docs/concepts/workloads/index.html')).toBe(false);
  expect(urls.has('https://kubernetes.io/docs/tags/workloads/')).toBe(false);
  expect(urls.has('https://kubernetes.io/blog/2020/a-post/')).toBe(false);
  expect(urls.has('https://kubernetes.io/zh-cn/docs/concepts/workloads/pods/')).toBe(false);
  expect(urls.has('https://kubernetes.io/ru/docs/concepts/workloads/pods/')).toBe(false);
  expect(urls.has('https://v1-33.docs.kubernetes.io/docs/concepts/workloads/pods/')).toBe(false);
  const reference = offer?.sections.filter((section) => section.kind === 'reference') ?? [];
  expect(reference.length).toBeGreaterThan(0);
  expect(reference.every((section) => section.selected === false)).toBe(true);
  expect(reference.some((section) => section.prefix === '/docs/reference/kubernetes-api/')).toBe(true);
  expect(offer?.needsPages).toBe(false);
  expect(offer?.ignoredUrls).toContain(K8S_SEED);
  expect(calls.some((url) => url.includes('v1-33.docs.kubernetes.io'))).toBe(false);
  expect(calls.some((url) => url.includes('kubernetes.io'))).toBe(true);

  const summary = planSummary(discovered);
  expect(summary.modules[0]?.urls).toEqual([K8S_SEED]);
  expect(JSON.stringify(summary)).not.toContain(K8S_POD);
  expect(summary.modules[0]?.sections.find((section) => section.prefix === '/docs/concepts/workloads/')).toMatchObject({
    kind: 'content',
    selected: true,
    pageCount: 2,
    estimatedTokens: 2400,
  });
});

test('a related subtree over the remaining budget is omitted and a higher budget keeps it', async () => {
  const origin = 'https://relate.example';
  const page = (path: string) => `${origin}${path}`;
  const pods = page('/docs/concepts/workloads/pods/');
  const deployments = page('/docs/concepts/workloads/deployments/');
  const taskPod = page('/docs/tasks/run-application/run-a-pod/');
  const taskDeploy = page('/docs/tasks/run-application/deploy-an-app/');
  const service = page('/docs/concepts/services-networking/service/');
  const locs = [
    pods,
    deployments,
    service,
    taskPod,
    taskDeploy,
    page('/docs/setup/production-environment/overview/'),
    page('/docs/configuration/overview/'),
    page('/docs/storage/volumes/'),
  ];
  const titles: Record<string, string> = {
    [pods]: 'Pod',
    [deployments]: 'Deployment',
    [service]: 'Service',
    [taskPod]: 'Pod',
    [taskDeploy]: 'Deployment',
    [page('/docs/setup/production-environment/overview/')]: 'Cluster',
    [page('/docs/configuration/overview/')]: 'Config',
    [page('/docs/storage/volumes/')]: 'Volume',
  };
  const llms = locs.map((url) => `- [${titles[url]}](${url})`).join('\n');
  const sitemap = `<urlset>${locs.map((url) => `<url><loc>${url}</loc></url>`).join('')}</urlset>`;
  const calls = install({
    '/llms.txt': text(llms, 'text/plain'),
    '/llms-full.txt': new Response('no', { status: 404 }),
    '/sitemap.xml': text(sitemap, 'application/xml'),
  });
  const input = {
    goal: 'Workloads',
    level: null,
    locale: 'en' as const,
    modules: [
      {
        title: 'Workloads',
        outcome: 'Schedule a Pod and a Deployment',
        prerequisiteIndexes: [],
        urls: [`${origin}/docs/`],
      },
    ],
  };
  const previousBudget = process.env.TOPIC_PLAN_MODULE_TOKEN_BUDGET;
  process.env.TOPIC_PLAN_MODULE_TOKEN_BUDGET = '3000';
  try {
    const tight = toPlanOffer(await discoverPlanPages(input)).modules[0];
    const tightUrls = new Set(tight?.sections.flatMap((section) => section.pages.map((item) => item.url)) ?? []);
    expect(tightUrls.has(pods)).toBe(true);
    expect(tightUrls.has(deployments)).toBe(true);
    expect(tightUrls.has(taskPod)).toBe(false);
    expect(tightUrls.has(taskDeploy)).toBe(false);
    expect(tightUrls.has(service)).toBe(false);
    const before = calls.length;
    process.env.TOPIC_PLAN_MODULE_TOKEN_BUDGET = '8000';
    const wide = toPlanOffer(await discoverPlanPages(input)).modules[0];
    const wideSelected = wide?.sections.filter((section) => section.selected).map((section) => section.prefix) ?? [];
    expect(wideSelected).toEqual(['/docs/concepts/workloads/', '/docs/tasks/run-application/']);
    expect(wide?.sections.some((section) => section.prefix.includes('services-networking'))).toBe(false);
    expect(calls.length).toBe(before);
  } finally {
    if (previousBudget === undefined) delete process.env.TOPIC_PLAN_MODULE_TOKEN_BUDGET;
    else process.env.TOPIC_PLAN_MODULE_TOKEN_BUDGET = previousBudget;
  }
});

test('an ancestor over the budget offers a child subtree and does not cut pages', async () => {
  const origin = 'https://guide.example';
  const notes = Array.from({ length: 30 }, (_, index) => `${origin}/docs/guide/note-${index + 1}/`);
  const appendix = Array.from({ length: 30 }, (_, index) => `${origin}/docs/guide/appendix/page-${index + 1}/`);
  const intro = `${origin}/docs/guide/chapter/intro/`;
  const details = `${origin}/docs/guide/chapter/details/`;
  const locs = [...notes, intro, details, ...appendix];
  const sitemap = `<urlset>${locs.map((url) => `<url><loc>${url}</loc></url>`).join('')}</urlset>`;
  install({
    '/llms.txt': new Response('no', { status: 404 }),
    '/llms-full.txt': new Response('no', { status: 404 }),
    '/sitemap.xml': text(sitemap, 'application/xml'),
  });
  const discovered = await discoverPlanPages({
    goal: 'Guide',
    level: null,
    locale: 'en',
    modules: [
      {
        title: 'Guide',
        outcome: 'Read the guide',
        prerequisiteIndexes: [],
        urls: [`${origin}/docs/`],
      },
    ],
  });
  const pages = toPlanOffer(discovered).modules[0]?.sections.flatMap((section) => section.pages) ?? [];
  expect(pages.map((page) => page.url).sort()).toEqual([details, intro].sort());
  expect(pages.some((page) => page.url === notes[0])).toBe(false);
  expect(pages.some((page) => page.url === appendix[0] || page.url === appendix[29])).toBe(false);
});

test('a linked API page is added from the catalog and an unlinked API page is not', async () => {
  installKubernetes();
  const offer = toPlanOffer(await workloadsDiscovery()).modules[0];
  const catalog = offer?.catalog;
  expect(catalog?.entries.map((entry) => entry.url)).toContain(K8S_API_POD);
  expect(catalog?.entries.map((entry) => entry.url)).toContain(K8S_API_INGRESS);
  expect(catalog?.entries.some((entry) => entry.url.includes('/blog/'))).toBe(false);
  expect(referenceLinksToAdd([K8S_API_POD, K8S_SERVICE, 'https://other.example/docs/reference/pod/'], catalog!)).toEqual([
    K8S_API_POD,
  ]);
  expect(referenceLinksToAdd([K8S_API_INGRESS], { ...catalog!, remainingTokens: 100 })).toEqual([]);
  const selected = new Set(
    offer?.sections.filter((section) => section.selected).flatMap((section) => section.pages.map((page) => page.url)) ??
      [],
  );
  expect(selected.has(K8S_API_POD)).toBe(false);
  expect(selected.has(K8S_API_INGRESS)).toBe(false);
});

test('a stored plan keeps section summaries and does not copy discovered page URLs into the module list', () => {
  const stored = capStoredToolResult(
    'propose_topic_plan',
    JSON.stringify({
      goal: 'Learn Kubernetes',
      level: null,
      modules: [
        {
          title: 'Workloads',
          outcome: 'Schedule a Pod and a Deployment',
          prerequisiteIndexes: [],
          urls: [K8S_SEED],
          needsPages: false,
          sections: [
            {
              prefix: '/docs/concepts/workloads/',
              kind: 'content',
              selected: true,
              pageCount: 2,
              estimatedTokens: 2400,
              pages: [{ url: K8S_POD, title: 'Pod', estimatedTokens: 1200 }],
            },
          ],
        },
      ],
    }),
  );
  const parsed = JSON.parse(stored) as {
    modules: { urls: string[]; needsPages: boolean; sections: { prefix: string; pages?: unknown }[] }[];
  };
  expect(parsed.modules[0]?.urls).toEqual([K8S_SEED]);
  expect(JSON.stringify(parsed)).not.toContain(K8S_POD);
  expect(parsed.modules[0]?.needsPages).toBe(false);
  expect(parsed.modules[0]?.sections[0]?.prefix).toBe('/docs/concepts/workloads/');
  expect(parsed.modules[0]?.sections[0]?.pages).toBeUndefined();
});
