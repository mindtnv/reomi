import { createHash } from 'node:crypto';
import { and, asc, desc, eq, exists, getTableColumns, inArray, isNull, or, sql } from 'drizzle-orm';
import { db, conversations, conversationContexts, messages, notebookSources, sources, decks, type Db } from '@reomi/db';
import { ASSISTANT_OBJECT_KINDS, AssistantContextError, assistantRefKey, mergeAssistantSnapshots, parseAssistantContext, type AssistantObjectKind, type AssistantObjectSnapshot, type AssistantContextSnapshot } from '@reomi/shared';
import { resolveAssistantRefs } from './assistant-context';
import type { AssistantObjectRef, MessageMention } from '@reomi/shared';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Conversation = typeof conversations.$inferSelect;
const refHash = (snapshot: AssistantObjectSnapshot) => createHash('sha256').update(assistantRefKey(snapshot.ref)).digest('hex');
const validUuid = (id: unknown) => {
  try { parseAssistantContext({ version: 1, refs: [{ kind: 'card', id }] }); return true; }
  catch { return false; }
};

async function saveRefs(tx: Tx, conversation: Conversation, refs: AssistantObjectSnapshot[]): Promise<void> {
  await tx.delete(conversationContexts).where(and(eq(conversationContexts.userId, conversation.userId), eq(conversationContexts.conversationId, conversation.id)));
  if (refs.length) await tx.insert(conversationContexts).values(refs.map((snapshot, position) => ({
    userId: conversation.userId, conversationId: conversation.id, kind: snapshot.ref.kind,
    objectId: snapshot.ref.id, refKey: refHash(snapshot), snapshot, position,
  })));
}

export async function conversationWithContext(conversation: Conversation, ex: Pick<Db, 'select'> = db) {
  const stored = await ex.select({ snapshot: conversationContexts.snapshot }).from(conversationContexts)
    .where(and(eq(conversationContexts.userId, conversation.userId), eq(conversationContexts.conversationId, conversation.id)))
    .orderBy(asc(conversationContexts.position));
  const previous = stored.map(r => r.snapshot);
  const refs = await resolveAssistantRefs(conversation.userId, previous.map(s => s.ref), { ex, previous, allowUnavailable: true });
  return { ...conversation, context: { version: 1 as const, policy: conversation.contextPolicy, revision: conversation.contextRevision, refs } };
}

export async function createAssistantConversation(userId: string, body: { title?: string; notebookId?: string; context?: unknown }) {
  if (body.context !== undefined && body.notebookId !== undefined) throw new AssistantContextError('ambiguous_context');
  const input = parseAssistantContext(body.context ?? {
    version: 1, policy: body.notebookId ? 'strict' : 'focus',
    refs: body.notebookId ? [{ kind: 'notebook', id: body.notebookId }] : [],
  });
  return db.transaction(async tx => {
    let refs: AssistantObjectSnapshot[];
    try { refs = await resolveAssistantRefs(userId, input.refs, { ex: tx }); }
    catch (error) {
      if (body.notebookId && error instanceof AssistantContextError && error.code === 'context_unavailable') throw new AssistantContextError('not_found');
      throw error;
    }
    const [row] = await tx.insert(conversations).values({
      userId, title: body.title ?? null, notebookId: body.notebookId ?? null,
      contextVersion: body.context === undefined ? 0 : 1, contextPolicy: input.policy,
    }).returning();
    await saveRefs(tx, row!, refs);
    return { ...row!, context: { ...input, revision: 0, refs } };
  });
}

export async function patchAssistantConversation(userId: string, id: string, body: {
  title?: string; pinned?: boolean; context?: unknown; expectedContextRevision?: number;
}) {
  const input = body.context === undefined ? undefined : parseAssistantContext(body.context);
  if (input && body.expectedContextRevision === undefined) throw new AssistantContextError('context_revision_required');
  if (!input && body.expectedContextRevision !== undefined) throw new AssistantContextError('invalid_context');
  if (!input && body.title === undefined && body.pinned === undefined) throw new AssistantContextError('nothing_to_update');
  return db.transaction(async tx => {
    const [original] = await tx.select().from(conversations)
      .where(and(eq(conversations.userId, userId), eq(conversations.id, id))).for('update');
    if (!original) throw new AssistantContextError('not_found');
    if (input && original.contextRevision !== body.expectedContextRevision) throw new AssistantContextError('context_stale');
    const refs = input ? await resolveAssistantRefs(userId, input.refs, { ex: tx }) : undefined;
    const [row] = await tx.update(conversations).set({
      ...(body.title !== undefined ? { title: body.title, updatedAt: new Date() } : {}),
      ...(body.pinned !== undefined ? { pinned: body.pinned } : {}),
      ...(input ? { contextPolicy: input.policy, contextVersion: 1, contextRevision: original.contextRevision + 1 } : {}),
    }).where(and(eq(conversations.userId, userId), eq(conversations.id, id))).returning();
    if (refs) await saveRefs(tx, row!, refs);
    return conversationWithContext(row!, tx);
  });
}

export function assistantContextErrorStatus(error: AssistantContextError): 400 | 404 | 409 {
  return error.code === 'not_found' ? 404 : error.code === 'context_stale' ? 409 : 400;
}

export async function listAssistantConversations(userId: string, query: {
  notebookId?: string; scope?: 'global'; contextKind?: string; contextId?: string; limit?: number; cursor?: string; q?: string;
}) {
  if (Boolean(query.contextKind) !== Boolean(query.contextId) || (query.notebookId && query.contextId)) throw new AssistantContextError('invalid_context_filter');
  const filterKind = query.notebookId ? 'notebook' : query.contextKind as AssistantObjectKind | undefined;
  const filterId = query.notebookId ?? query.contextId;
  if (filterKind && !(ASSISTANT_OBJECT_KINDS as readonly string[]).includes(filterKind)) throw new AssistantContextError('invalid_context_filter');
  if (filterId && (!validUuid(filterId) || !filterKind)) throw new AssistantContextError('invalid_context_filter');
  if (filterId && filterKind) {
    // Saved owner-scoped references remain filterable after their target dies.
    const [known] = await db.select({ id: conversationContexts.id }).from(conversationContexts)
      .where(and(eq(conversationContexts.userId, userId), eq(conversationContexts.kind, filterKind), eq(conversationContexts.objectId, filterId))).limit(1);
    const mentioned = !known ? await db.select({ id: messages.id }).from(messages)
      .where(and(eq(messages.userId, userId), sql`${messages.context} -> 'refs' @> ${JSON.stringify([{ ref: { kind: filterKind, id: filterId } }])}::jsonb`)).limit(1) : [];
    if (!known && !mentioned.length) {
      try { await resolveAssistantRefs(userId, [filterKind === 'source_passage'
        ? { kind: 'source', id: filterId } : { kind: filterKind, id: filterId }]); }
      catch (error) {
        if (error instanceof AssistantContextError) throw new AssistantContextError('not_found');
        throw error;
      }
    }
  }
  let cursor: { p: boolean; t: string; id: string } | undefined;
  if (query.cursor) {
    try {
      if (query.cursor.length > 512) throw new Error();
      const value = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (value.v !== 1 || typeof value.p !== 'boolean' || typeof value.t !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value.t)
        || !Number.isFinite(Date.parse(value.t)) || !validUuid(value.id)) throw new Error();
      cursor = value;
    } catch { throw new AssistantContextError('invalid_cursor'); }
  }
  const pinnedMatch = filterId && filterKind ? exists(db.select({ id: conversationContexts.id }).from(conversationContexts)
    .where(and(eq(conversationContexts.userId, userId), eq(conversationContexts.conversationId, conversations.id),
      eq(conversationContexts.kind, filterKind), eq(conversationContexts.objectId, filterId)))) : undefined;
  const messageMatch = filterId && filterKind ? exists(db.select({ id: messages.id }).from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.conversationId, conversations.id),
      sql`${messages.context} -> 'refs' @> ${JSON.stringify([{ ref: { kind: filterKind, id: filterId } }])}::jsonb`))) : undefined;
  const objectMatch = pinnedMatch ? or(pinnedMatch, messageMatch) : undefined;
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100)) throw new AssistantContextError('invalid_limit');
  const limit = Math.min(100, Math.max(1, query.limit ?? 50));
  const search = query.q?.trim();
  if (search && search.length > 200) throw new AssistantContextError('invalid_search');
  const rows = await db.select({ ...getTableColumns(conversations),
    cursorStamp: sql<string>`to_char(${conversations.updatedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
  }).from(conversations).where(and(
    eq(conversations.userId, userId), query.scope === 'global' ? isNull(conversations.notebookId) : undefined,
    search ? sql`${conversations.title} ILIKE ${`%${search.replace(/[\\%_]/g, '\\$&')}%`}` : undefined,
    query.notebookId ? or(eq(conversations.notebookId, query.notebookId), objectMatch) : objectMatch,
    cursor ? sql`(${conversations.pinned}, ${conversations.updatedAt}, ${conversations.id}) < (${cursor.p}, ${cursor.t}::timestamptz, ${cursor.id}::uuid)` : undefined,
  )).orderBy(desc(conversations.pinned), desc(conversations.updatedAt), desc(conversations.id)).limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const items = await Promise.all(page.map(({ cursorStamp: _, ...row }) => conversationWithContext(row)));
  return { items, nextCursor: rows.length > limit && last
    ? Buffer.from(JSON.stringify({ v: 1, p: last.pinned, t: last.cursorStamp, id: last.id })).toString('base64url') : null };
}

/** Pins are read with their revision under the same lock; mentions only affect this turn. */
export async function freezeAssistantTurnContext(userId: string, id: string, input?: unknown, expectedRevision?: number): Promise<AssistantContextSnapshot> {
  return db.transaction(async tx => {
    const [conversation] = await tx.select().from(conversations)
      .where(and(eq(conversations.userId, userId), eq(conversations.id, id))).for('update');
    if (!conversation) throw new AssistantContextError('not_found');
    if (expectedRevision !== undefined && expectedRevision !== conversation.contextRevision) throw new AssistantContextError('context_stale');
    let pinned = (await conversationWithContext(conversation, tx)).context.refs;
    const additions = input === undefined ? { version: 1 as const, policy: conversation.contextPolicy, refs: [] } : parseAssistantContext(input);
    if (conversation.contextVersion === 0 && conversation.notebookId) {
      const notebookId=conversation.notebookId;
      const explicit=additions.refs.some(ref=>ref.kind==='notebook'&&ref.id===notebookId&&ref.sourceIds!==undefined);
      const stored=pinned.find(item=>item.ref.kind==='notebook'&&item.ref.id===notebookId);
      if(!explicit&&stored?.ref.kind==='notebook'&&stored.ref.sourceIds===undefined) {
        const selected=await legacyNotebookSelection(userId,conversation.id,notebookId,tx);
        if(selected!==undefined) {
          const [resolved]=await resolveAssistantRefs(userId,[{kind:'notebook',id:notebookId,sourceIds:selected}],{ex:tx,allowUnavailable:true,previous:[stored]});
          pinned=pinned.map(item=>item===stored?resolved!:item);
        }
      }
    }
    const incoming = await resolveAssistantRefs(userId, additions.refs, { ex: tx });
    // An explicit notebook selection replaces that notebook's pinned selection;
    // unioning both would silently widen a narrowed or explicitly empty scope.
    const snapshots = new Map(mergeAssistantSnapshots(pinned,incoming).map(s=>[assistantRefKey(s.ref),s]));
    // Validate the combined budget, not just each input separately.
    parseAssistantContext({ version: 1, refs: [...snapshots.values()].map(s => s.ref) });
    const sourceIds = new Set<string>();
    const deckIds = new Set<string>();
    for (const snapshot of snapshots.values()) {
      if (!snapshot.available) continue;
      const ref = snapshot.ref;
      if (ref.kind === 'source' || ref.kind === 'source_passage') sourceIds.add(ref.id);
      if (ref.kind === 'notebook') {
        const rows = await tx.select({ id: sources.id }).from(notebookSources)
          .innerJoin(sources, and(eq(sources.id, notebookSources.sourceId), eq(sources.userId, userId)))
          .where(and(eq(notebookSources.userId, userId), eq(notebookSources.notebookId, ref.id),
            ref.sourceIds !== undefined ? inArray(sources.id, ref.sourceIds) : undefined));
        for (const row of rows) sourceIds.add(row.id);
      }
      if (ref.kind === 'deck') deckIds.add(ref.id);
    }
    if ([...snapshots.values()].some(s => s.available && s.ref.kind === 'deck')) {
      const rows = await tx.select({ id: decks.id, parentId: decks.parentId }).from(decks).where(eq(decks.userId, userId));
      // Only expand explicitly mentioned decks; a card does not grant its whole subtree.
      const roots = [...snapshots.values()].filter(s => s.available && s.ref.kind === 'deck').map(s => s.ref.id);
      const expanded = new Set(roots);
      const queue = [...roots];
      for (let n = 0; n < queue.length; n++) for (const row of rows) {
        if (row.parentId === queue[n] && !expanded.has(row.id)) { expanded.add(row.id); queue.push(row.id); }
      }
      for (const value of expanded) deckIds.add(value);
    }
    return { version: 1, policy: additions.policy, refs: [...snapshots.values()], sourceIds: [...sourceIds], deckIds: [...deckIds], revision: conversation.contextRevision };
  });
}

/** Historical source data is serialized as data, never executable tool calls. */
export function appendAssistantContext(content: string, context: AssistantContextSnapshot | null | undefined): string {
  if (!context) return content;
  const data = JSON.stringify({ policy: context.policy, objects: context.refs.map(s => ({
    kind: s.ref.kind, id: s.ref.id, label: s.label, available: s.available,
    ...(s.excerpt ? { excerpt: s.excerpt, verifiedQuote: s.verifiedQuote === true } : {}),
    ...(s.ref.kind === 'source_passage' ? { locator: s.ref.locator } : {}),
  })) }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `${content}\n\n<assistant_context_data>\n${data}\n</assistant_context_data>`;
}

/** Freeze already-resolved legacy selections instead of guessing them on replay. */
export async function freezeLegacyAssistantContext(userId: string, conversation: Conversation, input: {
  notebook?: { notebookId: string; sourceIds: string[] };
  deckId?: string; deckIds?: string[]; mentions?: MessageMention[] | null;
}): Promise<AssistantContextSnapshot | undefined> {
  const refs: AssistantObjectRef[] = [];
  if (input.notebook) refs.push({ kind: 'notebook', id: input.notebook.notebookId, sourceIds: input.notebook.sourceIds });
  if (input.deckId && input.deckIds?.includes(input.deckId)) refs.push({ kind: 'deck', id: input.deckId });
  for (const mention of input.mentions ?? []) refs.push({ kind: 'card', id: mention.cardId });
  if (!refs.length && input.deckIds === undefined) {
    // A deleted legacy notebook remains a strict empty/tombstoned context.
    return conversation.contextPolicy === 'strict' ? freezeAssistantTurnContext(userId, conversation.id) : undefined;
  }
  const resolved = await resolveAssistantRefs(userId, refs, { allowUnavailable: true });
  let revision = conversation.contextRevision;
  if (input.notebook && conversation.contextVersion === 0) {
    revision = await db.transaction(async tx => {
      const [current] = await tx.select().from(conversations)
        .where(and(eq(conversations.userId, userId), eq(conversations.id, conversation.id))).for('update');
      if (!current) throw new AssistantContextError('not_found');
      if (current.contextVersion !== 0 || current.contextRevision !== conversation.contextRevision) throw new AssistantContextError('context_stale');
      const [old] = await tx.select({ snapshot: conversationContexts.snapshot }).from(conversationContexts)
        .where(and(eq(conversationContexts.userId, userId), eq(conversationContexts.conversationId, current.id), eq(conversationContexts.kind, 'notebook'))).limit(1);
      const notebook = resolved.find(s => s.ref.kind === 'notebook')!;
      const changed = !old || assistantRefKey(old.snapshot.ref) !== assistantRefKey(notebook.ref);
      if (changed) {
        await saveRefs(tx, current, [notebook]);
        await tx.update(conversations).set({ contextRevision: current.contextRevision + 1 })
          .where(and(eq(conversations.userId, userId), eq(conversations.id, current.id)));
      }
      return current.contextRevision + (changed ? 1 : 0);
    });
  }
  return { version: 1, revision,
    policy: input.notebook || input.deckIds !== undefined ? 'strict' : 'focus',
    refs: resolved,
    sourceIds: input.notebook?.sourceIds ?? [], deckIds: input.deckIds ?? [],
  };
}

export async function legacyNotebookSelection(userId: string, conversationId: string, notebookId: string, ex: Pick<typeof db, 'select'> = db): Promise<string[] | undefined> {
  const [pin] = await ex.select({ snapshot: conversationContexts.snapshot }).from(conversationContexts)
    .where(and(eq(conversationContexts.userId, userId), eq(conversationContexts.conversationId, conversationId),
      eq(conversationContexts.kind, 'notebook'), eq(conversationContexts.objectId, notebookId))).limit(1);
  if (pin?.snapshot.ref.kind === 'notebook' && pin.snapshot.ref.sourceIds !== undefined) return pin.snapshot.ref.sourceIds;
  const [previous] = await ex.select({ context: messages.context }).from(messages)
    .where(and(eq(messages.userId, userId), eq(messages.conversationId, conversationId), eq(messages.role, 'user')))
    .orderBy(desc(messages.createdAt), desc(messages.id)).limit(1);
  if (previous?.context) return previous.context.sourceIds;
  if (previous) throw new AssistantContextError('context_selection_required');
  return undefined; // A new legacy conversation starts with the notebook's default scope.
}
