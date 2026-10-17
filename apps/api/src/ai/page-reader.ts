// Page reader — the `fetch_page` tool's data source (deep research).
//
// Two backends behind one interface (mirrors web-search.ts):
//   • ExaPageReader    — Exa /contents (EXA_API_KEY). Exa crawls the page on
//     THEIR infrastructure and returns clean text + links, so the API server
//     makes no direct outbound fetch to arbitrary URLs (no SSRF surface).
//     Preferred when the key is set.
//   • DirectPageReader — a hand-rolled fetch + HTML→text extractor, used when
//     no Exa key is configured. SSRF-guarded: http(s) only, no userinfo,
//     blocked internal hostnames, private/reserved IP ranges rejected BOTH as
//     literals and after DNS resolution, redirects re-validated per hop, hard
//     timeout + byte cap + content-type allow-list. Known accepted v1 gap: the
//     OS may re-resolve DNS between our check and the fetch (TOCTOU /
//     rebinding) — the Exa path avoids the entire class.
//
// Readers MAY throw; the `fetch_page` TOOL catches and returns `{ok:false}`
// so nothing throws into the agent loop (the SSE single-error invariant).
//
// A small in-memory TTL cache fronts both backends (`readPageCached`) so the
// tool's offset-pagination over a long page doesn't re-crawl (or re-bill Exa)
// per slice.

import { lookup as dnsLookup } from 'node:dns/promises';
import type { Logger } from 'pino';
import { env, fetchPageEnabled } from '../env.ts';
import { rootLogger, safeLogUrl } from '../logger.ts';

export interface PageContent {
  /** Final URL (after redirects / as reported by the backend). */
  url: string;
  title?: string;
  /** Readable plain text of the page (already whitespace-collapsed). */
  text: string;
  /** Absolute http(s) links found on the page (deduped, capped). */
  links: string[];
  /**
   * Cover image candidate (og:image) — absolute http(s) URL, when the page
   * declares one (L3 covers, §8.2 URL path). The ingest worker downloads it
   * (SSRF-guarded, ≤2 MB) into a media object. Optional; absent ⇒ no cover.
   */
  imageUrl?: string;
}

export interface PageReadOpts {
  signal?: AbortSignal;
  log?: Logger;
}

export interface PageReader {
  read(url: string, opts?: PageReadOpts): Promise<PageContent>;
}

const PAGE_LINKS_MAX = 20;
/** Exa /contents `text.maxCharacters` hard cap is 10000. */
const EXA_TEXT_MAX_CHARS = 10000;

// ── SSRF guards (DirectPageReader) ────────────────────────────────────────────

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

function isPrivateIpV4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  // Malformed quad → treat as private (fail closed).
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true;
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIpV6(ip: string): boolean {
  const s = ip.toLowerCase();
  if (s === '::' || s === '::1') return true;
  if (s.startsWith('fc') || s.startsWith('fd')) return true; // unique-local fc00::/7
  if (/^fe[89ab]/.test(s)) return true; // link-local fe80::/10
  // IPv4-mapped: dotted form (DNS results) AND the hex form the WHATWG URL
  // parser canonicalizes literals to ([::ffff:10.0.0.1] → ::ffff:a00:1).
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) return isPrivateIpV4(mapped[1]!);
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1]!, 16);
    const lo = Number.parseInt(mappedHex[2]!, 16);
    return isPrivateIpV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return false;
}

function isPrivateIp(address: string, family: number): boolean {
  return family === 6 || address.includes(':')
    ? isPrivateIpV6(address)
    : isPrivateIpV4(address);
}

/** Parse + statically validate a URL: http(s) only, no userinfo, sane host.
 *  Exported so the cover-image downloader (L3) reuses the SAME static guard. */
export function validatePageUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('invalid URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`only http(s) URLs can be fetched (got ${u.protocol})`);
  }
  if (u.username || u.password) {
    throw new Error('URLs with embedded credentials are not allowed');
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host.length === 0) throw new Error('URL has no host');
  if (host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new Error(`host "${host}" is not allowed`);
  }
  return u;
}

type LookupFn = (
  hostname: string,
  opts: { all: true },
) => Promise<{ address: string; family: number }[]>;

let lookupImpl: LookupFn = (hostname, opts) => dnsLookup(hostname, opts);

/** Reject hosts that ARE private-IP literals or RESOLVE to private addresses.
 *  Exported so the cover-image downloader (L3) reuses the SAME DNS/IP guard. */
export async function assertPublicHost(u: URL): Promise<void> {
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const isV4Literal = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
  const isV6Literal = host.includes(':');
  if (isV4Literal || isV6Literal) {
    if (isPrivateIp(host, isV6Literal ? 6 : 4)) {
      throw new Error(`address "${host}" is not allowed`);
    }
    return;
  }
  let addrs: { address: string; family: number }[];
  try {
    addrs = await lookupImpl(host, { all: true });
  } catch {
    throw new Error(`cannot resolve host "${host}"`);
  }
  if (addrs.length === 0) throw new Error(`cannot resolve host "${host}"`);
  for (const a of addrs) {
    if (isPrivateIp(a.address, a.family)) {
      throw new Error(`host "${host}" resolves to a private address`);
    }
  }
}

// ── HTML → text extraction (DirectPageReader) ─────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  laquo: '«',
  raquo: '»',
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : '';
    })
    .replace(/&([a-z]+);/gi, (m, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

export function collapseText(s: string): string {
  return s
    .replace(/[ \t ]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Extract a readable text + title + absolute links from raw HTML. Hand-rolled
 *  (no HTML-parser dep) — good enough for documentation pages; Exa is the
 *  high-fidelity path. */
export function htmlToPage(html: string, baseUrl: string): PageContent {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch
    ? collapseText(decodeEntities(titleMatch[1]!)).replace(/\n+/g, ' ').slice(0, 200) || undefined
    : undefined;

  // Open-Graph cover candidate: <meta property="og:image" content="…"> (also
  // accept name="og:image" and twitter:image). Resolve relative → absolute and
  // keep only http(s). The order of `property`/`content` attrs varies, so match
  // a <meta …> tag carrying BOTH (either ordering).
  const imageUrl = extractOgImage(html, baseUrl);

  // Collect absolute http(s) links BEFORE stripping tags.
  const links: string[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const raw = (m[1] ?? m[2] ?? '').trim();
    if (!raw || raw.startsWith('#') || raw.startsWith('javascript:') || raw.startsWith('mailto:')) {
      continue;
    }
    try {
      const abs = new URL(raw, baseUrl);
      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') continue;
      abs.hash = '';
      const href = abs.href;
      if (!seen.has(href)) {
        seen.add(href);
        links.push(href);
        if (links.length >= PAGE_LINKS_MAX) break;
      }
    } catch {
      // unresolvable href — skip
    }
  }

  let s = html
    // Drop non-content subtrees wholesale.
    .replace(/<(script|style|noscript|template|svg|head|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Line breaks for structural tags so the text keeps its shape.
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|section|article|li|tr|table|ul|ol|blockquote|pre|h[1-6])>/gi, '\n')
    .replace(/<(h[1-6])\b[^>]*>/gi, '\n\n')
    // Everything else: strip the tag, keep the text.
    .replace(/<[^>]+>/g, ' ');
  s = collapseText(decodeEntities(s));

  return { url: baseUrl, title, text: s, links, imageUrl };
}

/**
 * Pull the og:image (or twitter:image) URL from raw HTML and resolve it against
 * `baseUrl`. Returns an absolute http(s) URL or `undefined`. Tolerates either
 * attribute ordering (`property` before/after `content`) and single/double
 * quotes. Pure + exported for unit testing. */
export function extractOgImage(html: string, baseUrl: string): string | undefined {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const propMatch = /\b(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag);
    const prop = propMatch?.[1]?.toLowerCase();
    if (prop !== 'og:image' && prop !== 'og:image:url' && prop !== 'twitter:image') continue;
    const contentMatch = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag);
    const raw = contentMatch?.[1]?.trim();
    if (!raw) continue;
    try {
      const abs = new URL(decodeEntities(raw), baseUrl);
      if (abs.protocol === 'http:' || abs.protocol === 'https:') return abs.href;
    } catch {
      /* unresolvable — try the next meta */
    }
  }
  return undefined;
}

// ── DirectPageReader ──────────────────────────────────────────────────────────

const ALLOWED_CONTENT_TYPES = [
  'text/html',
  'application/xhtml+xml',
  'text/plain',
  'text/markdown',
  'application/json',
];

// Plain call signature (NOT `typeof fetch` — Bun's fetch type carries static
// members like `preconnect` that a test fake shouldn't have to implement).
type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
let directFetchImpl: FetchFn = (input, init) => fetch(input, init);

/** Read a response body up to `cap` bytes (truncates, never buffers more). */
async function readBodyCapped(res: Response, cap: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, cap);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
      if (total >= cap) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  }
  const buf = new Uint8Array(Math.min(total, cap));
  let off = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, buf.length - off);
    if (take <= 0) break;
    buf.set(c.subarray(0, take), off);
    off += take;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(buf);
}

async function releaseResponse(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {});
}

/**
 * Liveness check for a suggested URL. HEAD, then GET when HEAD is not a 2xx.
 * Uses the same static and DNS guards as DirectPageReader, follows redirects
 * manually, and treats any final 2xx as live. A private hop or a network
 * failure is not live. The body is cancelled; this does not read or store a page.
 */
export async function probePageUrl(raw: string): Promise<boolean> {
  let current: URL;
  try {
    current = validatePageUrl(raw);
    await assertPublicHost(current);
  } catch {
    return false;
  }
  if (await probePageMethod(current, 'HEAD')) return true;
  return probePageMethod(current, 'GET');
}

export type IndexFetchResult = {
  url: string;
  body: string;
  contentType: string;
};

const INDEX_CONTENT_MARKERS = ['xml', 'text/plain', 'text/markdown', 'text/html', 'markdown'];

function indexContentAllowed(contentType: string): boolean {
  if (contentType.length === 0) return true;
  return INDEX_CONTENT_MARKERS.some((marker) => contentType.includes(marker));
}

/**
 * Raw index body. XML is allowed and the fetch_page 2MB cap is not this cap.
 * A private, off-host, or failed hop returns null. This does not call DirectPageReader.read.
 */
export async function fetchIndexBody(url: string, maxBytes: number): Promise<IndexFetchResult | null> {
  let current: URL;
  try {
    current = validatePageUrl(url);
    await assertPublicHost(current);
  } catch {
    return null;
  }
  const startHost = current.hostname;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.ai.FETCH_PAGE_TIMEOUT_MS);
  try {
    const maxRedirects = 3;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const res = await directFetchImpl(current.href, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'user-agent': 'ReomiAgent/1.0 (study assistant; +https://github.com)',
          accept: 'application/xml,text/xml,text/plain,text/markdown,text/html;q=0.9,*/*;q=0.5',
        },
        signal: controller.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        await releaseResponse(res);
        if (!loc || hop === maxRedirects) return null;
        let next: URL;
        try {
          next = validatePageUrl(new URL(loc, current).href);
        } catch {
          return null;
        }
        if (next.hostname !== startHost) return null;
        try {
          await assertPublicHost(next);
        } catch {
          return null;
        }
        current = next;
        continue;
      }
      if (!res.ok) {
        await releaseResponse(res);
        return null;
      }
      const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
      if (!indexContentAllowed(contentType)) {
        await releaseResponse(res);
        return null;
      }
      const body = await readBodyCapped(res, Math.max(0, maxBytes));
      return { url: current.href, body, contentType };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function probePageMethod(start: URL, method: 'HEAD' | 'GET'): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.ai.FETCH_PAGE_TIMEOUT_MS);
  try {
    let current = start;
    const MAX_REDIRECTS = 3;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await directFetchImpl(current.href, {
        method,
        redirect: 'manual',
        headers: {
          'user-agent': 'ReomiAgent/1.0 (study assistant; +https://github.com)',
          accept: '*/*',
        },
        signal: controller.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        await releaseResponse(res);
        if (!loc) return false;
        current = validatePageUrl(new URL(loc, current).href);
        await assertPublicHost(current);
        continue;
      }
      const ok = res.ok;
      await releaseResponse(res);
      return ok;
    }
    return false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export class DirectPageReader implements PageReader {
  async read(url: string, opts: PageReadOpts = {}): Promise<PageContent> {
    let current = validatePageUrl(url);
    await assertPublicHost(current);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), env.ai.FETCH_PAGE_TIMEOUT_MS);
    const onExternalAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onExternalAbort, { once: true });
    try {
      const MAX_REDIRECTS = 3;
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const res = await directFetchImpl(current.href, {
          method: 'GET',
          // Manual redirects: every hop's target is re-validated (a public URL
          // 302-ing to http://169.254.169.254/ must not be followed).
          redirect: 'manual',
          headers: {
            'user-agent': 'ReomiAgent/1.0 (study assistant; +https://github.com)',
            accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
          },
          signal: controller.signal,
        });

        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get('location');
          if (!loc) throw new Error(`redirect (HTTP ${res.status}) without a Location header`);
          current = validatePageUrl(new URL(loc, current).href);
          await assertPublicHost(current);
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${safeLogUrl(current.href)}`);

        const ct = (res.headers.get('content-type') ?? '').toLowerCase();
        if (ct && !ALLOWED_CONTENT_TYPES.some((t) => ct.includes(t))) {
          throw new Error(`unsupported content type "${ct.split(';')[0]}" (text pages only)`);
        }
        const raw = await readBodyCapped(res, env.ai.FETCH_PAGE_MAX_BYTES);
        const looksHtml = ct.includes('html') || /<html[\s>]|<!doctype html/i.test(raw.slice(0, 1024));
        if (looksHtml) return htmlToPage(raw, current.href);
        return { url: current.href, title: undefined, text: collapseText(raw), links: [] };
      }
      throw new Error('too many redirects');
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}

// ── ExaPageReader ─────────────────────────────────────────────────────────────

/** Subset of the Exa /contents response we map from. */
interface ExaContentsResponse {
  results?: {
    url?: string;
    title?: string | null;
    text?: string;
    image?: string | null;
    extras?: { links?: unknown[] };
  }[];
  statuses?: { status?: string; error?: { tag?: string; httpStatusCode?: number | null } }[];
}

const EXA_CONTENTS_ENDPOINT = 'https://api.exa.ai/contents';

export class ExaPageReader implements PageReader {
  constructor(private readonly apiKey: string) {}

  async read(url: string, opts: PageReadOpts = {}): Promise<PageContent> {
    // Static validation still applies (scheme/userinfo) — but no DNS/IP guard
    // is needed: Exa fetches the page from THEIR network, not ours.
    const u = validatePageUrl(url);

    const controller = new AbortController();
    // Exa live-crawls within `livecrawlTimeout`; give the HTTP call headroom.
    const timer = setTimeout(
      () => controller.abort(),
      env.ai.FETCH_PAGE_TIMEOUT_MS + 5000,
    );
    const onExternalAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onExternalAbort, { once: true });
    try {
      const res = await directFetchImpl(EXA_CONTENTS_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey },
        body: JSON.stringify({
          urls: [u.href],
          text: { maxCharacters: EXA_TEXT_MAX_CHARS },
          extras: { links: PAGE_LINKS_MAX },
          livecrawlTimeout: env.ai.FETCH_PAGE_TIMEOUT_MS,
        }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`exa contents HTTP ${res.status}`);
      const json = (await res.json()) as ExaContentsResponse;

      const status = json.statuses?.[0];
      if (status?.status === 'error') {
        throw new Error(`exa could not fetch the page (${status.error?.tag ?? 'error'})`);
      }
      const r = json.results?.[0];
      if (!r || typeof r.text !== 'string' || r.text.length === 0) {
        throw new Error('exa returned no readable text for this page');
      }
      const links = (r.extras?.links ?? [])
        .map((l) =>
          typeof l === 'string'
            ? l
            : l && typeof l === 'object' && typeof (l as { url?: unknown }).url === 'string'
              ? (l as { url: string }).url
              : '',
        )
        .filter((l) => /^https?:\/\//i.test(l))
        .slice(0, PAGE_LINKS_MAX);
      const imageUrl =
        typeof r.image === 'string' && /^https?:\/\//i.test(r.image) ? r.image : undefined;
      return {
        url: r.url ?? u.href,
        title: r.title ?? undefined,
        text: collapseText(r.text),
        links,
        imageUrl,
      };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onExternalAbort);
    }
  }
}

// ── Reader selection + test seams ─────────────────────────────────────────────

let injectedReader: PageReader | null = null;
let injectedReaderSet = false;

/**
 * Inject a fake reader for tests (mirrors `__setWebSearchProviderForTests`).
 * Pass a reader to flip `fetch_page` on regardless of env; pass `null` to force
 * the tool absent. Restore with `__resetPageReaderForTests` (also clears the
 * page cache so tests never see each other's pages).
 */
export function __setPageReaderForTests(reader: PageReader | null): void {
  injectedReader = reader;
  injectedReaderSet = true;
  pageCache.clear();
}

export function __resetPageReaderForTests(): void {
  injectedReader = null;
  injectedReaderSet = false;
  pageCache.clear();
}

/** Inject fetch/DNS for DirectPageReader/ExaPageReader unit tests. */
export function __setPageFetchForTests(fn: FetchFn | null): void {
  directFetchImpl = fn ?? ((...args) => fetch(...args));
}
export function __setDnsLookupForTests(fn: LookupFn | null): void {
  lookupImpl = fn ?? ((hostname, opts) => dnsLookup(hostname, opts));
}

/**
 * Return the active page reader, or `null` when `fetch_page` is disabled
 * (`CHAT_FETCH_PAGE='false'`). Exa (EXA_API_KEY) preferred; the direct
 * SSRF-guarded fetcher is the keyless fallback.
 */
export function getPageReader(): PageReader | null {
  if (injectedReaderSet) return injectedReader;
  if (!fetchPageEnabled) return null;
  if (env.ai.EXA_API_KEY) return new ExaPageReader(env.ai.EXA_API_KEY);
  return new DirectPageReader();
}

/**
 * Effective fetch_page switch: env flag OR an injected fake reader — so a test
 * reader flips the tool on. `buildToolRegistry` reads this to decide whether to
 * offer `fetch_page`.
 */
export function isFetchPageEnabled(): boolean {
  if (injectedReaderSet) return injectedReader !== null;
  return fetchPageEnabled;
}

// ── Page cache (offset pagination must not re-crawl / re-bill per slice) ─────

const PAGE_CACHE_TTL_MS = 15 * 60_000;
const PAGE_CACHE_MAX = 32;
const pageCache = new Map<string, { page: PageContent; at: number }>();

/** Cached read-through: the tool's slice calls hit the same crawl result. */
export async function readPageCached(url: string, opts: PageReadOpts = {}): Promise<PageContent> {
  const log = opts.log ?? rootLogger;
  const hit = pageCache.get(url);
  if (hit && Date.now() - hit.at < PAGE_CACHE_TTL_MS) return hit.page;

  const reader = getPageReader();
  if (!reader) throw new Error('fetch_page is not configured');
  const page = await reader.read(url, opts);
  log.debug(
    { url: safeLogUrl(url), chars: page.text.length, links: page.links.length },
    'ai.fetch_page.read',
  );

  if (pageCache.size >= PAGE_CACHE_MAX) {
    // Drop the oldest insertion (Map preserves insertion order).
    const oldest = pageCache.keys().next().value;
    if (oldest !== undefined) pageCache.delete(oldest);
  }
  pageCache.delete(url);
  pageCache.set(url, { page, at: Date.now() });
  return page;
}
