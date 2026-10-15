// Shared NotebookLM-source constants + types (M1). DOM-free, Node-free — consumed
// by BOTH edges so the web pre-check and the server presign/ingest agree on what
// is an allowed source upload, the source kinds/statuses, and the ingest error
// codes (machine codes, mapped to i18n on the client — never English prose in
// the DB). Single source of truth, like MEDIA_MIME_ALLOWLIST / ANKI_DEFAULTS.

/** Source categories the user can add to a notebook. */
export const SOURCE_KINDS = ['pdf', 'epub', 'url', 'text', 'youtube'] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** Source kinds that carry uploaded bytes (need presign→finalize). url/text don't. */
export const UPLOAD_SOURCE_KINDS = ['pdf', 'epub'] as const;
export type UploadSourceKind = (typeof UPLOAD_SOURCE_KINDS)[number];

/** Ingest lifecycle status (the `sources.status` column). */
export const SOURCE_STATUSES = [
  'pending',
  'parsing',
  'indexing',
  'ready',
  'error',
  'deleting',
] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

/** Non-terminal statuses the ingest worker resumes/claims. */
export const SOURCE_NONTERMINAL_STATUSES = ['pending', 'parsing', 'indexing'] as const;

/**
 * Allowed MIME types for UPLOADED source bytes (pdf / epub). Separate from
 * MEDIA_MIME_ALLOWLIST (images-only) so generalizing sources never touches the
 * media invariant. `text/plain` + `text/markdown` ride INLINE (no upload), so
 * they're validated by `kind`, not this allowlist.
 */
export const SOURCE_MIME_ALLOWLIST = ['application/pdf', 'application/epub+zip'] as const;
export type SourceMime = (typeof SOURCE_MIME_ALLOWLIST)[number];

/** Maps an upload mime to its source kind (for presign validation). */
export const SOURCE_MIME_TO_KIND: Record<SourceMime, UploadSourceKind> = {
  'application/pdf': 'pdf',
  'application/epub+zip': 'epub',
};

/**
 * Machine error codes stored in `sources.error_code` (NOT prose). The web client
 * maps each to a `notebooks.status.*` i18n key. Adding a code requires an i18n
 * entry in BOTH locales (enforced by the i18n-parity test).
 */
export const INGEST_ERROR_CODES = [
  'too_large',
  'too_many_chunks',
  'parse_failed',
  'index_failed',
  'fetch_failed',
  'unsupported_mime',
  'empty_source',
  'no_subtitles',
  'video_unavailable',
] as const;
export type IngestErrorCode = (typeof INGEST_ERROR_CODES)[number];

/** Default per-file source byte ceiling (25 MiB) — overridable via MAX_SOURCE_BYTES. */
export const MAX_SOURCE_BYTES_DEFAULT = 25 * 1024 * 1024;

/** Max provenance source-chunks auto-linked per generated card (M3 server cap). */
export const CARD_PROVENANCE_LINK_CAP = 5;
