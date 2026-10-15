'use client';

// Client render edge for the note-types model (Milestone 1, Phase 5a — plan
// must-fix #1 client edge / C-2).
//
// Display HTML is rendered LAZILY from the note's field values (MARKDOWN source)
// + the note-type template (via the shared pure-TS `renderTemplate`), then
// markdown → HTML, then DOMPurified before it ever touches the DOM. Field values
// are lossless, untrusted Markdown source. html:false keeps literal HTML inert;
// DOMPurify is the mandatory HTML boundary, never optional safe-source polish.
//
// `<SafeHtml>` is the SINGLE place in the web app where `dangerouslySetInnerHTML`
// is allowed. Every HTML render site (review, browser detail panel, note-editor
// preview) goes through it; the browser table renders the stored PLAINTEXT
// columns instead (no HTML, perf + safety).

import React from 'react';
import DOMPurify, { type Config } from 'dompurify';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import bash from 'highlight.js/lib/languages/bash';
import json from 'highlight.js/lib/languages/json';
import sql from 'highlight.js/lib/languages/sql';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import csharp from 'highlight.js/lib/languages/csharp';
import cpp from 'highlight.js/lib/languages/cpp';
import java from 'highlight.js/lib/languages/java';
import { cardClozePlugin, cardMathPlugin, cardMediaPlugin, ClozeSyntaxError, MATH_RE, renderTemplate, type NoteTypeDef, type FieldValues } from '@reomi/shared';


// ── Syntax highlighting (Step 6a, plan A2) ───────────────────────────────────
//
// highlight.js CORE + a fixed SUBSET of languages (no auto-detect bloat / full
// bundle). Output is CLASS-BASED only (`<span class="hljs-*">`) — NEVER
// inline-style (plan Principle 2 forbids `style` in the main allow-list; Shiki
// was rejected for emitting inline styles). The `hljs-*` theme lives in
// `globals.css` (class-based, dark-by-default). The emitted `<span class>` and
// the wrapper `<pre><code class>` both survive the main sanitize: `span`/`pre`/
// `code` are allowed tags and `class` is an allowed attr (Step 4 allow-list).
// hljs emits ONLY `<span class>` for tokens — no tags/attrs outside the allow-list.
//
// `xml` covers HTML markup; aliases (`js`/`ts`/`py`/`sh`/`shell`/`html`/`yml`)
// are registered by the language modules themselves, so ` ```js ` etc. resolve.
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('python', python);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('json', json);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('java', java);

// ── Markdown (Step 5, plan A1a/H3) ───────────────────────────────────────────
//
// Field values are stored as their MARKDOWN SOURCE; markdown → HTML is rendered
// CLIENT-SIDE here, BEFORE the main sanitize (which stays the last line of
// defense — plan A1a). markdown-it config is locked to the safe trio (plan H3):
//   * `html: false`     — a raw HTML tag typed in the source is ESCAPED, never
//                         passed through. The author can only produce the tags
//                         markdown-it GENERATES (a controlled set ⊆ the main
//                         allow-list); arbitrary `<tag>` injection is impossible.
//   * `linkify: false`  — a bare URL in text is NOT auto-linked, so the autolink
//                         surface is exactly the explicit `[text](url)` form;
//                         the scheme is gated by markdown-it's own validateLink
//                         AND, last, by the main `<a href>` hook (B3).
//   * `typographer: false` — no smart-quote / dash substitution (deterministic,
//                         byte-stable output for the idempotency/equality tests).
// A MODULE SINGLETON: one parser instance, reused across every render (no
// per-call allocation). markdown-it is a plain npm package — no Next.js
// `transpilePackages` entry needed.
//
// `highlight` callback (Step 6a, plan A2): markdown-it calls this for every
// fenced code block. It is the PURE-SYNCHRONOUS highlight path (no async, low
// risk). The returned string is inserted as HTML (markdown-it does NOT re-escape
// a non-empty highlight result), then it flows through the main sanitize — the
// `<span class="hljs-*">` tokens survive (span + class are allow-listed), so the
// class-based theme applies. A KNOWN language → class-based hljs highlight; an
// UNKNOWN / missing language → plain ESCAPED `<pre><code>` (never throws, never
// injects). hljs emits only `<span class>` so nothing forbidden reaches the DOM.
// Escape the four HTML special chars for the plain (unknown-language) fenced
// path. Standalone so the `highlight` callback never references `md` inside `md`'s
// own initializer (TS7022/TS7023 circular-any); mirrors markdown-it's escapeHtml.
function escapeFence(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const md = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  highlight: (str, lang): string => {
    // Mermaid (Step 6b): a ` ```mermaid ` fence is NOT highlighted — it is an
    // ASYNC diagram. Returning '' makes markdown-it fall back to its DEFAULT
    // fence renderer, which emits `<pre><code class="language-mermaid">ESCAPED
    // SOURCE</code></pre>`. `extractMermaidBlocks` (post-markdown) finds that
    // exact shape, decodes the source, and swaps the block for an inert
    // placeholder so the `RichCard` wrapper can render it to a sanitized SVG
    // island. Must run BEFORE the hljs path below so mermaid never falls into the
    // plain escaped-code branch (which would lose the `language-mermaid` class).
    if (lang === 'mermaid') return '';
    if (lang && hljs.getLanguage(lang)) {
      try {
        const code = hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
        return `<pre><code class="hljs language-${lang}">${code}</code></pre>`;
      } catch {
        // Fall through to the plain escaped path on any hljs failure — a code
        // block must never break the whole card render.
      }
    }
    // Unknown / missing language: escape the source and wrap it plainly. No
    // hljs spans, no execution — escapeFence neutralizes any HTML special chars
    // in the fence body.
    return `<pre><code>${escapeFence(str)}</code></pre>`;
  },
});

md.use(cardMathPlugin, MATH_RE).use(cardClozePlugin).use(cardMediaPlugin);

// The STRICT canonical-UUID relative-token regex (M2 Phase 3, plan C-6). This is
// the SAME literal as the server edge (`apps/api/src/sanitize.ts` MEDIA_TOKEN_RE)
// and the Next `/m/:uuid` reverse-proxy route — keep all three byte-identical.
// An `<img src>` survives ONLY if it matches this exactly; everything else
// (absolute/protocol-relative/userinfo/suffix URLs, data:/javascript:, traversal,
// malformed 36-char tokens) is dropped.
export const MEDIA_TOKEN_RE =
  /^\/m\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// DOMPurify allowlist MIRRORING the server `SANITIZE_CONFIG`
// (apps/api/src/sanitize.ts): the SAME tag/attr set so both edges agree on what
// is allowed. ALLOWED_TAGS is BYTE-IDENTICAL to the server `allowedTags` (a
// cross-edge equality test pins it): b i em strong u ul ol li br hr p span div
// img h1-h6 blockquote pre code a table thead tbody tr th td. attrs: class +
// img's src/alt/width/height + a's href; NO script/style/iframe/on*.
//
// URL-attribute gating is done by the `uponSanitizeAttribute` hook below (NOT
// the declarative `ALLOWED_URI_REGEXP`, which would clamp EVERY url-ish
// attribute — including <a href> — to the media token and kill links):
//   * `src`  → must be the strict media token `/m/<uuid>`; a non-matching src is
//     dropped, then the `afterSanitizeAttributes` img hook removes the WHOLE
//     srcless img (matching the server edge's exclusiveFilter byte-for-byte —
//     img keep/drop is "drop element").
//   * `href` → must be http(s)/mailto; an invalid scheme drops only the
//     attribute, leaving the bare <a> tag (matching the server edge's
//     allowedSchemesByTag.a — "drop attr, keep tag", NOT element removal).
const SANITIZE_CONFIG: Config = {
  ALLOWED_TAGS: [
    'b', 'i', 'em', 'strong', 'u', 'ul', 'ol', 'li', 'br', 'hr', 'p', 'span', 'div', 'img',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code', 'a',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
  ],
  ALLOWED_ATTR: ['class', 'src', 'alt', 'width', 'height', 'href'],
  // Defense in depth: never keep event handlers / unknown protocols.
  ALLOW_UNKNOWN_PROTOCOLS: false,
  // Return a plain string (we feed it to dangerouslySetInnerHTML ourselves).
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
};

// Register the img-drop hook ONCE per module load (guarded so HMR / repeated
// imports never stack duplicate hooks). After DOMPurify finishes attribute
// filtering on a node, an <img> that lost its src (because the token failed
// ALLOWED_URI_REGEXP) — or never had a valid one — is removed whole. This is the
// client mirror of the server `exclusiveFilter`: a bad-src img must not reach the
// DOM at all, not even as a srcless element.
const NN_IMG_HOOK = '__nnImgTokenHookRegistered';
type HookFlaggedDOMPurify = typeof DOMPurify & { [NN_IMG_HOOK]?: boolean };
if (typeof DOMPurify.addHook === 'function' && !(DOMPurify as HookFlaggedDOMPurify)[NN_IMG_HOOK]) {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if ((node as Element).tagName?.toLowerCase() !== 'img') return;
    const el = node as Element;
    // DOMPurify already trims ASCII whitespace from attribute values (the URL
    // spec a browser applies), so this is the same normalized value the server
    // edge tests after `.trim()` — keeping keep/drop byte-identical.
    const src = el.getAttribute('src') ?? '';
    if (!MEDIA_TOKEN_RE.test(src)) {
      el.remove();
      return;
    }
    // Clamp width/height to digits-only, MIRRORING the server's
    // transformTags.img (`/^[0-9]+$/`). A real browser's parser splits
    // `width="100 onload=…"` into a numeric width + a stray onload attribute
    // (which DOMPurify drops); but a forgiving parser (e.g. happy-dom) keeps the
    // whole string as the width value. Dropping any non-numeric width/height
    // here matches the server edge byte-for-byte and ensures no event-handler
    // residue can ride a dimension attribute on EITHER engine.
    for (const dim of ['width', 'height'] as const) {
      const v = el.getAttribute(dim);
      if (v !== null && !/^[0-9]+$/.test(v)) el.removeAttribute(dim);
    }
  });
  (DOMPurify as HookFlaggedDOMPurify)[NN_IMG_HOOK] = true;
}

// Register the per-attribute url-scheme hook ONCE per module load (guarded so
// HMR / repeated imports never stack duplicates, like the img hook above). This
// REPLACES the old declarative `ALLOWED_URI_REGEXP: MEDIA_TOKEN_RE` (which would
// clamp <a href> to the media token and break links). It branches on attribute
// name (plan B3), keeping the two edges in lockstep on keep/drop:
//   * `src`  (img): a non-token src is dropped here; the `afterSanitizeAttributes`
//     img hook above then removes the now-srcless <img> ENTIRELY — img stays
//     "drop element", mirroring the server exclusiveFilter byte-for-byte.
//   * `href` (a): an invalid scheme drops ONLY the attribute; DOMPurify leaves
//     the bare <a> tag — mirroring the server's allowedSchemesByTag.a ("drop
//     attr, keep tag"). NEVER remove the element.
// Order: uponSanitizeAttribute (per-attribute, DURING) runs before
// afterSanitizeAttributes (per-node, AFTER), so the img element is removed only
// after its bad src has been stripped.
const NN_ATTR_HOOK = '__nnUrlAttrHookRegistered';
type AttrHookFlaggedDOMPurify = typeof DOMPurify & { [NN_ATTR_HOOK]?: boolean };
const HREF_SCHEME_RE = /^(?:https?:|mailto:)/i;
if (typeof DOMPurify.addHook === 'function' && !(DOMPurify as AttrHookFlaggedDOMPurify)[NN_ATTR_HOOK]) {
  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName === 'src') {
      // DOMPurify trims ASCII whitespace before the hook sees the value, so this
      // matches the server edge's post-`.trim()` test of the media token.
      if (!MEDIA_TOKEN_RE.test(data.attrValue)) data.keepAttr = false;
    } else if (data.attrName === 'href') {
      if (!HREF_SCHEME_RE.test(data.attrValue)) data.keepAttr = false;
    }
  });
  (DOMPurify as AttrHookFlaggedDOMPurify)[NN_ATTR_HOOK] = true;
}

// Register the SVG url-reference clamp hook ONCE (guarded like the hooks above).
// This REPLACES the declarative `ALLOWED_URI_REGEXP: /^(?:#|url\(#)/` that USED to
// live on `MERMAID_DOMPURIFY_CONFIG`. That regex was the right INTENT (a functional
// `url(...)` ref may only point at a LOCAL fragment — arrowhead markers / gradients
// — never `url(http…)` / `javascript:` / `data:`) but the WRONG mechanism: DOMPurify
// matches `ALLOWED_URI_REGEXP` against EVERY attribute value, so it silently dropped
// all SVG GEOMETRY (`viewBox`, `width="100%"`, `x`/`y`/`width`/`height`, `d`,
// `transform`, …) — none of which look like `url(#…)`. A geometry-less SVG has no
// coordinate system, so mermaid diagrams collapsed to the 300×150 default and
// rendered as a thin strip. Scoping the clamp to the url-BEARING attribute NAMES
// keeps geometry intact while preserving the local-only `url()` guarantee. The hook
// is global but no-ops for every non-SVG sink (the main card + KaTeX configs never
// emit these attribute names). `xlink:href` stays handled by `FORBID_ATTR`.
const SVG_URL_REF_ATTRS = new Set([
  'marker-start', 'marker-mid', 'marker-end',
  'fill', 'stroke', 'clip-path', 'mask', 'filter', 'cursor',
]);
const LOCAL_URL_REF_RE = /^url\(\s*['"]?#[^)'"]*['"]?\s*\)$/i;
const NN_SVG_URL_HOOK = '__nnSvgUrlRefHookRegistered';
type SvgUrlHookFlaggedDOMPurify = typeof DOMPurify & { [NN_SVG_URL_HOOK]?: boolean };
if (typeof DOMPurify.addHook === 'function' && !(DOMPurify as SvgUrlHookFlaggedDOMPurify)[NN_SVG_URL_HOOK]) {
  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (!SVG_URL_REF_ATTRS.has(data.attrName)) return;
    const v = (data.attrValue ?? '').trim();
    // A functional `url(...)` reference is allowed ONLY if it points at a local
    // fragment; a plain value (color `#eaeaea`, `none`, a paint keyword) is fine.
    if (/url\(/i.test(v) && !LOCAL_URL_REF_RE.test(v)) data.keepAttr = false;
  });
  (DOMPurify as SvgUrlHookFlaggedDOMPurify)[NN_SVG_URL_HOOK] = true;
}

// ── KaTeX math render (M2 Phase 5, plan A3/A4/C-5 + Principle 5) ─────────────
//
// KaTeX output is UNTRUSTED HTML and is DOMPurified before injection. This config
// is INTENTIONALLY separate from (and never widens) `SANITIZE_CONFIG`: KaTeX
// emits `<span class style>` only (with `output:'html'` there is NO
// `<math>`/`<annotation>`/`<svg>` namespace-confusion surface — Phase 0). `style`
// is permitted HERE AND ONLY HERE; DOMPurify's built-in CSS sanitizer blocks the
// dangerous primitives (`position:fixed`, `url(...)`, `expression(...)`) so the
// inline styles KaTeX needs (height/vertical-align/margins) survive while an
// injection attempt does not (DOMPurify 3.4.8).
const KATEX_DOMPURIFY_CONFIG: Config = {
  ALLOWED_TAGS: ['span'],
  ALLOWED_ATTR: ['class', 'style'],
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
};

// ── Mermaid SVG sink (Step 6b, plan A3a/H4 + Principle 2/3) ──────────────────
//
// Mermaid renders a diagram to an SVG string client-side (async, lazy-loaded in
// the `RichCard` wrapper). That SVG is UNTRUSTED HTML and is run through THIS
// dedicated DOMPurify config — INTENTIONALLY separate from (and never widening)
// the main `SANITIZE_CONFIG`, exactly like `KATEX_DOMPURIFY_CONFIG`. The result
// is a safe SVG island that the main sanitize NEVER sees (it is substituted into
// the single `SafeHtml` sink AFTER the main sanitize has run — `<svg>` is NOT in
// the main allow-list, so injecting it before would get it stripped).
//
//   * `USE_PROFILES: { svg, svgFilters }` — turns on the SVG element/attr
//     namespace (the main config is HTML-only). svgFilters keeps `<filter>`/
//     `<feGaussianBlur>` etc. that mermaid uses for shadows.
//   * `FORBID_TAGS: foreignObject/script/a` — `foreignObject` is the SVG→HTML
//     escape hatch (XSS) and `script` is an obvious sink (both also live in
//     DOMPurify's `svgDisallowed` set), and a bare `<a>` inside a diagram is
//     dropped (no in-diagram navigation surface). `<style>` is DELIBERATELY NOT
//     forbidden: mermaid v11 emits the whole diagram THEME (node/edge/label
//     fill + stroke + text color) as a scoped `<style>#<id>{…}</style>` block
//     INSIDE the SVG — forbidding it stripped every color and rendered an
//     invisible diagram (empty box). `style` is in DOMPurify's `svg` tag profile,
//     so simply NOT listing it here is enough to keep it; DOMPurify's built-in CSS
//     sanitizer still neutralizes the dangerous primitives (`@import`,
//     `url(http…)`, `expression(...)`, `position:fixed`) inside the block, so the
//     scoped theme is safe. Diagram LABELS stay native SVG `<text>` (never
//     `foreignObject`) because the `RichCard` wrapper initializes mermaid with
//     `htmlLabels:false` — so forbidding `foreignObject` no longer drops text.
//   * `FORBID_ATTR: xlink:href` — kills external/`javascript:` links riding the
//     legacy xlink namespace.
//   * NO `ALLOWED_URI_REGEXP` — DOMPurify matches it against EVERY attribute
//     value, so a `url(#…)`-only regex stripped all SVG GEOMETRY (`viewBox`,
//     `width="100%"`, `x`/`y`/`width`/`height`, `d`, `transform`) and collapsed
//     every diagram to the 300×150 default (rendered as a thin strip). The
//     local-only `url()` clamp now lives in the scoped `SVG_URL_REF_ATTRS` hook
//     above — applied by attribute NAME, so geometry is untouched. Without a
//     custom regex DOMPurify's DEFAULT URI check applies, which does NOT catch
//     `marker-end="url(javascript:…)"`; that is exactly what the hook covers.
//   * `ADD_ATTR: marker-start/marker-end` — DOMPurify's stock SVG profile does
//     NOT allow-list these presentation-marker attributes, so without this the
//     CORRECTNESS gate `marker-end="url(#arrow)"` would be dropped and every
//     arrowed diagram would lose its arrowheads (plan N5 fallback). They stay
//     clamped to local `url(#id)` by the SVG_URL_REF_ATTRS hook above.
const MERMAID_DOMPURIFY_CONFIG: Config = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: ['foreignObject', 'script', 'a'],
  FORBID_ATTR: ['xlink:href'],
  ADD_ATTR: ['marker-end', 'marker-start'],
  RETURN_DOM: false,
  RETURN_DOM_FRAGMENT: false,
};

/**
 * Sanitize a mermaid-rendered SVG string with the dedicated mermaid-only sink.
 * Exported so the corpus test can assert the exact SVG bypass behavior (the live
 * sink is applied inside `RichCard`; this is the string operation it performs on
 * the raw mermaid SVG before it reaches the single `SafeHtml` inject node).
 */
export function sanitizeMermaidSvg(svg: string): string {
  return DOMPurify.sanitize(svg ?? '', MERMAID_DOMPURIFY_CONFIG) as unknown as string;
}

// Marker frame for island placeholders (KaTeX-stash + raw-math). Each island /
// raw-math source is stashed behind a placeholder so the markdown pass + the main
// sanitize can't touch it, then restored 1:1 afterwards — preserving idempotency
// (the `resanitize` re-pass `<SafeHtml>` runs leaves rendered KaTeX intact) and
// the single-sink invariant.
//
// HARDENING (validation fix #6): the placeholder prefix is PER-RENDER-UNIQUE,
// minted from crypto.getRandomValues() at the start of each render. Unlike
// randomUUID(), this is available on private-network HTTP previews as well.
// Because the prefix
// differs every render, author input can never alias a key.
//
// Step 5 change: the placeholder is now ALSO markdown-it-safe. The old token was
// NUL-prefixed (` \x00nnkatex-… `), but markdown-it's `normalize` core rule
// REPLACES every NUL with U+FFFD as a security measure — which would corrupt the
// token and break restore. The new format is
// `nnph<uuid-no-dashes><kind><n><TERM>`: lowercase letters + hex digits only, so
// it is (a) HTML-inert (no '<'), (b) regex-inert (no metacharacters), (c)
// math-delimiter-inert (no backslash-paren/bracket), (d) markdown-inert (a bare
// alnum word — no markdown syntax, never autolinked with linkify:false), and (e)
// NUL-free so markdown-it passes it through verbatim. The per-render UUID still
// makes it non-aliasable by author input. `s<n>` keys hold stashed KaTeX islands;
// `m<n>` keys hold raw-math sources; `d<n>` keys hold mermaid blocks — distinct
// infixes so the kinds never collide within one render.
//
// PLACEHOLDER_TERM (correctness fix): a non-digit terminator letter appended to
// EVERY key so that no key is a string PREFIX of another. Restore is
// `out.split(key).join(value)`; without the terminator `m1` (the literal prefix
// of `m10`) would split INSIDE the `m10` placeholder, corrupting the 11th+ island
// of any kind (math/mermaid/KaTeX) on one side. With the terminator the keys are
// `m1z` and `m10z` — `m1z` is NOT a substring of `m10z` (they diverge at the 3rd
// char: `z` vs `0`), so split is unambiguous regardless of restore order. The
// terminator is a bare lowercase letter inside the UUID-like token: HTML-/regex-/
// markdown-inert and NUL-free, so it rides through markdown-it + the main sanitize
// verbatim exactly like the rest of the key.
const PLACEHOLDER_TERM = 'z';
function newPlaceholderPrefix(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `nnph${Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Render one LaTeX formula to KaTeX HTML and DOMPurify the result with the
 * KaTeX-only allowlist. `trust:false` + `strict:'ignore'`
 * neutralize `\href{javascript:}`/`\includegraphics`/`\htmlData` at the KaTeX
 * layer; the DOMPurify pass is defense-in-depth (Principle 5). Returns a SAFE
 * `<span class="katex">…` string — already sanitized, never re-run through the
 * main config.
 */
function renderOneMath(formula: string, display: boolean): string | null {
  let rendered: string;
  try {
    rendered = katex.renderToString(formula, {
      output: 'html',
      displayMode: display,
      trust: false,
      strict: 'ignore',
      throwOnError: true,
    });
  } catch {
    // Preserve the source in a diagnostic island rather than dropping the formula.
    return null;
  }
  return DOMPurify.sanitize(rendered, KATEX_DOMPURIFY_CONFIG);
}

/** One stashed raw-math source: its inner LaTeX + whether it is display mode. */
type RawMath = { source: string; display: boolean; field: string; block: number };

/** One stashed mermaid source: its raw (HTML-entity-decoded) diagram text. */
export type ContentBlock = { key: string; source: string; field: string; block: number };
export type MermaidSource = ContentBlock;

// markdown-it default fence renderer for a ` ```mermaid ` block (the highlight
// callback returns '' for `mermaid`, so the default fence path runs) →
// `<pre><code class="language-mermaid">ESCAPED SOURCE</code></pre>`. Captured
// group 1 = the HTML-entity-escaped diagram source. The class attribute order is
// markdown-it's own (deterministic), so this exact shape is stable.
const MERMAID_BLOCK_RE =
  /<pre><code class="language-mermaid">([\s\S]*?)<\/code><\/pre>/g;

// Decode the FOUR HTML entities markdown-it's escapeHtml produces (the inverse of
// `escapeFence`/markdown-it escapeHtml) to recover the verbatim mermaid source.
// Order matters: `&amp;` LAST so an escaped `&lt;` is not double-decoded.
function decodeFenceEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/**
 * Detect every markdown-rendered mermaid block in a per-field HTML fragment,
 * replace each with an inert per-render placeholder (markdown-/HTML-/sanitize-
 * inert, like the math placeholders — survives `renderTemplate` substitution AND
 * the whole-card main sanitize as plain text), and append `{ key, source }` to
 * the shared `blocks` array. The decoded source is what `mermaid.render` consumes
 * later inside the async `RichCard` wrapper.
 *
 * Runs AFTER `md.render` (step 3 of `renderFieldMarkdown`): the fence only exists
 * once markdown has produced the `<pre><code class="language-mermaid">` shape.
 */
function stashMermaid(html: string, prefix: string, blocks: MermaidSource[], field: string): string {
  let block = 0;
  const re = new RegExp(MERMAID_BLOCK_RE.source, 'g');
  return html.replace(re, (_full, escaped: string) => {
    const key = `${prefix}d${blocks.length}${PLACEHOLDER_TERM}`;
    blocks.push({ key, source: decodeFenceEntities(escaped), field, block: ++block });
    return key;
  });
}

// Stash every ALREADY-rendered KaTeX island (a `<span class="katex…">…</span>`
// whose `</span>` is found by balancing nested `<span>`s — NOT a fragile
// closing-tag regex, since KaTeX nests many spans). Returns the placeholdered
// string + the island map. This makes the `resanitize` re-pass IDEMPOTENT: when
// `renderCardHtml`'s already-rendered output flows through `<SafeHtml>`, the
// islands are protected from the main sanitize (which forbids the
// `style`/`aria-hidden` KaTeX needs) and restored verbatim. Each stashed island
// was itself produced by `renderOneMath` (KaTeX-DOMPurified), so it is safe.
const KATEX_OPEN_RE = /<span class="katex(?:-display)?"[^>]*>/g;
function stashRenderedKatex(
  html: string,
  prefix: string,
): { text: string; islands: Map<string, string> } {
  const islands = new Map<string, string>();
  let out = '';
  let cursor = 0;
  const openRe = new RegExp(KATEX_OPEN_RE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(html)) !== null) {
    // Balance <span>…</span> from the opener to find the island's true end.
    let depth = 0;
    let i = m.index;
    const tagRe = /<\/?span\b[^>]*>/g;
    tagRe.lastIndex = m.index;
    let t: RegExpExecArray | null;
    let end = -1;
    while ((t = tagRe.exec(html)) !== null) {
      depth += t[0].startsWith('</') ? -1 : 1;
      if (depth === 0) {
        end = t.index + t[0].length;
        break;
      }
    }
    if (end < 0) break; // unbalanced — leave the rest untouched
    out += html.slice(cursor, i);
    const key = `${prefix}s${islands.size}${PLACEHOLDER_TERM}`;
    islands.set(key, html.slice(i, end));
    out += key;
    cursor = end;
    openRe.lastIndex = end;
  }
  out += html.slice(cursor);
  return { text: out, islands };
}

/**
 * Render ONE field value (markdown source) → HTML, the H2-ordered way, stashing
 * its raw math into the shared `sources` map (restored to KaTeX at the END, after
 * the whole-card sanitize). Steps:
 *
 *   1. Parse math into inert placeholders as Markdown syntax, outside code,
 *      before the default escape rule consumes its delimiters.
 *   2. MARKDOWN → HTML (markdown-it singleton, html:false/linkify:false). A raw
 *      HTML tag typed into the FIELD is escaped (only the markdown-generated tags
 *      survive). The placeholders ride through as plain text.
 *   3. STASH mermaid blocks (Step 6b): markdown emits ` ```mermaid ` as
 *      `<pre><code class="language-mermaid">…</code></pre>`; swap each for an inert
 *      placeholder + collect the decoded source for the async `RichCard` island.
 *
 * Markdown is applied PER FIELD VALUE, NOT to the note-type TEMPLATE: the template
 * is trusted HTML STRUCTURE (`{{Front}}<hr>{{Back}}`, custom-type wrapper markup),
 * and must NOT be markdown-escaped. So the rendered field HTML is substituted into
 * the template by `renderTemplate`, then the whole card is sanitized once — see
 * `renderCardHtml`.
 */
function renderFieldMarkdown(
  value: string,
  field: string,
  prefix: string,
  sources: Map<string, RawMath>,
  mermaid: MermaidSource[],
  cloze?: { side: 'front' | 'back'; number: number; legacy?: boolean },
): string {
  let block = 0;
  // Math participates in inline parsing; code and URL contents remain literal.
  const rendered = md.render(value ?? '', {
    cloze,
    renderMath(source: string, display: boolean) {
      const key = `${prefix}m${sources.size}${PLACEHOLDER_TERM}`;
      sources.set(key, { source, display, field, block: ++block });
      return key;
    },
  });
  // 3. stash mermaid blocks → inert placeholders (async RichCard island swap).
  return stashMermaid(rendered, prefix, mermaid, field);
}

/**
 * The IDEMPOTENT defensive re-sanitize that `<SafeHtml>` applies to its prop. It
 * is NOT a from-source render: markdown + math were already applied ONCE by
 * `renderCardHtml`. Running markdown again here would ESCAPE the already-rendered
 * `<p>`/`<h1>`/`<strong>` (markdown-it `html:false`), so this path instead:
 *
 *   1. STASHes the already-rendered KaTeX islands (so the main sanitize cannot
 *      strip the `style`/`aria-hidden` KaTeX needs),
 *   2. runs the MAIN SANITIZE (defense-in-depth — a caller passing un-sanitized
 *      HTML still cannot introduce an XSS sink),
 *   3. RESTOREs the islands verbatim.
 *
 * `renderCardHtml`'s output flows through this unchanged (the allowed tags survive
 * the sanitize, the islands are protected), so the single-sink invariant holds and
 * double-injection is impossible.
 *
 * Exported so tests can assert the EXACT SafeHtml re-pass (the public sink is a
 * React component; this is the string operation it performs on its prop).
 */
export function resanitize(html: string): string {
  const prefix = newPlaceholderPrefix();
  const { text: stashed, islands } = stashRenderedKatex(html ?? '', prefix);
  let out = DOMPurify.sanitize(stashed, SANITIZE_CONFIG);
  for (const [key, value] of islands) out = out.split(key).join(value);
  return out;
}

/**
 * Sanitize an arbitrary HTML string against the pinned allowlist (no markdown /
 * math pass). The ONLY raw-allowlist sanitizer entry point on the client. `<img>`
 * survives only as the strict relative media token `/m/<uuid>`; any other img is
 * dropped whole. Use `renderCardHtml` (via `<SafeHtml>`) for the display path that
 * also renders markdown + LaTeX.
 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html ?? '', SANITIZE_CONFIG);
}

/** The full render result: the safe HTML + the mermaid sources still pending. */
export interface RenderedCard {
  error?: 'invalid_cloze';
  /** Visible invalid formulas only; hidden answer fields never produce diagnostics. */
  mathErrors?: ContentBlock[];
  /**
   * Safe HTML with KaTeX restored and mermaid blocks left as INERT placeholders
   * (one per `mermaid[n].key`). The `RichCard` wrapper swaps each placeholder for
   * a sanitized SVG island AFTER the main sanitize, inside the single `SafeHtml`
   * sink (`<svg>` is not in the main allow-list, so it must be injected post-
   * sanitize — see the mermaid-islands prop on `SafeHtml`).
   */
  html: string;
  /** The mermaid diagram sources awaiting async render (empty for most cards). */
  mermaid: MermaidSource[];
}

/**
 * Render one side of a card from the note-type template + the note's field values
 * (markdown source), returning the safe HTML AND the still-pending mermaid
 * sources. This is the SINGLE pipeline owner (plan H1/CR1.3): `renderCardHtml`
 * (string-only, mermaid restored as code) and the async `RichCard` wrapper both
 * call THIS — no second place collects mermaid sources, so the two can never
 * drift. The H2-ordered pipeline (plan A1a/H2/H3 + 6a + 6b):
 *
 *   1. Render EACH field value markdown → HTML (`renderFieldMarkdown`), stashing
 *      its raw math into a shared `sources` map AND its mermaid blocks into the
 *      shared `mermaid` array. Markdown is applied to the FIELD VALUES, never to
 *      the note-type TEMPLATE (trusted HTML structure — `{{Front}}<hr>{{Back}}`,
 *      custom wrapper markup — must not be markdown-escaped). markdown-it
 *      `html:false` still escapes raw HTML typed INTO a field.
 *   2. Substitute the rendered fields into the template via `renderTemplate`
 *      (cloze blank/reveal per `side`). The math + mermaid placeholders ride
 *      through substitution as plain text.
 *   3. MAIN SANITIZE the whole card (last line of defense). Template HTML + the
 *      markdown-generated field tags pass the allow-list; both placeholder kinds
 *      survive as inert text.
 *   4. RESTORE math: each math placeholder → `renderOneMath` (KaTeX render +
 *      KaTeX-DOMPurify, never re-run through the main config). Mermaid placeholders
 *      are LEFT for the async `RichCard` swap (or restored to a code block by
 *      `renderCardHtml`).
 *
 * `templateOrd` selects which template generates the card (defaults to 0 — the
 * first / only template for the three builtins).
 */
export function renderCardHtmlWithMermaid(
  noteType: Pick<NoteTypeDef, 'kind' | 'templates'>,
  fieldValues: FieldValues,
  side: 'front' | 'back',
  templateOrd = 0,
  clozeNumber: number | null = 0,
): RenderedCard {
  const template =
    noteType.templates.find((tpl) => tpl.ord === templateOrd) ?? noteType.templates[0];
  if (!template) return { html: '', mermaid: [] };
  const tpl = side === 'front' ? template.frontTemplate : template.backTemplate;
  // One per-render-unique prefix shared across every field so keys never collide.
  // A fresh UUID each render means no author-typeable string can alias a key.
  const prefix = newPlaceholderPrefix();
  const mathSources = new Map<string, RawMath>();
  const mermaid: MermaidSource[] = [];
  // 1. markdown-render each field value (NOT the template); stash math + mermaid.
  let renderedFields: FieldValues;
  try {
    renderedFields = Object.fromEntries(Object.entries(fieldValues).map(([name, value]) => [name,
      renderFieldMarkdown(value ?? '', name, prefix, mathSources, mermaid, noteType.kind === 'cloze' ? { side, number: clozeNumber ?? 0, legacy: !clozeNumber } : undefined),
    ]));
  } catch (error) {
    if (error instanceof ClozeSyntaxError) return { html: '', mermaid: [], error: 'invalid_cloze' };
    throw error;
  }
  // 2. substitute rendered fields into the trusted template HTML (+ cloze rewrite).
  const templated = renderTemplate(tpl, renderedFields, {
    side,
    cloze: false,
  });
  // 3. main sanitize the whole card (last line of defense).
  let out = DOMPurify.sanitize(templated, SANITIZE_CONFIG);
  // 4. restore math: placeholder → KaTeX island (rendered + KaTeX-DOMPurified).
  const mathErrors: ContentBlock[] = [];
  for (const [key, { source, display, field, block }] of mathSources) {
    if (!out.includes(key)) continue;
    const rendered = renderOneMath(source, display);
    if (rendered === null) mathErrors.push({ key, source, field, block });
    else out = out.split(key).join(rendered);
  }
  // Mermaid placeholders are intentionally LEFT in `out` — the async RichCard
  // wrapper swaps them for sanitized SVG islands; `renderCardHtml` restores them
  // to a code block for the non-async callers.
  return { html: out, mathErrors, mermaid: mermaid.filter(({ key }) => out.includes(key)) };
}

/**
 * Render one side of a card's HTML — the string-only entry point used by every
 * synchronous caller (preview empty-checks, plaintext fallbacks, tests). Mermaid
 * blocks (async) are NOT rendered here: each placeholder is restored to a plain
 * `<pre><code class="language-mermaid">SOURCE</code></pre>` code block (the
 * diagram source shown verbatim), so a non-`RichCard` sink still shows sensible
 * content and stays idempotent through the `SafeHtml` re-pass. Use `RichCard`
 * (which calls `renderCardHtmlWithMermaid`) for the live diagram render.
 *
 * Returns a SAFE HTML string ready for `<SafeHtml>` (whose `resanitize` defensive
 * re-pass leaves this output unchanged — idempotent single sink).
 */
export function renderCardHtml(
  noteType: Pick<NoteTypeDef, 'kind' | 'templates'>,
  fieldValues: FieldValues,
  side: 'front' | 'back',
  templateOrd = 0,
  clozeNumber: number | null = 0,
): string {
  const { html, mermaid, mathErrors = [] } = renderCardHtmlWithMermaid(noteType, fieldValues, side, templateOrd, clozeNumber);
  let out = html;
  for (const { key, source } of mathErrors) out = out.split(key).join(`<code>${escapeFence(source)}</code>`);
  for (const { key, source } of mermaid) {
    out = out.split(key).join(`<pre><code class="language-mermaid">${escapeFence(source)}</code></pre>`);
  }
  return out;
}

/**
 * Substitute mermaid SVG islands into a string AFTER the main sanitize. Exported
 * so the corpus test can prove the post-sanitize swap restores an SVG that the
 * main sanitize would otherwise have stripped (`<svg>` is not in the main
 * allow-list). Each value is ALREADY `sanitizeMermaidSvg`-clean.
 */
export function restoreMermaidIslands(html: string, islands: Map<string, string>): string {
  let out = html;
  for (const [key, svg] of islands) out = out.split(key).join(svg);
  return out;
}

export interface SafeHtmlProps extends React.HTMLAttributes<HTMLDivElement> {
  hostRef?: React.RefObject<HTMLDivElement | null>;
  /** Pre-sanitized OR raw HTML — it is sanitized here regardless. */
  html: string;
  /**
   * Optional map of mermaid placeholder-key → ALREADY-SANITIZED SVG island
   * (produced by `sanitizeMermaidSvg` in the `RichCard` wrapper). Substituted in
   * AFTER `resanitize` (the main sanitize) — `<svg>` is NOT in the main allow-list,
   * so injecting it before would strip it; substituting after keeps the single
   * inject node while letting the dedicated mermaid sink own the SVG safety. Any
   * placeholder with no island yet stays as inert text (a brief "loading" state).
   */
  mermaidIslands?: Map<string, string>;
}

/**
 * The ONE component allowed to use `dangerouslySetInnerHTML`. The `html` prop is
 * always run through the idempotent defensive `resanitize` pass (main DOMPurify
 * with the KaTeX islands protected) immediately before injection, so even a caller
 * passing un-sanitized HTML cannot introduce an XSS sink. Markdown + LaTeX are
 * rendered ONCE upstream by `renderCardHtml`; `resanitize` does NOT re-run
 * markdown, so passing `renderCardHtml`'s already-rendered output leaves it (and
 * the KaTeX islands) intact.
 *
 * `mermaidIslands` (Step 6b) are substituted AFTER `resanitize` so the SVG —
 * produced and DOMPurified by the dedicated mermaid sink in `RichCard` — is never
 * stripped by the main allow-list (which has no `<svg>`). This keeps the single
 * inject node: there is still exactly ONE `dangerouslySetInnerHTML`.
 */
export const SafeHtml = ({ html, mermaidIslands, hostRef, ...rest }: SafeHtmlProps) => {
  // `nn-rendered` applies the shared img/inline-code display CSS (globals.css) to
  // every render site that flows through this single sink. Merge defensively so a
  // caller-provided className isn't clobbered; placed AFTER the `...rest` spread so
  // it always wins over (and absorbs) any `rest.className`.
  let injected = resanitize(html);
  if (mermaidIslands && mermaidIslands.size > 0) {
    injected = restoreMermaidIslands(injected, mermaidIslands);
  }
  return (
    <div
      {...rest}
      ref={hostRef}
      className={`nn-rendered ${rest.className ?? ''}`.trim()}
      dangerouslySetInnerHTML={{ __html: injected }}
    />
  );
};
