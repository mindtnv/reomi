import {
  isDiscoverySeed,
  keepLocalePages,
  namedDocVersion,
  preferDocVersions,
  storedDocVersion,
  type PlanOffer,
  type PlanOfferModule,
  type PlanPage,
  type PlanSection,
  type PlanSummary,
} from '@reomi/shared';
import { normalizePlanUrl } from '../modules/plan-url.ts';
import { fetchIndexBody } from './page-reader.ts';

export type PlanLocale = 'en' | 'ru';

export type DiscoveryModule = {
  title: string;
  outcome: string;
  prerequisiteIndexes: number[];
  urls: string[];
};

export type PlanDiscovery = {
  modules: DiscoveryModule[];
  offers: PlanOfferModule[];
};

const LLMS_MAX_BYTES = 256 * 1024;
const SITEMAP_MAX_BYTES = 8 * 1024 * 1024;
const SITEMAP_LOC_MAX = 20_000;
const SITEMAP_CHILD_MAX = 16;
const DESCRIPTION_MAX = 300;
const PAGE_TOKEN_ESTIMATE = 1200;
const PAGE_TOKEN_MIN = 100;
const PAGE_TOKEN_MAX = 8000;
const MODULE_TOKEN_BUDGET = 32_000;
const SEED_MAX = 4;

type SeedIdentity = {
  origin: string;
  host: string;
  path: string;
};

type FrozenPage = {
  url: string;
  title: string;
  description: string;
  treePosition: string;
};

type TrieNode = {
  segment: string;
  path: string;
  children: Map<string, TrieNode>;
  pages: FrozenPage[];
};

const indexCache = new Map<string, readonly FrozenPage[]>();

export function __resetDocsIndexCacheForTests(): void {
  indexCache.clear();
}

export async function discoverPlanPages(input: {
  goal: string;
  level: string | null;
  locale: PlanLocale;
  modules: readonly DiscoveryModule[];
}): Promise<PlanDiscovery> {
  const seeds: string[] = [];
  const seenSeeds = new Set<string>();
  for (const module of input.modules) {
    for (const url of module.urls) {
      if (!isDiscoverySeed(url)) continue;
      const key = seedKey(url);
      if (!key || seenSeeds.has(key)) continue;
      if (seeds.length >= SEED_MAX) continue;
      seenSeeds.add(key);
      seeds.push(url);
    }
  }

  const indexes = new Map<string, readonly FrozenPage[]>();
  for (const url of seeds) {
    const key = seedKey(url);
    if (!key) continue;
    indexes.set(key, await loadSeedIndex(url, input.locale));
  }

  const offers = input.modules.map((module) =>
    offerModule(module, indexes, namedDocVersion(`${input.goal}\n${input.level ?? ''}\n${module.title}\n${module.outcome}`)),
  );

  return {
    modules: input.modules.map((module) => ({
      title: module.title,
      outcome: module.outcome,
      prerequisiteIndexes: [...module.prerequisiteIndexes],
      urls: [...module.urls],
    })),
    offers,
  };
}

export function planSummary(discovered: PlanDiscovery): PlanSummary {
  return {
    modules: discovered.modules.map((module, index) => {
      const offer = discovered.offers[index];
      return {
        title: module.title,
        outcome: module.outcome,
        prerequisiteIndexes: [...module.prerequisiteIndexes],
        urls: [...module.urls],
        needsPages: offer?.needsPages ?? true,
        sections: (offer?.sections ?? []).map((section) => ({
          prefix: section.prefix,
          kind: section.kind,
          selected: section.selected,
          pageCount: section.pages.length,
          estimatedTokens: section.pages.reduce((sum, page) => sum + page.estimatedTokens, 0),
        })),
      };
    }),
  };
}

export function toPlanOffer(discovered: PlanDiscovery): PlanOffer {
  return { modules: discovered.offers.map((offer) => ({ ...offer, sections: offer.sections.map((section) => ({ ...section, pages: [...section.pages] })), ignoredUrls: [...offer.ignoredUrls] })) };
}

function offerModule(
  module: DiscoveryModule,
  indexes: ReadonlyMap<string, readonly FrozenPage[]>,
  named: string | null,
): PlanOfferModule {
  const ignoredUrls: string[] = [];
  const seenIgnored = new Set<string>();
  for (const url of module.urls) {
    if (!isDiscoverySeed(url)) continue;
    const normalized = normalizePlanUrl(url);
    if (!normalized || seenIgnored.has(normalized)) continue;
    seenIgnored.add(normalized);
    ignoredUrls.push(normalized);
  }

  const collected: FrozenPage[] = [];
  const seenPages = new Set<string>();
  let docVersion: string | null = null;
  let sawSeed = false;
  for (const url of module.urls) {
    if (!isDiscoverySeed(url)) continue;
    const key = seedKey(url);
    if (!key) continue;
    if (!sawSeed) {
      sawSeed = true;
      try {
        docVersion = storedDocVersion(new URL(url).hostname);
      } catch {
        docVersion = null;
      }
    }
    for (const page of indexes.get(key) ?? []) {
      if (seenPages.has(page.url)) continue;
      seenPages.add(page.url);
      collected.push(page);
    }
  }

  const copied = collected.map((page) => ({ ...page }));
  const preferred = new Set(preferDocVersions(copied.map((page) => page.url), named));
  const chosen = copied.filter((page) => preferred.has(page.url));
  const sections = sectionsFromTrie(buildTrie(chosen));
  const selectedPages = sections.reduce((sum, section) => sum + section.pages.length, 0);
  const spent = sections.reduce(
    (sum, section) => sum + section.pages.reduce((inner, page) => inner + page.estimatedTokens, 0),
    0,
  );
  const hand = module.urls.filter((url) => {
    const normalized = normalizePlanUrl(url);
    return normalized !== null && !isDiscoverySeed(url) && !seenIgnored.has(normalized);
  });

  return {
    sections,
    ignoredUrls,
    docVersion,
    catalog: {
      v: 1,
      remainingTokens: Math.max(0, MODULE_TOKEN_BUDGET - spent),
      entries: [],
      pending: [],
    },
    needsPages: selectedPages === 0 && hand.length === 0,
  };
}

function sectionsFromTrie(root: TrieNode): PlanSection[] {
  const sections: PlanSection[] = [];
  const walk = (node: TrieNode): void => {
    if (node.pages.length > 0) {
      const pages: PlanPage[] = node.pages.map((page) => ({
        url: page.url,
        title: page.title,
        estimatedTokens: estimateTokens(page.title, page.description),
      }));
      sections.push({ prefix: node.path, kind: 'content', selected: true, pages });
    }
    for (const segment of node.children.keys()) {
      const child = childAt(node, segment);
      if (child) walk(child);
    }
  };
  walk(root);
  return sections;
}

function childAt(node: TrieNode, segment: string): TrieNode | undefined {
  if (segment.length === 0 || segment.includes('/')) return undefined;
  return node.children.get(segment);
}

function buildTrie(pages: readonly FrozenPage[]): TrieNode {
  const root = emptyNode('', '/');
  for (const page of pages) {
    const segments = page.treePosition.split('/').filter((segment) => segment.length > 0);
    let node = root;
    let path = '';
    for (const segment of segments) {
      path += `/${segment}`;
      const key = segment.toLowerCase();
      let child = childAt(node, key);
      if (!child) {
        child = emptyNode(segment, `${path}/`);
        node.children.set(key, child);
      }
      node = child;
    }
    node.pages.push(page);
  }
  return root;
}

function emptyNode(segment: string, path: string): TrieNode {
  return { segment, path, children: new Map(), pages: [] };
}

function estimateTokens(title: string, description: string): number {
  if (description.trim().length === 0) return clamp(PAGE_TOKEN_ESTIMATE, PAGE_TOKEN_MIN, PAGE_TOKEN_MAX);
  return clamp(Math.ceil((title.length + description.length) / 4), PAGE_TOKEN_MIN, PAGE_TOKEN_MAX);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function loadSeedIndex(seedUrl: string, locale: PlanLocale): Promise<readonly FrozenPage[]> {
  const identity = seedIdentity(seedUrl);
  if (!identity) return [];
  const key = `${identity.origin}\0${locale}\0${identity.path}`;
  const cached = indexCache.get(key);
  if (cached) return cached;
  let pages: FrozenPage[] = [];
  try {
    pages = await buildSeedIndex(identity, locale);
  } catch {
    pages = [];
  }
  const frozen = Object.freeze(pages.map((page) => Object.freeze(page)));
  indexCache.set(key, frozen);
  return frozen;
}

async function buildSeedIndex(identity: SeedIdentity, locale: PlanLocale): Promise<FrozenPage[]> {
  const llms = await readLlms(identity.origin);
  const sitemap = await readSitemap(identity.origin, locale);
  const raw = sitemap.length > 0 ? decorate(sitemap, llms.titles) : decorate(llms.links, llms.titles);
  const scoped = localize(raw.filter((page) => inSeed(page.url, identity)), locale);
  if (scoped.length > 0) return scoped;
  const fromPage = (await readSeedPage(identity)).filter((page) => inSeed(page.url, identity));
  return localize(fromPage, locale);
}

function localize(pages: FrozenPage[], locale: PlanLocale): FrozenPage[] {
  const allowed = new Set(keepLocalePages(pages.map((page) => page.url), locale));
  return pages.filter((page) => allowed.has(page.url));
}

async function readLlms(origin: string): Promise<{
  titles: Map<string, { title: string; description: string }>;
  links: string[];
}> {
  const titles = new Map<string, { title: string; description: string }>();
  const links: string[] = [];
  const seen = new Set<string>();
  for (const name of ['/llms.txt', '/llms-full.txt']) {
    const fetched = await fetchIndexBody(`${origin}${name}`, LLMS_MAX_BYTES);
    if (!fetched) continue;
    if (new URL(fetched.url).hostname !== new URL(origin).hostname) continue;
    for (const link of parseLlms(fetched.body, fetched.url)) {
      titles.set(matchKey(link.url), { title: link.title, description: link.description });
      if (seen.has(matchKey(link.url))) continue;
      seen.add(matchKey(link.url));
      links.push(link.url);
    }
  }
  return { titles, links };
}

async function readSeedPage(identity: SeedIdentity): Promise<FrozenPage[]> {
  const fetched = await fetchIndexBody(`${identity.origin}${identity.path}`, 2 * 1024 * 1024);
  if (!fetched) return [];
  if (new URL(fetched.url).hostname !== identity.host) return [];
  if (!inSeed(fetched.url, identity) && identity.path !== '/') return [];
  return decorate(htmlHrefs(fetched.body, fetched.url), new Map());
}

function htmlHrefs(html: string, baseUrl: string): string[] {
  const hrefs: string[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const raw = (match[1] ?? match[2] ?? '').trim();
    if (!raw || raw.startsWith('#') || raw.startsWith('javascript:') || raw.startsWith('mailto:')) continue;
    let absolute: string;
    try {
      absolute = new URL(raw, baseUrl).href;
    } catch {
      continue;
    }
    const url = normalizePlanUrl(absolute);
    if (!url || seen.has(matchKey(url))) continue;
    seen.add(matchKey(url));
    hrefs.push(url);
    if (hrefs.length >= 2000) break;
  }
  return hrefs;
}

async function readSitemap(origin: string, locale: PlanLocale): Promise<string[]> {
  const fetched = await fetchIndexBody(`${origin}/sitemap.xml`, SITEMAP_MAX_BYTES);
  if (!fetched) return [];
  if (new URL(fetched.url).hostname !== new URL(origin).hostname) return [];
  const budget = { bytes: fetched.body.length, locs: 0 };
  return readSitemapDocument(fetched.body, fetched.url, origin, locale, budget);
}

async function readSitemapDocument(
  xml: string,
  baseUrl: string,
  origin: string,
  locale: PlanLocale,
  budget: { bytes: number; locs: number },
): Promise<string[]> {
  if (/<sitemapindex\b/i.test(xml)) return readSitemapIndex(xml, baseUrl, origin, locale, budget);
  const remaining = SITEMAP_LOC_MAX - budget.locs;
  if (remaining <= 0) return [];
  const entries = parseUrlset(xml, baseUrl, remaining);
  budget.locs += entries.length;
  return collapseCanonical(entries);
}

async function readSitemapIndex(
  xml: string,
  baseUrl: string,
  origin: string,
  locale: PlanLocale,
  budget: { bytes: number; locs: number },
): Promise<string[]> {
  const originHost = new URL(origin).hostname;
  const urls: string[] = [];
  let accepted = 0;
  for (const child of parseIndexChildren(xml, baseUrl)) {
    if (budget.locs >= SITEMAP_LOC_MAX || budget.bytes >= SITEMAP_MAX_BYTES) break;
    let parsed: URL;
    try {
      parsed = new URL(child);
    } catch {
      continue;
    }
    if (parsed.hostname !== originHost) continue;
    if (namesOtherLocale(child, locale)) continue;
    if (accepted >= SITEMAP_CHILD_MAX) break;
    accepted += 1;
    const remainingBytes = SITEMAP_MAX_BYTES - budget.bytes;
    if (remainingBytes <= 0) break;
    const fetched = await fetchIndexBody(child, remainingBytes);
    if (!fetched) continue;
    if (new URL(fetched.url).hostname !== originHost) continue;
    budget.bytes += fetched.body.length;
    const nested = await readSitemapDocument(fetched.body, fetched.url, origin, locale, budget);
    urls.push(...nested);
  }
  return urls;
}

const FILENAME_LOCALES = [
  'zh-cn',
  'zh-tw',
  'zh-hk',
  'pt-br',
  'zh',
  'ru',
  'ja',
  'ko',
  'de',
  'fr',
  'es',
  'pt',
  'uk',
  'pl',
  'it',
  'nl',
  'tr',
  'vi',
  'id',
  'hi',
  'ar',
  'fa',
  'he',
  'sv',
  'cs',
  'sk',
  'hu',
  'ro',
  'bg',
  'el',
  'th',
  'fi',
  'da',
  'no',
  'nb',
  'nn',
  'en',
];

function namesOtherLocale(url: string, locale: PlanLocale): boolean {
  let filename = '';
  try {
    filename = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '').toLowerCase();
  } catch {
    return false;
  }
  for (const tag of FILENAME_LOCALES) {
    const pattern = new RegExp(`(^|[^a-z])${tag}([^a-z]|$)`);
    if (!pattern.test(filename)) continue;
    if (locale === 'en' && (tag === 'en' || tag.startsWith('en-'))) continue;
    if (locale === 'ru' && (tag === 'ru' || tag.startsWith('ru-'))) continue;
    return true;
  }
  return false;
}

function parseIndexChildren(xml: string, baseUrl: string): string[] {
  const children: string[] = [];
  for (const match of xml.matchAll(/<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi)) {
    const locMatch = /<loc>\s*([^<]*?)\s*<\/loc>/i.exec(match[1] ?? '');
    if (!locMatch) continue;
    try {
      const url = normalizePlanUrl(new URL(decodeXml(locMatch[1] ?? ''), baseUrl).href);
      if (url) children.push(url);
    } catch {
      continue;
    }
  }
  return children;
}

function decorate(
  locs: readonly string[],
  titles: ReadonlyMap<string, { title: string; description: string }>,
): FrozenPage[] {
  const pages: FrozenPage[] = [];
  const seen = new Set<string>();
  for (const loc of locs) {
    const url = normalizePlanUrl(loc);
    if (!url || seen.has(matchKey(url))) continue;
    seen.add(matchKey(url));
    const meta = titles.get(matchKey(url));
    pages.push({
      url,
      title: meta?.title || fallbackTitle(url),
      description: meta?.description ?? '',
      treePosition: treePosition(url),
    });
  }
  return pages;
}

function parseLlms(body: string, baseUrl: string): { url: string; title: string; description: string }[] {
  const links: { url: string; title: string; description: string }[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(/\[([^\]\n]+)\]\(([^)\s]+)\)([^\n]*)/g)) {
    const label = cleanLabel(match[1] ?? '');
    const raw = (match[2] ?? '').trim();
    if (!label || raw.startsWith('#') || raw.startsWith('mailto:')) continue;
    let absolute: string;
    try {
      absolute = new URL(raw, baseUrl).href;
    } catch {
      continue;
    }
    const url = normalizePlanUrl(absolute);
    if (!url || seen.has(matchKey(url))) continue;
    seen.add(matchKey(url));
    const description = capText(cleanLabel((match[3] ?? '').replace(/^[\s:–—-]+/, '')), DESCRIPTION_MAX);
    links.push({ url, title: capText(label, DESCRIPTION_MAX), description });
  }
  return links;
}

type SitemapEntry = { url: string; canonical: string | null };

function parseUrlset(xml: string, baseUrl: string, limit: number): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  for (const match of xml.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)) {
    if (entries.length >= limit) break;
    const inner = match[1] ?? '';
    const locMatch = /<loc>\s*([^<]*?)\s*<\/loc>/i.exec(inner);
    if (!locMatch) continue;
    const loc = normalizePlanUrl(decodeXml(locMatch[1] ?? ''));
    if (!loc) continue;
    const canonicalRaw = canonicalHref(inner);
    let canonical: string | null = null;
    if (canonicalRaw) {
      try {
        canonical = normalizePlanUrl(new URL(canonicalRaw, baseUrl).href);
      } catch {
        canonical = null;
      }
    }
    entries.push({ url: loc, canonical });
  }
  return entries;
}

function canonicalHref(inner: string): string | null {
  for (const tag of inner.matchAll(/<xhtml:link\b[^>]*>/gi)) {
    const text = tag[0] ?? '';
    const rel = /rel\s*=\s*["']([^"']+)["']/i.exec(text)?.[1]?.toLowerCase();
    if (rel !== 'canonical') continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(text)?.[1];
    if (href) return decodeXml(href).trim();
  }
  return null;
}

function collapseCanonical(entries: readonly SitemapEntry[]): string[] {
  const groups = new Map<string, SitemapEntry[]>();
  const order: string[] = [];
  for (const entry of entries) {
    const key = entry.canonical ?? entry.url;
    const group = groups.get(key);
    if (group) group.push(entry);
    else {
      groups.set(key, [entry]);
      order.push(key);
    }
  }
  const urls: string[] = [];
  for (const key of order) {
    const group = groups.get(key) ?? [];
    const match = group.find((entry) => entry.canonical !== null && entry.url === entry.canonical) ?? group[0];
    if (match) urls.push(match.url);
  }
  return urls;
}

function decodeXml(value: string): string {
  return value
    .trim()
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");
}

function inSeed(url: string, identity: SeedIdentity): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.hostname !== identity.host) return false;
  if (identity.path === '/') return true;
  const path = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
  return path.startsWith(identity.path);
}

function seedIdentity(raw: string): SeedIdentity | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  let path = parsed.pathname || '/';
  if (!path.endsWith('/')) path += '/';
  return { origin: parsed.origin, host: parsed.hostname, path };
}

function seedKey(url: string): string | null {
  const identity = seedIdentity(url);
  if (!identity) return null;
  return `${identity.origin}\0${identity.path}`;
}

function treePosition(url: string): string {
  const segments = new URL(url).pathname.split('/').filter((segment) => segment.length > 0);
  if (segments.length <= 1) return '/';
  return `/${segments.slice(0, -1).join('/')}/`;
}

function fallbackTitle(url: string): string {
  const segments = new URL(url).pathname.split('/').filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1] ?? 'page';
  try {
    return decodeURIComponent(last).replaceAll('-', ' ');
  } catch {
    return last;
  }
}

function matchKey(url: string): string {
  const parsed = new URL(url);
  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.hash = '';
  return parsed.href;
}

function cleanLabel(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function capText(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : chars.slice(0, max).join('');
}
