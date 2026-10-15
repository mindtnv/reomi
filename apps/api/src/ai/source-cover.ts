// Source cover extraction (Library L3, §8.2). After a source parses, the ingest
// worker tries to give it a cover image stored as a user-owned `media` object so
// `sources.cover_media_id` points at it. NONE of this can fail the ingest — every
// path is best-effort (try/catch + log in the caller).
//
//   • EPUB — the cover image lives INSIDE the already-unzipped archive. The OPF
//     manifest names it (`properties="cover-image"`, `<meta name="cover">`, or a
//     manifest item whose id/href contains "cover"). Pure zip + regex (no new
//     dep); capped at COVER_MAX_BYTES. `extractEpubCover` is exported + unit-tested.
//   • URL — the page reader surfaced an `imageUrl` (og:image). The worker
//     downloads it SSRF-guarded (reusing page-reader's validate/assertPublicHost),
//     ≤COVER_MAX_BYTES, image/* only.
//   • PDF — no server cover (unpdf has no canvas in Bun); the client renders page 1
//     lazily on first open and PATCHes `coverMediaId` (handled web-side).
//
// `storeCoverMedia` writes the bytes to S3 under a fresh `media/{uuid}` key + a
// verified `media` row owned by the source's user (server-side analog of the
// presign→finalize media flow), then returns the media id for `cover_media_id`.

import { db, media } from '@reomi/db';
import { newUuidV7 } from '@reomi/shared';
import { putObject } from '../storage.ts';
import { assertPublicHost, validatePageUrl } from './page-reader.ts';

/** Hard cap on a cover image (2 MB — bigger ⇒ skip, never an error). */
export const COVER_MAX_BYTES = 2 * 1024 * 1024;

/** A detected cover image: raw bytes + its MIME (sniffed from magic bytes). */
export interface CoverImage {
  bytes: Uint8Array;
  mime: string;
}

// ── magic-byte image sniff (trust bytes, not extensions / declared types) ─────

/** Detect a supported image MIME from the leading magic bytes, else null. */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

// ── EPUB cover extraction (from the already-unzipped archive) ──────────────────

const textDecoder = new TextDecoder('utf-8', { fatal: false });

/** Collapse `a/b/../c` + leading `./` in an EPUB-relative zip path (mirror of
 *  source-parsers.normalizeZipPath). */
function normalizeZipPath(path: string): string {
  const parts: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Find + return the EPUB cover image bytes from a decompressed zip map
 * (`{ key: Uint8Array }` from fflate). Resolution order:
 *   1. manifest item with `properties="cover-image"` (EPUB3).
 *   2. `<meta name="cover" content="<id>">` → that manifest item (EPUB2).
 *   3. first manifest item whose id OR href contains "cover" AND is an image.
 * Returns null when no cover is found or it exceeds COVER_MAX_BYTES. PURE
 * (caller does the unzip) — unit-tested with a hand-built fixture zip.
 */
export function extractEpubCover(zip: Record<string, Uint8Array>): CoverImage | null {
  const decode = (key: string): string | undefined => {
    const entry = zip[key];
    return entry ? textDecoder.decode(entry) : undefined;
  };

  const container = decode('META-INF/container.xml');
  if (!container) return null;
  const opfPath = /<rootfile[^>]*\bfull-path\s*=\s*["']([^"']+)["']/i.exec(container)?.[1];
  if (!opfPath) return null;
  const opf = decode(opfPath);
  if (!opf) return null;
  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';

  // Parse the manifest into id → { href, props, mediaType }.
  interface Item { id: string; href: string; props: string; mediaType: string }
  const items: Item[] = [];
  const byId = new Map<string, Item>();
  for (const m of opf.matchAll(/<item\b[^>]*>/gi)) {
    const tag = m[0];
    const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!id || !href) continue;
    const props = /\bproperties\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
    const mediaType = /\bmedia-type\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? '';
    const item = { id, href, props, mediaType };
    items.push(item);
    byId.set(id, item);
  }

  // 1) properties="cover-image".
  let chosen = items.find((it) => /\bcover-image\b/i.test(it.props));
  // 2) <meta name="cover" content="id">.
  if (!chosen) {
    const metaCover = /<meta\b[^>]*\bname\s*=\s*["']cover["'][^>]*>/i.exec(opf)?.[0];
    const coverId = metaCover ? /\bcontent\s*=\s*["']([^"']+)["']/i.exec(metaCover)?.[1] : undefined;
    if (coverId) chosen = byId.get(coverId);
  }
  // 3) first image manifest item whose id/href mentions "cover".
  if (!chosen) {
    chosen = items.find(
      (it) =>
        (/image\//i.test(it.mediaType) || /\.(png|jpe?g|gif|webp)$/i.test(it.href)) &&
        (/cover/i.test(it.id) || /cover/i.test(it.href)),
    );
  }
  if (!chosen) return null;

  const cleanHref = decodeURIComponent(chosen.href.split('#')[0]!);
  const key = normalizeZipPath(opfDir + cleanHref);
  const bytes = zip[key] ?? zip[cleanHref];
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > COVER_MAX_BYTES) return null;

  const mime = sniffImageMime(bytes) ?? (/image\/(png|jpe?g|gif|webp)/i.exec(chosen.mediaType)?.[0] ?? null);
  if (!mime) return null;
  return { bytes, mime };
}

// ── URL cover (og:image download, SSRF-guarded) ────────────────────────────────

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
let coverFetchImpl: FetchFn = (input, init) => fetch(input, init);

/** Inject fetch for cover-download unit tests. */
export function __setCoverFetchForTests(fn: FetchFn | null): void {
  coverFetchImpl = fn ?? ((input, init) => fetch(input, init));
}

/**
 * Read a response body STREAMING into raw bytes, up to `cap`. Returns null the
 * moment the stream exceeds `cap` (the cover is too large — reject rather than
 * buffer an unbounded image). Mirrors page-reader's `readBodyCapped` but keeps
 * BYTES (not decoded text), since a cover is binary. Cancels the reader on
 * overflow so a streaming server isn't left dangling.
 */
async function readBytesCapped(res: Response, cap: number): Promise<Uint8Array | null> {
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.byteLength > cap ? null : buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        return null; // exceeded the cap mid-stream → oversize, reject
      }
      chunks.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * Download an og:image URL into a CoverImage, SSRF-guarded (same static + DNS/IP
 * checks as DirectPageReader). Returns null on ANY failure (blocked host,
 * non-image content, oversize, network error) — never throws. The Exa path's
 * `imageUrl` is on Exa's network already, but we still re-validate before our
 * own fetch (defense in depth, since OUR server makes this request).
 */
export async function downloadUrlCover(imageUrl: string): Promise<CoverImage | null> {
  let u: URL;
  try {
    u = validatePageUrl(imageUrl);
    await assertPublicHost(u);
  } catch {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await coverFetchImpl(u.href, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'image/*' },
      signal: controller.signal,
    });
    // A redirect could point at a private host — bail rather than follow blindly.
    if (res.status >= 300 && res.status < 400) return null;
    if (!res.ok) return null;
    const ct = (res.headers.get('content-type') ?? '').toLowerCase();
    if (ct && !ct.startsWith('image/')) return null;
    // Pre-check the advertised size (an honest oversize server saves the download)
    // then read the body STREAMING with a hard byte cap (a lying/chunked server
    // can't make us buffer an unbounded image into memory).
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > COVER_MAX_BYTES) return null;
    const buf = await readBytesCapped(res, COVER_MAX_BYTES);
    if (buf === null) return null; // streamed past the cap → reject (oversize)
    if (buf.byteLength === 0) return null;
    const mime = sniffImageMime(buf);
    if (!mime) return null;
    return { bytes: buf, mime };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── store a cover as a user media object → cover_media_id ──────────────────────

/**
 * Persist cover bytes as a VERIFIED `media` row owned by `userId` (server-side
 * analog of media presign→finalize: the server already holds the bytes, so it
 * derives a fresh `media/{uuid}` key, PUTs the bytes, and inserts the verified
 * row). Returns the new media id. The S3 key includes a content hash suffix in
 * the row's `s3_key` uniqueness is satisfied by the random uuid.
 */
export async function storeCoverMedia(
  userId: string,
  cover: CoverImage,
): Promise<string | null> {
  try {
    const mediaId = newUuidV7();
    const key = `media/${mediaId}`;
    await putObject(key, cover.bytes, cover.mime);
    await db.insert(media).values({
      id: mediaId,
      userId,
      s3Key: key,
      mime: cover.mime,
      size: cover.bytes.byteLength,
      verified: true,
    });
    return mediaId;
  } catch {
    return null;
  }
}
