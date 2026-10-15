import { z } from 'zod';
import { and, count, eq } from 'drizzle-orm';
import { db, notebooks, notebookSources, sources, type Source } from '@reomi/db';
import { insertInlineSource, enqueueInlineSource, MAX_INLINE_TEXT } from '../modules/sources-shared.ts';
import { env, embeddingEnabled } from '../env.ts';
import { McpToolError, type KnowledgeTool } from './types.ts';

export function sourceTools(): KnowledgeTool[] {
  return (['text', 'url'] as const).map(kind => {
    const schema = z.strictObject({
      title: z.string().trim().min(1).max(300), notebookId: z.uuid().optional(),
      ...(kind === 'text' ? { text: z.string().min(1).max(MAX_INLINE_TEXT) } : { url: z.url().max(2000).refine(value => ['https:', 'http:'].includes(new URL(value).protocol)) }),
    });
    return {
      name: `create_${kind}_source`, readOnly: false,
      description: `Propose adding a ${kind === 'text' ? 'plain text document' : 'web page URL'} to the library, optionally attaching it to a notebook. Ingestion starts after confirmation.`,
      schema,
      async prepare(ctx, args) {
        const ex = ctx.tx ?? db;
        const [r] = await ex.select({ n: count() }).from(sources).where(eq(sources.userId, ctx.userId));
        if (r!.n >= env.ai.MAX_LIBRARY_ITEMS_PER_USER) throw new McpToolError('library_full');
        if (args.notebookId) {
          const [nb] = await ex.select({ id: notebooks.id }).from(notebooks).where(and(eq(notebooks.userId, ctx.userId), eq(notebooks.id, String(args.notebookId))));
          if (!nb) throw new McpToolError('notebook_not_found');
          const [attached] = await ex.select({ n: count() }).from(notebookSources).where(and(eq(notebookSources.userId, ctx.userId), eq(notebookSources.notebookId, nb.id)));
          if (attached!.n >= env.ai.MAX_SOURCES_PER_NOTEBOOK) throw new McpToolError('too_many_sources');
        }
        return { kind, create: args, indexing: embeddingEnabled ? 'enabled' : 'parked_without_embeddings' };
      },
      async execute(ctx, args) {
        if (!ctx.tx) throw new Error('transaction_required');
        const input = kind === 'text' ? { kind, title: String(args.title), text: String(args.text) } : { kind, title: String(args.title), url: String(args.url) };
        return insertInlineSource(ctx.tx, ctx.userId, input, args.notebookId as string | undefined);
      },
      afterCommit(ctx, args, result) {
        const input = kind === 'text' ? { kind, title: String(args.title), text: String(args.text) } : { kind, title: String(args.title), url: String(args.url) };
        enqueueInlineSource(result as Source, input, ctx.log);
      },
    } satisfies KnowledgeTool;
  });
}
