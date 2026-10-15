// M4 — client API surface for the PDF reader: the binary file fetch (with byte
// progress) + the per-page ink annotation GET/PUT. The file route returns raw
// bytes (not JSON), so Eden can't carry it — we hand-fetch `NEXT_PUBLIC_API_URL`
// with `credentials:'include'` exactly like chat-stream.ts. The annotation
// JSON routes go through Eden via the loose `(api as any)` path (the store's
// established escape hatch for endpoints Eden's path inference chokes on).

import type {
  MarkRect,
  PageAnnotations,
  SourceMarkColor,
  SourceMarkKind,
} from '@reomi/shared';
import { api, apiErrorFromResponse, ok } from '@/lib/api';
import { CooldownError } from '@/lib/store';
import type { QuickCardResult, SourceMark, SuggestCardResult } from '@/lib/types';

// Same origin resolution as lib/api.ts / chat-stream.ts.
const baseURL =
  typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL
    ? process.env.NEXT_PUBLIC_API_URL
    : 'http://localhost:3000';

export interface PageAnnotationRow {
  page: number;
  strokes: PageAnnotations;
  markedText: string | null;
  updatedAt: string;
}

/**
 * Fetch the original source bytes (`GET /sources/:id/file`) into an ArrayBuffer,
 * reporting download progress when the server sends content-length. Throws on a
 * non-2xx response (caller renders the reader error state).
 */
export async function fetchSourceFile(
  sourceId: string,
  opts?: { signal?: AbortSignal; onProgress?: (loaded: number, total: number | null) => void },
): Promise<ArrayBuffer> {
  const res = await fetch(`${baseURL}/sources/${sourceId}/file`, {
    credentials: 'include',
    signal: opts?.signal,
  });
  if (!res.ok) throw await apiErrorFromResponse(res, `file ${res.status}`);

  const lenHeader = res.headers.get('content-length');
  const total = lenHeader ? Number(lenHeader) : null;

  // Stream with progress when a body reader is available; otherwise fall back to
  // arrayBuffer() (still correct, just no granular progress).
  if (!res.body || typeof res.body.getReader !== 'function') {
    const buf = await res.arrayBuffer();
    opts?.onProgress?.(buf.byteLength, total);
    return buf;
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      opts?.onProgress?.(loaded, total && total >= loaded ? total : null);
    }
  }
  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out.buffer;
}

/** GET /sources/:id/annotations → all page rows (ordered by page). */
export async function fetchAnnotations(sourceId: string): Promise<PageAnnotationRow[]> {
  const body = (await ok(
    await (api as any).sources({ id: sourceId }).annotations.get(),
  )) as { items: PageAnnotationRow[] };
  return body.items ?? [];
}

/**
 * PUT /sources/:id/annotations/:page. Empty `strokes.strokes` ⇒ the server
 * DELETEs the row (clear). `markedText` is the geometric extraction; omit it
 * when clearing.
 */
export async function saveAnnotation(
  sourceId: string,
  page: number,
  strokes: PageAnnotations,
  markedText?: string,
): Promise<void> {
  await ok(
    await (api as any)
      .sources({ id: sourceId })
      .annotations({ page })
      .put({ strokes, markedText }),
  );
}

// ── Reading-workflow marks (M5) ───────────────────────────────────────────────
// Text-selection highlights/notes. Like the annotation JSON routes above, these
// ride Eden through the loose `(api as any)` path (the store's escape hatch).

/** GET /sources/:id/marks → all marks (ordered page ASC, createdAt ASC). */
export async function fetchMarks(sourceId: string): Promise<SourceMark[]> {
  const body = (await ok(await (api as any).sources({ id: sourceId }).marks.get())) as {
    items: SourceMark[];
  };
  return body.items ?? [];
}

export interface CreateMarkInput {
  page: number;
  kind: SourceMarkKind;
  quote: string;
  rects: MarkRect[];
  color?: SourceMarkColor;
  note?: string;
}

/** POST /sources/:id/marks → the created mark row. */
export async function createMark(sourceId: string, input: CreateMarkInput): Promise<SourceMark> {
  return (await ok(
    await (api as any).sources({ id: sourceId }).marks.post(input),
  )) as SourceMark;
}

/** PATCH /sources/:id/marks/:markId → the updated mark row. */
export async function updateMark(
  sourceId: string,
  markId: string,
  patch: { color?: SourceMarkColor; note?: string },
): Promise<SourceMark> {
  return (await ok(
    await (api as any).sources({ id: sourceId }).marks({ markId }).patch(patch),
  )) as SourceMark;
}

/** DELETE /sources/:id/marks/:markId. */
export async function deleteMark(sourceId: string, markId: string): Promise<void> {
  await ok(await (api as any).sources({ id: sourceId }).marks({ markId }).delete());
}

// ── Quick card + AI formulate (M5) ────────────────────────────────────────────

export interface QuickCardInput {
  pdfSelection?: import('@reomi/shared').PdfCardSelection;
  textSelection?: import('@reomi/shared').SourceTextSelection;
  deckId: string;
  front: string;
  back: string;
  page?: number;
  quote?: string;
  /** W4: selection/marquee rects → server inserts a source_marks row + returns markId. */
  rects?: MarkRect[];
}

/** POST /sources/:id/quick-card → { noteId, cardIds } (provenance written tx-side). */
export async function quickCard(sourceId: string, input: QuickCardInput): Promise<QuickCardResult> {
  return (await ok(
    await (api as any).sources({ id: sourceId })['quick-card'].post(input),
  )) as QuickCardResult;
}

/** POST /sources/:id/suggest-card → { front, back }. Throws on 503 (ai off) / 502
 *  (parse fail) — the caller keeps the user's manual values + shows a toast. */
export async function suggestCard(
  sourceId: string,
  input: { quote: string; page?: number; locale?: string },
): Promise<SuggestCardResult> {
  const res = await (api as any).sources({ id: sourceId })['suggest-card'].post(input);
  if (res.error?.status === 429 && res.error.value?.error === 'cooldown') {
    throw new CooldownError(Number(res.error.value.retryAfterMs) || 0);
  }
  return (await ok(res)) as SuggestCardResult;
}
