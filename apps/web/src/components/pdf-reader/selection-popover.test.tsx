import { ensureTestDom, GlobalRegistrator } from '../../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import en from '../../lib/messages/en/notebooks';
import ru from '../../lib/messages/ru/notebooks';
import { DialogProvider } from '../dialog';
import { SOURCE_MARK_COLORS } from '@reomi/shared';
import { SelectionPopover, type SelectionInfo } from './selection-popover';
ensureTestDom();
const { createRoot } = await import('react-dom/client');
let root: Root, host: HTMLDivElement, page: HTMLDivElement;
let previousRects: typeof Range.prototype.getClientRects;
beforeEach(() => {
  ensureTestDom(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); page = document.createElement('div'); page.textContent = 'Selected PDF passage'; document.body.append(host, page); root = createRoot(host);
  page.getBoundingClientRect = () => new DOMRect(20, 50, 600, 800);
  previousRects = Range.prototype.getClientRects;
  Range.prototype.getClientRects = (() => [new DOMRect(100, 200, 180, 18)]) as any;
});
afterEach(async () => { await act(async () => root.unmount()); window.getSelection()?.removeAllRanges(); host.remove(); page.remove(); Range.prototype.getClientRects = previousRects; delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });
afterAll(() => { try { GlobalRegistrator.unregister(); } catch {} });
const button = (text: string) => [...document.querySelectorAll('button')].find(element => element.textContent === text)!;
async function select() {
  await act(async () => {
    const range = document.createRange(); range.selectNodeContents(page); window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange')); await new Promise(resolve => setTimeout(resolve, 80));
  });
}
test('selection actions expose the full palette and Ask preserves the exact quote and page', async () => {
  let asked: SelectionInfo | undefined;
  await act(async () => root.render(<DialogProvider><SelectionPopover pageEls={new Map([[7, page]])} handMode onHighlight={() => {}} onNote={() => {}} onCard={() => {}} onAsk={value => { asked = value; }} t={key => key}/></DialogProvider>));
  await select();
  expect(document.querySelectorAll('.reomi-pdf-selection-colors button')).toHaveLength(SOURCE_MARK_COLORS.length);
  expect(SOURCE_MARK_COLORS).toHaveLength(10);
  await act(async () => button('assistant.askObject').click());
  expect(asked).toMatchObject({ page: 7, text: 'Selected PDF passage' });
  expect(asked!.rects.length).toBeGreaterThan(0);
  expect(document.querySelector('#nn-sel-popover')).toBeNull();
});
test('a failed highlight keeps the passage and allows retry by normal button activation', async () => {
  let attempts = 0;
  await act(async () => root.render(<DialogProvider><SelectionPopover pageEls={new Map([[1, page]])} handMode onHighlight={async () => { if (++attempts === 1) throw new Error('offline'); }} onNote={() => {}} onCard={() => {}} onAsk={() => {}} t={key => key}/></DialogProvider>));
  await select();
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="notebooks.marks.color_blue"]')!.click());
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('assistant.selectionSaveFailed');
  expect(document.querySelector('blockquote')?.textContent).toBe('Selected PDF passage');
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="notebooks.marks.color_blue"]')!.click());
  expect(attempts).toBe(2); expect(document.querySelector('#nn-sel-popover')).toBeNull();
});
test('moving focus into the note editor does not close the selected-passage panel', async () => {
  await act(async () => root.render(<DialogProvider><SelectionPopover pageEls={new Map([[1, page]])} handMode onHighlight={() => {}} onNote={() => {}} onCard={() => {}} onAsk={() => {}} t={key => key}/></DialogProvider>));
  await select(); await act(async () => button('notebooks.marks.note').click());
  await act(async () => {
    document.querySelector<HTMLTextAreaElement>('#nn-sel-popover textarea')!.focus(); window.getSelection()?.removeAllRanges();
    document.dispatchEvent(new Event('selectionchange')); await new Promise(resolve => setTimeout(resolve, 80));
  });
  expect(document.querySelector('#nn-sel-popover textarea')).not.toBeNull();
  expect(document.querySelector('blockquote')?.textContent).toBe('Selected PDF passage');
});


test('every selection color and action label exists in the marks locale namespace', () => {
  for (const locale of [en, ru]) {
    for (const color of SOURCE_MARK_COLORS) expect(locale.marks[`color_${color}`].length).toBeGreaterThan(0);
    expect(locale.marks.selectionTitle.length).toBeGreaterThan(0);
    expect(locale.marks.selectionAskPrompt.length).toBeGreaterThan(0);
  }
});

test('selection tint is composited once for overlapping PDF text spans and removed on dismiss', async () => {
  Range.prototype.getClientRects = (() => [new DOMRect(100, 200, 120, 20), new DOMRect(210, 201, 80, 18)]) as any;
  await act(async () => root.render(<DialogProvider><SelectionPopover pageEls={new Map([[1, page]])} handMode onHighlight={() => {}} onNote={() => {}} onCard={() => {}} onAsk={() => {}} t={key => key}/></DialogProvider>));
  await select();
  const paint = page.querySelector<HTMLElement>('[data-pdf-selection-paint]')!;
  expect(paint.style.opacity).toBe('0.3');
  expect(paint.style.pointerEvents).toBe('none');
  expect(paint.children.length).toBe(1);
  await act(async () => button('assistant.askObject').click());
  expect(page.querySelector('[data-pdf-selection-paint]')).toBeNull();
});

test('PDF selection ignores layout and whitespace sentinels outside selected glyphs', async () => {
  page.innerHTML = '<div class="nn-textlayer"><span>Selected PDF passage</span><span> </span><div class="endOfContent"></div></div>';
  Range.prototype.getClientRects = function (this: Range) {
    return this.startContainer.nodeType === 3 ? [new DOMRect(100, 200, 180, 18)] : [new DOMRect(20, 50, 4, 800), new DOMRect(100, 200, 180, 18)];
  } as any;
  await act(async () => root.render(<DialogProvider><SelectionPopover pageEls={new Map([[1, page]])} handMode onHighlight={() => {}} onNote={() => {}} onCard={() => {}} onAsk={() => {}} t={key => key}/></DialogProvider>));
  await select();
  const paint = page.querySelector('[data-pdf-selection-paint]')!;
  expect(paint.children.length).toBe(1);
  expect((paint.firstElementChild as HTMLElement).style.height).toBe('2.25%');
});

test('Ask cannot discard an unsaved PDF comment and the comment toggle uses the same decision', async () => {
  let asks = 0;
  await act(async () => root.render(<DialogProvider><SelectionPopover pageEls={new Map([[1, page]])} handMode onHighlight={() => {}} onNote={() => {}} onCard={() => {}} onAsk={() => { asks++; }} t={key => key}/></DialogProvider>));
  await select(); await act(async () => button('notebooks.marks.note').click());
  await act(async () => { const input = document.querySelector<HTMLTextAreaElement>('#nn-sel-popover textarea')!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Keep this annotation'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => button('assistant.askObject').click());
  expect(asks).toBe(0); expect(document.body.textContent).toContain('editor.draft.leaveTitle');
  await act(async () => button('editor.draft.stay').click());
  expect(document.querySelector<HTMLTextAreaElement>('#nn-sel-popover textarea')!.value).toBe('Keep this annotation');
  await act(async () => button('notebooks.marks.note').click());
  expect(document.body.textContent).toContain('editor.draft.leaveTitle');
  await act(async () => button('editor.draft.stay').click());
  expect(document.querySelector<HTMLTextAreaElement>('#nn-sel-popover textarea')!.value).toBe('Keep this annotation');
});
