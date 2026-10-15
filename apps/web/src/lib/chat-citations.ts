// Numbered source citations (Notebooks redesign, A2) — pure helpers.
//
// In notebook mode a grounded answer marks the passages it cites inline as
// `[src:<sourceChunkId>]` (the document analog of `[card:<id>]`). Instead of
// stripping those tokens (the card-mode behavior), the redesign renders them as
// small numbered chips ¹² and lists the matching sources under the answer.
//
// The numbering is PER MESSAGE and follows the order of FIRST appearance of a
// chunk id in the prose — so the same passage cited twice keeps one number, and
// the chips row reads top-to-bottom in the same order the reader meets them.
//
// Pure logic only (no React / DOM) so it is unit-tested directly; the inline
// chip injection lives in `components/chat/source-citations.ts` (DOM decoration,
// mirroring `code-copy.ts`).

import { SRC_TOKEN_RE, isSourceCitation, type Citation, type SourceCitation } from '@reomi/shared';

/** Deterministic cover tones — letter-tile background for a source, picked by a
 *  stable hash of its id so a given source always renders the same colour. */
export const CITATION_COVER_TONES = ['amber', 'sky', 'lime', 'violet', 'rose'] as const;
export type CitationCoverTone = (typeof CITATION_COVER_TONES)[number];

/** One numbered, resolved source citation for a message. */
export interface NumberedCitation {
  /** 1-based number shown in the inline chip and the chips row. */
  n: number;
  citation: SourceCitation;
}

export interface CitationNumbering {
  /** chunkId → 1-based number (only for chunk ids with a matching citation). */
  numberOf: Map<string, number>;
  /** Citations in first-appearance order, each carrying its number. */
  ordered: NumberedCitation[];
}

/**
 * Build the per-message citation numbering.
 *
 * Numbers are assigned by the order each `[src:<chunkId>]` token FIRST appears in
 * `content`, restricted to chunk ids that have a matching SourceCitation in
 * `citations`. Any source citation NOT referenced inline is appended after the
 * inline ones (so its chip still renders, in citation order). A token whose
 * chunk id has no matching citation is ignored (no number assigned).
 */
export function buildCitationNumbering(content: string, citations: Citation[]): CitationNumbering {
  const byChunkId = new Map<string, SourceCitation>();
  for (const c of citations) {
    if (isSourceCitation(c) && !byChunkId.has(c.sourceChunkId)) {
      byChunkId.set(c.sourceChunkId, c);
    }
  }

  const numberOf = new Map<string, number>();
  const ordered: NumberedCitation[] = [];

  // First appearance in prose drives the number. Fresh literal — never share a
  // global `lastIndex`.
  const re = new RegExp(SRC_TOKEN_RE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const chunkId = match[1];
    if (numberOf.has(chunkId)) continue;
    const citation = byChunkId.get(chunkId);
    if (!citation) continue;
    const n = ordered.length + 1;
    numberOf.set(chunkId, n);
    ordered.push({ n, citation });
  }

  // Append any source citations not referenced inline, preserving their order.
  for (const c of byChunkId.values()) {
    if (numberOf.has(c.sourceChunkId)) continue;
    const n = ordered.length + 1;
    numberOf.set(c.sourceChunkId, n);
    ordered.push({ n, citation: c });
  }

  return { numberOf, ordered };
}

/** True when at least one citation resolves to a number (notebook grounding). */
export function hasNumberedCitations(numbering: CitationNumbering): boolean {
  return numbering.ordered.length > 0;
}

// FNV-1a-ish stable hash → tone index. Deterministic across reloads.
function hashCode(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Stable cover tone for a source, keyed on its id. */
export function citationCoverTone(sourceId: string): CitationCoverTone {
  return CITATION_COVER_TONES[hashCode(sourceId) % CITATION_COVER_TONES.length];
}

/** First letter of a title for the mini letter-tile cover (uppercase). Falls
 *  back to a neutral glyph when the title is empty/unknown. */
export function citationCoverLetter(title: string | undefined): string {
  const trimmed = (title ?? '').trim();
  if (trimmed.length === 0) return '?';
  return Array.from(trimmed)[0]!.toUpperCase();
}

/**
 * Localized location suffix for a source chip — only the page (the one location
 * that actually exists on a SourceCitation). No page ⇒ null (chip shows title
 * only; never invent "chapter"/"section").
 */
export function citationLocation(
  citation: SourceCitation,
  t: (key: string, params?: Record<string, string | number>) => string,
): string | null {
  if (citation.page != null) return t('chat.source.page', { n: citation.page });
  return null;
}
