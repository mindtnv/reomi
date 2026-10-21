import { and, asc, count, eq, inArray, ne, sql } from 'drizzle-orm';
import { db, libraryDocumentation as collections, libraryDocumentationPages as pages, libraryFolders, sources } from '@reomi/db';
import { documentationPeriod, documentationRuleSelected, newUuidV7, type DocumentationManifest, type DocumentationPage, type DocumentationSchedule } from '@reomi/shared';
import { env } from '../env';
import { discoverDocumentation, documentationLabel, documentationSections, documentationUrlKey, selectedDocumentationPages } from '../ai/library-documentation-discovery';
import { LibraryFolderError, lockLibraryFolders, validateLibraryFolder } from './library-folders';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type DocumentationCollection = typeof collections.$inferSelect;
export const PREVIEW_TTL_MS = 10 * 60 * 1000;
export class DocumentationError extends LibraryFolderError {}
const fail = (code: string, status: 400 | 404 | 409 = 409): never => { throw new DocumentationError(status, code); };

async function owned(userId: string, id: string, tx: typeof db | Tx = db, lock = false) {
  const query = tx.select().from(collections).where(and(eq(collections.userId, userId), eq(collections.id, id))).limit(1);
  const [row] = await (lock ? query.for('update') : query);
  return row ?? fail('documentation_not_found', 404);
}

export async function documentationSummary(userId: string, id: string) {
  const row = await owned(userId, id);
  const grouped = await db.select({ state: pages.state, n: count() }).from(pages)
    .where(and(eq(pages.userId, userId), eq(pages.collectionId, id))).groupBy(pages.state);
  const counts = Object.fromEntries(grouped.map(g => [g.state, Number(g.n)]));
  return { id: row.id, rootUrl: row.rootUrl, title: row.title, locale: row.locale, folderId: row.folderId,
    state: row.state, errorCode: row.errorCode, checkedAt: row.checkedAt, updatedAt: row.updatedAt,
    schedule: row.schedule, nextSyncAt: row.nextSyncAt, syncError: row.syncError, lastResult: row.lastResult,
    checking: Boolean(row.syncClaimId && row.syncClaimUntil && row.syncClaimUntil.getTime() > Date.now()),
    total: grouped.reduce((sum, g) => sum + Number(g.n), 0), completed: counts.ready ?? 0,
    pending: counts.pending ?? 0, failed: (counts.error ?? 0) + (counts.missing ?? 0), deleted: counts.deleted ?? 0 };
}

async function activeSources(userId: string, tx: typeof db | Tx = db) {
  return tx.select({ id: sources.id, url: sources.url, kind: sources.kind }).from(sources)
    .where(and(eq(sources.userId, userId), ne(sources.status, 'deleting')));
}
export function sourceUrlMap(rows: { id: string; url: string | null; kind: string }[]) {
  const map = new Map<string, string>();
  for (const row of rows) if (row.kind === 'url' && row.url) {
    try { if (!map.has(documentationUrlKey(row.url))) map.set(documentationUrlKey(row.url), row.id); } catch { /* legacy invalid URL */ }
  }
  return map;
}

async function reservedUrls(userId: string, tx: typeof db | Tx = db, exceptId?: string) {
  const rows = await tx.select({ url: pages.url }).from(pages).innerJoin(collections, eq(collections.id, pages.collectionId))
    .where(and(eq(pages.userId, userId), eq(collections.userId, userId), eq(pages.imported, false), eq(pages.state, 'pending'),
      inArray(collections.state, ['queued', 'running']), exceptId ? ne(collections.id, exceptId) : undefined));
  return new Set(rows.map(row => row.url));
}

export async function previewDocumentation(userId: string, url: string, locale: 'en' | 'ru') {
  const [{ n: connectionCount }] = await db.select({ n: count() }).from(collections)
    .where(and(eq(collections.userId, userId), ne(collections.state, 'draft')));
  if (Number(connectionCount) >= 20) fail('documentation_limit');
  let manifest: DocumentationManifest;
  try { manifest = await discoverDocumentation(url, locale); } catch { return fail('documentation_unavailable'); }
  if (!manifest.pages.length) fail('documentation_empty');
  const active = await activeSources(userId), existing = sourceUrlMap(active);
  const reserved = await reservedUrls(userId);
  const newCounts = new Map(documentationSections({ ...manifest, pages: manifest.pages.filter(page => !existing.has(page.url) && !reserved.has(page.url)) })
    .map(section => [section.prefix, section.pageCount]));
  await db.delete(collections).where(and(eq(collections.userId, userId), eq(collections.state, 'draft'),
    sql`${collections.createdAt} < now() - interval '10 minutes'`));
  const [{ n: drafts }] = await db.select({ n: count() }).from(collections).where(and(eq(collections.userId, userId), eq(collections.state, 'draft')));
  if (Number(drafts) >= 10) fail('documentation_preview_limit');
  const [row] = await db.insert(collections).values({ userId, rootUrl: manifest.rootUrl, locale: manifest.locale,
    title: new URL(manifest.rootUrl).hostname.replace(/^www\./, ''), manifest }).returning();
  return { id: row!.id, rootUrl: manifest.rootUrl, title: row!.title, locale: manifest.locale,
    total: manifest.pages.length, available: Math.max(0, env.ai.MAX_LIBRARY_ITEMS_PER_USER - active.length - [...reserved].filter(url => !existing.has(url)).length),
    expiresAt: new Date(row!.createdAt.getTime() + PREVIEW_TTL_MS),
    sections: documentationSections(manifest).map(section => ({ ...section,
      newPageCount: newCounts.get(section.prefix) ?? 0 })) };
}

async function ensureSectionFolders(tx: Tx, row: DocumentationCollection, selected: DocumentationPage[]) {
  const all = await tx.select().from(libraryFolders).where(eq(libraryFolders.userId, row.userId));
  if (!row.folderId) fail('documentation_folder_missing');
  await validateLibraryFolder(tx, row.userId, row.folderId);
  const rootPath = new URL(row.rootUrl).pathname;
  const mapping = { ...row.sectionFolders, [rootPath]: row.folderId! };
  const required = new Set<string>();
  for (const page of selected) {
    let prefix = page.section;
    let depth = 0;
    while (prefix !== rootPath) {
      if (++depth >= 20) fail('folder_depth_limit');
      required.add(prefix);
      prefix = `/${prefix.split('/').filter(Boolean).slice(0, -1).join('/')}/`.replace(/^\/\/$/, '/');
    }
  }
  for (const prefix of [...required].sort((a, b) => a.length - b.length)) {
    if (mapping[prefix]) {
      if (!all.some(f => f.id === mapping[prefix])) fail('documentation_folder_missing');
      continue;
    }
    if (all.length >= 1000) fail('folder_limit');
    const parent = `/${prefix.split('/').filter(Boolean).slice(0, -1).join('/')}/`.replace(/^\/\/$/, '/');
    const parentId = mapping[parent];
    if (!parentId) fail('documentation_folder_missing');
    let name = documentationLabel(prefix), ordinal = 1;
    const base = name.slice(0, 85);
    while (all.some(f => f.parentId === parentId && f.name.toLowerCase() === name.toLowerCase())) name = `${base} (${++ordinal})`;
    const [folder] = await tx.insert(libraryFolders).values({ userId: row.userId, parentId, name }).returning();
    all.push(folder!); mapping[prefix] = folder!.id;
  }
  return mapping;
}

export async function confirmDocumentation(userId: string, id: string, titleInput: string, prefixes: string[]) {
  const title = titleInput.normalize('NFC').trim();
  if (!title || Array.from(title).length > 100) fail('invalid_folder_name', 400);
  await db.transaction(async tx => {
    await lockLibraryFolders(tx, userId);
    const row = await owned(userId, id, tx, true);
    if (row.state !== 'draft') {
      if (row.title !== title || JSON.stringify([...row.selectedPrefixes].sort()) !== JSON.stringify([...new Set(prefixes)].sort())) fail('documentation_already_connected');
      return;
    }
    if (Date.now() - row.createdAt.getTime() > PREVIEW_TTL_MS) fail('documentation_preview_expired');
    let selected: DocumentationPage[];
    try { selected = selectedDocumentationPages(row.manifest, prefixes); } catch { return fail('invalid_sections', 400); }
    const [duplicate] = await tx.select({ id: collections.id }).from(collections).where(and(eq(collections.userId, userId),
      eq(collections.rootUrl, row.rootUrl), eq(collections.locale, row.locale), ne(collections.state, 'draft')));
    if (duplicate) fail('documentation_already_connected');
    const [{ n: connected }] = await tx.select({ n: count() }).from(collections).where(and(eq(collections.userId, userId), ne(collections.state, 'draft')));
    if (Number(connected) >= 20) fail('documentation_limit');
    const active = await activeSources(userId, tx), existing = sourceUrlMap(active);
    const reserved = await reservedUrls(userId, tx);
    for (const page of selected) reserved.add(page.url);
    if (active.length + [...reserved].filter(url => !existing.has(url)).length > env.ai.MAX_LIBRARY_ITEMS_PER_USER) fail('library_full');
    const folders = await tx.select().from(libraryFolders).where(eq(libraryFolders.userId, userId));
    if (folders.length >= 1000) fail('folder_limit');
    let name = title, ordinal = 1;
    while (folders.some(f => !f.parentId && f.name.toLowerCase() === name.toLowerCase())) name = `${title.slice(0, 85)} (${++ordinal})`;
    const [folder] = await tx.insert(libraryFolders).values({ userId, name }).returning();
    const mapping = await ensureSectionFolders(tx, { ...row, folderId: folder!.id }, selected);
    await tx.insert(pages).values(selected.map(p => ({ ...p, userId, collectionId: id,
      sourceId: existing.get(p.url) ?? null, imported: existing.has(p.url) })));
    await tx.update(collections).set({ title, folderId: folder!.id, sectionFolders: mapping,
      selectedPrefixes: [...new Set(prefixes)], state: 'queued', runId: newUuidV7(), updatedAt: new Date() }).where(eq(collections.id, id));
  });
  return documentationSummary(userId, id);
}

function assertDiscoveryClaim(row: DocumentationCollection, claimId?: string) {
  const live = Boolean(row.syncClaimId && row.syncClaimUntil && row.syncClaimUntil.getTime() > Date.now());
  if (claimId ? !live || row.syncClaimId !== claimId || row.schedule === 'off' : live) fail('documentation_busy');
}

export async function configureDocumentationSchedule(userId: string, id: string, schedule: DocumentationSchedule) {
  await db.transaction(async tx => {
    const row = await owned(userId, id, tx, true);
    if (row.state === 'draft') fail('documentation_not_confirmed');
    const period = documentationPeriod(schedule);
    await tx.update(collections).set({ schedule, nextSyncAt: period ? new Date(Date.now() + period) : null,
      syncClaimId: null, syncClaimUntil: null, syncFailures: 0, syncError: null, updatedAt: new Date() }).where(eq(collections.id, id));
  });
  return documentationSummary(userId, id);
}

export async function updateDocumentation(userId: string, id: string, claimId?: string) {
  const before = await owned(userId, id);
  if (before.state === 'draft') fail('documentation_not_confirmed');
  if (before.state === 'running' || before.state === 'queued') fail('documentation_busy');
  assertDiscoveryClaim(before, claimId);
  let manifest: DocumentationManifest;
  try { manifest = await discoverDocumentation(before.rootUrl, before.locale); } catch { return fail('documentation_unavailable'); }
  if (!manifest.pages.length) fail('documentation_unavailable');
  await db.transaction(async tx => {
    await lockLibraryFolders(tx, userId);
    const row = await owned(userId, id, tx, true);
    if (row.runId !== before.runId || row.state !== before.state) fail('documentation_busy');
    assertDiscoveryClaim(row, claimId);
    const selected = manifest.pages.filter(p => documentationRuleSelected(p.section, row.selectedPrefixes));
    const mapping = await ensureSectionFolders(tx, row, selected);
    const old = await tx.select().from(pages).where(and(eq(pages.userId, userId), eq(pages.collectionId, id))).for('update');
    const byUrl = new Map(old.map(p => [p.url, p]));
    const active = await activeSources(userId, tx), existing = sourceUrlMap(active);
    const added = selected.filter(p => !byUrl.has(p.url));
    const reserved = await reservedUrls(userId, tx, id);
    for (const page of selected) if (!byUrl.get(page.url)?.imported) reserved.add(page.url);
    if (active.length + [...reserved].filter(url => !existing.has(url)).length > env.ai.MAX_LIBRARY_ITEMS_PER_USER) fail('library_full');
    const current = new Set(selected.map(p => p.url));
    for (const page of old) {
      const deleted = page.imported && !page.sourceId;
      await tx.update(pages).set({ state: deleted ? 'deleted' : current.has(page.url) ? 'pending' : 'missing', lastChange: null,
        errorCode: deleted ? null : current.has(page.url) ? null : 'remote_missing' }).where(eq(pages.id, page.id));
    }
    if (added.length) await tx.insert(pages).values(added.map(p => ({ ...p, userId, collectionId: id,
      sourceId: existing.get(p.url) ?? null, imported: existing.has(p.url) })));
    await tx.update(collections).set({ manifest, sectionFolders: mapping, state: 'queued', runId: newUuidV7(),
      errorCode: null, updatedAt: new Date(), syncClaimId: null, syncClaimUntil: null, syncFailures: 0, syncError: null,
      nextSyncAt: documentationPeriod(row.schedule) ? new Date(Date.now() + documentationPeriod(row.schedule)!) : null }).where(eq(collections.id, id));
  });
  return documentationSummary(userId, id);
}

export async function cancelDocumentation(userId: string, id: string) {
  await db.transaction(async tx => {
    const row = await owned(userId, id, tx, true);
    if (row.state !== 'queued' && row.state !== 'running') fail('documentation_not_running');
    await tx.update(collections).set({ state: 'cancelled', runId: newUuidV7(), updatedAt: new Date() }).where(eq(collections.id, id));
  });
  return documentationSummary(userId, id);
}

/** Disconnect removes only the import relationship, never sources or folders. */
export async function disconnectDocumentation(userId: string, id: string) {
  await db.transaction(async tx => {
    await owned(userId, id, tx, true);
    await tx.delete(collections).where(and(eq(collections.userId, userId), eq(collections.id, id)));
  });
  return { ok: true };
}

export async function listDocumentation(userId: string) {
  const rows = await db.select({ id: collections.id }).from(collections)
    .where(and(eq(collections.userId, userId), ne(collections.state, 'draft'))).orderBy(asc(collections.createdAt)).limit(20);
  return { items: await Promise.all(rows.map(row => documentationSummary(userId, row.id))) };
}

export async function documentationPageErrors(userId: string, id: string) {
  await owned(userId, id);
  return { items: await db.select({ id: pages.id, title: pages.title, url: pages.url, state: pages.state, errorCode: pages.errorCode }).from(pages)
    .where(and(eq(pages.userId, userId), eq(pages.collectionId, id), inArray(pages.state, ['error', 'missing'])))
    .orderBy(asc(pages.id)).limit(20) };
}
