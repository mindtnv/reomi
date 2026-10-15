import { beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { db, sources, sourceChunks, sourceTextMarks } from '@reomi/db';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app';
import { buildToolRegistry, type ToolContext } from '../src/ai/tools';
import { rootLogger } from '../src/logger';
import { resetTestDb, signUpAndCookie, uniqueEmail } from './helpers';
const app = buildApp();
beforeEach(resetTestDb);
async function fixture(title = 'Text source') {
  const { userId } = await signUpAndCookie(app, uniqueEmail());
  const [source] = await db.insert(sources).values({ userId, kind: 'text', title, status: 'ready' }).returning();
  const [chunk] = await db.insert(sourceChunks).values({ userId, sourceId: source!.id, position: 3, text: 'A **Pod** groups containers.' }).returning();
  const hash = createHash('sha256').update(chunk!.text).digest('hex');
  await db.insert(sourceTextMarks).values({ userId, sourceId: source!.id, kind: 'note', note: 'My study note', selection: {
    version: 1, quote: 'Pod groups containers.', chunks: [{ chunkId: chunk!.id, textHash: hash, renderedHash: hash, start: 2, end: 24 }],
  } });
  const ctx: ToolContext = { userId, log: rootLogger, grounding: { chunkIds: [] }, assistantContext: {
    version: 1, revision: 0, policy: 'strict', sourceIds: [source!.id], deckIds: [], refs: [],
  } };
  return { userId, source: source!, chunk: chunk!, ctx };
}
const read = (ctx: ToolContext, args: unknown = {}) => buildToolRegistry().find(tool => tool.name === 'list_marked_passages')!.execute(ctx, args);
test('text-reader marks are visible without a notebook, but are not invented source evidence', async () => {
  const f = await fixture();
  const result = await read(f.ctx);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.text).toContain('Pod groups containers.');
  expect(result.text).toContain('My study note');
  expect(result.text).toContain('read_source');
  expect(result.text).toContain('position=3');
  expect(result.text).toContain('user-supplied');
  expect(result.citations).toEqual([]);
  expect(f.ctx.grounding!.chunkIds).toEqual([]);
  await db.delete(sourceChunks).where(eq(sourceChunks.id, f.chunk.id));
  const stale = await read(f.ctx);
  expect(stale.ok).toBe(true);
  if (stale.ok) { expect(stale.text).toContain('unavailable'); expect(stale.text).not.toContain('position=3'); }
});
test('text markup respects ownership and empty strict scope, and offers bounded continuation', async () => {
  const a = await fixture(), b = await fixture('Private source');
  const foreign = await read(a.ctx, { sourceId: b.source.id });
  expect(foreign.ok).toBe(false);
  expect(JSON.stringify(foreign)).not.toContain('Private source');
  const empty = await read({ ...a.ctx, assistantContext: { ...a.ctx.assistantContext!, sourceIds: [] } });
  expect(JSON.stringify(empty)).not.toContain('Pod groups containers.');
  await db.insert(sourceTextMarks).values(Array.from({ length: 5 }, (_, i) => ({
    userId: a.userId, sourceId: a.source.id, kind: 'highlight' as const,
    selection: { version: 1 as const, quote: `Unanchored quote ${i}`, chunks: [] },
  })));
  const first = await read(a.ctx);
  expect(first.ok).toBe(true);
  if (first.ok) { expect(first.text).toContain('textOffset=4'); expect(first.text.length).toBeLessThan(4000); }
  const next = await read(a.ctx, { textOffset: 4 });
  expect(next.ok).toBe(true);
  if (next.ok) { expect(next.text).not.toContain('Pod groups containers.'); expect(next.text).toContain('Unanchored quote 4'); }
});

test('escaped long markup remains bounded and every record is reachable through continuation', async () => {
  const f = await fixture();
  await db.insert(sourceTextMarks).values(Array.from({ length: 6 }, () => ({
    userId: f.userId, sourceId: f.source.id, kind: 'note' as const, note: '\\"'.repeat(500),
    selection: { version: 1 as const, quote: '\\"'.repeat(1900), chunks: [] },
  })));
  const seen = new Set<string>();
  let offset = 0;
  for (let page = 0; page < 8; page++) {
    const result = await read(f.ctx, { textOffset: offset });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text.length).toBeLessThan(4000);
    for (const line of result.text.split('\n').filter(line => line.startsWith('{'))) {
      const row = JSON.parse(line);
      expect(seen.has(row.markId)).toBe(false); seen.add(row.markId);
    }
    const next = result.text.match(/textOffset=(\d+)/);
    if (!next) break;
    expect(Number(next[1])).toBeGreaterThan(offset); offset = Number(next[1]);
  }
  expect(seen.size).toBe(7);
  expect((await read(f.ctx, { textOffset: -1 })).ok).toBe(false);
});
