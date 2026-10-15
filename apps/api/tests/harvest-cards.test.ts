// «Урожай выделений → карточки» (feature #2): harvest a source's UNHARVESTED
// markup (text highlights/notes + ink marked_text) into card candidates via the
// cheap complete() surface, then apply a selection → real cards + provenance +
// `harvested_at` stamps.
//
// CONTRACT (read from notebooks.ts harvest routes, NOT invented):
//   POST /sources/:id/harvest-cards
//     * 503 ai_disabled pre-flush when chat is off; user-scoped 404; cooldown
//       AFTER ownership (429 on the 2nd call within the window).
//     * gathers source_marks (highlight/note, harvested_at IS NULL, quote
//       non-empty) + source_annotations (marked_text non-empty, harvested_at
//       IS NULL); already-harvested rows are excluded.
//     * runs complete() → candidates `{ origin, page, front, back, quote }`;
//       origin maps back to the mark id / ink page; unknown originRefs dropped.
//     * nothing to harvest ⇒ { candidates: [] }; a generation failure ⇒ 502.
//   POST /sources/:id/harvest-cards/apply
//     * { deckId, cards:[{front,back,page?,origin}] } cap 20; empty → 400 empty;
//       over cap → 400 too_many; foreign deck/source → 4xx/404.
//     * ONE tx: N Basic cards + page-matched (or NULL-fallback) card_sources
//       provenance + harvested_at=now() on the INCLUDED origins; a bad entry
//       rolls back everything. Returns { created, cardIds }.
//
// Harness mirrors quick-card.test.ts + marked-passages.test.ts (direct-DB
// fixtures, ensureBuiltins, __setAiClientForTests with a `complete` fake + a
// no-op chat surface so isChatEnabled() flips on).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  cardSources as cardSourcesTable,
  cards as cardsTable,
  db,
  ensureBuiltins,
  notebooks as notebooksTable,
  notebookSources as notebookSourcesTable,
  sourceAnnotations as sourceAnnotationsTable,
  sourceChunks as sourceChunksTable,
  sourceMarks as sourceMarksTable,
  sources as sourcesTable,
} from '@reomi/db';
import type { MarkRect, PageAnnotations, SourceMarkKind } from '@reomi/shared';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import {
  __resetAiClientForTests,
  __setAiClientForTests,
  type AgentChatMessage,
  type AgentStreamChunk,
  type ChatMessage,
} from '../src/ai/openai-client.ts';
import { cooldownReset } from '../src/ai-cooldown.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

// ── fixtures ──────────────────────────────────────────────────────────────────

async function freshNotebook(userId: string, title = 'NB'): Promise<string> {
  const [nb] = await db
    .insert(notebooksTable)
    .values({ userId, title })
    .returning({ id: notebooksTable.id });
  return nb!.id;
}

async function freshDeck(cookie: string, name = 'Deck'): Promise<string> {
  const res = await callApp(app, 'POST', '/decks', { cookie, body: { name } });
  expect(res.status).toBe(200);
  return (await res.json<{ id: string }>()).id;
}

async function seedSourceWithChunks(
  userId: string,
  notebookId: string,
  title: string,
  chunks: { text: string; page?: number }[],
): Promise<{ sourceId: string; chunkIds: string[] }> {
  const [src] = await db
    .insert(sourcesTable)
    .values({ userId, kind: 'pdf', title, status: 'ready', verified: true, chunkCount: chunks.length })
    .returning({ id: sourcesTable.id });
  const sourceId = src!.id;
  await db.insert(notebookSourcesTable).values({ userId, notebookId, sourceId });
  const chunkIds: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]!;
    const [sc] = await db
      .insert(sourceChunksTable)
      .values({ userId, sourceId, position: i, text: c.text, page: c.page, embedded: true })
      .returning({ id: sourceChunksTable.id });
    chunkIds.push(sc!.id);
  }
  return { sourceId, chunkIds };
}

/** Insert one source_marks row directly (the selection popover's POST did this). */
async function seedMark(
  userId: string,
  sourceId: string,
  page: number,
  kind: SourceMarkKind,
  quote: string,
  opts: { note?: string | null; harvestedAt?: Date } = {},
): Promise<string> {
  const rects: MarkRect[] = [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04 }];
  const [row] = await db
    .insert(sourceMarksTable)
    .values({
      userId,
      sourceId,
      page,
      kind,
      quote,
      rects,
      color: 'lime',
      note: opts.note ?? null,
      harvestedAt: opts.harvestedAt ?? null,
    })
    .returning({ id: sourceMarksTable.id });
  return row!.id;
}

/** Insert one source_annotations (ink) row directly. */
async function seedAnnotation(
  userId: string,
  sourceId: string,
  page: number,
  markedText: string | null,
  opts: { harvestedAt?: Date } = {},
): Promise<void> {
  const strokes: PageAnnotations = {
    v: 1,
    strokes: [{ tool: 'highlighter', color: '#ffcc00', width: 0.004, points: [0.1, 0.2, 0.5] }],
  };
  await db.insert(sourceAnnotationsTable).values({
    userId,
    sourceId,
    page,
    strokes,
    markedText,
    harvestedAt: opts.harvestedAt ?? null,
  });
}

// A no-op agent stream — present only so isChatEnabled() flips on for the
// harvest-cards pre-flush gate (the routes never stream).
async function* noopAgentStream(messages: AgentChatMessage[]): AsyncIterable<AgentStreamChunk> {
  void messages;
  yield { type: 'finish', reason: 'stop' };
}

function harvest(cookie: string, sourceId: string, body: Record<string, unknown> = {}) {
  return callApp(app, 'POST', `/sources/${sourceId}/harvest-cards`, { cookie, body });
}
function applyHarvest(cookie: string, sourceId: string, body: Record<string, unknown>) {
  return callApp(app, 'POST', `/sources/${sourceId}/harvest-cards/apply`, { cookie, body });
}

async function edgesFor(userId: string) {
  return db
    .select()
    .from(cardSourcesTable)
    .where(eq(cardSourcesTable.userId, userId))
    .orderBy(asc(cardSourcesTable.createdAt));
}

interface HarvestCandidateVM {
  origin: { kind: 'mark'; markId: string } | { kind: 'ink'; page: number };
  page: number | null;
  front: string;
  back: string;
  quote: string;
}

// ── generation ──────────────────────────────────────────────────────────────

describe('POST /sources/:id/harvest-cards — generation', () => {
  beforeEach(async () => {
    await resetTestDb();
    await ensureBuiltins(db);
    cooldownReset();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('two fixtures (a mark + an ink page) → two candidates with correct origin mapping', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'Bio');
    const { sourceId } = await seedSourceWithChunks(userId, notebookId, 'Cell Biology', [
      { text: 'mitochondria are the powerhouse', page: 3 },
      { text: 'photosynthesis on page five', page: 5 },
    ]);
    const markId = await seedMark(userId, sourceId, 3, 'highlight', 'mitochondria are the powerhouse of the cell');
    await seedAnnotation(userId, sourceId, 5, 'photosynthesis converts light to energy');

    // The fake echoes back the refs the route fed in (parsed from <passage ref=…>).
    let captured: ChatMessage[] = [];
    __setAiClientForTests({
      chatStreamAgentic: noopAgentStream,
      complete: async (msgs) => {
        captured = msgs as ChatMessage[];
        const userMsg = (msgs as ChatMessage[]).find((m) => m.role === 'user')?.content ?? '';
        // Extract the two refs the route assigned ("m<id>", "i<page>").
        const refs = [...userMsg.matchAll(/ref="([^"]+)"/g)].map((m) => m[1]!);
        return JSON.stringify(
          refs.map((ref, i) => ({
            front: `Q${i}`,
            back: `A${i}`,
            originRef: ref,
          })),
        );
      },
    });

    const res = await harvest(cookie, sourceId);
    expect(res.status).toBe(200);
    const { candidates } = await res.json<{ candidates: HarvestCandidateVM[] }>();
    expect(candidates.length).toBe(2);

    // The prompt carried both passages with their text.
    const userContent = captured.find((m) => m.role === 'user')?.content ?? '';
    expect(userContent).toContain('mitochondria are the powerhouse of the cell');
    expect(userContent).toContain('photosynthesis converts light to energy');

    // Origin mapping: the mark candidate points at the mark id; the ink candidate
    // points at the page.
    const byOrigin = (k: string) => candidates.find((c) => c.origin.kind === k)!;
    const markCand = byOrigin('mark');
    expect(markCand.origin).toEqual({ kind: 'mark', markId });
    expect(markCand.page).toBe(3);
    expect(markCand.quote).toBe('mitochondria are the powerhouse of the cell');

    const inkCand = byOrigin('ink');
    expect(inkCand.origin).toEqual({ kind: 'ink', page: 5 });
    expect(inkCand.page).toBe(5);
    expect(inkCand.quote).toBe('photosynthesis converts light to energy');
  });

  test('already-harvested markings are excluded from the prompt + candidates', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const { sourceId } = await seedSourceWithChunks(userId, notebookId, 'Doc', [{ text: 'c', page: 1 }]);
    const fresh = await seedMark(userId, sourceId, 1, 'highlight', 'a fresh highlight');
    // A second highlight that was already harvested → must NOT appear.
    await seedMark(userId, sourceId, 2, 'highlight', 'an old harvested highlight', {
      harvestedAt: new Date(),
    });
    // An ink page already harvested → also excluded.
    await seedAnnotation(userId, sourceId, 3, 'old harvested ink', { harvestedAt: new Date() });

    let userContent = '';
    __setAiClientForTests({
      chatStreamAgentic: noopAgentStream,
      complete: async (msgs) => {
        userContent = (msgs as ChatMessage[]).find((m) => m.role === 'user')?.content ?? '';
        const refs = [...userContent.matchAll(/ref="([^"]+)"/g)].map((m) => m[1]!);
        return JSON.stringify(refs.map((ref) => ({ front: 'Q', back: 'A', originRef: ref })));
      },
    });

    const res = await harvest(cookie, sourceId);
    expect(res.status).toBe(200);
    const { candidates } = await res.json<{ candidates: HarvestCandidateVM[] }>();
    // Only the one fresh highlight is offered.
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.origin).toEqual({ kind: 'mark', markId: fresh });
    expect(userContent).toContain('a fresh highlight');
    expect(userContent).not.toContain('an old harvested highlight');
    expect(userContent).not.toContain('old harvested ink');
  });

  test('nothing to harvest → { candidates: [] } (no AI call)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const { sourceId } = await seedSourceWithChunks(userId, notebookId, 'Doc', [{ text: 'c', page: 1 }]);

    let called = false;
    __setAiClientForTests({
      chatStreamAgentic: noopAgentStream,
      complete: async () => {
        called = true;
        return '[]';
      },
    });

    const res = await harvest(cookie, sourceId);
    expect(res.status).toBe(200);
    expect((await res.json<{ candidates: unknown[] }>()).candidates).toEqual([]);
    expect(called).toBe(false); // short-circuited before the paid call
  });

  test('unknown originRef in the model reply is dropped (route only trusts fed refs)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const { sourceId } = await seedSourceWithChunks(userId, notebookId, 'Doc', [{ text: 'c', page: 1 }]);
    const markId = await seedMark(userId, sourceId, 1, 'highlight', 'the only real passage');

    __setAiClientForTests({
      chatStreamAgentic: noopAgentStream,
      complete: async (msgs) => {
        const userMsg = (msgs as ChatMessage[]).find((m) => m.role === 'user')?.content ?? '';
        const realRef = [...userMsg.matchAll(/ref="([^"]+)"/g)].map((m) => m[1]!)[0]!;
        return JSON.stringify([
          { front: 'real', back: 'A', originRef: realRef },
          { front: 'phantom', back: 'B', originRef: 'm-does-not-exist' },
        ]);
      },
    });

    const res = await harvest(cookie, sourceId);
    const { candidates } = await res.json<{ candidates: HarvestCandidateVM[] }>();
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.front).toBe('real');
    expect(candidates[0]!.origin).toEqual({ kind: 'mark', markId });
  });

  test('chat disabled → 503 ai_disabled (no fake injected)', async () => {
    __setAiClientForTests({ embed: async (t) => t.map(() => []) });
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const { sourceId } = await seedSourceWithChunks(userId, notebookId, 'Doc', [{ text: 'c', page: 1 }]);
    await seedMark(userId, sourceId, 1, 'highlight', 'something');

    const res = await harvest(cookie, sourceId);
    expect(res.status).toBe(503);
    expect((await res.json<{ error: string }>()).error).toBe('ai_disabled');
  });

  test('a foreign source → 404 (chat enabled)', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const notebookId = await freshNotebook(b.userId, 'NB');
    const { sourceId } = await seedSourceWithChunks(b.userId, notebookId, 'Doc', [{ text: 'c', page: 1 }]);

    __setAiClientForTests({
      chatStreamAgentic: noopAgentStream,
      complete: async () => '[]',
    });

    const res = await harvest(a.cookie, sourceId);
    expect(res.status).toBe(404);
    expect((await res.json<{ error: string }>()).error).toBe('not_found');
  });

  test('a generation failure → 502 harvest_failed (never a 500)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const { sourceId } = await seedSourceWithChunks(userId, notebookId, 'Doc', [{ text: 'c', page: 1 }]);
    await seedMark(userId, sourceId, 1, 'highlight', 'something');

    __setAiClientForTests({
      chatStreamAgentic: noopAgentStream,
      complete: async () => 'I cannot, sorry — no JSON here.',
    });

    const res = await harvest(cookie, sourceId);
    expect(res.status).toBe(502);
    expect((await res.json<{ error: string }>()).error).toBe('harvest_failed');
  });

  test('cooldown: the 2nd call within the window → 429 (NODE_ENV flipped off test)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const { sourceId } = await seedSourceWithChunks(userId, notebookId, 'Doc', [{ text: 'c', page: 1 }]);
    await seedMark(userId, sourceId, 1, 'highlight', 'something');

    __setAiClientForTests({
      chatStreamAgentic: noopAgentStream,
      complete: async (msgs) => {
        const userMsg = (msgs as ChatMessage[]).find((m) => m.role === 'user')?.content ?? '';
        const ref = [...userMsg.matchAll(/ref="([^"]+)"/g)].map((m) => m[1]!)[0]!;
        return JSON.stringify([{ front: 'Q', back: 'A', originRef: ref }]);
      },
    });

    // cooldownCheck short-circuits under NODE_ENV=test; flip it off so the window
    // actually arms (the ai-cooldown.test.ts pattern). Same test DB pool.
    cooldownReset();
    const savedEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const first = await harvest(cookie, sourceId);
      expect(first.status).toBe(200);
      const second = await harvest(cookie, sourceId);
      expect(second.status).toBe(429);
      const body = await second.json<{ error: string; retryAfterMs: number }>();
      expect(body.error).toBe('cooldown');
      expect(body.retryAfterMs).toBeGreaterThan(0);
    } finally {
      process.env.NODE_ENV = savedEnv;
      cooldownReset();
    }
  });
});

// ── apply ─────────────────────────────────────────────────────────────────────

describe('POST /sources/:id/harvest-cards/apply', () => {
  beforeEach(async () => {
    await resetTestDb();
    await ensureBuiltins(db);
    cooldownReset();
  });
  afterEach(() => {
    __resetAiClientForTests();
  });

  test('creates N cards + page-matched provenance + stamps harvested_at on included origins', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'Bio');
    const deckId = await freshDeck(cookie);
    // Page 3 has TWO chunks (page-matched provenance); page 5 has one.
    const { sourceId, chunkIds } = await seedSourceWithChunks(userId, notebookId, 'Cell Biology', [
      { text: 'mitochondria are the powerhouse', page: 3 },
      { text: 'ATP synthase spans the membrane', page: 3 },
      { text: 'photosynthesis on page five', page: 5 },
    ]);
    const markId = await seedMark(userId, sourceId, 3, 'highlight', 'mitochondria are the powerhouse');
    await seedAnnotation(userId, sourceId, 5, 'photosynthesis converts light');

    const res = await applyHarvest(cookie, sourceId, {
      deckId,
      cards: [
        { front: 'Powerhouse?', back: 'Mitochondria', page: 3, origin: { kind: 'mark', markId } },
        { front: 'Photosynthesis?', back: 'Light→energy', page: 5, origin: { kind: 'ink', page: 5 } },
      ],
    });
    expect(res.status).toBe(200);
    const { created, cardIds } = await res.json<{ created: number; cardIds: string[] }>();
    expect(created).toBe(2);
    expect(cardIds.length).toBe(2);

    // Two cards exist.
    const cards = await db.select().from(cardsTable).where(eq(cardsTable.userId, userId));
    expect(cards.length).toBe(2);

    // Provenance: page-3 card → BOTH page-3 chunks; page-5 card → the page-5 chunk.
    const edges = await edgesFor(userId);
    // 2 (page 3) + 1 (page 5) = 3 edges.
    expect(edges.length).toBe(3);
    const page3Chunks = [chunkIds[0]!, chunkIds[1]!].sort();
    const linkedToPage3 = edges
      .filter((e) => page3Chunks.includes(e.sourceChunkId ?? ''))
      .map((e) => e.sourceChunkId!)
      .sort();
    expect(linkedToPage3).toEqual(page3Chunks);
    expect(edges.some((e) => e.sourceChunkId === chunkIds[2])).toBe(true);
    for (const e of edges) {
      expect(e.sourceId).toBe(sourceId);
      expect(e.notebookId).toBeNull(); // reading-born
    }

    // harvested_at stamped on BOTH origins.
    const [mark] = await db.select().from(sourceMarksTable).where(eq(sourceMarksTable.id, markId));
    expect(mark!.harvestedAt).not.toBeNull();
    const [ink] = await db
      .select()
      .from(sourceAnnotationsTable)
      .where(and(eq(sourceAnnotationsTable.sourceId, sourceId), eq(sourceAnnotationsTable.page, 5)));
    expect(ink!.harvestedAt).not.toBeNull();
  });

  test('a candidate with no page → ONE fallback edge (NULL chunk)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const deckId = await freshDeck(cookie);
    const { sourceId } = await seedSourceWithChunks(userId, notebookId, 'Doc', [{ text: 'c', page: 1 }]);
    const markId = await seedMark(userId, sourceId, 1, 'note', 'a note with no page on the card');

    const res = await applyHarvest(cookie, sourceId, {
      deckId,
      // No `page` on the card → fallback NULL-chunk edge.
      cards: [{ front: 'Q', back: 'A', origin: { kind: 'mark', markId } }],
    });
    expect(res.status).toBe(200);
    const edges = await edgesFor(userId);
    expect(edges.length).toBe(1);
    expect(edges[0]!.sourceChunkId).toBeNull();
    expect(edges[0]!.sourceId).toBe(sourceId);
    // Origin still stamped.
    const [mark] = await db.select().from(sourceMarksTable).where(eq(sourceMarksTable.id, markId));
    expect(mark!.harvestedAt).not.toBeNull();
  });

  test('excluded origins are NOT stamped (only the applied cards mark their sources)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const deckId = await freshDeck(cookie);
    const { sourceId } = await seedSourceWithChunks(userId, notebookId, 'Doc', [{ text: 'c', page: 1 }]);
    const kept = await seedMark(userId, sourceId, 1, 'highlight', 'the kept passage');
    const excluded = await seedMark(userId, sourceId, 2, 'highlight', 'the user excluded this');

    // The wizard sends ONLY the kept card.
    const res = await applyHarvest(cookie, sourceId, {
      deckId,
      cards: [{ front: 'Q', back: 'A', page: 1, origin: { kind: 'mark', markId: kept } }],
    });
    expect(res.status).toBe(200);

    const [keptRow] = await db.select().from(sourceMarksTable).where(eq(sourceMarksTable.id, kept));
    expect(keptRow!.harvestedAt).not.toBeNull();
    const [exclRow] = await db.select().from(sourceMarksTable).where(eq(sourceMarksTable.id, excluded));
    expect(exclRow!.harvestedAt).toBeNull(); // untouched → re-offered on the next harvest
  });

  test('a re-harvest after apply does NOT re-return the harvested passage', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const deckId = await freshDeck(cookie);
    const { sourceId } = await seedSourceWithChunks(userId, notebookId, 'Doc', [{ text: 'c', page: 1 }]);
    const harvestedMark = await seedMark(userId, sourceId, 1, 'highlight', 'passage one');
    await seedMark(userId, sourceId, 2, 'highlight', 'passage two still fresh');

    // Apply card from passage one.
    const applied = await applyHarvest(cookie, sourceId, {
      deckId,
      cards: [{ front: 'Q', back: 'A', page: 1, origin: { kind: 'mark', markId: harvestedMark } }],
    });
    expect(applied.status).toBe(200);

    // Re-harvest → only passage two is offered.
    let userContent = '';
    __setAiClientForTests({
      chatStreamAgentic: noopAgentStream,
      complete: async (msgs) => {
        userContent = (msgs as ChatMessage[]).find((m) => m.role === 'user')?.content ?? '';
        const refs = [...userContent.matchAll(/ref="([^"]+)"/g)].map((m) => m[1]!);
        return JSON.stringify(refs.map((ref) => ({ front: 'Q', back: 'A', originRef: ref })));
      },
    });
    const re = await harvest(cookie, sourceId);
    const { candidates } = await re.json<{ candidates: HarvestCandidateVM[] }>();
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.origin).toEqual({ kind: 'mark', markId: (await secondMarkId(userId, sourceId)) });
    expect(userContent).toContain('passage two still fresh');
    expect(userContent).not.toContain('passage one');
  });

  test('a bad entry rolls back the whole batch (no cards, no stamps)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const deckId = await freshDeck(cookie);
    const { sourceId } = await seedSourceWithChunks(userId, notebookId, 'Doc', [{ text: 'c', page: 1 }]);
    const m1 = await seedMark(userId, sourceId, 1, 'highlight', 'good passage');

    // The second card has an empty front (route schema minLength:1) → 400, whole
    // batch rejected. (Elysia validates the body before the handler runs.)
    const res = await applyHarvest(cookie, sourceId, {
      deckId,
      cards: [
        { front: 'Q', back: 'A', page: 1, origin: { kind: 'mark', markId: m1 } },
        { front: '', back: 'B', page: 1, origin: { kind: 'mark', markId: m1 } },
      ],
    });
    expect(res.status).toBe(400);
    // Nothing committed.
    expect((await db.select().from(cardsTable).where(eq(cardsTable.userId, userId))).length).toBe(0);
    const [mark] = await db.select().from(sourceMarksTable).where(eq(sourceMarksTable.id, m1));
    expect(mark!.harvestedAt).toBeNull();
  });

  test('replaying the SAME apply body is idempotent — no duplicate cards (M1)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const deckId = await freshDeck(cookie);
    const { sourceId } = await seedSourceWithChunks(userId, notebookId, 'Doc', [{ text: 'c', page: 1 }]);
    const markId = await seedMark(userId, sourceId, 1, 'highlight', 'a passage');
    await seedAnnotation(userId, sourceId, 2, 'ink on page two');
    const cards = [
      { front: 'Q1', back: 'A1', page: 1, origin: { kind: 'mark', markId } },
      { front: 'Q2', back: 'A2', page: 2, origin: { kind: 'ink', page: 2 } },
    ];

    const first = await applyHarvest(cookie, sourceId, { deckId, cards });
    expect(first.status).toBe(200);
    expect((await first.json<{ created: number }>()).created).toBe(2);

    // The origins are now stamped — a replay claims nothing, creates nothing.
    const second = await applyHarvest(cookie, sourceId, { deckId, cards });
    expect(second.status).toBe(200);
    expect((await second.json<{ created: number }>()).created).toBe(0);

    // Still only the original two cards (no duplicates from the replay).
    expect((await db.select().from(cardsTable).where(eq(cardsTable.userId, userId))).length).toBe(2);
  });

  test('empty cards array → 400 empty', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const deckId = await freshDeck(cookie);
    const { sourceId } = await seedSourceWithChunks(userId, notebookId, 'Doc', [{ text: 'c', page: 1 }]);

    const res = await applyHarvest(cookie, sourceId, { deckId, cards: [] });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('empty');
  });

  test('over the cap → 400 too_many', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const notebookId = await freshNotebook(userId, 'NB');
    const deckId = await freshDeck(cookie);
    const { sourceId } = await seedSourceWithChunks(userId, notebookId, 'Doc', [{ text: 'c', page: 1 }]);
    const m1 = await seedMark(userId, sourceId, 1, 'highlight', 'p');

    // 21 cards (cap is 20). The body schema allows maxItems = cap+1 so the handler
    // returns the friendly too_many rather than a generic validation 400.
    const cards = Array.from({ length: 21 }, () => ({
      front: 'Q',
      back: 'A',
      page: 1,
      origin: { kind: 'mark', markId: m1 },
    }));
    const res = await applyHarvest(cookie, sourceId, { deckId, cards });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('too_many');
  });

  test('a foreign deck → a clean 4xx, nothing created/stamped', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const notebookId = await freshNotebook(a.userId, 'NB');
    const { sourceId } = await seedSourceWithChunks(a.userId, notebookId, 'Doc', [{ text: 'c', page: 1 }]);
    const m1 = await seedMark(a.userId, sourceId, 1, 'highlight', 'p');
    const foreignDeck = await freshDeck(b.cookie, 'B deck');

    const res = await applyHarvest(a.cookie, sourceId, {
      deckId: foreignDeck,
      cards: [{ front: 'Q', back: 'A', page: 1, origin: { kind: 'mark', markId: m1 } }],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect((await db.select().from(cardsTable).where(eq(cardsTable.userId, a.userId))).length).toBe(0);
    const [mark] = await db.select().from(sourceMarksTable).where(eq(sourceMarksTable.id, m1));
    expect(mark!.harvestedAt).toBeNull();
  });

  test('a foreign source → 404', async () => {
    const a = await signUpAndCookie(app, uniqueEmail('a'));
    const b = await signUpAndCookie(app, uniqueEmail('b'));
    const deckId = await freshDeck(a.cookie);
    const notebookId = await freshNotebook(b.userId, 'NB');
    const { sourceId } = await seedSourceWithChunks(b.userId, notebookId, 'Doc', [{ text: 'c', page: 1 }]);
    const m1 = await seedMark(b.userId, sourceId, 1, 'highlight', 'p');

    const res = await applyHarvest(a.cookie, sourceId, {
      deckId,
      cards: [{ front: 'Q', back: 'A', page: 1, origin: { kind: 'mark', markId: m1 } }],
    });
    expect(res.status).toBe(404);
  });
});

/** Helper: the id of the still-fresh (unharvested) mark of a source. */
async function secondMarkId(userId: string, sourceId: string): Promise<string> {
  const [row] = await db
    .select({ id: sourceMarksTable.id })
    .from(sourceMarksTable)
    .where(
      and(
        eq(sourceMarksTable.userId, userId),
        eq(sourceMarksTable.sourceId, sourceId),
        isNull(sourceMarksTable.harvestedAt),
      ),
    )
    .limit(1);
  return row!.id;
}
