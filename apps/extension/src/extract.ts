import { Readability } from '@mozilla/readability';
import type { CaptureResult } from './types';

const privateFields = 'input,textarea,select,form,[contenteditable]:not([contenteditable="false"]),[role="textbox"]';
export function extractPage(doc: Document, view: Window): CaptureResult {
  let url: URL;
  try { url = new URL(doc.location.href); } catch { return { ok: false, error: 'unsupported' }; }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return { ok: false, error: 'unsupported' };
  let selection = '';
  const selected = view.getSelection();
  if (selected && !selected.isCollapsed && selected.rangeCount) {
    const range = selected.getRangeAt(0);
    const unsafe = doc.activeElement?.closest(privateFields) || [...doc.querySelectorAll(privateFields)].some(el => range.intersectsNode(el));
    if (!unsafe) selection = selected.toString().trim();
  }
  const original = [...doc.querySelectorAll('*')];
  if (original.length > 25000) return selection && selection.length <= 4000
    ? { ok: true, capture: { url: url.href, title: doc.title.slice(0, 300), text: '', selection } } : { ok: false, error: 'too_large' };
  const clone = doc.cloneNode(true) as Document;
  const copies = [...clone.querySelectorAll('*')];
  for (let i = copies.length - 1; i >= 0; i--) {
    const node = original[i], copy = copies[i];
    if (node.matches(`${privateFields},script,style,noscript,[hidden],[aria-hidden="true"],button`)) { copy.remove(); continue; }
    const style = view.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden') copy.remove();
  }
  const article = new Readability(clone, { charThreshold: 80 }).parse();
  const text = article?.textContent?.trim() ?? '';
  if (!text && !selection) return { ok: false, error: 'unreadable' };
  if (text.length > 200000 && !selection) return { ok: false, error: 'too_large' };
  return { ok: true, capture: { url: url.href, title: (article?.title?.trim() || doc.title || url.hostname).slice(0, 300), text, selection } };
}
