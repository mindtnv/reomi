import { and, eq, inArray } from 'drizzle-orm';
import { cards, db, notebookArtifacts, notebookNotes } from '@reomi/db';
import type { AssistantContextSnapshot, AssistantObjectKind } from '@reomi/shared';
import type { Tool, ToolContext } from './tools';

const outside = 'outside_context: object not found in selected context; attach it or change Only these materials before reading it';
const metadata = new Set(['get_capabilities', 'list_decks', 'list_library', 'list_notebooks', 'list_note_types', 'list_deck_options', 'list_tags', 'list_filtered_decks']);

/** Scope is server-owned. A different read alias must not bypass strict context. */
export async function assistantReadScopeError(ctx: ToolContext, name: string, raw: unknown): Promise<string | undefined> {
  const snapshot = ctx.assistantContext;
  const legacy = !snapshot && ctx.notebook;
  if (snapshot?.policy !== 'strict' && !legacy) return undefined;
  if (metadata.has(name)) return undefined;
  // The plan is drafted from the user's goal. It does not read selected materials.
  if (name === 'propose_topic_plan') return undefined;
  const args = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const sourceIds = snapshot?.sourceIds ?? (legacy ? legacy.sourceIds : []);
  const deckIds = snapshot?.deckIds ?? [];
  const has = (kind: AssistantObjectKind, id: unknown) => snapshot?.refs.some(s => s.available && s.ref.kind === kind && s.ref.id === id) ?? false;
  const notebookAllowed = (id: unknown) => has('notebook', id) || Boolean(legacy && legacy.notebookId === id);
  if (name === 'read_context_object') {
    if (has(args.kind as AssistantObjectKind,args.id)) return undefined;
    if (args.kind === 'written_note') name = 'get_source_note';
    else if (args.kind === 'artifact') name = 'get_source_artifact';
    else return outside;
  }
  if (name === 'list_source_artifacts') return sourceIds.includes(String(args.id)) ? undefined : outside;
  if (name === 'list_source_notes') return sourceIds.includes(String(args.id)) ? undefined : outside;
  if (name === 'get_source_note') {
    if (has('written_note',args.id)) return undefined;
    if (typeof args.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(args.id)) return outside;
    const [note] = await db.select({sourceId:notebookNotes.sourceId,notebookId:notebookNotes.notebookId}).from(notebookNotes)
      .where(and(eq(notebookNotes.userId,ctx.userId),eq(notebookNotes.id,args.id))).limit(1);
    return note && (note.sourceId && sourceIds.includes(note.sourceId) || notebookAllowed(note.notebookId)) ? undefined : outside;
  }
  if (['web_search', 'fetch_page'].includes(name)) return outside;
  if (name === 'read_source') return undefined; // Its reader checks scope and returns the selected source choices.
  if (name === 'list_marked_passages') return undefined; // The reader validates scope and lists only selected choices.

  if (['read_source_chunks', 'get_library_item', 'get_source_cards', 'get_source_marks', 'get_source_annotations'].includes(name)) return sourceIds.includes(String(args.id)) ? undefined : outside;
  if (['search_source', 'search_library'].includes(name)) return undefined; // Registry routes both through scoped retrieval.
  if (['search_cards', 'browse_cards'].includes(name)) return deckIds.length ? undefined : outside;
  // study_stats ignores deckId for global (including its default) scope. An
  // allowed ID must not authorize a different, account-wide query.
  if (name === 'study_stats' && args.scope !== 'deck') return outside;
  if (['list_cards', 'get_review_queue', 'get_retention', 'study_stats', 'due_forecast'].includes(name)) return deckIds.includes(String(args.deckId)) ? undefined : outside;
  if (['get_card', 'card_progress', 'get_card_sources'].includes(name)) {
    const id = typeof args.cardId === 'string' ? args.cardId : typeof args.id === 'string' ? args.id : '';
    if (has('card', id)) return undefined;
    if (!deckIds.length || !/^[0-9a-f-]{36}$/i.test(id)) return outside;
    const [owned] = await db.select({ id: cards.id }).from(cards)
      .where(and(eq(cards.userId, ctx.userId), eq(cards.id, id), inArray(cards.deckId, deckIds))).limit(1);
    return owned ? undefined : outside;
  }
  if (['list_notes', 'list_notebook_notes', 'list_artifacts'].includes(name)) return notebookAllowed(args.notebookId ?? args.id ?? ctx.notebook?.notebookId) ? undefined : outside;
  if (name === 'read_note') {
    if (has('written_note', args.noteId)) return undefined;
    if (typeof args.noteId !== 'string' || !/^[0-9a-f-]{36}$/i.test(args.noteId)) return outside;
    const [note] = await db.select({ notebookId: notebookNotes.notebookId }).from(notebookNotes)
      .where(and(eq(notebookNotes.userId, ctx.userId), eq(notebookNotes.id, args.noteId))).limit(1);
    return note && notebookAllowed(note.notebookId) ? undefined : outside;
  }
  if (['get_artifact','list_quiz_attempts','get_source_artifact','list_source_quiz_attempts'].includes(name)) {
    const id=args.artifactId ?? args.id;
    if(has('artifact',id))return undefined;
    if(typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id))return outside;
    const [artifact]=await db.select({notebookId:notebookArtifacts.notebookId,sourceId:notebookArtifacts.sourceId,sourceIds:notebookArtifacts.sourceIds}).from(notebookArtifacts)
      .where(and(eq(notebookArtifacts.userId,ctx.userId),eq(notebookArtifacts.id,id))).limit(1);
    return artifact && (notebookAllowed(artifact.notebookId) || artifact.sourceId && sourceIds.includes(artifact.sourceId))
      && artifact.sourceIds.every(sourceId=>sourceIds.includes(sourceId)) ? undefined : outside;
  }

  // Aggregated overview/graph/similarity routes may contain passages outside a
  // selected subset. They need a scoped implementation before being read here.
  return outside;
}

export function withAssistantReadScope(tool: Tool): Tool {
  if (tool.kind !== 'read') return tool;
  return { ...tool, async execute(ctx, args) {
    const error = await assistantReadScopeError(ctx, tool.name, args);
    if (error) return { ok: false, error };
    const snapshot: AssistantContextSnapshot | undefined = ctx.assistantContext;
    return tool.execute(snapshot?.policy === 'strict' ? { ...ctx, deckIds: snapshot.deckIds } : ctx, args);
  } };
}
