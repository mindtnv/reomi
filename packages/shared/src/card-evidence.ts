import type { SourceTextSelection } from './source-text-selection';
/** Immutable, bounded evidence kept even when live source/chunk links detach. */
interface CardEvidenceOrigin { version: 1; sourceId: string; sourceTitle: string; quote: string; page?: number; startSeconds?: number }
export interface ChunkCardEvidenceSnapshot extends CardEvidenceOrigin {
  kind?: 'chunk';
  chunkId: string;
  position: number;
  textHash: string;
  sourceVersion?: never;
}
export interface QuotedCardEvidenceSnapshot extends CardEvidenceOrigin {
  kind: 'user_quote';
  sourceVersion: string;
  chunkId?: never;
  position?: never;
  textHash?: never;
}
/** A manual rendered-text selection: locator verified, quote remains user supplied. */
export interface SelectionCardEvidenceSnapshot extends Omit<ChunkCardEvidenceSnapshot, 'kind'> {
  kind: 'user_selection';
  selection: SourceTextSelection;
}
export type CardEvidenceSnapshot = ChunkCardEvidenceSnapshot | QuotedCardEvidenceSnapshot | SelectionCardEvidenceSnapshot;

/** A PDF text-layer selection tied to the source version displayed by the reader. */
export interface PdfCardSelection {
  version: 1;
  page: number;
  quote: string;
  sourceVersion: string;
}
