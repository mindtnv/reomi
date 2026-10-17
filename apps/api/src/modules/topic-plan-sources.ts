// Each create commits on its own, and ingest starts only after that row
// exists. The youtube unique index ignores error rows, so a failed video is
// reused here instead of inserted again.

import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import { db, notebookSources, sources, topicModuleSources, topicModules, topicPlans } from '@reomi/db';
import {
  isDiscoverySeed,
  parseYoutubeUrl,
  referenceLinksToAdd,
  type PlanPage,
  type ReferenceCatalog,
} from '@reomi/shared';
import { env } from '../env.ts';
import { enqueueSource } from '../ai/source-ingest.ts';
import { rootLogger, safeError } from '../logger.ts';
import { newOperationRun } from '../operation-run.ts';
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

/**
 * A docs root is a seed, not a library page. The brand keeps that root out of
 * the page insert unless a caller casts it on purpose.
 */
declare const pageUrlBrand: unique symbol;
declare const seedUrlBrand: unique symbol;
type PageUrl = string & { readonly [pageUrlBrand]: true };
type SeedUrl = string & { readonly [seedUrlBrand]: true };

type PlanTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type PlanWave = { kind: 'fetch' } | { kind: 'hold' };
type PageStop = 'library_full' | 'too_many_sources' | null;

function classifyPlanUrl(raw: string): { kind: 'page'; url: PageUrl } | { kind: 'seed'; url: SeedUrl } | null {
  const normalized = normalizePlanUrl(raw);
  if (!normalized) return null;
  if (isDiscoverySeed(normalized)) return { kind: 'seed', url: normalized as SeedUrl };
  return { kind: 'page', url: normalized as PageUrl };
}

async function ownedModule(userId: string, notebookId: string, moduleId: string) {
  const [row] = await db
    .select({ id: topicModules.id, planId: topicModules.planId, position: topicModules.position })
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
  return row ?? null;
}

async function countInTx(tx: PlanTx, userId: string, notebookId: string): Promise<{ library: number; notebook: number }> {
  const [library] = await tx
    .select({ n: count() })
    .from(sources)
    .where(and(eq(sources.userId, userId), sql`${sources.status} <> 'deleting'`));
  const [notebook] = await tx
    .select({ n: count() })
    .from(notebookSources)
    .where(and(eq(notebookSources.userId, userId), eq(notebookSources.notebookId, notebookId)));
  return { library: library?.n ?? 0, notebook: notebook?.n ?? 0 };
}

async function findUrlInTx(tx: PlanTx, userId: string, normalized: string) {
  const rows = await tx
    .select({
      id: sources.id,
      url: sources.url,
      status: sources.status,
      verified: sources.verified,
    })
    .from(sources)
    .where(and(eq(sources.userId, userId), eq(sources.kind, 'url'), sql`${sources.status} <> 'deleting'`))
    .orderBy(asc(sources.createdAt), asc(sources.id));
  for (const row of rows) {
    if (row.url && normalizePlanUrl(row.url) === normalized) return row;
  }
  return null;
}

async function linkedAlready(tx: PlanTx, userId: string, notebookId: string, sourceId: string): Promise<boolean> {
  const [row] = await tx
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

async function moduleIsReleased(tx: PlanTx, userId: string, moduleId: string, position: number): Promise<boolean> {
  if (position <= 1) return true;
  const rows = await tx
    .select({ status: sources.status })
    .from(topicModuleSources)
    .innerJoin(sources, eq(sources.id, topicModuleSources.sourceId))
    .where(
      and(eq(topicModuleSources.userId, userId), eq(topicModuleSources.moduleId, moduleId), eq(sources.userId, userId)),
    );
  return rows.some((row) => row.status !== 'planned');
}

async function linkModuleTx(tx: PlanTx, userId: string, moduleId: string, sourceId: string): Promise<void> {
  await tx
    .insert(topicModuleSources)
    .values({ userId, moduleId, sourceId })
    .onConflictDoNothing({ target: [topicModuleSources.moduleId, topicModuleSources.sourceId] });
}

function pageTitle(page: PlanPage, url: string): string {
  const title = page.title.trim() || titleForUrl(url);
  return title.slice(0, 300);
}

export async function savePlanPages(input: {
  userId: string;
  notebookId: string;
  moduleId: string;
  wave: PlanWave;
  docVersion: string | null;
  catalog: ReferenceCatalog | null;
  pages: readonly PlanPage[];
}): Promise<PageStop> {
  const owned = await ownedModule(input.userId, input.notebookId, input.moduleId);
  if (!owned) return null;
  const outcome = await db.transaction(async (tx) => {
    const counts = await countInTx(tx, input.userId, input.notebookId);
    let library = counts.library;
    let notebook = counts.notebook;
    let stopped: PageStop = null;
    const fetchIds: string[] = [];
    for (const page of input.pages) {
      const classified = classifyPlanUrl(page.url);
      if (!classified || classified.kind === 'seed') continue;
      const url = classified.url;
      if (stopped) continue;
      const existing = await findUrlInTx(tx, input.userId, url);
      if (existing) {
        const attached = await linkedAlready(tx, input.userId, input.notebookId, existing.id);
        if (!attached) {
          if (notebook >= env.ai.MAX_SOURCES_PER_NOTEBOOK) {
            stopped = 'too_many_sources';
            continue;
          }
          await attachSourceToNotebook(tx, {
            userId: input.userId,
            notebookId: input.notebookId,
            sourceId: existing.id,
          });
          notebook += 1;
        }
        await linkModuleTx(tx, input.userId, input.moduleId, existing.id);
        if (input.wave.kind === 'fetch' && existing.status === 'planned' && existing.verified) {
          const [promoted] = await tx
            .update(sources)
            .set({ status: 'pending', ...newOperationRun(), updatedAt: new Date() })
            .where(and(eq(sources.id, existing.id), eq(sources.status, 'planned'), eq(sources.verified, true)))
            .returning({ id: sources.id });
          if (promoted) fetchIds.push(promoted.id);
        }
        continue;
      }
      if (library >= env.ai.MAX_LIBRARY_ITEMS_PER_USER) {
        stopped = 'library_full';
        continue;
      }
      if (notebook >= env.ai.MAX_SOURCES_PER_NOTEBOOK) {
        stopped = 'too_many_sources';
        continue;
      }
      const fetching = input.wave.kind === 'fetch';
      const [created] = await tx
        .insert(sources)
        .values({
          userId: input.userId,
          kind: 'url',
          title: pageTitle(page, url),
          url,
          status: fetching ? 'pending' : 'planned',
          verified: true,
          docVersion: input.docVersion,
          ...(fetching ? newOperationRun() : {}),
        })
        .returning({ id: sources.id });
      if (!created) continue;
      await attachSourceToNotebook(tx, {
        userId: input.userId,
        notebookId: input.notebookId,
        sourceId: created.id,
      });
      await linkModuleTx(tx, input.userId, input.moduleId, created.id);
      library += 1;
      notebook += 1;
      if (fetching) fetchIds.push(created.id);
    }
    if (input.catalog) {
      await tx
        .update(topicModules)
        .set({ referenceCatalog: input.catalog, updatedAt: new Date() })
        .where(and(eq(topicModules.id, input.moduleId), eq(topicModules.userId, input.userId)));
    }
    return { stopped, fetchIds };
  });
  for (const id of outcome.fetchIds) enqueueSource(id);
  return outcome.stopped;
}

export async function releasePlanWave(input: {
  userId: string;
  notebookId: string;
  moduleId: string;
}): Promise<boolean> {
  const owned = await ownedModule(input.userId, input.notebookId, input.moduleId);
  if (!owned) return false;
  const neighbors = await db
    .select({ id: topicModules.id })
    .from(topicModules)
    .where(
      and(
        eq(topicModules.planId, owned.planId),
        eq(topicModules.userId, input.userId),
        inArray(topicModules.position, [owned.position, owned.position + 1]),
      ),
    );
  const moduleIds = neighbors.map((row) => row.id);
  if (moduleIds.length === 0) return true;
  const links = await db
    .select({ sourceId: topicModuleSources.sourceId })
    .from(topicModuleSources)
    .where(and(eq(topicModuleSources.userId, input.userId), inArray(topicModuleSources.moduleId, moduleIds)));
  const sourceIds = [...new Set(links.map((row) => row.sourceId))];
  const released: string[] = [];
  for (const sourceId of sourceIds) {
    const [updated] = await db
      .update(sources)
      .set({ status: 'pending', ...newOperationRun(), updatedAt: new Date() })
      .where(
        and(
          eq(sources.id, sourceId),
          eq(sources.userId, input.userId),
          eq(sources.status, 'planned'),
          eq(sources.verified, true),
        ),
      )
      .returning({ id: sources.id });
    if (updated) released.push(updated.id);
  }
  for (const id of released) enqueueSource(id);
  return true;
}

export async function attachLinkedReferences(sourceId: string, hrefs: readonly string[]): Promise<void> {
  try {
    const normalized = hrefs.flatMap((href) => {
      const url = normalizePlanUrl(href);
      return url ? [url] : [];
    });
    if (normalized.length === 0) return;
    const anchors = await db
      .select({
        planId: topicModules.planId,
        sourceUserId: sources.userId,
      })
      .from(topicModuleSources)
      .innerJoin(topicModules, eq(topicModules.id, topicModuleSources.moduleId))
      .innerJoin(sources, eq(sources.id, topicModuleSources.sourceId))
      .where(and(eq(topicModuleSources.sourceId, sourceId), eq(topicModules.userId, sources.userId)));
    const ownerId = anchors[0]?.sourceUserId;
    if (!ownerId) return;
    const planIds = [...new Set(anchors.map((row) => row.planId))];
    const links = await db
      .select({ moduleId: topicModules.id, catalog: topicModules.referenceCatalog })
      .from(topicModules)
      .where(and(eq(topicModules.userId, ownerId), inArray(topicModules.planId, planIds)));
    for (const link of links) {
      if (!link.catalog) continue;
      const urls = referenceLinksToAdd(normalized, link.catalog);
      if (urls.length === 0) continue;
      await recordReferenceReceipt(link.moduleId, sourceId, urls);
      const created = await finishReferenceReceipt(link.moduleId, sourceId);
      for (const id of created) enqueueSource(id);
    }
  } catch (err) {
    rootLogger.warn({ err: safeError(err), sourceId }, 'topic_plan.reference_link_failed');
  }
}

export async function resumePlanReferenceReceipts(): Promise<void> {
  const rows = await db
    .select({ id: topicModules.id, catalog: topicModules.referenceCatalog })
    .from(topicModules)
    .where(sql`${topicModules.referenceCatalog} is not null`);
  for (const row of rows) {
    for (const receipt of row.catalog?.pending ?? []) {
      if (receipt.urls.length === 0) continue;
      const created = await finishReferenceReceipt(row.id, receipt.sourceId);
      for (const id of created) enqueueSource(id);
    }
  }
}

async function recordReferenceReceipt(moduleId: string, sourceId: string, urls: readonly string[]): Promise<void> {
  await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ catalog: topicModules.referenceCatalog })
      .from(topicModules)
      .where(eq(topicModules.id, moduleId))
      .for('update')
      .limit(1);
    if (!locked?.catalog) return;
    const catalog = locked.catalog;
    const prior = catalog.pending.find((item) => item.sourceId === sourceId)?.urls ?? [];
    const merged = [...new Set([...prior, ...urls])];
    const pending = catalog.pending.filter((item) => item.sourceId !== sourceId);
    pending.push({ sourceId, urls: merged });
    await tx
      .update(topicModules)
      .set({ referenceCatalog: { ...catalog, pending }, updatedAt: new Date() })
      .where(eq(topicModules.id, moduleId));
  });
}

async function finishReferenceReceipt(moduleId: string, sourceId: string): Promise<string[]> {
  const created = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({
        catalog: topicModules.referenceCatalog,
        userId: topicModules.userId,
        planId: topicModules.planId,
        position: topicModules.position,
      })
      .from(topicModules)
      .where(eq(topicModules.id, moduleId))
      .for('update')
      .limit(1);
    if (!locked?.catalog) return [];
    const catalog = locked.catalog;
    const receipt = catalog.pending.find((item) => item.sourceId === sourceId);
    if (!receipt || receipt.urls.length === 0) return [];
    const [parent] = await tx
      .select({ docVersion: sources.docVersion, userId: sources.userId })
      .from(sources)
      .where(eq(sources.id, sourceId))
      .limit(1);
    const [plan] = await tx
      .select({ notebookId: topicPlans.notebookId })
      .from(topicPlans)
      .where(eq(topicPlans.id, locked.planId))
      .limit(1);
    if (!parent || parent.userId !== locked.userId || !plan) return [];
    const released = await moduleIsReleased(tx, locked.userId, moduleId, locked.position);
    const counts = await countInTx(tx, parent.userId, plan.notebookId);
    let library = counts.library;
    let notebook = counts.notebook;
    let remaining = catalog.remainingTokens;
    const entries = catalog.entries.map((entry) => ({ ...entry }));
    const consumed = new Set<string>();
    const ids: string[] = [];
    let blocked = false;
    for (const raw of receipt.urls) {
      if (blocked) break;
      const classified = classifyPlanUrl(raw);
      if (!classified || classified.kind === 'seed') {
        consumed.add(raw);
        continue;
      }
      const url = classified.url;
      const entryIndex = entries.findIndex((entry) => entry.url === url);
      const tokens = entryIndex >= 0 ? entries[entryIndex]!.tokens : 0;
      const existing = await findUrlInTx(tx, parent.userId, url);
      if (existing) {
        const attached = await linkedAlready(tx, parent.userId, plan.notebookId, existing.id);
        if (!attached) {
          if (notebook >= env.ai.MAX_SOURCES_PER_NOTEBOOK) {
            blocked = true;
            break;
          }
          await attachSourceToNotebook(tx, {
            userId: parent.userId,
            notebookId: plan.notebookId,
            sourceId: existing.id,
          });
          notebook += 1;
        }
        await linkModuleTx(tx, locked.userId, moduleId, existing.id);
        if (released && existing.status === 'planned' && existing.verified) {
          const [promoted] = await tx
            .update(sources)
            .set({ status: 'pending', ...newOperationRun(), updatedAt: new Date() })
            .where(and(eq(sources.id, existing.id), eq(sources.status, 'planned'), eq(sources.verified, true)))
            .returning({ id: sources.id });
          if (promoted) ids.push(promoted.id);
        }
        if (entryIndex >= 0) entries.splice(entryIndex, 1);
        remaining = Math.max(0, remaining - tokens);
        consumed.add(raw);
        continue;
      }
      if (library >= env.ai.MAX_LIBRARY_ITEMS_PER_USER || notebook >= env.ai.MAX_SOURCES_PER_NOTEBOOK) {
        blocked = true;
        break;
      }
      const [row] = await tx
        .insert(sources)
        .values({
          userId: parent.userId,
          kind: 'url',
          title: titleForUrl(url).slice(0, 300),
          url,
          status: released ? 'pending' : 'planned',
          verified: true,
          docVersion: parent.docVersion,
          ...(released ? newOperationRun() : {}),
        })
        .returning({ id: sources.id });
      if (!row) continue;
      await attachSourceToNotebook(tx, {
        userId: parent.userId,
        notebookId: plan.notebookId,
        sourceId: row.id,
      });
      await linkModuleTx(tx, locked.userId, moduleId, row.id);
      library += 1;
      notebook += 1;
      if (released) ids.push(row.id);
      if (entryIndex >= 0) entries.splice(entryIndex, 1);
      remaining = Math.max(0, remaining - tokens);
      consumed.add(raw);
    }
    const leftover = receipt.urls.filter((url) => !consumed.has(url));
    const pending = catalog.pending.filter((item) => item.sourceId !== sourceId);
    if (leftover.length > 0) pending.push({ sourceId, urls: leftover });
    await tx
      .update(topicModules)
      .set({
        referenceCatalog: { v: 1, remainingTokens: remaining, entries, pending },
        updatedAt: new Date(),
      })
      .where(eq(topicModules.id, moduleId));
    return ids;
  });
  return created;
}
