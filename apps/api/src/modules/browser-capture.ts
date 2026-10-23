import { createHash } from 'node:crypto';
import { Elysia, t } from 'elysia';
import { and, asc, desc, eq, ne } from 'drizzle-orm';
import { browserCaptures, db, libraryFolders, sourceChunks, sources } from '@reomi/db';
import { chunkSource, normalizeSourceText } from '@reomi/shared';
import { authPlugin } from '../auth-plugin';
import { env } from '../env';
import { authenticateToken } from '../mcp/tokens';
import { newOperationRun } from '../operation-run';
import { rateLimitCheck } from '../rate-limit';
import { computeSourceHash } from '../ai/index-queue';
import { enqueueSource } from '../ai/source-ingest';
import { ensureBrowserFolder, lockLibraryFolders, validateLibraryFolder } from './library-folders';
import { reservedUrls, sourceUrlMap } from './library-documentation-service';

export class CaptureError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 410, code: string) { super(code); }
}
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const fingerprint = (chunks: { text: string; heading?: string | null }[]) => digest(JSON.stringify(chunks.map(c => [c.text, c.heading ?? null])));
const sourceText = (ex: Tx | typeof db, userId: string, sourceId: string) => ex.select({ id: sourceChunks.id, text: sourceChunks.text, heading: sourceChunks.heading }).from(sourceChunks)
  .where(and(eq(sourceChunks.userId, userId), eq(sourceChunks.sourceId, sourceId))).orderBy(asc(sourceChunks.position));
function normalizedUrl(input: string) {
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    url.hash = ''; return url.href;
  } catch { throw new CaptureError(400, 'invalid_url'); }
}
const bodySchema = t.Object({
  requestKey: t.String({ format: 'uuid' }), url: t.String({ minLength: 1, maxLength: 2000 }),
  title: t.String({ minLength: 1, maxLength: 300 }), text: t.String({ minLength: 1, maxLength: 200_000 }),
  mode: t.Union([t.Literal('page'), t.Literal('selection')]),
  folderId: t.Optional(t.Union([t.String({ format: 'uuid' }), t.Null()])),
  locale: t.Optional(t.Union([t.Literal('ru'), t.Literal('en')])),
});
type CaptureInput = typeof bodySchema.static;
function receiptResult(receipt: typeof browserCaptures.$inferSelect) {
  if (!receipt.sourceId) throw new CaptureError(410, 'capture_source_deleted');
  return { receiptId: receipt.id, sourceId: receipt.sourceId, readerUrl: `/library/${receipt.sourceId}?capture=${receipt.id}` };
}

async function saveCapture(userId: string, input: CaptureInput) {
  const url = normalizedUrl(input.url), text = input.text.trim(), title = input.title.trim();
  if (!text || !title || (input.mode === 'selection' && text.length > 4000)) throw new CaptureError(400, 'invalid_capture');
  const chunks = chunkSource({ sourceType: 'document', sourceId: input.requestKey, parentId: input.requestKey,
    text: '', units: [{ text, heading: title }],
    chunkOptions: { tokensPerChunk: input.mode === 'selection' ? 1000 : env.ai.SOURCE_CHUNK_TOKENS, overlap: input.mode === 'selection' ? 0 : env.ai.SOURCE_CHUNK_OVERLAP } });
  if (!chunks.length || chunks.length > env.ai.MAX_SOURCE_CHUNKS) throw new CaptureError(400, 'invalid_capture');
  const contentKey = digest(JSON.stringify([url, input.mode, text])), sourceFingerprint = fingerprint(chunks);
  const requestHash = digest(JSON.stringify([url, title, text, input.mode, input.folderId === undefined ? 'browser' : input.folderId, input.locale ?? 'en']));
  const result = await db.transaction(async tx => {
    await lockLibraryFolders(tx, userId);
    const [prior] = await tx.select().from(browserCaptures).where(and(eq(browserCaptures.userId, userId), eq(browserCaptures.requestKey, input.requestKey)));
    if (prior) {
      if (prior.requestHash !== requestHash) throw new CaptureError(409, 'capture_request_conflict');
      if (!prior.sourceId) throw new CaptureError(410, 'capture_source_deleted');
      const [live] = await tx.select().from(sources).where(and(eq(sources.userId, userId), eq(sources.id, prior.sourceId))).for('share');
      if (!live || live.status === 'deleting') throw new CaptureError(410, 'capture_source_deleted');
      return { receipt: prior, enqueue: null };
    }
    await validateLibraryFolder(tx, userId, input.folderId);
    const candidates = await tx.select().from(browserCaptures).where(and(eq(browserCaptures.userId, userId), eq(browserCaptures.contentKey, contentKey)))
      .orderBy(desc(browserCaptures.createdAt)).limit(10);
    let sourceId: string | undefined, savedFingerprint = sourceFingerprint;
    for (const candidate of candidates) {
      if (!candidate.sourceId) continue;
      const [live] = await tx.select().from(sources).where(and(eq(sources.userId, userId), eq(sources.id, candidate.sourceId))).for('update');
      if (live && !['deleting', 'pending', 'parsing'].includes(live.status) && fingerprint(await sourceText(tx, userId, live.id)) === candidate.sourceFingerprint) { sourceId = live.id; savedFingerprint = candidate.sourceFingerprint; break; }
    }
    let enqueue: string | null = null;
    if (!sourceId) {
      const active = await tx.select({ id: sources.id, url: sources.url, kind: sources.kind }).from(sources).where(and(eq(sources.userId, userId), ne(sources.status, 'deleting')));
      const existing = sourceUrlMap(active); existing.set(url, 'new-capture');
      const reserved = await reservedUrls(userId, tx);
      if (active.length + [...reserved].filter(value => !existing.has(value)).length >= env.ai.MAX_LIBRARY_ITEMS_PER_USER) throw new CaptureError(409, 'library_full');
      const folderId = input.folderId === undefined ? (await ensureBrowserFolder(tx, userId, input.locale === 'ru' ? 'Из браузера' : 'From browser')).id : input.folderId;
      const [source] = await tx.insert(sources).values({ userId, kind: 'url', url, title, folderId, verified: true,
        status: 'indexing', charCount: text.length, chunkCount: chunks.length, ...newOperationRun() }).returning();
      sourceId = source!.id; enqueue = sourceId;
      await tx.insert(sourceChunks).values(chunks.map(chunk => ({ userId, sourceId: sourceId!, position: chunk.position,
        text: chunk.text, heading: chunk.heading ?? null, tokenCount: chunk.tokenCount ?? null, embedded: false,
        sourceHash: computeSourceHash(chunk.text, env.ai.EMBEDDING_MODEL) })));
    }
    const [receipt] = await tx.insert(browserCaptures).values({ userId, requestKey: input.requestKey, requestHash, contentKey,
      sourceId, sourceFingerprint: savedFingerprint, mode: input.mode, quote: input.mode === 'selection' ? text : null }).returning();
    return { receipt: receipt!, enqueue };
  });
  if (result.enqueue) enqueueSource(result.enqueue);
  return receiptResult(result.receipt);
}

export const browserCaptureModule = new Elysia({ prefix: '/extension' })
  .derive(async ({ request }) => ({ capturePrincipal: await authenticateToken(request) }))
  .onBeforeHandle(({ capturePrincipal, request, status }) => {
    if (!capturePrincipal || capturePrincipal.scope !== 'capture') return status(401, { error: 'invalid_token' });
    const origin = request.headers.get('origin');
    if (origin && origin !== env.WEB_ORIGIN && !/^(chrome-extension:\/\/[a-p]{32}|moz-extension:\/\/[a-f0-9-]{36})$/i.test(origin)) return status(403, { error: 'untrusted_origin' });
    if (!rateLimitCheck(capturePrincipal.user.id, { bucket: 'browser:capture', limit: 60, windowMs: 60_000 }).allowed) return status(429, { error: 'rate_limited' });
  })
  .onAfterHandle(({ set }) => { set.headers['cache-control'] = 'no-store'; })
  .get('/connection', async ({ capturePrincipal }) => ({ user: { id: capturePrincipal!.user.id, name: capturePrincipal!.user.name },
    folders: await db.select({ id: libraryFolders.id, name: libraryFolders.name, parentId: libraryFolders.parentId, purpose: libraryFolders.purpose })
      .from(libraryFolders).where(eq(libraryFolders.userId, capturePrincipal!.user.id)).orderBy(asc(libraryFolders.name)) }))
  .post('/captures', ({ capturePrincipal, body }) => saveCapture(capturePrincipal!.user.id, body), { body: bodySchema });

export const browserCaptureHandoffModule = new Elysia({ prefix: '/library/captures' }).use(authPlugin)
  .get('/:id', async ({ user, params }) => {
    const [receipt] = await db.select().from(browserCaptures).where(and(eq(browserCaptures.userId, user.id), eq(browserCaptures.id, params.id)));
    if (!receipt) throw new CaptureError(404, 'capture_not_found');
    if (!receipt.sourceId) throw new CaptureError(410, 'capture_source_deleted');
    const [source] = await db.select().from(sources).where(and(eq(sources.userId, user.id), eq(sources.id, receipt.sourceId), ne(sources.status, 'deleting')));
    if (!source) throw new CaptureError(410, 'capture_source_deleted');
    const chunks = await sourceText(db, user.id, source.id);
    if (fingerprint(chunks) !== receipt.sourceFingerprint || !chunks[0]) throw new CaptureError(409, 'capture_source_changed');
    const first = chunks[0], rendered = normalizeSourceText(first.text), quote = rendered.slice(0, 4000);
    return { sourceId: source.id, sourceVersion: source.updatedAt.toISOString(), quote, mode: receipt.mode,
      textSelection: { version: 1 as const, quote, chunks: [{ chunkId: first.id, textHash: digest(first.text), renderedHash: digest(rendered), start: 0, end: quote.length }] } };
  }, { auth: true, params: t.Object({ id: t.String({ format: 'uuid' }) }) });
