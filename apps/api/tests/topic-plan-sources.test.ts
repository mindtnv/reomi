// Accepted URLs become library sources only through this action. Normalization
// is pure. A retry reuses the oldest owned match and does not insert again.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { count, eq } from 'drizzle-orm';
import { cards, db, notebookSources, sources as sourcesTable } from '@reomi/db';
import { buildApp } from '../src/app.ts';
import { env } from '../src/env.ts';
import { drainSourceIngest } from '../src/ai/source-ingest.ts';
import { __resetPageReaderForTests, __setDnsLookupForTests, __setPageReaderForTests } from '../src/ai/page-reader.ts';
import { __setYoutubeFetchForTests } from '../src/ai/youtube-transcript.ts';
import { normalizePlanUrl } from '../src/modules/topic-plan.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

interface SavedPlan {
  notebook: { id: string };
  plan: {
    modules: Array<{
      id: string;
      status: string;
      sources: Array<{ sourceId: string; openable: boolean }>;
    }>;
  };
}

interface AddResult {
  items: Array<{ url: string; result: string; sourceId?: string }>;
}

describe('documentation version column', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('a library source stores a documentation version and leaves it empty on an apex host', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const [versioned] = await db
      .insert(sourcesTable)
      .values({
        userId,
        kind: 'url',
        title: 'Pods',
        url: 'https://v1-34.docs.example/docs/concepts/pods/',
        status: 'planned',
        verified: true,
        docVersion: 'v1.34',
      })
      .returning({ id: sourcesTable.id });
    const [stored] = await db
      .select({ docVersion: sourcesTable.docVersion })
      .from(sourcesTable)
      .where(eq(sourcesTable.id, versioned!.id));
    expect(stored?.docVersion).toBe('v1.34');

    const [apex] = await db
      .insert(sourcesTable)
      .values({
        userId,
        kind: 'url',
        title: 'Pods',
        url: 'https://docs.example/docs/concepts/pods/',
        status: 'planned',
        verified: true,
      })
      .returning({ docVersion: sourcesTable.docVersion });
    expect(apex?.docVersion).toBeNull();
  });
});

describe('normalizePlanUrl', () => {
  test('trims, keeps http(s), drops userinfo, fragment, and default ports', () => {
    expect(normalizePlanUrl('  HTTPS://Example.com:443/Rust?q=1#frag  ')).toBe(
      'https://example.com/Rust?q=1',
    );
    expect(normalizePlanUrl('http://example.com:80/a')).toBe('http://example.com/a');
    expect(normalizePlanUrl('http://user:pass@example.com/a')).toBeNull();
    expect(normalizePlanUrl('ftp://example.com/a')).toBeNull();
    expect(normalizePlanUrl('not a url')).toBeNull();
  });
});

async function savedModule(cookie: string): Promise<{ notebookId: string; moduleId: string }> {
  const res = await callApp(app, 'POST', '/notebooks/plans', {
    cookie,
    body: {
      goal: 'Learn Rust',
      modules: [{ title: 'Ownership', outcome: 'Explain who frees a value.', prerequisiteIndexes: [] }],
    },
  });
  expect(res.status).toBe(200);
  const body = await res.json<SavedPlan>();
  return { notebookId: body.notebook.id, moduleId: body.plan.modules[0]!.id };
}

function sourcesPath(notebookId: string, moduleId: string): string {
  return `/notebooks/${notebookId}/plan/modules/${moduleId}/sources`;
}

async function sourceCount(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(sourcesTable);
  return row?.n ?? 0;
}

async function cardCount(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(cards);
  return row?.n ?? 0;
}

describe('topic plan sources', () => {
  beforeEach(async () => {
    await resetTestDb();
    __setPageReaderForTests({
      async read(url: string) {
        const [row] = await db
          .select({ id: sourcesTable.id })
          .from(sourcesTable)
          .where(eq(sourcesTable.url, url))
          .limit(1);
        expect(row).toBeDefined();
        throw new Error('ingest failed after the row existed');
      },
    });
  });
  afterEach(async () => {
    await drainSourceIngest({ timeoutMs: 4000 });
    __resetPageReaderForTests();
    __setYoutubeFetchForTests(null);
    __setDnsLookupForTests(null);
  });

  test('a new URL is created and a retry links the same row', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const { notebookId, moduleId } = await savedModule(cookie);
    const first = await callApp(app, 'POST', sourcesPath(notebookId, moduleId), {
      cookie,
      body: { urls: ['https://example.com/rust'] },
    });
    expect(first.status).toBe(200);
    const created = await first.json<AddResult>();
    expect(created.items).toEqual([
      { url: 'https://example.com/rust', result: 'created', sourceId: expect.any(String) },
    ]);
    expect(await sourceCount()).toBe(1);
    expect(await cardCount()).toBe(0);

    const again = await callApp(app, 'POST', sourcesPath(notebookId, moduleId), {
      cookie,
      body: { urls: ['HTTPS://Example.com/rust#section'] },
    });
    expect(again.status).toBe(200);
    const linked = await again.json<AddResult>();
    expect(linked.items[0]?.result).toBe('linked');
    expect(linked.items[0]?.sourceId).toBe(created.items[0]?.sourceId);
    expect(await sourceCount()).toBe(1);

    await drainSourceIngest({ timeoutMs: 4000 });
    const plan = await callApp(app, 'GET', `/notebooks/${notebookId}/plan`, { cookie });
    const saved = await plan.json<SavedPlan>();
    const sourceId = created.items[0]?.sourceId;
    const [row] = await db
      .select({ status: sourcesTable.status, errorCode: sourcesTable.errorCode })
      .from(sourcesTable)
      .where(eq(sourcesTable.id, sourceId!));
    expect(row?.status).toBe('error');
    expect(row?.errorCode).not.toBe('index_failed');
    expect(saved.plan.modules[0]?.sources.map((source) => source.sourceId)).toEqual([sourceId]);
    expect(saved.plan.modules[0]?.status).toBe('unavailable');
    expect(saved.plan.modules[0]?.sources[0]?.openable).toBe(false);
  });

  test('the oldest owned non-deleting URL is reused', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const { notebookId, moduleId } = await savedModule(cookie);
    const [deleting] = await db
      .insert(sourcesTable)
      .values({
        userId,
        kind: 'url',
        title: 'Deleting',
        url: 'HTTPS://Example.com/rust#old',
        status: 'deleting',
        verified: true,
        createdAt: new Date('2019-01-01T00:00:00Z'),
      })
      .returning({ id: sourcesTable.id });
    const [older] = await db
      .insert(sourcesTable)
      .values({
        userId,
        kind: 'url',
        title: 'Older',
        url: 'HTTPS://Example.com/rust#old',
        status: 'ready',
        verified: true,
        createdAt: new Date('2020-01-01T00:00:00Z'),
      })
      .returning({ id: sourcesTable.id });
    await db.insert(sourcesTable).values({
      userId,
      kind: 'url',
      title: 'Newer',
      url: 'https://example.com/rust',
      status: 'ready',
      verified: true,
      createdAt: new Date('2021-01-01T00:00:00Z'),
    });

    const res = await callApp(app, 'POST', sourcesPath(notebookId, moduleId), {
      cookie,
      body: { urls: ['https://example.com/rust'] },
    });
    expect(res.status).toBe(200);
    const body = await res.json<AddResult>();
    expect(body.items[0]?.result).toBe('linked');
    expect(body.items[0]?.sourceId).toBe(older!.id);
    expect(body.items[0]?.sourceId).not.toBe(deleting!.id);
    expect(await sourceCount()).toBe(3);

    const attached = await db
      .select({ sourceId: notebookSources.sourceId })
      .from(notebookSources)
      .where(eq(notebookSources.notebookId, notebookId));
    expect(attached.map((row) => row.sourceId)).toEqual([older!.id]);
    expect(await cardCount()).toBe(0);
  });

  test('an invalid URL does not stop an earlier create, and caps stop the rest', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const { notebookId, moduleId } = await savedModule(cookie);
    const cap = env.ai.MAX_LIBRARY_ITEMS_PER_USER;
    await db.insert(sourcesTable).values(
      Array.from({ length: cap - 1 }, (_, index) => ({
        userId,
        kind: 'text' as const,
        title: `seed-${index}`,
        status: 'ready' as const,
        verified: true,
      })),
    );

    const res = await callApp(app, 'POST', sourcesPath(notebookId, moduleId), {
      cookie,
      body: {
        urls: ['ftp://example.com/nope', 'https://example.com/one', 'https://example.com/two'],
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json<AddResult>();
    expect(body.items.map((item) => item.result)).toEqual(['invalid_url', 'created', 'library_full']);
    expect(await sourceCount()).toBe(cap);

    const retry = await callApp(app, 'POST', sourcesPath(notebookId, moduleId), {
      cookie,
      body: { urls: ['https://example.com/one'] },
    });
    expect((await retry.json<AddResult>()).items[0]?.result).toBe('linked');
    expect(await sourceCount()).toBe(cap);
    expect(await cardCount()).toBe(0);
  });

  test('a full notebook stops a new URL and keeps an earlier link', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const { notebookId, moduleId } = await savedModule(cookie);
    const cap = env.ai.MAX_SOURCES_PER_NOTEBOOK;
    const seeded = await db
      .insert(sourcesTable)
      .values(
        Array.from({ length: cap - 1 }, (_, index) => ({
          userId,
          kind: 'text' as const,
          title: `attached-${index}`,
          status: 'ready' as const,
          verified: true,
        })),
      )
      .returning({ id: sourcesTable.id });
    await db.insert(notebookSources).values(
      seeded.map((row) => ({ userId, notebookId, sourceId: row.id })),
    );
    const [held] = await db
      .insert(sourcesTable)
      .values({
        userId,
        kind: 'url',
        title: 'Held',
        url: 'https://example.com/held',
        status: 'ready',
        verified: true,
      })
      .returning({ id: sourcesTable.id });
    await db.insert(notebookSources).values({ userId, notebookId, sourceId: held!.id });

    const res = await callApp(app, 'POST', sourcesPath(notebookId, moduleId), {
      cookie,
      body: { urls: ['https://example.com/held', 'https://example.com/new'] },
    });
    expect(res.status).toBe(200);
    const body = await res.json<AddResult>();
    expect(body.items.map((item) => item.result)).toEqual(['linked', 'too_many_sources']);
    expect(body.items[0]?.sourceId).toBe(held!.id);
    expect(await sourceCount()).toBe(cap);
    expect(await cardCount()).toBe(0);
  });

  test('a second accept of an active YouTube video links that row', async () => {
    __setDnsLookupForTests(async () => [{ address: '142.250.1.1', family: 4 }]);
    __setYoutubeFetchForTests(async () => ({ status: 500, body: '' }));
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const { notebookId, moduleId } = await savedModule(cookie);
    const canonical = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const first = await callApp(app, 'POST', sourcesPath(notebookId, moduleId), {
      cookie,
      body: { urls: [canonical] },
    });
    expect(first.status).toBe(200);
    const created = await first.json<AddResult>();
    const sourceId = created.items[0]?.sourceId;
    expect(created.items).toEqual([{ url: canonical, result: 'created', sourceId: expect.any(String) }]);
    await drainSourceIngest({ timeoutMs: 4000 });
    await db.update(sourcesTable).set({ status: 'ready' }).where(eq(sourcesTable.id, sourceId!));

    const again = await callApp(app, 'POST', sourcesPath(notebookId, moduleId), {
      cookie,
      body: { urls: ['https://youtu.be/dQw4w9WgXcQ'] },
    });
    expect(again.status).toBe(200);
    expect(await again.json<AddResult>()).toEqual({
      items: [{ url: 'https://youtu.be/dQw4w9WgXcQ', result: 'linked', sourceId }],
    });
    expect(await sourceCount()).toBe(1);
    const [stored] = await db
      .select({ kind: sourcesTable.kind, url: sourcesTable.url })
      .from(sourcesTable)
      .where(eq(sourcesTable.id, sourceId!));
    expect(stored).toEqual({ kind: 'youtube', url: canonical });
    const attached = await db
      .select({ sourceId: notebookSources.sourceId })
      .from(notebookSources)
      .where(eq(notebookSources.notebookId, notebookId));
    expect(attached.map((row) => row.sourceId)).toEqual([sourceId]);
    expect(await cardCount()).toBe(0);
  });

  test('a second accept of an errored YouTube video links that row', async () => {
    __setDnsLookupForTests(async () => [{ address: '142.250.1.1', family: 4 }]);
    __setYoutubeFetchForTests(async () => ({ status: 500, body: '' }));
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const { notebookId, moduleId } = await savedModule(cookie);
    const canonical = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const first = await callApp(app, 'POST', sourcesPath(notebookId, moduleId), {
      cookie,
      body: { urls: [canonical] },
    });
    const sourceId = (await first.json<AddResult>()).items[0]?.sourceId;
    expect(first.status).toBe(200);
    await drainSourceIngest({ timeoutMs: 4000 });
    const [errored] = await db
      .select({ status: sourcesTable.status })
      .from(sourcesTable)
      .where(eq(sourcesTable.id, sourceId!));
    expect(errored?.status).toBe('error');

    const retry = await callApp(app, 'POST', sourcesPath(notebookId, moduleId), {
      cookie,
      body: { urls: ['https://www.youtube.com/shorts/dQw4w9WgXcQ'] },
    });
    expect(retry.status).toBe(200);
    expect(await retry.json<AddResult>()).toEqual({
      items: [{ url: 'https://www.youtube.com/shorts/dQw4w9WgXcQ', result: 'linked', sourceId }],
    });
    expect(await sourceCount()).toBe(1);
    const plan = await callApp(app, 'GET', `/notebooks/${notebookId}/plan`, { cookie });
    const saved = await plan.json<SavedPlan>();
    expect(saved.plan.modules[0]?.sources.map((source) => source.sourceId)).toEqual([sourceId]);
    expect(await cardCount()).toBe(0);
  });

  test('a playlist URL is invalid and the earlier URL stays in the batch', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const { notebookId, moduleId } = await savedModule(cookie);
    const res = await callApp(app, 'POST', sourcesPath(notebookId, moduleId), {
      cookie,
      body: {
        urls: ['https://example.com/one', 'https://www.youtube.com/playlist?list=PL123'],
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json<AddResult>();
    expect(body.items.map((item) => item.result)).toEqual(['created', 'invalid_url']);
    expect(body.items[0]?.url).toBe('https://example.com/one');
    expect(body.items[1]?.url).toBe('https://www.youtube.com/playlist?list=PL123');
    expect(await sourceCount()).toBe(1);
    expect(await cardCount()).toBe(0);
  });

  test('a foreign module writes nothing', async () => {
    const owner = await signUpAndCookie(app, uniqueEmail());
    const { notebookId, moduleId } = await savedModule(owner.cookie);
    const other = await signUpAndCookie(app, uniqueEmail('other'));
    const before = await sourceCount();
    const res = await callApp(app, 'POST', sourcesPath(notebookId, moduleId), {
      cookie: other.cookie,
      body: { urls: ['https://example.com/rust'] },
    });
    expect(res.status).toBe(404);
    expect((await res.json<{ error: string }>()).error).toBe('not_found');
    expect(await sourceCount()).toBe(before);
    expect(await cardCount()).toBe(0);
  });
});
