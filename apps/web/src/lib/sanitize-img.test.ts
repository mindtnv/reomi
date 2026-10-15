// Two-engine bypass corpus — CLIENT edge (M2 Phase 3, plan A2 + C-6).
//
// This is the FIRST test to actually EXECUTE the client DOMPurify config in
// `render-card.tsx` (M1 only asserted a hardcoded list, never ran DOMPurify). It
// registers a happy-dom global DOM so `dompurify` has a `window`, then runs the
// SAME shared corpus (apps/api/tests/sanitize-img-corpus.ts) through the client
// `sanitizeHtml`. The server edge runs the identical corpus in
// apps/api/tests/sanitize-img.test.ts — the `keep`/`mustNotContain` expectations
// live in the shared module, so the two edges are asserted byte-identical in
// keep/drop by construction.
//
// IMPORTANT: the DOM must be registered (and the happy-dom nodeName getter
// repaired) BEFORE importing render-card, because dompurify captures `window` and
// caches `Node.prototype.nodeName` at module-eval time. `test-dom-setup` does
// both as an import side effect, so it MUST be the first import here.

import { ensureTestDom, GlobalRegistrator } from './test-dom-setup.ts';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
beforeAll(ensureTestDom);
import { readFileSync } from 'node:fs';
import {
  IMG_CORPUS,
  MXSS_CORPUS,
  VALID_TOKEN,
  isNeutralized,
  keptImg,
} from '../../../api/tests/sanitize-img-corpus.ts';
// Register before the first DOMPurify module evaluation, even after another suite tears down the cached bootstrap.
ensureTestDom();
const {
  renderCardHtml,
  renderCardHtmlWithMermaid,
  resanitize,
  restoreMermaidIslands,
  sanitizeHtml,
  sanitizeMermaidSvg,
} = await import('./render-card.tsx');
import type { NoteTypeDef } from '@reomi/shared';

// A minimal basic note-type whose front template is the raw field, so a test can
// drive the FULL markdown + math + sanitize pipeline (`renderCardHtml`) directly.
const mdBasic: Pick<NoteTypeDef, 'kind' | 'templates'> = {
  kind: 'basic',
  templates: [{ name: 'Card 1', ord: 0, frontTemplate: '{{Front}}', backTemplate: '{{Back}}' }],
};
const mdFront = (src: string): string => renderCardHtml(mdBasic, { Front: src, Back: '' }, 'front');

afterAll(async () => {
  // `GlobalRegistrator` is a cross-file singleton: another DOM-using test file in
  // the same `bun test` run (e.g. render-math.test.ts) may already have
  // unregistered it. Guard so this teardown never throws on an already-clean
  // global regardless of file execution order.
  try {
    await GlobalRegistrator.unregister();
  } catch {
    /* already unregistered by another suite — fine */
  }
});

describe('client DOMPurify actually executes under happy-dom', () => {
  test('a real DOM is registered', () => {
    expect(typeof window).toBe('object');
    expect(typeof document).toBe('object');
  });

  // Sentinel: if DOMPurify were a no-op (no DOM), a disallowed tag would survive.
  // Proving it is stripped proves DOMPurify ran.
  test('DOMPurify is live: a disallowed <script> is stripped', () => {
    const out = sanitizeHtml('<p>ok</p><script>alert(1)</script>');
    expect(out.toLowerCase()).not.toContain('<script');
    expect(out).toContain('ok');
  });
});

describe('sanitizeHtml — img relative-token corpus (client edge)', () => {
  for (const c of IMG_CORPUS) {
    test(`${c.keep ? 'KEEP' : 'DROP'}: ${c.label}`, () => {
      const out = sanitizeHtml(c.input);
      expect(keptImg(out)).toBe(c.keep);
      for (const banned of c.mustNotContain) {
        expect(out.toLowerCase()).not.toContain(banned);
      }
    });
  }

  test('a kept img carries the valid token as src', () => {
    const out = sanitizeHtml(`<img src="${VALID_TOKEN}">`);
    expect(out).toContain(VALID_TOKEN);
  });

  test('a kept img with injected onerror keeps src, drops onerror', () => {
    const out = sanitizeHtml(`<img src="${VALID_TOKEN}" onerror=alert(1)>`);
    expect(keptImg(out)).toBe(true);
    expect(out).toContain(VALID_TOKEN);
    expect(out.toLowerCase()).not.toContain('onerror');
  });
});

describe('M1 mXSS corpus stays neutralized with img allowed (client edge)', () => {
  for (const vector of MXSS_CORPUS) {
    test(`neutralizes: ${vector.slice(0, 50)}`, () => {
      expect(isNeutralized(sanitizeHtml(vector))).toBe(true);
    });
  }
});

// ── Editor-rework gating spike: the CLIENT-edge halves of the size/code
// invariants (server halves live in apps/api/tests/sanitize.test.ts). The client
// DOMPurify config uses a FLAT ALLOWED_ATTR (class/src/alt/width/height), so it
// applies `class` to ANY tag — including <img>. That is the source of the
// documented server-strip / client-keep `img.class` ASYMMETRY.
describe('sanitizeHtml — editor-rework size/code invariants (client edge)', () => {
  // (b) `<img class>` is KEPT on the CLIENT edge (flat ALLOWED_ATTR includes
  // `class`). ACCEPTABLE ASYMMETRY: the SERVER edge strips img.class on save
  // (apps/api/tests/sanitize.test.ts case (a)), so class on img NEVER round-trips
  // — the live editor preview may echo a chosen class, but the persisted card
  // carries none. This is exactly WHY image sizing rides the `width` attribute
  // (which DOES round-trip) and not a CSS class. Not a bug; pinned to document it.
  test('(b) img class is kept on the client (acceptable asymmetry vs server strip)', () => {
    const out = sanitizeHtml(`<img src="${VALID_TOKEN}" class="nn-img-m">`);
    expect(out.toLowerCase()).toContain('<img');
    expect(out).toContain('class="nn-img-m"');
  });

  // (c) integer img width is allowed on the client edge too (width is in the flat
  // ALLOWED_ATTR), so it round-trips in a REAL browser. NOTE: we assert config
  // membership by string-scraping render-card.tsx rather than executing
  // DOMPurify, because under happy-dom (this test runner's DOM) DOMPurify strips
  // `width`/`height` from <img> during serialization even though they are
  // allow-listed — a happy-dom quirk (raw happy-dom keeps the attr; DOMPurify's
  // attribute pass under happy-dom drops it). In production (real browser DOM)
  // the attribute survives, matching the server edge proven in
  // apps/api/tests/sanitize.test.ts case (c). Scraping the config pins the
  // allow-list invariant without depending on the happy-dom serialization quirk.
  test('(c) integer img width is allow-listed on the client (config-level)', () => {
    const src = readFileSync(
      new URL('./render-card.tsx', import.meta.url),
      'utf8',
    );
    const m = src.match(/ALLOWED_ATTR:\s*\[([^\]]*)\]/);
    expect(m).not.toBeNull();
    const attrs = m![1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    expect(attrs).toContain('width');
    expect(attrs).toContain('height');
  });

  // (e) span.nn-code class is KEPT on the client edge (matching the server),
  // so inline code round-trips on both edges.
  test('(e) span nn-code class is kept on the client', () => {
    const out = sanitizeHtml('<span class="nn-code">x = 1</span>');
    expect(out).toContain('class="nn-code"');
    expect(out).toContain('x = 1');
  });

  // (f) <code> and <a> tags are now KEPT on the client edge (rich-content A4),
  // matching the server. INVERTED from the M1/M2 "tags dropped" pin. <code>
  // carries a class; <a> carries a valid-scheme href.
  test('(f) code and a tags are KEPT on the client (rich-content A4)', () => {
    const codeOut = sanitizeHtml('<code class="language-js">const x</code>');
    expect(codeOut.toLowerCase()).toContain('<code');
    expect(codeOut).toContain('class="language-js"');
    expect(codeOut).toContain('const x');
    const aOut = sanitizeHtml('<a href="https://x.test">link text</a>');
    expect(aOut.toLowerCase()).toContain('<a');
    expect(aOut).toContain('href="https://x.test"');
    expect(aOut).toContain('link text');
  });
});

// ── Step 0 / Step 4 bypass corpus (CLIENT edge). happy-dom runs the REAL client
// DOMPurify, so these EXECUTE the rich-content allow-list + the per-attribute
// href/src hook (B3). The matching SERVER halves live in
// apps/api/tests/sanitize.test.ts — the two edges agree byte-for-byte on
// keep/drop. CRITICAL: this proves <a href> SURVIVES (the old
// ALLOWED_URI_REGEXP would have killed it) AND that img strictness still holds.
describe('Step 4 rich-content allow-list (client edge)', () => {
  // attr-equality scrape: the client ALLOWED_ATTR must now include `href`
  // (the server adds a:['href']). Scrape rather than execute because happy-dom
  // serialization is quirky for some attrs; config membership is the invariant.
  test('client ALLOWED_ATTR includes href (config-level)', () => {
    const src = readFileSync(new URL('./render-card.tsx', import.meta.url), 'utf8');
    const m = src.match(/ALLOWED_ATTR:\s*\[([^\]]*)\]/);
    expect(m).not.toBeNull();
    const attrs = m![1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    expect(attrs).toContain('href');
    expect(attrs).toContain('class');
    expect(attrs).toContain('src');
  });

  // <a> keep/drop by scheme (plan B3) — symmetric with the server edge.
  test('<a href="https://…"> is KEPT with href (positive — href survives)', () => {
    const out = sanitizeHtml('<a href="https://ok.test/p">x</a>');
    expect(out.toLowerCase()).toContain('<a');
    expect(out).toContain('href="https://ok.test/p"');
    expect(out).toContain('x');
  });

  test('<a href="mailto:…"> is KEPT with href', () => {
    const out = sanitizeHtml('<a href="mailto:a@b.test">mail</a>');
    expect(out.toLowerCase()).toContain('<a');
    expect(out).toContain('href="mailto:a@b.test"');
  });

  test('<a href="javascript:…"> drops the href, keeps the bare tag', () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">x</a>');
    expect(out.toLowerCase()).toContain('<a');
    expect(out.toLowerCase()).not.toContain('href');
    expect(out.toLowerCase()).not.toContain('javascript:');
  });

  test('<a href="data:…"> drops the href, keeps the bare tag', () => {
    const out = sanitizeHtml('<a href="data:text/html,evil">x</a>');
    expect(out.toLowerCase()).toContain('<a');
    expect(out.toLowerCase()).not.toContain('href');
    expect(out.toLowerCase()).not.toContain('data:');
  });

  // New rich-content tags pass the client DOMPurify (round-trip).
  test('h1-h6 / pre / code / blockquote pass the client DOMPurify', () => {
    const out = sanitizeHtml(
      '<h1>a</h1><h2>b</h2><h3>c</h3><h4>d</h4><h5>e</h5><h6>f</h6>' +
        '<blockquote>q</blockquote><pre><code>k</code></pre>',
    );
    for (const tag of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code']) {
      expect(out.toLowerCase()).toContain(`<${tag}`);
    }
  });

  test('table/thead/tbody/tr/th/td pass the client DOMPurify', () => {
    const out = sanitizeHtml(
      '<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>C</td></tr></tbody></table>',
    );
    for (const tag of ['table', 'thead', 'tbody', 'tr', 'th', 'td']) {
      expect(out.toLowerCase()).toContain(`<${tag}`);
    }
  });

  // img strictness MUST still hold under the new hook: a non-token src → the img
  // is removed WHOLE (drop element), unchanged from before.
  test('img with non-token src is still dropped WHOLE (strictness intact)', () => {
    expect(keptImg(sanitizeHtml('<img src="https://evil.test/x">'))).toBe(false);
    expect(keptImg(sanitizeHtml('<img src="data:image/png;base64,xx">'))).toBe(false);
    expect(keptImg(sanitizeHtml(`<img src="${VALID_TOKEN}">`))).toBe(true);
  });

});

// ── Step 6b — mermaid SVG sink (CLIENT edge). The dedicated
// `MERMAID_DOMPURIFY_CONFIG` (via `sanitizeMermaidSvg`) is INTENTIONALLY isolated
// from the main allow-list: it turns on the SVG namespace but forbids the SVG→
// HTML escape hatches (foreignObject/script/a), external links (xlink:href via
// FORBID_ATTR), and clamps url-bearing presentation attrs (marker-end / fill /
// stroke / …) to a LOCAL `url(#id)` fragment via the `SVG_URL_REF_ATTRS` hook —
// this REPLACED the old `ALLOWED_URI_REGEXP`, which matched EVERY attribute and so
// stripped all SVG GEOMETRY (viewBox/width/x/y) and collapsed the diagram. The
// geometry-preservation test below pins that regression. `<style>` is PERMITTED (mermaid v11 emits
// its dark theme as a scoped `<style>` INSIDE the SVG — node/edge/label fill +
// stroke — and forbidding it rendered an invisible diagram); DOMPurify's built-in
// CSS sanitizer still neutralizes the dangerous at-rules (`@import`, external
// `url(http…)`). These EXECUTE the real client DOMPurify under happy-dom, proving
// the security drops AND the N5 + theme correctness KEEPs.
describe('Step 6b mermaid SVG sink (MERMAID_DOMPURIFY_CONFIG, client edge)', () => {
  // foreignObject is the SVG→HTML escape hatch — it AND any script inside it must
  // be dropped whole.
  test('drops <foreignObject> and a nested <script>', () => {
    const out = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><script>alert(1)</script></foreignObject></svg>',
    );
    expect(out.toLowerCase()).not.toContain('foreignobject');
    expect(out.toLowerCase()).not.toContain('<script');
  });

  // A bare <script> in the SVG body is dropped. NOTE: under happy-dom (this
  // runner's DOM) a sibling <script> makes DOMPurify drop the whole <svg> body,
  // so we cannot assert the sibling <path> survives HERE — that is a happy-dom
  // serialization quirk (same family as the img width/height quirk documented
  // above), NOT production behavior (a real browser keeps the siblings). The
  // SECURITY invariant — no live <script> reaches the DOM — is what matters and
  // is asserted; the legit-content KEEP is proven by the separate
  // `<svg><g><path/><text/></g>` test (no script sibling → content survives).
  test('drops a top-level <script>', () => {
    const out = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><g><path d="M0 0"/></g></svg>',
    );
    expect(out.toLowerCase()).not.toContain('<script');
    expect(out.toLowerCase()).not.toContain('alert');
  });

  // `<style>` is now PERMITTED (mermaid theme lives there), but a <style> whose
  // content is a dangerous `@import url(http…)` must still be neutralized — the
  // @import / external host never reaches the DOM (DOMPurify CSS sanitizer).
  test('neutralizes a dangerous @import inside <style>', () => {
    const out = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(http://evil.test/x.css)</style><g><rect/></g></svg>',
    );
    expect(out.toLowerCase()).not.toContain('@import');
    expect(out.toLowerCase()).not.toContain('evil.test');
  });

  // KEEP (CORRECTNESS) — theme survival is verified at RUNTIME, not here: `<style>`
  // is in DOMPurify's `svg` tag profile (purify svg allow-list), so a real browser
  // keeps the mermaid `theme:'dark'` `<style>` block (node/edge/label colors) and
  // the diagram renders visibly. happy-dom (this runner's DOM) cannot model an SVG
  // `<style>` sibling — it empties the whole <svg> body on serialize (the SAME
  // documented quirk family as the `<script>`-sibling test above), so a unit
  // assertion that the benign <style> survives is impossible in this environment.
  // The security side (the @import test above) is what we pin here.

  // KEEP (CORRECTNESS, regression for the collapsed-diagram bug): the SVG root
  // GEOMETRY (viewBox / width / x / y) MUST survive. The old ALLOWED_URI_REGEXP
  // matched every attribute value and dropped all of these (none look like
  // `url(#…)`), leaving the diagram with no coordinate system → it rendered as a
  // 300×150 strip. happy-dom faithfully reproduces this (a plain geometry svg has
  // no <style>-sibling quirk), so it is a reliable oracle here.
  test('KEEPS svg geometry (viewBox/width/x/y) — collapsed-diagram regression', () => {
    const out = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100%" viewBox="0 0 240 140"><g><rect x="1" y="2" width="40" height="20"/></g></svg>',
    );
    expect(out).toContain('viewBox="0 0 240 140"');
    expect(out).toContain('width="100%"');
    expect(out).toContain('x="1"');
    expect(out).toContain('y="2"');
  });

  // A url-bearing presentation attr (fill) with an EXTERNAL url() is dropped by the
  // SVG_URL_REF_ATTRS hook — while geometry (above) is untouched.
  test('drops fill="url(http://…)" (external paint ref)', () => {
    const out = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(http://evil.test/x)"/></svg>',
    );
    expect(out.toLowerCase()).not.toContain('evil.test');
  });

  // xlink:href to a data: URL — dropped (FORBID_ATTR xlink:href).
  test('drops xlink:href (data: / external)', () => {
    const out = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="data:image/png;base64,xx"/></svg>',
    );
    expect(out.toLowerCase()).not.toContain('xlink:href');
    expect(out.toLowerCase()).not.toContain('data:image');
  });

  // marker-end with a javascript: url — dropped (ALLOWED_URI_REGEXP keeps only
  // local `url(#id)`).
  test('drops marker-end="url(javascript:…)"', () => {
    const out = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0" marker-end="url(javascript:alert(1))"/></svg>',
    );
    expect(out.toLowerCase()).not.toContain('javascript:');
    // the marker-end value (the dangerous url) must be gone.
    expect(out.toLowerCase()).not.toContain('alert');
  });

  // <a> inside a diagram is dropped (no in-diagram navigation surface).
  test('drops a bare <a> link in the diagram', () => {
    const out = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="http://evil.test"><text>x</text></a></svg>',
    );
    expect(out.toLowerCase()).not.toContain('<a ');
    expect(out.toLowerCase()).not.toContain('evil.test');
  });

  // KEEP (CORRECTNESS gate, plan N5): a legitimate local arrowhead reference
  // `marker-end="url(#arrow)"` must SURVIVE — otherwise every arrowed diagram
  // loses its arrowheads. ADD_ATTR allow-lists marker-end/-start; ALLOWED_URI_REGEXP
  // still clamps them to local `url(#id)`.
  test('KEEPS marker-end="url(#arrow)" (N5 correctness gate)', () => {
    const out = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<defs><marker id="arrow"><path d="M0 0L10 5L0 10"/></marker></defs>' +
        '<path d="M0 0L50 0" marker-end="url(#arrow)"/></svg>',
    );
    expect(out).toContain('marker-end="url(#arrow)"');
  });

  // KEEP: a legitimate diagram (group + path + text) survives intact.
  test('KEEPS a legitimate <svg><g><path/><text/></g></svg>', () => {
    const out = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><g><path d="M0 0L10 10"/><text>hello</text></g></svg>',
    );
    expect(out.toLowerCase()).toContain('<svg');
    expect(out.toLowerCase()).toContain('<g');
    expect(out.toLowerCase()).toContain('<path');
    expect(out.toLowerCase()).toContain('<text');
    expect(out).toContain('hello');
  });
});

// ── Step 6b — mermaid pipeline + island restore (CLIENT edge). The pipeline
// leaves a ` ```mermaid ` fence as an INERT placeholder + a decoded source; the
// SafeHtml mermaid-island swap substitutes a sanitized SVG AFTER the main sanitize
// (so an SVG — not in the main allow-list — survives).
describe('Step 6b mermaid pipeline + island restore (client edge)', () => {
  // A ```mermaid fence becomes an inert placeholder (NOT a live <pre>) + one
  // mermaid source with the verbatim decoded diagram text.
  test('renderCardHtmlWithMermaid extracts the source and leaves an inert placeholder', () => {
    const { html, mermaid } = renderCardHtmlWithMermaid(
      mdBasic,
      { Front: '```mermaid\ngraph TD\n  A-->B\n```', Back: '' },
      'front',
    );
    expect(mermaid.length).toBe(1);
    // source decoded verbatim (the `-->` arrow is NOT entity-escaped here).
    expect(mermaid[0].source).toContain('graph TD');
    expect(mermaid[0].source).toContain('A-->B');
    // the placeholder rides in the html as inert text — no live mermaid <pre> yet.
    expect(html).toContain(mermaid[0].key);
    expect(html).not.toContain('language-mermaid');
    // the placeholder is HTML-inert (no angle brackets, no script).
    expect(mermaid[0].key).not.toContain('<');
  });

  // renderCardHtml (string-only) restores mermaid to a plain CODE block (the
  // non-async fallback) — sensible content for a non-RichCard sink, no live SVG.
  test('renderCardHtml restores mermaid to a plain code block (string fallback)', () => {
    const out = renderCardHtml(
      mdBasic,
      { Front: '```mermaid\ngraph TD\n  A-->B\n```', Back: '' },
      'front',
    );
    expect(out).toContain('class="language-mermaid"');
    // the arrow is RE-escaped inside the code block (safe, inert).
    expect(out).toContain('A--&gt;B');
    expect(out.toLowerCase()).not.toContain('<svg');
  });

  // The island swap substitutes the sanitized SVG into the post-sanitize string
  // (this is the exact operation SafeHtml performs with `mermaidIslands`). The SVG
  // — which the MAIN sanitize would strip — survives because it is injected AFTER.
  test('restoreMermaidIslands substitutes a sanitized SVG that the main sanitize would have stripped', () => {
    const { html, mermaid } = renderCardHtmlWithMermaid(
      mdBasic,
      { Front: '```mermaid\ngraph TD\n  A-->B\n```', Back: '' },
      'front',
    );
    // First prove the main re-pass (resanitize) does NOT strip the placeholder
    // (it is inert text) AND would strip a raw <svg> (svg not in main allow-list).
    const repassed = resanitize(html);
    expect(repassed).toContain(mermaid[0].key);
    expect(resanitize('<svg><g></g></svg>').toLowerCase()).not.toContain('<svg');
    // Now substitute a sanitized SVG island AFTER the main re-pass.
    const safeSvg = sanitizeMermaidSvg(
      '<svg xmlns="http://www.w3.org/2000/svg"><g><path d="M0 0"/></g></svg>',
    );
    const islands = new Map<string, string>([[mermaid[0].key, `<div class="nn-mermaid">${safeSvg}</div>`]]);
    const final = restoreMermaidIslands(repassed, islands);
    expect(final.toLowerCase()).toContain('<svg');
    expect(final).toContain('class="nn-mermaid"');
    // the placeholder is gone — fully replaced by the island.
    expect(final).not.toContain(mermaid[0].key);
  });
});

// ── Step 5 markdown pipeline (CLIENT edge, via renderCardHtml). markdown-it runs
// with `{ html:false, linkify:false, typographer:false }` (plan H3), then the
// main sanitize is the last line of defense. These prove the LIVE markdown render
// path (not just the raw `sanitizeHtml` allow-list).
describe('Step 5 markdown pipeline (client edge, renderCardHtml)', () => {
  // linkify:false → a bare URL in text is NOT turned into an <a>.
  test('markdown autolink (linkify off) does not produce <a> for a bare URL', () => {
    const out = mdFront('see http://evil.test/x now');
    expect(out.toLowerCase()).not.toContain('<a');
    // the URL text survives as plain text (searchable / visible), just not linked
    expect(out).toContain('http://evil.test/x');
  });

  // html:false → a raw HTML tag typed into the field is ESCAPED, never live markup.
  test('markdown html:false escapes a raw <script> / <b> in the source', () => {
    const out = mdFront('<script>alert(1)</script> and <b>x</b>');
    expect(out.toLowerCase()).not.toContain('<script');
    expect(out.toLowerCase()).not.toContain('</script');
    expect(out).not.toContain('<b>');
    expect(out).toContain('&lt;script&gt;');
    expect(out).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  // markdown → the ALLOWED rich-content tags (the same set the allow-list permits).
  test('markdown renders to allowed tags (heading / list / bold / blockquote / table)', () => {
    expect(mdFront('# Title').toLowerCase()).toContain('<h1>title</h1>');
    const list = mdFront('- a\n- b').toLowerCase();
    expect(list).toContain('<ul>');
    expect(list).toContain('<li>a</li>');
    expect(mdFront('**bold**').toLowerCase()).toContain('<strong>bold</strong>');
    expect(mdFront('> quote').toLowerCase()).toContain('<blockquote>');
    const table = mdFront('| H |\n|---|\n| C |').toLowerCase();
    expect(table).toContain('<table>');
    expect(table).toContain('<th>h</th>');
    expect(table).toContain('<td>c</td>');
  });

  // An explicit markdown link with a valid scheme survives WITH its href; a
  // dangerous scheme is dropped (markdown-it's validateLink + the main href hook).
  test('explicit markdown link: https kept, javascript dropped', () => {
    const okLink = mdFront('[t](https://ok.test)');
    expect(okLink.toLowerCase()).toContain('<a');
    expect(okLink).toContain('href="https://ok.test"');
    const jsLink = mdFront('[t](javascript:alert(1))').toLowerCase();
    // markdown-it's validateLink refuses the javascript: scheme → it never builds
    // an <a> at all (the markup stays inert literal text). No LIVE link/href.
    expect(jsLink).not.toContain('<a');
    expect(jsLink).not.toContain('href=');
  });

  // The H2 ordering proof: markdown + math in ONE field — markdown markup renders
  // AND `\(x^2\)` is NOT eaten by markdown-it (raw math is stashed BEFORE markdown)
  // → it becomes a KaTeX island.
  test('markdown + math in one field: tags render AND math is a katex island (H2)', () => {
    const out = mdFront('# Energy\n\nThe formula \\(E=mc^2\\) is **famous**.');
    expect(out.toLowerCase()).toContain('<h1>energy</h1>');
    expect(out.toLowerCase()).toContain('<strong>famous</strong>');
    expect(out).toContain('class="katex"'); // math survived markdown, rendered
    expect(out).not.toContain('E=mc^2'); // the raw source was consumed by KaTeX
  });

  // ── Markdown-only editor (A1): the editor now stores RAW MARKDOWN source. The
  // image toolbar inserts `![alt](/m/<uuid>)`; markdown-it renders it to
  // `<img src="/m/<uuid>">`, which must SURVIVE the render-edge MEDIA_TOKEN_RE
  // sanitizer (the exact src shape it keeps). A non-token src must be DROPPED.
  test('A1: markdown image `![alt](/m/<uuid>)` renders an <img> that survives the sanitizer', () => {
    const out = mdFront(`![cat](${VALID_TOKEN})`);
    expect(keptImg(out)).toBe(true);
    expect(out).toContain(`src="${VALID_TOKEN}"`);
    // the alt rides through markdown → the img alt attribute.
    expect(out).toContain('alt="cat"');
  });

  test('A1: a markdown image with a non-token src is DROPPED whole', () => {
    expect(keptImg(mdFront('![x](https://evil.test/a.png)'))).toBe(false);
    expect(keptImg(mdFront('![x](data:image/png;base64,zz)'))).toBe(false);
  });

  // ── Smoke (AC2): the headline bug. A markdown SOURCE field `# 123\n12` must
  // render an <h1> + a paragraph — NO literal `<div>` and NO escaped `&lt;`
  // (the contentEditable era produced `123<div>12</div>` that markdown-it then
  // escaped to visible tags).
  test('smoke: `# 123\\n12` → <h1>123</h1> + paragraph 12, no literal/escaped tags', () => {
    const out = mdFront('# 123\n12');
    expect(out.toLowerCase()).toContain('<h1>123</h1>');
    expect(out).toContain('12');
    // no HTML produced by the (gone) contentEditable authoring path
    expect(out.toLowerCase()).not.toContain('<div');
    expect(out).not.toContain('&lt;');
    expect(out).not.toContain('&lt;div&gt;');
  });
});

// ── Step 6a — fenced-code syntax highlighting (CLIENT edge, via renderCardHtml).
// highlight.js CORE + a fixed language subset, wired as markdown-it's `highlight`
// callback (the pure-synchronous path). Output is CLASS-BASED (`<span class=
// "hljs-*">`) only — never inline style (plan A2 / Principle 2). The hljs spans +
// the wrapper `<pre><code class>` survive the main sanitize (span/pre/code + class
// are allow-listed from Step 4), so the class-based theme applies. These prove the
// LIVE render path, not just the raw allow-list.
describe('Step 6a code highlighting (client edge, renderCardHtml)', () => {
  // A KNOWN language → class-based hljs highlight with `hljs-*` token spans.
  test('python fence is class-highlighted (hljs-* spans, language class)', () => {
    const out = mdFront('```python\nprint(1)\n```');
    expect(out).toContain('<pre>');
    expect(out).toContain('class="hljs language-python"');
    // class-based tokens — NOT inline style.
    expect(out).toContain('hljs-');
    expect(out.toLowerCase()).not.toContain('style=');
    // `print` is a python built_in; the keyword/built_in class proves real tokens.
    expect(out).toMatch(/class="hljs-(built_in|keyword)"/);
  });

  // js highlighting also lands tokens (keyword `const`).
  test('javascript fence highlights a keyword token', () => {
    const out = mdFront('```javascript\nconst x = 1;\n```');
    expect(out).toContain('class="hljs language-javascript"');
    expect(out).toContain('hljs-keyword');
    expect(out.toLowerCase()).not.toContain('style=');
  });

  // An UNKNOWN language → plain ESCAPED `<pre><code>` (no language class, no hljs
  // spans, no throw).
  test('unknown language falls back to plain <pre><code> (no hljs, no crash)', () => {
    const out = mdFront('```zzz\nx\n```');
    expect(out).toContain('<pre>');
    expect(out).toContain('<code>');
    expect(out).not.toContain('hljs');
    expect(out).not.toContain('language-zzz');
    expect(out).toContain('x');
  });

  // A fence with NO language is also the plain escaped path.
  test('no-language fence is plain <pre><code> (no hljs)', () => {
    const out = mdFront('```\njust text\n```');
    expect(out).toContain('<pre>');
    expect(out).toContain('<code>');
    expect(out).not.toContain('hljs');
    expect(out).toContain('just text');
  });

  // HTML special chars inside a fence are ESCAPED, never executed — both the
  // unknown-language plain path (markdown-it escapeHtml) AND the known-language
  // path (hljs class-based output never emits live `<script>`) + the main sanitize.
  test('HTML inside a fence is escaped, not executed (unknown language)', () => {
    const out = mdFront('```zzz\n<script>alert(1)</script>\n```');
    expect(out.toLowerCase()).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  test('HTML inside a highlighted fence is escaped, not executed (known language)', () => {
    // `<script>` inside a JS fence: hljs tokenizes/escapes it; no live <script>.
    const out = mdFront('```javascript\nvar s = "<script>alert(1)</script>";\n```');
    expect(out.toLowerCase()).not.toContain('<script>');
    expect(out.toLowerCase()).not.toContain('</script>');
    expect(out).toContain('&lt;script&gt;');
  });

  // Idempotency (Step 5 invariant must hold): markdown is NOT re-rendered by the
  // SafeHtml `resanitize` re-pass, so a highlighted block stays stable — the
  // `<pre><code class="hljs …">` + the `hljs-*` spans survive verbatim (no
  // double-highlight, no re-escape of the rendered tags).
  test('idempotent: SafeHtml re-pass keeps the highlighted block stable', () => {
    const once = mdFront('```python\nprint(1)\n```');
    expect(once).toContain('class="hljs language-python"');
    const twice = resanitize(once);
    expect(twice).toContain('class="hljs language-python"');
    expect(twice).toContain('hljs-');
    expect(twice.toLowerCase()).not.toContain('style=');
    // True idempotency: a second re-pass equals the first.
    expect(twice).toBe(resanitize(twice));
  });

  // Math + a highlighted code fence in ONE field must not conflict: the fence is
  // highlighted AND `\(x^2\)` outside it becomes a KaTeX island.
  test('math + highlighted code in one field do not conflict', () => {
    const out = mdFront('Inline \\(x^2\\) then:\n\n```python\nprint(2)\n```');
    expect(out).toContain('class="katex"'); // math rendered
    expect(out).toContain('class="hljs language-python"'); // code highlighted
    expect(out).toContain('hljs-');
  });
});
