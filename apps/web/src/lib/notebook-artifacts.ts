// Pure helpers for the «Блокноты 2.0» N2 studio artifact viewer. DOM-free so
// they unit-test under `bun test` (the repo has no component-render harness).
//
// An artifact's `content_md` carries `[src:<chunkId>]` grounding tokens (the
// server has already intersected them against the sampled context, Р5). The
// reader renders the prose with the tokens INTACT — the inline-citation DOM
// decoration (`useInlineCitations`, mirroring the chat path) swaps each token
// for a clickable numbered superscript AFTER the markdown render, and the
// numbered footnote row at the foot duplicates them. These helpers do the token
// bookkeeping (numbering by first appearance) WITHOUT touching HTML — injecting
// `<sup>` here would be escaped to literal text by markdown-it (`html:false`).

import { SRC_TOKEN_RE } from '@reomi/shared';

/**
 * A single-field "basic" note-type that feeds artifact markdown through the card
 * render pipeline (markdown-it → DOMPurify via SafeHtml / RichCard) — same
 * pattern as the notes panel + chat AssistantMarkdown. The sanitizer stays the
 * single boundary. Shared between the studio panel and the artifact reader so the
 * shim is never duplicated.
 */
export const ARTIFACT_MD_NOTE_TYPE = {
  kind: 'basic' as const,
  templates: [
    { name: 'artifact', ord: 0, frontTemplate: '{{Body}}', backTemplate: '{{Body}}' },
  ],
};

export interface ArtifactFootnote {
  n: number;
  chunkId: string;
}

/**
 * Build the artifact's citation numbering from its markdown. The prose is
 * returned UNCHANGED (tokens intact — the DOM decorator owns the inline swap),
 * alongside a numbered footnote list of the distinct `[src:<chunkId>]` ids in
 * order of first appearance and a `numbering` Map (chunkId → 1-based number) the
 * decorator consumes to render the inline superscript chips.
 */
export function parseArtifactCitations(content: string): {
  prose: string;
  footnotes: ArtifactFootnote[];
  numbering: Map<string, number>;
} {
  const numbering = new Map<string, number>();
  const order: string[] = [];
  // Fresh literal — the shared token regex carries the `g` flag; never reuse a
  // global `lastIndex`.
  const re = new RegExp(SRC_TOKEN_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const id = match[1]!;
    if (numbering.has(id)) continue;
    numbering.set(id, order.length + 1);
    order.push(id);
  }
  return {
    prose: content,
    footnotes: order.map((chunkId, i) => ({ n: i + 1, chunkId })),
    numbering,
  };
}

/** Strip `[src:]` tokens entirely + collapse leftover runs of spaces (for «copy»). */
export function stripSrcTokens(content: string): string {
  return content.replace(new RegExp(SRC_TOKEN_RE), '').replace(/[ \t]{2,}/g, ' ').trim();
}
