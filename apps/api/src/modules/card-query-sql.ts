// AST → drizzle SQL WHERE: the SERVER back-end of the one-AST-two-consumers
// design (the client predicate in @reomi/shared/card-query-predicate.ts is
// the other). This module imports only AST *types* + the shared wildcard helper
// from @reomi/shared — it never re-parses, and never re-implements wildcard
// translation (Architect should-fix #7, plan Principle 1).
//
// SAFETY (PRE-MORTEM #2): every user-supplied literal is passed as a bound
// parameter — drizzle `ilike()` binds its second arg, and every `sql` fragment
// interpolates values as `${value}` placeholders. We NEVER string-concatenate
// user input into the query text.
//
// TIME (Critic must-fix C2): the caller injects `now: Date` (computed once per
// request app-side). We never emit SQL `now()`, so `is:`/`added:`/`edited:`/
// `prop:due` are internally consistent and test-controllable, and stay in parity
// with the client predicate which uses the same pinned `now`.

import {
  and,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  lt,
  lte,
  ne,
  or,
  not as sqlNot,
  type AnyColumn,
  type Column,
  type SQL,
  sql,
} from 'drizzle-orm';
import { cards, noteTypes, notes } from '@reomi/db';
import {
  wildcardToSqlLike,
  type CardQueryNode,
  type CompareOp,
  type PropField,
  type TermNode,
} from '@reomi/shared';

const MS_PER_DAY = 86_400_000;

export interface CardWhereOptions {
  userId: string;
  /** Injected per-request clock — never SQL `now()` (Critic C2). */
  now: Date;
  /**
   * Resolve a `deck:` value to the set of matching deck ids (incl. descendants
   * when `nested`). Deck-table knowledge is injected so this module stays
   * deck-table-agnostic (mirrors the client predicate's `resolveDeckIds`).
   */
  resolveDeckIds(value: string, nested: boolean): string[];
}

/**
 * Translate an AST into a drizzle `SQL` predicate, ANDed with the user scope.
 * The returned predicate is always safe to pass straight to `.where(...)`.
 */
export function buildCardWhere(ast: CardQueryNode, opts: CardWhereOptions): SQL {
  const scope = eq(cards.userId, opts.userId);
  const translated = translate(ast, opts);
  if (translated === undefined) return scope;
  return and(scope, translated)!;
}

/**
 * Translate a node into a predicate, or `undefined` when the node imposes no
 * constraint (an `empty` query → only the user scope applies).
 */
function translate(node: CardQueryNode, opts: CardWhereOptions): SQL | undefined {
  switch (node.kind) {
    case 'empty':
      return undefined;
    case 'group':
      return translate(node.child, opts);
    case 'not': {
      const inner = translate(node.child, opts);
      // `not(empty)` → matches nothing.
      if (inner === undefined) return sql`false`;
      return sqlNot(inner);
    }
    case 'and': {
      const parts = node.children
        .map((c) => translate(c, opts))
        .filter((p): p is SQL => p !== undefined);
      if (parts.length === 0) return undefined;
      if (parts.length === 1) return parts[0];
      return and(...parts);
    }
    case 'or': {
      // An empty branch in an OR matches everything → the whole OR matches
      // everything. Represent that as "no constraint".
      const parts: SQL[] = [];
      for (const c of node.children) {
        const p = translate(c, opts);
        if (p === undefined) return undefined;
        parts.push(p);
      }
      if (parts.length === 0) return undefined;
      if (parts.length === 1) return parts[0];
      return or(...parts);
    }
    case 'term':
      return translateTerm(node, opts);
  }
}

function translateTerm(term: TermNode, opts: CardWhereOptions): SQL {
  switch (term.field) {
    case 'text':
    case 'cloze':
      // bareword / `cloze:` (aliased) → substring over the denormalized
      // renderText (plaintext search cache). `cloze:` is no longer a distinct
      // column — it reads the same rendered plaintext as a bareword (C1).
      return ilike(cards.renderText, substringPattern(term.value));

    case 'front':
      return fieldMatch(cards.renderFrontText, term.value);
    case 'back':
      return fieldMatch(cards.renderBackText, term.value);

    case 'field':
      return fieldValueMatch(term.fieldName ?? '', term.value);

    case 'note':
      // `note:` → note-type name (substring), cross-table via EXISTS.
      return noteTypeMatch(sql`nt.name ILIKE ${substringPattern(term.value)}`);

    case 'template':
      return templateMatch(term.value);

    case 'deck': {
      const ids = opts.resolveDeckIds(term.value, term.nested ?? true);
      if (ids.length === 0) return sql`false`;
      return inArray(cards.deckId, ids);
    }

    case 'tag':
      return tagMatch(term.value);

    case 'is':
      return isMatch(term.value, opts.now);

    case 'variant':
      return variantMatch(term.value);

    case 'added':
      return withinDays(cards.createdAt, term.value, opts.now);
    case 'edited':
      return withinDays(cards.updatedAt, term.value, opts.now);

    case 'prop':
      return propMatch(term, opts.now);
  }
}

// ── cross-table (EXISTS) matchers ─────────────────────────────────────────────
//
// Cross-table operators (C-1) emit a correlated `EXISTS (... WHERE n.id =
// cards.note_id AND <predicate>)` so `buildCardWhere` stays a SINGLE-table
// predicate over `cards` and the tuple-keyset `(sortCol, cards.id)` pagination is
// untouched. Every literal stays a bound parameter.

/** `EXISTS (SELECT 1 FROM notes n WHERE n.id = cards.note_id AND <inner>)`. */
function noteExists(inner: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM ${notes} n WHERE n.id = ${cards.noteId} AND ${inner})`;
}

/**
 * `EXISTS (SELECT 1 FROM notes n JOIN note_types nt ... AND <inner>)`. The inner
 * predicate may reference `n.` and `nt.`.
 */
function noteTypeMatch(inner: SQL): SQL {
  return sql`EXISTS (SELECT 1 FROM ${notes} n JOIN ${noteTypes} nt ON nt.id = n.note_type_id WHERE n.id = ${cards.noteId} AND ${inner})`;
}

/**
 * `field:Name=X` → the note's `field_values->>'Name'` matched with substring /
 * wildcard semantics (mirrors the client `fieldValueMatch`). A bare `field:Name`
 * (value === '') → the field exists and is non-empty.
 */
function fieldValueMatch(name: string, value: string): SQL {
  if (name === '') return sql`false`;
  if (value === '') {
    return noteExists(sql`btrim(n.field_values->>${name}) <> '' AND n.field_values->>${name} IS NOT NULL`);
  }
  return noteExists(sql`n.field_values->>${name} ILIKE ${substringPattern(value)}`);
}

/** `template:N` → the card's template ordinal. Non-numeric → matches nothing. */
function templateMatch(value: string): SQL {
  const n = Number(value);
  if (!Number.isFinite(n)) return sql`false`;
  return eq(cards.templateOrd, n);
}

/**
 * `variant:` is a builtin note-type alias. Legacy `basic`/`cloze`/`type` map to
 * the note-type KIND (`type`→`typein`); other values compare against the kind
 * directly. Cross-table via the note-type join.
 */
function variantMatch(value: string): SQL {
  const target = value === 'type' ? 'typein' : value;
  return noteTypeMatch(sql`nt.kind = ${target}`);
}

// ── text matching ─────────────────────────────────────────────────────────────

/** Wrap a value in implicit `*…*` then translate to a SQL LIKE pattern. */
function substringPattern(value: string): string {
  return wildcardToSqlLike(`*${value}*`);
}

/**
 * `field:value` matching. Mirrors the client predicate's `fieldMatch`:
 *  - empty value → the field must be the empty string.
 *  - explicit wildcard → anchor-free pattern (wrapped in implicit `*…*`).
 *  - otherwise → substring match.
 */
function fieldMatch(col: Column, value: string): SQL {
  if (value === '') return eq(col, '');
  return ilike(col, substringPattern(value));
}

// ── tags (note-level, cross-table via EXISTS) ────────────────────────────────
//
// Tags moved from cards to notes (Anki tags are note-level). `tag:` resolves
// through the note row: `EXISTS (SELECT 1 FROM notes n WHERE n.id = cards.note_id
// AND <tags predicate>)`. Preserves case-insensitive exact + wildcard + `tag:none`
// (mirrors the old cards.tags unnest logic, retargeted to notes.tags).

function tagMatch(value: string): SQL {
  if (value === 'none') {
    return noteExists(sql`array_length(n.tags, 1) IS NULL`);
  }
  if (value.includes('*') || value.includes('_')) {
    // Prefix / wildcard tag: ILIKE each element via unnest. wildcardToSqlLike is
    // an anchored full-pattern match (no implicit wrap) — matches the client
    // predicate's `likeToRegex(value)` over each tag.
    const pat = wildcardToSqlLike(value);
    return noteExists(
      sql`EXISTS (SELECT 1 FROM unnest(n.tags) AS tg WHERE tg ILIKE ${pat})`,
    );
  }
  // Exact (case-INSENSITIVE) membership — matches the client predicate's
  // `t.toLowerCase() === value.toLowerCase()`. Value stays a bound parameter.
  return noteExists(
    sql`EXISTS (SELECT 1 FROM unnest(n.tags) AS tg WHERE lower(tg) = lower(${value}))`,
  );
}

// ── is: ───────────────────────────────────────────────────────────────────────

function isMatch(value: string, now: Date): SQL {
  switch (value) {
    case 'new':
      return eq(cards.state, 'new');
    case 'learn':
      // Anki's "learn" covers both learning and relearning queues.
      return inArray(cards.state, ['learning', 'relearning']);
    case 'review':
      return eq(cards.state, 'review');
    case 'due':
      // Due = scheduled at-or-before now AND not suspended (Critic C2 boundary
      // contract: `<=` inclusive). Uses the injected `now`, not SQL now().
      // Use drizzle's typed `lte` so the Date is encoded for the timestamp col.
      return and(lte(cards.due, now), eq(cards.suspended, false))!;
    case 'suspended':
      return eq(cards.suspended, true);
    default:
      return sql`false`;
  }
}

// ── added: / edited: ──────────────────────────────────────────────────────────

/**
 * `added:N` / `edited:N` → the timestamp falls within the last N days of `now`
 * (inclusive lower bound at `now - N*day`, upper bound at `now`). Non-numeric /
 * non-positive N → matches nothing (mirrors the predicate).
 */
function withinDays(col: AnyColumn, value: string, now: Date): SQL {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return sql`false`;
  const cutoff = new Date(now.getTime() - n * MS_PER_DAY);
  // Typed `gte`/`lte` encode the Date for the timestamp column.
  return and(gte(col, cutoff), lte(col, now))!;
}

// ── prop: ─────────────────────────────────────────────────────────────────────

function propMatch(term: TermNode, now: Date): SQL {
  const prop = term.prop ?? 'reps';
  const op = term.op ?? '=';
  const n = Number(term.value);
  if (!Number.isFinite(n)) return sql`false`;

  if (prop === 'due') {
    // `prop:due` operand is a relative day offset vs now (Anki-style):
    // `prop:due<=3` = due within 3 days. Compare the timestamp column.
    const target = new Date(now.getTime() + n * MS_PER_DAY);
    return compareTimestamp(cards.due, op, target);
  }

  return compareNumber(propColumn(prop), op, n);
}

function propColumn(prop: PropField): Column {
  switch (prop) {
    case 'reps':
      return cards.reps;
    case 'lapses':
      return cards.lapses;
    case 's':
      return cards.stability;
    case 'd':
      return cards.difficulty;
    case 'ivl':
      // Pinned decision (plan Phase 1): `prop:ivl` maps to scheduled_days.
      return cards.scheduledDays;
    case 'due':
      // handled separately in propMatch; fall back for exhaustiveness.
      return cards.due;
  }
}

function compareNumber(col: Column, op: CompareOp, value: number): SQL {
  switch (op) {
    case '=':
      return sql`${col} = ${value}`;
    case '!=':
      return sql`${col} <> ${value}`;
    case '<':
      return sql`${col} < ${value}`;
    case '>':
      return sql`${col} > ${value}`;
    case '<=':
      return sql`${col} <= ${value}`;
    case '>=':
      return sql`${col} >= ${value}`;
  }
}

function compareTimestamp(col: AnyColumn, op: CompareOp, value: Date): SQL {
  // Typed operators encode the Date for the timestamp column.
  switch (op) {
    case '=':
      return eq(col, value);
    case '!=':
      return ne(col, value);
    case '<':
      return lt(col, value);
    case '>':
      return gt(col, value);
    case '<=':
      return lte(col, value);
    case '>=':
      return gte(col, value);
  }
}
