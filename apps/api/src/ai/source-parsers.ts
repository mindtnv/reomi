// Source parsers (NotebookLM M1, T4). One dispatcher `parseSource` that turns a
// raw source (uploaded PDF/EPUB bytes, a URL, or inline text) into ordered
// `SourceUnit[]` (text + page/heading) for the document chunker.
//
// Heavy parser deps (`unpdf`, `fflate`) are LAZILY `await import`-ed INSIDE the
// branch that needs them — never top-level — so the web bundle never pulls them
// and an unconfigured-AI deploy pays no import cost. Both deps live in apps/api
// only (added to apps/api/package.json).
//
// URL + text reuse page-reader.ts (`readPageCached` + the same `htmlToPage` /
// `collapseText` extraction the deep-research fetch_page tool uses), so a URL
// source goes through the exact same Exa-preferred / SSRF-guarded path.
//
// Failures throw a typed `SourceParseError` carrying an `IngestErrorCode` — the
// ingest worker maps it onto `sources.error_code` (a machine code, never prose).
// An empty parse result is itself an error (`empty_source`).
//
// Test seams mirror page-reader's `__setPageReaderForTests`: inject a fake PDF
// extractor / EPUB reader so tests drive the dispatcher without real binary
// fixtures. The URL path is already injectable via `__setPageReaderForTests`.

import type { IngestErrorCode, SourceKind, SourceUnit } from '@reomi/shared';
import { env } from '../env.ts';
import { collapseText, htmlToPage, readPageCached } from './page-reader.ts';
import { extractEpubCover, type CoverImage } from './source-cover.ts';

/** A parse failure carrying the machine error code the worker stamps on the row. */
export class SourceParseError extends Error {
  constructor(
    readonly code: IngestErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'SourceParseError';
  }
}

export interface ParseSourceInput {
  kind: SourceKind;
  /** pdf/epub: the uploaded bytes. */
  bytes?: Uint8Array;
  /** url: the source URL. */
  url?: string;
  /** text: the inline text. */
  text?: string;
}

export interface ParseSourceResult {
  units: SourceUnit[];
  /** EPUB: the cover image bytes extracted from the archive (L3, §8.2). */
  cover?: CoverImage;
  /** URL: an og:image candidate URL the worker downloads as a cover (L3). */
  imageUrl?: string;
}

// ── Test seams ────────────────────────────────────────────────────────────────
// Inject fakes so tests don't need real PDF/EPUB binaries. `null` (default) uses
// the real lazy-imported parser.

/** Per-page text extractor (PDF). Returns one string per page (1-based order). */
type PdfExtractor = (bytes: Uint8Array) => Promise<string[]>;
/** EPUB → ordered chapters (spine order) of `{ text, heading? }`. */
type EpubReader = (bytes: Uint8Array) => Promise<{ text: string; heading?: string }[]>;

let pdfExtractor: PdfExtractor | null = null;
let epubReader: EpubReader | null = null;

export function __setPdfExtractorForTests(fn: PdfExtractor | null): void {
  pdfExtractor = fn;
}
export function __setEpubReaderForTests(fn: EpubReader | null): void {
  epubReader = fn;
}

// ── Dispatcher ──────────────────────────────────────────────────────────────

export async function parseSource(input: ParseSourceInput): Promise<ParseSourceResult> {
  let units: SourceUnit[];
  let cover: CoverImage | undefined;
  let imageUrl: string | undefined;
  switch (input.kind) {
    case 'pdf':
      units = await parsePdf(requireBytes(input.bytes));
      break;
    case 'epub': {
      const res = await parseEpub(requireBytes(input.bytes));
      units = res.units;
      cover = res.cover;
      break;
    }
    case 'url': {
      const res = await parseUrl(input.url ?? '');
      units = res.units;
      imageUrl = res.imageUrl;
      break;
    }
    case 'text':
      units = parseText(input.text ?? '');
      break;
    default:
      throw new SourceParseError('unsupported_mime', `unknown source kind "${input.kind}"`);
  }

  // Drop empty units; an all-empty parse is `empty_source` (not a crash).
  units = units.filter((u) => u.text.trim().length > 0);
  if (units.length === 0) throw new SourceParseError('empty_source');
  return { units, cover, imageUrl };
}

function requireBytes(bytes: Uint8Array | undefined): Uint8Array {
  if (!bytes || bytes.byteLength === 0) throw new SourceParseError('empty_source', 'no bytes');
  return bytes;
}

// ── PDF (unpdf, lazy) — one SourceUnit per page ──────────────────────────────

async function parsePdf(bytes: Uint8Array): Promise<SourceUnit[]> {
  let pages: string[];
  try {
    if (pdfExtractor) {
      pages = await pdfExtractor(bytes);
    } else {
      const { extractText } = await import('unpdf');
      // mergePages:false → { totalPages, text: string[] } (one entry per page).
      // unpdf wants a fresh ArrayBuffer view of the bytes.
      const data = new Uint8Array(bytes);
      const res = await extractText(data, { mergePages: false });
      pages = res.text;
    }
  } catch (err) {
    if (err instanceof SourceParseError) throw err;
    throw new SourceParseError('parse_failed', `pdf parse failed: ${String(err)}`);
  }
  return pages.map((text, i) => ({ text: collapseText(text ?? ''), page: i + 1 }));
}

// ── EPUB (fflate, lazy) — one SourceUnit per chapter, with heading ────────────

async function parseEpub(bytes: Uint8Array): Promise<{ units: SourceUnit[]; cover?: CoverImage }> {
  let chapters: { text: string; heading?: string }[];
  let cover: CoverImage | undefined;
  try {
    if (epubReader) {
      // Test seam: no real zip, so no cover extraction.
      chapters = await epubReader(bytes);
    } else {
      const res = await readEpub(bytes);
      chapters = res.chapters;
      cover = res.cover;
    }
  } catch (err) {
    if (err instanceof SourceParseError) throw err;
    throw new SourceParseError('parse_failed', `epub parse failed: ${String(err)}`);
  }
  return { units: chapters.map((c) => ({ text: collapseText(c.text), heading: c.heading })), cover };
}

const textDecoder = new TextDecoder('utf-8', { fatal: false });

/**
 * Read an EPUB zip: META-INF/container.xml → the OPF rootfile → the spine
 * `itemref` order → each referenced XHTML chapter, extracted via the same
 * `htmlToPage` the page reader uses (which gives us a chapter title as the
 * heading). Pure unzip + regex (no XML-parser dep) — good enough for the EPUB
 * package format, which is well-structured.
 */
async function readEpub(
  bytes: Uint8Array,
): Promise<{ chapters: { text: string; heading?: string }[]; cover?: CoverImage }> {
  const { unzipSync } = await import('fflate');
  const zip = unzipSync(new Uint8Array(bytes));

  // Zip-bomb guard: cap total decompressed size.
  const totalDecompressed = Object.values(zip).reduce((n, entry) => n + entry.byteLength, 0);
  if (totalDecompressed > env.ai.MAX_SOURCE_DECOMPRESSED_BYTES) {
    throw new SourceParseError('too_large', `epub decompressed size ${totalDecompressed} exceeds cap`);
  }

  const decode = (key: string): string | undefined => {
    const entry = zip[key];
    return entry ? textDecoder.decode(entry) : undefined;
  };

  // 1) container.xml → the OPF path.
  const container = decode('META-INF/container.xml');
  if (!container) throw new SourceParseError('parse_failed', 'epub missing container.xml');
  const opfPath = /<rootfile[^>]*\bfull-path\s*=\s*["']([^"']+)["']/i.exec(container)?.[1];
  if (!opfPath) throw new SourceParseError('parse_failed', 'epub container has no rootfile');

  const opf = decode(opfPath);
  if (!opf) throw new SourceParseError('parse_failed', `epub missing OPF at ${opfPath}`);

  // OPF-relative paths resolve against the OPF's directory.
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  // 2) manifest: id → href.
  const manifest = new Map<string, string>();
  for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
    const tag = m[0];
    const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (id && href) manifest.set(id, href);
  }

  // 3) spine: ordered idref list = reading order.
  const spineIds: string[] = [];
  const spineMatch = /<spine\b[^>]*>([\s\S]*?)<\/spine>/i.exec(opf);
  const spineBody = spineMatch?.[1] ?? '';
  for (const m of spineBody.matchAll(/<itemref\b[^>]*\bidref\s*=\s*["']([^"']+)["']/gi)) {
    if (m[1]) spineIds.push(m[1]);
  }

  // 4) each spine chapter → resolved zip key → XHTML → text + heading.
  const chapters: { text: string; heading?: string }[] = [];
  for (const id of spineIds) {
    const href = manifest.get(id);
    if (!href) continue;
    // Strip any in-document anchor + decode percent-encoding in the href.
    const cleanHref = decodeURIComponent(href.split('#')[0]!);
    const key = normalizeZipPath(opfDir + cleanHref);
    const html = decode(key) ?? decode(cleanHref);
    if (!html) continue;
    const page = htmlToPage(html, 'epub://chapter');
    if (page.text.trim().length === 0) continue;
    chapters.push({ text: page.text, heading: page.title });
  }

  // Best-effort cover extraction from the SAME unzipped archive (L3 §8.2).
  let cover: CoverImage | undefined;
  try {
    cover = extractEpubCover(zip) ?? undefined;
  } catch {
    cover = undefined;
  }
  return { chapters, cover };
}

/** Collapse `a/b/../c` and leading `./` in an EPUB-relative zip path. */
function normalizeZipPath(path: string): string {
  const parts: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

// ── URL (reuse page-reader) + text — single SourceUnit ────────────────────────

async function parseUrl(url: string): Promise<{ units: SourceUnit[]; imageUrl?: string }> {
  if (!url) throw new SourceParseError('fetch_failed', 'no url');
  try {
    const page = await readPageCached(url);
    return { units: [{ text: page.text, heading: page.title }], imageUrl: page.imageUrl };
  } catch (err) {
    throw new SourceParseError('fetch_failed', `url fetch failed: ${String(err)}`);
  }
}

function parseText(text: string): SourceUnit[] {
  return [{ text: collapseText(text) }];
}
