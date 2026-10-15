// Async source-ingest worker (NotebookLM M1, T6). The `sources` ROW IS THE JOB:
// `status` drives the pipeline and survives a restart (resume reclaims any
// non-terminal row). Runs with NO auth session — `user_id` is pulled from the
// row and stamped on every write (Principle P3). The card `index-queue.ts` is
// untouched; this is a parallel, status-keyed runner.
//
// Pipeline (all transitions are CAS — `UPDATE … WHERE id=$id AND status=$expected`
// — so a lost race updates 0 rows and the worker simply skips):
//   pending → parsing  : fetch bytes (S3 for pdf/epub, inline text, url) →
//                        parseSource → ONE tx writes all source_chunks (SoT) +
//                        chunk_count/char_count.
//   parsing → indexing : (guarded by chunk_count ≤ MAX_SOURCE_CHUNKS).
//   indexing → ready   : batch-embed (EMBED_BATCH); per batch ONE tx upserts the
//                        kb_chunk document rows (text = denormalized copy of the
//                        SoT) AND flips the matching source_chunks.embedded=true,
//                        so progress = COUNT(embedded=true) is crash-safe.
//
// Progress is COMPUTED, never stored: resume embeds only `embedded=false` rows.
// A vanished / `deleting` source mid-ingest is a CLEAN terminal (not a crash) —
// the DELETE route owns the kb_chunk cleanup. notebooksEnabled off (no embed
// key) → parse-and-park: SoT is written, embedding is skipped, status stays at
// `indexing`; a later restart-resume finishes it once a key is present.

import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  db,
  kbChunk,
  sourceChunks,
  sources,
  type Source,
} from '@reomi/db';
import { chunkSource, type SourceUnit } from '@reomi/shared';
import { env, notebooksEnabled } from '../env.ts';
import {
  rootLogger,
  safeError,
  workerLogger,
  type LogCorrelation,
} from '../logger.ts';
import { CorrelatedPendingQueue, sourceIngestWorkerState } from '../runtime-state.ts';
import type { Logger } from 'pino';
import { computeSourceHash, EMBED_BATCH, embeddingDegraded } from './index-queue.ts';
import { embed, isEmbeddingEnabled } from './openai-client.ts';
import { getObjectBytes } from '../storage.ts';
import { parseSource, SourceParseError } from './source-parsers.ts';
import { downloadUrlCover, storeCoverMedia, type CoverImage } from './source-cover.ts';

// ── In-process claim loop (concurrency-capped) ────────────────────────────────

const CONCURRENCY = Math.max(1, env.ai.SOURCE_INGEST_CONCURRENCY);
const queued = new CorrelatedPendingQueue(); // source ids + bounded causal metadata
let active = 0;
let idleResolvers: Array<() => void> = [];

/** Resolve any drain waiters once the loop is fully idle. */
function settleIfIdle(): void {
  if (active === 0 && queued.size === 0) {
    const resolvers = idleResolvers;
    idleResolvers = [];
    for (const r of resolvers) r();
  }
}

/**
 * Fire-and-forget enqueue after a create/finalize commit. Sync + non-blocking.
 * Idempotent (a re-enqueue of an in-flight id is dropped — the row's CAS guard
 * is the real safety net). Kicks the bounded claim loop.
 */
export function enqueueSource(sourceId: string, correlation?: LogCorrelation): void {
  const isNew = queued.enqueue(sourceId, correlation);
  if (isNew) sourceIngestWorkerState.enqueue();
  kick();
}

function kick(): void {
  while (active < CONCURRENCY && queued.size > 0) {
    const next = queued.takeOne();
    if (!next) break;
    active += 1;
    sourceIngestWorkerState.start();
    const log = workerLogger('source_ingest', next.correlation);
    void ingestSourceWithResult(next.id, { log })
      .then((failureCode) => {
        if (failureCode) sourceIngestWorkerState.fail(failureCode);
        else sourceIngestWorkerState.succeed();
      })
      .finally(() => {
        active -= 1;
        if (queued.size > 0) kick();
        settleIfIdle();
      });
  }
}

/**
 * Drain in-flight + queued ingest, up to `timeoutMs` (graceful shutdown). A
 * timeout is NOT fatal — the next startup resume picks up the remainder.
 */
export async function drainSourceIngest({ timeoutMs }: { timeoutMs: number }): Promise<void> {
  if (active === 0 && queued.size === 0) return;
  const drain = new Promise<void>((resolve) => idleResolvers.push(resolve));
  kick();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      rootLogger.warn(
        { active, queued: queued.size },
        'ai.source_ingest.drain_timeout',
      );
      resolve();
    }, timeoutMs);
  });
  await Promise.race([drain, timeout]);
  if (timer) clearTimeout(timer);
}

// ── Single-source pipeline (never throws into the loop) ───────────────────────

/**
 * Run the full pipeline for one source. Per-source try/catch — a parse throw or
 * an over-limit source resolves to a CAS `error` (with a machine code), never a
 * crash that takes down the loop. Exported so tests can drive it synchronously.
 */
export async function ingestSource(
  sourceId: string,
  opts: { log?: Logger } = {},
): Promise<void> {
  await ingestSourceWithResult(sourceId, opts);
}

/** Internal result lets the queue tracker record a safe failure code while the
 * public/test contract remains the original `Promise<void>`. */
async function ingestSourceWithResult(
  sourceId: string,
  opts: { log?: Logger } = {},
): Promise<string | null> {
  const log = opts.log ?? rootLogger;
  let phase: 'parse' | 'index' = 'parse';
  let runId: string | undefined;
  try {
    const claimed = await claimForParse(sourceId);
    if (!claimed) {
      // Not claimable as `pending` — maybe already `indexing` (resume) or gone.
      phase = 'index';
      const [current] = await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
      if (current?.status === 'indexing' && current.operationRunId) {
        runId = current.operationRunId;
        await indexPhase(sourceId, runId, log);
      }
      return null;
    }
    runId = claimed.operationRunId!;
    await parsePhase(claimed, log);
    phase = 'index';
    await indexPhase(sourceId, runId!, log);
    return null;
  } catch (err) {
    if (err instanceof TerminalSkip) return null; // vanished / deleting — clean exit
    const code =
      err instanceof SourceParseError ? err.code : phase === 'index' ? ('index_failed' as const) : ('parse_failed' as const);
    log.error({ err: safeError(err), sourceId, code }, 'ai.source_ingest.failed');
    await casStatus(sourceId, runId, ['pending', 'parsing', 'indexing'], 'error', { errorCode: code });
    return code;
  }
}

/** Thrown internally when a source vanished / went `deleting` — a clean terminal. */
class TerminalSkip extends Error {}

/** CAS `pending → parsing`. Returns the claimed row, or null if not claimable. */
async function claimForParse(sourceId: string): Promise<Source | null> {
  const [row] = await db
    .update(sources)
    .set({ status: 'parsing', errorCode: null, operationRunId: sql`COALESCE(${sources.operationRunId}, uuidv7())`, operationFinishedAt: null, updatedAt: new Date() })
    .where(and(eq(sources.id, sourceId), eq(sources.status, 'pending'), eq(sources.verified, true)))
    .returning();
  return row ?? null;
}

// ── Parse phase: bytes → parseSource → source_chunks (SoT) in ONE tx ───────────

async function parsePhase(source: Source, log: Logger): Promise<void> {
  try {
    const bytes = await loadBytes(source);
    const { units, cover, imageUrl, fetchedTitle, language } = await parseSource({
      kind: source.kind as 'pdf' | 'epub' | 'url' | 'text' | 'youtube',
      bytes,
      url: source.url ?? undefined,
      text: source.kind === 'text' ? await inlineTextFor(source.id) : undefined,
    });

    const chunks = chunkSource({
      sourceType: 'document',
      sourceId: source.id,
      // parentId = sourceId for documents (library refactor): sources are
      // user-level now, so the column keeps its NOT NULL with the card
      // convention. See packages/shared/src/kb-chunk.ts:13.
      parentId: source.id,
      text: '',
      units,
      chunkOptions: {
        tokensPerChunk: env.ai.SOURCE_CHUNK_TOKENS,
        overlap: env.ai.SOURCE_CHUNK_OVERLAP,
      },
    });

    // Over-limit short-circuit (CRITIC-C1) — never embed a runaway source.
    if (chunks.length > env.ai.MAX_SOURCE_CHUNKS) {
      await casStatus(source.id, source.operationRunId!, ['parsing'], 'error', { errorCode: 'too_many_chunks' });
      throw new TerminalSkip();
    }

    const charCount = units.reduce((n, u) => n + u.text.length, 0);
    const model = env.ai.EMBEDDING_MODEL;

    // ONE tx: rewrite the SoT chunks (idempotent — wipe + reinsert so a re-parse
    // never leaves stale rows) + set the progress denominator.
    await db.transaction(async (tx) => {
      const [live] = await tx.select({ id: sources.id }).from(sources)
        .where(and(eq(sources.id, source.id), eq(sources.operationRunId, source.operationRunId!), eq(sources.status, 'parsing'))).for('update').limit(1);
      if (!live) throw new TerminalSkip();
      await tx.delete(sourceChunks).where(eq(sourceChunks.sourceId, source.id));
      if (chunks.length > 0) {
        await tx.insert(sourceChunks).values(
          chunks.map((c) => ({
            userId: source.userId,
            sourceId: source.id,
            position: c.position,
            text: c.text,
            page: c.page ?? null,
            heading: c.heading ?? null,
            startSeconds: c.startSeconds ?? null,
            tokenCount: c.tokenCount ?? null,
            embedded: false,
            sourceHash: computeSourceHash(c.text, model),
          })),
        );
      }
      const title = fetchedTitle && /^https?:\/\//i.test(source.title) ? fetchedTitle.slice(0, 300) : undefined;
      await tx
        .update(sources)
        .set({
          chunkCount: chunks.length,
          charCount,
          ...(title ? { title } : {}),
          ...(language && !source.language ? { language: language.slice(0, 32) } : {}),
          updatedAt: new Date(),
        })
        .where(eq(sources.id, source.id));
    });

    // Best-effort cover (L3 §8.2): EPUB ships its cover in the archive; a URL's
    // og:image is downloaded SSRF-guarded. NEVER fails ingest (try/catch + log),
    // and only fills `cover_media_id` when it's still NULL (a client PATCH wins).
    await maybeStoreCover(source, cover, imageUrl, log);

    // CAS parsing → indexing (a concurrent delete loses this race → 0 rows → skip).
    const moved = await casStatus(source.id, source.operationRunId!, ['parsing'], 'indexing');
    if (!moved) throw new TerminalSkip();
  } finally {
    // Always evict — SoT recovery from source_chunks makes correctness
    // independent of the stash (stash is only a fast-path for same-process runs).
    inlineTextStore.delete(source.id);
  }
}

/**
 * Best-effort cover storage for a freshly-parsed source (L3 §8.2). EPUB ships a
 * `cover` (bytes already in hand); a URL ships an `imageUrl` (og:image) which we
 * download SSRF-guarded. The cover becomes a verified user `media` object and
 * `sources.cover_media_id` points at it — but ONLY when it's still NULL (a
 * client PATCH, e.g. PDF page-1 render, always wins). ANY failure is swallowed
 * (logged) so a cover never breaks ingest.
 */
async function maybeStoreCover(
  source: Source,
  cover: CoverImage | undefined,
  imageUrl: string | undefined,
  log: Logger,
): Promise<void> {
  try {
    let image: CoverImage | null = cover ?? null;
    if (!image && imageUrl) image = await downloadUrlCover(imageUrl);
    if (!image) return;
    const mediaId = await storeCoverMedia(source.userId, image);
    if (!mediaId) return;
    // Only set when still NULL — never clobber a client-set cover. Re-read the
    // live row (parse may have raced a PATCH).
    await db
      .update(sources)
      .set({ coverMediaId: mediaId })
      .where(and(eq(sources.id, source.id), sql`cover_media_id IS NULL`));
  } catch (err) {
    log.warn({ err: safeError(err), sourceId: source.id }, 'ai.source_ingest.cover_failed');
  }
}

/**
 * Inline-text carrier. `kind:'text'` sources have no S3 bytes and no dedicated
 * schema column for their raw text, so the create route stashes the (already
 * capped) text here keyed by source id; the parse phase reads it back. A restart
 * loses the map — but `resumeSourceIngestOnStartup` rebuilds it from the
 * already-written SoT `source_chunks` (joined back to one blob) before
 * re-enqueuing, so a torn `text` ingest re-parses from the recovered text rather
 * than failing `empty_source`.
 */
const inlineTextStore = new Map<string, string>();

export function stashInlineText(sourceId: string, text: string): void {
  inlineTextStore.set(sourceId, text);
}

/** Resolve inline text: in-memory stash first, else recover from the SoT chunks. */
async function inlineTextFor(sourceId: string): Promise<string> {
  const stashed = inlineTextStore.get(sourceId);
  if (stashed !== undefined) return stashed;
  const rows = await db
    .select({ text: sourceChunks.text })
    .from(sourceChunks)
    .where(eq(sourceChunks.sourceId, sourceId))
    .orderBy(sourceChunks.position);
  return rows.map((r) => r.text).join('\n\n');
}

async function loadBytes(source: Source): Promise<Uint8Array | undefined> {
  if (source.kind === 'pdf' || source.kind === 'epub') {
    if (!source.storageKey) throw new SourceParseError('parse_failed', 'no storage key');
    return getObjectBytes(source.storageKey);
  }
  return undefined; // url/text carry no S3 bytes
}

// ── Index phase: batch embed → kb_chunk doc rows + flip embedded ──────────────

/**
 * Embed every not-yet-embedded source_chunk in EMBED_BATCH-sized batches. Each
 * batch is ONE tx: upsert the kb_chunk document rows (conflict target
 * `(source_id, position) WHERE source_type='document'`) AND flip the matching
 * source_chunks.embedded=true. Then CAS indexing → ready. notebooksEnabled off
 * → parse-and-park (skip embedding, leave at `indexing`).
 */
async function indexPhase(sourceId: string, runId: string, log: Logger): Promise<void> {
  // Degrade: no embedder configured OR dim-assertion failed → park at 'indexing'.
  // Mirrors canIndex() in index-queue.ts (isEmbeddingEnabled && !embeddingDegraded).
  if (!isEmbeddingEnabled() || embeddingDegraded()) {
    log.info(
      { sourceId, notebooksEnabled },
      'ai.source_ingest.parked — embedding disabled or dim degraded, SoT written',
    );
    await db.update(sources).set({ operationFinishedAt: sql`COALESCE(${sources.operationFinishedAt}, now())` })
      .where(and(eq(sources.id, sourceId), eq(sources.operationRunId, runId), eq(sources.status, 'indexing')));
    return; // parked, readable, not active; resume finishes it later
  }

  // The ingest path runs with the source in `indexing` (this CAS will move it to
  // `ready`); a per-batch re-check that the source is STILL in an allowed status
  // bails cleanly on a concurrent reingest (which flips it back to `pending`).
  await db.update(sources).set({ operationFinishedAt: null }).where(and(eq(sources.id, sourceId), eq(sources.operationRunId, runId), eq(sources.status, 'indexing')));
  await embedUnembeddedChunks(sourceId, ['indexing'], log, runId);

  // All chunks embedded → CAS indexing → ready (a delete-race loses → skip).
  await casStatus(sourceId, runId, ['indexing'], 'ready');
}

/**
 * Embed every `embedded=false` source_chunk of one source in EMBED_BATCH-sized
 * batches. Each batch is ONE tx: upsert the kb_chunk document rows (conflict
 * target `(source_id, position) WHERE source_type='document'`, `parentId =
 * sourceId` per §3.4) AND flip the matching source_chunks.embedded=true, so
 * progress = COUNT(embedded=true) is crash-safe. A vanished/`deleting` source
 * is a clean TerminalSkip. Shared by the ingest index-phase (`allowedStatuses =
 * ['indexing']`) AND the document-reconcile pass (`['ready']` — re-stamps stale
 * chunks `embedded=false` first so they flow back through here) — NOT
 * copy-pasted (L4 §5). The per-batch re-check requires the source to STILL be in
 * one of `allowedStatuses` (a source that left it — e.g. a concurrent reingest
 * moved `ready`→`pending`, or a delete moved it to `deleting` — is a clean
 * TerminalSkip).
 */
async function embedUnembeddedChunks(
  sourceId: string,
  allowedStatuses: readonly string[],
  log: Logger = rootLogger,
  runId?: string | null,
): Promise<void> {
  const model = env.ai.EMBEDDING_MODEL;

  for (;;) {
    // Re-check the source still exists and is in an allowed status BEFORE each
    // batch (delete-race / concurrent-reingest: a vanished source or one that
    // left `allowedStatuses` is a clean terminal, not a crash).
    const [source] = await db
      .select({ id: sources.id, status: sources.status, userId: sources.userId })
      .from(sources)
      .where(and(eq(sources.id, sourceId), runId ? eq(sources.operationRunId, runId) : undefined))
      .limit(1);
    if (!source || !allowedStatuses.includes(source.status)) throw new TerminalSkip();

    // Pull the next batch of unembedded chunks (resume-safe: only embedded=false).
    const batch = await db
      .select({
        id: sourceChunks.id,
        position: sourceChunks.position,
        text: sourceChunks.text,
        sourceHash: sourceChunks.sourceHash,
      })
      .from(sourceChunks)
      .where(and(eq(sourceChunks.sourceId, sourceId), eq(sourceChunks.embedded, false)))
      .orderBy(sourceChunks.position)
      .limit(EMBED_BATCH);
    if (batch.length === 0) break;

    const vectors = await embed(batch.map((c) => c.text));

    // A non-conformant OpenAI-compatible gateway can return FEWER vectors than
    // inputs (or extras). If we silently proceed, the missing chunks never flip
    // `embedded=true` and the loop re-pulls + re-bills them forever. Fail the
    // ingest with a machine code instead (CAS → error) so it's a terminal, not a
    // paid infinite loop. `parse_failed` is the catch-all ingest error code.
    if (vectors.length !== batch.length) {
      throw new SourceParseError(
        'parse_failed',
        `embedder returned ${vectors.length} vectors for ${batch.length} chunks`,
      );
    }

    let deletedDuringEmbed = false;
    await db.transaction(async (tx) => {
      // Re-validate the source still exists and is not being deleted.
      // Serializes against the DELETE route's status flip.
      const [live] = await tx
        .select({ id: sources.id })
        .from(sources)
        .where(and(eq(sources.id, sourceId), inArray(sources.status, [...allowedStatuses]), runId ? eq(sources.operationRunId, runId) : undefined))
        .for('update').limit(1);
      if (!live) {
        // Source vanished or went 'deleting' during the embed() call — clean terminal.
        deletedDuringEmbed = true;
        return;
      }
      for (let i = 0; i < batch.length; i++) {
        const c = batch[i]!;
        const vector = vectors[i];
        if (!vector) continue;
        // The chunk's stored hash may be stale (a model change re-stamped it
        // embedded=false but the SoT hash still reads the OLD model); always
        // recompute against the CURRENT model so the kb_chunk hash is fresh.
        const freshHash = computeSourceHash(c.text, model);
        await tx
          .insert(kbChunk)
          .values({
            userId: source.userId,
            sourceType: 'document',
            sourceId: source.id,
            // parentId = sourceId for documents (library refactor — kb-chunk.ts:13).
            parentId: source.id,
            position: c.position,
            text: c.text,
            embedding: vector,
            embeddingModel: model,
            sourceHash: freshHash,
            cardId: null,
          })
          .onConflictDoUpdate({
            target: [kbChunk.sourceId, kbChunk.position],
            targetWhere: sql`source_type = 'document'`,
            set: {
              text: c.text,
              embedding: vector,
              embeddingModel: model,
              sourceHash: freshHash,
              userId: source.userId,
              parentId: source.id,
              updatedAt: new Date(),
            },
          });
        // Re-stamp the SoT hash to the current model in the SAME tx (so a
        // reconcile is idempotent — the next pass sees a matching hash + skips).
        await tx
          .update(sourceChunks)
          .set({ embedded: true, sourceHash: freshHash })
          .where(eq(sourceChunks.id, c.id));
      }
    });
    if (deletedDuringEmbed) throw new TerminalSkip();

    log.info({ sourceId, batch: batch.length, model }, 'ai.source_ingest.embed');
  }
}

// ── CAS helper ────────────────────────────────────────────────────────────────

/**
 * Compare-and-swap the status: UPDATE … WHERE id=$id AND status IN (expected).
 * Returns true iff a row was updated (the swap won the race). Optional extra
 * columns (`errorCode`) are set in the same statement.
 */
async function casStatus(
  sourceId: string,
  runId: string | undefined,
  expected: readonly string[],
  next: string,
  extra?: { errorCode?: string | null },
): Promise<boolean> {
  if (!runId) return false;
  const set: Record<string, unknown> = { status: next, updatedAt: new Date(), operationFinishedAt: next === 'ready' || next === 'error' ? new Date() : null };
  if (extra && 'errorCode' in extra) set.errorCode = extra.errorCode ?? null;
  const rows = await db
    .update(sources)
    .set(set)
    .where(and(eq(sources.id, sourceId), eq(sources.operationRunId, runId), inArray(sources.status, expected as string[])))
    .returning({ id: sources.id });
  return rows.length > 0;
}

// ── Resume-on-startup (boot-time, ALL users) ──────────────────────────────────

/**
 * Reclaim every non-terminal source on boot (mirrors `reconcileOnStartup`):
 * CAS-reset `parsing`/`indexing` back to `pending` (a torn parse re-parses; a
 * torn embed re-embeds only embedded=false chunks) and re-enqueue. NEVER throws
 * into the caller — kicked from index.ts after listen, degrades silently.
 */
export async function resumeSourceIngestOnStartup(): Promise<void> {
  try {
    const rows = await db.update(sources)
      .set({ operationRunId: sql`COALESCE(${sources.operationRunId}, uuidv7())` })
      .where(and(inArray(sources.status, ['pending', 'parsing', 'indexing']), eq(sources.verified, true)))
      .returning({ id: sources.id });
    if (rows.length === 0) return;
    // Reset parsing/indexing → pending so the full pipeline re-runs idempotently.
    await db
      .update(sources)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(and(eq(sources.status, 'parsing'), eq(sources.verified, true)));
    rootLogger.info({ count: rows.length }, 'ai.source_ingest.resume');
    for (const { id } of rows) enqueueSource(id);
  } catch (err) {
    sourceIngestWorkerState.recordFailure('startup_resume_failed');
    rootLogger.error({ err }, 'ai.source_ingest.resume_failed — degrading');
  }
}

// ── Document re-embed on model change (L4 §5 — closes the runbook gap) ─────────

/**
 * Re-embed library document vectors after an EMBEDDING_MODEL change. The card
 * `reconcileOnStartup`/`POST /ai/reindex` paths walk `cards` ONLY, so document
 * `kb_chunk` rows go stale on a model swap (their `source_hash` still encodes the
 * old model). This reads `source_chunks.text` (the SoT — never a re-parse/
 * re-download), finds every `ready` source whose chunks are stale, re-stamps
 * those chunks `embedded=false`, and re-embeds them through the SAME
 * `embedUnembeddedChunks` ingest helper (kb_chunk upsert + SoT hash re-stamp,
 * parentId=sourceId per §3.4). A chunk is stale when its SoT `source_hash` ≠
 * hash(text + current model) OR its kb_chunk row is missing / on a different
 * `embedding_model`. Parks (no-op) when embeddings are off / dim-degraded —
 * never churns. NEVER throws into the caller.
 *
 * `scope` selects the corpus: `{ all: true }` (reconcileOnStartup — all users)
 * or `{ userId }` (POST /ai/reindex — one user). Returns the count of sources
 * that had stale chunks re-embedded.
 */
export async function reconcileDocumentsOnStartup(
  scope: { all: true } | { userId: string },
  log: Logger = rootLogger,
): Promise<number> {
  try {
    // Mirror canIndex(): no embedder OR dim mismatch ⇒ park (leave vectors stale).
    if (!isEmbeddingEnabled() || embeddingDegraded()) return 0;

    const model = env.ai.EMBEDDING_MODEL;

    // Candidate ready sources (user-scoped when reindexing a single user).
    const readyRows = await db
      .select({ id: sources.id, runId: sources.operationRunId })
      .from(sources)
      .where(
        and(
          eq(sources.status, 'ready'),
          'userId' in scope ? eq(sources.userId, scope.userId) : undefined,
        ),
      );
    if (readyRows.length === 0) return 0;

    let reembedded = 0;
    for (const { id: sourceId, runId } of readyRows) {
      // A chunk is stale when its SoT hash ≠ hash(text + current model) OR its
      // kb_chunk row is absent / on a different embedding_model. LEFT JOIN so a
      // missing kb_chunk row (kc.embeddingModel IS NULL) counts as stale.
      const chunkRows = (await db
        .select({
          id: sourceChunks.id,
          text: sourceChunks.text,
          sourceHash: sourceChunks.sourceHash,
          kbModel: kbChunk.embeddingModel,
        })
        .from(sourceChunks)
        .leftJoin(
          kbChunk,
          and(
            eq(kbChunk.sourceId, sourceChunks.sourceId),
            eq(kbChunk.position, sourceChunks.position),
            eq(kbChunk.sourceType, 'document'),
          ),
        )
        .where(eq(sourceChunks.sourceId, sourceId))) as Array<{
        id: string;
        text: string;
        sourceHash: string | null;
        kbModel: string | null;
      }>;

      const staleIds = chunkRows
        .filter(
          (c) =>
            c.kbModel !== model || c.sourceHash !== computeSourceHash(c.text, model),
        )
        .map((c) => c.id);
      if (staleIds.length === 0) continue;

      // Re-stamp stale chunks embedded=false so they flow back through the
      // ingest embed helper (which re-embeds + re-stamps the SoT hash). The
      // helper re-checks the live source per batch (deleting-race safe).
      for (let i = 0; i < staleIds.length; i += EMBED_BATCH) {
        await db
          .update(sourceChunks)
          .set({ embedded: false })
          .where(inArray(sourceChunks.id, staleIds.slice(i, i + EMBED_BATCH)));
      }
      try {
        // Reconcile runs over `ready` sources; a per-batch re-check bails
        // cleanly if a concurrent reingest pulled the source out of `ready`.
        await embedUnembeddedChunks(sourceId, ['ready'], log, runId);
        reembedded += 1;
      } catch (err) {
        if (err instanceof TerminalSkip) continue; // vanished/deleting — clean
        throw err;
      }
    }

    if (reembedded > 0) {
      log.info({ reembedded, model }, 'ai.source_ingest.doc_reconcile.done');
    }
    sourceIngestWorkerState.recover();
    return reembedded;
  } catch (err) {
    sourceIngestWorkerState.recordFailure('document_reconcile_failed');
    log.error({ err: safeError(err) }, 'ai.source_ingest.doc_reconcile_failed — degrading');
    return 0;
  }
}
