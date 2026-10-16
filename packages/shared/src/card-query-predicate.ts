// AST → client predicate: `buildCardPredicate(ast, ctx): (card) => boolean`.
//
// This is the CLIENT back-end of the one-AST-two-consumers design (the server
// SQL builder is the other; it lives in apps/api and consumes the same AST
// types). Pure-TS, no DOM/Node deps.
//
// Determinism contract (Critic must-fix C2): `now` and deck-name resolution are
// INJECTED via `ctx`. This module NEVER calls `Date.now()` inline, so time-
// relative operators (`is:due`, `added:N`, `edited:N`, `prop:due`) are testable
// with a pinned clock and stay in parity with the server (which passes the same
// per-request `now`).

import type { CardHoldView } from './card-hold.ts';
import { holdIsActive } from './card-hold.ts';
import type { CardState } from './index.ts';
import { likeToRegex } from './card-query-match.ts';
import type {
  CardQueryNode,
  CompareOp,
  PropField,
  TermNode,
} from './card-query.ts';

/**
 * Minimal structural shape a card must satisfy to be filtered. Built from the UI
 * `Card` (or a server row) by the caller. Timestamps are epoch milliseconds.
 *
 * Note-types model (M1, plan Principle 1): the content fields are the SERVER-
 * RENDERED plaintext columns (`renderText`/`renderFrontText`/`renderBackText`) —
 * the predicate consumes them VERBATIM and NEVER re-renders or re-strips cloze.
 * Cross-note operators read `fieldValues` (the note's sanitized field values),
 * `noteTypeKind`/`noteTypeName` (note-type identity) and `templateOrd`.
 *
 * Adapter note: `scheduledDays` must come from the FSRS scheduled interval
 * (`card.fsrs.scheduled_days`, snake_case in ts-fsrs / `mappers.ts:49`) — that
 * is what `prop:ivl` reads. `state` is the lowercase label
 * (`new|learning|review|relearning`), matching the DB column and the server.
 */
export interface CardLike {
  /** Server-rendered plaintext (bareword / `cloze:` target). VERBATIM, never re-rendered. */
  renderText: string;
  /** Server-rendered plaintext front (`front:` target). */
  renderFrontText: string;
  /** Server-rendered plaintext back (`back:` target). */
  renderBackText: string;
  /** Note field values keyed by field name (`field:Name=X` target). */
  fieldValues: Record<string, string>;
  /** Note-type render kind — `variant:` builtin alias target. */
  noteTypeKind: 'basic' | 'cloze' | 'typein' | 'custom';
  /** Note-type display name — `note:` target. */
  noteTypeName: string;
  /** Template ordinal — `template:` numeric-ordinal target. */
  templateOrd: number;
  /** Note-level tags (`tag:` target). */
  tags: string[];
  deckId: string;
  state: CardState;
  suspended: boolean;
  /** epoch ms */
  due: number;
  /** epoch ms */
  createdAt: number;
  /** epoch ms */
  updatedAt: number;
  lapses: number;
  reps: number;
  stability: number;
  difficulty: number;
  /** FSRS scheduled interval in days; backs `prop:ivl`. */
  scheduledDays: number;
  hold: CardHoldView | null;
}

export interface PredicateContext {
  /**
   * Injected "current time" in epoch ms. NEVER read `Date.now()` inside this
   * module — the caller pins this so client/server agree and tests are stable.
   */
  now: number;
  /**
   * Resolve a `deck:` value to the set of matching deck ids. `nested` is true
   * when the subtree should be included (always true for the plain `deck:` form
   * per AC7; the `::*` marker is an explicit hint). Deck-table knowledge is
   * injected so shared stays deck-table-agnostic.
   */
  resolveDeckIds(value: string, nested: boolean): string[];
}

const MS_PER_DAY = 86_400_000;

/**
 * Compile an AST into a predicate over {@link CardLike}. The returned function
 * is pure given the same `ctx`.
 */
export function buildCardPredicate(
  ast: CardQueryNode,
  ctx: PredicateContext,
): (card: CardLike) => boolean {
  return (card: CardLike) => evalNode(ast, card, ctx);
}

function evalNode(node: CardQueryNode, card: CardLike, ctx: PredicateContext): boolean {
  switch (node.kind) {
    case 'empty':
      return true;
    case 'and':
      return node.children.every((c) => evalNode(c, card, ctx));
    case 'or':
      return node.children.some((c) => evalNode(c, card, ctx));
    case 'not':
      return !evalNode(node.child, card, ctx);
    case 'group':
      return evalNode(node.child, card, ctx);
    case 'term':
      return evalTerm(node, card, ctx);
  }
}

function evalTerm(term: TermNode, card: CardLike, ctx: PredicateContext): boolean {
  switch (term.field) {
    case 'text':
    case 'cloze':
      // bareword / `cloze:` → substring over the server-rendered plaintext.
      return substringMatch(card.renderText, term.value);

    case 'front':
      return fieldMatch(card.renderFrontText, term.value);
    case 'back':
      return fieldMatch(card.renderBackText, term.value);

    case 'field':
      return fieldValueMatch(card.fieldValues, term.fieldName ?? '', term.value);

    case 'note':
      // `note:` → note-type name (substring, case-insensitive).
      return substringMatch(card.noteTypeName, term.value);

    case 'template':
      return templateMatch(card, term.value);

    case 'deck': {
      const ids = ctx.resolveDeckIds(term.value, term.nested ?? true);
      return ids.includes(card.deckId);
    }

    case 'tag':
      return tagMatch(card.tags, term.value);

    case 'is':
      return isMatch(term.value, card, ctx.now);

    case 'variant':
      return variantMatch(card, term.value);

    case 'added':
      return withinDays(card.createdAt, term.value, ctx.now);
    case 'edited':
      return withinDays(card.updatedAt, term.value, ctx.now);

    case 'prop':
      return propMatch(term, card, ctx.now);
  }
}

/**
 * `field:Name=X` matching. The note field VALUE is HTML — we match the raw value
 * with substring/wildcard semantics, mirroring the server's `field_values->>Name
 * ILIKE`. A bare `field:Name` (value === '' with fieldName set) means "field
 * exists and is non-empty".
 */
function fieldValueMatch(
  fieldValues: Record<string, string>,
  name: string,
  value: string,
): boolean {
  if (name === '') return false;
  const v = fieldValues[name];
  if (v === undefined) return false;
  if (value === '') return v.trim() !== '';
  return fieldMatch(v, value);
}

/**
 * `variant:` is a builtin note-type alias. The legacy values `basic`/`cloze`/
 * `type` map to the note-type KIND (`type`→`typein`). Otherwise compare against
 * the kind directly (so `variant:custom` works too).
 */
function variantMatch(card: CardLike, value: string): boolean {
  const target = value === 'type' ? 'typein' : value;
  return card.noteTypeKind === target;
}

/**
 * `template:` matches a card template by ordinal (numeric value) — mirrors the
 * server's `cards.template_ord = N`. A non-numeric value matches nothing.
 */
function templateMatch(card: CardLike, value: string): boolean {
  const n = Number(value);
  if (!Number.isFinite(n)) return false;
  return card.templateOrd === n;
}

// ── text matching ─────────────────────────────────────────────────────────────

/**
 * Substring match (bareword / front:/back:/cloze:). Wildcards `*`/`_` are
 * honored via likeToRegex; with no wildcard we still do a case-insensitive
 * substring (by wrapping the value in `*…*`). All regex translation goes through
 * the shared helper — no inline regex (Architect should-fix #7).
 */
function substringMatch(haystack: string, value: string): boolean {
  // Substring semantics: anchor-free match → wrap in implicit wildcards.
  return likeToRegex(`*${value}*`).test(haystack);
}

/**
 * `field:value` matching. Empty value (`front:`) → field must be empty (AC7).
 * Otherwise substring semantics: wrap the value in implicit `*…*` so both literal
 * and explicit-wildcard patterns match anywhere (the old wildcard branch was
 * behaviorally identical to this `substringMatch` fallthrough). Mirrors the
 * server's `fieldMatch` (`ilike(col, *value*)`).
 */
function fieldMatch(fieldValue: string, value: string): boolean {
  if (value === '') return fieldValue === '';
  return substringMatch(fieldValue, value);
}

// ── tags ──────────────────────────────────────────────────────────────────────

function tagMatch(tags: string[], value: string): boolean {
  if (value === 'none') return tags.length === 0;
  if (value.includes('*') || value.includes('_')) {
    const re = likeToRegex(value);
    return tags.some((t) => re.test(t));
  }
  // exact (case-insensitive) membership
  const lower = value.toLowerCase();
  return tags.some((t) => t.toLowerCase() === lower);
}

// ── is: ───────────────────────────────────────────────────────────────────────

function isMatch(value: string, card: CardLike, now: number): boolean {
  const held = holdIsActive(card.hold, now);
  switch (value) {
    case 'new':
      return card.state === 'new' && !held;
    case 'learn':
      // Anki's "learn" covers both learning and relearning queues.
      return (card.state === 'learning' || card.state === 'relearning') && !held;
    case 'review':
      return card.state === 'review' && !held;
    case 'due':
      // Due = scheduled at-or-before now AND not suspended (Critic C2 boundary
      // contract: `<=` is inclusive).
      return card.due <= now && !card.suspended && !held;
    case 'suspended':
      return card.suspended;
    case 'buried':
      return held && !card.suspended;
    default:
      return false;
  }
}

// ── added: / edited: ──────────────────────────────────────────────────────────

/**
 * `added:N` / `edited:N` → the timestamp falls within the last N days of `now`
 * (inclusive lower bound at `now - N*day`). Non-numeric / non-positive N → no
 * match.
 */
function withinDays(ts: number, value: string, now: number): boolean {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return false;
  const cutoff = now - n * MS_PER_DAY;
  return ts >= cutoff && ts <= now;
}

// ── prop: ─────────────────────────────────────────────────────────────────────

function propMatch(term: TermNode, card: CardLike, now: number): boolean {
  const prop = term.prop ?? 'reps';
  const op = term.op ?? '=';
  const actual = propValue(prop, card);
  const operand = propOperand(prop, term.value, now);
  if (!Number.isFinite(operand)) return false;
  return compareNum(actual, op, operand);
}

function propValue(prop: PropField, card: CardLike): number {
  switch (prop) {
    case 'reps':
      return card.reps;
    case 'lapses':
      return card.lapses;
    case 'due':
      return card.due;
    case 's':
      return card.stability;
    case 'd':
      return card.difficulty;
    case 'ivl':
      // Pinned decision (plan Phase 1): `prop:ivl` maps to the FSRS scheduled
      // interval in days.
      return card.scheduledDays;
  }
}

/**
 * Interpret the operand for a prop. For `prop:due` the operand is a relative day
 * offset (Anki-style: `prop:due<=3` = due within 3 days), resolved against the
 * injected `now`. All other props compare against the raw number.
 */
function propOperand(prop: PropField, raw: string, now: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return NaN;
  if (prop === 'due') return now + n * MS_PER_DAY;
  return n;
}

function compareNum(a: number, op: CompareOp, b: number): boolean {
  switch (op) {
    case '=':
      return a === b;
    case '!=':
      return a !== b;
    case '<':
      return a < b;
    case '>':
      return a > b;
    case '<=':
      return a <= b;
    case '>=':
      return a >= b;
  }
}
