// KaTeX render + math-injection security (M2 Phase 5, plan A3/A4/C-5).
//
// This is the FIRST test of the `style`-permitted path (KATEX_DOMPURIFY_CONFIG):
// it proves KaTeX's inline styles survive while an injected `position:fixed` /
// `url(...)` / `expression(...)` is neutralized by DOMPurify's built-in CSS
// sanitizer, and that `\href{javascript:}` / `\includegraphics` / `\htmlData`
// produce no `javascript:` / `on*` / `<script>`. It also asserts the math pass
// runs ONLY outside HTML tags (a delimiter inside an attribute is not rendered)
// and that the MAIN render path still strips a raw `style="…"` on a field value
// (the KaTeX `style` allowance must NOT leak to the main config).
//
// IMPORTANT: the DOM must be registered (and the happy-dom nodeName getter
// repaired) BEFORE importing render-card, because dompurify captures `window` and
// caches `Node.prototype.nodeName` at module-eval time. `test-dom-setup` does
// both as an import side effect, so it MUST be the first import here.

import { ensureTestDom, GlobalRegistrator } from './test-dom-setup.ts';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
beforeAll(ensureTestDom);
import type { Config } from 'dompurify';
ensureTestDom();
const { default: DOMPurify } = await import('dompurify');
// Imported AFTER the DOM is registered so DOMPurify binds to the happy-dom window.
const { renderCardHtml, renderCardHtmlWithMermaid, resanitize, sanitizeHtml } = await import('./render-card.tsx');
import type { NoteTypeDef } from '@reomi/shared';

// The EXACT config `render-card.tsx` uses to DOMPurify KaTeX output (plan A3/C-5).
// `style` is permitted ONLY here; the TAG allowlist (`span` only) is the
// structural guarantee, and DOMPurify's built-in CSS sanitizer blocks dangerous
// style primitives in a real browser.
const KATEX_DOMPURIFY_CONFIG: Config = {
  ALLOWED_TAGS: ['span'],
  ALLOWED_ATTR: ['class', 'style'],
};

afterAll(async () => {
  // `GlobalRegistrator` is a cross-file singleton: another DOM-using test file in
  // the same `bun test` run (e.g. sanitize-img.test.ts) may already have
  // unregistered it. Guard so this teardown never throws on an already-clean
  // global.
  try {
    await GlobalRegistrator.unregister();
  } catch {
    /* already unregistered by another suite — fine */
  }
});

const basicType: Pick<NoteTypeDef, 'kind' | 'templates'> = {
  kind: 'basic',
  templates: [{ name: 'Card 1', ord: 0, frontTemplate: '{{Front}}', backTemplate: '{{Back}}' }],
};

function front(fields: Record<string, string>): string {
  return renderCardHtml(basicType, fields, 'front');
}

test('renders over private-network HTTP where crypto.randomUUID is unavailable', () => {
  const descriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
  Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: undefined });
  try {
    const html = front({ Front: 'A formula: \\(x^2\\) and **a note**.' });
    expect(html).toContain('katex');
    expect(html).toContain('<strong>a note</strong>');
    expect(html).not.toMatch(/nnph[0-9a-f]+/);
  } finally {
    if (descriptor) Object.defineProperty(crypto, 'randomUUID', descriptor);
    else delete (crypto as Partial<Crypto>).randomUUID;
  }
});

describe('KaTeX render — basic', () => {
  test('inline \\(x^2\\) produces a katex span', () => {
    const out = front({ Front: '\\(x^2\\)', Back: '' });
    expect(out).toContain('class="katex"');
    // output:html → no MathML / SVG namespace-confusion surface
    expect(out.toLowerCase()).not.toContain('<math');
    expect(out.toLowerCase()).not.toContain('<svg');
  });

  test('display \\[\\frac12\\] renders in display mode', () => {
    const out = front({ Front: '\\[\\frac12\\]', Back: '' });
    expect(out).toContain('katex-display');
  });

  test('text around the math is preserved', () => {
    const out = front({ Front: 'before \\(x\\) after', Back: '' });
    expect(out).toContain('before ');
    expect(out).toContain(' after');
    expect(out).toContain('class="katex"');
  });

  test('a field with no math produces no katex span', () => {
    const out = front({ Front: 'plain text here', Back: '' });
    expect(out).not.toContain('class="katex"');
    expect(out).toContain('plain text here');
  });

  // Step 5 (plan H3): field values are MARKDOWN source rendered with markdown-it
  // `html: false`, so a RAW HTML tag typed into a field is ESCAPED, never passed
  // through as live markup. The author can only emit the tags markdown-it
  // generates (⊆ the allow-list); arbitrary `<tag>` injection is impossible.
  test('raw HTML in a field is escaped, not passed through (markdown html:false)', () => {
    const out = front({ Front: 'plain <b>text</b>', Back: '' });
    expect(out).not.toContain('class="katex"');
    // The literal tag is escaped to text; no live <b> element survives.
    expect(out).not.toContain('<b>');
    expect(out).toContain('&lt;b&gt;text&lt;/b&gt;');
  });

  // Markdown DOES render: a heading marker becomes an <h1>, bold becomes <strong>.
  test('markdown source renders to tags (heading + bold)', () => {
    const heading = front({ Front: '# Title', Back: '' });
    expect(heading.toLowerCase()).toContain('<h1>title</h1>');
    const bold = front({ Front: '**bold**', Back: '' });
    expect(bold.toLowerCase()).toContain('<strong>bold</strong>');
  });

  test('two adjacent inline spans both render', () => {
    const out = front({ Front: '\\(a\\)\\(b\\)', Back: '' });
    expect((out.match(/class="katex"/g) || []).length).toBe(2);
  });

  test('idempotent: <SafeHtml> re-sanitize keeps the katex island + markdown HTML', () => {
    const once = front({ Front: '# H\n\n\\(x^2\\) and **bold**', Back: '' });
    expect(once).toContain('class="katex"');
    expect(once.toLowerCase()).toContain('<h1>'); // markdown rendered once
    expect(once.toLowerCase()).toContain('<strong>bold</strong>');
    // <SafeHtml> re-runs `resanitize` (NOT markdown) on its prop — must keep the
    // math island AND must NOT re-escape the already-rendered markdown tags.
    const twice = sanitizeAndRenderViaSafeHtml(once);
    expect(twice).toContain('class="katex"');
    expect(twice).toContain('style=');
    expect(twice.toLowerCase()).toContain('<h1>'); // not escaped to &lt;h1&gt;
    expect(twice.toLowerCase()).toContain('<strong>bold</strong>');
    expect(twice).not.toContain('&lt;h1&gt;');
    // True idempotency: a second SafeHtml pass equals the first.
    expect(twice).toBe(sanitizeAndRenderViaSafeHtml(twice));
  });
});

// Mirror EXACTLY what <SafeHtml> does to its prop: it injects `resanitize(html)`
// (the idempotent defensive re-sanitize — main DOMPurify with the KaTeX islands
// protected, NO markdown re-render). `resanitize` is exported for this purpose.
function sanitizeAndRenderViaSafeHtml(html: string): string {
  return resanitize(html);
}

// ── Placeholder-key terminator regression (code-review MEDIUM). Each island is
// stashed behind a key `${prefix}<kind><n>` and restored via
// `out.split(key).join(value)` in insertion order. Without a non-digit terminator,
// the key `m1` is a STRING PREFIX of `m10`, so split('…m1') splits INSIDE the
// `m10` placeholder — the 11th+ island of a kind would render island #1's content
// + a stray trailing digit. The mint sites now append a `z` terminator so `m1z` is
// not a substring of `m10z`. These tests need ≥11 islands of one kind on one side
// to even exercise the m1/m10 collision; pre-fix they would FAIL (island #10 would
// carry formula #1's content + a stray `0`), post-fix they pass.
describe('placeholder-key terminator — ≥11 islands of one kind do not collide', () => {
  // 11 raw `\(…\)` math formulas (m0..m10), each a UNIQUE `\text{…}` sentinel so
  // its rendered KaTeX text is greppable. The math restore loop
  // (`renderCardHtmlWithMermaid`, key `m<n>`) runs split/join in insertion order
  // m0,m1,…,m10 — so `m1` is processed while `m10` is still present in the string.
  test('11 inline math islands each render their OWN formula (m1 vs m10)', () => {
    const N = 11;
    // sentinels mathNN — distinct, alnum, survive KaTeX \text verbatim.
    const fields = Array.from({ length: N }, (_, i) => `\\(\\text{math${i}}\\)`).join(' ');
    const out = front({ Front: fields, Back: '' });
    // Every sentinel must appear exactly once and in its OWN island.
    for (let i = 0; i < N; i++) {
      expect(out).toContain(`math${i}`);
      // exactly one occurrence — a collision would duplicate math0 (from m1's split
      // bleeding into m10) and/or leave a corrupted island short its sentinel.
      const count = (out.match(new RegExp(`math${i}\\b`, 'g')) || []).length;
      expect(count).toBe(1);
    }
    // No raw placeholder leaked through (every m<n>z was restored).
    expect(out).not.toMatch(/nnph[0-9a-f]{32}m\d+z/);
    // Pre-fix the 11th island would be `math0` + a stray `0`; the sentinel `math10`
    // would be ABSENT. Assert it is present (the discriminating check).
    expect(out).toContain('math10');
  });

  // 11 ALREADY-RENDERED KaTeX islands re-sanitized via `resanitize` (the SafeHtml
  // re-pass that runs on EVERY render — key `s<n>` in `stashRenderedKatex`). This
  // is the most load-bearing path: it executes on every display, not just first
  // render. Build the once-rendered HTML, then prove the re-pass keeps all 11
  // islands intact (no s1/s10 collision).
  test('11 KaTeX islands survive the resanitize re-pass intact (s1 vs s10)', () => {
    const N = 11;
    const fields = Array.from({ length: N }, (_, i) => `\\(\\text{katex${i}}\\)`).join(' ');
    const once = front({ Front: fields, Back: '' });
    // sanity: all 11 rendered on the first pass.
    for (let i = 0; i < N; i++) expect(once).toContain(`katex${i}`);
    expect((once.match(/class="katex"/g) || []).length).toBe(N);
    // The SafeHtml re-pass (stashRenderedKatex → main sanitize → restore by key).
    const twice = sanitizeAndRenderViaSafeHtml(once);
    for (let i = 0; i < N; i++) {
      expect(twice).toContain(`katex${i}`);
      const count = (twice.match(new RegExp(`katex${i}\\b`, 'g')) || []).length;
      expect(count).toBe(1);
    }
    expect((twice.match(/class="katex"/g) || []).length).toBe(N);
    // No stash placeholder leaked (every s<n>z restored).
    expect(twice).not.toMatch(/nnph[0-9a-f]{32}s\d+z/);
    // True idempotency still holds with 11 islands.
    expect(sanitizeAndRenderViaSafeHtml(twice)).toBe(twice);
    // Discriminating check: the 11th island keeps its OWN sentinel (pre-fix it
    // would carry katex0 + a stray `0`, dropping katex10).
    expect(twice).toContain('katex10');
  });

  // 11 mermaid blocks (d0..d10) on one side: each placeholder must restore to its
  // OWN source. `renderCardHtml` restores mermaid to a code block keyed by `d<n>`
  // (the same split/join restore, in the `mermaid` array order). Pre-fix `d1` would
  // split inside `d10`.
  test('11 mermaid blocks each restore their OWN source (d1 vs d10)', () => {
    const N = 11;
    // Each fence carries a unique node name so the decoded source is greppable.
    const fields = Array.from(
      { length: N },
      (_, i) => '```mermaid\ngraph TD\n  NODE' + i + '\n```',
    ).join('\n\n');
    const { html, mermaid } = renderCardHtmlWithMermaid(basicType, { Front: fields, Back: '' }, 'front');
    expect(mermaid.length).toBe(N);
    // Each extracted source carries its own sentinel.
    for (let i = 0; i < N; i++) {
      expect(mermaid.some((b) => b.source.includes(`NODE${i}`))).toBe(true);
    }
    // string-fallback restore (renderCardHtml) must place each source in its own
    // code block — every sentinel present exactly once, none corrupted.
    const out = renderCardHtml(basicType, { Front: fields, Back: '' }, 'front');
    for (let i = 0; i < N; i++) {
      expect(out).toContain(`NODE${i}`);
      const count = (out.match(new RegExp(`NODE${i}\\b`, 'g')) || []).length;
      expect(count).toBe(1);
    }
    // No mermaid placeholder leaked (every d<n>z restored to a code block).
    expect(out).not.toMatch(/nnph[0-9a-f]{32}d\d+z/);
    // Discriminating check: NODE10 present (pre-fix d1's split into d10 would emit
    // NODE0's block + a stray `0`, losing NODE10).
    expect(out).toContain('NODE10');
  });
});

describe('KaTeX render — tokenizes outside tags only (no injection via attrs)', () => {
  test('a delimiter inside an attribute value is NOT rendered', () => {
    // The field value carries `\(x\)` inside a class attribute. The main sanitize
    // keeps `class` on a span; the math tokenizer must NOT treat the attribute
    // text as a formula (it operates only on text between tags).
    const out = front({ Front: '<span class="\\(x\\)">hi</span>', Back: '' });
    expect(out).not.toContain('class="katex"');
    // the literal delimiter text stays inside the attribute (not turned to math)
    expect(out).toContain('hi');
  });
});

describe('KaTeX security — the style-permitted path', () => {
  test('\\href{javascript:alert(1)} produces no javascript: / on* / <script>', () => {
    const out = front({ Front: '\\(\\href{javascript:alert(1)}{x}\\)', Back: '' }).toLowerCase();
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('<script');
    expect(out).not.toMatch(/\son\w+=/);
  });

  test('\\includegraphics is neutralized (no <img>, no javascript:)', () => {
    const out = front({ Front: '\\(\\includegraphics{javascript:alert(1)}\\)', Back: '' }).toLowerCase();
    expect(out).not.toContain('javascript:');
    // KaTeX \includegraphics under trust:false renders nothing executable
    expect(out).not.toMatch(/\son\w+=/);
  });

  test('\\htmlData produces no data-* injection / event handlers', () => {
    const out = front({ Front: '\\(\\htmlData{foo=bar}{x}\\)', Back: '' }).toLowerCase();
    expect(out).not.toMatch(/\son\w+=/);
    expect(out).not.toContain('<script');
  });

  // The `style`-permitted KaTeX sink (KATEX_DOMPURIFY_CONFIG) restricts TAGS to
  // `span` only — so even if an attacker smuggled markup INTO a formula, only a
  // span can survive. The tag allowlist is the structural guarantee; it works
  // identically in the harness and in production.
  test('KATEX_DOMPURIFY_CONFIG keeps only <span> (drops a smuggled <img>/on*)', () => {
    const out = DOMPurify.sanitize(
      '<span class="katex"><img src=x onerror=alert(1)>y</span>',
      KATEX_DOMPURIFY_CONFIG,
    ).toLowerCase();
    expect(out).not.toContain('<img');
    expect(out).not.toContain('onerror');
    expect(out).toContain('class="katex"');
    expect(out).toContain('y');
  });

  test('KATEX_DOMPURIFY_CONFIG keeps a benign KaTeX style declaration', () => {
    const out = DOMPurify.sanitize(
      '<span class="katex" style="height:1em;vertical-align:-0.2em">x</span>',
      KATEX_DOMPURIFY_CONFIG,
    ).toLowerCase();
    expect(out).toContain('class="katex"');
    expect(out).toContain('height:1em'); // legitimate KaTeX sizing survives
  });

  // C-5 / Principle 5: the dangerous CSS primitives (`url()`, `expression()`,
  // `position:fixed`) are blocked by DOMPurify's built-in CSS sanitizer IN A REAL
  // BROWSER (DOMPurify 3.4.8). happy-dom has no functional CSSOM-backed style
  // sanitization, so the CSS-VALUE filtering is NOT exercised in this harness —
  // asserting it here would test the environment, not production. What IS robustly
  // verifiable (and is the PRIMARY defense per A3): KaTeX's OWN output under
  // `trust:false` never emits these primitives, so there is no dangerous style to
  // sanitize in the first place. Assert that invariant on real rendered output.
  test('rendered KaTeX output never emits url()/expression()/position:fixed in a style', () => {
    const out = front({ Front: '\\(\\frac{x}{y} + \\sqrt{z}\\)', Back: '' }).toLowerCase();
    expect(out).not.toContain('url(');
    expect(out).not.toContain('expression(');
    expect(out).not.toContain('position:fixed');
    expect(out).not.toContain('position: fixed');
  });

  test('the MAIN path still strips a raw style="…" on a field value (no leak)', () => {
    // The KaTeX `style` allowance is scoped to KATEX_DOMPURIFY_CONFIG only. A raw
    // styled element in a field value must still lose its style at the main edge.
    const out = sanitizeHtml('<span style="position:fixed;top:0">x</span>');
    expect(out.toLowerCase()).not.toContain('style=');
    expect(out.toLowerCase()).not.toContain('position:fixed');
    expect(out).toContain('x'); // the element survives, only the style is stripped
  });

  test('renderCardHtml main path neutralizes a raw styled element on a field value', () => {
    // Step 5 (markdown html:false): a raw `<span style=…>` typed into a field is
    // ESCAPED to text, so no live element — and therefore no live `style`
    // attribute — ever reaches the DOM. The defense is even stronger than the M2
    // "strip the style" path: the whole tag is neutralized to inert text.
    const out = front({ Front: '<span style="position:fixed">danger</span>', Back: '' });
    expect(out.toLowerCase()).not.toContain('<span'); // no live element
    expect(out).toContain('danger'); // the text content survives
    expect(out).toContain('&lt;span'); // the tag is escaped, not live markup
  });
});

describe('single sink — dangerouslySetInnerHTML stays in render-card.tsx only', () => {
  // The HTML-RENDER sink stays in render-card.tsx. `app/layout.tsx` is the ONE
  // allowed exception: a STATIC, build-time-constant inline <script> for the
  // anti-FOUC theme bootstrap (P3.3a) — no user data ever flows into it, so it
  // carries none of the sanitization risk this invariant guards. Next requires
  // dangerouslySetInnerHTML to emit an inline script that actually executes.
  const ALLOWED = new Set(['render-card.tsx', 'app/layout.tsx']);
  test('no other source file uses dangerouslySetInnerHTML', async () => {
    const { Glob } = await import('bun');
    const root = new URL('../', import.meta.url).pathname; // apps/web/src
    const glob = new Glob('**/*.{ts,tsx}');
    const offenders: string[] = [];
    for await (const rel of glob.scan({ cwd: root })) {
      if (ALLOWED.has(rel) || rel.endsWith('render-card.tsx')) continue;
      if (rel.endsWith('.test.ts') || rel.endsWith('.test.tsx')) continue;
      const text = await Bun.file(`${root}${rel}`).text();
      if (text.includes('dangerouslySetInnerHTML')) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

describe('rich-content diagnostics', () => {
  test('bad visible formulas retain their source, field and block while ordinary content survives', () => {
    const source = 'before \\(x\\) middle \\(\\notARealCommand{<img src=x onerror=alert(1)>}\\) after';
    const result = renderCardHtmlWithMermaid(basicType, { Front: source, Back: '\\(\\secretAnswer\\)' }, 'front');
    expect(result.mathErrors).toHaveLength(1);
    expect(result.mathErrors![0]).toMatchObject({ field: 'Front', block: 2 });
    expect(result.mathErrors![0].source).toContain('notARealCommand');
    expect(result.html).toContain('before'); expect(result.html).toContain('after');
    expect(result.html).not.toContain('secretAnswer');
    const fallback = renderCardHtml(basicType, { Front: source }, 'front');
    expect(fallback).toContain('&lt;img'); expect(fallback).not.toContain('<img');
    expect(fallback).not.toMatch(/nnph[0-9a-f]+m/);
  });
  test('diagrams are numbered within their own field and hidden blocks are omitted', () => {
    const diagram = '```mermaid\ngraph TD\n A-->B\n```';
    const result = renderCardHtmlWithMermaid(basicType, { Front: `${diagram}\n\n${diagram}`, Back: diagram }, 'front');
    expect(result.mermaid.map(({ field, block }) => ({ field, block }))).toEqual([{ field: 'Front', block: 1 }, { field: 'Front', block: 2 }]);
  });
});

test('C# fences and aliases retain syntax tokens through sanitization', () => {
  for (const language of ['csharp', 'cs', 'c#']) {
    const html = front({ Front: '```' + language + '\nIEnumerable<int> Fib() { yield return 1; } // iterator\n```' });
    expect(html).toContain('hljs-keyword');
    expect(html).toContain('hljs-number');
    expect(html).toContain('hljs-comment');
    expect(html).toContain('&lt;');
  }
  const html = front({ Front: '```csharp\nvar html = "<script>alert(1)</script>";\n```' });
  expect(html).not.toContain('<script>');
  expect(html).toContain('hljs-string');

});

test('inline a+b keeps one html KaTeX island and a newline accessible string', () => {
  const html = front({ Front: '\\(a+b\\)', Back: 'HIDDEN_ANSWER_TOKEN' });
  expect(html).not.toContain('HIDDEN_ANSWER_TOKEN');
  expect(html.toLowerCase()).not.toContain('<math');
  expect(html.match(/class="katex"/g)).toEqual(['class="katex"']);
  const root = document.createElement('div');
  root.innerHTML = html;
  const accessible = walkAccessible(root);
  expect(accessible).toBe('\n');
});

function walkAccessible(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  if ((node as Element).getAttribute('aria-hidden') === 'true') return '';
  let text = '';
  for (const child of node.childNodes) text += walkAccessible(child);
  return text;
}
