import { createHash } from 'node:crypto';
import { Elysia, t } from 'elysia';
import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, libraryFolders, sources } from '@reomi/db';
import { folderAncestors, folderSubtree } from '@reomi/shared';
import { authPlugin } from '../auth-plugin';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Reader = typeof db | Tx;
type Folder = typeof libraryFolders.$inferSelect;
export class LibraryFolderError extends Error {
  constructor(readonly status: 400 | 404 | 409, readonly code: string) { super(code); }
}
export async function lockLibraryFolders(tx: Tx, userId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 95))`);
}
async function readFolders(ex: Reader, userId: string) {
  return ex.select().from(libraryFolders).where(eq(libraryFolders.userId, userId)).orderBy(asc(libraryFolders.name), asc(libraryFolders.id));
}
export async function validateLibraryFolder(ex: Reader, userId: string, id?: string | null) {
  if (!id) return;
  const [found] = await ex.select({ id: libraryFolders.id }).from(libraryFolders)
    .where(and(eq(libraryFolders.userId, userId), eq(libraryFolders.id, id)));
  if (!found) throw new LibraryFolderError(404, 'folder_not_found');
}
export async function libraryFolderScope(userId: string, folderId?: string, ex: Reader = db) {
  if (!folderId) return undefined;
  if (folderId === 'unfiled') return isNull(sources.folderId);
  const all = await readFolders(ex, userId);
  if (!all.some(folder => folder.id === folderId)) throw new LibraryFolderError(404, 'folder_not_found');
  return inArray(sources.folderId, folderSubtree(all, folderId).map(folder => folder.id));
}
function normalizedName(value: string) {
  const name = value.normalize('NFC').trim();
  if (!name || Array.from(name).length > 100) throw new LibraryFolderError(400, 'invalid_folder_name');
  return name;
}
function checkName(all: Folder[], name: string, parentId: string | null, except?: string) {
  if (all.some(f => f.id !== except && f.parentId === parentId && f.name.toLowerCase() === name.toLowerCase()))
    throw new LibraryFolderError(409, 'folder_name_exists');
}
export async function ensureBrowserFolder(tx: Tx, userId: string, requestedName = 'From browser') {
  await lockLibraryFolders(tx, userId);
  const all = await readFolders(tx, userId);
  const existing = all.find(folder => folder.purpose === 'browser');
  if (existing) return existing;
  const name = normalizedName(requestedName);
  const named = all.find(folder => folder.parentId === null && folder.name.toLowerCase() === name.toLowerCase());
  if (named) return (await tx.update(libraryFolders).set({ purpose: 'browser', revision: sql`${libraryFolders.revision} + 1` }).where(eq(libraryFolders.id, named.id)).returning())[0]!;
  if (all.length >= 1000) throw new LibraryFolderError(409, 'folder_limit');
  return (await tx.insert(libraryFolders).values({ userId, name, purpose: 'browser' }).returning())[0]!;
}
async function preview(tx: Tx, userId: string, id: string) {
  const all = await readFolders(tx, userId);
  if (!all.some(folder => folder.id === id)) throw new LibraryFolderError(404, 'folder_not_found');
  const subtree = folderSubtree(all, id).sort((a, b) => a.id.localeCompare(b.id));
  const folderIds = subtree.map(folder => folder.id);
  const materials = await tx.select({ id: sources.id, folderId: sources.folderId }).from(sources)
    .where(and(eq(sources.userId, userId), inArray(sources.folderId, folderIds)))
    .orderBy(asc(sources.id)).for('update');
  const confirmationToken = createHash('sha256').update(JSON.stringify({ userId, subtree: subtree.map(f => [f.id, f.parentId, f.revision]), materials })).digest('hex');
  return { folderIds, folderCount: subtree.length, materialCount: materials.length, confirmationToken };
}
const idSchema = t.String({ format: 'uuid' });
const destinationSchema = t.Union([idSchema, t.Null()]);
export const libraryFoldersModule = new Elysia({ prefix: '/library/folders' })
  .use(authPlugin)
  .get('/', async ({ user }) => {
    const [all, grouped] = await Promise.all([
      readFolders(db, user.id),
      db.select({ folderId: sources.folderId, n: count() }).from(sources)
        .where(and(eq(sources.userId, user.id), sql`${sources.status} <> 'deleting'`)).groupBy(sources.folderId),
    ]);
    const counts = new Map(grouped.map(row => [row.folderId, Number(row.n)]));
    return { items: all.map(folder => ({ ...folder, directCount: counts.get(folder.id) ?? 0,
      count: folderSubtree(all, folder.id).reduce((n, f) => n + (counts.get(f.id) ?? 0), 0) })),
      unfiledCount: counts.get(null) ?? 0, totalCount: grouped.reduce((n, row) => n + Number(row.n), 0) };
  }, { auth: true })
  .post('/', ({ user, body }) => db.transaction(async tx => {
    await lockLibraryFolders(tx, user.id);
    const all = await readFolders(tx, user.id), name = normalizedName(body.name), parentId = body.parentId ?? null;
    await validateLibraryFolder(tx, user.id, parentId);
    if (all.length >= 1000 || (parentId && folderAncestors(all, parentId).length >= 20)) throw new LibraryFolderError(409, 'folder_limit');
    checkName(all, name, parentId);
    return (await tx.insert(libraryFolders).values({ userId: user.id, name, parentId }).returning())[0]!;
  }), { auth: true, body: t.Object({ name: t.String({ maxLength: 200 }), parentId: t.Optional(destinationSchema) }) })
  .post('/browser-default', ({ user, body }) => db.transaction(tx => ensureBrowserFolder(tx, user.id, body.name)),
    { auth: true, body: t.Object({ name: t.Optional(t.String({ maxLength: 200 })) }) })
  .post('/move-items', ({ user, body }) => db.transaction(async tx => {
    await lockLibraryFolders(tx, user.id);
    await validateLibraryFolder(tx, user.id, body.folderId);
    const ids = [...new Set(body.sourceIds)];
    const rows = await tx.select({ id: sources.id }).from(sources)
      .where(and(eq(sources.userId, user.id), inArray(sources.id, ids), sql`${sources.status} <> 'deleting'`)).orderBy(asc(sources.id)).for('update');
    if (rows.length !== ids.length) throw new LibraryFolderError(404, 'source_not_found');
    await tx.update(sources).set({ folderId: body.folderId })
      .where(and(eq(sources.userId, user.id), inArray(sources.id, ids)));
    return { moved: ids.length };
  }), { auth: true, body: t.Object({ sourceIds: t.Array(idSchema, { minItems: 1, maxItems: 1000 }), folderId: destinationSchema }) })
  .patch('/:id', ({ user, params, body }) => db.transaction(async tx => {
    await lockLibraryFolders(tx, user.id);
    const all = await readFolders(tx, user.id), current = all.find(f => f.id === params.id);
    if (!current) throw new LibraryFolderError(404, 'folder_not_found');
    if (body.revision !== current.revision) throw new LibraryFolderError(409, 'folder_changed');
    const parentId = body.parentId === undefined ? current.parentId : body.parentId;
    await validateLibraryFolder(tx, user.id, parentId);
    const subtree = folderSubtree(all, current.id);
    if (parentId && subtree.some(f => f.id === parentId)) throw new LibraryFolderError(409, 'folder_cycle');
    const parentDepth = parentId ? folderAncestors(all, parentId).length : 0;
    const height = Math.max(...subtree.map(f => folderAncestors(subtree, f.id).length));
    if (parentDepth + height > 20) throw new LibraryFolderError(409, 'folder_limit');
    const name = body.name === undefined ? current.name : normalizedName(body.name);
    checkName(all, name, parentId, current.id);
    return (await tx.update(libraryFolders).set({ name, parentId, revision: current.revision + 1 })
      .where(and(eq(libraryFolders.userId, user.id), eq(libraryFolders.id, current.id))).returning())[0]!;
  }), { auth: true, params: t.Object({ id: idSchema }), body: t.Object({ revision: t.Integer({ minimum: 0 }), name: t.Optional(t.String({ maxLength: 200 })), parentId: t.Optional(destinationSchema) }) })
  .get('/:id/delete-preview', ({ user, params }) => db.transaction(async tx => {
    await lockLibraryFolders(tx, user.id);
    const { folderIds: _omit, ...result } = await preview(tx, user.id, params.id);
    return result;
  }), { auth: true, params: t.Object({ id: idSchema }) })
  .delete('/:id', ({ user, params, body }) => db.transaction(async tx => {
    await lockLibraryFolders(tx, user.id);
    const state = await preview(tx, user.id, params.id), destinationId = body.destinationId ?? null;
    if (state.confirmationToken !== body.confirmationToken) throw new LibraryFolderError(409, 'folder_changed');
    await validateLibraryFolder(tx, user.id, destinationId);
    if (destinationId && state.folderIds.includes(destinationId)) throw new LibraryFolderError(409, 'folder_cycle');
    await tx.update(sources).set({ folderId: destinationId })
      .where(and(eq(sources.userId, user.id), inArray(sources.folderId, state.folderIds)));
    await tx.delete(libraryFolders).where(and(eq(libraryFolders.userId, user.id), inArray(libraryFolders.id, state.folderIds)));
    return { deleted: state.folderCount, moved: state.materialCount };
  }), { auth: true, params: t.Object({ id: idSchema }), body: t.Object({ confirmationToken: t.String({ minLength: 64, maxLength: 64 }), destinationId: t.Optional(destinationSchema) }) });
