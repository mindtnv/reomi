// Notebook + source CRUD (NotebookLM M1, T7 / AC1.8 + AC1.9).
//
// Pure route tests via `app.handle` — no ingest worker driven here (that lives
// in source-ingest.test.ts). url/text source creates DO enqueue the worker, but
// under NODE_ENV=test there is no embedder so ingest parse-and-parks; we don't
// await it. We assert: CRUD; user-scope 404 on foreign ids; the aggregate caps
// (MAX_NOTEBOOKS_PER_USER / MAX_SOURCES_PER_NOTEBOOK → 409); notebook delete
// PRESERVES sources + source_chunks + document kb_chunk (library refactor Р3/Р4 —
// only the notebook_sources edge cascades); and /ai/status carries
// `notebooksEnabled`.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { and, count, eq } from 'drizzle-orm';
import {
  db,
  kbChunk,
  notebooks,
  notebookSources,
  sourceChunks,
  sources as sourcesTable,
} from '@reomi/db';
import { buildApp } from '../src/app.ts';
import { env } from '../src/env.ts';
import { __resetAiClientForTests } from '../src/ai/openai-client.ts';
import {
  callApp,
  resetTestDb,
  signUpAndCookie,
  uniqueEmail,
} from './helpers.ts';

const app = buildApp();

interface NotebookRow {
  id: string;
  userId: string;
  title: string;
}

async function createNotebook(cookie: string, title = 'My Notebook'): Promise<NotebookRow> {
  const res = await callApp(app, 'POST', '/notebooks', { cookie, body: { title } });
  expect(res.status).toBe(200);
  return res.json<NotebookRow>();
}

describe('notebooks CRUD + scoping', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('401 without a session cookie', async () => {
    expect((await callApp(app, 'GET', '/notebooks', {})).status).toBe(401);
    expect((await callApp(app, 'POST', '/notebooks', { body: { title: 'x' } })).status).toBe(401);
  });

  test('create → list → rename → delete', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await createNotebook(cookie, 'Biology');
    expect(nb.title).toBe('Biology');
    expect(nb.userId).toBe(userId);

    const list = await callApp(app, 'GET', '/notebooks', { cookie });
    const { items } = await list.json<{ items: NotebookRow[] }>();
    expect(items.map((i) => i.id)).toContain(nb.id);

    const renamed = await callApp(app, 'PATCH', `/notebooks/${nb.id}`, {
      cookie,
      body: { title: 'Cell Biology' },
    });
    expect(renamed.status).toBe(200);
    expect((await renamed.json<NotebookRow>()).title).toBe('Cell Biology');

    const del = await callApp(app, 'DELETE', `/notebooks/${nb.id}`, { cookie });
    expect(del.status).toBe(200);
    const after = await callApp(app, 'GET', '/notebooks', { cookie });
    expect((await after.json<{ items: NotebookRow[] }>()).items).toHaveLength(0);
  });

  test('title validation: empty title → 400 (Elysia body schema)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const res = await callApp(app, 'POST', '/notebooks', { cookie, body: { title: '' } });
    expect(res.status).toBe(400);
  });

  test("foreign notebook id → 404 on GET sources / PATCH / DELETE (user-scoped)", async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const nbB = await createNotebook(b.cookie, "B's notebook");

    // A cannot see, rename, delete, or add sources to B's notebook.
    expect(
      (await callApp(app, 'GET', `/notebooks/${nbB.id}/sources`, { cookie: a.cookie })).status,
    ).toBe(404);
    expect(
      (
        await callApp(app, 'PATCH', `/notebooks/${nbB.id}`, {
          cookie: a.cookie,
          body: { title: 'hijack' },
        })
      ).status,
    ).toBe(404);
    expect(
      (await callApp(app, 'DELETE', `/notebooks/${nbB.id}`, { cookie: a.cookie })).status,
    ).toBe(404);
    expect(
      (
        await callApp(app, 'POST', `/notebooks/${nbB.id}/sources`, {
          cookie: a.cookie,
          body: { kind: 'text', title: 't', text: 'hi' },
        })
      ).status,
    ).toBe(404);
  });

  test('a missing (non-existent) notebook id → 404', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const res = await callApp(app, 'PATCH', '/notebooks/00000000-0000-0000-0000-0000000000aa', {
      cookie,
      body: { title: 'x' },
    });
    expect(res.status).toBe(404);
  });

  test('MAX_NOTEBOOKS_PER_USER → 409 too_many_notebooks (seed up to the cap)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const cap = env.ai.MAX_NOTEBOOKS_PER_USER;
    // Seed exactly the cap directly (fast; the route counts rows, not creates).
    await db.insert(notebooks).values(
      Array.from({ length: cap }, (_, i) => ({ userId, title: `seed-${i}` })),
    );
    const res = await callApp(app, 'POST', '/notebooks', { cookie, body: { title: 'one too many' } });
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toBe('too_many_notebooks');
    // The cap is per-USER: a second user can still create.
    const other = await signUpAndCookie(app, uniqueEmail('other'));
    expect((await callApp(app, 'POST', '/notebooks', { cookie: other.cookie, body: { title: 'ok' } })).status).toBe(200);
  });
});

describe('sources within a notebook', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('create a text source → inline create returns a pending row', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const nb = await createNotebook(cookie);
    const res = await callApp(app, 'POST', `/notebooks/${nb.id}/sources`, {
      cookie,
      body: { kind: 'text', title: 'Notes', text: 'Inline study text.' },
    });
    expect(res.status).toBe(200);
    const src = await res.json<{ id: string; kind: string; status: string; verified: boolean }>();
    expect(src.kind).toBe('text');
    expect(src.verified).toBe(true);
    // pending or further along (the worker may have run synchronously). Never error/ready
    // since there's no embedder under test — but it WILL have a non-null id.
    expect(src.id).toBeTruthy();

    const listed = await callApp(app, 'GET', `/notebooks/${nb.id}/sources`, { cookie });
    const { items } = await listed.json<{ items: { id: string; indexed: number; total: number }[] }>();
    expect(items.map((i) => i.id)).toContain(src.id);
    // Computed progress fields present.
    expect(typeof items[0]!.indexed).toBe('number');
    expect(typeof items[0]!.total).toBe('number');
  });

  test('create a url source → pending row, verified true', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const nb = await createNotebook(cookie);
    const res = await callApp(app, 'POST', `/notebooks/${nb.id}/sources`, {
      cookie,
      body: { kind: 'url', title: 'Web', url: 'https://example.com/doc' },
    });
    expect(res.status).toBe(200);
    const src = await res.json<{ kind: string; url: string; verified: boolean }>();
    expect(src.kind).toBe('url');
    expect(src.url).toBe('https://example.com/doc');
    expect(src.verified).toBe(true);
  });

  test('an upload source (pdf) → claim + presign envelope (sourceId + upload)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const nb = await createNotebook(cookie);
    const res = await callApp(app, 'POST', `/notebooks/${nb.id}/sources`, {
      cookie,
      body: { kind: 'upload', title: 'Book', mime: 'application/pdf', size: 12345 },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ sourceId: string; upload: { url: string; fields: Record<string, string> } }>();
    expect(body.sourceId).toBeTruthy();
    expect(body.upload.url).toBeTruthy();
    // The pending source row exists, unverified, kind pdf, storage_key set.
    const [row] = await db
      .select()
      .from(sourcesTable)
      .where(eq(sourcesTable.id, body.sourceId));
    expect(row!.kind).toBe('pdf');
    expect(row!.verified).toBe(false);
    expect(row!.status).toBe('pending');
    expect(row!.storageKey).toBe(`source/${body.sourceId}`);
  });

  test('upload with an unsupported mime → 400 unsupported_mime', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const nb = await createNotebook(cookie);
    const res = await callApp(app, 'POST', `/notebooks/${nb.id}/sources`, {
      cookie,
      body: { kind: 'upload', title: 'X', mime: 'application/zip', size: 100 },
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('unsupported_mime');
  });

  test('upload over MAX_SOURCE_BYTES → 400 too_large', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const nb = await createNotebook(cookie);
    const res = await callApp(app, 'POST', `/notebooks/${nb.id}/sources`, {
      cookie,
      body: { kind: 'upload', title: 'Huge', mime: 'application/pdf', size: env.ai.MAX_SOURCE_BYTES + 1 },
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('too_large');
  });

  test('MAX_SOURCES_PER_NOTEBOOK → 409 too_many_sources (seed up to the cap)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await createNotebook(cookie);
    const cap = env.ai.MAX_SOURCES_PER_NOTEBOOK;
    // Library refactor: the per-notebook cap counts notebook_sources EDGES.
    // Seed `cap` user-level sources and attach each to the notebook.
    const seeded = await db
      .insert(sourcesTable)
      .values(
        Array.from({ length: cap }, (_, i) => ({
          userId,
          kind: 'text' as const,
          title: `seed-${i}`,
          status: 'ready' as const,
          verified: true,
        })),
      )
      .returning({ id: sourcesTable.id });
    await db.insert(notebookSources).values(
      seeded.map((s) => ({ userId, notebookId: nb.id, sourceId: s.id })),
    );
    const res = await callApp(app, 'POST', `/notebooks/${nb.id}/sources`, {
      cookie,
      body: { kind: 'text', title: 'one too many', text: 'x' },
    });
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toBe('too_many_sources');
  });

  test('GET /sources/:id and rename/delete are user-scoped (404 foreign)', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const nbB = await createNotebook(b.cookie);
    const created = await callApp(app, 'POST', `/notebooks/${nbB.id}/sources`, {
      cookie: b.cookie,
      body: { kind: 'text', title: 's', text: 'body' },
    });
    const srcB = await created.json<{ id: string }>();

    expect((await callApp(app, 'GET', `/sources/${srcB.id}`, { cookie: a.cookie })).status).toBe(404);
    expect(
      (await callApp(app, 'PATCH', `/sources/${srcB.id}`, { cookie: a.cookie, body: { title: 'z' } })).status,
    ).toBe(404);
    expect((await callApp(app, 'DELETE', `/sources/${srcB.id}`, { cookie: a.cookie })).status).toBe(404);

    // The owner CAN read it.
    expect((await callApp(app, 'GET', `/sources/${srcB.id}`, { cookie: b.cookie })).status).toBe(200);
  });

  test('notebook delete PRESERVES sources + source_chunks + document kb_chunk (Р3/Р4); only the edge dies', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await createNotebook(cookie);
    // Seed a user-level source + its source_chunks + a document kb_chunk, attach
    // it to the notebook via the join edge.
    const [src] = await db
      .insert(sourcesTable)
      .values({
        userId,
        kind: 'text',
        title: 'doc',
        status: 'ready',
        verified: true,
        chunkCount: 1,
      })
      .returning({ id: sourcesTable.id });
    await db.insert(notebookSources).values({ userId, notebookId: nb.id, sourceId: src!.id });
    await db.insert(sourceChunks).values({
      userId,
      sourceId: src!.id,
      position: 0,
      text: 'chunk text',
      embedded: true,
    });
    await db.insert(kbChunk).values({
      userId,
      sourceType: 'document',
      sourceId: src!.id,
      // parentId = sourceId for documents (library refactor — kb-chunk.ts:13).
      parentId: src!.id,
      position: 0,
      text: 'chunk text',
      embeddingModel: 'test',
      sourceHash: 'h',
      cardId: null,
    });

    // Sanity: rows exist.
    const before = await db
      .select({ n: count() })
      .from(sourceChunks)
      .where(eq(sourceChunks.sourceId, src!.id));
    expect(before[0]!.n).toBe(1);

    const del = await callApp(app, 'DELETE', `/notebooks/${nb.id}`, { cookie });
    expect(del.status).toBe(200);

    // Library refactor (Р3/Р4): deleting the notebook does NOT touch the source —
    // it lives in the library and may be shared by other notebooks. The source,
    // its chunks, and its document vectors all SURVIVE.
    expect(
      (await db.select({ n: count() }).from(sourcesTable).where(eq(sourcesTable.id, src!.id)))[0]!.n,
    ).toBe(1);
    expect(
      (await db.select({ n: count() }).from(sourceChunks).where(eq(sourceChunks.sourceId, src!.id)))[0]!.n,
    ).toBe(1);
    const docChunks = (
      await db
        .select({ n: count() })
        .from(kbChunk)
        .where(and(eq(kbChunk.sourceId, src!.id), eq(kbChunk.sourceType, 'document')))
    )[0]!.n;
    expect(docChunks).toBe(1);
    // Only the notebook_sources EDGE dies with the notebook (FK cascade).
    const edges = (
      await db
        .select({ n: count() })
        .from(notebookSources)
        .where(eq(notebookSources.sourceId, src!.id))
    )[0]!.n;
    expect(edges).toBe(0);
  });
});

describe('/ai/status — notebooksEnabled (AC1.9)', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('status payload includes notebooksEnabled boolean', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const res = await callApp(app, 'GET', '/ai/status', { cookie });
    expect(res.status).toBe(200);
    const body = await res.json<{ notebooksEnabled: boolean }>();
    expect(body).toHaveProperty('notebooksEnabled');
    expect(typeof body.notebooksEnabled).toBe('boolean');
    // Under NODE_ENV=test with no injected embedder, embeddingEnabled is forced
    // off, so notebooksEnabled (= embeddingEnabled) is false.
    expect(body.notebooksEnabled).toBe(false);
  });
});
