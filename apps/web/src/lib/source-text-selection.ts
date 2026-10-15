import { ASSISTANT_CONTEXT_LIMITS, normalizeSourceText, parseSourceTextSelection, type SourceTextSegment, type SourceTextSelection } from '@reomi/shared';
const ignored = 'button,script,style,.katex-mathml,[data-source-selection-ui]';
const blocks = 'p,div,li,pre,h1,h2,h3,h4,h5,h6,blockquote,td,th,.katex-display';
function renderedText(body: HTMLElement, legacy = false) {
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: node => node.nodeType === Node.ELEMENT_NODE && (node as Element).matches(ignored) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: { node: Node; start: number; end: number }[] = [];
  if (body.closest(ignored)) return { full: '', nodes };
  let full = '', node: Node | null, previousBlock: Element | null = null;
  while ((node = walker.nextNode())) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (!legacy && (node as Element).tagName === 'BR') full += '\n';
      continue;
    }
    if (node.nodeType !== Node.TEXT_NODE || !node.textContent) continue;
    const block = node.parentElement?.closest(blocks) ?? body;
    if (!legacy && full && previousBlock && block !== previousBlock) full += '\n';
    const start = full.length; full += node.textContent;
    nodes.push({ node, start, end: full.length }); previousBlock = block;
  }
  return { full, nodes };
}

function contextSlice(text: string, start: number, end: number): string {
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start] ?? '') && /[\uD800-\uDBFF]/.test(text[start - 1] ?? '')) start++;
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '') && /[\uDC00-\uDFFF]/.test(text[end] ?? '')) end--;
  return text.slice(start, end);
}
async function hash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2,'0')).join('');
}
/** Read only rendered source-body text, never reader headings, page labels, copy buttons or
 * KaTeX's duplicate accessible MathML. A missing mapping degrades to a quote. */
export async function captureSourceTextSelection(host: HTMLElement, range: Range, rawChunks: ReadonlyMap<string,string>): Promise<SourceTextSelection | null> {
  if (range.collapsed || !host.contains(range.startContainer) || !host.contains(range.endContainer)) return null;
  const parts: { id: string; text: string; quote: string; start: number; end: number }[] = [];
  for (const body of host.querySelectorAll<HTMLElement>('[data-source-text-body]')) {
    const { full, nodes } = renderedText(body);
    let first = -1, last = -1;
    for (const { node, start: base } of nodes) {
      const text = node.textContent ?? '';
      if (!range.intersectsNode(node)) continue;
      const start = range.startContainer === node ? range.startOffset : 0;
      const end = range.endContainer === node ? range.endOffset : text.length;
      if (end <= start) continue;
      if (first < 0) first = base + start;
      last = base + end;
    }
    const quote = first < 0 ? '' : normalizeSourceText(full.slice(first, last));
    if (!quote) continue;
    const normalized = normalizeSourceText(full);
    const prefixLength = (index: number) => Math.min(normalized.length, full.slice(0,index).normalize('NFC').replace(/\s+/gu,' ').trimStart().length);
    parts.push({ id: body.closest<HTMLElement>('[data-chunk-id]')?.dataset.chunkId ?? '', text: normalized, quote, start: prefixLength(first), end: prefixLength(last) });
  }
  if (!parts.length) return null;
  const quote = parts.map(part => part.quote).join(' ');
  if (quote.length > ASSISTANT_CONTEXT_LIMITS.excerptChars || parts.length > ASSISTANT_CONTEXT_LIMITS.passageChunks) throw new Error('context_excerpt_too_large');
  const chunks: SourceTextSegment[] = [];
  let anchored = true;
  for (const part of parts) {
    const raw = rawChunks.get(part.id);
    if (raw === undefined || part.text.slice(part.start,part.end) !== part.quote) { anchored = false; break; }
    chunks.push({ chunkId: part.id, textHash: await hash(raw), renderedHash: await hash(part.text), start: part.start, end: part.end });
  }
  const first = parts[0]!, last = parts.at(-1)!;
  return parseSourceTextSelection({ version: 1, quote, chunks: anchored ? chunks : [],
    prefix: contextSlice(first.text, Math.max(0,first.start - 120), first.start), suffix: contextSlice(last.text, last.end, Math.min(last.text.length,last.end + 120)) });
}

/** Rebuild a browser range only while the rendered-text fingerprint still
 * matches. Raw text freshness is checked by the API before this is called. */
export async function restoreSourceTextRange(body: HTMLElement, segment: SourceTextSegment): Promise<Range | null> {
  let { full, nodes } = renderedText(body);
  let normalized = normalizeSourceText(full);
  if (await hash(normalized) !== segment.renderedHash) {
    // Stored v1 marks from the earlier serializer did not add block separators.
    // Restore only when that exact historical text fingerprint still matches.
    ({ full, nodes } = renderedText(body, true));
    normalized = normalizeSourceText(full);
    if (await hash(normalized) !== segment.renderedHash) return null;
  }
  if (segment.end > normalized.length) return null;
  const lengthAt = (offset: number) => Math.min(normalized.length, full.slice(0,offset).normalize('NFC').replace(/\s+/gu,' ').trimStart().length);
  const boundary = (target: number, last: boolean) => {
    let lo = 0, hi = full.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + (last ? 1 : 0))/2);
      if (last ? lengthAt(mid) <= target : lengthAt(mid) < target) lo = last ? mid : mid + 1;
      else hi = last ? mid - 1 : mid;
    }
    return lo;
  };
  const start = boundary(segment.start, true), end = boundary(segment.end, false);
  const first = nodes.find(part => part.end > start), last = nodes.find(part => part.end >= end);
  if (!first || !last || start >= end) return null;
  const range = document.createRange(); range.setStart(first.node, start - first.start); range.setEnd(last.node, end - last.start);
  return range;
}
