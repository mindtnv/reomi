import { and, asc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { db, media, sources } from '@reomi/db';
import { deleteObject, listObjectsPage } from './storage.ts';

const HOUR_MS = 60 * 60 * 1000;
export const DEFAULT_PENDING_MAX_AGE_MS = 24 * HOUR_MS;
export const DEFAULT_UNREFERENCED_MAX_AGE_MS = 7 * 24 * HOUR_MS;
export const DEFAULT_MEDIA_GC_BATCH = 50;

const PREFIXES = ['media/', 'source/'] as const;
const SWEEP_KEY = /^(?:media|source)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let prefixIndex = 0;
let continuationToken: string | undefined;

export type MediaGcReport = {
  pendingMedia: number;
  pendingSources: number;
  unreferencedMedia: number;
  orphanObjects: number;
  objectDeleteFailures: number;
  listFailures: number;
};

export type MediaGcOptions = {
  now?: Date;
  pendingMaxAgeMs?: number;
  unreferencedMaxAgeMs?: number;
  batch?: number;
};

export function __resetMediaGcForTests(): void {
  prefixIndex = 0;
  continuationToken = undefined;
}

function positiveEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function notReferenced(): SQL {
  return sql`not exists (select 1 from sources where cover_media_id = media.id)
    and not exists (select 1 from notes where position(media.id::text in field_values::text) > 0)
    and not exists (select 1 from messages where position(media.id::text in coalesce(content, '') || coalesce(attachments::text, '') || coalesce(tool_calls::text, '') || coalesce(mentions::text, '') || coalesce(context::text, '')) > 0)
    and not exists (select 1 from notebook_notes where position(media.id::text in title || content || coalesce(citations::text, '')) > 0)
    and not exists (select 1 from notebook_artifacts where position(media.id::text in title || coalesce(content_md, '') || coalesce(content_json::text, '')) > 0)
    and not exists (select 1 from notebooks where position(media.id::text in coalesce(overview, '') || coalesce(suggested_questions::text, '')) > 0)
    and not exists (select 1 from mcp_actions where position(media.id::text in args::text || preview::text) > 0)
    and not exists (select 1 from source_chunks where position(media.id::text in "text") > 0)
    and not exists (select 1 from note_types where position(media.id::text in templates::text) > 0)`;
}

async function removeObject(key: string, removed: Set<string>): Promise<boolean> {
  try {
    await deleteObject(key);
    removed.add(key);
    return true;
  } catch {
    return false;
  }
}

async function sweepPendingMedia(cutoff: Date, batch: number, removed: Set<string>): Promise<{ rows: number; failures: number }> {
  const candidates = await db
    .select({ id: media.id })
    .from(media)
    .where(and(eq(media.verified, false), lt(media.createdAt, cutoff)))
    .orderBy(asc(media.createdAt), asc(media.id))
    .limit(batch);
  let rows = 0;
  let failures = 0;
  for (const candidate of candidates) {
    const [claimed] = await db
      .delete(media)
      .where(and(eq(media.id, candidate.id), eq(media.verified, false), lt(media.createdAt, cutoff)))
      .returning({ key: media.s3Key });
    if (!claimed) continue;
    rows += 1;
    if (!(await removeObject(claimed.key, removed))) failures += 1;
  }
  return { rows, failures };
}

async function sweepPendingSources(cutoff: Date, batch: number, removed: Set<string>): Promise<{ rows: number; failures: number }> {
  const candidates = await db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.verified, false), eq(sources.status, 'pending'), lt(sources.createdAt, cutoff)))
    .orderBy(asc(sources.createdAt), asc(sources.id))
    .limit(batch);
  let rows = 0;
  let failures = 0;
  for (const candidate of candidates) {
    const [claimed] = await db
      .delete(sources)
      .where(and(
        eq(sources.id, candidate.id),
        eq(sources.verified, false),
        eq(sources.status, 'pending'),
        lt(sources.createdAt, cutoff),
      ))
      .returning({ key: sources.storageKey });
    if (!claimed) continue;
    rows += 1;
    if (claimed.key && !(await removeObject(claimed.key, removed))) failures += 1;
  }
  return { rows, failures };
}

async function sweepUnreferencedMedia(cutoff: Date, batch: number, removed: Set<string>): Promise<{ rows: number; failures: number }> {
  const candidates = await db
    .select({ id: media.id })
    .from(media)
    .where(and(eq(media.verified, true), lt(media.createdAt, cutoff), notReferenced()))
    .orderBy(asc(media.createdAt), asc(media.id))
    .limit(batch);
  let rows = 0;
  let failures = 0;
  for (const candidate of candidates) {
    const [claimed] = await db
      .delete(media)
      .where(and(eq(media.id, candidate.id), eq(media.verified, true), lt(media.createdAt, cutoff), notReferenced()))
      .returning({ key: media.s3Key });
    if (!claimed) continue;
    rows += 1;
    if (!(await removeObject(claimed.key, removed))) failures += 1;
  }
  return { rows, failures };
}

async function sweepOrphanObjects(now: Date, maxAgeMs: number, batch: number, removed: Set<string>): Promise<{ deleted: number; failures: number; listFailed: boolean }> {
  const prefix = PREFIXES[prefixIndex] ?? 'media/';
  let page: Awaited<ReturnType<typeof listObjectsPage>>;
  try {
    page = await listObjectsPage({ prefix, maxKeys: batch, continuationToken });
  } catch {
    return { deleted: 0, failures: 0, listFailed: true };
  }
  if (page.nextToken) continuationToken = page.nextToken;
  else {
    continuationToken = undefined;
    prefixIndex = (prefixIndex + 1) % PREFIXES.length;
  }
  const cutoff = now.getTime() - maxAgeMs;
  const candidates = page.items.filter((item) =>
    SWEEP_KEY.test(item.key) && item.lastModified !== null && item.lastModified.getTime() < cutoff);
  if (candidates.length === 0) return { deleted: 0, failures: 0, listFailed: false };
  const keys = candidates.map((item) => item.key);
  const knownMedia = await db.select({ key: media.s3Key }).from(media).where(inArray(media.s3Key, keys));
  const knownSources = await db.select({ key: sources.storageKey }).from(sources).where(inArray(sources.storageKey, keys));
  const known = new Set<string>([
    ...knownMedia.map((row) => row.key),
    ...knownSources.flatMap((row) => (row.key ? [row.key] : [])),
  ]);
  let deleted = 0;
  let failures = 0;
  for (const item of candidates) {
    if (known.has(item.key) || removed.has(item.key)) continue;
    if (await removeObject(item.key, removed)) deleted += 1;
    else failures += 1;
  }
  return { deleted, failures, listFailed: false };
}

export async function runMediaGc(options?: MediaGcOptions): Promise<MediaGcReport> {
  const resolved = {
    now: options?.now ?? new Date(),
    pendingMaxAgeMs: options?.pendingMaxAgeMs ?? positiveEnv('MEDIA_PENDING_MAX_AGE_MS', DEFAULT_PENDING_MAX_AGE_MS),
    unreferencedMaxAgeMs: options?.unreferencedMaxAgeMs ?? positiveEnv('MEDIA_UNREFERENCED_MAX_AGE_MS', DEFAULT_UNREFERENCED_MAX_AGE_MS),
    batch: Math.min(1000, options?.batch ?? positiveEnv('MEDIA_GC_BATCH', DEFAULT_MEDIA_GC_BATCH)),
  };
  const pendingCutoff = new Date(resolved.now.getTime() - resolved.pendingMaxAgeMs);
  const unreferencedCutoff = new Date(resolved.now.getTime() - resolved.unreferencedMaxAgeMs);
  const removed = new Set<string>();
  const pendingMedia = await sweepPendingMedia(pendingCutoff, resolved.batch, removed);
  const pendingSources = await sweepPendingSources(pendingCutoff, resolved.batch, removed);
  const unreferencedMedia = await sweepUnreferencedMedia(unreferencedCutoff, resolved.batch, removed);
  const orphans = await sweepOrphanObjects(resolved.now, resolved.pendingMaxAgeMs, resolved.batch, removed);
  return {
    pendingMedia: pendingMedia.rows,
    pendingSources: pendingSources.rows,
    unreferencedMedia: unreferencedMedia.rows,
    orphanObjects: orphans.deleted,
    objectDeleteFailures: pendingMedia.failures + pendingSources.failures + unreferencedMedia.failures + orphans.failures,
    listFailures: orphans.listFailed ? 1 : 0,
  };
}

export async function deleteAccountStorage(userId: string): Promise<void> {
  const mediaRows = await db.select({ key: media.s3Key }).from(media).where(eq(media.userId, userId));
  const sourceRows = await db.select({ key: sources.storageKey }).from(sources).where(eq(sources.userId, userId));
  const keys = [...new Set([
    ...mediaRows.map((row) => row.key),
    ...sourceRows.flatMap((row) => (row.key ? [row.key] : [])),
  ])].sort();
  for (const key of keys) await deleteObject(key);
}
