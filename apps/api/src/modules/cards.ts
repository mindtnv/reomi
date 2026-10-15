import { Elysia, t } from 'elysia';
import { and, asc, desc, eq, gt, inArray, lt, lte, ne, or, sql } from 'drizzle-orm';
import {
  cardSources,
  cards,
  db,
  deckOptionsPreset,
  decks,
  filteredDeck,
  notebooks,
  noteTypes,
  notes,
  profile,
  sourceChunks,
  sources,
  type Db,
} from '@reomi/db';
import {
  parseCardQuery,
  CardQueryError,
  fsrsResetColumns,
  type CardQueryNode,
} from '@reomi/shared';
import { authPlugin } from '../auth-plugin.ts';
import { cardEvidenceFingerprint } from '../ai/card-evidence';
import { internalReadDeckScope } from '../mcp/internal-read.ts';
import { buildCardWhere } from './card-query-sql.ts';
import { SORT_ORDERS, type SortOrder } from './filtered-decks.ts';
import { allocateStudyScope, loadStudyCounts, loadStudyOverview } from './study-summary.ts';
import { loadDeckSpend } from './deck-budget.ts';
import { readAccountStudyDay, studyDaySnapshot } from './study-day.ts';

export const MAX_STUDY_QUEUE = 500;

// ── Card read-payload enrichment (M1 Phase 5a) ────────────────────────────────
//
// The web review/browser screens render display HTML lazily from the note's
// lossless Markdown field values + the note-type template (then DOMPurify in the
// browser). They consume CARD payloads, so the card read endpoints must embed,
// per card, the minimal render descriptor:
//   note:     { id, fieldValues, tags }
//   noteType: { id, name, kind, templates, styling }
// Field values are untrusted source. The client parses with html:false and
// always DOMPurifies the rendered output. Plaintext render* columns stay on
// the card row for SQL search + the browser table (no client render there).

type CardRow = typeof cards.$inferSelect;
type EnrichedCard = CardRow & {
  note: { id: string; fieldValues: Record<string, string>; acceptedAnswers: string[]; tags: string[]; updatedAt?: Date } | null;
  noteType: {
    id: string;
    updatedAt?: Date;
    name: string;
    kind: string;
    fields: (typeof noteTypes.$inferSelect)['fields'];
    templates: (typeof noteTypes.$inferSelect)['templates'];
    styling: string;
  } | null;
};

/**
 * Attach `note` + `noteType` to a list of card rows in TWO batched queries
 * (notes by id, then note-types by id). Returns the same rows in the same order
 * with the embedded descriptors merged in — the card columns stay top-level so
 * existing consumers (cursor logic, tests) are untouched.
 */
export async function enrichCards(rows: CardRow[], executor: Pick<typeof db, 'select'> = db): Promise<EnrichedCard[]> {
  if (rows.length === 0) return [];
  const noteIds = [...new Set(rows.map((r) => r.noteId))];
  const noteRows = await executor
    .select({
      id: notes.id,
      fieldValues: notes.fieldValues,
      acceptedAnswers: notes.acceptedAnswers,
      tags: notes.tags,
      noteTypeId: notes.noteTypeId,
      updatedAt: notes.updatedAt,
    })
    .from(notes)
    .where(inArray(notes.id, noteIds));
  const noteById = new Map(noteRows.map((n) => [n.id, n]));

  const noteTypeIds = [...new Set(noteRows.map((n) => n.noteTypeId))];
  const noteTypeRows =
    noteTypeIds.length > 0
      ? await executor
          .select({
            id: noteTypes.id,
            name: noteTypes.name,
            kind: noteTypes.kind,
            templates: noteTypes.templates,
            fields: noteTypes.fields,
            styling: noteTypes.styling,
            updatedAt: noteTypes.updatedAt,
          })
          .from(noteTypes)
          .where(inArray(noteTypes.id, noteTypeIds))
      : [];
  const noteTypeById = new Map(noteTypeRows.map((nt) => [nt.id, nt]));

  return rows.map((row) => {
    const note = noteById.get(row.noteId);
    const noteType = note ? noteTypeById.get(note.noteTypeId) : undefined;
    return {
      ...row,
      note: note
        ? { id: note.id, fieldValues: note.fieldValues, acceptedAnswers: note.acceptedAnswers, tags: note.tags, updatedAt: note.updatedAt }
        : null,
      noteType: noteType
        ? {
            id: noteType.id,
            updatedAt: noteType.updatedAt,
            name: noteType.name,
            kind: noteType.kind,
            templates: noteType.templates,
            fields: noteType.fields,
            styling: noteType.styling,
          }
        : null,
    };
  });
}

// Pagination defaults for GET /cards. The hard ceiling protects us against
// a client asking for everything at once on a 10k-card account.
const DEFAULT_CARDS_PAGE = 500;
const MAX_CARDS_PAGE = 1000;

type CardsCursor = { createdAt: Date; id: string | null };

function parseCardsCursor(raw: string): CardsCursor | null {
  const separator = raw.lastIndexOf('_');
  const timestamp = separator === -1 ? raw : raw.slice(0, separator);
  const id = separator === -1 ? null : raw.slice(separator + 1);
  const createdAt = new Date(timestamp);
  if (Number.isNaN(createdAt.getTime())) return null;
  if (id !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    return null;
  }
  return { createdAt, id };
}

// ── /cards/search sort + tuple-keyset cursor helpers ──────────────────────────

// Sort allowlist (Architect must-fix #3): `<field> <dir>` validated against
// these maps; anything else → 400. Default `created desc`.
const SORT_COLUMNS = {
  created: cards.createdAt,
  updated: cards.updatedAt,
  due: cards.due,
  lapses: cards.lapses,
  reps: cards.reps,
  // `sort:front` is kept (C-7) but now targets the denormalized rendered front
  // plaintext column (content lives on notes, the search cache on cards).
  front: cards.renderFrontText,
} as const;
type SortField = keyof typeof SORT_COLUMNS;
const SORT_FIELDS = new Set<string>(Object.keys(SORT_COLUMNS));

/**
 * Parse a `sort` query value like `"lapses desc"` (space or `:` separated) into
 * `{ field, dir }`, or `null` when it is off the allowlist. Missing `sort`
 * defaults to `created desc`.
 */
export function parseSort(raw: string | undefined): { field: SortField; dir: 'asc' | 'desc' } | null {
  if (!raw) return { field: 'created', dir: 'desc' };
  const [fieldRaw, dirRaw = 'desc'] = raw.trim().split(/[\s:]+/);
  const field = (fieldRaw ?? '').toLowerCase();
  const dir = dirRaw.toLowerCase();
  if (!SORT_FIELDS.has(field)) return null;
  if (dir !== 'asc' && dir !== 'desc') return null;
  return { field: field as SortField, dir };
}

interface CursorPayload {
  v: string | number;
  id: string;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function decodeCursor(raw: string): CursorPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.id === 'string' &&
      (typeof parsed.v === 'string' || typeof parsed.v === 'number')
    ) {
      return parsed as CursorPayload;
    }
  } catch {
    // malformed cursor → ignore (treated as no cursor)
  }
  return null;
}

/** Serialize the sort field's value from a row for the cursor (ISO for dates). */
function encodeSortValue(field: SortField, row: typeof cards.$inferSelect): string | number {
  switch (field) {
    case 'created':
      return row.createdAt.toISOString();
    case 'updated':
      return row.updatedAt.toISOString();
    case 'due':
      return row.due.toISOString();
    case 'lapses':
      return row.lapses;
    case 'reps':
      return row.reps;
    case 'front':
      return row.renderFrontText;
  }
}

/**
 * Inverse of encodeSortValue: turn the cursor `v` back into a comparable.
 * Returns `null` when the value can't be decoded (e.g. a crafted cursor whose
 * date is unparseable) so the caller degrades to "no cursor" instead of 500ing —
 * consistent with decodeCursor's try/catch contract.
 */
function decodeSortValue(field: SortField, v: string | number): Date | number | string | null {
  switch (field) {
    case 'created':
    case 'updated':
    case 'due': {
      const d = new Date(v as string);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    case 'lapses':
    case 'reps':
      return Number(v);
    case 'front':
      return String(v);
  }
}

type DeckRow = { id: string; parentId: string | null; name: string };

/**
 * Recursively collect the ids of every descendant of `deckId` over `userDecks`
 * (the subtree, NOT including `deckId` itself). Cycle-safe via a `seen` set so a
 * malformed parent loop can't infinitely recurse. Mirrors
 * lib/decks.ts:getDescendantIds — kept server-side so both the deck-name
 * resolver (`makeDeckResolver`) and the regular `/queue` subtree aggregation
 * share ONE implementation.
 */
export function descendantIds(deckId: string, userDecks: DeckRow[], seen = new Set<string>()): string[] {
  if (seen.has(deckId)) return [];
  seen.add(deckId);
  const children = userDecks.filter((d) => d.parentId === deckId).map((d) => d.id);
  return children.flatMap((id) => [id, ...descendantIds(id, userDecks, seen)]);
}

/**
 * Build a `resolveDeckIds(value, nested)` closure over the user's decks. Plain
 * `deck:` resolves to the named deck plus its whole subtree (descendants), which
 * matches the client predicate's behavior and AC7. A deck matches when its name
 * OR its full path label (e.g. `"Parent / Child"`) equals the target — both
 * compared case-INSENSITIVELY, identical to the client `resolveDeckIds` +
 * `deckPathLabel` in cards-browser.tsx. Replicates lib/decks.ts:getDescendantIds
 * and deckPathLabel server-side so the SQL builder stays deck-table-agnostic.
 */
function makeDeckResolver(userDecks: DeckRow[]): (value: string, nested: boolean) => string[] {
  const byId = new Map(userDecks.map((d) => [d.id, d]));
  const descendantsOf = (deckId: string): string[] => descendantIds(deckId, userDecks);
  // Full root→deck path label, joined ` / ` — mirrors lib/decks.ts:deckPathLabel
  // (with the same cycle guard).
  const pathLabel = (deckId: string): string => {
    const names: string[] = [];
    const seen = new Set<string>();
    let current = byId.get(deckId);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      names.unshift(current.name);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return names.join(' / ');
  };
  return (value: string, nested: boolean): string[] => {
    const lower = value.toLowerCase();
    const matches = userDecks.filter(
      (d) => d.name.toLowerCase() === lower || pathLabel(d.id).toLowerCase() === lower,
    );
    if (matches.length === 0) return [];
    const ids = new Set<string>();
    for (const m of matches) {
      ids.add(m.id);
      if (nested) for (const id of descendantsOf(m.id)) ids.add(id);
    }
    return [...ids];
  };
}

// ── Extracted /cards/search query execution (reused by the agent browse tool) ─
//
// The Anki-grammar query builder + tuple-keyset pagination that the GET
// /cards/search route runs is hoisted here so the `browse_cards` agent tool
// (apps/api/src/ai/tools.ts) executes the EXACT same path — never reimplementing
// the parser (`parseCardQuery` → `buildCardWhere`), the `SORT_COLUMNS` allowlist,
// the `deck:`→subtree resolver, or the `(sortValue, id)` keyset cursor. The route
// handler calls this verbatim, so its responses are byte-identical (the route
// keeps its own 400 guards on `parseCardQuery`/`parseSort` + the enrich step).

export interface SearchCardsInput {
  userId: string;
  /** Parsed query AST (the route parses + 400s on CardQueryError before calling). */
  ast: CardQueryNode;
  /** Validated sort field + direction (the route 400s on a bad sort before calling). */
  sortField: SortField;
  dir: 'asc' | 'desc';
  /** Page size — the route clamps to [1, MAX_CARDS_PAGE] before calling. */
  limit: number;
  /** Per-request clock (Critic C2) — never SQL now(). */
  now: Date;
  /** Optional opaque tuple-keyset cursor (base64). */
  cursor?: string;
  /**
   * Optional deck-id scope ANDed onto the query (the `browse_cards` tool resolves
   * a `deckId` to `[deckId, ...descendants]` and passes it here). An EMPTY array
   * forces a no-match (a foreign/un-owned deck yields no cards, NOT a global
   * fallback) — mirroring the `deck:` resolver. `undefined` ⇒ no deck filter (the
   * route's behavior, unchanged).
   */
  deckScope?: string[];
  noteTypeId?: string;
}

/**
 * Run the user-scoped `/cards/search` query: translate the AST to a WHERE
 * (`buildCardWhere`, which ANDs `user_id` as the first conjunct), apply the
 * tuple-keyset cursor predicate over `(sortColumn, id)`, order + limit, and
 * compute the next cursor. Returns the RAW card rows (the caller enriches or
 * renders compactly). `userDecks` is loaded inside so a single call wires the
 * `deck:`/subtree resolver — identical to the route's setup.
 */
export async function searchCardsQuery(
  input: SearchCardsInput,
): Promise<{ rows: (typeof cards.$inferSelect)[]; nextCursor: string | null }> {
  const { userId, ast, sortField, dir, limit, now } = input;

  // Load the user's decks once for deck-name → id (subtree) resolution.
  const userDecks = await db
    .select({ id: decks.id, parentId: decks.parentId, name: decks.name })
    .from(decks)
    .where(eq(decks.userId, userId));
  const resolveDeckIds = makeDeckResolver(userDecks);

  const where = buildCardWhere(ast, { userId, now, resolveDeckIds });

  // Tuple-keyset cursor predicate.
  const col = SORT_COLUMNS[sortField];
  const cmp = dir === 'asc' ? gt : lt;
  const conditions = [where];
  if (input.noteTypeId) conditions.push(inArray(cards.noteId, db.select({ id: notes.id }).from(notes).where(and(eq(notes.userId, userId), eq(notes.noteTypeId, input.noteTypeId)))));
  // Optional deck-id scope (browse_cards). An empty array → match nothing (a
  // foreign deck is empty, not global); a populated array → deck-id membership.
  if (input.deckScope !== undefined) {
    conditions.push(input.deckScope.length === 0 ? sql`false` : inArray(cards.deckId, input.deckScope));
  }
  if (input.cursor) {
    const decoded = decodeCursor(input.cursor);
    if (decoded) {
      const v = decodeSortValue(sortField, decoded.v);
      // A cursor whose sort value is unparseable (crafted/invalid date) → drop
      // it rather than throw. decodeSortValue returns null in that case.
      if (v !== null) {
        conditions.push(or(cmp(col, v), and(eq(col, v), cmp(cards.id, decoded.id)))!);
      }
    }
  }

  const order = dir === 'asc' ? asc : desc;
  const rows = await db
    .select()
    .from(cards)
    .where(and(...conditions))
    .orderBy(order(col), order(cards.id))
    .limit(limit);

  let nextCursor: string | null = null;
  if (rows.length === limit) {
    const last = rows[rows.length - 1]!;
    nextCursor = encodeCursor({ v: encodeSortValue(sortField, last), id: last.id });
  }
  return { rows, nextCursor };
}

// ── Extracted card-content + deck-listing helpers (reused by the agent tools) ─
//
// `cardContent` wraps the GET /cards/:id load (single card, user-scoped, enriched
// with note + noteType) so the `get_card` agent tool returns content WITHOUT
// reimplementing the load. `listDecksWithCounts` is a small user-scoped GROUP BY
// over `cards` joined onto the deck tree — the data behind the `list_decks` tool.

export type CardContent = EnrichedCard;

/** Load one user-scoped card enriched with note + noteType, or null if foreign/missing. */
export async function cardContent(userId: string, cardId: string): Promise<CardContent | null> {
  const [row] = await db
    .select()
    .from(cards)
    .where(and(eq(cards.id, cardId), eq(cards.userId, userId)))
    .limit(1);
  if (!row) return null;
  const [enriched] = await enrichCards([row]);
  return enriched ?? null;
}

export interface DeckWithCounts {
  id: string;
  name: string;
  parentId: string | null;
  total: number;
  due: number;
}

/**
 * The user's deck tree with per-deck (NON-aggregated) card counts: `total` =
 * cards whose `deck_id` is exactly this deck, `due` = those with `due <= now` and
 * not suspended. `user_id` is the mandatory first conjunct on BOTH selects. The
 * count query is a single GROUP BY over the user's own cards; decks with zero
 * cards still appear (left-merged onto the deck list).
 */
export async function listDecksWithCounts(userId: string, now: Date): Promise<DeckWithCounts[]> {
  const deckRows = await db
    .select({ id: decks.id, name: decks.name, parentId: decks.parentId })
    .from(decks)
    .where(eq(decks.userId, userId));

  const nowIso = now.toISOString();
  const countRows = await db
    .select({
      deckId: cards.deckId,
      total: sql<number>`count(*)::int`,
      due: sql<number>`sum(CASE WHEN ${cards.suspended} = false AND ${cards.due} <= ${nowIso}::timestamptz THEN 1 ELSE 0 END)::int`,
    })
    .from(cards)
    .where(eq(cards.userId, userId))
    .groupBy(cards.deckId);
  const byDeck = new Map(countRows.map((r) => [r.deckId, r]));

  return deckRows.map((d) => {
    const c = byDeck.get(d.id);
    return {
      id: d.id,
      name: d.name,
      parentId: d.parentId,
      total: c ? Number(c.total) : 0,
      due: c ? Number(c.due) : 0,
    };
  });
}

// ── Extracted, reuse-by-the-agentic-SRS/edit tools helper (Phase B) ──────────
//
// Hoists the PATCH /cards/:id explicit-field map + guards (forget/setDue mutual
// exclusion, ISO-date validation, deck-ownership, suspend) out of the route body
// so the `suspend`/`set_due`/`forget` SRS tools and `edit_card`'s deck-move path
// (apps/api/src/ai/tools.ts) wrap the EXACT same path — never reimplementing the
// FSRS reset (`fsrsResetColumns`) or the explicit-field map (cards.ts:735). The
// route handler calls this verbatim, so its behavior is unchanged.

/** Patchable card-control fields — identical surface to the PATCH route body. */
export interface CardPatch {
  deckId?: string;
  suspended?: boolean;
  forget?: boolean;
  setDue?: string;
}

export type CardPatchResult =
  | { ok: true; card: typeof cards.$inferSelect }
  | {
      ok: false;
      code: 400 | 404;
      error: 'forget_and_setdue_exclusive' | 'deck_not_found' | 'invalid_date' | 'not_found';
    };

/**
 * Apply a card-control patch (deck-move / suspend / forget / setDue), scoped by
 * `userId`. Mirrors the PATCH /cards/:id route guards exactly (mutual exclusion
 * 400, deck-ownership 400, invalid-date 400, not-found 404). Control fields are
 * mapped EXPLICITLY (no body spread) so a stray key can never reach a column.
 */
export async function patchCard(
  userId: string,
  cardId: string,
  body: CardPatch,
  executor: Pick<Db, 'select' | 'update'> = db,
): Promise<CardPatchResult> {
  if (body.forget === true && body.setDue !== undefined) {
    return { ok: false, code: 400, error: 'forget_and_setdue_exclusive' };
  }

  const patch: Record<string, unknown> = {
    updatedAt: sql`greatest(${cards.updatedAt} + interval '1 millisecond', ${new Date().toISOString()}::timestamptz)`,
  };

  // If moving the card to a different deck, verify ownership of the target deck.
  if (body.deckId !== undefined) {
    const deck = await executor
      .select({ id: decks.id })
      .from(decks)
      .where(and(eq(decks.id, body.deckId), eq(decks.userId, userId)))
      .limit(1);
    if (deck.length === 0) return { ok: false, code: 400, error: 'deck_not_found' };
    patch.deckId = body.deckId;
  }

  if (body.suspended !== undefined) patch.suspended = body.suspended;

  if (body.forget === true) {
    // Reuse the shared FSRS defaults — no hard-coded magic. Resets state to
    // "new" with zeroed reps/lapses, due=now, lastReview=null.
    Object.assign(patch, fsrsResetColumns());
  }

  if (body.setDue !== undefined) {
    const d = new Date(body.setDue);
    if (Number.isNaN(d.getTime())) return { ok: false, code: 400, error: 'invalid_date' };
    patch.due = d;
  }

  const [updated] = await executor
    .update(cards)
    .set(patch)
    .where(and(eq(cards.id, cardId), eq(cards.userId, userId)))
    .returning();
  if (!updated) return { ok: false, code: 404, error: 'not_found' };
  return { ok: true, card: updated };
}

export const cardsModule = new Elysia({ prefix: '/cards' })
  .use(authPlugin)
  .get('/study-summary', ({ user }) => loadStudyOverview(user.id), { auth: true })
  // List cards. Cursor-paginated: ordered by `(created_at, id) DESC`, cursor is
  // `<ISO createdAt>_<id>` for the last item you saw. Legacy bare-ISO cursors
  // remain accepted during the transition.
  //
  //   GET /cards                 → first page (500 most recent, suspended excluded)
  //   GET /cards?limit=200       → smaller page
  //   GET /cards?cursor=<tuple>  → next page after that exact card
  //   GET /cards?includeSuspended=true  → include suspended
  //   GET /cards?due=true        → only what's currently due (ad-hoc filter;
  //                                the full scheduler queue lives under /cards/queue)
  //
  // Response: `{ items, nextCursor }`. `nextCursor` is null when the page was
  // shorter than the requested limit.
  .get(
    '/',
    async ({ user, query, request }) => {
      const rawLimit = Number(query.limit ?? DEFAULT_CARDS_PAGE);
      const limit = Math.max(
        1,
        Math.min(MAX_CARDS_PAGE, Number.isFinite(rawLimit) ? rawLimit : DEFAULT_CARDS_PAGE),
      );
      const conditions = [eq(cards.userId, user.id)];
      const allowed = internalReadDeckScope(request);
      if (allowed !== undefined) conditions.push(allowed.length ? inArray(cards.deckId, [...allowed]) : sql`false`);
      if (query.deckId) conditions.push(eq(cards.deckId, query.deckId));
      if (query.noteTypeId) conditions.push(inArray(cards.noteId,
        db.select({ id: notes.id }).from(notes).where(and(eq(notes.userId, user.id), eq(notes.noteTypeId, query.noteTypeId)))));
      if (query.due === 'true') conditions.push(lte(cards.due, new Date()));
      if (query.includeSuspended !== 'true') conditions.push(eq(cards.suspended, false));
      if (query.cursor) {
        const cursor = parseCardsCursor(query.cursor);
        if (cursor) {
          conditions.push(
            cursor.id
              ? or(
                  lt(cards.createdAt, cursor.createdAt),
                  and(eq(cards.createdAt, cursor.createdAt), lt(cards.id, cursor.id)),
                )!
              : lt(cards.createdAt, cursor.createdAt),
          );
        }
      }
      const rows = await db
        .select()
        .from(cards)
        .where(and(...conditions))
        .orderBy(desc(cards.createdAt), desc(cards.id))
        .limit(limit);
      const nextCursor =
        rows.length === limit
          ? `${rows[rows.length - 1]!.createdAt.toISOString()}_${rows[rows.length - 1]!.id}`
          : null;
      return { items: await enrichCards(rows), nextCursor };
    },
    {
      auth: true,
      query: t.Object({
        deckId: t.Optional(t.String({ format: 'uuid' })),
        noteTypeId: t.Optional(t.String({ format: 'uuid' })),
        due: t.Optional(t.String()),
        includeSuspended: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        cursor: t.Optional(t.String()),
      }),
    },
  )
  // Bounded read-only refresh of already-loaded cards, including suspended rows.
  .post('/lookup', async ({ user, body }) => {
    if (!body.ids.length) return { items: [] };
    const rows = await db.select().from(cards).where(and(eq(cards.userId, user.id), inArray(cards.id, [...new Set(body.ids)])));
    return { items: await enrichCards(rows) };
  }, { auth: true, body: t.Object({ ids: t.Array(t.String({ format: 'uuid' }), { maxItems: 200 }) }) })
  // Today's review queue (M3 Phase 4 — REGULAR paths). Returns, in order:
  //   1. Due cards (state != new, due <= now), ordered by earliest due first
  //   2. New cards
  // Both lists respect `suspended = false`. Callers render the concatenation.
  //
  // Each deck's nearest preset (or the 20/200 default) caps that deck, and
  // every ancestor caps it again. Study-all is the sum of those trees. Spend
  // is the reviews committed in the open study epoch, so sibling presets do
  // not share one counter. Explicit `newLimit`/`reviewLimit` query params
  // clamp this response from the tail of that gather order. Learning steps
  // stay outside the review cap. Envelope carries `mode: 'regular'`.
  .get(
    '/queue',
    async ({ user, query, status, request }) => {
      if (query.deckId && query.filteredDeckId) return status(400, { error: 'invalid_scope' });
      for (const value of [query.newLimit, query.reviewLimit]) {
        if (value !== undefined && (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))) {
          return status(400, { error: 'invalid_limit' });
        }
      }
      // ── Filtered branch (M3 Phase 7, `?filteredDeckId=`, Decision 4/5/7) ──────
      //
      // An EARLY return ABOVE the regular logic: load the saved filtered-deck row
      // (user-scoped, 404 if foreign), re-run its query via the shared SQL builder
      // (verbatim, no edit), apply the sortOrder enum as an OUTER `.orderBy()` +
      // `.limit(row.cardLimit)`, and return EVERYTHING under the `due` key so the
      // reviewer's `[...due, ...new]` stays single-path. `mode: 'filtered'`.
      if (query.filteredDeckId) {
        const now = new Date();
        const [row] = await db
          .select()
          .from(filteredDeck)
          .where(
            and(eq(filteredDeck.id, query.filteredDeckId), eq(filteredDeck.userId, user.id)),
          )
          .limit(1);
        if (!row) return status(404, { error: 'not_found' });

        // Defensive: POST/PATCH already validate, but a malformed stored query
        // shouldn't 500 — surface a clear 400.
        let ast;
        try {
          ast = parseCardQuery(row.query);
        } catch (err) {
          if (err instanceof CardQueryError) return status(400, { error: 'bad_query' });
          throw err;
        }

        // Reuse the same deck-name resolver setup the /cards/search handler uses.
        const fUserDecks = await db
          .select({ id: decks.id, parentId: decks.parentId, name: decks.name })
          .from(decks)
          .where(eq(decks.userId, user.id));
        const resolveDeckIds = makeDeckResolver(fUserDecks);
        const where = buildCardWhere(ast, { userId: user.id, now, resolveDeckIds });

        const sortOrder = (SORT_ORDERS as readonly string[]).includes(row.sortOrder)
          ? (row.sortOrder as SortOrder)
          : 'due';

        // WHERE: query predicate AND (suspended gate unless includeSuspended) AND
        // (an `overdue` due-gate when sortOrder === 'overdue'). `cram` intentionally
        // drops the due-gate (Decision 5 — future-due cards are returned).
        // Suspended cards cannot be graded. Keep legacy saved-filter fields
        // readable, but never build an impossible-to-complete study session.
        const conditions = [where, eq(cards.suspended, false)];
        if (sortOrder === 'overdue') conditions.push(lte(cards.due, now));

        const orderBy =
          sortOrder === 'added'
            ? desc(cards.createdAt)
            : sortOrder === 'random'
              ? sql`random()`
              : sortOrder === 'difficultyDesc'
                ? desc(cards.difficulty)
                : sortOrder === 'lapses'
                  ? desc(cards.lapses)
                  : // 'due' | 'overdue' | 'cram' all order by due ASC
                    asc(cards.due);

        const sessionRows = await db
          .select()
          .from(cards)
          .where(and(...conditions))
          .orderBy(orderBy, asc(cards.id))
          .limit(Math.min(row.cardLimit, 1000));

        const sessionCards = await enrichCards(sessionRows);
        return {
          due: sessionCards,
          new: [] as typeof sessionCards,
          total: sessionCards.length,
          mode: 'filtered' as const,
        };
      }

      const deckId = query.deckId;
      const now = new Date();

      // Snapshot for the resolver (Principle 1): the user's decks, presets, and
      // profile — a few cheap selects, mirroring the grade handler's batch.
      const userDecks = await db.select().from(decks).where(eq(decks.userId, user.id));
      if (deckId && !userDecks.some((deck) => deck.id === deckId)) {
        return status(404, { error: 'deck_not_found' });
      }
      const userPresets = await db
        .select()
        .from(deckOptionsPreset)
        .where(eq(deckOptionsPreset.userId, user.id));
      const presetsById = new Map(userPresets.map((p) => [p.id, p]));
      const [existingProfile] = await db
        .select()
        .from(profile)
        .where(eq(profile.userId, user.id))
        .limit(1);
      const snapshot = { userDecks, presetsById, profile: existingProfile ?? null };
      const { read: studyDay } = await readAccountStudyDay(user.id, existingProfile ?? null, now);
      const [spend, countsByDeck] = await Promise.all([
        loadDeckSpend(user.id, studyDay.startsAt, studyDay.endsAt),
        loadStudyCounts(user.id, now),
      ]);
      const allowed = internalReadDeckScope(request);
      const requestedSubtree = deckId ? [deckId, ...descendantIds(deckId, userDecks)] : null;
      const subtree = allowed === undefined ? requestedSubtree
        : requestedSubtree ? requestedSubtree.filter(id => allowed.includes(id)) : [...allowed];
      const { allocation, summary } = allocateStudyScope(snapshot, spend, countsByDeck, deckId ?? null, now, {
        include: subtree ? (id) => subtree.includes(id) : undefined,
        clampNew: query.newLimit !== undefined ? Number(query.newLimit) : undefined,
        clampReview: query.reviewLimit !== undefined ? Number(query.reviewLimit) : undefined,
      });

      const base = [eq(cards.userId, user.id), eq(cards.suspended, false)];
      if (subtree) base.push(subtree.length ? inArray(cards.deckId, subtree) : sql`false`);

      // Learning steps are already introduced cards, not another daily review.
      const learning = await db.select().from(cards)
        .where(and(...base, inArray(cards.state, ['learning', 'relearning']), lte(cards.due, now)))
        .orderBy(asc(cards.due), asc(cards.id))
        .limit(MAX_STUDY_QUEUE);
      const gatherLimited = async (limits: Map<string, number>, state: 'review' | 'new') => {
        const ids = allocation.order.filter((id) => (limits.get(id) ?? 0) > 0);
        const groups = await Promise.all(ids.map((id) => db.select().from(cards).where(and(
          ...base,
          eq(cards.deckId, id),
          eq(cards.state, state),
          lte(cards.due, now),
        )).orderBy(
          ...(state === 'new' ? [asc(cards.createdAt), asc(cards.id)] : [asc(cards.due), asc(cards.id)]),
        ).limit(limits.get(id)!)));
        return groups.flat();
      };
      let room = MAX_STUDY_QUEUE - learning.length;
      const mature: typeof learning = [];
      for (const row of await gatherLimited(allocation.reviewByDeck, 'review')) {
        if (room === 0) break;
        mature.push(row);
        room -= 1;
      }
      const fresh: typeof learning = [];
      for (const row of await gatherLimited(allocation.newByDeck, 'new')) {
        if (room === 0) break;
        fresh.push(row);
        room -= 1;
      }
      const due = [...learning, ...mature];

      const [dueEnriched, freshEnriched] = await Promise.all([
        enrichCards(due),
        enrichCards(fresh),
      ]);
      return {
        due: dueEnriched,
        new: freshEnriched,
        total: dueEnriched.length + freshEnriched.length,
        mode: 'regular' as const,
        summary,
        studyDay: studyDaySnapshot(studyDay),
      };
    },
    {
      auth: true,
      query: t.Object({
        deckId: t.Optional(t.String({ format: 'uuid' })),
        filteredDeckId: t.Optional(t.String({ format: 'uuid' })),
        newLimit: t.Optional(t.String()),
        reviewLimit: t.Optional(t.String()),
      }),
    },
  )
  // Anki-style Browse search. Parses `q` (shared parser) into an AST and
  // translates it to a SQL WHERE via buildCardWhere. Pagination is a
  // TUPLE-KEYSET cursor over `(sortValue, id)` — correct for non-unique sort
  // keys (e.g. ties on `lapses`). Distinct from GET /cards' scalar created_at
  // cursor, which is left untouched.
  //
  //   GET /cards/search?q=is:due
  //   GET /cards/search?q=front:hund&sort=lapses%20desc
  //   GET /cards/search?sort=created%20asc&cursor=<base64>
  //
  // `now` is computed once per request (Critic C2) and passed into the AST
  // translator; under NODE_ENV=test a `now` query param (epoch ms) can pin it
  // for parity tests.
  .get(
    '/search',
    async ({ user, query, status }) => {
      // Parse the query → AST. Cap violations map to 400.
      let ast;
      try {
        ast = parseCardQuery(query.q ?? '');
      } catch (err) {
        if (err instanceof CardQueryError) return status(400, { error: 'bad_query' });
        throw err;
      }

      // Sort allowlist (Architect must-fix #3). Reject anything off-list → 400.
      const sortSpec = parseSort(query.sort);
      if (sortSpec === null) return status(400, { error: 'bad_sort' });
      const { field: sortField, dir } = sortSpec;

      const rawLimit = Number(query.limit ?? DEFAULT_CARDS_PAGE);
      const limit = Math.max(
        1,
        Math.min(MAX_CARDS_PAGE, Number.isFinite(rawLimit) ? rawLimit : DEFAULT_CARDS_PAGE),
      );

      // Per-request clock. Test-only override via ?now=<epochMs>.
      let now = new Date();
      if (process.env.NODE_ENV === 'test' && query.now) {
        const t = Number(query.now);
        if (Number.isFinite(t)) now = new Date(t);
      }

      // Execute via the extracted helper (same query builder + keyset cursor the
      // `browse_cards` agent tool reuses) — byte-identical to the inline version.
      const { rows, nextCursor } = await searchCardsQuery({
        userId: user.id,
        ast,
        sortField,
        dir,
        limit,
        now,
        cursor: query.cursor,
        noteTypeId: query.noteTypeId,
      });

      return { items: await enrichCards(rows), nextCursor };
    },
    {
      auth: true,
      query: t.Object({
        q: t.Optional(t.String()),
        noteTypeId: t.Optional(t.String({ format: 'uuid' })),
        limit: t.Optional(t.String()),
        cursor: t.Optional(t.String()),
        sort: t.Optional(t.String()),
        now: t.Optional(t.String()),
      }),
    },
  )
  // Distinct tag universe for the sidebar (Critic must-fix C3). Avoids the
  // ≤500-mirror incompleteness — the sidebar must see every tag, not just the
  // tags on loaded cards.
  .get(
    '/tags',
    async ({ user }) => {
      // Tags are note-level (Anki-correct). DISTINCT unnest over notes.tags.
      const rows = await db.execute<{ tag: string }>(
        sql`SELECT DISTINCT unnest(${notes.tags}) AS tag FROM ${notes} WHERE ${notes.userId} = ${user.id} ORDER BY tag`,
      );
      const list = rows as unknown as Array<{ tag: string }>;
      return { tags: list.map((r) => r.tag) };
    },
    { auth: true },
  )
  // Single card by id (auth, user-scoped). 404 on a foreign/missing id.
  // Returns the enriched card (note + noteType descriptors merged in) so the
  // chat screen can resolve a CITED card for `RichCard` rendering when that card
  // is outside the ≤500-row bootstrap mirror (SHOULD-FIX #4). Eden-typed.
  .get(
    '/:id',
    async ({ user, params, status }) => {
      const [row] = await db
        .select()
        .from(cards)
        .where(and(eq(cards.id, params.id), eq(cards.userId, user.id)))
        .limit(1);
      if (!row) return status(404, { error: 'not_found' });
      const [enriched] = await enrichCards([row]);
      return enriched!;
    },
    { auth: true, params: t.Object({ id: t.String({ format: 'uuid' }) }) },
  )
  // Bulk operations over a set of card ids. All ops are scoped to the caller
  // (`user_id = $user AND id = ANY($cardIds)`), so foreign ids are silent
  // no-ops, never leaks or errors.
  .post(
    '/bulk',
    async ({ user, body, status }) => {
      const scope = and(eq(cards.userId, user.id), inArray(cards.id, body.cardIds))!;
      const updatedAt = sql`greatest(${cards.updatedAt} + interval '1 millisecond', ${new Date().toISOString()}::timestamptz)`;

      switch (body.action) {
        case 'move': {
          const deckId = body.payload?.deckId;
          if (!deckId) return status(400, { error: 'deck_required' });
          // Verify target deck ownership first.
          const deck = await db
            .select({ id: decks.id })
            .from(decks)
            .where(and(eq(decks.id, deckId), eq(decks.userId, user.id)))
            .limit(1);
          if (deck.length === 0) return status(400, { error: 'deck_not_found' });
          const updated = await db
            .update(cards)
            .set({ deckId, updatedAt })
            .where(scope)
            .returning({ id: cards.id });
          return { updated: updated.length };
        }

        case 'delete': {
          const deleted = await db.delete(cards).where(scope).returning({ id: cards.id });
          return { deleted: deleted.length };
        }

        case 'suspend':
        case 'unsuspend': {
          const updated = await db
            .update(cards)
            .set({ suspended: body.action === 'suspend', updatedAt })
            .where(scope)
            .returning({ id: cards.id });
          return { updated: updated.length };
        }

        case 'forget': {
          const updated = await db.update(cards).set({ ...fsrsResetColumns(), updatedAt }).where(scope).returning();
          return { updated: updated.length, cards: updated };
        }

        case 'setDue': {
          const due = new Date(body.payload?.setDue ?? '');
          if (!Number.isFinite(due.getTime())) return status(400, { error: 'invalid_date' });
          const updated = await db.update(cards).set({ due, updatedAt }).where(scope).returning();
          return { updated: updated.length, cards: updated };
        }

        case 'addTag': {
          const tag = body.payload?.tag;
          if (!tag) return status(400, { error: 'tag_required' });
          // Tags are note-level (Anki-correct): resolve the notes of the selected
          // cards, then array_append where the tag isn't already present (dedup).
          // Scoped to the user via the card ownership filter on the subquery.
          const noteScope = sql`${notes.id} IN (SELECT ${cards.noteId} FROM ${cards} WHERE ${scope})`;
          const updated = await db
            .update(notes)
            .set({ tags: sql`array_append(${notes.tags}, ${tag})`, updatedAt: new Date() })
            .where(
              and(
                eq(notes.userId, user.id),
                noteScope,
                sql`NOT (${notes.tags} @> ARRAY[${tag}]::text[])`,
              ),
            )
            .returning({ id: notes.id });
          // No RAG re-index: tags live on the `notes` table and tag-filtered
          // retrieval JOINs the live notes row, so a chunk re-index would be a
          // no-op churn write (kb_chunk carries no tag/meta column).
          return { updated: updated.length };
        }

        case 'removeTag': {
          const tag = body.payload?.tag;
          if (!tag) return status(400, { error: 'tag_required' });
          const noteScope = sql`${notes.id} IN (SELECT ${cards.noteId} FROM ${cards} WHERE ${scope})`;
          const updated = await db
            .update(notes)
            .set({ tags: sql`array_remove(${notes.tags}, ${tag})`, updatedAt: new Date() })
            .where(and(eq(notes.userId, user.id), noteScope))
            .returning({ id: notes.id });
          // No RAG re-index (see addTag): tag-filtered retrieval reads live
          // notes, so re-indexing here would only churn the chunk.
          return { updated: updated.length };
        }
      }
    },
    {
      auth: true,
      body: t.Object({
        action: t.Union([
          t.Literal('move'),
          t.Literal('delete'),
          t.Literal('suspend'),
          t.Literal('unsuspend'),
          t.Literal('addTag'),
          t.Literal('removeTag'),
          t.Literal('forget'),
          t.Literal('setDue'),
        ]),
        cardIds: t.Array(t.String({ format: 'uuid' }), { minItems: 1, maxItems: 1000 }),
        payload: t.Optional(
          t.Object({
            deckId: t.Optional(t.String({ format: 'uuid' })),
            tag: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
            setDue: t.Optional(t.String()),
          }),
        ),
      }),
    },
  )
  // Card content is derived from notes (note-types model, M1). Card creation
  // happens via POST /notes, not here. PATCH keeps card-level (not note-level)
  // mutations: deck-move, suspend, and manual scheduling control —
  //   - `forget`  → reset FSRS state to "new" (Anki "Forget").
  //   - `setDue`  → set the due date to a specific instant (Anki "Set Due Date").
  // Control fields are mapped EXPLICITLY (no `...body` spread) so a malicious /
  // mistyped key can never reach the column set, and forget/setDue can't smuggle
  // arbitrary FSRS columns. `forget` + `setDue` are mutually exclusive (forget
  // resets due to now, setDue picks a specific instant — conflicting intents).
  // Manual schedule changes bump `updatedAt`, which is what trips the undo
  // stale-guard (`POST /reviews/undo` refuses once a card was modified after its
  // last grade) — that's intentional. render* cache is NOT touched (scheduling
  // doesn't change content).
  .patch(
    '/:id',
    async ({ user, params, body, status }) => {
      const result = await patchCard(user.id, params.id, body);
      if (!result.ok) return status(result.code, { error: result.error });
      return result.card;
    },
    {
      auth: true,
      params: t.Object({ id: t.String({ format: 'uuid' }) }),
      body: t.Partial(
        t.Object({
          deckId: t.String({ format: 'uuid' }),
          suspended: t.Boolean(),
          forget: t.Boolean(),
          setDue: t.String(),
        }),
      ),
    },
  )
  // Source backlinks (NotebookLM M3 / AC3.5): the source passages this card was
  // generated from. Ownership 404 first. LEFT JOINs to source_chunks/sources/
  // notebooks so a card_sources row whose source was deleted (refs SET NULL —
  // a tombstone) is STILL returned with null source fields (the web renders
  // «source deleted»). Snippet = first 240 chars of the chunk text. `{ items }`.
  .get(
    '/:id/sources',
    async ({ user, params, status }) => {
      const [card] = await db
        .select({ id: cards.id })
        .from(cards)
        .where(and(eq(cards.id, params.id), eq(cards.userId, user.id)))
        .limit(1);
      if (!card) return status(404, { error: 'not_found' });

      const rows = await db
        .select({
          id: cardSources.id,
          sourceChunkId: cardSources.sourceChunkId,
          sourceId: cardSources.sourceId,
          notebookId: cardSources.notebookId,
          conversationId: cardSources.conversationId,
          messageId: cardSources.messageId,
          sourceTitle: sources.title,
          sourceSnapshot: cardSources.sourceSnapshot,
          sourceUpdatedAt: sources.updatedAt, sourcePageCount: sources.pageCount,
          sourceHash: sourceChunks.sourceHash,
          notebookTitle: notebooks.title,
          sourceKind: sources.kind,
          sourceUrl: sources.url,
          position: sourceChunks.position,
          page: sourceChunks.page,
          startSeconds: sourceChunks.startSeconds,
          heading: sourceChunks.heading,
          chunkText: sourceChunks.text,
          createdAt: cardSources.createdAt,
        })
        .from(cardSources)
        .leftJoin(sourceChunks, and(eq(sourceChunks.id, cardSources.sourceChunkId), eq(sourceChunks.userId, user.id)))
        .leftJoin(sources, and(eq(sources.id, cardSources.sourceId), eq(sources.userId, user.id)))
        .leftJoin(notebooks, and(eq(notebooks.id, cardSources.notebookId), eq(notebooks.userId, user.id)))
        .where(and(eq(cardSources.userId, user.id), eq(cardSources.cardId, params.id)))
        .orderBy(desc(cardSources.createdAt));

      const items = rows.map((r) => ({
        id: r.id,
        sourceChunkId: r.sourceChunkId,
        sourceId: r.sourceId,
        notebookId: r.notebookId,
        conversationId: r.conversationId,
        messageId: r.messageId,
        sourceTitle: r.sourceSnapshot?.sourceTitle ?? r.sourceTitle ?? null,
        sourceSnapshot: r.sourceSnapshot,
        locationAvailable: r.sourceSnapshot?.kind === 'user_quote' ? Boolean(r.sourceId && r.sourceSnapshot.page && r.sourcePageCount && r.sourceSnapshot.page <= r.sourcePageCount && r.sourceUpdatedAt?.toISOString() === r.sourceSnapshot.sourceVersion) : Boolean(r.sourceId && r.sourceChunkId && r.chunkText != null && r.position != null && (!r.sourceSnapshot || cardEvidenceFingerprint({ text: r.chunkText, sourceHash: r.sourceHash, position: r.position, page: r.page }) === r.sourceSnapshot.textHash)),
        notebookTitle: r.notebookTitle ?? null,
        sourceKind: r.sourceKind ?? null,
        sourceUrl: r.sourceUrl ?? null,
        position: r.sourceSnapshot?.position ?? r.position ?? null,
        page: r.sourceSnapshot?.page ?? r.page ?? null,
        startSeconds: r.sourceSnapshot && r.sourceSnapshot.kind !== 'user_quote' && r.sourceSnapshot.startSeconds != null
          ? r.sourceSnapshot.startSeconds
          : r.startSeconds ?? null,
        heading: r.heading ?? null,
        snippet: r.sourceSnapshot?.quote ?? (r.chunkText ? r.chunkText.slice(0, 240) : null),
        createdAt: r.createdAt,
      }));
      return { items };
    },
    { auth: true, params: t.Object({ id: t.String({ format: 'uuid' }) }) },
  )
  .delete(
    '/:id',
    async ({ user, params, status }) => {
      const [deleted] = await db
        .delete(cards)
        .where(and(eq(cards.id, params.id), eq(cards.userId, user.id)))
        .returning({ id: cards.id });
      if (!deleted) return status(404, { error: 'not_found' });
      return { ok: true };
    },
    { auth: true, params: t.Object({ id: t.String({ format: 'uuid' }) }) },
  );
