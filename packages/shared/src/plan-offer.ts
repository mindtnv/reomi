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

function canonicalPlanUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.hostname.length === 0) return null;
  url.hash = '';
  if (
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443')
  ) {
    url.port = '';
  }
  return url.href;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readSelections(value: readonly PlanSelection[] | undefined): PlanSelection[] {
  if (!value) return [];
  const selections: PlanSelection[] = [];
  for (const entry of value) {
    if (!record(entry) || typeof entry.moduleIndex !== 'number' || typeof entry.prefix !== 'string') continue;
    if (typeof entry.include !== 'boolean') continue;
    const pages = Array.isArray(entry.pages)
      ? entry.pages.flatMap((page) => {
          if (!record(page) || typeof page.url !== 'string' || typeof page.include !== 'boolean') return [];
          return [{ url: page.url, include: page.include }];
        })
      : undefined;
    selections.push({
      moduleIndex: entry.moduleIndex,
      prefix: entry.prefix,
      include: entry.include,
      ...(pages ? { pages } : {}),
    });
  }
  return selections;
}

function sectionIncluded(section: PlanSection, moduleIndex: number, selections: readonly PlanSelection[]): boolean {
  const relevant = selections.filter((selection) => selection.moduleIndex === moduleIndex && selection.prefix === section.prefix);
  const dropped = relevant.some((selection) => selection.include === false);
  if (section.kind === 'reference') return section.selected && !dropped;
  if (dropped) return false;
  if (relevant.some((selection) => selection.include)) return true;
  return section.selected;
}

function pageIncluded(url: string, moduleIndex: number, prefix: string, selections: readonly PlanSelection[]): boolean {
  const canon = canonicalPlanUrl(url);
  if (!canon) return false;
  for (const selection of selections) {
    if (selection.moduleIndex !== moduleIndex || selection.prefix !== prefix) continue;
    for (const page of selection.pages ?? []) {
      if (page.include === false && canonicalPlanUrl(page.url) === canon) return false;
    }
  }
  return true;
}

function readCatalog(value: unknown): ReferenceCatalog | null {
  if (!record(value) || value.v !== 1 || typeof value.remainingTokens !== 'number') return null;
  if (!Array.isArray(value.entries) || !Array.isArray(value.pending)) return null;
  const entries: ReferenceCatalog['entries'] = [];
  for (const entry of value.entries) {
    if (!record(entry) || typeof entry.url !== 'string' || typeof entry.tokens !== 'number') continue;
    const url = canonicalPlanUrl(entry.url);
    if (url) entries.push({ url, tokens: entry.tokens });
  }
  const pending: ReferenceCatalog['pending'] = [];
  for (const item of value.pending) {
    if (!record(item) || typeof item.sourceId !== 'string' || !Array.isArray(item.urls)) continue;
    const urls = item.urls.filter((url): url is string => typeof url === 'string');
    pending.push({ sourceId: item.sourceId, urls });
  }
  return { v: 1, remainingTokens: value.remainingTokens, entries, pending };
}

function modelModules(raw: unknown): { goal: string; level: string | null; modules: ExecPlanModule[] } | null {
  if (!record(raw) || typeof raw.goal !== 'string' || !Array.isArray(raw.modules) || raw.modules.length === 0) return null;
  let level: string | null = null;
  if (typeof raw.level === 'string') level = raw.level;
  else if (raw.level !== undefined && raw.level !== null) return null;
  const modules: ExecPlanModule[] = [];
  for (const entry of raw.modules) {
    if (!record(entry) || typeof entry.title !== 'string' || typeof entry.outcome !== 'string') return null;
    const prerequisiteIndexes = Array.isArray(entry.prerequisiteIndexes)
      ? entry.prerequisiteIndexes.filter((index): index is number => typeof index === 'number')
      : [];
    if (Array.isArray(entry.prerequisiteIndexes) && prerequisiteIndexes.length !== entry.prerequisiteIndexes.length) return null;
    const urls = Array.isArray(entry.urls) ? entry.urls.filter((url): url is string => typeof url === 'string') : [];
    if (Array.isArray(entry.urls) && urls.length !== entry.urls.length) return null;
    modules.push({
      title: entry.title,
      outcome: entry.outcome,
      prerequisiteIndexes,
      urls,
      pages: [],
      ignoredUrls: [],
      docVersion: null,
      catalog: null,
    });
  }
  return { goal: raw.goal, level, modules };
}

/**
 * Content sections stay selected unless a selection says include false.
 * include true on a reference section is ignored.
 * Page URLs come from the offer. Model-supplied page lists are ignored.
 * A missing offer yields empty pages and empty ignoredUrls.
 */
export function applyPlanSelections(
  modelArgs: unknown,
  offer: PlanOffer | undefined,
  selections: readonly PlanSelection[] | undefined,
): ExecPlan | null {
  const model = modelModules(modelArgs);
  if (!model) return null;
  const chosen = readSelections(selections);
  const modules = model.modules.map((module, index) => {
    const offered = offer?.modules[index];
    const pages: PlanPage[] = [];
    for (const section of offered?.sections ?? []) {
      if (!sectionIncluded(section, index, chosen)) continue;
      for (const page of section.pages) {
        if (!pageIncluded(page.url, index, section.prefix, chosen)) continue;
        const url = canonicalPlanUrl(page.url);
        if (!url) continue;
        pages.push({ url, title: page.title, estimatedTokens: page.estimatedTokens });
      }
    }
    const ignoredUrls = (offered?.ignoredUrls ?? []).flatMap((url) => {
      const canon = canonicalPlanUrl(url);
      return canon ? [canon] : [];
    });
    return {
      ...module,
      pages,
      ignoredUrls,
      docVersion: offered?.docVersion ?? null,
      catalog: offered ? readCatalog(offered.catalog) : null,
    };
  });
  return { goal: model.goal, level: model.level, modules };
}

/** Boundary parse for execute. Drops a page URL that is not http(s). */
export function readKeptPages(raw: unknown): ExecPlan | null {
  const model = modelModules(raw);
  if (!model || !record(raw) || !Array.isArray(raw.modules)) return null;
  const modules = model.modules.map((module, index) => {
    const source = raw.modules[index];
    if (!record(source)) return module;
    const pages: PlanPage[] = [];
    if (Array.isArray(source.pages)) {
      for (const entry of source.pages) {
        if (!record(entry) || typeof entry.url !== 'string') continue;
        const url = canonicalPlanUrl(entry.url);
        if (!url) continue;
        pages.push({
          url,
          title: typeof entry.title === 'string' ? entry.title : '',
          estimatedTokens: typeof entry.estimatedTokens === 'number' && Number.isFinite(entry.estimatedTokens) ? entry.estimatedTokens : 0,
        });
      }
    }
    const ignoredUrls = Array.isArray(source.ignoredUrls)
      ? source.ignoredUrls.flatMap((url) => {
          if (typeof url !== 'string') return [];
          const canon = canonicalPlanUrl(url);
          return canon ? [canon] : [];
        })
      : [];
    const docVersion = typeof source.docVersion === 'string' || source.docVersion === null ? source.docVersion : null;
    return {
      ...module,
      pages,
      ignoredUrls,
      docVersion,
      catalog: readCatalog(source.catalog),
    };
  });
  return { goal: model.goal, level: model.level, modules };
}

/**
 * Prefix limiters arrive in ignoredUrls. A leaf stays.
 */
export function handUrls(module: ExecPlanModule | undefined): string[] {
  if (!module) return [];
  const ignored = new Set(
    module.ignoredUrls.flatMap((url) => {
      const canon = canonicalPlanUrl(url);
      return canon ? [canon] : [];
    }),
  );
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const raw of module.urls) {
    const url = canonicalPlanUrl(raw);
    if (!url || seen.has(url) || ignored.has(url) || isDiscoverySeed(url)) continue;
    seen.add(url);
    kept.push(url);
  }
  return kept;
}

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
