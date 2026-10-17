const DOCS_ROOTS = new Set(['docs', 'documentation']);
const VERSION_WORDS = new Set(['stable', 'latest', 'current', 'next']);

const LOCALE_TAGS = new Set([
  'ru',
  'zh',
  'zh-cn',
  'zh-tw',
  'zh-hk',
  'ja',
  'ko',
  'de',
  'fr',
  'es',
  'pt',
  'pt-br',
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
]);

function isDocsRoot(segment: string): boolean {
  return DOCS_ROOTS.has(segment.toLowerCase());
}

function isVersionLabel(segment: string): boolean {
  const value = segment.toLowerCase();
  if (VERSION_WORDS.has(value)) return true;
  if (/^v?\d+(?:\.\d+)*\.x$/i.test(value)) return true;
  if (/^v?\d+(?:\.\d+)*$/i.test(value)) return true;
  if (/^v\d+-\d+$/i.test(value)) return true;
  return false;
}

function pathnameOf(url: string): string | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.pathname;
  } catch {
    if (!trimmed.startsWith('/')) return null;
    try {
      return new URL(trimmed, 'https://seed.invalid').pathname;
    } catch {
      return null;
    }
  }
}

function segmentsOf(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

/** Path `/`, `/docs/`, `/documentation/`, or only version labels and those names. */
export function isDiscoverySeed(url: string): boolean {
  const pathname = pathnameOf(url);
  if (pathname === null) return false;
  const segments = segmentsOf(pathname);
  if (segments.length === 0) return true;
  return segments.every((segment) => isDocsRoot(segment) || isVersionLabel(segment));
}

/** Host `v<major>-<minor>.docs.*` stores `v{major}.{minor}`. Every other host stores null. */
export function storedDocVersion(hostname: string): string | null {
  const match = /^v(\d+)-(\d+)\.docs\./i.exec(hostname.trim().toLowerCase());
  if (!match) return null;
  return `v${match[1]}.${match[2]}`;
}

function canonicalVersion(label: string): string {
  let value = label.toLowerCase();
  if (/^v\d/.test(value)) value = value.slice(1);
  if (/^\d+-\d+$/.test(value)) value = value.replace('-', '.');
  return value;
}

function versionTier(label: string): { tier: number; parts: number[] } {
  const canon = canonicalVersion(label);
  if (canon === 'stable') return { tier: 0, parts: [] };
  if (canon === 'latest') return { tier: 1, parts: [] };
  if (canon === 'current') return { tier: 2, parts: [] };
  if (canon === 'next') return { tier: 4, parts: [] };
  const numeric = canon.replace(/\.x$/, '');
  if (/^\d+(?:\.\d+)*$/.test(numeric)) {
    return { tier: 3, parts: numeric.split('.').map((part) => Number(part)) };
  }
  return { tier: 6, parts: [] };
}

function bestTier(labels: readonly string[]): { tier: number; parts: number[] } {
  let best = versionTier(labels[0] ?? '');
  for (const label of labels.slice(1)) {
    const next = versionTier(label);
    if (next.tier < best.tier) best = next;
    else if (next.tier === best.tier && next.tier === 3 && numericGreater(next.parts, best.parts)) best = next;
  }
  return best;
}

function numericGreater(left: readonly number[], right: readonly number[]): boolean {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a > b;
  }
  return false;
}

function versionBetter(left: readonly string[], right: readonly string[]): boolean {
  const a = bestTier(left);
  const b = bestTier(right);
  if (a.tier !== b.tier) return a.tier < b.tier;
  if (a.tier === 3) return numericGreater(a.parts, b.parts);
  return false;
}

function versionKey(url: string): { key: string; versions: string[] } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const segments = segmentsOf(parsed.pathname);
  const versions: string[] = [];
  const rest: string[] = [];
  for (const segment of segments) {
    if (!isDocsRoot(segment) && isVersionLabel(segment)) versions.push(segment);
    else rest.push(segment.toLowerCase());
  }
  return { key: `${parsed.hostname.toLowerCase()}/${rest.join('/')}`, versions };
}

/**
 * One page per stripped path. Preference is stable, latest, current, highest
 * numeric, then next. A named version on that same path wins.
 */
export function preferDocVersions(urls: readonly string[], named: string | null): string[] {
  const groups = new Map<string, { url: string; versions: string[] }[]>();
  const order: string[] = [];
  for (const url of urls) {
    const parsed = versionKey(url);
    if (!parsed) continue;
    const group = groups.get(parsed.key);
    if (group) group.push({ url, versions: parsed.versions });
    else {
      groups.set(parsed.key, [{ url, versions: parsed.versions }]);
      order.push(parsed.key);
    }
  }

  const namedCanon = named ? canonicalVersion(named) : null;
  const kept: string[] = [];
  for (const key of order) {
    const items = groups.get(key) ?? [];
    const versioned = items.filter((item) => item.versions.length > 0);
    if (versioned.length === 0) {
      const first = items[0];
      if (first) kept.push(first.url);
      continue;
    }
    let pool = versioned;
    if (namedCanon) {
      const matched = versioned.filter((item) =>
        item.versions.some((label) => canonicalVersion(label) === namedCanon),
      );
      if (matched.length > 0) pool = matched;
    }
    let best = pool[0]!;
    for (const item of pool.slice(1)) {
      if (versionBetter(item.versions, best.versions)) best = item;
    }
    kept.push(best.url);
  }
  return kept;
}

/** A numeric version in the text, or an explicit "version stable|latest|current|next". */
export function namedDocVersion(text: string): string | null {
  const numeric = text.match(/\bv\d+(?:[.-]\d+)+\b|\bv\d+\b|\b\d+\.\d+(?:\.\d+)*\b/i);
  if (numeric) return numeric[0];
  const word = text.match(/\b(?:version|версия)\s+(stable|latest|current|next)\b/i);
  if (word?.[1]) return word[1].toLowerCase();
  return null;
}

function pageLocale(url: string): string {
  const pathname = pathnameOf(url);
  if (!pathname) return 'en';
  const first = segmentsOf(pathname)[0]?.toLowerCase() ?? '';
  if (first === 'en' || first.startsWith('en-')) return 'en';
  if (first === 'ru' || first.startsWith('ru-')) return 'ru';
  if (LOCALE_TAGS.has(first)) return first;
  return 'en';
}

export type PlanPage = {
  url: string;
  title: string;
  estimatedTokens: number;
};

export type PlanSectionKind = 'content' | 'reference';

export type PlanSectionSummary = {
  prefix: string;
  kind: PlanSectionKind;
  selected: boolean;
  pageCount: number;
  estimatedTokens: number;
};

export type PlanSection = {
  prefix: string;
  kind: PlanSectionKind;
  selected: boolean;
  pages: PlanPage[];
};

export type ReferenceCatalog = {
  v: 1;
  remainingTokens: number;
  entries: { url: string; tokens: number }[];
  pending: { sourceId: string; urls: string[] }[];
};

export type PlanOfferModule = {
  sections: PlanSection[];
  ignoredUrls: string[];
  docVersion: string | null;
  catalog: ReferenceCatalog;
  needsPages: boolean;
};

export type PlanOffer = {
  modules: PlanOfferModule[];
};

export type PlanSelection = {
  moduleIndex: number;
  prefix: string;
  include: boolean;
  pages?: { url: string; include: boolean }[];
};

export type SummarizedModule = {
  title: string;
  outcome: string;
  prerequisiteIndexes: number[];
  urls: string[];
  sections: PlanSectionSummary[];
  needsPages: boolean;
};

export type PlanSummary = {
  modules: SummarizedModule[];
};

export type ExecPlanModule = {
  title: string;
  outcome: string;
  prerequisiteIndexes: number[];
  urls: string[];
  pages: PlanPage[];
  ignoredUrls: string[];
  docVersion: string | null;
  catalog: ReferenceCatalog | null;
};

export type ExecPlan = {
  goal: string;
  level: string | null;
  modules: ExecPlanModule[];
};

/** A catalog URL is returned only when a fetched page links to it and the remaining tokens cover it. */
export function referenceLinksToAdd(
  hrefs: readonly string[],
  catalog: ReferenceCatalog,
): string[] {
  const entries = new Map<string, number>();
  for (const entry of catalog.entries) {
    if (!entries.has(entry.url)) entries.set(entry.url, entry.tokens);
  }
  const added: string[] = [];
  const seen = new Set<string>();
  let remaining = catalog.remainingTokens;
  for (const href of hrefs) {
    if (seen.has(href)) continue;
    const tokens = entries.get(href);
    if (tokens === undefined || tokens > remaining) continue;
    seen.add(href);
    added.push(href);
    remaining -= tokens;
  }
  return added;
}

/** `en` keeps unprefixed English. `ru` keeps `/ru/` when any exist, otherwise English. */
export function keepLocalePages(urls: readonly string[], locale: 'en' | 'ru'): string[] {
  if (locale === 'ru' && urls.some((url) => pageLocale(url) === 'ru')) {
    return urls.filter((url) => pageLocale(url) === 'ru');
  }
  return urls.filter((url) => pageLocale(url) === 'en');
}
