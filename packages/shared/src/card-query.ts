// Card query language: tokenizer + recursive-descent parser → AST.
//
// One AST, two consumers (plan Principle 1): this module is the single source of
// truth for the grammar. The client predicate (card-query-predicate.ts) and the
// server SQL builder (apps/api/.../card-query-sql.ts) both consume the AST this
// module produces — there is never a second parser.
//
// Pure-TS only: NO DOM/Node deps (packages/shared is shared between the browser
// bundle and the Bun server).
//
// Grammar (AC6):
//   orExpr  := andExpr ("OR" andExpr)*
//   andExpr := unary+                         (implicit AND on whitespace)
//   unary   := "-" unary | primary
//   primary := "(" orExpr ")" | term
//   term    := key ":" value | "quoted" | bareword
//
// Recovery: liberal for harmless-but-malformed input (an unbalanced "(" or an
// unbalanced quote degrades to barewords); but hard caps (max length / max term
// count) throw a typed CardQueryError that the API layer maps to 400.

// ── safety caps ──────────────────────────────────────────────────────────────

export const MAX_QUERY_LENGTH = 1000;
export const MAX_TERM_COUNT = 64;

export const CARD_IS_VALUES = ['new', 'learn', 'review', 'due', 'suspended', 'buried'] as const;
export type CardIsValue = (typeof CARD_IS_VALUES)[number];

/**
 * Thrown for cap violations (query too long / too many terms). The API layer can
 * `instanceof CardQueryError` to return a 400 instead of a 500. Recoverable
 * malformations (unbalanced quote/paren) do NOT throw — they degrade gracefully.
 */
export class CardQueryError extends Error {
  readonly code: 'too_long' | 'too_many_terms';
  constructor(code: 'too_long' | 'too_many_terms', message: string) {
    super(message);
    this.name = 'CardQueryError';
    this.code = code;
  }
}

// ── AST ──────────────────────────────────────────────────────────────────────

/** Comparison operators usable on `prop:` terms. */
export type CompareOp = '=' | '!=' | '<' | '>' | '<=' | '>=';

/**
 * A leaf term. `field` is the normalized key (`'text'` for a bareword that
 * matches the rendered card text). `op` is only present for `prop:` terms.
 * `value` is the raw (unquoted, comparator-stripped) string operand.
 *
 * Note-types model (M1): content operators target the DENORMALIZED rendered
 * plaintext columns on the card (`front`→renderFrontText, `back`→renderBackText,
 * bareword/`cloze`→renderText) and, cross-table, the note's field values
 * (`field:Name=X`) and the note-type identity (`variant`/`note`/`template`).
 */
export interface TermNode {
  kind: 'term';
  /**
   * Normalized term field:
   *  - 'text'    bareword / quoted bareword → substring over renderText
   *  - 'front' | 'back'                     → substring on rendered front/back text
   *  - 'cloze'                              → alias to bareword (renderText)
   *  - 'field'                              → note field value (`field:Name=X`)
   *  - 'note'                               → note-type name
   *  - 'template'                           → card template name / ordinal
   *  - 'deck'                               → deck name (resolved to ids in ctx)
   *  - 'tag'                                → tag membership (`none`, prefix `foo*`)
   *  - 'is'                                 → new|learn|review|due|suspended|buried
   *  - 'variant'                            → builtin note-type kind / name alias
   *  - 'added' | 'edited'                   → N (days)
   *  - 'prop'                               → reps|lapses|due|s|d|ivl (+ op)
   */
  field:
    | 'text'
    | 'front'
    | 'back'
    | 'cloze'
    | 'field'
    | 'note'
    | 'template'
    | 'deck'
    | 'tag'
    | 'is'
    | 'variant'
    | 'added'
    | 'edited'
    | 'prop';
  value: string;
  /** Present only on `prop:` terms (the comparator parsed out of the value). */
  op?: CompareOp;
  /** For `prop:` terms, which numeric field is being compared. */
  prop?: PropField;
  /**
   * For `field:Name=X` terms: the note field NAME (`Name`). The `value` holds the
   * operand (`X`). A `field:Name` form with no `=value` matches "field exists and
   * is non-empty" (value === '').
   */
  fieldName?: string;
  /**
   * True when `deck:`/`tag:`/`text` value was supplied quoted (spaces preserved,
   * no implicit AND split). Informational; semantics don't depend on it today.
   */
  quoted?: boolean;
  /**
   * For `deck:` terms: the `::*` nesting marker was present (match the deck and
   * all of its descendants). The plain `deck:` form already resolves to the
   * subtree in the predicate, so this is an explicit/forced-nesting hint.
   */
  nested?: boolean;
}

export interface NotNode {
  kind: 'not';
  child: CardQueryNode;
}

export interface AndNode {
  kind: 'and';
  children: CardQueryNode[];
}

export interface OrNode {
  kind: 'or';
  children: CardQueryNode[];
}

export interface GroupNode {
  kind: 'group';
  child: CardQueryNode;
}

/** Empty / whitespace-only query — matches everything. */
export interface EmptyNode {
  kind: 'empty';
}

export type CardQueryNode =
  | TermNode
  | NotNode
  | AndNode
  | OrNode
  | GroupNode
  | EmptyNode;

/** Numeric fields addressable via `prop:`. `ivl` maps to `scheduledDays`. */
export const PROP_FIELDS = ['reps', 'lapses', 'due', 's', 'd', 'ivl'] as const;
export type PropField = (typeof PROP_FIELDS)[number];

const KNOWN_KEYS = new Set([
  'front',
  'back',
  'cloze',
  'field',
  'note',
  'template',
  'deck',
  'tag',
  'is',
  'variant',
  'added',
  'edited',
  'prop',
]);

// ── tokenizer ────────────────────────────────────────────────────────────────

type Token =
  | { type: 'word'; value: string; quoted: boolean }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'or' }
  | { type: 'minus' };

/**
 * Tokenize a raw query string.
 *
 *  - Whitespace separates tokens (becomes implicit AND in the parser).
 *  - `(` and `)` are structural.
 *  - A leading `-` (with no whitespace before the next token) is negation.
 *  - `"…"` is a quoted string; `\"` is an escaped quote, `\\` an escaped
 *    backslash. An unterminated quote consumes to end-of-input (recovery).
 *  - `key:"quoted value"` keeps the colon+key glued to the quoted operand so the
 *    parser sees one `word` token (e.g. `deck:"My Deck"`).
 *
 * The tokenizer is permissive — structural validity is the parser's concern.
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r';

  while (i < n) {
    const c = input[i]!;

    if (isSpace(c)) {
      i++;
      continue;
    }
    if (c === '(') {
      tokens.push({ type: 'lparen' });
      i++;
      continue;
    }
    if (c === ')') {
      tokens.push({ type: 'rparen' });
      i++;
      continue;
    }
    if (c === '-') {
      // A `-` is negation only when it is the start of a new term (i.e. it is
      // followed by a non-space, non-`)` char). A trailing `-` is a bareword.
      const next = input[i + 1];
      if (next !== undefined && !isSpace(next) && next !== ')') {
        tokens.push({ type: 'minus' });
        i++;
        continue;
      }
      // else fall through and read it as part of a word
    }

    // Read a "word": run of non-space chars, with quote handling. A quote may
    // appear at the start (`"two words"`) or after a colon (`key:"two words"`).
    //
    // `quotedAtStart` distinguishes a true quoted bareword (`"two words"`, quote
    // is the first char → never key-split) from a keyed quoted operand
    // (`deck:"two words"`, the key is bare → still key-split). `usedQuote` just
    // records that quoting happened at all.
    let value = '';
    let usedQuote = false;
    let quotedAtStart = false;
    let sawColon = false;

    while (i < n) {
      const ch = input[i]!;

      if (isSpace(ch)) break;
      if (ch === '(' || ch === ')') break;

      if (ch === '"') {
        // Begin quoted segment. The segment is part of the current word so that
        // `key:"a b"` stays one token. Spaces inside are preserved.
        usedQuote = true;
        if (value === '') quotedAtStart = true;
        i++; // skip opening quote
        let closed = false;
        while (i < n) {
          const qc = input[i]!;
          if (qc === '\\') {
            const esc = input[i + 1];
            if (esc === '"' || esc === '\\') {
              value += esc;
              i += 2;
              continue;
            }
            // lone backslash — keep it literal
            value += qc;
            i++;
            continue;
          }
          if (qc === '"') {
            i++; // skip closing quote
            closed = true;
            break;
          }
          value += qc;
          i++;
        }
        // Unterminated quote (no closing `"`): recovery — we've consumed to EOI
        // and treat what we read as the (bareword-ish) value.
        if (!closed) {
          // mark so an unbalanced quote degrades to a bareword (not a key:value
          // with magic) — but keep already-collected text.
        }
        // After a quoted segment, continue reading any trailing non-space chars
        // (rare, but e.g. `"a"b` → `ab`). Loop continues.
        continue;
      }

      if (ch === ':' && !sawColon) {
        sawColon = true;
        value += ch;
        i++;
        continue;
      }

      value += ch;
      i++;
    }

    if (value === '') continue;

    // `OR` (case-sensitive, bareword, unquoted) is the disjunction operator.
    if (!usedQuote && value === 'OR') {
      tokens.push({ type: 'or' });
      continue;
    }

    // `quoted` on the token means "quoted bareword" (suppress key-splitting) —
    // only true when the quote opened the word (`"two words"`), NOT for a keyed
    // quoted operand (`deck:"two words"`).
    tokens.push({ type: 'word', value, quoted: quotedAtStart });
  }

  return tokens;
}

// ── parser ───────────────────────────────────────────────────────────────────

/**
 * Parse a query string into an AST. Throws {@link CardQueryError} for cap
 * violations (too long / too many terms); otherwise always returns a node
 * (degrading gracefully for harmless malformations).
 */
export function parseCardQuery(q: string): CardQueryNode {
  if (q.length > MAX_QUERY_LENGTH) {
    throw new CardQueryError(
      'too_long',
      `query exceeds ${MAX_QUERY_LENGTH} characters (got ${q.length})`,
    );
  }

  const tokens = tokenize(q);

  // Term-count cap: count `word` tokens (each is at most one leaf term).
  const wordCount = tokens.reduce((acc, t) => acc + (t.type === 'word' ? 1 : 0), 0);
  if (wordCount > MAX_TERM_COUNT) {
    throw new CardQueryError(
      'too_many_terms',
      `query exceeds ${MAX_TERM_COUNT} terms (got ${wordCount})`,
    );
  }

  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];
  const next = (): Token | undefined => tokens[pos++];

  // orExpr := andExpr ("OR" andExpr)*
  function parseOr(): CardQueryNode {
    const first = parseAnd();
    const branches: CardQueryNode[] = [first];
    while (peek()?.type === 'or') {
      next(); // consume OR
      // A trailing/leading OR with nothing after it is ignored (recovery).
      if (peek() === undefined || peek()!.type === 'rparen') break;
      branches.push(parseAnd());
    }
    if (branches.length === 1) return first;
    return { kind: 'or', children: branches };
  }

  // andExpr := unary+   (implicit AND; stops at OR / `)` / EOI)
  function parseAnd(): CardQueryNode {
    const children: CardQueryNode[] = [];
    while (true) {
      const t = peek();
      if (t === undefined) break;
      if (t.type === 'or' || t.type === 'rparen') break;
      const node = parseUnary();
      if (node) children.push(node);
    }
    if (children.length === 0) return { kind: 'empty' };
    if (children.length === 1) return children[0]!;
    return { kind: 'and', children };
  }

  // unary := "-" unary | primary
  function parseUnary(): CardQueryNode | null {
    const t = peek();
    if (t?.type === 'minus') {
      next();
      const child = parseUnary();
      if (!child) return null; // dangling `-` → drop (recovery)
      return { kind: 'not', child };
    }
    return parsePrimary();
  }

  // primary := "(" orExpr ")" | term
  function parsePrimary(): CardQueryNode | null {
    const t = peek();
    if (t === undefined) return null;

    if (t.type === 'lparen') {
      next(); // consume (
      const inner = parseOr();
      if (peek()?.type === 'rparen') {
        next(); // consume )
      }
      // Unbalanced `(` → we just take what we parsed (recovery).
      return { kind: 'group', child: inner };
    }

    if (t.type === 'rparen') {
      // Stray `)` — consume and ignore (recovery).
      next();
      return null;
    }

    if (t.type === 'word') {
      next();
      return termFromWord(t.value, t.quoted);
    }

    // `or`/`minus` shouldn't reach here, but guard anyway.
    next();
    return null;
  }

  const ast = parseOr();
  // Trailing tokens (e.g. extra `)`) are ignored by construction.
  return ast;
}

// ── term construction ────────────────────────────────────────────────────────

/**
 * Turn a single `word` token into a TermNode. Splits `key:value`, normalizes the
 * key, parses comparators out of `prop:` values, and detects `deck:`'s `::*`
 * nesting marker. An unknown key (e.g. `foo:bar`) degrades to a bareword text
 * term over the whole literal.
 */
function termFromWord(raw: string, quoted: boolean): TermNode {
  // Quoted barewords never carry a key (the quote starts the operand).
  if (!quoted) {
    const colon = raw.indexOf(':');
    if (colon > 0) {
      const key = raw.slice(0, colon).toLowerCase();
      const value = raw.slice(colon + 1);
      if (KNOWN_KEYS.has(key)) {
        return buildKeyedTerm(key, value, quoted);
      }
    }
  }
  // bareword (or unknown key, or quoted phrase) → text term
  return { kind: 'term', field: 'text', value: raw, quoted };
}

function buildKeyedTerm(key: string, value: string, quoted: boolean): TermNode {
  switch (key) {
    case 'front':
    case 'back':
    case 'cloze':
      return { kind: 'term', field: key, value, quoted };

    case 'note':
    case 'template':
      return { kind: 'term', field: key, value, quoted };

    case 'field': {
      // `field:Name=X` → { fieldName: 'Name', value: 'X' }. Split on the FIRST
      // `=`. A bare `field:Name` (no `=`) means "field Name is non-empty"
      // (value === '' but fieldName set — distinct from text-empty matching).
      const eq = value.indexOf('=');
      if (eq >= 0) {
        return {
          kind: 'term',
          field: 'field',
          fieldName: value.slice(0, eq),
          value: value.slice(eq + 1),
          quoted,
        };
      }
      return { kind: 'term', field: 'field', fieldName: value, value: '', quoted };
    }

    case 'deck': {
      // AC7: the plain `deck:` form already resolves to the subtree (descendants
      // included) → `nested: true` by default. `deck:Foo::*` is an explicit
      // nesting marker; strip the trailing `::*` (kept distinct so a caller could
      // special-case it, but semantics are the same — nest the subtree).
      let v = value;
      if (v.endsWith('::*')) {
        v = v.slice(0, -3);
      }
      return { kind: 'term', field: 'deck', value: v, nested: true, quoted };
    }

    case 'tag':
      return { kind: 'term', field: 'tag', value, quoted };

    case 'is':
      return { kind: 'term', field: 'is', value: value.toLowerCase(), quoted };

    case 'variant':
      return { kind: 'term', field: 'variant', value: value.toLowerCase(), quoted };

    case 'added':
    case 'edited':
      return { kind: 'term', field: key, value, quoted };

    case 'prop': {
      const { prop, op, operand } = parseProp(value);
      return { kind: 'term', field: 'prop', prop, op, value: operand, quoted };
    }

    default:
      // unreachable (KNOWN_KEYS gate) — degrade to text
      return { kind: 'term', field: 'text', value: `${key}:${value}`, quoted };
  }
}

/**
 * Parse a `prop:` operand like `ivl>=10` into `{ prop: 'ivl', op: '>=',
 * operand: '10' }`. The numeric field name is the leading [a-z]+ run; the
 * comparator is parsed out of the remainder. An unknown field falls back to
 * `reps` (harmless; the predicate clamps to a numeric compare).
 */
function parseProp(value: string): { prop: PropField; op: CompareOp; operand: string } {
  // field name = leading letters
  const m = /^([a-zA-Z]+)(.*)$/.exec(value);
  let field = (m?.[1] ?? '').toLowerCase();
  const rest = m?.[2] ?? '';

  const prop: PropField = (PROP_FIELDS as readonly string[]).includes(field)
    ? (field as PropField)
    : 'reps';

  const { op, operand } = parseComparator(rest);
  // An empty/whitespace operand (`prop:due` with no number) must NOT coerce to 0
  // (`Number('') === 0`). Route it through the same NaN-rejecting path that a
  // non-numeric operand uses (`Number('x') → NaN → matches nothing`), so both
  // back-ends agree it matches nothing.
  const safeOperand = operand.trim() === '' ? 'NaN' : operand;
  return { prop, op, operand: safeOperand };
}

/**
 * Split a comparator + operand. Longest-match the two-char operators (`>=`,
 * `<=`, `!=`) before the single-char ones (`>`, `<`, `=`). A bare value with no
 * comparator defaults to `=`.
 */
function parseComparator(s: string): { op: CompareOp; operand: string } {
  const two = s.slice(0, 2);
  if (two === '>=' || two === '<=' || two === '!=') {
    return { op: two, operand: s.slice(2) };
  }
  const one = s.slice(0, 1);
  if (one === '>' || one === '<' || one === '=') {
    return { op: one as CompareOp, operand: s.slice(1) };
  }
  return { op: '=', operand: s };
}
