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
import { env } from '../env.ts';
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
const PAGE_TOKEN_MIN = 100;
const PAGE_TOKEN_MAX = 8000;
const SEED_MAX = 4;
const REFERENCE_SEGMENTS = new Set(['reference', 'kubernetes-api', 'api-reference', 'glossary']);
const EXCLUDED_SEGMENTS = new Set(['blog', 'tags', 'tag']);
const VERSION_TOKENS = new Set(['stable', 'latest', 'current', 'next']);

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

const INDEX_CACHE_MAX = 32;
const INDEX_CACHE_TTL_MS = 15 * 60 * 1000;

type IndexCacheEntry = { at: number; pages: readonly FrozenPage[] };

const indexCache = new Map<string, IndexCacheEntry>();

export function __resetDocsIndexCacheForTests(): void {
  indexCache.clear();
}

function cachedIndex(key: string): readonly FrozenPage[] | undefined {
  const hit = indexCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > INDEX_CACHE_TTL_MS) {
    indexCache.delete(key);
    return undefined;
  }
  indexCache.delete(key);
  indexCache.set(key, hit);
  return hit.pages;
}

function storeIndex(key: string, pages: readonly FrozenPage[]): void {
  indexCache.delete(key);
  indexCache.set(key, { at: Date.now(), pages });
  while (indexCache.size > INDEX_CACHE_MAX) {
    const oldest = indexCache.keys().next().value;
    if (oldest === undefined) break;
    indexCache.delete(oldest);
  }
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
  const budget = env.ai.TOPIC_PLAN_MODULE_TOKEN_BUDGET;
  const ignoredUrls: string[] = [];
  const seenIgnored = new Set<string>();
  const rememberIgnored = (url: string): void => {
    const normalized = normalizePlanUrl(url);
    if (!normalized || seenIgnored.has(normalized)) return;
    seenIgnored.add(normalized);
    ignoredUrls.push(normalized);
  };
  for (const url of module.urls) {
    if (isDiscoverySeed(url)) rememberIgnored(url);
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
      collected.push({ ...page });
    }
  }

  const preferred = new Set(preferDocVersions(collected.map((page) => page.url), named));
  const chosen = collected.filter((page) => preferred.has(page.url));
  const names = namedClasses(`${module.title} ${module.outcome}`);
  const content: FrozenPage[] = [];
  const reference: FrozenPage[] = [];
  for (const page of chosen) {
    const kind = pageClass(page.url, names);
    if (kind === 'content') content.push(page);
    else if (kind === 'reference') reference.push(page);
  }

  const limiters = limiterPaths(module.urls, [...content, ...reference]);
  for (const limiter of limiters) rememberIgnored(limiter);
  const inScope = (page: FrozenPage): boolean =>
    limiters.length === 0 || limiters.some((limiter) => pageUnder(limiter, page.url));
  const contentPages = content.filter(inScope);
  const referencePages = reference.filter(inScope);

  const sections: PlanSection[] = [];
  let spent = 0;
  const trie = buildTrie(contentPages);
  const startPath = limiters.length === 1 ? pathnameOf(limiters[0]!) : firstSeedPath(module.urls);
  const start = startPath ? findNode(trie, startPath) : null;
  if (start) {
    const tokens = moduleTokens(module.title, module.outcome);
    const primary = deepestImproving(start, tokens);
    if (ownScore(primary, tokens) > 0) {
      const picked: FrozenPage[] = [];
      spent += takeScored(primary, tokens, budget, sections, picked);
      spent += addRelated(start, primary, picked, tokens, budget - spent, sections);
    }
  }

  for (const group of groupReference(referencePages, names)) {
    const cost = group.pages.reduce((sum, page) => sum + page.estimatedTokens, 0);
    const selected = group.named && cost > 0 && cost <= budget - spent;
    if (selected) spent += cost;
    sections.push({ prefix: group.prefix, kind: 'reference', selected, pages: group.pages });
  }

  const selectedContent = sections
    .filter((section) => section.kind === 'content' && section.selected)
    .reduce((sum, section) => sum + section.pages.length, 0);
  const hand = module.urls.filter((url) => {
    const normalized = normalizePlanUrl(url);
    return normalized !== null && !seenIgnored.has(normalized);
  });

  return {
    sections,
    ignoredUrls,
    docVersion,
    catalog: {
      v: 1,
      remainingTokens: Math.max(0, budget - spent),
      entries: unselectedReferenceEntries(sections),
      pending: [],
    },
    needsPages: selectedContent === 0 && hand.length === 0,
  };
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
  if (description.trim().length === 0) return clamp(env.ai.TOPIC_PLAN_PAGE_TOKEN_ESTIMATE, PAGE_TOKEN_MIN, PAGE_TOKEN_MAX);
  return clamp(Math.ceil((title.length + description.length) / 4), PAGE_TOKEN_MIN, PAGE_TOKEN_MAX);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

type NamedClasses = {
  reference: boolean;
  glossary: boolean;
  blog: boolean;
  tags: boolean;
  index: boolean;
};

function mentions(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^\\p{L}])${escaped}(?=$|[^\\p{L}])`, 'iu').test(text);
}

function namedClasses(text: string): NamedClasses {
  return {
    reference: mentions(text, 'api reference') || mentions(text, 'api-reference') || mentions(text, 'справочник'),
    glossary: mentions(text, 'glossary') || mentions(text, 'глоссарий'),
    blog: mentions(text, 'blog') || mentions(text, 'блог'),
    tags: mentions(text, 'tags') || mentions(text, 'tag') || mentions(text, 'теги'),
    index: mentions(text, 'index'),
  };
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}]+/u).filter((token) => token.length > 0);
}

function moduleTokens(title: string, outcome: string): Set<string> {
  const tokens = new Set<string>();
  for (const token of tokenize(`${title} ${outcome}`)) {
    if (token.length < 3 || VERSION_TOKENS.has(token)) continue;
    tokens.add(token);
  }
  return tokens;
}

function textOverlap(tokens: Set<string>, text: string): number {
  if (tokens.size === 0 || text.length === 0) return 0;
  const haystack = new Set(tokenize(text));
  let count = 0;
  for (const token of tokens) if (haystack.has(token)) count += 1;
  return count;
}

function setOverlap(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const token of left) if (right.has(token)) count += 1;
  return count;
}

function ownScore(node: TrieNode, tokens: Set<string>): number {
  const pages = node.pages.map((page) => `${page.title} ${page.description}`).join(' ');
  return 10 * textOverlap(tokens, node.segment) + 3 * textOverlap(tokens, pages);
}

function segmentsOfPath(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function pathnameOf(url: string): string | null {
  try {
    const path = new URL(url).pathname;
    return path.endsWith('/') ? path : `${path}/`;
  } catch {
    return null;
  }
}

function pageClass(url: string, names: NamedClasses): 'content' | 'reference' | 'excluded' {
  const path = pathnameOf(url);
  if (!path) return 'excluded';
  const segments = segmentsOfPath(path);
  const last = segments[segments.length - 1]?.toLowerCase() ?? '';
  const excluded =
    last === 'index' ||
    last === 'index.html' ||
    segments.some((segment) => EXCLUDED_SEGMENTS.has(segment.toLowerCase()));
  if (excluded) {
    const named =
      (names.index && (last === 'index' || last === 'index.html')) ||
      (names.blog && segments.some((segment) => segment.toLowerCase() === 'blog')) ||
      (names.tags &&
        segments.some((segment) => {
          const value = segment.toLowerCase();
          return value === 'tags' || value === 'tag';
        }));
    return named ? 'content' : 'excluded';
  }
  if (segments.some((segment) => REFERENCE_SEGMENTS.has(segment.toLowerCase()))) return 'reference';
  return 'content';
}

function pageUnder(prefixUrl: string, pageUrl: string): boolean {
  try {
    const prefix = new URL(prefixUrl);
    const page = new URL(pageUrl);
    if (prefix.hostname !== page.hostname) return false;
    const base = prefix.pathname.endsWith('/') ? prefix.pathname : `${prefix.pathname}/`;
    const path = page.pathname.endsWith('/') ? page.pathname : `${page.pathname}/`;
    return path.startsWith(base);
  } catch {
    return false;
  }
}

function limiterPaths(urls: readonly string[], pages: readonly FrozenPage[]): string[] {
  const limiters: string[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    if (isDiscoverySeed(url)) continue;
    const normalized = normalizePlanUrl(url);
    if (!normalized || seen.has(normalized)) continue;
    const limits = pages.some((page) => {
      if (!pageUnder(normalized, page.url)) return false;
      const prefix = pathnameOf(normalized);
      const path = pathnameOf(page.url);
      return prefix !== null && path !== null && path !== prefix;
    });
    if (!limits) continue;
    seen.add(normalized);
    limiters.push(normalized);
  }
  return limiters;
}

function firstSeedPath(urls: readonly string[]): string | null {
  for (const url of urls) {
    if (!isDiscoverySeed(url)) continue;
    const identity = seedIdentity(url);
    if (identity) return identity.path;
  }
  return null;
}

function findNode(root: TrieNode, prefix: string): TrieNode | null {
  let node = root;
  for (const segment of segmentsOfPath(prefix)) {
    const child = childAt(node, segment.toLowerCase());
    if (!child) return null;
    node = child;
  }
  return node;
}

function subtreePages(node: TrieNode): FrozenPage[] {
  const pages = [...node.pages];
  for (const child of node.children.values()) pages.push(...subtreePages(child));
  return pages;
}

function toPlanPage(page: FrozenPage): PlanPage {
  return { url: page.url, title: page.title, estimatedTokens: estimateTokens(page.title, page.description) };
}

function deepestImproving(node: TrieNode, tokens: Set<string>): TrieNode {
  let best = node;
  let bestScore = ownScore(node, tokens);
  const visit = (current: TrieNode): void => {
    const score = ownScore(current, tokens);
    if (score > bestScore) {
      best = current;
      bestScore = score;
    }
    for (const child of current.children.values()) visit(child);
  };
  visit(node);
  return best;
}

function takeScored(
  node: TrieNode,
  tokens: Set<string>,
  budget: number,
  sections: PlanSection[],
  picked: FrozenPage[],
): number {
  const covered = subtreePages(node);
  const cost = covered.reduce((sum, page) => sum + estimateTokens(page.title, page.description), 0);
  if (covered.length > 0 && cost > 0 && cost <= budget) {
    sections.push({ prefix: node.path, kind: 'content', selected: true, pages: covered.map(toPlanPage) });
    picked.push(...covered);
    return cost;
  }
  const children = [...node.children.values()].sort((left, right) => {
    const score = ownScore(right, tokens) - ownScore(left, tokens);
    if (score !== 0) return score;
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });
  let spent = 0;
  for (const child of children) {
    if (spent >= budget) break;
    spent += takeScored(child, tokens, budget - spent, sections, picked);
  }
  return spent;
}

function titleTokens(pages: readonly FrozenPage[]): Set<string> {
  const tokens = new Set<string>();
  for (const page of pages) {
    for (const token of tokenize(page.title)) {
      if (token.length >= 3) tokens.add(token);
    }
  }
  return tokens;
}

function collectNodes(node: TrieNode, into: TrieNode[]): void {
  into.push(node);
  for (const child of node.children.values()) collectNodes(child, into);
}

function isUnder(path: string, ancestor: string): boolean {
  return ancestor !== path && path.startsWith(ancestor);
}

function addRelated(
  start: TrieNode,
  primary: TrieNode,
  primaryPages: readonly FrozenPage[],
  tokens: Set<string>,
  budget: number,
  sections: PlanSection[],
): number {
  const titles = titleTokens(primaryPages);
  const tops = [...start.children.values()];
  const counts = new Map<string, number>();
  for (const top of tops) {
    for (const token of titleTokens(subtreePages(top))) counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  for (const [token, count] of counts) {
    if (count * 2 > tops.length) titles.delete(token);
  }
  if (titles.size === 0 || budget <= 0) return 0;
  const nodes: TrieNode[] = [];
  collectNodes(start, nodes);
  const candidates = nodes
    .map((node) => ({
      node,
      overlap: setOverlap(titles, titleTokens(subtreePages(node))),
      depth: segmentsOfPath(node.path).length,
    }))
    .filter(
      (candidate) =>
        candidate.overlap > 0 &&
        candidate.node !== primary &&
        !isUnder(candidate.node.path, primary.path) &&
        !isUnder(primary.path, candidate.node.path),
    );
  const kept = candidates.filter((candidate) => {
    const deeperTie = candidates.some(
      (other) => isUnder(other.node.path, candidate.node.path) && other.overlap >= candidate.overlap,
    );
    const widerAncestor = candidates.some(
      (other) => isUnder(candidate.node.path, other.node.path) && other.overlap > candidate.overlap,
    );
    return !deeperTie && !widerAncestor;
  });
  kept.sort(
    (left, right) =>
      right.overlap - left.overlap || right.depth - left.depth || left.node.path.localeCompare(right.node.path),
  );
  let spent = 0;
  for (const candidate of kept) {
    if (spent >= budget) break;
    spent += takeScored(candidate.node, tokens, budget - spent, sections, []);
  }
  return spent;
}

function referenceGroupNamed(prefix: string, names: NamedClasses): boolean {
  const segments = segmentsOfPath(prefix).map((segment) => segment.toLowerCase());
  if (segments.includes('glossary')) return names.glossary;
  return names.reference && segments.some((segment) => REFERENCE_SEGMENTS.has(segment));
}

function referencePrefix(url: string): string | null {
  const path = pathnameOf(url);
  if (!path) return null;
  const segments = segmentsOfPath(path);
  let last = -1;
  for (let index = 0; index < segments.length; index += 1) {
    if (REFERENCE_SEGMENTS.has(segments[index]!.toLowerCase())) last = index;
  }
  if (last < 0) return null;
  return `/${segments.slice(0, last + 1).join('/')}/`;
}

function groupReference(
  pages: readonly FrozenPage[],
  names: NamedClasses,
): { prefix: string; named: boolean; pages: PlanPage[] }[] {
  const groups = new Map<string, PlanPage[]>();
  const order: string[] = [];
  for (const page of pages) {
    const prefix = referencePrefix(page.url);
    if (!prefix) continue;
    const group = groups.get(prefix);
    const planPage = toPlanPage(page);
    if (group) group.push(planPage);
    else {
      groups.set(prefix, [planPage]);
      order.push(prefix);
    }
  }
  return order.map((prefix) => ({
    prefix,
    named: referenceGroupNamed(prefix, names),
    pages: groups.get(prefix) ?? [],
  }));
}

function unselectedReferenceEntries(sections: readonly PlanSection[]): { url: string; tokens: number }[] {
  const entries: { url: string; tokens: number }[] = [];
  for (const section of sections) {
    if (section.kind !== 'reference' || section.selected) continue;
    for (const page of section.pages) entries.push({ url: page.url, tokens: page.estimatedTokens });
  }
  return entries;
}

async function loadSeedIndex(seedUrl: string, locale: PlanLocale): Promise<readonly FrozenPage[]> {
  const identity = seedIdentity(seedUrl);
  if (!identity) return [];
  const key = `${identity.origin}\0${locale}\0${identity.path}`;
  const cached = cachedIndex(key);
  if (cached) return cached;
  let pages: FrozenPage[] = [];
  try {
    pages = await buildSeedIndex(identity, locale);
  } catch {
    pages = [];
  }
  const frozen = Object.freeze(pages.map((page) => Object.freeze(page)));
  storeIndex(key, frozen);
  return frozen;
}

export async function buildSeedIndex(identity: SeedIdentity, locale: PlanLocale): Promise<FrozenPage[]> {
  const llms = await readLlms(identity.origin);
  const sitemap = await readSitemap(identity.origin, locale);
  const fromSitemap = inScopePages(sitemap, llms.titles, identity, locale);
  if (fromSitemap.length > 0) return fromSitemap;
  const fromLlms = inScopePages(llms.links, llms.titles, identity, locale);
  if (fromLlms.length > 0) return fromLlms;
  const fromPage = (await readSeedPage(identity)).filter((page) => inSeed(page.url, identity));
  return localize(fromPage, locale);
}

function inScopePages(
  locs: readonly string[],
  titles: ReadonlyMap<string, { title: string; description: string }>,
  identity: SeedIdentity,
  locale: PlanLocale,
): FrozenPage[] {
  return localize(decorate(locs, titles).filter((page) => inSeed(page.url, identity)), locale);
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
  const budget: SitemapBudget = {
    bytes: utf8Bytes(fetched.body),
    locs: 0,
    children: 0,
    visited: new Set([matchKey(fetched.url)]),
  };
  return readSitemapDocument(fetched.body, fetched.url, origin, locale, budget);
}

type SitemapBudget = {
  bytes: number;
  locs: number;
  children: number;
  visited: Set<string>;
};

function utf8Bytes(body: string): number {
  return Buffer.byteLength(body, 'utf8');
}

async function readSitemapDocument(
  xml: string,
  baseUrl: string,
  origin: string,
  locale: PlanLocale,
  budget: SitemapBudget,
): Promise<string[]> {
  if (/<sitemapindex\b/i.test(xml)) return readSitemapIndex(xml, baseUrl, origin, locale, budget);
  const remaining = SITEMAP_LOC_MAX - budget.locs;
  if (remaining <= 0) return [];
  const entries = parseUrlset(xml, baseUrl, remaining);
  budget.locs += entries.length;
  const allowed = new Set(keepLocalePages(entries.map((entry) => entry.url), locale));
  return collapseCanonical(entries.filter((entry) => allowed.has(entry.url)));
}

async function readSitemapIndex(
  xml: string,
  baseUrl: string,
  origin: string,
  locale: PlanLocale,
  budget: SitemapBudget,
): Promise<string[]> {
  const originHost = new URL(origin).hostname;
  const urls: string[] = [];
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
    const key = matchKey(child);
    if (budget.visited.has(key)) continue;
    if (budget.children >= SITEMAP_CHILD_MAX) break;
    budget.visited.add(key);
    budget.children += 1;
    const remainingBytes = SITEMAP_MAX_BYTES - budget.bytes;
    if (remainingBytes <= 0) break;
    const fetched = await fetchIndexBody(child, remainingBytes);
    if (!fetched) continue;
    if (new URL(fetched.url).hostname !== originHost) continue;
    const fetchedKey = matchKey(fetched.url);
    if (fetchedKey !== key && budget.visited.has(fetchedKey)) continue;
    budget.visited.add(fetchedKey);
    budget.bytes += utf8Bytes(fetched.body);
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
