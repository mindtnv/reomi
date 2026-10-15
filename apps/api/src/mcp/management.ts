import { DECK_COLORS } from '@reomi/shared';
import { z } from 'zod';
import { and, count, eq, inArray, sql } from 'drizzle-orm';
import { db, cards, decks, notes, notebooks, notebookNotes, notebookSources, notebookArtifacts, conversations, reviews, sources, sourceReadingState } from '@reomi/db';
import { NOTEBOOK_COLORS, NOTEBOOK_TITLE_MAX, NOTEBOOK_EMOJI_MAX, NOTEBOOK_DESCRIPTION_MAX, NOTE_TITLE_MAX, NOTE_CONTENT_MAX, MAX_NOTES_PER_NOTEBOOK } from '@reomi/shared';
import type { ToolContext } from '../ai/tools.ts';
import { descendantIds } from '../modules/cards.ts';
import { attachSourceToNotebook } from '../modules/sources-shared.ts';
import { createStudyNote } from '../modules/study-notes';
import { env } from '../env.ts';
import { McpToolError, type KnowledgeTool } from './types.ts';

const id = z.uuid();
const deckColors = z.enum(DECK_COLORS);
const colors = z.enum(NOTEBOOK_COLORS);
const title = z.string().trim().min(1).max(NOTEBOOK_TITLE_MAX);
const ex = (ctx: ToolContext) => ctx.tx ?? db;
function required<T>(row: T | undefined): T { if (!row) throw new McpToolError('not_found'); return row; }
function nonempty<T extends Record<string, unknown>>(value: T) {
  if (!Object.values(value).some(v => v !== undefined)) throw new McpToolError('nothing_to_update');
  return value;
}
function writer<S extends z.ZodType>(name: string, description: string, schema: S,
  prepare: (ctx: ToolContext, args: z.output<S>) => Promise<Record<string, unknown>>,
  execute: (ctx: ToolContext, args: z.output<S>) => Promise<unknown>, destructive = false): KnowledgeTool {
  return { name, description, schema, readOnly: false, destructive,
    prepare: (ctx, args) => prepare(ctx, schema.parse(args)),
    execute: (ctx, args) => execute(ctx, schema.parse(args)),
  };
}
async function ownedNotebook(ctx: ToolContext, notebookId: string) {
  const query = ex(ctx).select().from(notebooks).where(and(eq(notebooks.userId, ctx.userId), eq(notebooks.id, notebookId)));
  return required((await (ctx.tx ? query.for('update') : query))[0]);
}
async function ownedSource(ctx: ToolContext, sourceId: string) {
  const query = ex(ctx).select().from(sources).where(and(eq(sources.userId, ctx.userId), eq(sources.id, sourceId)));
  const row = required((await (ctx.tx ? query.for('update') : query))[0]);
  if (row.status === 'deleting') throw new McpToolError('source_deleting');
  // Metadata previews must never echo upstream URL/storage details.
  return { id: row.id, title: row.title, author: row.author, description: row.description, tags: row.tags, language: row.language };
}
async function ownedNote(ctx: ToolContext, noteId: string) {
  const condition=and(eq(notebookNotes.userId,ctx.userId),eq(notebookNotes.id,noteId));
  const initial=required((await ex(ctx).select().from(notebookNotes).where(condition).limit(1))[0]);
  if (!ctx.tx) return initial;
  // Match REST's owner-before-note lock order when updating notebook recency.
  if (initial.notebookId) await ownedNotebook(ctx,initial.notebookId);
  return required((await ex(ctx).select().from(notebookNotes).where(condition).for('update').limit(1))[0]);
}

async function bump(ctx: ToolContext, notebookId: string | null) {
  if (notebookId === null) return;
  await ex(ctx).update(notebooks).set({ updatedAt: sql`GREATEST(now(), ${notebooks.updatedAt} + interval '1 millisecond')` })
    .where(and(eq(notebooks.userId, ctx.userId), eq(notebooks.id, notebookId)));
}
async function deckState(ctx: ToolContext, deckId?: string, parentId?: string | null) {
  if (ctx.tx) await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ctx.userId}, 73))`);
  const query = ex(ctx).select().from(decks).where(eq(decks.userId, ctx.userId)).orderBy(decks.id);
  const rows = await (ctx.tx ? query.for('update') : query);
  const row = deckId ? required(rows.find(r => r.id === deckId)) : undefined;
  if (parentId) {
    required(rows.find(r => r.id === parentId));
    if (deckId && (parentId === deckId || descendantIds(deckId, rows).includes(parentId))) throw new McpToolError('deck_cycle');
  }
  return { rows, row };
}

export function managementTools(): KnowledgeTool[] {
  const createDeck = z.strictObject({ name: z.string().trim().min(1).max(100), color: deckColors.default('lime'), icon: z.string().max(100).optional(), parentId: id.optional() });
  const editDeck = z.strictObject({ id, name: z.string().trim().min(1).max(100).optional(), color: deckColors.optional(), icon: z.string().max(100).optional(), parentId: id.nullable().optional() });
  const editNotebook = z.strictObject({ id, title: title.optional(), emoji: z.string().max(NOTEBOOK_EMOJI_MAX).nullable().optional(), color: colors.nullable().optional(), description: z.string().max(NOTEBOOK_DESCRIPTION_MAX).nullable().optional(), pinned: z.boolean().optional(), archived: z.boolean().optional() });
  const editNote = z.strictObject({ id, title: z.string().trim().min(1).max(NOTE_TITLE_MAX).optional(), content: z.string().max(NOTE_CONTENT_MAX).optional(), pinned: z.boolean().optional() });
  const attachment = z.strictObject({ notebookId: id, sourceId: id });
  const editSource = z.strictObject({ id, title: z.string().trim().min(1).max(300).optional(), author: z.string().max(500).nullable().optional(), description: z.string().max(2000).nullable().optional(), tags: z.array(z.string().trim().min(1).max(64)).max(32).optional(), language: z.string().trim().max(16).nullable().optional() });
  return [
    writer('create_deck', 'Propose creating a deck, optionally under a parent deck.', createDeck,
      async (ctx, a) => { await deckState(ctx, undefined, a.parentId); return { create: a }; },
      async (ctx, a) => (await ex(ctx).insert(decks).values({ userId: ctx.userId, ...a }).returning())[0]),
    writer('update_deck', 'Propose renaming, recoloring or moving a deck. Rejects hierarchy cycles.', editDeck,
      async (ctx, { id, ...patch }) => ({ before: (await deckState(ctx, id, patch.parentId)).row!, changes: nonempty(patch) }),
      async (ctx, { id, ...patch }) => (await ex(ctx).update(decks).set(patch).where(and(eq(decks.userId, ctx.userId), eq(decks.id, id))).returning())[0]),
    writer('delete_deck', 'Propose deleting a deck AND its descendant decks, cards and review history.', z.strictObject({ id }),
      async (ctx, a) => {
        const { rows, row } = await deckState(ctx, a.id); const ids = [a.id, ...descendantIds(a.id, rows)];
        const affectedCards = await ex(ctx).select({ id: cards.id, updatedAt: cards.updatedAt }).from(cards).where(and(eq(cards.userId, ctx.userId), inArray(cards.deckId, ids))).orderBy(cards.id);
        const [r] = await ex(ctx).select({ n: count() }).from(reviews).where(and(eq(reviews.userId, ctx.userId), inArray(reviews.deckId, ids)));
        return { before: row!, decks: rows.filter(d => ids.includes(d.id)), cards: affectedCards, reviewCount: r!.n, warning: 'Deletes the entire subtree and its card review history.' };
      }, async (ctx, a) => { await ex(ctx).delete(decks).where(and(eq(decks.userId, ctx.userId), eq(decks.id, a.id))); return { deleted: a.id }; }, true),
    writer('create_notebook', 'Propose creating a knowledge notebook.', z.strictObject({ title }),
      async (ctx, a) => { const [r] = await ex(ctx).select({ n: count() }).from(notebooks).where(eq(notebooks.userId, ctx.userId)); if (r!.n >= env.ai.MAX_NOTEBOOKS_PER_USER) throw new McpToolError('too_many_notebooks'); return { create: a }; },
      async (ctx, a) => (await ex(ctx).insert(notebooks).values({ userId: ctx.userId, ...a }).returning())[0]),
    writer('update_notebook', 'Propose updating notebook metadata, pinning or archiving.', editNotebook,
      async (ctx, { id, ...patch }) => ({ before: await ownedNotebook(ctx, id), changes: nonempty(patch) }),
      async (ctx, { id, ...patch }) => {
        const content = ['title', 'emoji', 'color', 'description'].some(k => k in patch);
        return (await ex(ctx).update(notebooks).set({ ...patch, ...(content ? { updatedAt: sql`GREATEST(now(), ${notebooks.updatedAt} + interval '1 millisecond')` } : {}) }).where(and(eq(notebooks.userId, ctx.userId), eq(notebooks.id, id))).returning())[0];
      }),
    writer('delete_notebook', 'Propose deleting a notebook and its notebook-owned notes and artifacts. Conversations, library sources, source-owned study work and cards survive.', z.strictObject({ id }),
      async (ctx, a) => {
        const before = await ownedNotebook(ctx, a.id);
        const ns = await ex(ctx).select({ id: notebookNotes.id, updatedAt: notebookNotes.updatedAt }).from(notebookNotes).where(and(eq(notebookNotes.userId, ctx.userId), eq(notebookNotes.notebookId, a.id))).orderBy(notebookNotes.id);
        const artifacts = await ex(ctx).select({ id: notebookArtifacts.id }).from(notebookArtifacts).where(and(eq(notebookArtifacts.userId, ctx.userId), eq(notebookArtifacts.notebookId, a.id))).orderBy(notebookArtifacts.id);
        const threads = await ex(ctx).select({ id: conversations.id }).from(conversations).where(and(eq(conversations.userId, ctx.userId), eq(conversations.notebookId, a.id))).orderBy(conversations.id);
        return { before, notes: ns, artifacts, retainedConversations: threads, warning: 'Notebook-owned notes and artifacts will be deleted. Conversations, sources, source-owned study work and cards remain.' };
      }, async (ctx, a) => { await ex(ctx).delete(notebooks).where(and(eq(notebooks.userId, ctx.userId), eq(notebooks.id, a.id))); return { deleted: a.id }; }, true),
    writer('save_source_note', 'Propose saving a written note directly to an owned library source, without creating a notebook. Requires confirmation.',
      z.strictObject({ sourceId: id, title: z.string().trim().min(1).max(NOTE_TITLE_MAX), content: z.string().max(NOTE_CONTENT_MAX) }),
      async (ctx, args) => {
        const source = await ownedSource(ctx, args.sourceId);
        const [total] = await ex(ctx).select({ n: count() }).from(notebookNotes).where(and(eq(notebookNotes.userId,ctx.userId),eq(notebookNotes.ownerKind,'source'),eq(notebookNotes.sourceOriginId,args.sourceId)));
        if (total!.n >= MAX_NOTES_PER_NOTEBOOK) throw new McpToolError('too_many_notes');
        return { source, count: total!.n, create: args };
      }, async (ctx,args) => createStudyNote(ctx.userId,{kind:'source',id:args.sourceId},{title:args.title,content:args.content},ctx.tx)),
    writer('update_note', 'Propose editing or pinning a written notebook note (not a flashcard note).', editNote,
      async (ctx, { id, ...patch }) => ({ before: await ownedNote(ctx, id), changes: nonempty(patch) }),
      async (ctx, { id, ...patch }) => {
        const [row] = await ex(ctx).update(notebookNotes).set({ ...patch, ...('title' in patch || 'content' in patch ? { updatedAt: new Date() } : {}) }).where(and(eq(notebookNotes.userId, ctx.userId), eq(notebookNotes.id, id))).returning();
        if ('title' in patch || 'content' in patch) await bump(ctx, row!.notebookId);
        return row;
      }),
    writer('delete_note', 'Propose deleting one written notebook note.', z.strictObject({ id }),
      async (ctx, a) => ({ before: await ownedNote(ctx, a.id) }),
      async (ctx, a) => { const [row] = await ex(ctx).delete(notebookNotes).where(and(eq(notebookNotes.userId, ctx.userId), eq(notebookNotes.id, a.id))).returning(); await bump(ctx, row!.notebookId); return { deleted: a.id }; }, true),
    ...(['attach_source', 'detach_source'] as const).map(name => writer(name,
      name === 'attach_source' ? 'Propose attaching an existing library source to a notebook.' : 'Propose detaching a source from a notebook. The library source remains.', attachment,
      async (ctx, a) => {
        const notebook = await ownedNotebook(ctx, a.notebookId); const source = await ownedSource(ctx, a.sourceId);
        const [attached] = await ex(ctx).select().from(notebookSources).where(and(eq(notebookSources.userId, ctx.userId), eq(notebookSources.notebookId, a.notebookId), eq(notebookSources.sourceId, a.sourceId)));
        if (name === 'attach_source' && !attached) {
          const [r] = await ex(ctx).select({ n: count() }).from(notebookSources).where(and(eq(notebookSources.userId, ctx.userId), eq(notebookSources.notebookId, a.notebookId)));
          if (r!.n >= env.ai.MAX_SOURCES_PER_NOTEBOOK) throw new McpToolError('too_many_sources');
        }
        return { notebook: { id: notebook.id, title: notebook.title }, source, attached: Boolean(attached) };
      }, async (ctx, a) => {
        if (name === 'attach_source') await attachSourceToNotebook(ex(ctx), { userId: ctx.userId, ...a });
        else await ex(ctx).delete(notebookSources).where(and(eq(notebookSources.userId, ctx.userId), eq(notebookSources.notebookId, a.notebookId), eq(notebookSources.sourceId, a.sourceId)));
        await bump(ctx, a.notebookId); return { ok: true, ...a };
      })),
    writer('update_source', 'Propose editing library source metadata or tags; parsed source text remains unchanged.', editSource,
      async (ctx, { id, ...patch }) => ({ before: await ownedSource(ctx, id), changes: nonempty(patch) }),
      async (ctx, { id, ...patch }) => { await ex(ctx).update(sources).set({ ...patch, updatedAt: new Date() }).where(and(eq(sources.userId, ctx.userId), eq(sources.id, id))); return { updated: id }; }),
    writer('set_reading_status', 'Propose marking a source unread, reading or finished.', z.strictObject({ sourceId: id, status: z.enum(['unread', 'reading', 'finished']) }),
      async (ctx, a) => { const source = await ownedSource(ctx, a.sourceId); const [state] = await ex(ctx).select().from(sourceReadingState).where(and(eq(sourceReadingState.userId, ctx.userId), eq(sourceReadingState.sourceId, a.sourceId))); return { source, before: state ?? null, status: a.status }; },
      async (ctx, a) => { await ex(ctx).insert(sourceReadingState).values({ userId: ctx.userId, ...a }).onConflictDoUpdate({ target: [sourceReadingState.sourceId, sourceReadingState.userId], set: { status: a.status, updatedAt: new Date() } }); return { ok: true }; }),
    writer('delete_card', 'Propose deleting one flashcard and its reviews. Sibling cards are preserved.', z.strictObject({ id }),
      async (ctx, a) => {
        const q = ex(ctx).select().from(cards).where(and(eq(cards.userId, ctx.userId), eq(cards.id, a.id)));
        const before = required((await (ctx.tx ? q.for('update') : q))[0]);
        const [r] = await ex(ctx).select({ n: count() }).from(reviews).where(and(eq(reviews.userId, ctx.userId), eq(reviews.cardId, a.id)));
        return { before, reviewCount: r!.n };
      }, async (ctx, a) => { await ex(ctx).delete(cards).where(and(eq(cards.userId, ctx.userId), eq(cards.id, a.id))); return { deleted: a.id }; }, true),
    writer('delete_flashcard_note', 'Propose deleting a flashcard note AND all generated sibling cards and reviews.', z.strictObject({ id }),
      async (ctx, a) => {
        const q = ex(ctx).select().from(notes).where(and(eq(notes.userId, ctx.userId), eq(notes.id, a.id)));
        const before = required((await (ctx.tx ? q.for('update') : q))[0]);
        const siblings = await ex(ctx).select().from(cards).where(and(eq(cards.userId, ctx.userId), eq(cards.noteId, a.id))).orderBy(cards.id);
        return { before, cards: siblings, warning: 'All sibling cards and their review history will be deleted.' };
      }, async (ctx, a) => { await ex(ctx).delete(notes).where(and(eq(notes.userId, ctx.userId), eq(notes.id, a.id))); return { deleted: a.id }; }, true),
  ];
}
