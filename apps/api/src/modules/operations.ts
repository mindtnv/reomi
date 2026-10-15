import { Elysia, t } from 'elysia';
import { db, notebookArtifacts, sources, notebooks } from '@reomi/db';
import { and, eq, ne, sql } from 'drizzle-orm';
import { OPERATION_GROUPS, type OperationDestination, type OperationGroup, type OperationItem, type OperationPage, type OperationsFeed } from '@reomi/shared';
import { authPlugin } from '../auth-plugin';
import { isArtifactGenerationEnabled, isEmbeddingEnabled } from '../ai/openai-client';
import { embeddingDegraded } from '../ai/index-queue';
import { StudyError } from './study-notes';
import { OperationCooldownError, retryOperation } from './operation-retry';
import { requestLogFromContext } from '../logger';

type FeedQuery = { limit?: number; activeCursor?: string; attentionCursor?: string; recentCursor?: string };
type Cursor = { group: OperationGroup; at: string; kind: string; id: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function readCursor(value: string | undefined, group: OperationGroup): Cursor | null {
  if (!value) return null;
  try {
    if (value.length > 512) throw new Error();
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (parsed.group !== group || !['source', 'artifact'].includes(parsed.kind) || !uuid.test(parsed.id)
      || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(parsed.at) || !Number.isFinite(Date.parse(parsed.at))) throw new Error();
    return parsed;
  } catch { throw new StudyError(400, 'invalid_cursor'); }
}

/** One bounded SQL projection. Only presentation metadata crosses the API. */
export async function listOperations(userId: string, query: FeedQuery = {}): Promise<OperationsFeed> {
  const limit = Math.max(1, Math.min(50, query.limit ?? 20));
  const cursors = Object.fromEntries(OPERATION_GROUPS.map(group => [group, readCursor(query[`${group}Cursor`], group)])) as Record<OperationGroup, Cursor | null>;
  const embedding = isEmbeddingEnabled() && !embeddingDegraded();
  const generation = isArtifactGenerationEnabled();
  const now = new Date();
  const since = new Date(now.getTime() - 7 * 86400_000).toISOString();
  const projection = sql`
    WITH jobs AS (
      SELECT 'source'::text AS kind, s.id, s.operation_run_id AS run_id, left(s.title, 200) AS title,
        NULL::text AS artifact_type, s.operation_started_at AS started_at, s.operation_finished_at AS finished_at,
        CASE WHEN s.status = 'indexing' AND NOT ${embedding} THEN 'search_unavailable'
          WHEN s.status = 'indexing' THEN 'search_preparing' WHEN s.status = 'pending' THEN 'queued'
          WHEN s.status = 'error' THEN 'failed' ELSE s.status END AS phase,
        (s.kind = 'pdf' AND s.storage_key IS NOT NULL OR COALESCE(s.chunk_count, 0) > 0 OR s.status = 'ready') AS can_read,
        (s.status = 'ready' AND ${embedding}) AS can_search,
        s.chunk_count AS total, s.id AS source_id, NULL::uuid AS notebook_id,
        (s.kind <> 'text' OR s.error_code = 'index_failed') AS retry_source,
        NOT (s.error_code = 'index_failed' AND NOT ${embedding}) AS retry_service,
        false AS needs_defaults,
        CASE WHEN s.status IN ('pending','parsing') OR (s.status = 'indexing' AND ${embedding}) THEN 'active'
          WHEN s.status IN ('error','indexing') THEN 'attention' ELSE 'recent' END AS group_name,
        CASE WHEN s.status IN ('pending','parsing') OR (s.status = 'indexing' AND ${embedding})
          THEN COALESCE(s.operation_started_at, s.created_at) ELSE COALESCE(s.operation_finished_at, s.operation_started_at, s.created_at) END AS sort_at
      FROM sources s WHERE s.user_id = ${userId} AND s.verified AND s.status <> 'deleting' AND s.operation_run_id IS NOT NULL
        AND (s.status IN ('pending','parsing','indexing') OR s.operation_finished_at >= ${since})
      UNION ALL
      SELECT 'artifact', a.id, a.operation_run_id, left(a.title, 200), a.type, a.operation_started_at, a.operation_finished_at,
        CASE WHEN a.status = 'pending' THEN 'queued' WHEN a.status = 'error' THEN 'failed' ELSE a.status END,
        false, false, NULL::integer, a.source_id, a.notebook_id,
        CASE WHEN a.owner_kind = 'source' THEN EXISTS (SELECT 1 FROM sources s WHERE s.id = a.source_id AND s.user_id = ${userId}
          AND (s.status IN ('ready','indexing') OR s.status = 'error' AND s.error_code = 'index_failed'))
          ELSE EXISTS (SELECT 1 FROM sources s WHERE s.id IN (SELECT jsonb_array_elements_text(a.source_ids)::uuid)
            AND s.user_id = ${userId} AND s.status = 'ready') END,
        ${generation}, (a.type = 'quiz' AND a.generation_options IS NULL),
        CASE WHEN a.status IN ('pending','generating') THEN 'active' WHEN a.status = 'error' THEN 'attention' ELSE 'recent' END,
        CASE WHEN a.status IN ('pending','generating') THEN COALESCE(a.operation_started_at, a.created_at)
          ELSE a.operation_finished_at END
      FROM notebook_artifacts a WHERE a.user_id = ${userId} AND a.operation_run_id IS NOT NULL
        AND (a.status IN ('pending','generating') OR a.operation_finished_at >= ${since})
    ), visible AS (SELECT * FROM jobs WHERE group_name = 'active' OR sort_at >= ${since})`;
  const pages = await Promise.all(OPERATION_GROUPS.map(async group => {
    const cursor = cursors[group];
    const next = cursor ? group === 'active'
      ? sql`AND (sort_at, kind, id) > (${cursor.at}::timestamptz, ${cursor.kind}, ${cursor.id}::uuid)`
      : sql`AND (sort_at, kind, id) < (${cursor.at}::timestamptz, ${cursor.kind}, ${cursor.id}::uuid)` : sql``;
    const order = group === 'active' ? sql`sort_at ASC, kind ASC, id ASC` : sql`sort_at DESC, kind DESC, id DESC`;
    const [result] = await db.execute(sql`${projection}
      SELECT (SELECT count(*)::integer FROM visible WHERE group_name = ${group}) AS total,
        COALESCE((SELECT jsonb_agg(p) FROM (SELECT *,
          to_char(sort_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at,
          CASE WHEN kind = 'source' AND phase = 'search_preparing' THEN
            (SELECT count(*)::integer FROM source_chunks c WHERE c.source_id = visible.id AND c.embedded)
            ELSE NULL END AS completed
          FROM visible WHERE group_name = ${group} ${next} ORDER BY ${order} LIMIT ${limit + 1}) p), '[]'::jsonb) AS items`);
    const rows = result!.items as Array<Record<string, any>>;
    const items: OperationItem[] = rows.slice(0, limit).map(row => ({
      id: row.id, kind: row.kind, runId: row.run_id, title: row.title, artifactType: row.artifact_type,
      phase: row.phase, canRead: row.can_read, canSearch: row.can_search,
      progress: row.completed !== null && row.total > 0 ? { completed: Math.min(row.completed, row.total), total: row.total } : null,
      startedAt: row.started_at, finishedAt: row.finished_at,
      retry: { allowed: row.phase === 'failed' && row.retry_source && row.retry_service,
        reason: row.phase !== 'failed' ? 'not_failed' : !row.retry_source ? 'source_unavailable' : !row.retry_service ? 'ai_unavailable' : null,
        needsDefaults: row.needs_defaults },
      destination: row.kind === 'source' ? { kind: 'source', id: row.id }
        : row.notebook_id ? { kind: 'notebook-artifact', id: row.id, notebookId: row.notebook_id }
          : { kind: 'source-artifact', id: row.id, sourceId: row.source_id },
    }));
    const last = rows[limit - 1];
    const page: OperationPage = { items, total: Number(result!.total), nextCursor: rows.length > limit && last
      ? Buffer.from(JSON.stringify({ group, at: last.cursor_at, kind: last.kind, id: last.id })).toString('base64url') : null };
    return [group, page] as const;
  }));
  return { ...Object.fromEntries(pages), serverTime: now.toISOString() } as OperationsFeed;
}

/** Resolve only navigation metadata; opening the reader owns the content read. */
export async function resolveOperationResult(userId: string, id: string): Promise<{ destination: OperationDestination }> {
  const [row] = await db.select({ id: notebookArtifacts.id, status: notebookArtifacts.status, ownerKind: notebookArtifacts.ownerKind,
    sourceId: sources.id, notebookId: notebooks.id }).from(notebookArtifacts)
    .leftJoin(sources, and(eq(sources.id, notebookArtifacts.sourceId), eq(sources.userId, userId), ne(sources.status, 'deleting')))
    .leftJoin(notebooks, and(eq(notebooks.id, notebookArtifacts.notebookId), eq(notebooks.userId, userId)))
    .where(and(eq(notebookArtifacts.userId, userId), eq(notebookArtifacts.id, id))).limit(1);
  if (!row || row.ownerKind === 'notebook' && !row.notebookId) throw new StudyError(404, 'not_found');
  if (row.status !== 'ready') throw new StudyError(409, 'result_changed');
  return { destination: row.ownerKind === 'notebook'
    ? { kind: 'notebook-artifact', id: row.id, notebookId: row.notebookId! }
    : { kind: 'source-artifact', id: row.id, sourceId: row.sourceId } };
}

export const operationsModule = new Elysia({ prefix: '/operations/v1' }).use(authPlugin)
  .get('', ({ user, query }) => listOperations(user.id, query), { auth: true, query: t.Object({
    limit: t.Optional(t.Integer({ minimum: 1, maximum: 50 })),
    activeCursor: t.Optional(t.String({ maxLength: 512 })), attentionCursor: t.Optional(t.String({ maxLength: 512 })),
    recentCursor: t.Optional(t.String({ maxLength: 512 })),
  }) })
  .get('/artifacts/:id', ({ user, params }) => resolveOperationResult(user.id, params.id), { auth: true, params: t.Object({ id: t.String({ format: 'uuid' }) }) })
  .post('/retry', async context => {
    try { return await retryOperation(context.user.id, context.body, requestLogFromContext(context)); }
    catch (error) {
      if (error instanceof OperationCooldownError) return context.status(429, { error: 'cooldown', retryAfterMs: error.retryAfterMs });
      throw error;
    }
  }, { auth: true, body: t.Object({ kind: t.Union([t.Literal('source'), t.Literal('artifact')]),
    id: t.String({ format: 'uuid' }), runId: t.String({ format: 'uuid' }), requestId: t.String({ format: 'uuid' }),
    acceptDefaults: t.Optional(t.Boolean()),
  }) });
