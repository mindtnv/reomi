// Owned topic-plan storage. The user saves a module list onto one notebook.
// These tests call the HTTP routes the way the client will.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { count, eq, sql } from 'drizzle-orm';
import { cards, db, sources as sourcesTable } from '@reomi/db';
import { studyModule } from '@reomi/shared';
import { buildApp } from '../src/app.ts';
import { drainSourceIngest } from '../src/ai/source-ingest.ts';
import { __resetAiClientForTests, __setAiClientForTests } from '../src/ai/openai-client.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

interface SavedPlan {
  notebook: { id: string; title: string };
  plan: {
    id: string;
    userId: string;
    goal: string;
    level: string | null;
    modules: Array<{
      id: string;
      position: number;
      title: string;
      outcome: string;
      prerequisiteIds: string[];
      status: 'empty' | 'ingesting' | 'readable' | 'unavailable';
      sources: Array<{ sourceId: string; title: string; openable: boolean }>;
    }>;
  };
}

const ONE_MODULE = {
  title: 'Ownership',
  outcome: 'Explain who frees a value.',
};

function handPlan(extra: Record<string, unknown> = {}) {
  return {
    goal: 'Learn Rust',
    level: 'beginner',
    modules: [{ ...ONE_MODULE, prerequisiteIndexes: [] as number[] }],
    ...extra,
  };
}

async function cardCount(): Promise<number> {
  const [row] = await db.select({ n: count() }).from(cards);
  return row?.n ?? 0;
}

async function planCount(): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`select count(*)::int as n from topic_plans`);
  return Number(rows[0]?.n ?? 0);
}

describe('topic plan storage', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('401 without a session', async () => {
    const res = await callApp(app, 'POST', '/notebooks/plans', { body: handPlan() });
    expect(res.status).toBe(401);
    expect(await cardCount()).toBe(0);
  });

  test('first save stores one module with no URLs and creates no cards', async () => {
    const calls: string[] = [];
    __setAiClientForTests({
      complete: async () => {
        calls.push('complete');
        return '';
      },
    });
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const res = await callApp(app, 'POST', '/notebooks/plans', {
      cookie,
      body: {
        goal: 'Learn Rust',
        modules: [{ title: 'Ownership', outcome: 'Explain who frees a value.' }],
        userId: 'someone-else',
      },
    });
    expect(res.status).toBe(200);
    const saved = await res.json<SavedPlan>();
    expect(saved.notebook.title).toBe('Learn Rust');
    expect(saved.plan.userId).toBe(userId);
    expect(saved.plan.goal).toBe('Learn Rust');
    expect(saved.plan.level).toBe(null);
    expect(saved.plan.modules).toEqual([
      {
        id: saved.plan.modules[0]!.id,
        position: 0,
        title: 'Ownership',
        outcome: 'Explain who frees a value.',
        prerequisiteIds: [],
        status: 'empty',
        sources: [],
      },
    ]);
    expect(calls).toEqual([]);
    expect(await cardCount()).toBe(0);

    const again = await callApp(app, 'GET', `/notebooks/${saved.notebook.id}/plan`, { cookie });
    expect(again.status).toBe(200);
    expect(await again.json<SavedPlan>()).toEqual(saved);
  });

  test('thirteen modules are rejected and write nothing', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const modules = Array.from({ length: 13 }, (_, i) => ({
      title: `Module ${i}`,
      outcome: `Outcome ${i}`,
      prerequisiteIndexes: [],
    }));
    const res = await callApp(app, 'POST', '/notebooks/plans', {
      cookie,
      body: { goal: 'Too big', modules },
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('too_many_modules');
    const list = await callApp(app, 'GET', '/notebooks', { cookie });
    expect((await list.json<{ items: unknown[] }>()).items).toEqual([]);
    expect(await cardCount()).toBe(0);
  });

  test('a forward prerequisite is rejected and writes nothing', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const res = await callApp(app, 'POST', '/notebooks/plans', {
      cookie,
      body: {
        goal: 'Learn Rust',
        modules: [
          { title: 'Ownership', outcome: 'Explain borrowing.', prerequisiteIndexes: [1] },
          { title: 'Lifetimes', outcome: 'Name a scope.', prerequisiteIndexes: [1] },
        ],
      },
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_prerequisite');
    const list = await callApp(app, 'GET', '/notebooks', { cookie });
    expect((await list.json<{ items: unknown[] }>()).items).toEqual([]);
  });

  test('a second save keeps a module id and does not rename the notebook', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const created = await callApp(app, 'POST', '/notebooks/plans', { cookie, body: handPlan() });
    expect(created.status).toBe(200);
    const first = await created.json<SavedPlan>();
    const keptId = first.plan.modules[0]!.id;

    const renamed = await callApp(app, 'PATCH', `/notebooks/${first.notebook.id}`, {
      cookie,
      body: { title: 'Rust book' },
    });
    expect(renamed.status).toBe(200);

    const second = await callApp(app, 'PUT', `/notebooks/${first.notebook.id}/plan`, {
      cookie,
      body: {
        goal: 'Learn Rust ownership',
        level: 'intermediate',
        modules: [
          { id: keptId, title: 'Ownership', outcome: 'Explain who frees a value.', prerequisiteIndexes: [] },
          { title: 'Lifetimes', outcome: 'Name a scope.', prerequisiteIndexes: [0] },
        ],
      },
    });
    expect(second.status).toBe(200);
    const saved = await second.json<SavedPlan>();
    expect(saved.notebook.title).toBe('Rust book');
    expect(saved.plan.goal).toBe('Learn Rust ownership');
    expect(saved.plan.level).toBe('intermediate');
    expect(saved.plan.modules.map((m) => m.id)[0]).toBe(keptId);
    expect(saved.plan.modules[1]!.id).not.toBe(keptId);
    expect(saved.plan.modules[1]!.prerequisiteIds).toEqual([keptId]);
    expect(saved.plan.modules[0]).toMatchObject({ status: 'empty', sources: [] });
  });

  test('a second save can drop a module without deleting its library source', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const created = await callApp(app, 'POST', '/notebooks/plans', {
      cookie,
      body: {
        goal: 'Learn Rust',
        modules: [
          { title: 'Ownership', outcome: 'Explain borrowing.', prerequisiteIndexes: [] },
          { title: 'Lifetimes', outcome: 'Name a scope.', prerequisiteIndexes: [0] },
        ],
      },
    });
    expect(created.status).toBe(200);
    const first = await created.json<SavedPlan>();
    const dropId = first.plan.modules[0]!.id;
    const keepId = first.plan.modules[1]!.id;

    const sourceRes = await callApp(app, 'POST', '/library/items', {
      cookie,
      body: {
        kind: 'text',
        title: 'Rust book',
        text: 'Ownership is a set of rules.',
        notebookId: first.notebook.id,
      },
    });
    expect(sourceRes.status).toBe(200);
    const source = await sourceRes.json<{ id: string }>();

    await db.execute(sql`
      insert into topic_module_sources (module_id, source_id, user_id)
      values (${dropId}, ${source.id}, ${userId})
    `);

    await drainSourceIngest({ timeoutMs: 4000 });
    const [row] = await db
      .select({
        title: sourcesTable.title,
        status: sourcesTable.status,
        errorCode: sourcesTable.errorCode,
      })
      .from(sourcesTable)
      .where(eq(sourcesTable.id, source.id));
    const studied = studyModule([
      {
        sourceId: source.id,
        title: row!.title,
        status: row!.status,
        errorCode: row!.errorCode,
      },
    ]);
    const before = await callApp(app, 'GET', `/notebooks/${first.notebook.id}/plan`, { cookie });
    const linked = await before.json<SavedPlan>();
    expect(linked.plan.modules[0]?.status).toBe(studied.status);
    expect(linked.plan.modules[0]?.sources).toEqual([...studied.sources]);

    const second = await callApp(app, 'PUT', `/notebooks/${first.notebook.id}/plan`, {
      cookie,
      body: {
        goal: 'Learn Rust',
        modules: [
          { id: keepId, title: 'Lifetimes', outcome: 'Name a scope.', prerequisiteIndexes: [] },
        ],
      },
    });
    expect(second.status).toBe(200);
    const saved = await second.json<SavedPlan>();
    expect(saved.plan.modules.map((m) => m.id)).toEqual([keepId]);
    expect(saved.plan.modules[0]).toMatchObject({ status: 'empty', sources: [] });

    const stillThere = await callApp(app, 'GET', `/library/items/${source.id}`, { cookie });
    expect(stillThere.status).toBe(200);
    expect((await stillThere.json<{ id: string }>()).id).toBe(source.id);

    const attached = await callApp(app, 'GET', `/notebooks/${first.notebook.id}/sources`, { cookie });
    const items = (await attached.json<{ items: Array<{ id: string }> }>()).items;
    expect(items.map((item) => item.id)).toEqual([source.id]);

    const links = await db.execute<{ n: number }>(
      sql`select count(*)::int as n from topic_module_sources`,
    );
    expect(Number(links[0]?.n ?? 0)).toBe(0);
    const [sourceRow] = await db.select({ id: sourcesTable.id }).from(sourcesTable);
    expect(sourceRow?.id).toBe(source.id);
  });

  test('a second plan for one notebook is 409 and the stored plan stays', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const notebook = await callApp(app, 'POST', '/notebooks', {
      cookie,
      body: { title: 'Already mine' },
    });
    expect(notebook.status).toBe(200);
    const notebookId = (await notebook.json<{ id: string }>()).id;

    const first = await callApp(app, 'POST', '/notebooks/plans', {
      cookie,
      body: { ...handPlan(), notebookId },
    });
    expect(first.status).toBe(200);
    const stored = await first.json<SavedPlan>();
    expect(stored.notebook.title).toBe('Already mine');

    const again = await callApp(app, 'POST', '/notebooks/plans', {
      cookie,
      body: { ...handPlan({ goal: 'A different goal' }), notebookId },
    });
    expect(again.status).toBe(409);
    expect((await again.json<{ error: string }>()).error).toBe('plan_exists');

    const read = await callApp(app, 'GET', `/notebooks/${notebookId}/plan`, { cookie });
    expect(await read.json<SavedPlan>()).toEqual(stored);
  });

  test('a foreign or missing notebook writes nothing', async () => {
    const owner = await signUpAndCookie(app, uniqueEmail());
    const other = await signUpAndCookie(app, uniqueEmail('other'));
    const notebook = await callApp(app, 'POST', '/notebooks', {
      cookie: owner.cookie,
      body: { title: 'Private' },
    });
    const notebookId = (await notebook.json<{ id: string }>()).id;

    const foreign = await callApp(app, 'POST', '/notebooks/plans', {
      cookie: other.cookie,
      body: { ...handPlan(), notebookId },
    });
    expect(foreign.status).toBe(404);
    expect((await foreign.json<{ error: string }>()).error).toBe('not_found');

    const missing = await callApp(app, 'POST', '/notebooks/plans', {
      cookie: owner.cookie,
      body: { ...handPlan(), notebookId: '018f3b2a-7c31-7b2a-8c11-111111111111' },
    });
    expect(missing.status).toBe(404);
    expect((await missing.json<{ error: string }>()).error).toBe('not_found');

    const read = await callApp(app, 'GET', `/notebooks/${notebookId}/plan`, { cookie: other.cookie });
    expect(read.status).toBe(404);
    const ownerRead = await callApp(app, 'GET', `/notebooks/${notebookId}/plan`, { cookie: owner.cookie });
    expect(ownerRead.status).toBe(404);
    expect(await planCount()).toBe(0);
  });

  test('deleting the notebook removes the plan and keeps the library source', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const created = await callApp(app, 'POST', '/notebooks/plans', { cookie, body: handPlan() });
    expect(created.status).toBe(200);
    const saved = await created.json<SavedPlan>();
    const sourceRes = await callApp(app, 'POST', '/library/items', {
      cookie,
      body: { kind: 'text', title: 'Kept page', text: 'Still in the library.', notebookId: saved.notebook.id },
    });
    expect(sourceRes.status).toBe(200);
    const sourceId = (await sourceRes.json<{ id: string }>()).id;

    const del = await callApp(app, 'DELETE', `/notebooks/${saved.notebook.id}`, { cookie });
    expect(del.status).toBe(200);
    const read = await callApp(app, 'GET', `/notebooks/${saved.notebook.id}/plan`, { cookie });
    expect(read.status).toBe(404);
    expect(await planCount()).toBe(0);
    const stillThere = await callApp(app, 'GET', `/library/items/${sourceId}`, { cookie });
    expect(stillThere.status).toBe(200);
    expect((await stillThere.json<{ id: string }>()).id).toBe(sourceId);
    expect(await cardCount()).toBe(0);
  });
});
