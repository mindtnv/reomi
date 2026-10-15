// kb_chunk.text denormalization parity (NotebookLM M1, T6 ARCH-MED6 / AC1.5).
//
// `source_chunks` is the SoT for document text; the matching `kb_chunk` document
// row carries a DENORMALIZED COPY of that text (a read-cache for retrieval). The
// invariant: after ingest, for every document chunk of a source,
// `kb_chunk.text == source_chunks.text` at the same (source_id, position).
//
// Driven via `ingestSource` + a fake embedder (no S3 needed for `text` sources).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  db,
  kbChunk,
  notebooks,
  sourceChunks,
  sources as sourcesTable,
} from '@reomi/db';
import { buildApp } from '../src/app.ts';
import {
  __resetAiClientForTests,
  __setAiClientForTests,
} from '../src/ai/openai-client.ts';
import { ingestSource, stashInlineText } from '../src/ai/source-ingest.ts';
import { resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();
const DIM = 1536;

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

async function freshNotebook(userId: string): Promise<string> {
  const [nb] = await db.insert(notebooks).values({ userId, title: 'NB' }).returning({ id: notebooks.id });
  return nb!.id;
}

async function seedTextSource(userId: string, _notebookId: string, text: string): Promise<string> {
  // Sources are user-level now (library refactor) — no notebook_id on the row.
  const [src] = await db
    .insert(sourcesTable)
    .values({ userId, kind: 'text', title: 'Inline', status: 'pending', verified: true })
    .returning({ id: sourcesTable.id });
  stashInlineText(src!.id, text);
  return src!.id;
}

describe('source text parity — kb_chunk.text == source_chunks.text', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('every document kb_chunk text matches its source_chunk at the same position', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const nbId = await freshNotebook(userId);
    // Multi-chunk text so the parity check spans several rows.
    const text = Array.from({ length: 5 }, (_, i) => `Section ${i}. ${'word '.repeat(900)}`.trim()).join('\n\n');
    const srcId = await seedTextSource(userId, nbId, text);

    installFakeEmbedder();
    await ingestSource(srcId);

    // Pull both sides ordered by position.
    const soT = await db
      .select({ position: sourceChunks.position, text: sourceChunks.text })
      .from(sourceChunks)
      .where(eq(sourceChunks.sourceId, srcId))
      .orderBy(sourceChunks.position);
    const kb = await db
      .select({ position: kbChunk.position, text: kbChunk.text })
      .from(kbChunk)
      .where(eq(kbChunk.sourceId, srcId))
      .orderBy(kbChunk.position);

    expect(soT.length).toBeGreaterThan(1);
    // One kb_chunk doc row per source_chunk (1:1).
    expect(kb.length).toBe(soT.length);

    const kbByPos = new Map(kb.map((r) => [r.position, r.text]));
    for (const sc of soT) {
      expect(kbByPos.has(sc.position)).toBe(true);
      // The denormalized read-cache text is byte-identical to the SoT text.
      expect(kbByPos.get(sc.position)).toBe(sc.text);
    }
  });

  test('parity holds after a re-embed (resume) — text is re-copied from SoT, not re-parsed divergently', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const nbId = await freshNotebook(userId);
    const text = Array.from({ length: 3 }, (_, i) => `Block ${i}. ${'word '.repeat(900)}`.trim()).join('\n\n');
    const srcId = await seedTextSource(userId, nbId, text);

    installFakeEmbedder();
    await ingestSource(srcId);
    __resetAiClientForTests();

    // Simulate a torn embed: status indexing + one chunk embedded=false → resume
    // re-embeds it. The kb_chunk.text must STILL equal the SoT text after.
    await db.update(sourcesTable).set({ status: 'indexing' }).where(eq(sourcesTable.id, srcId));
    const [one] = await db
      .select({ id: sourceChunks.id })
      .from(sourceChunks)
      .where(eq(sourceChunks.sourceId, srcId))
      .limit(1);
    await db.update(sourceChunks).set({ embedded: false }).where(eq(sourceChunks.id, one!.id));

    installFakeEmbedder();
    await ingestSource(srcId);

    const soT = await db
      .select({ position: sourceChunks.position, text: sourceChunks.text })
      .from(sourceChunks)
      .where(eq(sourceChunks.sourceId, srcId))
      .orderBy(sourceChunks.position);
    const kb = await db
      .select({ position: kbChunk.position, text: kbChunk.text })
      .from(kbChunk)
      .where(eq(kbChunk.sourceId, srcId))
      .orderBy(kbChunk.position);

    const kbByPos = new Map(kb.map((r) => [r.position, r.text]));
    for (const sc of soT) {
      expect(kbByPos.get(sc.position)).toBe(sc.text);
    }
  });
});
