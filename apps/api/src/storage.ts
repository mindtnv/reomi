// S3-compatible storage client (M2 Phase 2).
//
// Mirrors packages/db/src/client.ts: one client per process, built from env.
// With `bun --watch` the module is fully reloaded on file change, so a module
// singleton is safe — no HMR state leaks.
//
// Upload model (plan Decision A1 + amendments C-1/C-3/C-4/A5/A7):
//   * Bytes never flow through Bun. The client presigns a POST policy here,
//     POSTs the multipart form directly to S3, then calls finalize.
//   * Keys are EXT-FREE `media/{uuid}` (C-1/A7) — no userId, no extension; the
//     owner lives only in the `media.userId` DB row. The stored token is
//     `/m/{uuid}`. Reading it requires the owner's session (`GET /media/:id/content`);
//     the bucket is not an anonymous download.
//   * `presignUpload` binds size (content-length-range) AND Content-Type so
//     MinIO/S3 reject oversize (400) and wrong type (403) server-side.
//   * `headSize` + `sniffMagic` re-verify real size/MIME at finalize.

import {
  S3Client,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { createPresignedPost, type PresignedPost } from '@aws-sdk/s3-presigned-post';
import { env } from './env.ts';

const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
});

/**
 * Create a presigned POST policy for a direct browser upload. The policy binds:
 *   * `content-length-range` [1, maxBytes] → S3 rejects oversize/empty (400)
 *   * `eq $Content-Type mime` → S3 rejects a mismatched Content-Type (403)
 * The client POSTs a multipart form of `fields` + `Content-Type` + `file`.
 * MinIO returns 204 on success. Expires in 120s.
 */
export function presignUpload(
  key: string,
  mime: string,
  maxBytes: number,
): Promise<PresignedPost> {
  return createPresignedPost(s3, {
    Bucket: env.S3_BUCKET,
    Key: key,
    Conditions: [
      ['content-length-range', 1, maxBytes],
      ['eq', '$Content-Type', mime],
    ],
    Fields: { 'Content-Type': mime },
    Expires: 120,
  });
}

/**
 * Real object size via HEAD metadata (finalize size check, plan C-4). Returns
 * `undefined` when the object exists but reports NO `ContentLength` — finalize
 * MUST treat that as a distinct `head_failed` (do NOT delete a possibly-good
 * object), rather than coalescing it to 0 and mis-classifying it as too_large.
 */
export async function headSize(key: string): Promise<number | undefined> {
  const res = await s3.send(
    new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
  );
  return res.ContentLength;
}

/**
 * First 16 bytes via a ranged GET (`bytes=0-15`) for magic-byte sniffing
 * (plan C-4 — HEAD can't return a body). Returns the bytes as a Uint8Array.
 */
export async function sniffMagic(key: string): Promise<Uint8Array> {
  const res = await s3.send(
    new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Range: 'bytes=0-15' }),
  );
  if (!res.Body) return new Uint8Array(0);
  // The Node/Bun stream body exposes transformToByteArray on the SDK's
  // SdkStreamMixin; fall back to manual buffering if it's absent.
  const body = res.Body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof body.transformToByteArray === 'function') {
    return body.transformToByteArray();
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Server-side PUT of bytes to a key the server itself derived (L3 covers: the
 * ingest worker extracts an EPUB/URL cover image and stores it as a media
 * object). NOT a client-upload path — the bytes are already in hand on the
 * server, size-capped by the caller, so no presign policy is involved.
 */
export async function putObject(key: string, bytes: Uint8Array, mime: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: bytes, ContentType: mime }),
  );
}

export type ListedObject = { key: string; lastModified: Date | null };
export type ObjectListQuery = { prefix: string; maxKeys: number; continuationToken?: string };
export type ObjectListPage = { items: ListedObject[]; nextToken?: string };

type ObjectDeleter = (key: string) => Promise<void>;
type ObjectLister = (query: ObjectListQuery) => Promise<ObjectListPage>;

let objectDeleter: ObjectDeleter | null = null;
let objectLister: ObjectLister | null = null;

/** Test seam. Production sends DeleteObject. */
export function __setObjectDeleterForTests(deleter: ObjectDeleter | null): void {
  objectDeleter = deleter;
}

/** Test seam. Production sends ListObjectsV2. */
export function __setObjectListerForTests(lister: ObjectLister | null): void {
  objectLister = lister;
}

/** Delete an object (finalize mismatch, account deletion, and media GC). */
export async function deleteObject(key: string): Promise<void> {
  if (objectDeleter) {
    await objectDeleter(key);
    return;
  }
  await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
}

/** One bounded page of object keys. The caller decides which keys are garbage. */
export async function listObjectsPage(query: ObjectListQuery): Promise<ObjectListPage> {
  if (objectLister) return objectLister(query);
  const res = await s3.send(new ListObjectsV2Command({
    Bucket: env.S3_BUCKET,
    Prefix: query.prefix,
    MaxKeys: query.maxKeys,
    ContinuationToken: query.continuationToken,
  }));
  const items: ListedObject[] = [];
  for (const entry of res.Contents ?? []) {
    if (!entry.Key) continue;
    items.push({ key: entry.Key, lastModified: entry.LastModified ?? null });
  }
  return { items, nextToken: res.IsTruncated ? res.NextContinuationToken : undefined };
}

/**
 * Full object bytes (chat image attachments → base64 data URLs for the
 * multimodal gateway request). Callers bound the size BEFORE calling (the
 * media row's verified `size`), so this never buffers unbounded data.
 */
export async function getObjectBytes(key: string): Promise<Uint8Array> {
  const res = await s3.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
  if (!res.Body) return new Uint8Array(0);
  const body = res.Body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof body.transformToByteArray === 'function') {
    return body.transformToByteArray();
  }
  const chunks: Uint8Array[] = [];
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) chunks.push(chunk);
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Absolute object URL on the configured public base. This is not an access
 * grant: card and cover reads go through the authenticated media route, and
 * the bucket must not allow anonymous GetObject.
 */
export function publicUrl(key: string): string {
  return `${env.S3_PUBLIC_BASE_URL}/${key}`;
}

type MediaObjectReader = (key: string) => Promise<Uint8Array | null>;
type MediaObjectLength = (key: string) => Promise<number | undefined>;

let mediaObjectReader: MediaObjectReader | null = null;
let mediaObjectLength: MediaObjectLength | null = null;

/** Test seam. Production reads the server-derived key from S3. */
export function __setMediaObjectReaderForTests(reader: MediaObjectReader | null): void {
  mediaObjectReader = reader;
}

/** Test seam for the HEAD size check. Production uses object ContentLength. */
export function __setMediaObjectLengthForTests(reader: MediaObjectLength | null): void {
  mediaObjectLength = reader;
}

/**
 * Object size from HEAD, before any body is buffered. Missing objects and
 * storage failures become `undefined` so the caller can refuse the read.
 */
export async function mediaObjectByteLength(key: string): Promise<number | undefined> {
  try {
    return mediaObjectLength ? await mediaObjectLength(key) : await headSize(key);
  } catch {
    return undefined;
  }
}

/**
 * Full object bytes for an authorized media read. The caller must already have
 * rejected an over-cap ContentLength. Missing objects and storage failures
 * become `null` so the route can answer 404 without leaking the cause.
 */
export async function readMediaObject(key: string): Promise<Uint8Array | null> {
  try {
    const bytes = mediaObjectReader ? await mediaObjectReader(key) : await getObjectBytes(key);
    if (!bytes || bytes.byteLength < 1) return null;
    return bytes;
  } catch {
    return null;
  }
}
