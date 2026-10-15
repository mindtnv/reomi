import { beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db, user, sources, sourceChunks, decks, cards, notes, noteTypes, notebooks, notebookNotes, notebookArtifacts, conversations } from '@reomi/db';
import { BASIC_NOTE_TYPE, newUuidV7, type AssistantObjectRef } from '@reomi/shared';
import { resolveAssistantRefs } from '../src/ai/assistant-context';
import { resetTestDb } from './helpers';

let alice: string;
let bob: string;
async function fixture(owner: string) {
  const [source] = await db.insert(sources).values({ userId: owner, kind: 'text', title: `Book ${owner}`, status: 'ready' }).returning();
  const [chunk] = await db.insert(sourceChunks).values({ userId: owner, sourceId: source!.id, position: 0, text: 'A Deployment manages Pods.', sourceHash: 'v1' }).returning();
  const [deck] = await db.insert(decks).values({ userId: owner, name: 'Kubernetes' }).returning();
  const [type] = await db.insert(noteTypes).values({ ...BASIC_NOTE_TYPE, id: newUuidV7(), isBuiltin: false, userId: owner }).returning();
  const [note] = await db.insert(notes).values({ userId: owner, noteTypeId: type!.id, fieldValues: { Front: 'What manages Pods?', Back: 'Deployment' } }).returning();
  const [card] = await db.insert(cards).values({ userId: owner, deckId: deck!.id, noteId: note!.id, renderFrontText: 'What manages Pods?', renderText: 'What manages Pods? Deployment' }).returning();
  const [notebook] = await db.insert(notebooks).values({ userId: owner, title: 'Study' }).returning();
  const [written] = await db.insert(notebookNotes).values({ userId: owner, notebookId: notebook!.id, title: 'My conclusions', content: 'Private note body' }).returning();
  const [artifact] = await db.insert(notebookArtifacts).values({ userId: owner, notebookId: notebook!.id, title: 'Quiz', type: 'quiz', status: 'ready', sourceIds: [source!.id] }).returning();
  const [conversation] = await db.insert(conversations).values({ userId: owner, title: 'About Pods' }).returning();
  const refs: AssistantObjectRef[] = [
    { kind: 'source', id: source!.id },
    { kind: 'source_passage', id: source!.id, locator: { chunkId: chunk!.id, quote: 'Deployment manages Pods' } },
    { kind: 'deck', id: deck!.id }, { kind: 'card', id: card!.id },
    { kind: 'notebook', id: notebook!.id }, { kind: 'written_note', id: written!.id },
    { kind: 'flashcard_note', id: note!.id }, { kind: 'note_type', id: type!.id },
    { kind: 'artifact', id: artifact!.id }, { kind: 'conversation', id: conversation!.id },
  ];
  return { source: source!, chunk: chunk!, card: card!, refs };
}

describe('assistant object resolution', () => {
  beforeEach(async () => {
    await resetTestDb();
    alice = newUuidV7(); bob = newUuidV7();
    await db.insert(user).values([
      { id: alice, name: 'Alice', email: `${alice}@test.dev` },
      { id: bob, name: 'Bob', email: `${bob}@test.dev` },
    ]);
  });

  test('resolves all supported objects with trusted labels and canonical links', async () => {
    const f = await fixture(alice);
    const resolved = await resolveAssistantRefs(alice, f.refs);
    expect(resolved).toHaveLength(f.refs.length);
    expect(resolved.every(r => r.available && r.label && r.href?.startsWith('/'))).toBe(true);
    expect(resolved[1]!.verifiedQuote).toBe(true);
    expect(resolved[1]!.excerpt).toBe('Deployment manages Pods');
    expect(JSON.stringify(resolved)).not.toContain('Private note body');
  });

  test('foreign and missing objects reject atomically without leaking their labels', async () => {
    const own = await fixture(alice);
    const foreign = await fixture(bob);
    for (const ref of foreign.refs) {
      await expect(resolveAssistantRefs(alice, [own.refs[0]!, ref])).rejects.toThrow('context_unavailable');
    }
    await expect(resolveAssistantRefs(alice, [{ kind: 'source', id: newUuidV7() }])).rejects.toThrow('context_unavailable');
  });

  test('validates passage parent and treats unmatched quotes as user excerpts', async () => {
    const a = await fixture(alice);
    const b = await fixture(alice);
    await expect(resolveAssistantRefs(alice, [{ kind: 'source_passage', id: a.source.id, locator: { chunkId: b.chunk.id } }])).rejects.toThrow('context_unavailable');
    const [quote] = await resolveAssistantRefs(alice, [{ kind: 'source_passage', id: a.source.id, locator: { quote: 'My own explanation' } }]);
    expect(quote!.verifiedQuote).toBe(false);
    expect(quote!.excerpt).toBe('My own explanation');
  });

  test('PDF page quotes retain valid locations without claiming unparsed text is verified', async () => {
    const [source] = await db.insert(sources).values({ userId: alice, kind: 'pdf', title: 'PDF book', pageCount: 8, status: 'ready' }).returning();
    const ref = { kind: 'source_passage' as const, id: source!.id, locator: { page: 4, quote: 'A selection from the PDF text layer' } };
    const [snapshot] = await resolveAssistantRefs(alice, [ref]);
    expect(snapshot!.available).toBe(true);
    expect(snapshot!.href).toBe(`/library/${source!.id}?page=4`);
    expect(snapshot!.excerpt).toBe(ref.locator.quote);
    expect(snapshot!.verifiedQuote).toBe(false);
    await expect(resolveAssistantRefs(alice, [{ ...ref, locator: { ...ref.locator, page: 9 } }])).rejects.toThrow('context_unavailable');
    await expect(resolveAssistantRefs(bob, [ref])).rejects.toThrow('context_unavailable');
    await expect(resolveAssistantRefs(alice, [{ ...ref, locator: { ...ref.locator, chunkId: newUuidV7() } }])).rejects.toThrow('context_unavailable');
    await db.insert(sourceChunks).values({ userId: alice, sourceId: source!.id, position: 0, page: 4, text: ref.locator.quote });
    const [verified] = await resolveAssistantRefs(alice, [ref]);
    expect(verified!.verifiedQuote).toBe(true);
    expect(verified!.href).toContain('page=4');
  });

  test('preserves historical labels for deleted targets without reusing live content', async () => {
    const f = await fixture(alice);
    const snapshot = await resolveAssistantRefs(alice, [f.refs[0]!]);
    await db.delete(sources).where(eq(sources.id, f.source.id));
    const [missing] = await resolveAssistantRefs(alice, [f.refs[0]!], { previous: snapshot, allowUnavailable: true });
    expect(missing!.available).toBe(false);
    expect(missing!.label).toBe(snapshot[0]!.label);
    expect(missing!.href).toBeUndefined();
  });

  test('only shared builtin types are globally readable', async () => {
    const [builtin] = await db.insert(noteTypes).values({ ...BASIC_NOTE_TYPE, userId: null, isBuiltin: true }).returning();
    const [orphan] = await db.insert(noteTypes).values({ ...BASIC_NOTE_TYPE, id: newUuidV7(), name: 'Unpublished', userId: null, isBuiltin: false }).returning();
    expect((await resolveAssistantRefs(alice, [{ kind: 'note_type', id: builtin!.id }]))[0]!.available).toBe(true);
    await expect(resolveAssistantRefs(alice, [{ kind: 'note_type', id: orphan!.id }])).rejects.toThrow('context_unavailable');
  });

  test('readable parsed source resolution works without embeddings and fingerprints edits', async () => {
    const f = await fixture(alice);
    await db.update(sources).set({ status: 'error', errorCode: 'index_failed' }).where(eq(sources.id, f.source.id));
    const [before] = await resolveAssistantRefs(alice, [f.refs[1]!]);
    expect(before!.available).toBe(true);
    await db.update(sourceChunks).set({ text: 'Rewritten source text', sourceHash: 'v2' }).where(eq(sourceChunks.id, f.chunk.id));
    const [after] = await resolveAssistantRefs(alice, [f.refs[1]!]);
    expect(after!.version).not.toBe(before!.version);
    expect(after!.verifiedQuote).toBe(false);
  });
});
