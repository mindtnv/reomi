import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import {
  db, cards, decks, notes, noteTypes, notebooks, notebookNotes, notebookArtifacts,
  notebookSources, sources, sourceChunks, conversations, type Db,
} from '@reomi/db';
import {
  ASSISTANT_CONTEXT_LIMITS, AssistantContextError, assistantRefKey, parseAssistantContext,
  type AssistantObjectRef, type AssistantObjectSnapshot,
} from '@reomi/shared';

type Reader = Pick<Db, 'select'>;
type Descriptor = { label: string; href: string; state?: string; pdfPages?: number; parent?: AssistantObjectSnapshot['parent']; versionData: unknown };
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const label = (value: string) => value.replace(/\s+/g, ' ').trim().slice(0, ASSISTANT_CONTEXT_LIMITS.labelChars);
const normalizeQuote = (value: string) => value.normalize('NFC').replace(/\s+/g, ' ').trim();

async function descriptor(ex: Reader, userId: string, ref: AssistantObjectRef): Promise<Descriptor | undefined> {
  switch (ref.kind) {
    case 'card': {
      const [r] = await ex.select({ title: cards.renderFrontText, content: cards.renderText, deckId: decks.id, deck: decks.name })
        .from(cards).innerJoin(decks, and(eq(cards.deckId, decks.id), eq(decks.userId, userId)))
        .where(and(eq(cards.userId, userId), eq(cards.id, ref.id))).limit(1);
      return r && { label: r.title || r.content, href: `/cards?focus=${ref.id}`, parent: { kind: 'deck', id: r.deckId, label: label(r.deck) }, versionData: r };
    }
    case 'deck': {
      const [r] = await ex.select({ title: decks.name, parentId: decks.parentId, color: decks.color, icon: decks.icon, position: decks.position }).from(decks)
        .where(and(eq(decks.userId, userId), eq(decks.id, ref.id))).limit(1);
      return r && { label: r.title, href: `/decks?focus=${ref.id}`, versionData: r };
    }
    case 'source':
    case 'source_passage': {
      const [r] = await ex.select({ title: sources.title, updatedAt: sources.updatedAt, status: sources.status, kind: sources.kind, pageCount: sources.pageCount }).from(sources)
        .where(and(eq(sources.userId, userId), eq(sources.id, ref.id))).limit(1);
      return r && { label: r.title, href: `/library/${ref.id}`, state: r.status,
        ...(r.kind === 'pdf' && r.pageCount != null ? { pdfPages: r.pageCount } : {}), versionData: r };
    }
    case 'notebook': {
      const [r] = await ex.select({ title: notebooks.title, updatedAt: notebooks.updatedAt }).from(notebooks)
        .where(and(eq(notebooks.userId, userId), eq(notebooks.id, ref.id))).limit(1);
      if (!r) return undefined;
      if (ref.sourceIds?.length) {
        const found = await ex.select({ id: sources.id }).from(notebookSources)
          .innerJoin(sources, and(eq(sources.id, notebookSources.sourceId), eq(sources.userId, userId)))
          .where(and(eq(notebookSources.userId, userId), eq(notebookSources.notebookId, ref.id), inArray(sources.id, ref.sourceIds)));
        if (found.length !== ref.sourceIds.length) return undefined;
      }
      return { label: r.title, href: `/notebooks/${ref.id}`, versionData: r };
    }
    case 'written_note': {
      const [r] = await ex.select({ title: notebookNotes.title, notebookId: notebookNotes.notebookId, updatedAt: notebookNotes.updatedAt }).from(notebookNotes)
        .where(and(eq(notebookNotes.userId, userId), eq(notebookNotes.id, ref.id))).limit(1);
      return r && { label: r.title, href: r.notebookId ? `/notebooks/${r.notebookId}?note=${ref.id}` : `/library/study?note=${ref.id}`, versionData: r };
    }
    case 'flashcard_note': {
      const [r] = await ex.select({ fields: notes.fieldValues, firstField: noteTypes.fields, typeId: notes.noteTypeId, updatedAt: notes.updatedAt }).from(notes)
        .innerJoin(noteTypes, and(eq(noteTypes.id, notes.noteTypeId), or(eq(noteTypes.userId, userId), and(isNull(noteTypes.userId), eq(noteTypes.isBuiltin, true)))))
        .where(and(eq(notes.userId, userId), eq(notes.id, ref.id))).limit(1);
      return r && { label: r.fields[r.firstField[0]?.name ?? ''] || 'Note', href: `/editor?noteId=${ref.id}`, versionData: r };
    }
    case 'note_type': {
      const [r] = await ex.select({ title: noteTypes.name, updatedAt: noteTypes.updatedAt }).from(noteTypes)
        .where(and(or(eq(noteTypes.userId, userId), and(isNull(noteTypes.userId), eq(noteTypes.isBuiltin, true))), eq(noteTypes.id, ref.id))).limit(1);
      return r && { label: r.title, href: `/note-types?edit=${ref.id}`, versionData: r };
    }
    case 'artifact': {
      const [r] = await ex.select({ title: notebookArtifacts.title, notebookId: notebookArtifacts.notebookId, updatedAt: notebookArtifacts.updatedAt, status: notebookArtifacts.status }).from(notebookArtifacts)
        .where(and(eq(notebookArtifacts.userId, userId), eq(notebookArtifacts.id, ref.id))).limit(1);
      return r && { label: r.title, href: r.notebookId ? `/notebooks/${r.notebookId}?artifact=${ref.id}` : `/library/study?artifact=${ref.id}`, state: r.status, versionData: r };
    }
    case 'conversation': {
      const [r] = await ex.select({ title: conversations.title, updatedAt: conversations.updatedAt }).from(conversations)
        .where(and(eq(conversations.userId, userId), eq(conversations.id, ref.id))).limit(1);
      return r && { label: r.title || 'Conversation', href: `/chat?thread=${ref.id}`, versionData: r };
    }
  }
}

/** Resolve only bounded metadata/selections, never expand a document or transcript. */
export async function resolveAssistantRefs(
  userId: string,
  input: AssistantObjectRef[],
  options: { ex?: Reader; allowUnavailable?: boolean; previous?: AssistantObjectSnapshot[] } = {},
): Promise<AssistantObjectSnapshot[]> {
  const refs = parseAssistantContext({ version: 1, refs: input }).refs;
  const ex = options.ex ?? db;
  const previous = new Map((options.previous ?? []).map(s => [assistantRefKey(s.ref), s]));
  const output: AssistantObjectSnapshot[] = [];
  for (const ref of refs) {
    let row = await descriptor(ex, userId, ref);
    let excerpt: string | undefined;
    let verifiedQuote: boolean | undefined;
    if (row && ref.kind === 'source_passage') {
      const locator = ref.locator;
      const chunkIds = locator.chunkId ? [locator.chunkId] : locator.chunks?.map(c => c.chunkId);
      const filters = [eq(sourceChunks.userId, userId), eq(sourceChunks.sourceId, ref.id)];
      if (chunkIds) filters.push(inArray(sourceChunks.id, chunkIds));
      if (locator.page !== undefined) filters.push(eq(sourceChunks.page, locator.page));
      if (locator.position !== undefined) filters.push(eq(sourceChunks.position, locator.position));
      if (locator.section) filters.push(eq(sourceChunks.heading, locator.section));
      // A quote without a locator is user-supplied input, not a full-book scan.
      const located = Boolean(chunkIds || locator.page !== undefined || locator.position !== undefined || locator.section);
      const chunks = located ? await ex.select({ id: sourceChunks.id, text: sourceChunks.text, hash: sourceChunks.sourceHash, position: sourceChunks.position })
        .from(sourceChunks).where(and(...filters)).orderBy(sourceChunks.position).limit(ASSISTANT_CONTEXT_LIMITS.passageChunks) : [];
      // A PDF text-layer selection can exist before server extraction, or on a
      // page with no parsed chunks. Preserve its page and user quote, but never
      // mark that quote as verified evidence. Explicit chunk locators still fail
      // closed; a valid page cannot disguise a forged or reingested chunk ID.
      const pdfPageOnly = !chunkIds && locator.position === undefined && !locator.section
        && locator.page !== undefined && row.pdfPages !== undefined && locator.page <= row.pdfPages && Boolean(locator.quote);
      if (locator.page !== undefined && row.pdfPages !== undefined && locator.page > row.pdfPages) row = undefined;
      if (located && ((!chunks.length && !pdfPageOnly) || (chunkIds && chunks.length !== chunkIds.length))) row = undefined;
      if (row) {
        const ordered = chunkIds ? chunkIds.map(id => chunks.find(c => c.id === id)!) : chunks;
        if (ordered.some((c, n) => n > 0 && c.position <= ordered[n - 1]!.position)) throw new AssistantContextError('invalid_context');
        const selectedText = ordered.map(c => {
          const range = locator.chunks?.find(s => s.chunkId === c.id) ?? (locator.chunkId ? locator : undefined);
          if (range?.start !== undefined) {
            if (range.end! > c.text.length) throw new AssistantContextError('invalid_context');
            return c.text.slice(range.start, range.end);
          }
          return c.text;
        }).join('\n');
        excerpt = locator.quote;
        verifiedQuote = Boolean(excerpt && selectedText && normalizeQuote(selectedText).includes(normalizeQuote(excerpt)));
        row.versionData = { source: row.versionData, chunks: ordered.map(c => ({ id: c.id, textHash: fingerprint(c.text), sourceHash: c.hash })) };
        const query = new URLSearchParams();
        if (locator.chunkId) query.set('chunk', locator.chunkId);
        else if (ordered[0]) query.set('chunk', ordered[0].id);
        if (locator.page !== undefined) query.set('page', String(locator.page));
        if (locator.position !== undefined) query.set('pos', String(locator.position));
        if (query.size) row.href += `?${query}`;
      }
    }
    if (!row) {
      if (!options.allowUnavailable) throw new AssistantContextError('context_unavailable');
      // previous is a trusted stored snapshot, not a client-provided label.
      const old = previous.get(assistantRefKey(ref));
      output.push({ ref, label: old?.label ?? 'Unavailable', available: false, ...(old?.excerpt ? { excerpt: old.excerpt } : {}) });
      continue;
    }
    output.push({ ref, label: label(row.label) || ref.kind, available: true, href: row.href,
      version: fingerprint(row.versionData), ...(row.parent ? { parent: row.parent } : {}),
      ...(row.state ? { state: row.state } : {}), ...(excerpt !== undefined ? { excerpt, verifiedQuote } : {}),
    });
  }
  return output;
}
