import { createHash } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@reomi/db';
import { ASSISTANT_OBJECT_KINDS, AssistantContextError, parseAssistantRef, type AssistantObjectKind, type AssistantObjectRef, type AssistantObjectSnapshot } from '@reomi/shared';
import { resolveAssistantRefs } from './assistant-context';

export interface AssistantSearchQuery {
  q?: string; type?: string; parentKind?: string; parentId?: string; limit?: number; cursor?: string;
}
interface SearchRow extends Record<string, unknown> {
  kind: AssistantObjectKind; id: string; object_id: string; label: string; sort_key: string;
  parent_kind: AssistantObjectKind | null; parent_id: string | null; parent_label: string | null;
  position: number | null; page: number | null;
}

const emptyParent = sql`NULL::text AS parent_kind, NULL::uuid AS parent_id, NULL::text AS parent_label`;
const noLocation = sql`NULL::integer AS position, NULL::integer AS page`;
const normalizedLabel = (value: SQL) => sql`trim(regexp_replace(COALESCE(${value}, ''), '\\s+', ' ', 'g'))`;

/** One bounded owner-scoped SQL query; no local card mirror or embeddings. */
export async function searchAssistantObjects(userId: string, query: AssistantSearchQuery) {
  const q = (query.q ?? '').trim();
  const kinds = ASSISTANT_OBJECT_KINDS as readonly string[];
  if (q.length > 200 || (query.type && !kinds.includes(query.type))
    || Boolean(query.parentKind) !== Boolean(query.parentId)
    || (query.parentKind && !['source', 'deck', 'notebook', 'note_type'].includes(query.parentKind))) throw new AssistantContextError('invalid_context_search');
  if (query.type === 'source_passage' && query.parentKind !== 'source') throw new AssistantContextError('source_parent_required');
  const limit = query.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new AssistantContextError('invalid_limit');
  let parent: AssistantObjectSnapshot | undefined;
  if (query.parentId && query.parentKind) {
    const ref = parseAssistantRef({ kind: query.parentKind, id: query.parentId });
    try { [parent] = await resolveAssistantRefs(userId, [ref]); }
    catch (error) { if (error instanceof AssistantContextError) throw new AssistantContextError('not_found'); throw error; }
  }
  const signature = createHash('sha256').update(JSON.stringify([userId, q, query.type ?? null, query.parentKind ?? null, query.parentId ?? null])).digest('hex');
  let cursor: { key: string; kind: AssistantObjectKind; id: string } | undefined;
  if (query.cursor) {
    try {
      if (query.cursor.length > 2048) throw new Error();
      const decoded = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
      if (decoded.v !== 1 || decoded.signature !== signature || typeof decoded.key !== 'string' || decoded.key.length > 400 || !kinds.includes(decoded.kind)) throw new Error();
      parseAssistantRef({ kind: 'card', id: decoded.id });
      cursor = decoded;
    } catch { throw new AssistantContextError('invalid_cursor'); }
  }
  const branches: Partial<Record<AssistantObjectKind, SQL>> = {
    card: sql`SELECT 'card'::text AS kind, c.id, c.id AS object_id, ${normalizedLabel(sql`NULLIF(c.render_front_text, '')`)} AS label,
      'deck'::text AS parent_kind, d.id AS parent_id, ${normalizedLabel(sql`d.name`)} AS parent_label, ${noLocation}
      FROM cards c JOIN decks d ON d.id=c.deck_id AND d.user_id=${userId} WHERE c.user_id=${userId}`,
    deck: sql`SELECT 'deck'::text AS kind, d.id, d.id AS object_id, ${normalizedLabel(sql`d.name`)} AS label,
      CASE WHEN p.id IS NOT NULL THEN 'deck'::text END AS parent_kind, p.id AS parent_id, ${normalizedLabel(sql`p.name`)} AS parent_label, ${noLocation}
      FROM decks d LEFT JOIN decks p ON p.id=d.parent_id AND p.user_id=${userId} WHERE d.user_id=${userId}`,
    notebook: sql`SELECT 'notebook'::text AS kind, n.id, n.id AS object_id, ${normalizedLabel(sql`n.title`)} AS label, ${emptyParent}, ${noLocation} FROM notebooks n WHERE n.user_id=${userId}`,
    source: sql`SELECT 'source'::text AS kind, s.id, s.id AS object_id, ${normalizedLabel(sql`s.title`)} AS label,
      ${query.parentKind === 'notebook' ? sql`'notebook'::text AS parent_kind, ${query.parentId}::uuid AS parent_id, ${parent?.label ?? ''}::text AS parent_label` : emptyParent}, ${noLocation}
      FROM sources s WHERE s.user_id=${userId} ${query.parentKind === 'notebook' ? sql`AND EXISTS (SELECT 1 FROM notebook_sources ns WHERE ns.user_id=${userId} AND ns.notebook_id=${query.parentId}::uuid AND ns.source_id=s.id)` : sql``}`,
    written_note: sql`SELECT 'written_note'::text AS kind, n.id, n.id AS object_id, ${normalizedLabel(sql`n.title`)} AS label,
      CASE WHEN n.owner_kind='source' THEN 'source' ELSE 'notebook' END::text AS parent_kind,
      COALESCE(n.source_origin_id,nb.id) AS parent_id, ${normalizedLabel(sql`COALESCE(n.source_origin_title,nb.title)`)} AS parent_label, ${noLocation}
      FROM notebook_notes n LEFT JOIN notebooks nb ON nb.id=n.notebook_id AND nb.user_id=${userId}
      WHERE n.user_id=${userId} AND (n.owner_kind='source' OR nb.id IS NOT NULL)`,
    artifact: sql`SELECT 'artifact'::text AS kind, a.id, a.id AS object_id, ${normalizedLabel(sql`a.title`)} AS label,
      CASE WHEN a.owner_kind='source' THEN 'source' ELSE 'notebook' END::text AS parent_kind,
      COALESCE(a.source_origin_id,nb.id) AS parent_id, ${normalizedLabel(sql`COALESCE(a.source_origin_title,nb.title)`)} AS parent_label, ${noLocation}
      FROM notebook_artifacts a LEFT JOIN notebooks nb ON nb.id=a.notebook_id AND nb.user_id=${userId}
      WHERE a.user_id=${userId} AND (a.owner_kind='source' OR nb.id IS NOT NULL)`,
    note_type: sql`SELECT 'note_type'::text AS kind, nt.id, nt.id AS object_id, ${normalizedLabel(sql`nt.name`)} AS label, ${emptyParent}, ${noLocation}
      FROM note_types nt WHERE nt.user_id=${userId} OR (nt.user_id IS NULL AND nt.is_builtin=true)`,
    flashcard_note: sql`SELECT 'flashcard_note'::text AS kind, n.id, n.id AS object_id, ${normalizedLabel(sql`COALESCE(n.field_values ->> (nt.fields->0->>'name'), 'Note')`)} AS label,
      'note_type'::text AS parent_kind, nt.id AS parent_id, ${normalizedLabel(sql`nt.name`)} AS parent_label, ${noLocation}
      FROM notes n JOIN note_types nt ON nt.id=n.note_type_id AND (nt.user_id=${userId} OR (nt.user_id IS NULL AND nt.is_builtin=true)) WHERE n.user_id=${userId}`,
    conversation: sql`SELECT 'conversation'::text AS kind, c.id, c.id AS object_id, ${normalizedLabel(sql`COALESCE(c.title, 'Conversation')`)} AS label,
      CASE WHEN nb.id IS NOT NULL THEN 'notebook'::text END AS parent_kind, nb.id AS parent_id, ${normalizedLabel(sql`nb.title`)} AS parent_label, ${noLocation}
      FROM conversations c LEFT JOIN notebooks nb ON nb.id=c.notebook_id AND nb.user_id=${userId} WHERE c.user_id=${userId}`,
  };
  if (query.parentKind === 'source') branches.source_passage = sql`SELECT 'source_passage'::text AS kind, ch.id, s.id AS object_id,
    ${normalizedLabel(sql`COALESCE(NULLIF(ch.heading, ''), 'Section ' || (ch.position+1)::text)`)} AS label,
    'source'::text AS parent_kind, s.id AS parent_id, ${normalizedLabel(sql`s.title`)} AS parent_label, ch.position, ch.page
    FROM source_chunks ch JOIN sources s ON s.id=ch.source_id AND s.user_id=${userId}
    WHERE ch.user_id=${userId} AND ch.source_id=${query.parentId}::uuid`;
  const selected = query.type ? [branches[query.type as AssistantObjectKind]!] : Object.values(branches);
  const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const rows = await db.execute<SearchRow>(sql`SELECT * FROM (
    SELECT kind,id,object_id,left(label,200) AS label,parent_kind,parent_id,left(parent_label,200) AS parent_label,position,page,
      lower(left(label,200)) COLLATE "C" AS sort_key FROM (${sql.join(selected, sql` UNION ALL `)}) objects
    WHERE ${q ? sql`label ILIKE ${pattern}` : sql`true`}
      ${parent ? sql`AND parent_kind=${query.parentKind} AND parent_id=${query.parentId}::uuid` : sql``}
  ) candidates ${cursor ? sql`WHERE (sort_key,kind COLLATE "C",id) > (${cursor.key} COLLATE "C",${cursor.kind} COLLATE "C",${cursor.id}::uuid)` : sql``}
  ORDER BY sort_key,kind COLLATE "C",id LIMIT ${limit + 1}`);
  const page = rows.slice(0, limit);
  const items: AssistantObjectSnapshot[] = page.map(row => {
    const ref: AssistantObjectRef = row.kind === 'source_passage' ? { kind: row.kind, id: row.object_id,
      locator: { chunkId: row.id, ...(row.position !== null ? { position: row.position } : {}), ...(row.page !== null ? { page: row.page } : {}) },
    } : { kind: row.kind, id: row.object_id };
    return { ref, label: row.label, available: true, href: assistantSearchHref(ref, row.parent_id, row.parent_kind),
      ...(row.parent_kind && row.parent_id ? { parent: { kind: row.parent_kind, id: row.parent_id, label: row.parent_label ?? '' } } : {}),
    };
  });
  const last = page.at(-1);
  return { items, nextCursor: rows.length > limit && last
    ? Buffer.from(JSON.stringify({ v: 1, signature, key: last.sort_key, kind: last.kind, id: last.id })).toString('base64url') : null };
}

function assistantSearchHref(ref: AssistantObjectRef, parentId: string | null, parentKind?: string | null): string {
  switch (ref.kind) {
    case 'card': return `/cards?focus=${ref.id}`;
    case 'deck': return `/decks?focus=${ref.id}`;
    case 'source': return `/library/${ref.id}`;
    case 'source_passage': return `/library/${ref.id}?chunk=${ref.locator.chunkId}`;
    case 'notebook': return `/notebooks/${ref.id}`;
    case 'written_note': return parentKind === 'source' ? `/library/study?note=${ref.id}` : `/notebooks/${parentId}?note=${ref.id}`;
    case 'artifact': return parentKind === 'source' ? `/library/study?artifact=${ref.id}` : `/notebooks/${parentId}?artifact=${ref.id}`;
    case 'note_type': return `/note-types?edit=${ref.id}`;
    case 'flashcard_note': return `/editor?noteId=${ref.id}`;
    case 'conversation': return `/chat?thread=${ref.id}`;
  }
}
