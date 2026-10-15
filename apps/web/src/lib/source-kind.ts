// Single source of truth for source-kind → accent-tone mapping (P2.6 dedup).
// Two consumers shapes existed before:
//   • notebooks.tsx wanted a ready-to-use CSS-var color string (`var(--rose-500)`)
//     for `color-mix()` / `color` inline styles.
//   • notebook-workspace.tsx wanted a bare tone NAME (`rose`) to interpolate into
//     `var(--${tone}-500)` / `var(--${tone}-600)`.
// One map of tone names + two thin accessors keeps both honest.

import type { RenderKind } from '@reomi/shared';
import type { SourceKind } from '@reomi/shared';
import type { BadgeTone } from '@/components/ui';

/** Accent tone names (match the CSS `--<tone>-NNN` token families). */
export type SourceKindTone = 'rose' | 'violet' | 'sky' | 'amber';

const SOURCE_KIND_TONE: Record<SourceKind, SourceKindTone> = {
  pdf: 'rose',
  epub: 'violet',
  url: 'sky',
  text: 'amber',
};

/** The bare tone name (e.g. 'rose') — for `var(--${tone}-500)` interpolation. */
export function sourceKindToneName(kind: SourceKind): SourceKindTone {
  return SOURCE_KIND_TONE[kind] ?? 'sky';
}

/** A ready CSS-var color string (e.g. 'var(--rose-500)') — for color-mix / color. */
export function sourceKindToneVar(kind: SourceKind): string {
  return `var(--${sourceKindToneName(kind)}-500)`;
}

// ── Note render-kind → badge tone ──────────────────────────────────────────────
// A distinct enum (the note-type render kind, not a source kind), kept here so
// the cards-browser "variant" badge shares one tone vocabulary with the library.
export const RENDER_KIND_BADGE_TONE: Record<RenderKind, BadgeTone> = {
  basic: 'lime',
  cloze: 'violet',
  typein: 'amber',
  custom: 'sky',
};
