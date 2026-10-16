import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  conversations,
  db,
  mcpActions,
  media,
  messages,
  notebookArtifacts,
  notebookNotes,
  notebooks,
  noteTypes,
  personalAccessTokens,
  sourceChunks,
  sources,
} from '@reomi/db';
import { newUuidV7 } from '@reomi/shared';
import { __resetMediaGcForTests, runMediaGc, type MediaGcOptions } from '../src/media-gc.ts';
import { __setObjectDeleterForTests, __setObjectListerForTests, type ObjectListQuery } from '../src/storage.ts';
import { buildApp } from '../src/app.ts';
import { callApp, resetTestDb, seedNote, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();
const HOUR = 60 * 60 * 1000;
const now = new Date('2026-10-15T12:00:00.000Z');
const old = new Date(now.getTime() - 48 * HOUR);
const young = new Date(now.getTime() - 5 * 60 * 1000);
const gc: MediaGcOptions = { now, pendingMaxAgeMs: HOUR, unreferencedMaxAgeMs: HOUR, batch: 20 };

let deleted: string[] = [];

async function insertMedia(userId: string, createdAt: Date, verified: boolean): Promise<string> {
  const id = newUuidV7();
  await db.insert(media).values({
    id,
    userId,
    s3Key: `media/${id}`,
    mime: 'image/png',
    size: 12,
    verified,
    createdAt,
  });
  return id;
}

async function insertSource(userId: string, opts: {
  createdAt: Date;
  verified: boolean;
  status: string;
  storage: boolean;
  coverMediaId?: string;
}): Promise<string> {
  const id = newUuidV7();
  await db.insert(sources).values({
    id,
    userId,
    kind: opts.storage ? 'pdf' : 'text',
    title: 'Source',
    storageKey: opts.storage ? `source/${id}` : null,
    verified: opts.verified,
    status: opts.status,
    createdAt: opts.createdAt,
    coverMediaId: opts.coverMediaId,
  });
  return id;
}

async function mediaIds(): Promise<string[]> {
  const rows = await db.select({ id: media.id }).from(media);
  return rows.map((row) => row.id).sort();
}

async function sourceIds(): Promise<string[]> {
  const rows = await db.select({ id: sources.id }).from(sources);
  return rows.map((row) => row.id).sort();
}

describe('media GC', () => {
  beforeEach(async () => {
    deleted = [];
    __resetMediaGcForTests();
    __setObjectDeleterForTests(async (key) => { deleted.push(key); });
    __setObjectListerForTests(async () => ({ items: [] }));
    await resetTestDb();
  });

  afterEach(() => {
    __setObjectDeleterForTests(null);
    __setObjectListerForTests(null);
    __resetMediaGcForTests();
  });

  test('removes expired pending media and source claims and leaves fresh or verified rows', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail('pending'));
    const expiredMedia = await insertMedia(userId, old, false);
    const freshMedia = await insertMedia(userId, young, false);
    const expiredSource = await insertSource(userId, { createdAt: old, verified: false, status: 'pending', storage: true });
    await insertSource(userId, { createdAt: old, verified: false, status: 'pending', storage: false });
    const freshSource = await insertSource(userId, { createdAt: young, verified: false, status: 'pending', storage: true });
    const readySource = await insertSource(userId, { createdAt: old, verified: true, status: 'ready', storage: true });

    const first = await runMediaGc(gc);
    expect(first).toEqual({
      pendingMedia: 1,
      pendingSources: 2,
      unreferencedMedia: 0,
      orphanObjects: 0,
      objectDeleteFailures: 0,
    });
    expect(deleted).toEqual([`media/${expiredMedia}`, `source/${expiredSource}`]);
    expect(await mediaIds()).toEqual([freshMedia]);
    expect(await sourceIds()).toEqual([freshSource, readySource].sort());

    const second = await runMediaGc(gc);
    expect(second).toEqual({
      pendingMedia: 0,
      pendingSources: 0,
      unreferencedMedia: 0,
      orphanObjects: 0,
      objectDeleteFailures: 0,
    });
    expect(deleted).toEqual([`media/${expiredMedia}`, `source/${expiredSource}`]);
  });

  test('stops a pending sweep at the batch size and continues on the next run', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail('batch'));
    const oldest = await insertMedia(userId, new Date(now.getTime() - 72 * HOUR), false);
    const middle = await insertMedia(userId, new Date(now.getTime() - 60 * HOUR), false);
    const newest = await insertMedia(userId, new Date(now.getTime() - 48 * HOUR), false);

    const first = await runMediaGc({ ...gc, batch: 2 });
    expect(first.pendingMedia).toBe(2);
    expect(deleted).toEqual([`media/${oldest}`, `media/${middle}`]);
    expect(await mediaIds()).toEqual([newest]);

    const second = await runMediaGc({ ...gc, batch: 2 });
    expect(second.pendingMedia).toBe(1);
    expect(deleted).toEqual([`media/${oldest}`, `media/${middle}`, `media/${newest}`]);
    expect(await mediaIds()).toEqual([]);
  });

  test('keeps a verified image stored in each server sink', async () => {
    const email = uniqueEmail('refs');
    const { cookie, userId } = await signUpAndCookie(app, email);
    await callApp(app, 'GET', '/profile', { cookie });
    const deck = await (await callApp(app, 'POST', '/decks', { cookie, body: { name: 'D' } })).json<{ id: string }>();

    const inNote = await insertMedia(userId, old, true);
    const inCover = await insertMedia(userId, old, true);
    const inChat = await insertMedia(userId, old, true);
    const inNotebook = await insertMedia(userId, old, true);
    const inArtifact = await insertMedia(userId, old, true);
    const inOverview = await insertMedia(userId, old, true);
    const inPreview = await insertMedia(userId, old, true);
    const inChunk = await insertMedia(userId, old, true);
    const inTemplate = await insertMedia(userId, old, true);
    const orphan = await insertMedia(userId, old, true);
    const fresh = await insertMedia(userId, young, true);

    await seedNote(app, cookie, { deckId: deck.id, fields: { Front: `see ![](/m/${inNote})`, Back: 'answer' } });
    const coverSource = await insertSource(userId, { createdAt: young, verified: true, status: 'ready', storage: false, coverMediaId: inCover });
    await db.insert(sourceChunks).values({ userId, sourceId: coverSource, position: 0, text: `figure ![](/m/${inChunk})` });
    const [conversation] = await db.insert(conversations).values({ userId }).returning({ id: conversations.id });
    await db.insert(messages).values({
      conversationId: conversation!.id,
      userId,
      role: 'user',
      content: 'attached',
      attachments: [{ kind: 'image', mediaId: inChat, token: `/m/${inChat}`, mime: 'image/png' }],
    });
    const [notebook] = await db.insert(notebooks).values({
      userId,
      title: 'Notes',
      overview: `cover ![](/m/${inOverview})`,
    }).returning({ id: notebooks.id });
    await db.insert(notebookNotes).values({
      userId,
      notebookId: notebook!.id,
      title: 'Saved',
      content: `passage /m/${inNotebook}`,
      kind: 'manual',
      ownerKind: 'notebook',
    });
    await db.insert(notebookArtifacts).values({
      userId,
      notebookId: notebook!.id,
      type: 'summary',
      title: 'Guide',
      contentMd: `see ![](/m/${inArtifact})`,
      sourceIds: [],
    });
    const [token] = await db.insert(personalAccessTokens).values({
      userId,
      name: 'gc',
      tokenHash: `gc-${inPreview}`,
      prefix: 'nn_pat_',
      expiresAt: new Date(now.getTime() + HOUR),
    }).returning({ id: personalAccessTokens.id });
    await db.insert(mcpActions).values({
      userId,
      tokenId: token!.id,
      tool: 'create_card',
      args: {},
      preview: { note: `/m/${inPreview}` },
      expiresAt: new Date(now.getTime() + HOUR),
    });
    await db.insert(noteTypes).values({
      userId,
      name: 'Illustrated',
      kind: 'basic',
      fields: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }],
      templates: [{ name: 'Card', ord: 0, frontTemplate: `<img src="/m/${inTemplate}">`, backTemplate: '{{Back}}' }],
    });

    const report = await runMediaGc(gc);
    expect(report.unreferencedMedia).toBe(1);
    expect(deleted).toEqual([`media/${orphan}`]);
    expect(await mediaIds()).toEqual([
      fresh, inArtifact, inChat, inChunk, inCover, inNote, inNotebook, inOverview, inPreview, inTemplate,
    ].sort());
  });

  test('deletes an old ownerless object and skips live, young, and foreign keys', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail('orphan'));
    const live = await insertMedia(userId, old, true);
    const orphanId = newUuidV7();
    const queries: string[] = [];
    __setObjectListerForTests(async (query: ObjectListQuery) => {
      queries.push(query.prefix);
      if (query.prefix === 'media/') {
        return {
          items: [
            { key: `media/${orphanId}`, lastModified: old },
            { key: `media/${live}`, lastModified: old },
            { key: `media/${newUuidV7()}`, lastModified: young },
            { key: 'covers/not-a-media-key', lastModified: old },
          ],
        };
      }
      return { items: [] };
    });

    const first = await runMediaGc(gc);
    expect(first.orphanObjects).toBe(1);
    expect(first.unreferencedMedia).toBe(1);
    expect(deleted).toEqual([`media/${live}`, `media/${orphanId}`]);
    expect(queries).toEqual(['media/']);
    expect(await mediaIds()).toEqual([]);

    deleted = [];
    const second = await runMediaGc(gc);
    expect(second.orphanObjects).toBe(0);
    expect(queries).toEqual(['media/', 'source/']);
    expect(deleted).toEqual([]);
  });

  test('still removes expired pending rows when object listing fails', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail('list-down'));
    await insertMedia(userId, old, false);
    __setObjectListerForTests(async () => { throw new Error('s3 down'); });
    __setObjectDeleterForTests(async () => { throw new Error('s3 down'); });

    const report = await runMediaGc(gc);
    expect(report).toEqual({
      pendingMedia: 1,
      pendingSources: 0,
      unreferencedMedia: 0,
      orphanObjects: 0,
      objectDeleteFailures: 1,
    });
    expect(await mediaIds()).toEqual([]);

    const again = await runMediaGc(gc);
    expect(again.pendingMedia).toBe(0);
    expect(again.objectDeleteFailures).toBe(0);
  });
});
