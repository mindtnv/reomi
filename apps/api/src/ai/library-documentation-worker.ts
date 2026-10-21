import { and, asc, count, eq, inArray, ne, sql } from 'drizzle-orm';
import { db, kbChunk, libraryDocumentation as collections, libraryDocumentationPages as pages, libraryFolders, sources, sourceChunks } from '@reomi/db';
import { chunkSource, storedDocVersion } from '@reomi/shared';
import { env } from '../env';
import { newOperationRun } from '../operation-run';
import { documentationWorkerState } from '../runtime-state';
import { rootLogger, safeError } from '../logger';
import { DirectPageReader, type PageContent } from './page-reader';
import { computeSourceHash } from './index-queue';
import { enqueueSource } from './source-ingest';
import { lockLibraryFolders } from '../modules/library-folders';
import { sourceUrlMap, type DocumentationCollection } from '../modules/library-documentation-service';
import { runDueDocumentationCheck } from './library-documentation-scheduler';

type Page = typeof pages.$inferSelect;
let running: Promise<void> | null = null;
let stopping = false;
let controller: AbortController | null = null;
let activeCollectionId: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/** Persistent rows own the queue; process memory only prevents redundant pumps. */
export function wakeDocumentationWorker() {
  if (env.NODE_ENV === 'test' || stopping || running) return;
  running = pump().catch(err => {
    documentationWorkerState.recordFailure('documentation_worker_failed');
    rootLogger.warn({ err: safeError(err) }, 'documentation.worker_failed');
  }).finally(() => { running = null; });
}

export function interruptDocumentationFetch(id: string) {
  if (activeCollectionId === id) controller?.abort();
}

async function pump() {
  let checkedSchedule = false;
  while (!stopping) {
    const [next] = await db.select({ id: collections.id }).from(collections).where(eq(collections.state, 'queued')).orderBy(asc(collections.updatedAt)).limit(1);
    if (!next) {
      if (!checkedSchedule) { checkedSchedule = true; if (await runDueDocumentationCheck()) continue; }
      break;
    }
    await runDocumentationCollection(next.id);
  }
}

export async function recoverDocumentationImports() {
  await db.update(collections).set({ state: 'queued', runId: sql`uuidv7()`, updatedAt: new Date() }).where(eq(collections.state, 'running'));
}

export async function startDocumentationWorker() {
  if (env.NODE_ENV === 'test') return;
  stopping = false;
  await recoverDocumentationImports();
  timer = setInterval(wakeDocumentationWorker, 5000);
  timer.unref();
  wakeDocumentationWorker();
}

export async function drainDocumentationWorker(timeoutMs: number) {
  stopping = true;
  if (timer) clearInterval(timer); timer = null;
  controller?.abort();
  if (!running) return;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([running, new Promise<void>(resolve => { deadline = setTimeout(resolve, Math.max(1, timeoutMs)); })]);
  if (deadline) clearTimeout(deadline);
}

/** Also used by deterministic integration tests; no timer, session or model is needed. */
export async function runDocumentationCollection(id: string) {
  const [collection] = await db.update(collections).set({ state: 'running', updatedAt: new Date() })
    .where(and(eq(collections.id, id), eq(collections.state, 'queued'))).returning();
  if (!collection?.runId) return;
  documentationWorkerState.start();
  const abort = new AbortController(); controller = abort; activeCollectionId = id;
  try {
    while (!abort.signal.aborted) {
      const [live] = await db.select({ state: collections.state, runId: collections.runId }).from(collections).where(eq(collections.id, id));
      if (live?.state !== 'running' || live.runId !== collection.runId) return;
      const [page] = await db.select().from(pages).where(and(eq(pages.userId, collection.userId), eq(pages.collectionId, id), eq(pages.state, 'pending'))).orderBy(asc(pages.id)).limit(1);
      if (!page) break;
      try {
        if (page.imported && !page.sourceId) {
          await markPage(collection, page, 'deleted', null); continue;
        }
        const root = new URL(collection.rootUrl);
        const fetched = await new DirectPageReader().read(page.url, { signal: abort.signal,
          scope: { origin: root.origin, pathPrefix: root.pathname, canonicalPath: new URL(page.url).pathname } });
        if (abort.signal.aborted) return;
        const sourceId = await savePage(collection, page, fetched);
        if (sourceId && !stopping && env.NODE_ENV !== 'test') enqueueSource(sourceId);
      } catch (err) {
        if (abort.signal.aborted) return;
        const code = err instanceof DocumentationWorkerError ? err.message : 'fetch_failed';
        await markPage(collection, page, 'error', code);
        if (code === 'documentation_folder_missing') {
          await db.update(collections).set({ state: 'attention', errorCode: code, updatedAt: new Date() })
            .where(and(eq(collections.id, id), eq(collections.runId, collection.runId), eq(collections.state, 'running')));
          return;
        }
      }
    }
    if (abort.signal.aborted) return;
    const outcomes = await db.select({ state: pages.state, change: pages.lastChange, n: count() }).from(pages)
      .where(and(eq(pages.userId, collection.userId), eq(pages.collectionId, id))).groupBy(pages.state, pages.lastChange);
    const lastResult = { added: 0, updated: 0, unchanged: 0, failed: 0, missing: 0, completedAt: new Date().toISOString() };
    for (const outcome of outcomes) {
      if (outcome.state === 'error') lastResult.failed += Number(outcome.n);
      else if (outcome.state === 'missing') lastResult.missing += Number(outcome.n);
      else if (outcome.state === 'ready' && outcome.change) lastResult[outcome.change] += Number(outcome.n);
    }
    await db.update(collections).set({ state: lastResult.failed + lastResult.missing ? 'attention' : 'completed', errorCode: null,
      checkedAt: new Date(), updatedAt: new Date(), lastResult })
      .where(and(eq(collections.id, id), eq(collections.runId, collection.runId), eq(collections.state, 'running')));
    documentationWorkerState.recover();
  } catch (error) {
    documentationWorkerState.recordFailure('documentation_worker_failed');
    await db.update(collections).set({ state: 'attention', errorCode: 'documentation_worker_failed', updatedAt: new Date() })
      .where(and(eq(collections.id, id), eq(collections.runId, collection.runId), eq(collections.state, 'running')));
    throw error;
  } finally {
    if (controller === abort) { controller = null; activeCollectionId = null; }
    documentationWorkerState.complete();
  }
}

class DocumentationWorkerError extends Error {}

async function markPage(collection: DocumentationCollection, page: Page, state: Page['state'], errorCode: string | null) {
  await db.transaction(async tx => {
    const [live] = await tx.select({ id: collections.id }).from(collections).where(and(eq(collections.id, collection.id),
      eq(collections.userId, collection.userId), eq(collections.runId, collection.runId!), eq(collections.state, 'running'))).for('update');
    if (!live) return;
    await tx.update(pages).set({ state, errorCode, checkedAt: new Date() }).where(and(eq(pages.userId, collection.userId), eq(pages.id, page.id)));
  });
}

async function savePage(collection: DocumentationCollection, page: Page, fetched: PageContent): Promise<string | null> {
  if (!fetched.text.trim()) throw new DocumentationWorkerError('empty_source');
  const chunks = chunkSource({ sourceType: 'document', sourceId: page.sourceId ?? page.id, parentId: page.sourceId ?? page.id,
    text: '', units: [{ text: fetched.text, heading: fetched.title }],
    chunkOptions: { tokensPerChunk: env.ai.SOURCE_CHUNK_TOKENS, overlap: env.ai.SOURCE_CHUNK_OVERLAP } });
  if (!chunks.length || chunks.length > env.ai.MAX_SOURCE_CHUNKS) throw new DocumentationWorkerError('too_many_chunks');
  return db.transaction(async tx => {
    await lockLibraryFolders(tx, collection.userId);
    const [live] = await tx.select().from(collections).where(and(eq(collections.id, collection.id), eq(collections.userId, collection.userId),
      eq(collections.runId, collection.runId!), eq(collections.state, 'running'))).for('update');
    if (!live) return null;
    // Source deletion takes the source row before its FK updates the page row.
    if (page.sourceId) await tx.select({ id: sources.id }).from(sources)
      .where(and(eq(sources.id, page.sourceId), eq(sources.userId, live.userId))).for('update');
    const [currentPage] = await tx.select().from(pages).where(and(eq(pages.id, page.id), eq(pages.userId, live.userId))).for('update');
    if (!currentPage || currentPage.state !== 'pending') return null;
    if (currentPage.imported && !currentPage.sourceId) {
      await tx.update(pages).set({ state: 'deleted', errorCode: null }).where(eq(pages.id, page.id)); return null;
    }
    if (!live.folderId) throw new DocumentationWorkerError('documentation_folder_missing');
    const destinationId = live.sectionFolders[page.section];
    if (!destinationId) throw new DocumentationWorkerError('documentation_folder_missing');
    const folderRows = await tx.select({ id: libraryFolders.id }).from(libraryFolders).where(and(eq(libraryFolders.userId, live.userId), inArray(libraryFolders.id, [live.folderId, destinationId])));
    if (!folderRows.some(f => f.id === destinationId) || !folderRows.some(f => f.id === live.folderId)) throw new DocumentationWorkerError('documentation_folder_missing');
    let sourceId = currentPage.sourceId, added = false;
    if (!sourceId) {
      const existing = await tx.select({ id: sources.id, url: sources.url, kind: sources.kind }).from(sources).where(and(eq(sources.userId, live.userId), ne(sources.status, 'deleting')));
      sourceId = sourceUrlMap(existing).get(page.url) ?? null;
      if (!sourceId) {
        if (existing.length >= env.ai.MAX_LIBRARY_ITEMS_PER_USER) throw new DocumentationWorkerError('library_full');
        const [created] = await tx.insert(sources).values({ userId: live.userId, kind: 'url', url: page.url,
          title: (fetched.title || page.title).slice(0, 300), folderId: destinationId,
          docVersion: storedDocVersion(new URL(live.rootUrl).hostname), verified: true, status: 'indexing', ...newOperationRun() }).returning();
        sourceId = created!.id;
        added = true;
      }
    }
    const [source] = await tx.select().from(sources).where(and(eq(sources.id, sourceId), eq(sources.userId, live.userId))).for('update');
    if (!source || source.status === 'deleting') {
      await tx.update(pages).set({ state: 'deleted', imported: true, sourceId: null }).where(eq(pages.id, page.id)); return null;
    }
    if (source.status === 'pending' || source.status === 'parsing') throw new DocumentationWorkerError('source_busy');
    const oldChunks = await tx.select().from(sourceChunks).where(and(eq(sourceChunks.userId, live.userId), eq(sourceChunks.sourceId, sourceId))).orderBy(asc(sourceChunks.position));
    const changed = oldChunks.length !== chunks.length || chunks.some((chunk, i) => chunk.text !== oldChunks[i]?.text || (chunk.heading ?? null) !== oldChunks[i]?.heading);
    if (changed) {
      await tx.delete(kbChunk).where(and(eq(kbChunk.userId, live.userId), eq(kbChunk.sourceType, 'document'), eq(kbChunk.sourceId, sourceId)));
      await tx.delete(sourceChunks).where(and(eq(sourceChunks.userId, live.userId), eq(sourceChunks.sourceId, sourceId)));
      await tx.insert(sourceChunks).values(chunks.map(chunk => ({ userId: live.userId, sourceId: sourceId!, position: chunk.position,
        text: chunk.text, heading: chunk.heading ?? null, tokenCount: chunk.tokenCount ?? null,
        embedded: false, sourceHash: computeSourceHash(chunk.text, env.ai.EMBEDDING_MODEL) })));
      await tx.update(sources).set({ status: 'indexing', ...newOperationRun(), errorCode: null,
        charCount: fetched.text.length, chunkCount: chunks.length, updatedAt: new Date() }).where(eq(sources.id, sourceId));
    }
    await tx.update(pages).set({ sourceId, imported: true, state: 'ready', errorCode: null,
      lastChange: added ? 'added' : changed ? 'updated' : 'unchanged', checkedAt: new Date() }).where(eq(pages.id, page.id));
    return changed ? sourceId : null;
  });
}
