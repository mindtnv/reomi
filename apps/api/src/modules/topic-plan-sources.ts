// Add the URLs the user accepted for one module. Each create commits on its
// own and ingest starts only after that row exists. A later URL that would
// pass a cap is not inserted; earlier rows stay.

import { and, asc, eq, sql } from 'drizzle-orm';
import { db, notebookSources, sources, topicModuleSources, topicModules, topicPlans } from '@reomi/db';
import { env } from '../env.ts';
import {
  attachSourceToNotebook,
  countLibraryItems,
  countNotebookSources,
  createInlineSource,
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

    const existing = await findOldestUrl(userId, normalized);
    if (existing) {
      const attached = await isAttached(userId, notebookId, existing.id);
      if (!attached) {
        if ((await countNotebookSources(userId, notebookId)) >= env.ai.MAX_SOURCES_PER_NOTEBOOK) {
          stopped = 'too_many_sources';
          items.push({ url: normalized, result: stopped });
          continue;
        }
        await attachSourceToNotebook(db, { userId, notebookId, sourceId: existing.id });
      }
      await linkModule(userId, moduleId, existing.id);
      items.push({ url: normalized, result: 'linked', sourceId: existing.id });
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

    const row = await createInlineSource(userId, { kind: 'url', title: titleForUrl(normalized), url: normalized }, notebookId);
    await linkModule(userId, moduleId, row.id);
    items.push({ url: normalized, result: 'created', sourceId: row.id });
  }

  return { ok: true, items };
}
