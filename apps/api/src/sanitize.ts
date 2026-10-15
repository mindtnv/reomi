// HTML sanitizer for explicit HTML callers. Markdown field values use the
// lossless source copier at the bottom of this file. Pinned HTML allowlist:
// (parse5-based, no jsdom — chosen for Bun reliability per Phase 0 / C-3). The
// SAME `SANITIZE_CONFIG` shape is referenced by the Phase 4b tests and the
// client render edge (Phase 5, DOMPurify) so both edges agree on what is allowed.
//
// Field values are untrusted source. The cards.render* columns are a derived
// search cache, NOT a security artifact. Display HTML MUST be sanitized in the
// browser before DOM injection even when source has already been validated.
//
// Allowlist (M1 narrow set + M2 img + rich-content A4):
//   tags:    b i em strong u ul ol li br hr p span div img
//            h1-h6 blockquote pre code a table thead tbody tr th td
//   attrs:   span/div/code/pre → class only; img → src alt width height;
//            a → href (http/https/mailto only)
//   NO:      script style iframe on* (event handlers), javascript:/data: URLs,
//            th/td colspan/rowspan
//   <a>:     invalid-scheme href is DROPPED (attribute), the bare <a> tag is
//            KEPT (sanitize-html default) — the client edge mirrors this.
//   img:     allowed ONLY as the relative token `/m/<uuid>` (M2 Phase 3, plan
//            amendments A1 + C-6). The `src` must match the STRICT canonical
//            UUID token regex below; everything else (absolute URLs,
//            protocol-relative `//evil`, userinfo `@evil`, suffix
//            `media.com.evil`, `data:`/`javascript:`, traversal, malformed
//            36-char tokens) is DROPPED whole by `imgExclusiveFilter`. No
//            scheme is ever allowed on img (`allowedSchemesByTag.img = []`),
//            and `allowProtocolRelative:false` blocks `//host` smuggling.

import sanitizeHtml from 'sanitize-html';

/**
 * The STRICT canonical-UUID relative-token regex (plan C-6). The ONLY shape an
 * `<img src>` may take. Anchored (`^…$`) so no prefix/suffix smuggling. The
 * SAME literal is mirrored on the client edge (`render-card.tsx`). Stored
 * markup keeps this relative token; display resolves it to the authenticated
 * media route. Keep the two literals byte-identical.
 */
export const MEDIA_TOKEN_RE =
  /^\/m\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The pinned allowlist config. Exported so Phase 4b tests + the client edge
 * (Phase 5) can reference the same shape / derive a matching DOMPurify config.
 */
export const SANITIZE_CONFIG: sanitizeHtml.IOptions = {
  // Rich-content allow-list (plan A4/B3): the M1+M2 narrow set PLUS the
  // markdown-generated block/inline tags (h1-h6, blockquote, pre, code, a,
  // table…). This set is BYTE-IDENTICAL to the client edge's ALLOWED_TAGS
  // (apps/web/src/lib/render-card.tsx) — a cross-edge equality test pins it.
  // NO `th/td colspan/rowspan` (markdown tables don't emit them — narrower
  // surface).
  allowedTags: [
    'b', 'i', 'em', 'strong', 'u', 'ul', 'ol', 'li', 'br', 'hr', 'p', 'span', 'div', 'img',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code', 'a',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
  ],
  allowedAttributes: {
    span: ['class'],
    div: ['class'],
    // img carries NO url-bearing attribute beyond `src`, which is gated to the
    // relative media token by `imgExclusiveFilter` (below). width/height are
    // clamped to digits-only by `transformTags` so no non-numeric injection.
    img: ['src', 'alt', 'width', 'height'],
    // code/pre carry `class` for highlight.js token classes (`hljs-*`,
    // `language-*`) — class only, no url-bearing attribute.
    code: ['class'],
    pre: ['class'],
    // <a> carries `href` only, gated to http/https/mailto by
    // allowedSchemesByTag.a below. An invalid scheme drops the attribute and
    // keeps the bare tag (sanitize-html default — the client mirror matches).
    a: ['href'],
  },
  // No schemes are needed for the M1 tags. img is explicitly schemeless
  // (`allowedSchemesByTag.img = []`) — its only legal src is a scheme-LESS
  // relative token. `<a href>` is restricted to http/https/mailto via
  // allowedSchemesByTag.a (mailto rides there, not in the global allowedSchemes).
  // Pin an explicit safe set so a future tag addition can't silently enable
  // javascript:.
  allowedSchemes: ['http', 'https'],
  allowedSchemesByTag: { img: [], a: ['http', 'https', 'mailto'] },
  // Block `//host` protocol-relative URLs from ever passing as a valid src
  // (defense in depth — the exclusiveFilter already rejects them).
  allowProtocolRelative: false,
  // Strip disallowed tags AND their text content for the dangerous structural
  // elements so nothing leaks through as visible text (mXSS hardening).
  disallowedTagsMode: 'discard',
  nonTextTags: ['script', 'style', 'textarea', 'noscript', 'iframe'],
  // No comments (could hide conditional-comment vectors).
  allowVulnerableTags: false,
  // Clamp img width/height to digits-only (sanitize-html keeps numeric attrs as
  // strings; this strips any non-numeric value rather than letting e.g.
  // `width="100 onload=…"`-style residue through). src/alt pass untouched here;
  // src is gated by imgExclusiveFilter.
  transformTags: {
    img: (tagName, attribs) => {
      const out: Record<string, string> = {};
      // Canonicalize src by trimming ASCII whitespace — a browser/DOMPurify trims
      // it before use, so storing the trimmed value keeps the persisted HTML
      // byte-identical with what the client edge produces.
      if (typeof attribs.src === 'string') out.src = attribs.src.trim();
      if (typeof attribs.alt === 'string') out.alt = attribs.alt;
      for (const dim of ['width', 'height'] as const) {
        const v = attribs[dim];
        if (typeof v === 'string' && /^[0-9]+$/.test(v)) out[dim] = v;
      }
      return { tagName, attribs: out };
    },
  },
  // DROP any <img> whose src is not EXACTLY the strict media token. Runs after
  // attribute filtering, so `src` here is the post-allowlist value. Returning
  // true removes the whole element (not just the attribute) — an img with no
  // legal src is useless and a bad-src img must never reach the DOM.
  //
  // We trim leading/trailing ASCII whitespace before matching to stay BYTE-
  // IDENTICAL with the client edge: DOMPurify (and the URL spec a real browser
  // applies) strips such whitespace before the value is ever observed, so
  // `src="  /m/<uuid>"` resolves to our own same-origin media on both edges.
  // Trimming here keeps server/client keep-drop in lockstep; strictness is still
  // proven by the malformed-UUID / traversal / userinfo / suffix corpus cases.
  exclusiveFilter: (frame) => {
    if (frame.tag !== 'img') return false;
    return !MEDIA_TOKEN_RE.test((frame.attribs.src ?? '').trim());
  },
};

/**
 * Sanitize a single note field value (HTML string) against the pinned allowlist.
 * Returns safe HTML with all script / style / iframe / event-handler / unsafe-URL
 * vectors removed. `<img>` survives ONLY when its `src` is the strict relative
 * media token `/m/<uuid>` (see MEDIA_TOKEN_RE); any other img is dropped whole.
 * Non-string input degrades to the empty string.
 */
export function sanitizeFieldHtml(html: string): string {
  if (typeof html !== 'string') return '';
  return sanitizeHtml(html, SANITIZE_CONFIG);
}

/**
 * Preserve Markdown source. This historical name remains for callers, but
 * source text is NOT safe HTML. Markdown renders with html:false and its output
 * must pass through the browser's sanitized render sink. Sanitizing the source
 * as HTML destroys code examples, comparisons and literal markup.
 * Object.fromEntries also preserves own keys such as __proto__ safely.
 */
export function sanitizeFieldValues(
  fieldValues: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(fieldValues).map(([name, value]) => [
    name, typeof value === 'string' ? value : '',
  ]));
}
