import { sourceOperationPresentation } from './source-operation-presentation';
import { libraryFolderScope } from './library-folders';
// Library module (L1) — the user's personal material store (`/library`). A
// "library item" IS a `sources` row (Р1 — the table is NOT renamed; the library
// is a UI/ownership concept over it). Sources are user-level now (notebooks
// attach via `notebook_sources`), so this module owns the source LIFECYCLE
// (create/presign/finalize/delete) shared with the legacy notebook routes via
// `sources-shared.ts`, plus reading-state + metadata that are library-only.
//
//   GET    /library                       — paginated list + filters + aggregates.
//   POST   /library/items                 — inline url/text create (+ optional attach).
//   POST   /library/items/presign         — pdf/epub claim + presign.
//   POST   /library/items/:id/finalize    — verify + dedup + enqueue (+ optional attach).
//   GET    /library/items/:id             — one item: metadata + status + notebooks + cardCount.
//   PATCH  /library/items/:id             — edit metadata (title/author/description/tags/readingStatus).
//   DELETE /library/items/:id             — full source delete (edges cascade, card tombstones).
//   PUT    /library/items/:id/reading-state — upsert reading position/status.
//
// Every query is `user.id`-FIRST-conjunct scoped; a foreign/missing id is 404.

import { Elysia, t } from 'elysia';
import { and, asc, count, countDistinct, desc, eq, gt, ilike, inArray, lt, or, sql } from 'drizzle-orm';
import {
  cardSources,
  db,
  media,
  notebooks,
  notebookSources,
  sourceChunks,
  sourceReadingState,
  sources,
  type Source,
} from '@reomi/db';
import { authPlugin } from '../auth-plugin.ts';
import { embeddingEnabled, env } from '../env.ts';
import { embed, isEmbeddingEnabled } from '../ai/openai-client.ts';
import { retrieveDocuments } from '../ai/retrieve-documents.ts';
import { requestLogFromContext } from '../logger.ts';
import {
  countLibraryItems,
  createInlineSource,
  SourceInputError,
  deleteSourceCompletely,
  finalizeUploadSource,
  MAX_INLINE_TEXT,
  presignUploadSource,
  reingestSource,
} from './sources-shared.ts';

const LIBRARY_PAGE = env.ai.LIBRARY_PAGE;
const MAX_LIBRARY_PAGE = 200;

// Metadata caps (explicit-field PATCH).
const TITLE_MAX = 300;
const AUTHOR_MAX = 500;
const DESCRIPTION_MAX = 2000;
const TAGS_MAX = 32;
const TAG_LEN_MAX = 64;
const LANGUAGE_MAX = 16;

// Semantic search over the library (§8.3).
const LIBRARY_SEARCH_DEFAULT = 20;
const LIBRARY_SEARCH_MAX = 50;
const SEARCH_HITS_PER_SOURCE = 5;
const SEARCH_SNIPPET_LEN = 300;

type ReadingStatus = 'unread' | 'reading' | 'finished';
const READING_STATUSES = new Set<ReadingStatus>(['unread', 'reading', 'finished']);

/**
 * Shape one library item for the list/detail response. The aggregate columns
 * (indexed/notebookCount/cardCount/readingStatus/percent) are joined in by the
 * caller's query (no N+1) and merged here.
 */
interface LibraryItemAggregates {
  indexed: number;
  notebookCount: number;
  cardCount: number;
  readingStatus: ReadingStatus;
  percent: number | null;
}

function shapeLibraryItem(s: Source, agg: LibraryItemAggregates): Record<string, unknown> {
  return {
    ...sourceOperationPresentation(),
    metadataRevision: s.metadataRevision,
    id: s.id,
    kind: s.kind,
    folderId: s.folderId,
    title: s.title,
    author: s.author,
    description: s.description,
    language: s.language,
    tags: s.tags,
    status: s.status,
    errorCode: s.errorCode,
    indexed: agg.indexed,
    total: s.chunkCount ?? 0,
    readingStatus: agg.readingStatus,
    percent: agg.percent,
    pageCount: s.pageCount,
    byteSize: s.byteSize,
    coverMediaId: s.coverMediaId,
    // Stored `/m/<uuid>` token. The web resolves it to the session-checked
    // media route; null when the item has no cover.
    coverUrl: s.coverMediaId ? `/m/${s.coverMediaId}` : null,
    notebookCount: agg.notebookCount,
    cardCount: agg.cardCount,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

export const libraryModule = new Elysia({ prefix: '/library' })
  .use(authPlugin)
  // ── list ─────────────────────────────────────────────────────────────────────
  // Paginated material list with filters + one-query aggregates. Filters: q
  // (ILIKE title|author), kind, tag (array containment), reading (status), shelf
  // (reading|unattached). Sort: added (created_at DESC, default) | title |
  // lastRead (reading-state updated_at DESC NULLS LAST). Every sort uses
  // a stable keyset cursor with an id tiebreaker.
  .get(
    '/',
    async ({ user, query, status }) => {
      const rawLimit = Number(query.limit ?? LIBRARY_PAGE);
      const limit = Math.max(
        1,
        Math.min(MAX_LIBRARY_PAGE, Number.isFinite(rawLimit) ? rawLimit : LIBRARY_PAGE),
      );

      // Per-source aggregate subqueries (correlated, one SELECT — no N+1).
      const indexedSq = db
        .select({
          sourceId: sourceChunks.sourceId,
          indexed: count().as('indexed'),
        })
        .from(sourceChunks)
        .where(eq(sourceChunks.embedded, true))
        .groupBy(sourceChunks.sourceId)
        .as('indexed_sq');
      const notebookSq = db
        .select({
          sourceId: notebookSources.sourceId,
          notebookCount: count().as('notebook_count'),
        })
        .from(notebookSources)
        .groupBy(notebookSources.sourceId)
        .as('notebook_sq');
      const cardSq = db
        .select({
          sourceId: cardSources.sourceId,
          cardCount: countDistinct(cardSources.cardId).as('card_count'),
        })
        .from(cardSources)
        .groupBy(cardSources.sourceId)
        .as('card_sq');

      const conditions = [
        eq(sources.userId, user.id),
        sql`${sources.status} <> 'deleting'`,
      ];
      const folderScope = await libraryFolderScope(user.id, query.folderId);
      if (folderScope) conditions.push(folderScope);
      if (query.q) {
        const pat = `%${query.q}%`;
        conditions.push(or(ilike(sources.title, pat), ilike(sources.author, pat))!);
      }
      if (query.kind) conditions.push(eq(sources.kind, query.kind));
      if (query.tag) conditions.push(sql`${sources.tags} @> ARRAY[${query.tag}]::text[]`);
      // reading filter: unread = no reading-state row OR status='unread'.
      if (query.reading === 'unread') {
        conditions.push(
          sql`(${sourceReadingState.status} IS NULL OR ${sourceReadingState.status} = 'unread')`,
        );
      } else if (query.reading === 'reading' || query.reading === 'finished') {
        conditions.push(eq(sourceReadingState.status, query.reading));
      }
      // shelf: reading = status 'reading'; unattached = no notebook edges.
      if (query.shelf === 'reading') {
        conditions.push(eq(sourceReadingState.status, 'reading'));
      } else if (query.shelf === 'unattached') {
        conditions.push(sql`${notebookSq.notebookCount} IS NULL`);
      }
      // Opaque cursors carry all sort keys. The legacy added-sort ISO/id
      // format remains accepted for existing clients.
      const sort = query.sort ?? 'added';
      const readKey = sql`coalesce(${sourceReadingState.updatedAt}, '-infinity'::timestamptz)`;
      if (query.cursor?.startsWith('v2.')) {
        try {
          const cursor = JSON.parse(Buffer.from(query.cursor.slice(3), 'base64url').toString()) as { sort: string; id: string; title: string; readAt: string | null; createdAt: string };
          if (cursor.sort !== sort || typeof cursor.createdAt !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(cursor.id) || Number.isNaN(new Date(cursor.createdAt).getTime())) throw new Error('invalid_cursor');
          const tie = or(lt(sources.createdAt, new Date(cursor.createdAt)), and(eq(sources.createdAt, new Date(cursor.createdAt)), lt(sources.id, cursor.id)))!;
          if (sort === 'title') {
            if (typeof cursor.title !== 'string') throw new Error('invalid_cursor');
            conditions.push(or(gt(sources.title, cursor.title), and(eq(sources.title, cursor.title), gt(sources.id, cursor.id)))!);
          } else if (sort === 'lastRead') {
            if (cursor.readAt !== null && (typeof cursor.readAt !== 'string' || Number.isNaN(new Date(cursor.readAt).getTime()))) throw new Error('invalid_cursor');
            const key = cursor.readAt ?? '-infinity';
            conditions.push(sql`(${readKey} < ${key}::timestamptz OR (${readKey} = ${key}::timestamptz AND ${tie}))`);
          } else conditions.push(tie);
        } catch { return status(400, { error: 'invalid_cursor' }); }
      } else if (query.cursor) {
        const us = query.cursor.lastIndexOf('_');
        const isoPart = us === -1 ? query.cursor : query.cursor.slice(0, us);
        const idPart = us === -1 ? null : query.cursor.slice(us + 1);
        const parsed = new Date(isoPart);
        if (!Number.isNaN(parsed.getTime())) {
          conditions.push(
            idPart
              ? or(
                  lt(sources.createdAt, parsed),
                  and(eq(sources.createdAt, parsed), lt(sources.id, idPart)),
                )!
              : lt(sources.createdAt, parsed),
          );
        }
      }

      const orderBy =
        query.sort === 'title'
          ? [asc(sources.title), asc(sources.id)]
          : query.sort === 'lastRead'
            ? [sql`${readKey} DESC`, desc(sources.createdAt), desc(sources.id)]
            : [desc(sources.createdAt), desc(sources.id)];

      const rows = await db
        .select({
          source: sources,
          indexed: indexedSq.indexed,
          notebookCount: notebookSq.notebookCount,
          cardCount: cardSq.cardCount,
          readingStatus: sourceReadingState.status,
          percent: sourceReadingState.percent,
          lastReadAt: sourceReadingState.updatedAt,
        })
        .from(sources)
        .leftJoin(
          sourceReadingState,
          and(
            eq(sourceReadingState.sourceId, sources.id),
            eq(sourceReadingState.userId, user.id),
          ),
        )
        .leftJoin(indexedSq, eq(indexedSq.sourceId, sources.id))
        .leftJoin(notebookSq, eq(notebookSq.sourceId, sources.id))
        .leftJoin(cardSq, eq(cardSq.sourceId, sources.id))
        .where(and(...conditions))
        .orderBy(...orderBy)
        .limit(limit + 1);

      const page = rows.slice(0, limit);

      const items = page.map((r) =>
        shapeLibraryItem(r.source, {
          indexed: Number(r.indexed ?? 0),
          notebookCount: Number(r.notebookCount ?? 0),
          cardCount: Number(r.cardCount ?? 0),
          readingStatus: (r.readingStatus as ReadingStatus) ?? 'unread',
          percent: r.percent ?? null,
        }),
      );

      // nextCursor only for the default added-sort keyset (a full page implies
      // more). Composite `<iso>_<id>` so the next page's tiebreaker resumes
      // exactly after the last row even when created_at ties.
      const last = page.at(-1);
      const nextCursor = rows.length > limit && last
        ? `v2.${Buffer.from(JSON.stringify({ sort, id: last.source.id, title: last.source.title, createdAt: last.source.createdAt.toISOString(), readAt: last.lastReadAt?.toISOString() ?? null })).toString('base64url')}`
        : null;

      return { items, nextCursor };
    },
    {
      auth: true,
      query: t.Object({
        q: t.Optional(t.String({ maxLength: 200 })),
        kind: t.Optional(t.String({ maxLength: 16 })),
        tag: t.Optional(t.String({ maxLength: TAG_LEN_MAX })),
        reading: t.Optional(
          t.Union([t.Literal('unread'), t.Literal('reading'), t.Literal('finished')]),
        ),
        shelf: t.Optional(t.Union([t.Literal('reading'), t.Literal('unattached')])),
        sort: t.Optional(
          t.Union([t.Literal('added'), t.Literal('title'), t.Literal('lastRead')]),
        ),
        limit: t.Optional(t.String()),
        cursor: t.Optional(t.String()),
        folderId: t.Optional(t.Union([t.String({ format: 'uuid' }), t.Literal('unfiled')])),
      }),
    },
  )
  // ── semantic search across the whole library (§8.3) ───────────────────────────
  // embed(q) → retrieveDocuments over ALL of the user's ready sources → group by
  // source (groups sorted by max score, ≤SEARCH_HITS_PER_SOURCE hits each, hits
  // by score). Degrades to `{ groups: [], reason }` (200, never 5xx) when
  // embeddings are off or the corpus is empty. Empty q → 400.
  .get(
    '/search',
    async ({ user, query, status }) => {
      const q = (query.q ?? '').trim();
      if (!q) return status(400, { error: 'empty_query' });
      const folderScope = await libraryFolderScope(user.id, query.folderId);
      const rawLimit = Number(query.limit ?? LIBRARY_SEARCH_DEFAULT);
      const limit = Math.max(
        1,
        Math.min(
          LIBRARY_SEARCH_MAX,
          Number.isFinite(rawLimit) ? rawLimit : LIBRARY_SEARCH_DEFAULT,
        ),
      );

      // Embeddings off (env flag AND no injected fake) ⇒ degrade with a reason.
      if (!embeddingEnabled && !isEmbeddingEnabled()) {
        return { groups: [], reason: 'embedding_disabled' as const };
      }

      // Scope = ALL of the caller's ready sources (the whole library).
      const readyRows = await db
        .select({ id: sources.id })
        .from(sources)
        .where(and(eq(sources.userId, user.id), eq(sources.status, 'ready'), folderScope));
      const sourceIds = readyRows.map((r) => r.id);
      if (sourceIds.length === 0) {
        return { groups: [], reason: 'no_sources' as const };
      }

      // The paid embed call can throw (gateway 5xx, network, dim assertion). Per
      // the search-degrade contract (200, never 5xx), fall back to an empty
      // result with a machine reason instead of a 500.
      let queryEmbedding: number[] | undefined;
      try {
        [queryEmbedding] = await embed([q]);
      } catch {
        return { groups: [], reason: 'embedding_failed' as const };
      }
      if (!queryEmbedding || queryEmbedding.length === 0) {
        return { groups: [], reason: 'embedding_disabled' as const };
      }

      // Pull more than `limit` raw hits so grouping + per-source cap still yields
      // up to `limit` groups (a single source could otherwise eat the budget).
      const hits = await retrieveDocuments({
        userId: user.id,
        queryEmbedding,
        k: Math.min(limit * SEARCH_HITS_PER_SOURCE, LIBRARY_SEARCH_MAX * SEARCH_HITS_PER_SOURCE),
        sourceIds,
      });
      if (hits.length === 0) return { groups: [] };

      // Source metadata (kind/title/author/cover) for the group headers.
      const hitSourceIds = [...new Set(hits.map((h) => h.sourceId))];
      const metaRows = await db
        .select({
          id: sources.id,
          kind: sources.kind,
          title: sources.title,
          author: sources.author,
          coverMediaId: sources.coverMediaId,
        })
        .from(sources)
        .where(and(eq(sources.userId, user.id), inArray(sources.id, hitSourceIds)));
      const metaById = new Map(metaRows.map((m) => [m.id, m]));

      // Group hits by source, keep best SEARCH_HITS_PER_SOURCE per source.
      interface GroupAcc {
        maxScore: number;
        hits: {
          sourceChunkId: string;
          position: number;
          page: number | null;
          heading: string | null;
          snippet: string;
          score: number;
        }[];
      }
      const groups = new Map<string, GroupAcc>();
      for (const h of hits) {
        let g = groups.get(h.sourceId);
        if (!g) {
          g = { maxScore: h.score, hits: [] };
          groups.set(h.sourceId, g);
        }
        g.maxScore = Math.max(g.maxScore, h.score);
        if (g.hits.length < SEARCH_HITS_PER_SOURCE) {
          g.hits.push({
            sourceChunkId: h.sourceChunkId,
            position: h.position,
            page: h.page ?? null,
            heading: h.heading ?? null,
            snippet: h.text.slice(0, SEARCH_SNIPPET_LEN),
            score: h.score,
          });
        }
      }

      const out = [...groups.entries()]
        .map(([sourceId, g]) => {
          const m = metaById.get(sourceId);
          return {
            source: {
              id: sourceId,
              kind: m?.kind ?? 'pdf',
              title: m?.title ?? '',
              author: m?.author ?? null,
              coverUrl: m?.coverMediaId ? `/m/${m.coverMediaId}` : null,
            },
            hits: g.hits.slice().sort((a, b) => b.score - a.score),
            maxScore: g.maxScore,
          };
        })
        .sort((a, b) => b.maxScore - a.maxScore)
        .slice(0, limit)
        .map(({ maxScore: _omit, ...rest }) => rest);

      return { groups: out };
    },
    {
      auth: true,
      query: t.Object({
        q: t.Optional(t.String({ maxLength: 500 })),
        limit: t.Optional(t.String()),
        folderId: t.Optional(t.Union([t.String({ format: 'uuid' }), t.Literal('unfiled')])),
      }),
    },
  )
  // ── inline create (url / text) ────────────────────────────────────────────────
  // Mirrors the notebook source-create (minus the per-notebook cap) + an optional
  // `notebookId` that attaches in the same tx (Р8). Enforces the per-user cap.
  .post(
    '/items',
    async (context) => {
      const { user, body, status } = context;
      const log = requestLogFromContext(context);
      if ((await countLibraryItems(user.id)) >= env.ai.MAX_LIBRARY_ITEMS_PER_USER) {
        return status(409, { error: 'library_full' });
      }
      if (body.notebookId) {
        const [nb] = await db
          .select({ id: notebooks.id })
          .from(notebooks)
          .where(and(eq(notebooks.id, body.notebookId), eq(notebooks.userId, user.id)))
          .limit(1);
        if (!nb) return status(404, { error: 'not_found' });
      }
      try {
        return await createInlineSource(
          user.id,
          body.kind === 'url'
            ? { kind: 'url', title: body.title, url: body.url, folderId: body.folderId }
            : { kind: 'text', title: body.title, text: body.text, folderId: body.folderId },
          body.notebookId,
          log,
        );
      } catch (err) {
        if (err instanceof SourceInputError) {
          return status(err.status, err.existingSourceId
            ? { error: err.code, existingSourceId: err.existingSourceId }
            : { error: err.code });
        }
        throw err;
      }
    },
    {
      auth: true,
      body: t.Union([
        t.Object({
          kind: t.Literal('url'),
          title: t.String({ minLength: 1, maxLength: TITLE_MAX }),
          url: t.String({ minLength: 1, maxLength: 2000 }),
          notebookId: t.Optional(t.String({ format: 'uuid' })),
          folderId: t.Optional(t.Union([t.String({ format: 'uuid' }), t.Null()])),
        }),
        t.Object({
          kind: t.Literal('text'),
          title: t.String({ minLength: 1, maxLength: TITLE_MAX }),
          text: t.String({ minLength: 1, maxLength: MAX_INLINE_TEXT }),
          notebookId: t.Optional(t.String({ format: 'uuid' })),
          folderId: t.Optional(t.Union([t.String({ format: 'uuid' }), t.Null()])),
        }),
      ]),
    },
  )
  // ── presign (pdf / epub) ──────────────────────────────────────────────────────
  // Claim a uuid + presign a POST policy. The optional notebook attach lands at
  // finalize (the upload may never complete). Enforces the per-user cap up front.
  .post(
    '/items/presign',
    async (context) => {
      const { user, body, status } = context;
      const log = requestLogFromContext(context);
      if ((await countLibraryItems(user.id)) >= env.ai.MAX_LIBRARY_ITEMS_PER_USER) {
        return status(409, { error: 'library_full' });
      }
      const res = await presignUploadSource(user.id, body, log);
      if (!res.ok) {
        const code = res.error === 'source_conflict' ? 409 : 400;
        return status(code, { error: res.error });
      }
      return { sourceId: res.sourceId, upload: res.upload };
    },
    {
      auth: true,
      body: t.Object({
        title: t.String({ minLength: 1, maxLength: TITLE_MAX }),
        mime: t.String({ maxLength: 128 }),
        size: t.Integer({ minimum: 0 }),
        folderId: t.Optional(t.Union([t.String({ format: 'uuid' }), t.Null()])),
      }),
    },
  )
  // Verify the uploaded object + per-user byte dedup + enqueue ingest, then
  // optionally attach to a notebook. 409 `duplicate_source` carries the existing
  // source id so the UI can offer "attach the existing one instead".
  .post(
    '/items/:id/finalize',
    async (context) => {
      const { user, params, body, status } = context;
      const log = requestLogFromContext(context);
      if (body.notebookId) {
        const [nb] = await db
          .select({ id: notebooks.id })
          .from(notebooks)
          .where(and(eq(notebooks.id, body.notebookId), eq(notebooks.userId, user.id)))
          .limit(1);
        if (!nb) return status(404, { error: 'not_found' });
      }
      const res = await finalizeUploadSource(user.id, params.id, body.notebookId, log);
      if (!res.ok) {
        return status(res.status, {
          error: res.error,
          ...(res.existingSourceId ? { existingSourceId: res.existingSourceId } : {}),
        });
      }
      return res.source;
    },
    {
      auth: true,
      params: t.Object({ id: t.String({ format: 'uuid' }) }),
      body: t.Object({ notebookId: t.Optional(t.String({ format: 'uuid' })) }),
    },
  )
  // ── detail ─────────────────────────────────────────────────────────────────────
  // One item: metadata + ingest status/progress + reading state + the notebooks
  // it's attached to + cardCount. 404 if foreign.
  .get(
    '/items/:id',
    async ({ user, params, status }) => {
      const [source] = await db
        .select()
        .from(sources)
        .where(and(eq(sources.id, params.id), eq(sources.userId, user.id)))
        .limit(1);
      if (!source) return status(404, { error: 'not_found' });

      const [[indexedRow], [cardRow], [readingRow], notebookRows] = await Promise.all([
        db
          .select({ n: count() })
          .from(sourceChunks)
          .where(and(eq(sourceChunks.sourceId, params.id), eq(sourceChunks.embedded, true))),
        db
          .select({ n: countDistinct(cardSources.cardId) })
          .from(cardSources)
          .where(and(eq(cardSources.userId, user.id), eq(cardSources.sourceId, params.id))),
        db
          .select({
            status: sourceReadingState.status,
            percent: sourceReadingState.percent,
            page: sourceReadingState.page,
            chunkPos: sourceReadingState.chunkPos,
          })
          .from(sourceReadingState)
          .where(
            and(
              eq(sourceReadingState.sourceId, params.id),
              eq(sourceReadingState.userId, user.id),
            ),
          )
          .limit(1),
        db
          .select({ id: notebooks.id, title: notebooks.title })
          .from(notebookSources)
          .innerJoin(notebooks, eq(notebooks.id, notebookSources.notebookId))
          .where(
            and(
              eq(notebookSources.userId, user.id),
              eq(notebookSources.sourceId, params.id),
            ),
          )
          .orderBy(desc(notebookSources.addedAt)),
      ]);

      const shaped = shapeLibraryItem(source, {
        indexed: indexedRow?.n ?? 0,
        notebookCount: notebookRows.length,
        cardCount: cardRow?.n ?? 0,
        readingStatus: (readingRow?.status as ReadingStatus) ?? 'unread',
        percent: readingRow?.percent ?? null,
      });
      // L2 — the reader restores its exact position from the persisted page
      // (PDF) / chunkPos (text); null when never opened (falls back to the
      // localStorage nn:pdf:pos cache + one-time migration PUT).
      const readingState = readingRow
        ? {
            status: (readingRow.status as ReadingStatus) ?? 'unread',
            page: readingRow.page ?? null,
            chunkPos: readingRow.chunkPos ?? null,
            percent: readingRow.percent ?? null,
          }
        : null;
      return { ...shaped, notebooks: notebookRows, readingState };
    },
    { auth: true, params: t.Object({ id: t.String({ format: 'uuid' }) }) },
  )
  // ── edit metadata ────────────────────────────────────────────────────────────
  // EXPLICIT field mapping (no body spread — a stray key never reaches a column).
  // title 1..300 / author ≤500 / description ≤2000 / tags ≤32×≤64. readingStatus
  // upserts source_reading_state.status. Empty body → 400 nothing_to_update.
  .patch(
    '/items/:id',
    async ({ user, params, body, status }) => {
      const [source] = await db
        .select({ id: sources.id })
        .from(sources)
        .where(and(eq(sources.id, params.id), eq(sources.userId, user.id)))
        .limit(1);
      if (!source) return status(404, { error: 'not_found' });

      const patch: Record<string, unknown> = {};
      if (body.title !== undefined) {
        const title = body.title.trim();
        if (title.length < 1 || title.length > TITLE_MAX) {
          return status(400, { error: 'invalid_metadata' });
        }
        patch.title = title;
      }
      if (body.author !== undefined) {
        patch.author = body.author.length === 0 ? null : body.author.slice(0, AUTHOR_MAX);
      }
      if (body.description !== undefined) {
        patch.description =
          body.description.length === 0 ? null : body.description.slice(0, DESCRIPTION_MAX);
      }
      if (body.tags !== undefined) {
        if (body.tags.length > TAGS_MAX) return status(400, { error: 'invalid_metadata' });
        const tags: string[] = [];
        for (const raw of body.tags) {
          const tag = raw.trim().slice(0, TAG_LEN_MAX);
          if (tag.length === 0) continue;
          if (!tags.includes(tag)) tags.push(tag);
        }
        patch.tags = tags;
      }
      // language — BCP-47-ish short string; empty ⇒ NULL.
      if (body.language !== undefined) {
        const lang = body.language.trim();
        if (lang.length > LANGUAGE_MAX) return status(400, { error: 'invalid_metadata' });
        patch.language = lang.length === 0 ? null : lang;
      }
      // pageCount — positive int (PDF: client-set on first open alongside cover).
      if (body.pageCount !== undefined) {
        if (!Number.isInteger(body.pageCount) || body.pageCount < 1) {
          return status(400, { error: 'invalid_metadata' });
        }
        patch.pageCount = body.pageCount;
      }
      // coverMediaId — must reference the CALLER'S OWN VERIFIED media row, else
      // 400 invalid_media (never recorded). Empty string clears the cover.
      if (body.coverMediaId !== undefined) {
        if (body.coverMediaId.length === 0) {
          patch.coverMediaId = null;
        } else {
          const [m] = await db
            .select({ id: media.id })
            .from(media)
            .where(
              and(
                eq(media.id, body.coverMediaId),
                eq(media.userId, user.id),
                eq(media.verified, true),
              ),
            )
            .limit(1);
          if (!m) return status(400, { error: 'invalid_media' });
          patch.coverMediaId = body.coverMediaId;
        }
      }

      const hasMetaPatch = Object.keys(patch).length > 0;
      const hasReading = body.readingStatus !== undefined;
      if (!hasMetaPatch && !hasReading) return status(400, { error: 'nothing_to_update' });

      let row = source;
      if (hasMetaPatch) {
        patch.updatedAt = new Date();
        const [updated] = await db
          .update(sources)
          .set(patch)
          .where(and(eq(sources.id, params.id), eq(sources.userId, user.id)))
          .returning();
        if (updated) row = updated;
      }

      if (hasReading) {
        const readingStatus = body.readingStatus as ReadingStatus;
        if (!READING_STATUSES.has(readingStatus)) {
          return status(400, { error: 'invalid_metadata' });
        }
        await db
          .insert(sourceReadingState)
          .values({ userId: user.id, sourceId: params.id, status: readingStatus })
          .onConflictDoUpdate({
            target: [sourceReadingState.sourceId, sourceReadingState.userId],
            set: { status: readingStatus, updatedAt: new Date() },
          });
      }

      // Return the (possibly) updated source row.
      const [out] = await db
        .select()
        .from(sources)
        .where(and(eq(sources.id, params.id), eq(sources.userId, user.id)))
        .limit(1);
      return out ?? row;
    },
    {
      auth: true,
      params: t.Object({ id: t.String({ format: 'uuid' }) }),
      body: t.Object({
        title: t.Optional(t.String({ maxLength: TITLE_MAX + 1 })),
        author: t.Optional(t.String({ maxLength: AUTHOR_MAX + 1 })),
        description: t.Optional(t.String({ maxLength: DESCRIPTION_MAX + 1 })),
        tags: t.Optional(t.Array(t.String({ maxLength: TAG_LEN_MAX + 1 }), { maxItems: TAGS_MAX + 1 })),
        readingStatus: t.Optional(t.String({ maxLength: 16 })),
        language: t.Optional(t.String({ maxLength: LANGUAGE_MAX + 8 })),
        pageCount: t.Optional(t.Integer()),
        coverMediaId: t.Optional(t.String({ maxLength: 64 })),
      }),
    },
  )
  // ── delete ─────────────────────────────────────────────────────────────────────
  // Full source delete (the shared flow): kb_chunk cleanup + cascade edges +
  // card_sources tombstones + S3. 404 if foreign.
  .delete(
    '/items/:id',
    async ({ user, params, status }) => {
      const ok = await deleteSourceCompletely(user.id, params.id);
      if (!ok) return status(404, { error: 'not_found' });
      return { ok: true };
    },
    { auth: true, params: t.Object({ id: t.String({ format: 'uuid' }) }) },
  )
  // ── reingest ───────────────────────────────────────────────────────────────────
  // Re-run ingest through the CAS state machine (§4.1): 409 `not_terminal` if the
  // source is mid-flight, 400 `not_reingestable` for text (no external carrier),
  // 404 if foreign. Wipes source_chunks + document kb_chunk vectors + CAS
  // ready|error → pending, then kicks the worker. The source falls out of every
  // notebook's chat scope (status ≠ ready) until it re-indexes.
  .post(
    '/items/:id/reingest',
    async (context) => {
      const { user, params, status } = context;
      const log = requestLogFromContext(context);
      const res = await reingestSource(user.id, params.id, log);
      if (!res.ok) return status(res.status, { error: res.error });
      // `parked` ⇒ embeddings off/degraded: the source re-parses but defers
      // (re)embedding — the client surfaces the existing setup-notice.
      return { ok: true, parked: res.parked };
    },
    { auth: true, params: t.Object({ id: t.String({ format: 'uuid' }) }) },
  )
  // ── reading state ──────────────────────────────────────────────────────────────
  // Upsert reading position/percent. The first progress PUT (or any PUT on an
  // 'unread'/absent row) flips status → 'reading'; 'finished' is set ONLY via
  // PATCH readingStatus. page/chunkPos are non-negative ints, percent ∈ [0,1].
  .put(
    '/items/:id/reading-state',
    async ({ user, params, body, status }) => {
      const [source] = await db
        .select({ id: sources.id })
        .from(sources)
        .where(and(eq(sources.id, params.id), eq(sources.userId, user.id)))
        .limit(1);
      if (!source) return status(404, { error: 'not_found' });

      const [existing] = await db
        .select({ status: sourceReadingState.status })
        .from(sourceReadingState)
        .where(
          and(
            eq(sourceReadingState.sourceId, params.id),
            eq(sourceReadingState.userId, user.id),
          ),
        )
        .limit(1);

      // A progress PUT moves unread→reading; an already-'finished'/'reading' row
      // keeps its status (a manual 'finished' isn't undone by a stray scroll).
      const nextStatus = existing?.status === undefined || existing.status === 'unread'
        ? 'reading'
        : existing.status;

      const set: Record<string, unknown> = { status: nextStatus, updatedAt: new Date() };
      if (body.page !== undefined) set.page = body.page;
      if (body.chunkPos !== undefined) set.chunkPos = body.chunkPos;
      if (body.percent !== undefined) set.percent = body.percent;

      await db
        .insert(sourceReadingState)
        .values({
          userId: user.id,
          sourceId: params.id,
          status: nextStatus,
          page: body.page ?? null,
          chunkPos: body.chunkPos ?? null,
          percent: body.percent ?? null,
        })
        .onConflictDoUpdate({
          target: [sourceReadingState.sourceId, sourceReadingState.userId],
          set,
        });
      return { ok: true, status: nextStatus };
    },
    {
      auth: true,
      params: t.Object({ id: t.String({ format: 'uuid' }) }),
      body: t.Object({
        page: t.Optional(t.Integer({ minimum: 0 })),
        chunkPos: t.Optional(t.Integer({ minimum: 0 })),
        percent: t.Optional(t.Number({ minimum: 0, maximum: 1 })),
      }),
    },
  );
