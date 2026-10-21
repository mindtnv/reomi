import { expect, test } from 'bun:test';
import { captureStablePage } from './stable-capture';
import type { CaptureResult } from './types';

test('a navigation during delayed content injection cannot send an old page under a new URL', async () => {
  const original = 'https://example.test/article'; let current = original;
  let finish!: (value: CaptureResult) => void;
  const pending = captureStablePage(original, () => new Promise(resolve => { finish = resolve; }), async () => current);
  current = 'https://different.test/private';
  finish({ ok: true, capture: { url: original, title: 'Old article', text: 'Old page text', selection: '' } });
  await expect(pending).rejects.toThrow('changed_page');
});
test('a mismatched injected result or closed tab is rejected; a stable source retains its full text', async () => {
  const original = 'https://example.test/article', capture = { url: original, title: 'Article', text: 'Full preview', selection: 'Preview' };
  expect(await captureStablePage(original, async () => ({ ok: true, capture }), async () => original)).toEqual(capture);
  await expect(captureStablePage(original, async () => ({ ok: true, capture }), async () => undefined)).rejects.toThrow('changed_page');
  await expect(captureStablePage(original, async () => ({ ok: true, capture: { ...capture, url: 'https://example.test/next' } }), async () => original)).rejects.toThrow('changed_page');
  let read = false;
  await expect(captureStablePage('file:///private', async () => { read = true; return undefined; }, async () => undefined)).rejects.toThrow('unsupported');
  expect(read).toBe(false);
});
