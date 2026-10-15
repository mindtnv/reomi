'use client';

// Inline numbered source-citation chips (Notebooks redesign, A2) — client-side
// DOM decoration of the rendered markdown, applied AFTER React commits the
// SafeHtml output. Mirrors `code-copy.ts`: the sanitizer is NEVER touched, the
// injected chip exists only in the live DOM.
//
// In notebook mode the prose keeps its `[src:<chunkId>]` tokens (the card-mode
// renderer strips them). markdown-it renders a bare `[src:abc]` as literal text,
// so the token lands inside text nodes of the sanitized output. This pass walks
// those text nodes and swaps each token for a clickable superscript number
// (NBCite from the design) — or removes it entirely when the chunk id has no
// assigned number (a token whose citation was dropped).

import { useEffect, type RefObject } from 'react';
import { SRC_TOKEN_RE, type SourceCitation } from '@reomi/shared';

/** Build the chip element for one citation number. The click handler is wired
 *  by the caller (it owns the per-chunk SourceCitation). */
function makeCiteChip(n: number, onClick: () => void): HTMLElement {
  const chip = document.createElement('sup');
  chip.className = 'nn-nb-cite';
  chip.setAttribute('data-nn-cite', '1');
  chip.setAttribute('role', 'button');
  chip.setAttribute('tabindex', '0');
  chip.textContent = String(n);
  chip.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  chip.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  });
  return chip;
}

/**
 * Replace every `[src:<chunkId>]` token under `root` with a numbered chip.
 * `numberOf` maps a chunk id to its 1-based number; `citationOf` resolves a chunk
 * id to its SourceCitation (for the click payload). `onClick` opens the reader.
 * Idempotent via the `data-nn-cited` marker on processed text-node parents.
 */
export function decorateInlineCitations(
  root: HTMLElement,
  numberOf: Map<string, number>,
  citationOf: (chunkId: string) => SourceCitation | undefined,
  onClick: (c: SourceCitation) => void,
): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.nodeValue ?? '';
      // Fresh test (token regex has the `g` flag — never reuse lastIndex).
      return new RegExp(SRC_TOKEN_RE.source).test(text)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const targets: Text[] = [];
  let cur = walker.nextNode();
  while (cur) {
    targets.push(cur as Text);
    cur = walker.nextNode();
  }

  for (const textNode of targets) {
    const parent = textNode.parentNode;
    if (!parent) continue;
    const text = textNode.nodeValue ?? '';
    const frag = document.createDocumentFragment();
    let last = 0;
    const re = new RegExp(SRC_TOKEN_RE.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const [token, chunkId] = match;
      if (match.index > last) {
        frag.appendChild(document.createTextNode(text.slice(last, match.index)));
      }
      const n = numberOf.get(chunkId);
      const citation = citationOf(chunkId);
      if (n != null && citation) {
        frag.appendChild(makeCiteChip(n, () => onClick(citation)));
      }
      // Token with no number/citation: drop it (no marker, no chip).
      last = match.index + token.length;
    }
    if (last < text.length) {
      frag.appendChild(document.createTextNode(text.slice(last)));
    }
    parent.replaceChild(frag, textNode);
  }
}

/**
 * Hook wiring — decorates the host after each FINAL render (no churn while
 * tokens stream; SafeHtml replaces the host DOM on every delta, orphaning chips
 * anyway). `enabled` gates the whole pass off for card-mode answers (where the
 * tokens were already stripped from the prose).
 */
export function useInlineCitations(
  ref: RefObject<HTMLElement | null>,
  deps: { html: string; final: boolean; enabled: boolean },
  numberOf: Map<string, number>,
  citationOf: (chunkId: string) => SourceCitation | undefined,
  onClick: (c: SourceCitation) => void,
): void {
  useEffect(() => {
    if (!deps.enabled || !deps.final) return;
    const host = ref.current;
    if (!host) return;
    decorateInlineCitations(host, numberOf, citationOf, onClick);
    // `html` change re-runs the pass (SafeHtml re-renders → tokens reappear).
  }, [ref, deps.enabled, deps.final, deps.html, numberOf, citationOf, onClick]);
}
