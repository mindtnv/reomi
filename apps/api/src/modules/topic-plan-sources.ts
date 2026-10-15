// Each create commits on its own, and ingest starts only after that row
// exists. The youtube unique index ignores error rows, so a failed video is
// reused here instead of inserted again.

import { and, asc, eq, sql } from 'drizzle-orm';
import { db, notebookSources, sources, topicModuleSources, topicModules, topicPlans } from '@reomi/db';
import { parseYoutubeUrl } from '@reomi/shared';
import { env } from '../env.ts';
import {
  attachSourceToNotebook,
  countLibraryItems,
  countNotebookSources,
  createInlineSource,
  SourceInputError,
} from './sources-shared.ts';
import { normalizePlanUrl } from './plan-url.ts';

const URL_BATCH_MAX = 20;

export type SourceAddResult = {
  url: string;
  result: 'linked' | 'created' | 'invalid_url' | 'library_full' | 'too_many_sources';
  sourceId?: string;
};

function titleForUrl(url: string): string {
  const parsed = new URL(url);
  const path = parsed.pathname === '/' ? '' : parsed.pathname;
  const title = `${parsed.hostname}${path}${parsed.search}`.replace(/\/$/, '');
  return (title || parsed.hostname).slice(0, 300);
}

async function findOldestUrl(userId: string, normalized: string): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: sources.id, url: sources.url })
    .from(sources)
    .where(and(eq(sources.userId, userId), eq(sources.kind, 'url'), sql`${sources.status} <> 'deleting'`))
    .orderBy(asc(sources.createdAt), asc(sources.id));
  for (const row of rows) {
    if (row.url && normalizePlanUrl(row.url) === normalized) return { id: row.id };
  }
  return null;
}

async function isAttached(userId: string, notebookId: string, sourceId: string): Promise<boolean> {
  const [row] = await db
    .select({ sourceId: notebookSources.sourceId })
    .from(notebookSources)
    .where(
      and(
        eq(notebookSources.userId, userId),
        eq(notebookSources.notebookId, notebookId),
        eq(notebookSources.sourceId, sourceId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

async function linkModule(userId: string, moduleId: string, sourceId: string): Promise<void> {
  await db
    .insert(topicModuleSources)
    .values({ userId, moduleId, sourceId })
    .onConflictDoNothing({ target: [topicModuleSources.moduleId, topicModuleSources.sourceId] });
}

async function findOwnedYoutube(userId: string, canonicalUrl: string): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(
      and(
        eq(sources.userId, userId),
        eq(sources.kind, 'youtube'),
        eq(sources.url, canonicalUrl),
        sql`${sources.status} <> 'deleting'`,
      ),
    )
    .orderBy(asc(sources.createdAt), asc(sources.id))
    .limit(1);
  return row ?? null;
}

async function adoptSource(
  userId: string,
  notebookId: string,
  moduleId: string,
  sourceId: string,
  url: string,
): Promise<{ item: SourceAddResult; stopped: 'too_many_sources' | null }> {
  const attached = await isAttached(userId, notebookId, sourceId);
  if (!attached) {
    if ((await countNotebookSources(userId, notebookId)) >= env.ai.MAX_SOURCES_PER_NOTEBOOK) {
      return { item: { url, result: 'too_many_sources' }, stopped: 'too_many_sources' };
    }
    await attachSourceToNotebook(db, { userId, notebookId, sourceId });
  }
  await linkModule(userId, moduleId, sourceId);
  return { item: { url, result: 'linked', sourceId }, stopped: null };
}

export async function addModuleSources(
  userId: string,
  notebookId: string,
  moduleId: string,
  urls: string[],
): Promise<{ ok: true; items: SourceAddResult[] } | { ok: false; error: 'not_found' | 'invalid_plan' }> {
  if (urls.length < 1 || urls.length > URL_BATCH_MAX) return { ok: false, error: 'invalid_plan' };

  const [owned] = await db
    .select({ id: topicModules.id })
    .from(topicModules)
    .innerJoin(topicPlans, eq(topicPlans.id, topicModules.planId))
    .where(
      and(
        eq(topicModules.id, moduleId),
        eq(topicModules.userId, userId),
        eq(topicPlans.userId, userId),
        eq(topicPlans.notebookId, notebookId),
      ),
    )
    .limit(1);
  if (!owned) return { ok: false, error: 'not_found' };

  const items: SourceAddResult[] = [];
  let stopped: 'library_full' | 'too_many_sources' | null = null;

  for (const raw of urls) {
    const trimmed = raw.trim();
    if (stopped) {
      items.push({ url: trimmed, result: stopped });
      continue;
    }
    const normalized = normalizePlanUrl(raw);
    if (!normalized) {
      items.push({ url: trimmed, result: 'invalid_url' });
      continue;
    }

    const video = parseYoutubeUrl(normalized);
    if (!video.ok && video.reason === 'not_a_video') {
      items.push({ url: normalized, result: 'invalid_url' });
      continue;
    }
    if (video.ok) {
      const existingVideo = await findOwnedYoutube(userId, video.canonicalUrl);
      if (existingVideo) {
        const adopted = await adoptSource(userId, notebookId, moduleId, existingVideo.id, normalized);
        if (adopted.stopped) stopped = adopted.stopped;
        items.push(adopted.item);
        continue;
      }
    }

    const existing = await findOldestUrl(userId, normalized);
    if (existing) {
      const adopted = await adoptSource(userId, notebookId, moduleId, existing.id, normalized);
      if (adopted.stopped) stopped = adopted.stopped;
      items.push(adopted.item);
      continue;
    }

    if ((await countLibraryItems(userId)) >= env.ai.MAX_LIBRARY_ITEMS_PER_USER) {
      stopped = 'library_full';
      items.push({ url: normalized, result: stopped });
      continue;
    }
    if ((await countNotebookSources(userId, notebookId)) >= env.ai.MAX_SOURCES_PER_NOTEBOOK) {
      stopped = 'too_many_sources';
      items.push({ url: normalized, result: stopped });
      continue;
    }

    try {
      const row = await createInlineSource(
        userId,
        { kind: 'url', title: titleForUrl(normalized), url: normalized },
        notebookId,
      );
      await linkModule(userId, moduleId, row.id);
      items.push({ url: normalized, result: 'created', sourceId: row.id });
    } catch (err) {
      if (!(err instanceof SourceInputError)) throw err;
      const sourceId =
        err.existingSourceId ??
        (video.ok ? (await findOwnedYoutube(userId, video.canonicalUrl))?.id : undefined);
      if (err.code === 'duplicate_source' && sourceId) {
        const adopted = await adoptSource(userId, notebookId, moduleId, sourceId, normalized);
        if (adopted.stopped) stopped = adopted.stopped;
        items.push(adopted.item);
        continue;
      }
      items.push({ url: normalized, result: 'invalid_url' });
    }
  }

  return { ok: true, items };
}
