import { StudyError } from './study-notes';
import { lockLibraryFolders, validateLibraryFolder } from './library-folders';
import { newOperationRun } from '../operation-run';
// Shared source/library helpers (L1). The library refactor split a source from
// any single notebook (sources are user-level; notebooks attach via the
// `notebook_sources` join). Both the legacy notebook source routes
// (`notebooks.ts`) and the new `/library` module (`library.ts`) need the SAME
// create/presign/finalize/delete/attach logic — it lives here so neither side
// copy-pastes ~200 lines. Every query is `user.id`-FIRST-conjunct scoped.

import { cancelArtifactRequests } from '../ai/artifact-cancellation';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import {
  db,
  kbChunk,
  notebookSources,
  notebookArtifacts,
  sourceChunks,
  sources,
  type Db,
  type Source,
} from '@reomi/db';
import {
  newUuidV7,
  parseYoutubeUrl,
  SOURCE_MIME_TO_KIND,
  type SourceMime,
} from '@reomi/shared';
import { env } from '../env.ts';
import { logCorrelation, rootLogger } from '../logger.ts';
import type { Logger } from 'pino';
import { deleteObject, getObjectBytes, headSize, presignUpload } from '../storage.ts';
import { enqueueSource, stashInlineText } from '../ai/source-ingest.ts';
import { embeddingDegraded } from '../ai/index-queue.ts';
import { isEmbeddingEnabled } from '../ai/openai-client.ts';

/** A Drizzle transaction handle (the arg passed to `db.transaction`). */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export const MAX_SOURCE_BYTES = env.ai.MAX_SOURCE_BYTES;
/** Inline text/url sources cap their content (re-capped server-side). */
export const MAX_INLINE_TEXT = 200_000;

/** S3 key for an uploaded source's bytes — `source/{uuid}` namespace (T3). */
export function sourceKeyFor(sourceId: string): string {
  return `source/${sourceId}`;
}

/** Map a Postgres unique-violation (23505) to a clean 409 (defense in depth). */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/**
 * Map a Postgres foreign-key-violation (23503) — e.g. a source physically
 * deleted between an ownership SELECT and a join INSERT — to a clean 404
 * (defense in depth against a TOCTOU between the ownership check and the write).
 */
export function isFkViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23503';
}

// ── caps ───────────────────────────────────────────────────────────────────

/**
 * Count a user's library items (sources NOT in the `deleting` terminal). The
 * global upload DoS bound — per-notebook caps no longer cover the whole library
 * now that sources are user-level.
 */
export async function countLibraryItems(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(sources)
    .where(and(eq(sources.userId, userId), sql`${sources.status} <> 'deleting'`));
  return row?.n ?? 0;
}

/** Count the sources attached to a notebook (the per-notebook cap target). */
export async function countNotebookSources(userId: string, notebookId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(notebookSources)
    .where(and(eq(notebookSources.userId, userId), eq(notebookSources.notebookId, notebookId)));
  return row?.n ?? 0;
}

// ── attach ───────────────────────────────────────────────────────────────────

/**
 * Idempotently attach one source to one notebook (the plain unique
 * `notebook_sources_nb_src_uq` arbiter — no `where`). Runs in the caller's tx
 * when given (so a create+attach is atomic), else a one-off db call.
 */
export async function attachSourceToNotebook(
  ex: Tx | typeof db,
  args: { userId: string; notebookId: string; sourceId: string },
): Promise<void> {
  await ex
    .insert(notebookSources)
    .values({
      userId: args.userId,
      notebookId: args.notebookId,
      sourceId: args.sourceId,
    })
    .onConflictDoNothing({
      target: [notebookSources.notebookId, notebookSources.sourceId],
    });
}

// ── inline create (url / text) ───────────────────────────────────────────────

export type InlineSourceInput = (
  | { kind: 'url'; title: string; url: string }
  | { kind: 'text'; title: string; text: string }) & { folderId?: string | null };

/** A rejected inline source. The transaction has not inserted a row. */
export class SourceInputError extends Error {
  constructor(
    readonly status: number,
    readonly code: 'invalid_url' | 'duplicate_source',
    readonly existingSourceId?: string,
  ) {
    super(code);
    this.name = 'SourceInputError';
  }
}

/**
 * Create an inline (url/text) library source + optionally attach it to a
 * notebook in ONE transaction, then enqueue ingest after commit. Returns the
 * created source row.
 */
export async function createInlineSource(
  userId: string,
  input: InlineSourceInput,
  notebookId?: string,
  log: Logger = rootLogger,
): Promise<Source> {
  const row = await db.transaction((tx) => insertInlineSource(tx, userId, input, notebookId));
  enqueueInlineSource(row, input, log);
  return row;
}

/** Insert only; callers enqueue AFTER their transaction commits. */
export async function insertInlineSource(
  tx: Tx, userId: string, input: InlineSourceInput, notebookId?: string,
): Promise<Source> {
  let created: Source;
  if (input.folderId) {
    await lockLibraryFolders(tx, userId);
    await validateLibraryFolder(tx, userId, input.folderId);
  }
  if (input.kind === 'url') {
    created = await insertUrlSource(tx, userId, input);
  } else {
    const text = input.text.slice(0, MAX_INLINE_TEXT);
    const [r] = await tx
      .insert(sources)
      .values({
        userId,
        kind: 'text',
        title: input.title,
        byteSize: text.length,
        status: 'pending',
        ...newOperationRun(),
        verified: true,
      })
      .returning();
    created = r!;
  }
  if (notebookId) {
    await attachSourceToNotebook(tx, { userId, notebookId, sourceId: created.id });
  }
  if (input.folderId) {
    [created] = await tx.update(sources).set({ folderId: input.folderId })
      .where(and(eq(sources.userId, userId), eq(sources.id, created.id))).returning() as [Source];
  }
  return created;
}

async function insertUrlSource(
  tx: Tx,
  userId: string,
  input: { title: string; url: string },
): Promise<Source> {
  const parsed = parseYoutubeUrl(input.url);
  if (!parsed.ok && parsed.reason === 'not_a_video') throw new SourceInputError(400, 'invalid_url');
  if (!parsed.ok) {
    const [row] = await tx.insert(sources).values({
      userId,
      kind: 'url',
      title: input.title,
      url: input.url,
      status: 'pending',
      ...newOperationRun(),
      verified: true,
    }).returning();
    return row!;
  }
  const canonicalUrl = parsed.canonicalUrl;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${canonicalUrl}`}, 940))`);
  const existing = await findActiveYoutube(tx, userId, canonicalUrl);
  if (existing) throw new SourceInputError(409, 'duplicate_source', existing.id);
  await tx.execute(sql`SAVEPOINT youtube_insert`);
  try {
    const [row] = await tx.insert(sources).values({
      userId,
      kind: 'youtube',
      title: input.title,
      url: canonicalUrl,
      status: 'pending',
      ...newOperationRun(),
      verified: true,
    }).returning();
    await tx.execute(sql`RELEASE SAVEPOINT youtube_insert`);
    return row!;
  } catch (err) {
    await tx.execute(sql`ROLLBACK TO SAVEPOINT youtube_insert`);
    if (!isUniqueViolation(err)) throw err;
    const dup = await findActiveYoutube(tx, userId, canonicalUrl);
    throw new SourceInputError(409, 'duplicate_source', dup?.id);
  }
}

async function findActiveYoutube(tx: Tx, userId: string, canonicalUrl: string) {
  const [row] = await tx.select({ id: sources.id }).from(sources).where(and(
    eq(sources.userId, userId),
    eq(sources.kind, 'youtube'),
    eq(sources.url, canonicalUrl),
    sql`${sources.status} NOT IN ('error', 'deleting')`,
  )).limit(1);
  return row;
}

export function enqueueInlineSource(row: Source, input: InlineSourceInput, log: Logger = rootLogger): void {
  if (input.kind === 'text') stashInlineText(row.id, input.text.slice(0, MAX_INLINE_TEXT));
  enqueueSource(row.id, logCorrelation(log));
}

// ── upload presign (pdf / epub) ───────────────────────────────────────────────

export type PresignResult =
  | { ok: true; sourceId: string; upload: Awaited<ReturnType<typeof presignUpload>> }
  | { ok: false; error: 'unsupported_mime' | 'too_large' | 'source_conflict' };

/**
 * Claim a uuid (pending, verified=false) for an upload + presign a POST policy.
 * The source is created WITHOUT a notebook (library item); the caller persists
 * the optional notebook attach at finalize time (the upload may never complete).
 */
export async function presignUploadSource(
  userId: string,
  body: { mime: string; size: number; title: string; folderId?: string | null },
  log: Logger = rootLogger,
): Promise<PresignResult> {
  if (!(body.mime in SOURCE_MIME_TO_KIND)) return { ok: false, error: 'unsupported_mime' };
  if (body.size < 1 || body.size > MAX_SOURCE_BYTES) return { ok: false, error: 'too_large' };
  const sourceMime = body.mime as SourceMime;
  const kind = SOURCE_MIME_TO_KIND[sourceMime];
  const sourceId = newUuidV7();
  const key = sourceKeyFor(sourceId);
  try {
    await db.transaction(async tx => {
      if (body.folderId) {
        await lockLibraryFolders(tx, userId);
        await validateLibraryFolder(tx, userId, body.folderId);
      }
      await tx.insert(sources).values({
      id: sourceId,
      userId,
      kind,
      title: body.title,
      storageKey: key,
      mime: sourceMime,
      byteSize: body.size,
      status: 'pending',
      verified: false,
      folderId: body.folderId ?? null,
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, error: 'source_conflict' };
    throw err;
  }
  const upload = await presignUpload(key, sourceMime, MAX_SOURCE_BYTES);
  log.debug({ sourceId, userId, kind }, 'source.presign');
  return { ok: true, sourceId, upload };
}

// ── finalize ─────────────────────────────────────────────────────────────────

export type FinalizeResult =
  | { ok: true; source: Source }
  | { ok: false; status: 400 | 404 | 409; error: string; existingSourceId?: string };

/**
 * Verify an uploaded object (HEAD size) + per-USER byte dedup, attach to an
 * optional notebook, then enqueue ingest. The dedup SELECT is per-user (the
 * whole library), excludes `error`/`deleting` (so a dupe uploaded while the
 * first is still indexing is caught too), and returns the existing source id so
 * the UI can offer "attach the existing one instead". SELECT the pending row by
 * (id, userId): user B can NEVER finalize user A's presigned uuid.
 */
export async function finalizeUploadSource(
  userId: string,
  sourceId: string,
  notebookId?: string,
  log: Logger = rootLogger,
): Promise<FinalizeResult> {
  const [pending] = await db
    .select()
    .from(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.userId, userId)))
    .limit(1);
  if (!pending) return { ok: false, status: 404, error: 'not_found' };
  if (pending.kind !== 'pdf' && pending.kind !== 'epub') {
    return { ok: false, status: 400, error: 'not_an_upload' };
  }
  const key = pending.storageKey;
  if (!key) return { ok: false, status: 400, error: 'no_storage_key' };

  // Idempotency: an already-verified row is returned as-is (+ attach if asked).
  if (pending.verified) {
    if (notebookId) await attachSourceToNotebook(db, { userId, notebookId, sourceId });
    return { ok: true, source: pending };
  }

  // Real size via HEAD. No object at the key → keep the pending row so a retry
  // after the real upload still works.
  let size: number | undefined;
  try {
    size = await headSize(key);
  } catch {
    return { ok: false, status: 400, error: 'not_uploaded' };
  }
  if (size === undefined) return { ok: false, status: 400, error: 'head_failed' };
  // > ceiling (or empty) → delete the object + the pending row + 400.
  if (size < 1 || size > MAX_SOURCE_BYTES) {
    await deleteObject(key).catch(() => {});
    await db.delete(sources).where(and(eq(sources.id, sourceId), eq(sources.userId, userId)));
    return { ok: false, status: 400, error: 'too_large' };
  }

  // Read the bytes once to compute the dedup hash.
  const bytes = await getObjectBytes(key);
  const byteHash = createHash('sha256').update(bytes).digest('hex');

  // DEDUP (Р5): a per-USER source with the same hash and a non-terminal/ready
  // status (NOT error/deleting) is a duplicate → delete the just-uploaded
  // object + the pending row + 409 carrying the existing id.
  const [dup] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(
      and(
        eq(sources.userId, userId),
        eq(sources.byteHash, byteHash),
        sql`${sources.status} NOT IN ('error', 'deleting')`,
      ),
    )
    .limit(1);
  if (dup) {
    await deleteObject(key).catch(() => {});
    await db.delete(sources).where(and(eq(sources.id, sourceId), eq(sources.userId, userId)));
    return { ok: false, status: 409, error: 'duplicate_source', existingSourceId: dup.id };
  }

  const source = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(sources)
      .set({ verified: true, byteSize: size, byteHash, ...newOperationRun(), updatedAt: new Date() })
      .where(and(eq(sources.id, sourceId), eq(sources.userId, userId)))
      .returning();
    if (notebookId) await attachSourceToNotebook(tx, { userId, notebookId, sourceId });
    return row!;
  });
  log.info({ sourceId, userId, size }, 'source.finalize');
  enqueueSource(sourceId, logCorrelation(log));
  return { ok: true, source };
}

// ── delete ─────────────────────────────────────────────────────────────────

/**
 * Completely delete a source from the library (the single source-delete flow,
 * shared by DELETE /sources/:id and DELETE /library/items/:id): soft-flag
 * `deleting` (so the ingest worker's pre-batch re-check bails cleanly), explicit
 * document kb_chunk cleanup by source_id (no FK on kb_chunk.source_id), delete
 * the row (source_chunks + notebook_sources edges + marks/annotations cascade;
 * card_sources SET NULL → tombstones), best-effort S3 delete. Returns false when
 * the source is foreign/missing (caller maps to 404).
 */
export async function deleteSourceCompletely(userId: string, sourceId: string): Promise<boolean> {
  const source = await db.transaction(async tx => {
    // All source-study mutations lock the source first, then its work. This
    // serializes deletion with admission and a worker's final commit.
    const [owned] = await tx.select({ id: sources.id, storageKey: sources.storageKey }).from(sources)
      .where(and(eq(sources.userId, userId), eq(sources.id, sourceId))).for('update').limit(1);
    if (!owned) return null;
    await tx.update(sources).set({ status: 'deleting', updatedAt: new Date() })
      .where(and(eq(sources.userId, userId), eq(sources.id, sourceId)));
    const interrupted = await tx.update(notebookArtifacts).set({ status: 'error', errorCode: 'source_unavailable', operationFinishedAt: new Date(), contentMd: null, contentJson: null, updatedAt: new Date() })
      .where(and(eq(notebookArtifacts.userId, userId), eq(notebookArtifacts.ownerKind, 'source'),
        eq(notebookArtifacts.sourceOriginId, sourceId), inArray(notebookArtifacts.status, ['pending', 'generating']))).returning({ id: notebookArtifacts.id });
    await tx.delete(kbChunk).where(and(eq(kbChunk.userId, userId), eq(kbChunk.sourceType, 'document'), eq(kbChunk.sourceId, sourceId)));
    await tx.delete(sources).where(and(eq(sources.userId, userId), eq(sources.id, sourceId)));
    return { ...owned, interruptedIds: interrupted.map(row => row.id) };
  });
  if (!source) return false;
  cancelArtifactRequests(source.interruptedIds);
  if (source.storageKey) await deleteObject(source.storageKey).catch(() => {});
  return true;
}

// ── reingest ─────────────────────────────────────────────────────────────────

export type ReingestResult =
  | { ok: true; parked: boolean }
  | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * Re-run the ingest pipeline for an already-ingested source through the existing
 * CAS state machine (L4 §4.1). Only valid on a TERMINAL status (`ready`/`error`)
 * — a non-terminal source (pending/parsing/indexing) is mid-flight → 409
 * `not_terminal`. `text` sources have NO external carrier (the raw text only
 * survives in source_chunks, which we wipe) so a re-parse is meaningless → 400
 * `not_reingestable`. One tx: wipe `source_chunks` + the document `kb_chunk`
 * rows (by source_id — no FK) + CAS `ready|error → pending` resetting the
 * progress metadata. The CAS `status IN ('ready','error')` guard means a
 * concurrent reingest (or a source that raced into `pending`) updates 0 rows →
 * 409. After commit the standard worker is kicked. Grounding-safety is
 * by-construction: the chat scope intersects `status='ready'`, so the source
 * drops out of every notebook's chat while it re-ingests. The success result
 * carries `parked` — true when embeddings are off/dim-degraded, so the source
 * re-parses but defers (re)embedding (mirrors the worker's park decision).
 */
export async function reingestSourceInTransaction(
  tx: Tx, userId: string, sourceId: string,
  retry?: { runId: string; beforeStart?: () => void },
) {
  const [source] = await tx.select().from(sources)
    .where(and(eq(sources.id, sourceId), eq(sources.userId, userId))).for('update').limit(1);
  if (!source) throw new StudyError(404, 'not_found');
  if (retry && source.operationRunId !== retry.runId) return { row: source, stale: true };
  const indexOnly = Boolean(retry && source.errorCode === 'index_failed');
  if (source.kind === 'text' && !indexOnly) throw new StudyError(400, 'not_reingestable');
  if (!['ready', 'error'].includes(source.status)) throw new StudyError(409, 'not_terminal');
  if (retry && source.status !== 'error') throw new StudyError(409, 'not_failed');
  if (indexOnly && (!isEmbeddingEnabled() || embeddingDegraded())) throw new StudyError(503, 'ai_disabled');
  if (retry && !source.verified) throw new StudyError(409, 'source_unavailable');
  retry?.beforeStart?.();
  const [row] = await tx.update(sources).set({ status: indexOnly ? 'indexing' : 'pending', errorCode: null,
    ...newOperationRun(), ...(indexOnly ? {} : { charCount: null, chunkCount: null }), updatedAt: new Date() })
    .where(and(eq(sources.id, sourceId), eq(sources.userId, userId))).returning();
  if (!indexOnly) {
    await tx.delete(sourceChunks).where(eq(sourceChunks.sourceId, sourceId));
    await tx.delete(kbChunk).where(and(eq(kbChunk.userId, userId), eq(kbChunk.sourceType, 'document'), eq(kbChunk.sourceId, sourceId)));
  }
  return { row: row!, stale: false };
}

export async function reingestSource(userId: string, sourceId: string, log: Logger = rootLogger): Promise<ReingestResult> {
  try {
    await db.transaction(tx => reingestSourceInTransaction(tx, userId, sourceId));
  } catch (error) {
    if (error instanceof StudyError) return { ok: false, status: error.status as 400 | 404 | 409, error: error.message as 'not_found' | 'not_terminal' | 'not_reingestable' };
    throw error;
  }
  enqueueSource(sourceId, logCorrelation(log));
  return { ok: true, parked: !isEmbeddingEnabled() || embeddingDegraded() };
}
