import { createHash } from 'node:crypto';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db, user, notebooks, decks } from '@reomi/db';
import { env } from '../env.ts';
import { safeError } from '../logger.ts';
import { readTools } from '../mcp/reads.ts';
import { managementTools } from '../mcp/management.ts';
import { sourceTools } from '../mcp/source-tools.ts';
import { legacyTools } from '../mcp/legacy-tools.ts';
import { McpToolError, type KnowledgeTool, type McpArgs } from '../mcp/types.ts';
import { pushGrounding, type Tool, type ToolContext, type ToolImpact, type ToolResult } from './tools.ts';

// Fixed GET routes only; identity comes from authenticated ToolContext, never args.
let handler: Promise<(request: Request) => Promise<Response>> | undefined;
function internalHandle(request: Request): Promise<Response> {
  handler ??= import('../app.ts').then(({ buildApp }) => { const app = buildApp(); return (req: Request) => app.handle(req); });
  return handler.then(handle => handle(request));
}
function canonical(value: unknown): string {
  const sort = (v: any): any => Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sort(v[k])])) : v;
  return JSON.stringify(sort(JSON.parse(JSON.stringify(value))));
}
const fingerprint = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const excerpt = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 500);
async function prepared(tool: KnowledgeTool, ctx: ToolContext, args: McpArgs): Promise<Record<string, any>> {
  const state = await tool.prepare!(ctx, args);
  const ex = ctx.tx ?? db;
  if (typeof args.notebookId === 'string') {
    const [book] = await ex.select({ id: notebooks.id, title: notebooks.title }).from(notebooks).where(and(eq(notebooks.id, args.notebookId), eq(notebooks.userId, ctx.userId)));
    if (!book) throw new McpToolError('notebook_not_found');
    state.notebook = { ...(state.notebook as object ?? {}), ...book };
  }
  if (typeof args.parentId === 'string') {
    const [parent] = await ex.select({ id: decks.id, name: decks.name }).from(decks).where(and(eq(decks.id, args.parentId), eq(decks.userId, ctx.userId)));
    if (!parent) throw new McpToolError('deck_not_found');
    state.parentDeck = parent;
  }
  return state;
}
function impactFor(tool: KnowledgeTool, args: McpArgs, state: Record<string, any>): ToolImpact {
  const before = state.before ?? {};
  const changes = (state.changes ?? state.create ?? args) as Record<string, unknown>;
  const fields = Object.entries(changes).filter(([key,value]) => value !== undefined && !['id','notebookId','sourceId'].includes(key)).map(([field, value]) => ({ field, ...(before[field] !== undefined ? { before: excerpt(before[field]) } : {}), after: field === 'parentId' ? state.parentDeck?.name ?? '—' : excerpt(value) }));
  if (state.notebook?.title) fields.push({ field: 'notebook', after: state.notebook.title });
  if (state.source?.title) fields.push({ field: 'source', after: state.source.title });
  const affected = ['cards','decks','notes','artifacts','conversations'].filter(key => Array.isArray(state[key])).map(kind => ({ kind, count: state[kind].length }));
  if (typeof state.reviewCount === 'number') affected.push({ kind: 'reviews', count: state.reviewCount });
  return {
    ...(state.impact ?? {}), snapshotHash: fingerprint(state),
    resourcePreview: { title: String(before.title ?? before.name ?? before.renderFrontText ?? Object.values(before.fieldValues ?? {})[0] ?? state.source?.title ?? state.notebook?.title ?? '').slice(0, 200), fields, affected, ...(Array.isArray(state.retainedConversations) ? {retained:[{kind:'conversations',count:state.retainedConversations.length}]} : {}), destructive: tool.destructive || undefined },
  };
}
/** Remove storage/provider internals before model-facing serialization. */
function publicValue(value: unknown): any {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(publicValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !['userId','storageKey','storage_key','byteHash','byte_hash','embedding','tokenHash'].includes(key)).map(([key,v]) => [key, publicValue(v)]));
  return value;
}
const appUrl = (path: string) => new URL(path, env.WEB_ORIGIN).toString();
function readResult(name: string, value: any, args: McpArgs): unknown {
  if (name === 'list_source_notes') return { ...value, items: value.items?.map((note: any) => ({ id:note.id,title:note.title,excerpt:note.excerpt,sourceId:note.sourceId,sourceOriginTitle:note.sourceOriginTitle,pinned:note.pinned })) };
  if (name === 'get_library_item') return { ...value, readerUrl: appUrl(`/library/${args.id}`) };
  if (name === 'get_notebook') return { ...value, url: appUrl(`/notebooks/${args.id}`) };
  if (name === 'list_library' && Array.isArray(value?.items)) return { ...value, items: value.items.map((item: any) => ({ id: item.id, title: item.title, author: item.author, kind: item.kind, status: item.status, pageCount: item.pageCount, tags: item.tags, readerUrl: appUrl(`/library/${item.id}`) })) };
  if (name === 'read_source_chunks') return { ...value, sourceId: args.id, readerUrl: appUrl(`/library/${args.id}`), citationHint: 'Cite this reader URL with ?page=<page> or ?chunk=<chunk-id> when using a returned passage.' };
  if (name === 'list_notebooks' && Array.isArray(value?.items)) return { ...value, items: value.items.map((item: any) => ({ id: item.id, title: item.title, description: item.description?.slice(0, 180), archived: item.archived, pinned: item.pinned, sourceCount: item.sourceCount, noteCount: item.noteCount, url: appUrl(`/notebooks/${item.id}`) })) };
  return value;
}
function failure(error: unknown, ctx: ToolContext): ToolResult {
  if (error instanceof z.ZodError) return { ok: false, error: 'invalid_arguments: check the tool schema' };
  if (error instanceof McpToolError) return { ok: false, error: error.message.slice(0, 400) };
  ctx.log.warn({ event: 'ai.knowledge_tool.failed', err: safeError(error) }, 'ai.knowledge_tool.failed');
  return { ok: false, error: 'operation_failed' };
}
function adapt(tool: KnowledgeTool): Tool {
  const notebookTool = ['list_notes', 'read_note', 'save_note'].includes(tool.name);
  const parse = (args: unknown, ctx: ToolContext) => {
    const value = args && typeof args === 'object' ? args as Record<string, unknown> : {};
    return tool.schema.parse(notebookTool && value.notebookId === undefined && ctx.notebook
      ? { ...value, notebookId: ctx.notebook.notebookId } : value) as McpArgs;
  };
  const parameters = z.toJSONSchema(tool.schema) as Record<string, unknown>;
  if (notebookTool && Array.isArray(parameters.required)) parameters.required = parameters.required.filter(key => key !== 'notebookId');
  return {
    name: tool.name, description: tool.description,
    parameters,
    kind: tool.readOnly ? 'read' : 'write', requirePreview: !tool.readOnly,
    ...(!tool.readOnly ? {
      async validate(ctx: ToolContext, args: unknown) {
        try { await prepared(tool, ctx, parse(args, ctx)); return { ok: true as const }; }
        catch (error) { const result = failure(error, ctx); return { ok: false as const, error: result.ok ? 'invalid_arguments' : result.error }; }
      },
      async dryRun(ctx: ToolContext, args: unknown) {
        const parsed = parse(args, ctx), state = await prepared(tool, ctx, parsed);
        return impactFor(tool, parsed, state);
      },
    } : {}),
    async execute(ctx, args) {
      try {
        const parsed = parse(args, ctx);
        if (tool.readOnly) {
          const raw = await tool.execute(ctx, parsed);
          if (['list_notes','read_note'].includes(tool.name) && (raw as {ok?: boolean})?.ok && typeof (raw as {text?: unknown}).text === 'string') {
            return { ok: true, text: (raw as {text: string}).text };
          }
          const text = JSON.stringify(publicValue(readResult(tool.name, raw, parsed)));
          if (text.length > env.ai.TOOL_RESULT_MAX_CHARS) return { ok: false, error: 'result_too_large: retry with a smaller limit or chunk range' };
          if (tool.name === 'read_source_chunks') {
            const chunks = (raw as { items?: { id: string; text: string; position: number; page?: number | null }[] }).items ?? [];
            await pushGrounding(ctx, chunks);
            return { ok: true, text, citations: chunks.map(c => ({ kind: 'source' as const,
              sourceId: String(parsed.id), sourceChunkId: c.id, position: c.position,
              ...(c.page != null ? { page: c.page } : {}), snippet: c.text.slice(0, 320),
            })) };
          }
          return { ok: true, text };
        }
        if (!ctx.tx || !ctx.confirmationHash) return { ok: false, error: 'confirmation_preview_required' };
        // Savepoint prevents a caught service error from committing partial work.
        const result = await ctx.tx.transaction(async tx => {
          const scoped = { ...ctx, tx }, state = await prepared(tool, scoped, parsed);
          if (fingerprint(state) !== ctx.confirmationHash) throw new McpToolError('stale_preview: request a new preview before applying');
          return tool.execute(scoped, parsed);
        });
        const safe = publicValue(result);
        const text = JSON.stringify({ operation: tool.name, result: safe });
        return { ok: true, text: text.length <= env.ai.TOOL_RESULT_MAX_CHARS ? text : JSON.stringify({ operation: tool.name, ok: true, id: safe?.id }),
          afterCommit: tool.afterCommit ? () => tool.afterCommit!({ ...ctx, tx: undefined }, parsed, result) : undefined };
      } catch (error) { return failure(error, ctx); }
    },
  };
}

export function buildKnowledgeTools(): Tool[] {
  const reads = readTools(async ctx => {
    const [owner] = await db.select().from(user).where(eq(user.id, ctx.userId));
    if (!owner) throw new McpToolError('not_found');
    return owner;
  }, internalHandle);
  const notebookNotes = legacyTools().filter(tool => ['list_notes','read_note','save_note'].includes(tool.name));
  return [...reads, ...managementTools(), ...sourceTools(), ...notebookNotes].map(adapt);
}
