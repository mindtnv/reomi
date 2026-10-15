import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { db, cards, notes, noteTypes, decks, notebooks, notebookSources, sources } from '@reomi/db';
import { buildToolRegistry, enqueueToolCardsForIndex, type ToolContext } from '../ai/tools.ts';
import { env, embeddingEnabled } from '../env.ts';
import { McpToolError, type KnowledgeTool, type McpArgs } from './types.ts';

async function context(ctx: ToolContext, args: McpArgs, notebook: boolean): Promise<ToolContext> {
  if (!notebook) return ctx;
  const notebookId = String(args.notebookId);
  const ex = ctx.tx ?? db;
  const q = ex.select({ id: notebooks.id }).from(notebooks)
    .where(and(eq(notebooks.userId, ctx.userId), eq(notebooks.id, notebookId)));
  if (!(await (ctx.tx ? q.for('update') : q))[0]) throw new McpToolError('notebook_not_found');
  const attached = await ex.select({ id: sources.id }).from(notebookSources)
    .innerJoin(sources, eq(sources.id, notebookSources.sourceId))
    .where(and(eq(notebookSources.userId, ctx.userId), eq(notebookSources.notebookId, notebookId), eq(sources.userId, ctx.userId), eq(sources.status, 'ready')));
  return { ...ctx, notebook: { notebookId, sourceIds: attached.map(r => r.id) }, grounding: { chunkIds: [] } };
}

// Include uncapped state in the stored preview. A truncated display diff alone
// cannot detect changes outside its excerpt between preview and confirmation.
async function snapshot(ctx: ToolContext, args: McpArgs) {
  const ex = ctx.tx ?? db;
  const validId = (v: unknown): v is string => typeof v === 'string' && z.uuid().safeParse(v).success;
  const cardIds = [args.cardId, ...(Array.isArray(args.cardIds) ? args.cardIds : [])].filter(validId);
  const cq = ex.select().from(cards).where(and(eq(cards.userId, ctx.userId), inArray(cards.id, cardIds))).orderBy(cards.id);
  const initialCards = cardIds.length ? await cq : [];
  const noteIds = [...new Set([args.noteId, ...initialCards.map(r => r.noteId)].filter(validId))];
  const nq = ex.select().from(notes).where(and(eq(notes.userId, ctx.userId), inArray(notes.id, noteIds))).orderBy(notes.id);
  const initialNotes = noteIds.length ? await nq : [];
  const typeIds = [...new Set(initialNotes.map(r => r.noteTypeId))].sort();
  const tq = ex.select().from(noteTypes).where(inArray(noteTypes.id, typeIds)).orderBy(noteTypes.id);
  // Match note editing/conversion: type -> note -> cards. Locking a card first
  // would deadlock against reconciliation, which already holds its note.
  const typeRows = typeIds.length ? await (ctx.tx ? tq.for('share') : tq) : [];
  const noteRows = noteIds.length ? await (ctx.tx ? nq.for('update') : nq) : [];
  if (ctx.tx && noteRows.some(row => !typeIds.includes(row.noteTypeId)))
    throw new McpToolError('stale_preview: note type changed; propose again');
  const cardRows = cardIds.length ? await (ctx.tx ? cq.for('update') : cq) : [];
  if (ctx.tx && cardRows.some(row => !noteIds.includes(row.noteId)))
    throw new McpToolError('stale_preview: card note changed; propose again');
  const deckIds = [args.deckId].filter(validId);
  const dq = ex.select().from(decks).where(and(eq(decks.userId, ctx.userId), inArray(decks.id, deckIds)));
  const deckRows = deckIds.length ? await (ctx.tx ? dq.for('update') : dq) : [];
  return { cards: cardRows, notes: noteRows, noteTypes: typeRows, decks: deckRows };
}

export function legacyTools(): KnowledgeTool[] {
  const regular = buildToolRegistry({ knowledge: false, webSearchEnabled: false, fetchPageEnabled: false });
  const notebook = buildToolRegistry({ notebook: true, knowledge: false, webSearchEnabled: false, fetchPageEnabled: false })
    .filter(t => !regular.some(r => r.name === t.name));
  return [...regular, ...notebook].map(tool => {
    const inNotebook = notebook.includes(tool);
    const parameters = { ...tool.parameters, additionalProperties: false,
      properties: { ...(tool.parameters.properties as object), ...(inNotebook ? { notebookId: { type: 'string', format: 'uuid' } } : {}) },
      required: [...(tool.parameters.required as string[] ?? []), ...(inNotebook ? ['notebookId'] : [])],
    };
    return {
      name: tool.name, description: tool.description + (inNotebook ? ' Supply notebookId explicitly.' : ''),
      schema: z.fromJSONSchema(parameters as Parameters<typeof z.fromJSONSchema>[0]), readOnly: tool.kind === 'read', destructive: tool.kind === 'srs' || tool.name === 'edit_card',
      async prepare(ctx, args) {
        const scoped = await context(ctx, args, inNotebook);
        const before = await snapshot(scoped, args);
        const check = await tool.validate?.(scoped, args);
        if (check && !check.ok) throw new McpToolError(check.error.slice(0, 500));
        return { before, impact: await tool.dryRun!(scoped, args), arguments: args };
      },
      async execute(ctx, args) {
        if ((tool.name === 'search_cards' || tool.name === 'search_source') && !embeddingEnabled)
          throw new McpToolError('embeddings_unavailable: use browse_cards, list_library or read_source_chunks');
        const result = await tool.execute(await context(ctx, args, inNotebook), args);
        if (!result.ok) throw new McpToolError('tool_failed: verify arguments and capabilities');
        return result;
      },
      afterCommit(ctx, _args, result) {
        const cardIds = (result as { cardIds?: string[] }).cardIds;
        enqueueToolCardsForIndex(cardIds, ctx.log);
      },
    } satisfies KnowledgeTool;
  });
}
