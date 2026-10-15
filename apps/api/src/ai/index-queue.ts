// In-process index queue (Decision 2, plan §155-185).
//
// A module-level FIFO + a concurrency-capped async drainer that embeds card
// `render_text` into `kb_chunk` rows. Fire-and-forget enqueue on write
// (notes/cards handlers, AFTER the transaction commits) keeps the HTTP path
// non-blocking; eventual consistency comes from the serial drain; a startup
// reconcile + idempotent backfill close the in-memory-durability gap (chunks
// are DERIVED — rebuildable at any time).
//
// Change detection: `sourceHash = hash(render_text + embeddingModel)`. A card
// whose stored chunk already carries the same hash is SKIPPED (no paid
// re-embed) — so an `updatedAt` bump that does NOT change content (forget /
// setDue / bulk move) costs nothing. Including the model means a model swap
// invalidates every chunk → full reindex.
//
// All loads are scoped by the card's `userId` (the chunk inherits it). The HNSW
// index is global, but retrieval (Slice 4) carries the `user_id` predicate.

import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { cards, db, kbChunk } from '@reomi/db';
import { chunkSource } from '@reomi/shared';
import { env } from '../env.ts';
import {
  rootLogger,
  safeError,
  workerLogger,
  type LogCorrelation,
} from '../logger.ts';
import { CorrelatedPendingQueue, indexWorkerState } from '../runtime-state.ts';
import type { Logger } from 'pino';
import { embed, isEmbeddingEnabled } from './openai-client.ts';

// Embed at most this many texts per upstream request (plan SHOULD-FIX #8).
// Exported as the single source of truth — backfill imports it too.
export const EMBED_BATCH = 96;
// Drainer concurrency cap. Serial-ish (1–2) so a bulk reindex never fans out
// hundreds of concurrent embedding calls (Pre-mortem #2).
const DRAIN_CONCURRENCY = 2;
const MAX_TASK_RETRIES = 3;

// ── sourceHash ───────────────────────────────────────────────────────────────

/** Cheap change-detection key: hash(render_text + embeddingModel). */
export function computeSourceHash(renderText: string, embeddingModel: string): string {
  return createHash('sha256').update(`${embeddingModel}\0${renderText}`).digest('hex');
}

// ── Dimension-assertion degrade state (SHOULD-FIX #9) ─────────────────────────
// When the live column dimension ≠ configured EMBEDDING_DIM we DISABLE embedding
// writes (degrade, never crash) and surface it in GET /ai/status.

let dimMismatch = false;

/** True when boot-time dim assertion found a mismatch and writes are disabled. */
export function embeddingDegraded(): boolean {
  return dimMismatch;
}

/** Embedding writes are permitted only when enabled AND not degraded. */
function canIndex(): boolean {
  return isEmbeddingEnabled() && !dimMismatch;
}

/**
 * Compare the live `kb_chunk.embedding` column dimension against the configured
 * EMBEDDING_DIM. On mismatch: log an error + set the degrade flag (writes are
 * blocked). Never throws — a query failure is itself logged and treated as
 * "can't assert" (writes stay enabled; a real dimension-mismatch insert would
 * fail loudly on its own). Idempotent.
 */
export async function assertEmbeddingDim(): Promise<void> {
  try {
    // pgvector stores the dimension in atttypmod for the vector column.
    const rows = (await db.execute(sql`
      SELECT a.atttypmod AS typmod
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relname = 'kb_chunk' AND a.attname = 'embedding'
    `)) as unknown as Array<{ typmod: number }>;
    const typmod = rows[0]?.typmod;
    if (typmod === undefined || typmod < 0) {
      // No dimension recorded (e.g. unparametrized) — can't assert, leave enabled.
      return;
    }
    const liveDim = typmod;
    if (liveDim !== env.ai.EMBEDDING_DIM) {
      dimMismatch = true;
      indexWorkerState.recordFailure('embedding_dimension_mismatch');
      rootLogger.error(
        { liveDim, configuredDim: env.ai.EMBEDDING_DIM },
        'ai.index.dim_mismatch — embedding writes DISABLED (degrade)',
      );
    }
  } catch (err) {
    indexWorkerState.recordFailure('dimension_assert_failed');
    rootLogger.warn({ err }, 'ai.index.dim_assert_failed');
  }
}

// ── FIFO queue + drainer ──────────────────────────────────────────────────────

const pending = new CorrelatedPendingQueue(); // queued card ids + safe causal metadata
const inFlight = new Set<string>(); // ids being embedded right now
let active = 0; // running drain workers
let drainPromise: Promise<void> | null = null;
let drainResolve: (() => void) | null = null;

/** A promise that resolves when the queue is fully drained (in-flight too). */
function ensureDrainPromise(): Promise<void> {
  if (!drainPromise) {
    drainPromise = new Promise<void>((resolve) => {
      drainResolve = resolve;
    });
  }
  return drainPromise;
}

function settleIfIdle(): void {
  if (active === 0 && pending.size === 0 && inFlight.size === 0) {
    drainResolve?.();
    drainResolve = null;
    drainPromise = null;
  }
}

/**
 * Enqueue a card for (re)indexing. Sync + non-blocking — returns immediately.
 * No-op when embeddings are not enabled (or degraded). Kicks the drainer.
 */
export function enqueueIndex(cardId: string, correlation?: LogCorrelation): void {
  if (!canIndex()) return;
  if (inFlight.has(cardId)) return;
  const isNew = pending.enqueue(cardId, correlation);
  if (isNew) indexWorkerState.enqueue();
  ensureDrainPromise();
  kickDrain();
}

/** Spin up drain workers up to the concurrency cap. */
function kickDrain(): void {
  while (active < DRAIN_CONCURRENCY && pending.size > 0) {
    active += 1;
    void drainWorker();
  }
}

async function drainWorker(): Promise<void> {
  try {
    while (pending.size > 0) {
      // Take a batch (up to EMBED_BATCH) for this worker.
      const next = pending.takeBatch(EMBED_BATCH);
      if (!next || next.ids.length === 0) break;
      const batch = next.ids;
      const log = workerLogger('index', next.correlation);
      for (const id of batch) inFlight.add(id);
      indexWorkerState.start(batch.length);

      let attempt = 0;
      let failed = false;
      for (;;) {
        try {
          await indexCards(batch, { log });
          break;
        } catch (err) {
          attempt += 1;
          log.warn(
            { err: safeError(err), attempt, batch: batch.length, queueDepth: pending.size },
            'ai.index.batch_retry',
          );
          if (attempt > MAX_TASK_RETRIES) {
            failed = true;
            log.error({ batch: batch.length }, 'ai.index.batch_dropped');
            break;
          }
          await new Promise((r) => setTimeout(r, Math.min(2000, 250 * 2 ** attempt)));
        }
      }
      for (const id of batch) inFlight.delete(id);
      if (failed) indexWorkerState.fail('index_batch_dropped', batch.length);
      else indexWorkerState.succeed(batch.length);
    }
  } finally {
    active -= 1;
    // Another worker may still be running; only settle when fully idle.
    if (pending.size > 0) kickDrain();
    settleIfIdle();
  }
}

/**
 * Await in-flight + queued work, up to `timeoutMs`. Used by graceful shutdown
 * (drain pending embeds before the pool closes) AND by tests (makes indexing
 * synchronous). A timeout is NOT fatal — the next startup reconcile picks up
 * the remainder.
 */
export async function drainIndexQueue({ timeoutMs }: { timeoutMs: number }): Promise<void> {
  if (active === 0 && pending.size === 0 && inFlight.size === 0) return;
  const drain = ensureDrainPromise();
  kickDrain();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      rootLogger.warn({ queueDepth: pending.size, inFlight: inFlight.size }, 'ai.index.drain_timeout');
      resolve();
    }, timeoutMs);
  });
  await Promise.race([drain, timeout]);
  if (timer) clearTimeout(timer);
}

// ── Workers ────────────────────────────────────────────────────────────────

/** Single-card worker — `indexCards([cardId])`. */
export async function indexCard(cardId: string): Promise<void> {
  return indexCards([cardId]);
}

interface CardLoad {
  id: string;
  userId: string;
  noteId: string;
  deckId: string;
  renderText: string;
}

/**
 * Batch worker: load N cards (scoped by their own userId), skip those whose
 * stored `sourceHash` already matches, `chunkSource` → `embed` (≤EMBED_BATCH
 * texts/request) → upsert `kb_chunk` by `(card_id, position)`.
 *
 * This is the real fulfilment of the batched-embed mitigation; backfill /
 * reconcile / `POST /ai/reindex` all call it. No-op when embeddings are not
 * enabled (or degraded). Idempotent.
 */
export async function indexCards(ids: string[], opts: { log?: Logger } = {}): Promise<void> {
  if (!canIndex() || ids.length === 0) return;
  const model = env.ai.EMBEDDING_MODEL;
  const log = opts.log ?? rootLogger;

  // Load cards. Scoped by their own userId via the row itself — no cross-user
  // mixing because each chunk carries the card's userId.
  const rows = (await db
    .select({
      id: cards.id,
      userId: cards.userId,
      noteId: cards.noteId,
      deckId: cards.deckId,
      renderText: cards.renderText,
    })
    .from(cards)
    .where(inArray(cards.id, ids))) as CardLoad[];
  if (rows.length === 0) return;

  // Existing chunks for these cards (position 0) — to skip unchanged hashes.
  const existing = await db
    .select({ cardId: kbChunk.cardId, sourceHash: kbChunk.sourceHash })
    .from(kbChunk)
    .where(and(inArray(kbChunk.cardId, ids), eq(kbChunk.position, 0)));
  const existingHashByCard = new Map(existing.map((c) => [c.cardId, c.sourceHash]));

  // Decide which cards need a re-embed (content/hash changed). A matching hash
  // means the chunk is already current — nothing to do (no meta/tags column on
  // kb_chunk; tag-filtered retrieval reads the live notes row).
  interface Job {
    row: CardLoad;
    sourceHash: string;
    chunkText: string;
  }
  const jobs: Job[] = [];
  for (const row of rows) {
    // Skip empty render_text — no embeddable content, no chunk (matches the
    // empty-card-skip rule on the note side).
    if (!row.renderText || row.renderText.trim() === '') continue;
    const sourceHash = computeSourceHash(row.renderText, model);
    const prior = existingHashByCard.get(row.id);
    // hash matches an existing chunk → already current, skip the paid re-embed.
    if (prior === sourceHash) continue;
    const chunks = chunkSource({
      sourceType: 'card',
      sourceId: row.id,
      parentId: row.id,
      text: row.renderText,
    });
    const chunk = chunks[0]!;
    jobs.push({ row, sourceHash, chunkText: chunk.text });
  }
  if (jobs.length === 0) return;

  const toEmbed = jobs;

  // Embed the changed ones in sub-batches of EMBED_BATCH.
  for (let i = 0; i < toEmbed.length; i += EMBED_BATCH) {
    const slice = toEmbed.slice(i, i + EMBED_BATCH);
    const vectors = await embed(slice.map((j) => j.chunkText));
    const started = performance.now();
    for (let k = 0; k < slice.length; k++) {
      const j = slice[k]!;
      const vector = vectors[k];
      if (!vector) continue;
      await db
        .insert(kbChunk)
        .values({
          userId: j.row.userId,
          sourceType: 'card',
          sourceId: j.row.id,
          parentId: j.row.id,
          position: 0,
          text: j.chunkText,
          embedding: vector,
          embeddingModel: model,
          sourceHash: j.sourceHash,
          cardId: j.row.id,
        })
        .onConflictDoUpdate({
          target: [kbChunk.cardId, kbChunk.position],
          set: {
            text: j.chunkText,
            embedding: vector,
            embeddingModel: model,
            sourceHash: j.sourceHash,
            sourceType: 'card',
            sourceId: j.row.id,
            parentId: j.row.id,
            userId: j.row.userId,
            updatedAt: new Date(),
          },
        });
    }
    log.info(
      { chunks: slice.length, model, latencyMs: Math.round(performance.now() - started) },
      'ai.index',
    );
  }
}

// ── Reconcile-on-startup ──────────────────────────────────────────────────────

/**
 * Find cards with NO chunk OR a `sourceHash` mismatch and drain them via
 * `indexCards` in batches. Guarded by the effective embedding switch + the dim
 * assertion (run first). NEVER throws into the caller — it's kicked from
 * index.ts after listen and must degrade silently on failure.
 */
export async function reconcileOnStartup(): Promise<void> {
  try {
    if (!isEmbeddingEnabled()) return;
    await assertEmbeddingDim();
    if (dimMismatch) return;

    const model = env.ai.EMBEDDING_MODEL;
    // All cards left-joined to their position-0 chunk hash. A card needs
    // (re)indexing when the chunk is missing (NULL hash) OR the stored hash
    // differs from hash(render_text + current model). Empty render_text is
    // skipped (it would produce no chunk anyway).
    const rows = (await db
      .select({ id: cards.id, renderText: cards.renderText, sourceHash: kbChunk.sourceHash })
      .from(cards)
      .leftJoin(
        kbChunk,
        and(eq(kbChunk.cardId, cards.id), eq(kbChunk.position, 0)),
      )) as Array<{
      id: string;
      renderText: string;
      sourceHash: string | null;
    }>;

    const needIndex = rows
      .filter((c) => c.renderText && c.renderText.trim() !== '')
      .filter((c) => c.sourceHash !== computeSourceHash(c.renderText, model))
      .map((c) => c.id);

    if (needIndex.length === 0) {
      indexWorkerState.recover();
      rootLogger.info('ai.index.reconcile — nothing stale');
      return;
    }
    rootLogger.info({ count: needIndex.length }, 'ai.index.reconcile.start');
    for (let i = 0; i < needIndex.length; i += EMBED_BATCH) {
      const batch = needIndex.slice(i, i + EMBED_BATCH);
      indexWorkerState.enqueue(batch.length);
      indexWorkerState.start(batch.length);
      try {
        await indexCards(batch);
        indexWorkerState.succeed(batch.length);
      } catch (err) {
        indexWorkerState.fail('reconcile_failed', batch.length);
        throw err;
      }
    }
    rootLogger.info({ count: needIndex.length }, 'ai.index.reconcile.done');
  } catch (err) {
    indexWorkerState.recordFailure('reconcile_failed');
    rootLogger.error({ err }, 'ai.index.reconcile_failed — degrading');
  }
}

/** Enqueue every card belonging to a user (user-scoped reindex). Returns count. */
export async function reindexUser(
  userId: string,
  correlation?: LogCorrelation,
): Promise<number> {
  if (!canIndex()) return 0;
  const ids = await db
    .select({ id: cards.id })
    .from(cards)
    .where(eq(cards.userId, userId));
  for (const { id } of ids) enqueueIndex(id, correlation);
  return ids.length;
}
