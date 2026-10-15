// Pure helpers for manipulating the card-query string from the sidebar builder.
//
// These let the Browse sidebar (decks / tags / state chips) insert, replace, or
// toggle a single token in the user's query without re-parsing the whole grammar
// (the AST lives in @reomi/shared; this is a UI-side text manipulation).
//
// Splitting is whitespace-based but quote-aware: a `deck:"My Deck"` token (with a
// space inside quotes) is kept whole. Pure-TS, unit-testable, no React deps.

/**
 * Split a query string into top-level tokens, keeping `"…"` quoted spans whole
 * (so `deck:"My Deck"` is ONE token, not two). Used to find/replace a token by
 * its `key:` prefix. Parentheses and OR are treated as ordinary tokens — the
 * sidebar only ever adds/replaces simple `key:value` filters.
 */
export function tokenizeQuery(query: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < query.length; i++) {
    const ch = query[i]!;
    if (ch === '"') {
      inQuote = !inQuote;
      cur += ch;
      continue;
    }
    if (!inQuote && (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r')) {
      if (cur) tokens.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/** Wrap a value in double-quotes if it contains whitespace (or is empty). */
export function quoteIfNeeded(value: string): string {
  if (value === '' || /\s/.test(value)) {
    // Escape embedded quotes so the token stays well-formed.
    return `"${value.replace(/"/g, '\\"')}"`;
  }
  return value;
}

/**
 * The `key:` prefix of a token, lowercased, or null for a bareword/grouping
 * token. `deck:"My Deck"` → `deck`, `is:due` → `is`, `hello` → null.
 */
function tokenKey(token: string): string | null {
  const colon = token.indexOf(':');
  if (colon <= 0) return null;
  const key = token.slice(0, colon).toLowerCase();
  // A `:` inside a leading quote isn't a key separator.
  if (token.startsWith('"')) return null;
  return key;
}

/**
 * Insert (or replace) a `key:value` filter in the query. Any existing token with
 * the same `key:` is replaced; otherwise the new token is appended. Used by the
 * sidebar deck/tag/state pickers so re-clicking a deck swaps the `deck:` filter
 * rather than stacking duplicates.
 */
export function addOrReplaceToken(query: string, key: string, value: string): string {
  const token = `${key}:${quoteIfNeeded(value)}`;
  const tokens = tokenizeQuery(query);
  let replaced = false;
  const out: string[] = [];
  for (const t of tokens) {
    if (tokenKey(t) === key.toLowerCase()) {
      if (!replaced) {
        out.push(token);
        replaced = true;
      }
      // drop any further duplicates of the same key
      continue;
    }
    out.push(t);
  }
  if (!replaced) out.push(token);
  return out.join(' ');
}

/**
 * Toggle a complete token in the query. If the exact token is already present it
 * is removed; otherwise it is appended. Comparison is exact (post-trim) so
 * `is:due` toggles independently of `is:new`. Used by the state chips.
 */
export function toggleToken(query: string, token: string): string {
  const target = token.trim();
  const tokens = tokenizeQuery(query);
  if (tokens.includes(target)) {
    return tokens.filter((t) => t !== target).join(' ');
  }
  return [...tokens, target].join(' ');
}
