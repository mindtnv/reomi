// «Блокноты 2.0» studio (N2) — artifact status machine + context sampling +
// [src:] intersect + the fixed POST check order + concurrency CAS + reconcile.
//
// CONTRACT (read from apps/api/src/ai/artifacts.ts + modules/notebooks.ts):
//   * POST /notebooks/:id/artifacts {type, sourceIds?} → a `pending` job row;
//     check order ownership-404 → 400 invalid_type → 400 no_sources →
//     409 too_many_artifacts → 409 generation_in_progress; async kick.
//   * generateArtifact(id): CAS pending→generating → buildArtifactContext (Р4
//     even round-robin sample over ready sources, re-verifying ownership) →
//     bounded complete() → [src:] intersect (Р5, un-sampled tokens stripped) →
//     CAS generating→ready (content_md + model). No ready sources ⇒ no_sources;
//     a fake without complete ⇒ ai_disabled; an infinite promise ⇒ timeout.
//   * reconcileArtifactsOnStartup(): pending|generating → error('interrupted').
//
// The generation worker is driven SYNCHRONOUSLY via `generateArtifact(id)` over a
// directly-inserted artifact row (no route kick race), mirroring how
// source-reingest drives `ingestSource`. The scripted complete() fake captures
// the LAST prompt so the round-robin sample can be asserted from the material.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { and, count, eq } from 'drizzle-orm';
import {
  db,
  notebookArtifacts as artifactsTable,
  notebooks as notebooksTable,
  notebookSources as notebookSourcesTable,
  sourceChunks as sourceChunksTable,
  sources as sourcesTable,
} from '@reomi/db';
import { buildApp } from '../src/app.ts';
import {
  __resetAiClientForTests,
  __setAiClientForTests,
  type ChatMessage,
} from '../src/ai/openai-client.ts';
import {
  buildArtifactContext,
  evenSample,
  generateArtifact,
  reconcileArtifactsOnStartup,
} from '../src/ai/artifacts.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

// ── fakes ───────────────────────────────────────────────────────────────────

let lastPrompt = '';

/** A `complete()` fake that returns a fixed string and captures the user prompt. */
function installComplete(reply: string | ((messages: ChatMessage[]) => string)): void {
  __setAiClientForTests({
    async complete(messages: ChatMessage[]): Promise<string> {
      lastPrompt = messages.map((m) => m.content).join('\n');
      return typeof reply === 'function' ? reply(messages) : reply;
    },
  });
}

/** A fake WITH a chat surface but WITHOUT complete — exercises ai_disabled. */
function installNoComplete(): void {
  __setAiClientForTests({
    async *chatStreamAgentic() {
      yield { type: 'finish', reason: 'stop' };
    },
  });
}

/** A `complete()` fake that never resolves — exercises the timeout branch. */
function installHangingComplete(): void {
  __setAiClientForTests({
    complete(): Promise<string> {
      return new Promise<string>(() => {});
    },
  });
}

// ── fixtures ──────────────────────────────────────────────────────────────────

async function freshNotebook(userId: string, title = 'NB'): Promise<string> {
  const [nb] = await db
    .insert(notebooksTable)
    .values({ userId, title })
    .returning({ id: notebooksTable.id });
  return nb!.id;
}

/** Seed a source (status default 'ready') + its chunks, attach to the notebook. */
async function seedSource(
  userId: string,
  notebookId: string,
  title: string,
  chunks: string[],
  status: 'ready' | 'indexing' | 'error' = 'ready',
): Promise<{ sourceId: string; chunkIds: string[] }> {
  const [src] = await db
    .insert(sourcesTable)
    .values({ userId, kind: 'pdf', title, status, verified: true, chunkCount: chunks.length })
    .returning({ id: sourcesTable.id });
  const sourceId = src!.id;
  await db.insert(notebookSourcesTable).values({ userId, notebookId, sourceId });
  const chunkIds: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const [sc] = await db
      .insert(sourceChunksTable)
      .values({ userId, sourceId, position: i, text: chunks[i]!, embedded: true })
      .returning({ id: sourceChunksTable.id });
    chunkIds.push(sc!.id);
  }
  return { sourceId, chunkIds };
}

/** Insert an artifact row directly (status pending) — bypasses the route kick. */
async function insertArtifact(
  userId: string,
  notebookId: string,
  sourceIds: string[],
  opts: { type?: string; status?: string } = {},
): Promise<string> {
  const [row] = await db
    .insert(artifactsTable)
    .values({
      userId,
      notebookId,
      type: opts.type ?? 'summary',
      status: opts.status ?? 'pending',
      title: 'Обзор',
      sourceIds,
    })
    .returning({ id: artifactsTable.id });
  return row!.id;
}

function getArtifact(id: string) {
  return db
    .select()
    .from(artifactsTable)
    .where(eq(artifactsTable.id, id))
    .limit(1)
    .then((r) => r[0]!);
}

// ── status machine + [src:] intersect ─────────────────────────────────────────

describe('generateArtifact — status machine', () => {
  beforeEach(async () => {
    await resetTestDb();
    lastPrompt = '';
  });
  afterEach(() => __resetAiClientForTests());

  test('pending → ready with content_md + model', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const { sourceId } = await seedSource(userId, nb, 'Doc', ['alpha', 'beta', 'gamma']);
    installComplete('# Overview\n\nAll about it.');

    const id = await insertArtifact(userId, nb, [sourceId]);
    await generateArtifact(id);

    const row = await getArtifact(id);
    expect(row.status).toBe('ready');
    expect(row.contentMd).toContain('# Overview');
    expect(row.errorCode).toBeNull();
    expect(row.model).toBeTruthy();
  });

  test('[src:] intersect — invalid token stripped, valid token kept', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const { sourceId, chunkIds } = await seedSource(userId, nb, 'Doc', ['alpha', 'beta']);
    const validId = chunkIds[0]!;
    const bogusId = '00000000-0000-0000-0000-000000000000';
    installComplete(`Fact one [src:${validId}]. Fact two [src:${bogusId}].`);

    const id = await insertArtifact(userId, nb, [sourceId]);
    await generateArtifact(id);

    const row = await getArtifact(id);
    expect(row.status).toBe('ready');
    expect(row.contentMd).toContain(`[src:${validId}]`);
    expect(row.contentMd).not.toContain(bogusId);
  });

  test('a fake WITHOUT complete ⇒ error ai_disabled', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const { sourceId } = await seedSource(userId, nb, 'Doc', ['alpha']);
    installNoComplete();

    const id = await insertArtifact(userId, nb, [sourceId]);
    await generateArtifact(id);

    const row = await getArtifact(id);
    expect(row.status).toBe('error');
    expect(row.errorCode).toBe('ai_disabled');
  });

  test('a hanging complete ⇒ error timeout (ARTIFACT_TIMEOUT_MS via env override)', async () => {
    const { env } = await import('../src/env.ts');
    const saved = env.ai.ARTIFACT_TIMEOUT_MS;
    try {
      env.ai.ARTIFACT_TIMEOUT_MS = 50;
      const { userId } = await signUpAndCookie(app, uniqueEmail());
      const nb = await freshNotebook(userId);
      const { sourceId } = await seedSource(userId, nb, 'Doc', ['alpha']);
      installHangingComplete();

      const id = await insertArtifact(userId, nb, [sourceId]);
      await generateArtifact(id);

      const row = await getArtifact(id);
      expect(row.status).toBe('error');
      expect(row.errorCode).toBe('timeout');
    } finally {
      env.ai.ARTIFACT_TIMEOUT_MS = saved;
    }
  });

  test('no ready sources at worker time ⇒ error no_sources (reingest race)', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    // Snapshot a source that is NOT ready (e.g. mid-reingest) — Р4 re-verify drops it.
    const { sourceId } = await seedSource(userId, nb, 'Doc', ['alpha'], 'indexing');
    installComplete('should not be called');

    const id = await insertArtifact(userId, nb, [sourceId]);
    await generateArtifact(id);

    const row = await getArtifact(id);
    expect(row.status).toBe('error');
    expect(row.errorCode).toBe('no_sources');
  });

  test('a lost CAS race (already ready) is a clean no-op', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const { sourceId } = await seedSource(userId, nb, 'Doc', ['alpha']);
    installComplete('x');
    const id = await insertArtifact(userId, nb, [sourceId], { status: 'ready' });
    await generateArtifact(id); // not 'pending' → 0-row CAS → exit
    const row = await getArtifact(id);
    expect(row.status).toBe('ready'); // unchanged
  });
});

// ── context sampling (round-robin, Р4) ────────────────────────────────────────

describe('buildArtifactContext — round-robin + even sample', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => __resetAiClientForTests());

  test('two sources → chunks of BOTH appear (round-robin)', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const a = await seedSource(userId, nb, 'A', ['a0', 'a1', 'a2', 'a3']);
    const b = await seedSource(userId, nb, 'B', ['b0', 'b1', 'b2', 'b3']);

    const ctx = await buildArtifactContext(userId, [a.sourceId, b.sourceId], 4);
    const fromA = ctx.chunks.filter((c) => c.sourceId === a.sourceId);
    const fromB = ctx.chunks.filter((c) => c.sourceId === b.sourceId);
    expect(fromA.length).toBeGreaterThan(0);
    expect(fromB.length).toBeGreaterThan(0);
    // allowedChunkIds matches the sampled ids exactly.
    expect(ctx.allowedChunkIds.size).toBe(ctx.chunks.length);
  });

  test('round-robin shows up in the generation prompt (both source titles)', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const a = await seedSource(userId, nb, 'AlphaBook', ['a0', 'a1']);
    const b = await seedSource(userId, nb, 'BetaBook', ['b0', 'b1']);
    installComplete('ok');

    const id = await insertArtifact(userId, nb, [a.sourceId, b.sourceId]);
    await generateArtifact(id);
    expect(lastPrompt).toContain('AlphaBook');
    expect(lastPrompt).toContain('BetaBook');
  });

  test('md prompt carries the rich-markup directive (mermaid + GFM tables)', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const a = await seedSource(userId, nb, 'AlphaBook', ['a0', 'a1']);
    installComplete('ok');

    const id = await insertArtifact(userId, nb, [a.sourceId]);
    await generateArtifact(id);
    // The reader renders the full RichCard pipeline — the generator is told to
    // actually use it (diagrams grounded in the material, tokens kept out of
    // mermaid blocks). Pin the directive so a prompt refactor can't drop it.
    expect(lastPrompt).toContain('mermaid');
    expect(lastPrompt).toContain('pipe tables');
    expect(lastPrompt).toContain('NEVER inside mermaid blocks');
  });

  test('evenSample picks first..last, distinct, ascending', () => {
    expect(evenSample([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 3)).toEqual([0, 5, 9]);
    expect(evenSample([0, 1, 2], 5)).toEqual([0, 1, 2]); // count ≥ len ⇒ all
    expect(evenSample([0, 1, 2, 3], 1)).toEqual([0]);
    expect(evenSample([], 4)).toEqual([]);
  });
});

// ── POST route: fixed check order + caps + concurrency ────────────────────────

describe('POST /notebooks/:id/artifacts — checks + concurrency', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => __resetAiClientForTests());

  test('creates a pending job row (async kick); list excludes content', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const { sourceId } = await seedSource(userId, nb, 'Doc', ['alpha', 'beta']);
    installComplete('# Done');

    const res = await callApp(app, 'POST', `/notebooks/${nb}/artifacts`, {
      cookie,
      body: { type: 'summary' },
    });
    expect(res.status).toBe(200);
    const row = await res.json<{ id: string; status: string; sourceIds: string[] }>();
    expect(row.status).toBe('pending');
    expect(row.sourceIds).toEqual([sourceId]);

    const list = await callApp(app, 'GET', `/notebooks/${nb}/artifacts`, { cookie });
    const items = (await list.json<{ items: Record<string, unknown>[] }>()).items;
    expect(items.length).toBe(1);
    expect(items[0]).not.toHaveProperty('contentMd');
    expect(items[0]).not.toHaveProperty('content_md');
  });

  test('invalid_type is checked BEFORE no_sources (no ready sources, bad type)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId); // no sources at all
    const res = await callApp(app, 'POST', `/notebooks/${nb}/artifacts`, {
      cookie,
      body: { type: 'banana' },
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_type');
  });

  test('quiz is a valid type in N3 (creates a pending job)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    await seedSource(userId, nb, 'Doc', ['alpha']);
    installComplete('{"questions":[]}'); // worker kicks; content irrelevant here
    const res = await callApp(app, 'POST', `/notebooks/${nb}/artifacts`, {
      cookie,
      body: { type: 'quiz' },
    });
    expect(res.status).toBe(200);
    expect((await res.json<{ type: string; status: string }>()).type).toBe('quiz');
  });

  test('no ready sources ⇒ 400 no_sources', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    await seedSource(userId, nb, 'Doc', ['alpha'], 'indexing'); // not ready
    const res = await callApp(app, 'POST', `/notebooks/${nb}/artifacts`, {
      cookie,
      body: { type: 'summary' },
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('no_sources');
  });

  test('a second generation while one is live ⇒ 409 generation_in_progress', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const { sourceId } = await seedSource(userId, nb, 'Doc', ['alpha']);
    // A live (generating) artifact already exists.
    await insertArtifact(userId, nb, [sourceId], { status: 'generating' });

    const res = await callApp(app, 'POST', `/notebooks/${nb}/artifacts`, {
      cookie,
      body: { type: 'summary' },
    });
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toBe('generation_in_progress');
  });

  test('two parallel POSTs ⇒ exactly one job row', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    await seedSource(userId, nb, 'Doc', ['alpha']);
    installComplete('# x');

    const [r1, r2] = await Promise.all([
      callApp(app, 'POST', `/notebooks/${nb}/artifacts`, { cookie, body: { type: 'summary' } }),
      callApp(app, 'POST', `/notebooks/${nb}/artifacts`, { cookie, body: { type: 'faq' } }),
    ]);
    const codes = [r1.status, r2.status].sort();
    expect(codes).toEqual([200, 409]);

    const [{ n }] = await db
      .select({ n: count() })
      .from(artifactsTable)
      .where(eq(artifactsTable.notebookId, nb));
    expect(Number(n)).toBe(1);
  });

  test('too_many_artifacts at the cap', async () => {
    const { env } = await import('../src/env.ts');
    const saved = env.ai.MAX_ARTIFACTS_PER_NOTEBOOK;
    try {
      env.ai.MAX_ARTIFACTS_PER_NOTEBOOK = 2;
      const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
      const nb = await freshNotebook(userId);
      const { sourceId } = await seedSource(userId, nb, 'Doc', ['alpha']);
      // Two terminal artifacts already exist (so no generation_in_progress).
      await insertArtifact(userId, nb, [sourceId], { status: 'ready' });
      await insertArtifact(userId, nb, [sourceId], { status: 'error' });

      const res = await callApp(app, 'POST', `/notebooks/${nb}/artifacts`, {
        cookie,
        body: { type: 'summary' },
      });
      expect(res.status).toBe(409);
      expect((await res.json<{ error: string }>()).error).toBe('too_many_artifacts');
    } finally {
      env.ai.MAX_ARTIFACTS_PER_NOTEBOOK = saved;
    }
  });

  test('foreign notebook ⇒ 404, zero attacker rows', async () => {
    const a = await signUpAndCookie(app, uniqueEmail());
    const b = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(a.userId);
    await seedSource(a.userId, nb, 'Doc', ['alpha']);
    const res = await callApp(app, 'POST', `/notebooks/${nb}/artifacts`, {
      cookie: b.cookie,
      body: { type: 'summary' },
    });
    expect(res.status).toBe(404);
    const [{ n }] = await db
      .select({ n: count() })
      .from(artifactsTable)
      .where(eq(artifactsTable.userId, b.userId));
    expect(Number(n)).toBe(0);
  });
});

// ── regenerate, delete, GET — CAS + ownership ─────────────────────────────────

describe('artifact lifecycle — regenerate / delete / get', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => __resetAiClientForTests());

  test('regenerate an error artifact ⇒ back to pending', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const { sourceId } = await seedSource(userId, nb, 'Doc', ['alpha']);
    installComplete('# again');
    const id = await insertArtifact(userId, nb, [sourceId], { status: 'error' });

    const res = await callApp(
      app,
      'POST',
      `/notebooks/${nb}/artifacts/${id}/regenerate`,
      { cookie },
    );
    expect(res.status).toBe(200);
    expect((await res.json<{ status: string }>()).status).toBe('pending');
  });

  test('regenerate a pending artifact ⇒ 409 not_terminal', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const { sourceId } = await seedSource(userId, nb, 'Doc', ['alpha']);
    const id = await insertArtifact(userId, nb, [sourceId], { status: 'pending' });

    const res = await callApp(
      app,
      'POST',
      `/notebooks/${nb}/artifacts/${id}/regenerate`,
      { cookie },
    );
    expect(res.status).toBe(409);
    expect((await res.json<{ error: string }>()).error).toBe('not_terminal');
  });

  test('DELETE during generating ⇒ worker CAS finds 0 rows, no crash, no resurrection', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const { sourceId } = await seedSource(userId, nb, 'Doc', ['alpha']);
    // Drive a generation that we delete mid-flight: a complete() that deletes the
    // row before returning, so the CAS generating→ready sees 0 rows.
    const id = await insertArtifact(userId, nb, [sourceId], { status: 'pending' });
    __setAiClientForTests({
      async complete(): Promise<string> {
        await db.delete(artifactsTable).where(eq(artifactsTable.id, id));
        return '# orphan';
      },
    });
    await generateArtifact(id); // must not throw
    const rows = await db.select().from(artifactsTable).where(eq(artifactsTable.id, id));
    expect(rows.length).toBe(0); // not resurrected
  });

  test('GET full artifact (foreign ⇒ 404)', async () => {
    const a = await signUpAndCookie(app, uniqueEmail());
    const b = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(a.userId);
    const { sourceId } = await seedSource(a.userId, nb, 'Doc', ['alpha']);
    const id = await insertArtifact(a.userId, nb, [sourceId], { status: 'ready' });

    const mine = await callApp(app, 'GET', `/notebooks/${nb}/artifacts/${id}`, {
      cookie: a.cookie,
    });
    expect(mine.status).toBe(200);
    const foreign = await callApp(app, 'GET', `/notebooks/${nb}/artifacts/${id}`, {
      cookie: b.cookie,
    });
    expect(foreign.status).toBe(404);
  });

  test('DELETE removes the row; foreign ⇒ 404', async () => {
    const a = await signUpAndCookie(app, uniqueEmail());
    const b = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(a.userId);
    const { sourceId } = await seedSource(a.userId, nb, 'Doc', ['alpha']);
    const id = await insertArtifact(a.userId, nb, [sourceId], { status: 'ready' });

    const foreign = await callApp(app, 'DELETE', `/notebooks/${nb}/artifacts/${id}`, {
      cookie: b.cookie,
    });
    expect(foreign.status).toBe(404);
    const mine = await callApp(app, 'DELETE', `/notebooks/${nb}/artifacts/${id}`, {
      cookie: a.cookie,
    });
    expect(mine.status).toBe(200);
    const rows = await db.select().from(artifactsTable).where(eq(artifactsTable.id, id));
    expect(rows.length).toBe(0);
  });
});

// ── reconcile-on-startup ──────────────────────────────────────────────────────

// ── streaming generation: partial flush + cancel-on-delete (A/D) ──────────────
//
// When the effective client offers `chatStream` (plain, tool-less), the worker
// PREFERS it over `complete()` and persists the accumulated raw text into
// content_md every ARTIFACT_PROGRESS_FLUSH_MS while generating (live progress).
// A concurrent DELETE makes a partial flush UPDATE 0 rows ⇒ the stream aborts and
// the row stays gone (cancel-on-delete). The pre-existing complete()-only fakes
// (above) hit the FALLBACK path — those tests pin it.

/** A resolvable promise (a gate the test releases to advance the stream). */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('generateArtifact — streaming (chatStream) partial persistence', () => {
  beforeEach(async () => {
    await resetTestDb();
    lastPrompt = '';
  });
  afterEach(() => __resetAiClientForTests());

  test('partial flush: content_md holds the accumulated text mid-stream (status generating)', async () => {
    const { env } = await import('../src/env.ts');
    const savedFlush = env.ai.ARTIFACT_PROGRESS_FLUSH_MS;
    try {
      env.ai.ARTIFACT_PROGRESS_FLUSH_MS = 1;
      const { userId } = await signUpAndCookie(app, uniqueEmail());
      const nb = await freshNotebook(userId);
      const { sourceId } = await seedSource(userId, nb, 'Doc', ['alpha', 'beta']);

      // A gated stream: yield "Hello ", PAUSE (test observes), then "world".
      const gate1 = deferred();
      const gate2 = deferred();
      __setAiClientForTests({
        async *chatStream(): AsyncIterable<string> {
          await Bun.sleep(3); // ensure > FLUSH_MS elapses before the first flush
          yield 'Hello ';
          gate1.resolve();
          await gate2.promise;
          yield 'world.';
        },
      });

      const id = await insertArtifact(userId, nb, [sourceId]);
      // Run the worker WITHOUT awaiting; observe the partial flush at the pause.
      const run = generateArtifact(id);

      await gate1.promise;
      // Give the worker a tick to perform the flush after receiving the first chunk.
      await Bun.sleep(10);
      const mid = await getArtifact(id);
      expect(mid.status).toBe('generating');
      expect(mid.contentMd).toContain('Hello');
      expect(mid.contentMd).not.toContain('world');

      // Release the rest and let it finish.
      gate2.resolve();
      await run;
      const done = await getArtifact(id);
      expect(done.status).toBe('ready');
      expect(done.contentMd).toContain('Hello world.');
      expect(done.model).toBeTruthy();
    } finally {
      env.ai.ARTIFACT_PROGRESS_FLUSH_MS = savedFlush;
    }
  });

  test('final: ready, [src:] intersect applied to the FULL streamed text', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const { sourceId, chunkIds } = await seedSource(userId, nb, 'Doc', ['alpha', 'beta']);
    const validId = chunkIds[0]!;
    const bogusId = '00000000-0000-0000-0000-000000000000';
    // Stream the citations in fragments — the intersect runs on the JOINED text.
    __setAiClientForTests({
      async *chatStream(): AsyncIterable<string> {
        yield `One [src:${validId}]. `;
        yield `Two [src:${bogusId}].`;
      },
    });

    const id = await insertArtifact(userId, nb, [sourceId]);
    await generateArtifact(id);

    const row = await getArtifact(id);
    expect(row.status).toBe('ready');
    expect(row.contentMd).toContain(`[src:${validId}]`);
    expect(row.contentMd).not.toContain(bogusId);
  });

  test('DELETE mid-stream: the generator aborts, the row does not resurrect', async () => {
    const { env } = await import('../src/env.ts');
    const savedFlush = env.ai.ARTIFACT_PROGRESS_FLUSH_MS;
    try {
      env.ai.ARTIFACT_PROGRESS_FLUSH_MS = 1;
      const { userId } = await signUpAndCookie(app, uniqueEmail());
      const nb = await freshNotebook(userId);
      const { sourceId } = await seedSource(userId, nb, 'Doc', ['alpha']);

      const id = await insertArtifact(userId, nb, [sourceId]);
      let yieldedAfterDelete = false;
      __setAiClientForTests({
        async *chatStream(): AsyncIterable<string> {
          await Bun.sleep(3);
          yield 'first chunk ';
          // The worker now flushes; it finds 0 rows (deleted below) and aborts.
          await db.delete(artifactsTable).where(eq(artifactsTable.id, id));
          await Bun.sleep(3);
          yield 'second chunk ';
          yieldedAfterDelete = true; // reached only if the abort failed
          yield 'third chunk';
        },
      });

      await generateArtifact(id); // must not throw, must not resurrect the row

      const rows = await db.select().from(artifactsTable).where(eq(artifactsTable.id, id));
      expect(rows.length).toBe(0); // not resurrected
      // The abort happened on the flush AFTER the delete — the generator should not
      // have run to completion (best-effort: the loop stopped requesting chunks).
      expect(yieldedAfterDelete).toBe(false);
    } finally {
      env.ai.ARTIFACT_PROGRESS_FLUSH_MS = savedFlush;
    }
  });

  test('fallback: a fake with complete but NO chatStream uses the single-shot path', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const { sourceId } = await seedSource(userId, nb, 'Doc', ['alpha']);
    // complete-only fake (no chatStream) ⇒ runGeneration falls back to complete().
    installComplete('# Single shot');
    const id = await insertArtifact(userId, nb, [sourceId]);
    await generateArtifact(id);
    const row = await getArtifact(id);
    expect(row.status).toBe('ready');
    expect(row.contentMd).toContain('# Single shot');
  });

  test('quiz via stream: final content_json valid, content_md NULL', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const { sourceId } = await seedSource(userId, nb, 'Doc', ['alpha', 'beta', 'gamma']);
    const quizJson = JSON.stringify({
      questions: [
        { kind: 'tf', prompt: 'Alpha is first?', answer: true },
        { kind: 'tf', prompt: 'Beta is second?', answer: true },
        { kind: 'tf', prompt: 'Gamma is third?', answer: true },
      ],
    });
    // Stream the JSON in two fragments so parseQuiz runs on the joined text.
    const half = Math.floor(quizJson.length / 2);
    __setAiClientForTests({
      async *chatStream(): AsyncIterable<string> {
        yield quizJson.slice(0, half);
        yield quizJson.slice(half);
      },
    });

    const id = await insertArtifact(userId, nb, [sourceId], { type: 'quiz' });
    await generateArtifact(id);

    const row = await getArtifact(id);
    expect(row.status).toBe('ready');
    expect(row.contentMd).toBeNull();
    const quiz = row.contentJson as { questions: { kind: string }[] } | null;
    expect(quiz?.questions.length).toBe(3);
    expect(quiz?.questions[0]!.kind).toBe('tf');
  });
});

describe('reconcileArtifactsOnStartup', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => __resetAiClientForTests());

  test('pending|generating ⇒ error interrupted; terminal rows untouched', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const { sourceId } = await seedSource(userId, nb, 'Doc', ['alpha']);
    const pendingId = await insertArtifact(userId, nb, [sourceId], { status: 'pending' });
    const generatingId = await insertArtifact(userId, nb, [sourceId], { status: 'generating' });
    const readyId = await insertArtifact(userId, nb, [sourceId], { status: 'ready' });

    await reconcileArtifactsOnStartup();

    expect((await getArtifact(pendingId)).status).toBe('error');
    expect((await getArtifact(pendingId)).errorCode).toBe('interrupted');
    expect((await getArtifact(generatingId)).status).toBe('error');
    expect((await getArtifact(generatingId)).errorCode).toBe('interrupted');
    expect((await getArtifact(readyId)).status).toBe('ready'); // untouched
  });
});
