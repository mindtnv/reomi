import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { extractPage } from './extract';

const passage = 'Kubernetes manages containerized workloads and services. A Pod is the smallest deployable unit that you can create and manage. ';
function page(html: string, url = 'https://example.test/docs/pods#intro') {
  const window = new Window({ url });
  window.document.write(`<html><head><title>Learning Pods</title></head><body>${html}</body></html>`);
  return { window, doc: window.document, read: () => extractPage(window.document as unknown as Document, window as unknown as globalThis.Window) };
}
test('readable capture preserves paragraph boundaries and excludes forms, editable and hidden content', () => {
  const { read } = page(`<article><h1>Learning Pods</h1><p>${passage.repeat(4)}</p><p>Second paragraph with a separate idea. ${passage.repeat(4)}</p>
    <form><p>FORM_SECRET</p><input value="PASSWORD_SECRET" type="password"></form><textarea>TEXTAREA_SECRET</textarea>
    <div contenteditable="true">EDITOR_SECRET</div><p hidden>HIDDEN_SECRET</p><p style="display:none">CSS_SECRET</p><p aria-hidden="true">ARIA_SECRET</p></article>`);
  const result = read(); expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.capture.text).toContain('Kubernetes manages');
  expect(result.capture.text).toContain('\n\nSecond paragraph');
  expect(result.capture.text).not.toContain('_SECRET');
  expect(result.capture.url).toBe('https://example.test/docs/pods#intro');
});
test('selection outside inputs survives without a readable article; form selections never leave the page', () => {
  const { window, doc, read } = page('<p id="public">An explicit passage</p><form><p id="private">Private draft</p></form>');
  let range = doc.createRange(); range.selectNodeContents(doc.getElementById('public')!); window.getSelection().addRange(range);
  const selected = read(); expect(selected.ok && selected.capture.selection).toBe('An explicit passage');
  window.getSelection().removeAllRanges(); range = doc.createRange(); range.selectNodeContents(doc.getElementById('private')!); window.getSelection().addRange(range);
  const privateResult = read(); expect(privateResult.ok && privateResult.capture.selection).toBe('');
});
test('unsupported schemes, embedded credentials, empty pages and excessive whole-page text do not produce a capture', () => {
  for (const url of ['file:///tmp/private.html', 'chrome://settings', 'https://user:password@example.test/']) expect(page(`<article>${passage}</article>`,url).read()).toEqual({ ok: false, error: 'unsupported' });
  expect(page('').read()).toEqual({ ok: false, error: 'unreadable' });
  expect(page(`<article><p>${passage.repeat(2000)}</p></article>`).read()).toEqual({ ok: false, error: 'too_large' });
});
