import { ensureTestDom } from './test-dom-setup';
import { beforeAll, describe, expect, test } from 'bun:test';
import { BASIC_NOTE_TYPE, CLOZE_NOTE_TYPE } from '@reomi/shared';
import { sanitizeFieldValues } from '../../../api/src/sanitize';
ensureTestDom();
const { renderCardHtml, renderCardHtmlWithMermaid, resanitize } = await import('./render-card');

beforeAll(ensureTestDom);

describe('saved Markdown has a safe display boundary', () => {
  test('numbered cloze hides just its group, keeps hints and leaves code literal', () => {
    const fields = { Text: '{{c1::Paris::city}} and {{c2::France}}. `{{c3::example}}`' };
    const box = document.createElement('div');
    box.innerHTML = renderCardHtml(CLOZE_NOTE_TYPE, fields, 'front', 0, 1);
    expect(box.textContent).toContain('[city] and France. {{c3::example}}');
    expect(box.textContent).not.toContain('Paris');
    expect(box.querySelector('code')?.textContent).toBe('{{c3::example}}');
    expect(Boolean(box.querySelector('[data-nn-cloze]'))).toBe(false);
    box.innerHTML = renderCardHtml(CLOZE_NOTE_TYPE, fields, 'back', 0, 1);
    expect(box.textContent).toContain('Paris and France');
    expect(box.textContent).not.toContain('::city');
  });
  test('cloze math is hidden and malformed historical source never reveals a partial answer', () => {
    const box = document.createElement('div');
    box.innerHTML = renderCardHtml(CLOZE_NOTE_TYPE, { Text: '\\(x={{c1::42::number}}\\)' }, 'front', 0, 1);
    expect(Boolean(box.querySelector('.katex'))).toBe(true);
    expect(box.textContent).not.toContain('42');
    const invalid = renderCardHtmlWithMermaid(CLOZE_NOTE_TYPE, { Text: '{{c1::secret}} {{c2::broken' }, 'front', 0, 1);
    expect(invalid).toMatchObject({ html: '', mermaid: [], error: 'invalid_cloze' });
  });
  test('hidden cloze diagrams and unused back fields do not trigger Mermaid rendering', () => {
    const result = renderCardHtmlWithMermaid(CLOZE_NOTE_TYPE, {
      Text: '{{c1::secret}}', Extra: '```mermaid\ngraph TD\n secret-->answer\n```',
    }, 'front', 0, 1);
    expect(result.mermaid).toEqual([]);
    expect(result.html).not.toContain('secret');
  });
  test('display math can span blank lines without entering fenced code', () => {
    const box = document.createElement('div');
    box.innerHTML = renderCardHtml(BASIC_NOTE_TYPE, { Front: '\\[\nx^2\n\n+ y^2\n\\]', Back: '' }, 'front');
    expect(Boolean(box.querySelector('.katex-display'))).toBe(true);
  });
  for (const source of ['`\\(x\\)`', '```text\n\\(x\\)\n```', '    \\(x\\)']) {
    test(`code does not render math: ${source}`, () => {
      const box = document.createElement('div');
      box.innerHTML = renderCardHtml(BASIC_NOTE_TYPE, { Front: source, Back: '' }, 'front');
      expect(Boolean(box.querySelector('.katex'))).toBe(false);
      expect(box.querySelector('code')?.textContent?.trim()).toBe('\\(x\\)');
    });
  }
  for (const source of [
    '```ts\nconst value: Array<T> = [];\n```',
    '`<button onclick="example()">OK</button>`',
    '```html\n<script>alert(1)</script>\n```',
    '<svg onload="example()"><script>example()</script></svg>',
    '[unsafe](javascript:alert(1)) ![unsafe](https://evil.test/pixel.png)',
    '<img src=x onerror=alert(1)>',
    '<iframe src="javascript:alert(1)"></iframe>',
  ]) {
    test(`save to render keeps executable input inert: ${source.slice(0, 35)}`, () => {
      const fields = sanitizeFieldValues({ Front: source, Back: 'answer' });
      expect(fields.Front).toBe(source);
      const box = document.createElement('div');
      box.innerHTML = resanitize(renderCardHtml(BASIC_NOTE_TYPE, fields, 'front'));
      expect(box.querySelector('script,svg,iframe,img,button,style')).toBeNull();
      expect(box.querySelector('[onload],[onerror],[onclick],[style]')).toBeNull();
      expect(box.querySelector('[href^="javascript:"]')).toBeNull();
      if (source.includes('Array<T>')) expect(box.textContent).toContain('Array<T>');
      if (source.includes('<script>')) expect(box.textContent).toContain('<script>');
    });
  }
});
