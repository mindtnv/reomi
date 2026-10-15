// Source byte-dedup at finalize (NotebookLM M1, T6 CRITIC-M3 / AC1.7 —
// library refactor Р5: dedup is now per-USER, not per-notebook).
//
// A finalize computes `byteHash = sha256(bytes)`; a non-terminal source of the
// SAME USER (status NOT IN ('error','deleting') — so even a still-indexing dupe
// is caught) with the same hash short-circuits as 409 `duplicate_source` carrying
// `existingSourceId` (the just-uploaded object + pending row are cleaned up, no
// second embed run). Different bytes embed normally. Sources are user-level now
// (notebooks attach via the join edge), so the SAME book in a DIFFERENT notebook
// is the SAME library item → also a duplicate (the "one ingest per material" win).
//
// The finalize path reads S3 (`headSize` + `getObjectBytes`) — there is NO
// storage seam (see report), so the END-TO-END 409 is exercised against REAL
// MinIO (the same `roundTrip` reachability gate as media.test.ts; skips when S3
// is down). To make the first source reach `status='ready'` without a valid PDF
// fixture, the PDF extractor seam is injected (bytes come from S3, the fake
// extractor returns units). A storage-independent DB-layer dedup-query test runs
// unconditionally as a backstop.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { and, count, eq, sql } from 'drizzle-orm';
import { db, sources as sourcesTable } from '@reomi/db';
import { buildApp } from '../src/app.ts';
import {
  __resetAiClientForTests,
  __setAiClientForTests,
} from '../src/ai/openai-client.ts';
import { __setPdfExtractorForTests } from '../src/ai/source-parsers.ts';
import { drainSourceIngest } from '../src/ai/source-ingest.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';
import { s3RoundTrip } from './s3-test-gate.ts';

const app = buildApp();
const DIM = 1536;

const PDF_BYTES_A = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 1, 2, 3, 4, 5]); // "%PDF-" + junk
const PDF_BYTES_B = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 9, 8, 7, 6, 5]);

function installFakeEmbedder(): void {
  __setAiClientForTests({
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((_, i) => {
        const v = new Array<number>(DIM).fill(0);
        v[i % DIM] = 1;
        return v;
      });
    },
  });
}

async function uploadToS3(
  upload: { url: string; fields: Record<string, string> },
  bytes: Uint8Array,
): Promise<number> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(upload.fields)) fd.append(k, v);
  fd.set('Content-Type', 'application/pdf');
  fd.append('file', new Blob([bytes], { type: 'application/pdf' }));
  const res = await fetch(upload.url, { method: 'POST', body: fd });
  return res.status;
}

interface PresignBody {
  sourceId: string;
  upload: { url: string; fields: Record<string, string> };
}

async function createNotebook(cookie: string, title = 'NB'): Promise<string> {
  const res = await callApp(app, 'POST', '/notebooks', { cookie, body: { title } });
  return (await res.json<{ id: string }>()).id;
}

/** presign → upload bytes → finalize (worker drains to ready). Returns finalize status. */
async function uploadAndFinalize(
  cookie: string,
  notebookId: string,
  bytes: Uint8Array,
): Promise<{ status: number; body: unknown; sourceId: string }> {
  const presign = await (
    await callApp(app, 'POST', `/notebooks/${notebookId}/sources`, {
      cookie,
      body: { kind: 'upload', title: 'Book', mime: 'application/pdf', size: bytes.length },
    })
  ).json<PresignBody>();
  const up = await uploadToS3(presign.upload, bytes);
  expect(up).toBe(204);
  const finalize = await callApp(app, 'POST', `/sources/${presign.sourceId}/finalize`, { cookie });
  return { status: finalize.status, body: await finalize.json(), sourceId: presign.sourceId };
}

describe('source dedup — finalize byte_hash (real MinIO round-trip)', () => {
  beforeEach(async () => {
    await resetTestDb();
    // The fake extractor lets a non-PDF byte blob reach ready (bytes come from S3).
    __setPdfExtractorForTests(async () => ['Page one.', 'Page two.']);
    installFakeEmbedder();
  });
  afterEach(() => {
    __setPdfExtractorForTests(null);
    __resetAiClientForTests();
  });

  s3RoundTrip('same bytes, same notebook → second finalize 409 duplicate_source (no second embed)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const nbId = await createNotebook(cookie);

    // First source: finalize → enqueue → drain to ready.
    const first = await uploadAndFinalize(cookie, nbId, PDF_BYTES_A);
    expect(first.status).toBe(200);
    await drainSourceIngest({ timeoutMs: 5000 });
    const [firstRow] = await db
      .select({ status: sourcesTable.status, byteHash: sourcesTable.byteHash })
      .from(sourcesTable)
      .where(eq(sourcesTable.id, first.sourceId));
    expect(firstRow!.status).toBe('ready');
    expect(firstRow!.byteHash).toBeTruthy();

    // Second source: SAME bytes, SAME notebook → finalize detects the ready dup,
    // returning the existing source id (so the UI can offer "attach existing").
    const second = await uploadAndFinalize(cookie, nbId, PDF_BYTES_A);
    expect(second.status).toBe(409);
    expect((second.body as { error: string; existingSourceId?: string }).error).toBe(
      'duplicate_source',
    );
    expect((second.body as { existingSourceId?: string }).existingSourceId).toBe(first.sourceId);

    // The duplicate's pending row was cleaned up (deleted by finalize).
    const [dupRow] = await db
      .select({ n: count() })
      .from(sourcesTable)
      .where(eq(sourcesTable.id, second.sourceId));
    expect(dupRow!.n).toBe(0);
    // Still exactly ONE ready source for this hash (per-user dedup).
    const [ready] = await db
      .select({ n: count() })
      .from(sourcesTable)
      .where(and(eq(sourcesTable.byteHash, firstRow!.byteHash!), eq(sourcesTable.status, 'ready')));
    expect(ready!.n).toBe(1);
  });

  s3RoundTrip('different bytes, same notebook → second finalize succeeds (no dedup)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const nbId = await createNotebook(cookie);

    const first = await uploadAndFinalize(cookie, nbId, PDF_BYTES_A);
    expect(first.status).toBe(200);
    await drainSourceIngest({ timeoutMs: 5000 });

    const second = await uploadAndFinalize(cookie, nbId, PDF_BYTES_B);
    expect(second.status).toBe(200); // distinct hash → not a dup
    await drainSourceIngest({ timeoutMs: 5000 });

    // Two distinct-hash ready sources for this user (per-user scope).
    const [readyN] = await db
      .select({ n: count() })
      .from(sourcesTable)
      .where(eq(sourcesTable.status, 'ready'));
    expect(readyN!.n).toBe(2);
  });

  s3RoundTrip('same bytes, DIFFERENT notebook → second finalize 409 (dedup is per-USER now, Р5)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const nb1 = await createNotebook(cookie, 'NB1');
    const nb2 = await createNotebook(cookie, 'NB2');

    const first = await uploadAndFinalize(cookie, nb1, PDF_BYTES_A);
    expect(first.status).toBe(200);
    await drainSourceIngest({ timeoutMs: 5000 });

    // SAME bytes in a DIFFERENT notebook → STILL a duplicate (sources are
    // user-level; one ingest per material). The UI is expected to attach the
    // existing source to nb2 via /notebooks/:id/sources/attach instead.
    const second = await uploadAndFinalize(cookie, nb2, PDF_BYTES_A);
    expect(second.status).toBe(409);
    expect((second.body as { error: string; existingSourceId?: string }).error).toBe(
      'duplicate_source',
    );
    expect((second.body as { existingSourceId?: string }).existingSourceId).toBe(first.sourceId);
  });
});

describe('source dedup — DB-layer query invariant (storage-independent backstop)', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('the dedup predicate matches per-USER on byteHash, status NOT IN (error,deleting) — even indexing', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const HASH = 'deadbeef'.repeat(8);

    // A READY source of user A with HASH.
    await db.insert(sourcesTable).values({
      userId: a.userId,
      kind: 'pdf',
      title: 'ready dup',
      status: 'ready',
      verified: true,
      byteHash: HASH,
    });
    // Same hash, same user, but ERROR status → must NOT count (excluded).
    await db.insert(sourcesTable).values({
      userId: a.userId,
      kind: 'pdf',
      title: 'errored same hash',
      status: 'error',
      verified: true,
      byteHash: HASH,
    });
    // Same hash, DIFFERENT user → must NOT count for user A's scope.
    await db.insert(sourcesTable).values({
      userId: b.userId,
      kind: 'pdf',
      title: 'other user same hash',
      status: 'ready',
      verified: true,
      byteHash: HASH,
    });

    // The finalize dedup query (Р5): per-user + byteHash + status NOT IN
    // ('error','deleting') — NO notebook conjunct.
    const dupForA = await db
      .select({ id: sourcesTable.id })
      .from(sourcesTable)
      .where(
        and(
          eq(sourcesTable.userId, a.userId),
          eq(sourcesTable.byteHash, HASH),
          sql`${sourcesTable.status} NOT IN ('error', 'deleting')`,
        ),
      );
    expect(dupForA.length).toBe(1); // exactly the ready row, not the errored one

    // User B sees only their own ready row (user-scoping is the cross-tenant boundary).
    const dupForB = await db
      .select({ id: sourcesTable.id })
      .from(sourcesTable)
      .where(
        and(
          eq(sourcesTable.userId, b.userId),
          eq(sourcesTable.byteHash, HASH),
          sql`${sourcesTable.status} NOT IN ('error', 'deleting')`,
        ),
      );
    expect(dupForB.length).toBe(1);
  });

  test('a still-INDEXING source with the same hash IS caught (dedup before ready, Р5)', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const HASH = 'feedface'.repeat(8);
    // The first source is STILL indexing (not yet ready) — a dupe uploaded now
    // must still be caught so "one complete embedding per material" holds.
    const [first] = await db
      .insert(sourcesTable)
      .values({
        userId,
        kind: 'pdf',
        title: 'still indexing',
        status: 'indexing',
        verified: true,
        byteHash: HASH,
      })
      .returning({ id: sourcesTable.id });

    const dup = await db
      .select({ id: sourcesTable.id })
      .from(sourcesTable)
      .where(
        and(
          eq(sourcesTable.userId, userId),
          eq(sourcesTable.byteHash, HASH),
          sql`${sourcesTable.status} NOT IN ('error', 'deleting')`,
        ),
      )
      .limit(1);
    expect(dup.length).toBe(1);
    expect(dup[0]!.id).toBe(first!.id); // the existing (indexing) source is returned
  });
});
