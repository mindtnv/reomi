'use client';

/* eslint-disable react/forbid-elements -- #78 */

import { useNavigationScroll, NavigationRestoreNotice } from '@/lib/use-navigation-scroll';
import { NNIcon } from '@/components/ui';
import { PdfPageVisibility } from '@/lib/pdf-page-visibility';
import { readBrowserValue, writeBrowserValue } from '@/lib/storage-migration';

// M4 — native PDF reader. Renders the ORIGINAL PDF client-side with pdf.js
// (dynamically imported — never SSR'd), continuous vertical pages, Intersection
// Observer virtualization (±2 pages, aspect-ratio placeholders), fit-width
// default scale, toolbar/pinch zoom (0.5–4), a page indicator + jump, reading-
// position persistence, byte-fetch progress + an error state. Each page carries
// a devicePixelRatio ink overlay (InkLayer) persisted per (source,page) via a
// debounced PUT; the under-stroke text is extracted (pdf-ink.ts) from the page's
// lazily-cached text layer and stored as markedText so the AI can read the markup.
//
// M5 — adds:
//  • pdf.js TextLayer per page (lazy, cached, freed with virtualization)
//  • Highlights layer rendering from SourceMark rects
//  • «Разметка» (marks) panel with page-grouped marks + ink pages
//  • SelectionPopover (hand tool) for highlight / note / card / ask / copy actions
//  • QuickCardDialog for creating flashcards from selections or marks

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAppNavigation, useNavigationWorkspace, useWorkspaceState } from '@/components/navigation';
import type { InkStroke, MarkRect, PageAnnotations, SourceMarkColor } from '@reomi/shared';
import { ANNOTATION_MAX_STROKES, MARKED_TEXT_MAX } from '@reomi/shared';
import { extractMarkedText, textItemBBox, type PdfTextItem } from '@/lib/pdf-ink';
import { destroyPdfResources } from '@/lib/pdf-task-cleanup';
import {
  createMark,
  deleteMark,
  fetchAnnotations,
  fetchMarks,
  fetchSourceFile,
  saveAnnotation,
  updateMark,
} from '@/lib/pdf-annotations';
import type { SourceMark } from '@/lib/types';
import { useLocale } from '@/lib/i18n';
import { InkLayer } from './ink-layer';
import { MARK_COLOR_CSS } from './mark-colors';
import { MarksPanel } from './marks-panel';
import { QuickCardDialog } from './quick-card';
import { HarvestWizard } from './harvest-wizard';
import { ReaderToolbar } from './toolbar';
import { SelectionPopover, type SelectionInfo } from './selection-popover';
import {
  DEFAULT_TOOL_SETTINGS,
  loadToolSettings,
  saveToolSettings,
  type SaveState,
  type ToolSettings,
} from './types';

// The lib is dynamically imported (client-only), so we keep its proxies loosely
// typed (`any`) at the boundary — the real pdf.js render() param shape varies by
// version and isn't worth pinning structurally. Only the viewport dims we read
// are named.
interface PdfPageViewport {
  width: number;
  height: number;
}
/* eslint-disable @typescript-eslint/no-explicit-any */
type PdfPage = any;
type PdfDocument = import('pdfjs-dist').PDFDocumentProxy;
type PdfLoadingTask = import('pdfjs-dist').PDFDocumentLoadingTask;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** One PDF outline entry (L2 — table of contents), flattened with depth. */
export interface PdfOutlineEntry {
  title: string;
  /** 1-based page the entry points to, or null if it could not be resolved. */
  page: number | null;
  depth: number;
}

export interface PdfReaderHandle {
  scrollToPage: (page: number, flash?: boolean) => void;
  /** Resolve the document outline (table of contents) into flat entries with a
   *  1-based page each. Empty array when the PDF has no outline. (L2) */
  getOutline: () => Promise<PdfOutlineEntry[]>;
}

interface PdfReaderProps {
  sourceId: string;
  sourceName: string;
  sourceVersion?: string;
  /** Initial page to scroll to (1-based) — from a citation / ?page= deep link. */
  initialPage?: number;
  /** If defined, scroll + highlight this mark on mount (from ?mark= deep link). */
  initialMarkId?: string;
  t: (key: string, params?: Record<string, string | number>) => string;
  /** Switch the reader panel back to the text-chunk view. */
  onMode: (m: 'pdf' | 'text') => void;
  /** Called by «Спросить» to prefill the chat composer with a quote block. */
  onAskChat?: (quote: string, page: number) => void;
  chatEnabled?: boolean;
  /** L2 — fires on page change (current page + total) so the library reader can
   *  persist server-side reading progress (debounced by the parent). */
  onPageChange?: (page: number, numPages: number) => void;
  /** L2 — table-of-contents toolbar toggle (library reader owns the TOC panel). */
  tocOpen?: boolean;
  tocAvailable?: boolean;
  onToggleToc?: () => void;
  /** L3 — fires ONCE after the doc loads with metadata + a lazy page-1 cover
   *  renderer (the library reader uses it to backfill pageCount/author/cover —
   *  ONLY for DB fields that are still NULL). */
  onDocInfo?: (info: {
    numPages: number;
    author?: string;
    renderCover: () => Promise<Blob | null>;
  }) => void;
  /** L4 §8.4 — «Экспорт в Markdown» from the «Разметка» panel. The reader hands
   *  the parent the already-loaded marks + ink markedText (the parent owns the
   *  title/author/cardCount + i18n + download). */
  onExportMarkup?: (data: {
    marks: SourceMark[];
    ink: { page: number; markedText: string | null }[];
  }) => void;
}

interface PageState {
  strokes: InkStroke[];
  undo: InkStroke[][];
  redo: InkStroke[][];
}

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 4;
const SAVE_DEBOUNCE_MS = 800;
const POS_KEY = (id: string) => `nn:pdf:pos:${id}`;

export const PdfReader = forwardRef<PdfReaderHandle, PdfReaderProps>(
  ({ sourceId, sourceName, sourceVersion, initialPage, initialMarkId, t, onMode, onAskChat, chatEnabled = false, onPageChange, tocOpen, tocAvailable, onToggleToc, onDocInfo, onExportMarkup }, ref) => {
    const router = useAppNavigation();
    const navigationWorkspace=useNavigationWorkspace();
    const navigationScope=`source:${sourceId}`;
    const hasNavigationAnchor=Boolean(navigationWorkspace?.entry?.views[navigationScope]?.scrolls.pdf);
    const { locale } = useLocale();
    const containerRef = useRef<HTMLDivElement>(null);
    const readerRootRef=useRef<HTMLDivElement>(null);
    const pageElsRef = useRef<Map<number, HTMLDivElement>>(new Map());
    const pdfjsRef = useRef<any>(null);
    const docRef = useRef<PdfDocument | null>(null);
    const textCacheRef = useRef<Map<number, PdfTextItem[]>>(new Map());
    // M5 — text layer DOM containers keyed by page number, freed with virtualization.
    const textLayerEls = useRef<Map<number, HTMLDivElement>>(new Map());
    const textLayerInstances = useRef<Map<number, any>>(new Map());
    const renderedRef = useRef<Map<number, { canvas: HTMLCanvasElement; scale: number; task: any }>>(new Map());
    const saveTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

    const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
    const [loadProgress, setLoadProgress] = useState<{ loaded: number; total: number | null }>({ loaded: 0, total: null });
    const [numPages, setNumPages] = useState(0);
    // Unscaled (scale=1) page dims for aspect-ratio placeholders.
    const [pageDims, setPageDims] = useState<PdfPageViewport[]>([]);
    const [dimensionsThrough,setDimensionsThrough]=useState(0);
    const [scale, setScale] = useState(1);
    const [fitScale, setFitScale] = useState(1);
    const [visible, setVisible] = useState<Set<number>>(new Set([1]));
    const [currentPage, setCurrentPage] = useState(initialPage ?? 1);
    const [tools, setTools] = useState<ToolSettings>(DEFAULT_TOOL_SETTINGS);
    const [pages, setPages] = useState<Map<number, PageState>>(new Map());
    const [saveState, setSaveState] = useState<SaveState>('idle');
    // M5 — marks state.
    const [marks, setMarks] = useState<SourceMark[]>([]);
    const activeSource = useRef(sourceId); activeSource.current = sourceId;
    const [marksPanelOpen, setMarksPanelOpen] = useWorkspaceState(navigationScope,'marksOpen',false);
    // Feature #2 — harvest wizard open flag.
    const [harvestOpen, setHarvestOpen] = useState(false);
    // M5 — QuickCardDialog state. Opened from a text selection (the popover),
    // from an existing mark («В карточку» in the Разметка panel), or from the
    // W3 smart-card marquee tool. rects are for the card marker (W4).
    const [quickCardState, setQuickCardState] = useState<
      { page?: number; quote: string; sourceVersion?: string; prefillBack?: string; rects?: MarkRect[] } | null
    >(null);
    // W3 — smart-card marquee drag state (null when not dragging).
    const [marquee, setMarquee] = useState<{
      page: number; pointerId: number;
      x0: number; y0: number; // CSS px within the page div, start corner
      x1: number; y1: number; // CSS px within the page div, current corner
    } | null>(null);
    const marqueeRef = useRef(marquee);
    useEffect(() => { marqueeRef.current = marquee; }, [marquee]);

    const savedAnchor=navigationWorkspace?.entry?.views[navigationScope]?.scrolls.pdf;
    const initialTargetRef=useRef(Math.max(1,Number(savedAnchor?.endId??savedAnchor?.id??initialPage??1)||1));
    const dimensionsReady=dimensionsThrough>=Math.min(numPages||1,initialTargetRef.current);
    const initialPositionDone=useRef(false);
    const position = useNavigationScroll(navigationScope,'pdf',{ready:loadState==='ready'&&dimensionsReady&&pageDims.length===numPages&&numPages>0,fractional:true});
    const setContainerRef=useCallback((node:HTMLDivElement|null)=>{containerRef.current=node;position.ref(node);},[position.ref]);

    const pendingInitialPageRef = useRef<number | undefined>(initialPage);
    const pendingInitialMarkRef = useRef<string | undefined>(initialMarkId);

    // ── M5 — Marks: fetch on source change ────────────────────────────────────────
    useEffect(() => {
      let cancelled = false;
      void (async () => {
        try {
          const items = await fetchMarks(sourceId);
          if (!cancelled) setMarks(items);
        } catch {
          /* best-effort */
        }
      })();
      const refresh = (event: Event) => {
        if ((event as CustomEvent<string>).detail !== sourceId) return;
        fetchMarks(sourceId).then(items => { if (!cancelled) setMarks(items); }).catch(() => {});
      };
      window.addEventListener('nn:pdf-marks-changed', refresh);
      return () => { cancelled = true; window.removeEventListener('nn:pdf-marks-changed', refresh); };
    }, [sourceId]);

    // ── M5 — Mark CRUD helpers ────────────────────────────────────────────────────
    const handleHighlight = useCallback(async (info: SelectionInfo, color: SourceMarkColor) => {
        const mark = await createMark(sourceId, {
          page: info.page,
          kind: 'highlight',
          quote: info.text,
          rects: info.rects,
          color,
        });
        if (activeSource.current === sourceId) setMarks((prev) => [...prev, mark]);
    }, [sourceId]);

    const handleNote = useCallback(async (info: SelectionInfo, noteText: string) => {
        const mark = await createMark(sourceId, {
          page: info.page,
          kind: 'note',
          quote: info.text,
          rects: info.rects,
          color: 'lime',
          note: noteText,
        });
        if (activeSource.current === sourceId) setMarks((prev) => [...prev, mark]);
    }, [sourceId]);

    const handleMarkDelete = useCallback(async (markId: string) => {
      setMarks((prev) => prev.filter((m) => m.id !== markId));
      try {
        await deleteMark(sourceId, markId);
      } catch {
        // Re-fetch on error.
        fetchMarks(sourceId).then((items) => setMarks(items)).catch(() => {});
      }
    }, [sourceId]);

    const handleMarkColorChange = useCallback(async (markId: string, color: SourceMarkColor) => {
      setMarks((prev) => prev.map((m) => m.id === markId ? { ...m, color } : m));
      try {
        const updated = await updateMark(sourceId, markId, { color });
        setMarks((prev) => prev.map((m) => m.id === markId ? updated : m));
      } catch {
        fetchMarks(sourceId).then((items) => setMarks(items)).catch(() => {});
      }
    }, [sourceId]);

    const handleMarkNoteChange = useCallback(async (markId: string, note: string) => {
      setMarks((prev) => prev.map((m) => m.id === markId ? { ...m, note } : m));
      try {
        const updated = await updateMark(sourceId, markId, { note });
        setMarks((prev) => prev.map((m) => m.id === markId ? updated : m));
      } catch {
        fetchMarks(sourceId).then((items) => setMarks(items)).catch(() => {});
      }
    }, [sourceId]);

    const handleMarkClick = useCallback((mark: SourceMark) => {
      scrollToPage(mark.page, false);
      // Flash the mark's highlight rects.
      const pageEl = pageElsRef.current.get(mark.page);
      if (!pageEl) return;
      const hlEls = pageEl.querySelectorAll<HTMLElement>(`[data-mark-id="${mark.id}"]`);
      for (const el of hlEls) {
        el.classList.remove('nn-mark-flash');
        void el.offsetWidth; // reflow
        el.classList.add('nn-mark-flash');
        window.setTimeout(() => el.classList.remove('nn-mark-flash'), 1400);
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleAsk = useCallback((info: SelectionInfo) => {
      onAskChat?.(info.text, info.page);
    }, [onAskChat]);

    // M5 — «В карточку» from an existing mark: open the QuickCardDialog with the
    // mark's quote prefilled into the Back and its page for provenance.
    const handleMarkToCard = useCallback((mark: SourceMark) => {
      setQuickCardState({ sourceVersion, page: mark.page, quote: mark.quote, prefillBack: mark.quote });
    }, [sourceVersion]);

    // L4 §8.4 — gather marks + ink markedText (re-read the persisted annotations
    // so we get the geometric markedText, not just the stroke page numbers) and
    // hand them to the parent, which adds title/author/cardCount + downloads.
    const handleExportMarkup = useCallback(async () => {
      if (!onExportMarkup) return;
      let ink: { page: number; markedText: string | null }[] = [];
      try {
        const rows = await fetchAnnotations(sourceId);
        ink = rows.map((r) => ({ page: r.page, markedText: r.markedText }));
      } catch {
        /* best-effort — export marks even if annotations fail to load */
      }
      onExportMarkup({ marks, ink });
    }, [onExportMarkup, sourceId, marks]);

    const ensureTextContent = useCallback(async (n: number): Promise<PdfTextItem[] | null> => {
      const cached = textCacheRef.current.get(n);
      if (cached) return cached;
      const doc = docRef.current;
      if (!doc) return null;
      try {
        const page = await doc.getPage(n);
        const tc = await page.getTextContent();
        const items = tc.items.filter((it: any) => typeof it.str === 'string') as PdfTextItem[];
        if (docRef.current !== doc) return null;
        textCacheRef.current.set(n, items);
        return items;
      } catch {
        return null;
      }
    }, []);

    // W3 — smart-card marquee: on release, extract text under the rect, AI-suggest
    // a card, and open QuickCardDialog with both fields pre-filled.
    const handleMarqueeRelease = useCallback(async (
      page: number,
      x0: number, y0: number, x1: number, y1: number,
    ) => {
      const w = pageDims[page - 1]?.width ?? 612;
      const h = pageDims[page - 1]?.height ?? 792;
      const scaledW = w * scale;
      const scaledH = h * scale;
      if (scaledW <= 0 || scaledH <= 0) return;
      // Normalize marquee to [0,1] rect (x/y min, w/h).
      const nx = Math.min(x0, x1) / scaledW;
      const ny = Math.min(y0, y1) / scaledH;
      const nw = Math.abs(x1 - x0) / scaledW;
      const nh = Math.abs(y1 - y0) / scaledH;
      if (nw < 0.01 || nh < 0.01) return; // too small — ignore tap
      const rect: MarkRect = { x: nx, y: ny, w: nw, h: nh };

      // Extract text items under the marquee from the text cache.
      let extractedText = '';
      const sourceAtStart = activeSource.current;
      const items = await ensureTextContent(page) ?? [];
      if (activeSource.current !== sourceAtStart) return;
      if (items.length > 0) {
        const pdfPageW = w;
        const pdfPageH = h;
        const hits: PdfTextItem[] = [];
        for (const item of items) {
          const bb = textItemBBox(item, pdfPageW, pdfPageH);
          if (!bb) continue;
          // Overlap check in normalized coords.
          const overlapX = bb.minX < rect.x + rect.w && bb.maxX > rect.x;
          const overlapY = bb.minY < rect.y + rect.h && bb.maxY > rect.y;
          if (overlapX && overlapY) hits.push(item);
        }
        // Sort in reading order: top-to-bottom, then left-to-right.
        hits.sort((a, b) => {
          const ba = textItemBBox(a, pdfPageW, pdfPageH)!;
          const bb2 = textItemBBox(b, pdfPageW, pdfPageH)!;
          const dy = ba.minY - bb2.minY;
          if (Math.abs(dy) > 0.005) return dy;
          return ba.minX - bb2.minX;
        });
        extractedText = hits.map((i) => i.str).join(' ').trim();
      }
      const quote = extractedText;
      // Open dialog — AI will suggest on demand via «✨ Сформулировать».
      // If AI suggestion fails or there's no quote, user edits manually.
      setQuickCardState({ sourceVersion, page, quote, rects: [rect] });
      // Kick off AI suggestion proactively (result piped back via prefillFront/Back
      // when the dialog opens — but the dialog has its own «Сформулировать» button
      // so we just open blank and let user trigger it).
      // (No auto-suggest here — keeps it simple and avoids double calls.)
    }, [pageDims, scale, sourceVersion, ensureTextContent]);

    // W4 — open the cards browser focused on a card marker's linked card.
    const handleOpenCard = useCallback((cardId: string) => {
      router.push(`/cards?focus=${cardId}`);
    }, [router]);

    // ── Tool settings hydrate / persist ──────────────────────────────────────────
    useEffect(() => {
      setTools(loadToolSettings());
    }, []);
    const updateTools = useCallback((patch: Partial<ToolSettings>) => {
      setTools((prev) => {
        const next = { ...prev, ...patch };
        saveToolSettings(next);
        return next;
      });
    }, []);

    // ── Load the document (dynamic pdf.js import, client-only) ────────────────────
    useEffect(() => {
      let cancelled = false;
      let loadingTask: PdfLoadingTask | null = null;
      const ac = new AbortController();
      setLoadState('loading');setDimensionsThrough(0);initialPositionDone.current=false;
      setLoadProgress({ loaded: 0, total: null });
      textCacheRef.current = new Map();
      renderedRef.current = new Map();
      (async () => {
        try {
          // pdf.js is loaded as NATIVE browser ESM from /public/vendor/pdfjs
          // (copied from node_modules by scripts/copy-pdfjs.mjs on dev/build),
          // deliberately BYPASSING webpack: Next 16's bundled webpack
          // mis-compiles pdfjs-dist's module init ("Object.defineProperty
          // called on non-object" — webpack#20095, fixed only in webpack
          // 5.103, which Next does not ship; pdf.js#20478; reproduced on
          // EVERY pdfjs 5.4.x here). `webpackIgnore` keeps the dynamic import
          // native; same-origin module script + worker satisfy the CSP
          // (`script-src 'self'` / `worker-src 'self'`). Identical in dev+prod.
          const PDFJS_VENDOR_URL = '/vendor/pdfjs/pdf.min.mjs';
          const pdfjs = (await import(
            /* webpackIgnore: true */ PDFJS_VENDOR_URL
          )) as typeof import('pdfjs-dist');
          if (cancelled) return;
          // The worker MUST come from the same vendored copy (version handshake).
          pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
          pdfjsRef.current = pdfjs;

          const data = await fetchSourceFile(sourceId, {
            signal: ac.signal,
            onProgress: (loaded, total) => {
              if (!cancelled) setLoadProgress({ loaded, total });
            },
          });
          if (cancelled) return;

          loadingTask = pdfjs.getDocument({ data });
          const doc: PdfDocument = await loadingTask.promise;
          if (cancelled) return;
          docRef.current = doc;
          setNumPages(doc.numPages);

          // First page sizes the fit-width scale + seeds placeholder dims.
          const first = await doc.getPage(1);
          const vp1 = first.getViewport({ scale: 1 });
          const dims: PdfPageViewport[] = new Array(doc.numPages).fill({ width: vp1.width, height: vp1.height });
          dims[0] = { width: vp1.width, height: vp1.height };
          setPageDims(dims);setDimensionsThrough(1);

          const containerW = readerRootRef.current?.clientWidth ?? containerRef.current?.clientWidth ?? 800;
          const fit = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, (containerW - 48) / vp1.width));
          setFitScale(fit);
          let preferredScale=fit;
          try{const saved=JSON.parse(readBrowserValue(localStorage,POS_KEY(sourceId))??'null');if(typeof saved?.scale==='number'&&saved.scale>=ZOOM_MIN&&saved.scale<=ZOOM_MAX)preferredScale=saved.scale;}catch{}
          setScale(preferredScale);

          // L3 — surface doc metadata + a lazy page-1 cover renderer ONCE so the
          // library reader can backfill pageCount/author/cover (NULL fields only).
          if (onDocInfo) {
            void (async () => {
              let author: string | undefined;
              try {
                const meta = await doc.getMetadata();
                const info = (meta?.info ?? {}) as { Author?: unknown };
                if (typeof info.Author === 'string' && info.Author.trim()) {
                  author = info.Author.trim().slice(0, 300);
                }
              } catch {
                /* no metadata */
              }
              const renderCover = async (): Promise<Blob | null> => {
                try {
                  const targetW = 480;
                  const scaleForCover = targetW / vp1.width;
                  const cvp = first.getViewport({ scale: scaleForCover });
                  const canvas = document.createElement('canvas');
                  canvas.width = Math.round(cvp.width);
                  canvas.height = Math.round(cvp.height);
                  const ctx = canvas.getContext('2d');
                  if (!ctx) return null;
                  await first.render({ canvas, canvasContext: ctx, viewport: cvp }).promise;
                  return await new Promise<Blob | null>((resolve) =>
                    canvas.toBlob((b) => resolve(b), 'image/webp', 0.8),
                  );
                } catch {
                  return null;
                }
              };
              if (!cancelled) onDocInfo({ numPages: doc.numPages, author, renderCover });
            })();
          }

          // Lazily measure remaining page dims (some PDFs vary) without blocking.
          void (async () => {
            for (let n = 2; n <= doc.numPages; n++) {
              if (cancelled) return;
              try {
                const pg = await doc.getPage(n);
                const vp = pg.getViewport({ scale: 1 });
                setPageDims((prev) => {
                  const next = prev.slice();
                  next[n - 1] = { width: vp.width, height: vp.height };
                  return next;
                });
              } catch {
                /* keep the seeded dims */
              } finally {if(!cancelled)setDimensionsThrough(n);}
            }
          })();

          // Load saved annotations.
          try {
            const rows = await fetchAnnotations(sourceId);
            if (!cancelled) {
              const m = new Map<number, PageState>();
              for (const r of rows) {
                m.set(r.page, { strokes: r.strokes?.strokes ?? [], undo: [], redo: [] });
              }
              setPages(m);
            }
          } catch {
            /* annotations are best-effort; reader still works */
          }

          if (!cancelled) setLoadState('ready');
        } catch (err) {
          if (!cancelled && (err as Error)?.name !== 'AbortError') {
            // The UI error state is deliberately generic — the console carries
            // the real cause (worker setup, fetch status, parse failure).
            console.error('[pdf-reader] load failed', err);
            setLoadState('error');
          }
        }
      })();
      return () => {
        cancelled = true;
        ac.abort();
        for (const timer of saveTimersRef.current.values()) clearTimeout(timer);
        saveTimersRef.current.clear();
        for (const rendered of renderedRef.current.values()) {
          try {
            rendered.task?.cancel?.();
          } catch {
            // A render can already be settling while its route unmounts.
          }
        }
        renderedRef.current.clear();
        for (const layer of textLayerInstances.current.values()) {
          try {
            layer?.cancel?.();
          } catch {
            // Text-layer cancellation is best-effort across pdf.js builds.
          }
        }
        textLayerInstances.current.clear();
        for (const element of textLayerEls.current.values()) element.remove();
        textLayerEls.current.clear();
        const document = docRef.current;
        docRef.current = null;
        void destroyPdfResources(loadingTask, document);
      };
    }, [sourceId]);

    // ── Persist + restore reading position (page + scale) ─────────────────────────
    const posSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
      if (loadState !== 'ready') return;
      if (posSaveTimer.current) clearTimeout(posSaveTimer.current);
      posSaveTimer.current = setTimeout(() => {
        try {
          writeBrowserValue(localStorage, POS_KEY(sourceId), JSON.stringify({ page: currentPage, scale }));
        } catch {
          /* best-effort */
        }
      }, 500);
      return () => {
        if (posSaveTimer.current) clearTimeout(posSaveTimer.current);
      };
    }, [currentPage, scale, loadState, sourceId]);

    // Once ready: jump to the deep-link page if any, else the stored position.
    useLayoutEffect(() => {
      if (loadState !== 'ready' || numPages === 0 || hasNavigationAnchor || !dimensionsReady || !containerRef.current || initialPositionDone.current) return;
      initialPositionDone.current=true;
      if(position.isCancelled())return;
      const wanted = pendingInitialPageRef.current;
      if (wanted && wanted >= 1 && wanted <= numPages) {
        pendingInitialPageRef.current = undefined;
        // Defer to next frame so placeholders are laid out.
        scrollToPage(wanted, true);
        return;
      }
      try {
        const raw = readBrowserValue(localStorage, POS_KEY(sourceId));
        if (raw) {
          const { page, scale: storedScale } = JSON.parse(raw) as { page?: number; scale?: number };
          if (typeof storedScale === 'number' && storedScale >= ZOOM_MIN && storedScale <= ZOOM_MAX) {
            setScale(storedScale);
          }
          if (typeof page === 'number' && page > 1 && page <= numPages) {
            scrollToPage(page, false);
          }
        }
      } catch {
        /* ignore */
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loadState, numPages, sourceId,dimensionsReady]);

    // ── Virtualization: observe page wrappers (±2) + track current page ───────────
    useEffect(() => {
      if (loadState !== 'ready' || numPages === 0 || !dimensionsReady) return;
      const root = containerRef.current;
      if (!root) return;
      const pages = new PdfPageVisibility(numPages);
      const nearby = new IntersectionObserver(entries => {
        setVisible(pages.updateNearby(entries.map(entry => ({
          page: Number((entry.target as HTMLElement).dataset.page), visible: entry.isIntersecting,
        }))));
      }, { root, rootMargin: '600px 0px', threshold: 0 });
      const viewport = new IntersectionObserver(entries => {
        const page = pages.updateViewport(entries.map(entry => ({
          page: Number((entry.target as HTMLElement).dataset.page),
          area: entry.isIntersecting ? entry.intersectionRect.width * entry.intersectionRect.height : 0,
        })));
        if (page !== undefined) setCurrentPage(page);
      }, { root, threshold: Array.from({ length: 11 }, (_, index) => index / 10) });
      for (const element of pageElsRef.current.values()) { nearby.observe(element); viewport.observe(element); }
      return () => { nearby.disconnect(); viewport.disconnect(); };
    }, [loadState, numPages, dimensionsReady]);

    // ── Render a page canvas when it becomes visible / scale changes ──────────────
    const renderPage = useCallback(
      async (n: number, host: HTMLDivElement) => {
        const doc = docRef.current;
        if (!doc) return;
        const existing = renderedRef.current.get(n);
        if (existing && existing.scale === scale && existing.canvas.isConnected) return;
        try {
          existing?.task?.cancel?.();
        } catch {
          /* ignore */
        }
        try {
          const page = await doc.getPage(n);
          const vp = page.getViewport({ scale });
          const dpr = Math.min(window.devicePixelRatio || 1, 3);
          const canvas = host.querySelector<HTMLCanvasElement>('canvas[data-pdf-canvas]') ?? document.createElement('canvas');
          canvas.dataset.pdfCanvas = '1';
          canvas.width = Math.floor(vp.width * dpr);
          canvas.height = Math.floor(vp.height * dpr);
          canvas.style.width = `${vp.width}px`;
          canvas.style.height = `${vp.height}px`;
          canvas.style.display = 'block';
          if (!canvas.isConnected) {
            const slot = host.querySelector('[data-canvas-slot]');
            slot?.prepend(canvas);
          }
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          const task = page.render({ canvas, canvasContext: ctx, viewport: vp });
          renderedRef.current.set(n, { canvas, scale, task });
          await task.promise;
        } catch (err) {
          if ((err as Error)?.name !== 'RenderingCancelledException') {
            /* leave the placeholder */
          }
        }
      },
      [scale],
    );

    // Trigger renders for visible pages.
    useEffect(() => {
      if (loadState !== 'ready') return;
      for (const n of visible) {
        const host = pageElsRef.current.get(n);
        if (host) void renderPage(n, host);
      }
      // Free canvases for pages no longer in range.
      for (const [n, r] of renderedRef.current) {
        if (!visible.has(n)) {
          try {
            r.task?.cancel?.();
          } catch {
            /* ignore */
          }
          r.canvas.remove();
          renderedRef.current.delete(n);
        }
      }
    }, [visible, scale, loadState, dimensionsReady, renderPage]);

    // ── M5 — Text layer: render per visible page (lazy, cached, freed with virt) ───
    const renderTextLayer = useCallback(
      async (n: number, host: HTMLDivElement) => {
        const pdfjs = pdfjsRef.current;
        const doc = docRef.current;
        if (!pdfjs || !doc) return;
        // One text layer per page; recreate on scale change.
        const existing = textLayerEls.current.get(n);
        if (existing?.dataset.scale === String(scale) && existing.isConnected) return;
        // Remove stale layer.
        existing?.remove();
        textLayerInstances.current.get(n)?.cancel?.();
        try {
          const page = await doc.getPage(n);
          const vp = page.getViewport({ scale });
          const container = document.createElement('div');
          container.className = 'nn-textlayer';
          container.dataset.scale = String(scale);
          // W1: pdf.js v5 TextLayer expects --total-scale-factor on the container.
          // All per-span font-sizes are `calc(Npx * var(--total-scale-factor))`.
          // setLayerDimensions (called inside TextLayer constructor) also rewrites
          // width/height via calc(), so our explicit px sizes are overwritten —
          // but we keep them as a safe fallback for browsers that don't support
          // CSS round().
          container.style.setProperty('--total-scale-factor', String(scale));
          container.style.width = `${vp.width}px`;
          container.style.height = `${vp.height}px`;
          // pdf.js-standard model: the CONTAINER never receives pointer events
          // (so the full-page text layer can't swallow clicks meant for note
          // pins / highlights below it). In hand mode the glyph SPANS opt back
          // in via the `.nn-textlayer[data-hand="1"] span` CSS rule, which keeps
          // text selectable while clicks in the gaps fall through.
          const isHand = tools.tool === 'hand';
          if (isHand) container.dataset.hand = '1';
          else delete container.dataset.hand;
          container.style.userSelect = isHand ? 'text' : 'none';
          // Insert BEFORE the ink canvas (z2 < z3).
          const inkEl = host.querySelector('[data-ink-layer]');
          if (inkEl) host.insertBefore(container, inkEl);
          else host.appendChild(container);
          textLayerEls.current.set(n, container);
          // pdf.js v5 TextLayer API.
          const layer = new pdfjs.TextLayer({
            textContentSource: page.streamTextContent(),
            container,
            viewport: vp,
          });
          textLayerInstances.current.set(n, layer);
          await layer.render();
          // Official pdf.js selection mechanic: an `endOfContent` sentinel that
          // the `.selecting` class (toggled on pointerdown in hand mode)
          // stretches over the whole page — so a drag that wanders slightly
          // PAST a line's last glyph still extends the selection instead of
          // requiring pixel-perfect pointer placement on the glyph edge.
          if (!container.querySelector('.endOfContent')) {
            const end = document.createElement('div');
            end.className = 'endOfContent';
            container.appendChild(end);
          }
        } catch {
          /* if TextLayer unavailable, silently skip — still usable without selection */
        }
      },
      [scale, tools.tool],
    );

    // Toggle hand-mode on existing text layers when the tool changes. The
    // container stays pointer-events:none ALWAYS; `data-hand` re-enables span
    // pointer events (CSS) so note pins / highlights below stay clickable.
    useEffect(() => {
      const isHand = tools.tool === 'hand';
      for (const el of textLayerEls.current.values()) {
        if (isHand) el.dataset.hand = '1';
        else delete el.dataset.hand;
        el.style.userSelect = isHand ? 'text' : 'none';
      }
    }, [tools.tool]);

    // Trigger text layer renders for visible pages.
    useEffect(() => {
      if (loadState !== 'ready') return;
      for (const n of visible) {
        const host = pageElsRef.current.get(n);
        if (host) void renderTextLayer(n, host);
      }
      // Free text layers for pages no longer in range.
      for (const n of textLayerEls.current.keys()) {
        if (!visible.has(n)) {
          textLayerInstances.current.get(n)?.cancel?.();
          textLayerEls.current.get(n)?.remove();
          textLayerEls.current.delete(n);
          textLayerInstances.current.delete(n);
        }
      }
    }, [visible, scale, loadState, dimensionsReady, renderTextLayer]);

    // ── scrollToPage (exposed) ────────────────────────────────────────────────────
    const scrollToPage = useCallback((page: number, flash = false) => {
      const el = pageElsRef.current.get(page);
      const root = containerRef.current;
      if (!el || !root) return;
      position.beginExplicitJump();
      el.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth', block: 'start' });
      setCurrentPage(page);
      if (flash) {
        el.classList.add('nn-pdf-page-flash');
        window.setTimeout(() => el.classList.remove('nn-pdf-page-flash'), 1600);
      }
    }, [position.beginExplicitJump]);

    // L2 — resolve the PDF outline (table of contents) into flat entries. Each
    // entry's `dest` is resolved through getDestination/getPageIndex to a 1-based
    // page. Returns [] when the document has no outline.
    const getOutline = useCallback(async (): Promise<PdfOutlineEntry[]> => {
      const doc = docRef.current;
      if (!doc) return [];
      let raw: any[] | null = null;
      try {
        raw = await doc.getOutline();
      } catch {
        return [];
      }
      if (!raw || raw.length === 0) return [];
      const out: PdfOutlineEntry[] = [];
      const resolvePage = async (dest: any): Promise<number | null> => {
        try {
          let explicit = dest;
          if (typeof dest === 'string') explicit = await doc.getDestination(dest);
          if (!Array.isArray(explicit) || explicit.length === 0) return null;
          const ref = explicit[0];
          const idx = await doc.getPageIndex(ref);
          return typeof idx === 'number' ? idx + 1 : null;
        } catch {
          return null;
        }
      };
      const walk = async (items: any[], depth: number): Promise<void> => {
        for (const it of items) {
          const title = typeof it?.title === 'string' ? it.title : '';
          const page = it?.dest != null ? await resolvePage(it.dest) : null;
          if (title) out.push({ title, page, depth });
          if (Array.isArray(it?.items) && it.items.length > 0) {
            await walk(it.items, depth + 1);
          }
        }
      };
      await walk(raw, 0);
      return out;
    }, []);

    useImperativeHandle(ref, () => ({ scrollToPage, getOutline }), [scrollToPage, getOutline]);

    // L2 — notify the parent of page changes (library reader → server progress).
    useEffect(() => {
      if (loadState !== 'ready' || numPages === 0) return;
      onPageChange?.(currentPage, numPages);
    }, [currentPage, numPages, loadState, onPageChange]);

    // M5 — jump to initial mark after marks are loaded.
    useEffect(() => {
      const markId = pendingInitialMarkRef.current;
      if (!markId || marks.length === 0) return;
      const mark = marks.find((m) => m.id === markId);
      if (!mark) return;
      pendingInitialMarkRef.current = undefined;
      requestAnimationFrame(() => {
        scrollToPage(mark.page, false);
        setTimeout(() => handleMarkClick(mark), 300);
      });
    }, [marks, scrollToPage, handleMarkClick]);

    // ── Zoom ──────────────────────────────────────────────────────────────────────
    const applyZoom = useCallback((delta: number) => {
      setScale((s) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round((s + delta) * 100) / 100)));
    }, []);
    const resetZoom = useCallback(() => setScale(fitScale), [fitScale]);

    // ── Two-finger pinch zoom (live CSS transform → commit on settle) ─────────────
    const pinchRef = useRef<{ pointers: Map<number, { x: number; y: number }>; startDist: number; startScale: number } | null>(null);
    const onContainerPointerDown = useCallback((e: React.PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      const p = pinchRef.current ?? { pointers: new Map(), startDist: 0, startScale: scale };
      p.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (p.pointers.size === 2) {
        const [a, b] = [...p.pointers.values()];
        p.startDist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        p.startScale = scale;
      }
      pinchRef.current = p;
    }, [scale]);
    const onContainerPointerMove = useCallback((e: React.PointerEvent) => {
      const p = pinchRef.current;
      if (!p || !p.pointers.has(e.pointerId) || p.pointers.size < 2) return;
      p.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [a, b] = [...p.pointers.values()];
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      if (p.startDist > 0) {
        const factor = dist / p.startDist;
        const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, p.startScale * factor));
        const wrap = containerRef.current?.querySelector<HTMLElement>('[data-pages-wrap]');
        if (wrap) {
          wrap.style.transformOrigin = 'top center';
          wrap.style.transform = `scale(${next / scale})`;
        }
      }
    }, [scale]);
    const endPinch = useCallback((e: React.PointerEvent) => {
      const p = pinchRef.current;
      if (!p) return;
      const had2 = p.pointers.size === 2;
      p.pointers.delete(e.pointerId);
      if (had2 && p.pointers.size < 2) {
        const wrap = containerRef.current?.querySelector<HTMLElement>('[data-pages-wrap]');
        const m = wrap?.style.transform.match(/scale\(([\d.]+)\)/);
        if (wrap) wrap.style.transform = '';
        if (m) {
          const f = Number(m[1]);
          if (Number.isFinite(f) && f !== 1) {
            setScale((s) => Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(s * f * 100) / 100)));
          }
        }
      }
      if (p.pointers.size === 0) pinchRef.current = null;
    }, []);

    // ── Annotation mutation + debounced save ──────────────────────────────────────
    const getPageState = useCallback(
      (n: number): PageState => pages.get(n) ?? { strokes: [], undo: [], redo: [] },
      [pages],
    );

    const scheduleSave = useCallback(
      (n: number, strokes: InkStroke[]) => {
        const timers = saveTimersRef.current;
        const existing = timers.get(n);
        if (existing) clearTimeout(existing);
        setSaveState('saving');
        timers.set(
          n,
          setTimeout(async () => {
            timers.delete(n);
            try {
              let markedText: string | undefined;
              if (strokes.length > 0) {
                const items = await ensureTextContent(n);
                const dims = pageDims[n - 1];
                if (items && dims) {
                  const vp = { w: dims.width, h: dims.height };
                  markedText = extractMarkedText(items, vp.w, vp.h, strokes).slice(0, MARKED_TEXT_MAX);
                }
              }
              const payload: PageAnnotations = { v: 1, strokes };
              await saveAnnotation(sourceId, n, payload, strokes.length ? markedText : undefined);
              setSaveState('saved');
              window.setTimeout(() => setSaveState((s) => (s === 'saved' ? 'idle' : s)), 1600);
            } catch {
              setSaveState('error');
            }
          }, SAVE_DEBOUNCE_MS),
        );
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [sourceId, pageDims],
    );

    const commitStrokes = useCallback(
      (n: number, next: InkStroke[]) => {
        if (next.length > ANNOTATION_MAX_STROKES) next = next.slice(0, ANNOTATION_MAX_STROKES);
        setPages((prev) => {
          const cur = prev.get(n) ?? { strokes: [], undo: [], redo: [] };
          const m = new Map(prev);
          m.set(n, { strokes: next, undo: [...cur.undo, cur.strokes], redo: [] });
          return m;
        });
        scheduleSave(n, next);
      },
      [scheduleSave],
    );

    const undoPage = useCallback(
      (n: number) => {
        setPages((prev) => {
          const cur = prev.get(n);
          if (!cur || cur.undo.length === 0) return prev;
          const last = cur.undo[cur.undo.length - 1]!;
          const m = new Map(prev);
          m.set(n, { strokes: last, undo: cur.undo.slice(0, -1), redo: [...cur.redo, cur.strokes] });
          scheduleSave(n, last);
          return m;
        });
      },
      [scheduleSave],
    );

    const redoPage = useCallback(
      (n: number) => {
        setPages((prev) => {
          const cur = prev.get(n);
          if (!cur || cur.redo.length === 0) return prev;
          const next = cur.redo[cur.redo.length - 1]!;
          const m = new Map(prev);
          m.set(n, { strokes: next, undo: [...cur.undo, cur.strokes], redo: cur.redo.slice(0, -1) });
          scheduleSave(n, next);
          return m;
        });
      },
      [scheduleSave],
    );

    const retrySave = useCallback(() => {
      const st = getPageState(currentPage);
      scheduleSave(currentPage, st.strokes);
    }, [getPageState, currentPage, scheduleSave]);

    // ── ⌘Z / ⌘⇧Z when the reader is focused ──────────────────────────────────────
    const focusRef = useRef(false);
    useEffect(() => {
      const onKey = (e: KeyboardEvent) => {
        if (!focusRef.current) return;
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
          e.preventDefault();
          if (e.shiftKey) redoPage(currentPage);
          else undoPage(currentPage);
        }
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, [currentPage, undoPage, redoPage]);

    const curState = getPageState(currentPage);

    // M5 — ink pages (pages that have strokes) for the Разметка panel.
    const inkPages = useMemo(
      () => [...pages.entries()].filter(([, s]) => s.strokes.length > 0).map(([n]) => n),
      [pages],
    );

    // M5 — mark color CSS map.
    // SOLID per-color fills — the alpha lives on the per-mark compositing GROUP
    // (opacity 0.38 + multiply), so rects overlapping inside one mark paint the
    // same flat color instead of double-tinting into dark slivers.
    const MARK_SOLID = MARK_COLOR_CSS;

    // ── Render ─────────────────────────────────────────────────────────────────────
    if (loadState === 'error') {
      return (
        <div className="nn-empty-state" style={{ flex: 1 }}>
        <NavigationRestoreNotice failure={position.failure} retry={position.retry}/>
          <p className="nn-empty-state-hint">
            {t('notebooks.reader.loadError')}
          </p>
          <button type="button" onClick={() => onMode('text')} style={modeFallbackBtn}>
            {t('notebooks.reader.openText')}
          </button>
        </div>
      );
    }

    return (
      <div ref={readerRootRef} style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <NavigationRestoreNotice failure={position.failure} retry={position.retry}/>
        <ReaderToolbar
            tool={tools.tool}
            color={tools.color}
            widthIdx={tools.widthIdx}
            fingerDraw={tools.fingerDraw}
            scale={scale}
            page={currentPage}
            total={numPages}
            saveState={saveState}
            canUndo={curState.undo.length > 0}
            canRedo={curState.redo.length > 0}
            marksCount={marks.length + inkPages.length}
            marksPanelOpen={marksPanelOpen}
            onToggleMarksPanel={() => setMarksPanelOpen((v) => !v)}
            tocOpen={tocOpen}
            tocAvailable={tocAvailable}
            onToggleToc={onToggleToc}
            onTool={(tool) => updateTools({ tool })}
            onColor={(color) => updateTools({ color })}
            onWidth={(widthIdx) => updateTools({ widthIdx })}
            onFingerDraw={(fingerDraw) => updateTools({ fingerDraw })}
            onZoom={applyZoom}
            onZoomReset={resetZoom}
            onUndo={() => undoPage(currentPage)}
            onRedo={() => redoPage(currentPage)}
            onJumpPage={(p) => scrollToPage(Math.max(1, Math.min(numPages, p)), true)}
            onRetrySave={retrySave}
            t={t}
          />

        {loadState === 'loading' || !dimensionsReady ? (
          <div className="nn-empty-state nn-reader-bg" style={{ flex: 1 }}>
            <div style={{ width: 180, height: 4, borderRadius: 99, background: 'var(--surface-3)', overflow: 'hidden' }}>
              <div
                style={{
                  height: '100%',
                  background: 'var(--lime-500)',
                  borderRadius: 99,
                  width:
                    loadProgress.total && loadProgress.total > 0
                      ? `${Math.min(100, Math.round((loadProgress.loaded / loadProgress.total) * 100))}%`
                      : '35%',
                  transition: 'width 150ms linear',
                }}
              />
            </div>
            <p className="nn-empty-state-hint" style={{ marginTop: 8 }}>
              {loadProgress.total && loadProgress.total > 0
                ? `${Math.round(loadProgress.loaded / 1024)} / ${Math.round(loadProgress.total / 1024)} KB`
                : t('notebooks.reader.loading')}
            </p>
          </div>
        ) : (
          // Reader body: relative container so the Разметка panel can be absolute.
          <div style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden' }}>
            <div
              ref={setContainerRef}
              className="nn-scroll nn-reader-bg"
              tabIndex={0}
              onFocus={() => (focusRef.current = true)}
              onBlur={() => (focusRef.current = false)}
              onPointerDownCapture={onContainerPointerDown}
              onPointerMoveCapture={onContainerPointerMove}
              onPointerUp={endPinch}
              onPointerCancel={endPinch}
              style={{ position: 'absolute', inset: 0, overflow: 'auto', padding: '20px 0 32px', outline: 'none', touchAction: 'pan-x pan-y pinch-zoom' }}
            >
              <div data-pages-wrap style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20 }}>
                {Array.from({ length: numPages }, (_, i) => i + 1).map((n) => {
                  const dims = pageDims[n - 1] ?? { width: 612, height: 792 };
                  const w = dims.width * scale;
                  const h = dims.height * scale;
                  const isVisible = visible.has(n);
                  const pst = pages.get(n);
                  // M5 — marks for this page.
                  const pageMarks = marks.filter((m) => m.page === n);
                  // W3 — smart-card marquee pointer handlers (per-page).
                  const isSmartCard = tools.tool === 'smart-card';
                  const onPagePointerDown = isSmartCard ? (e: React.PointerEvent<HTMLDivElement>) => {
                    if (!e.isPrimary || e.button !== 0 || (e.pointerType === 'touch' && !tools.fingerDraw)) return;
                    e.preventDefault();
                    const rect = e.currentTarget.getBoundingClientRect();
                    const x = e.clientX - rect.left;
                    const y = e.clientY - rect.top;
                    e.currentTarget.setPointerCapture(e.pointerId);
                    marqueeRef.current = { page: n, pointerId: e.pointerId, x0: x, y0: y, x1: x, y1: y };
                    setMarquee(marqueeRef.current);
                  } : tools.tool === 'hand' ? (e: React.PointerEvent<HTMLDivElement>) => {
                    // Hand mode: while a drag is live, stretch the page's
                    // endOfContent sentinel over the page (`.selecting`) so the
                    // selection keeps extending when the pointer drifts past a
                    // line's last glyph (official pdf.js viewer behavior).
                    if (!e.isPrimary) return;
                    const layer = textLayerEls.current.get(n);
                    if (!layer) return;
                    layer.classList.add('selecting');
                    const clear = () => {
                      for (const el of textLayerEls.current.values()) el.classList.remove('selecting');
                      window.removeEventListener('pointerup', clear);
                      window.removeEventListener('pointercancel', clear);
                    };
                    window.addEventListener('pointerup', clear);
                    window.addEventListener('pointercancel', clear);
                  } : undefined;
                  const onPagePointerMove = isSmartCard ? (e: React.PointerEvent<HTMLDivElement>) => {
                    if (!marqueeRef.current || marqueeRef.current.page !== n || marqueeRef.current.pointerId !== e.pointerId) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    setMarquee((prev) => prev ? { ...prev, x1: e.clientX - rect.left, y1: e.clientY - rect.top } : null);
                  } : undefined;
                  const onPagePointerUp = isSmartCard ? (e: React.PointerEvent<HTMLDivElement>) => {
                    const m = marqueeRef.current;
                    if (!m || m.page !== n || m.pointerId !== e.pointerId) return;
                    marqueeRef.current = null;
                    setMarquee(null);
                    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
                    const rect = e.currentTarget.getBoundingClientRect();
                    const x1 = e.clientX - rect.left;
                    const y1 = e.clientY - rect.top;
                    void handleMarqueeRelease(n, m.x0, m.y0, x1, y1);
                  } : undefined;

                  return (
                    <div
                      key={n}
                      data-page={n}
                      ref={(el) => {
                        if (el) { el.dataset.navigationAnchor=String(n); pageElsRef.current.set(n, el); }
                        else pageElsRef.current.delete(n);
                      }}
                      className="nn-pdf-page"
                      style={{
                        position: 'relative',
                        width: w,
                        height: h,
                        cursor: isSmartCard ? 'crosshair' : undefined,
                        touchAction: isSmartCard && tools.fingerDraw ? 'none' : undefined,
                      }}
                      onPointerDown={onPagePointerDown}
                      onPointerMove={onPagePointerMove}
                      onPointerUp={onPagePointerUp}
                      onPointerCancel={() => { marqueeRef.current = null; setMarquee(null); }}
                      onLostPointerCapture={() => { marqueeRef.current = null; setMarquee(null); }}
                    >
                      {/* z0: canvas slot */}
                      <div data-canvas-slot style={{ position: 'absolute', inset: 0 }} />
                      {/* z1: highlight rects layer (below text layer) */}
                      {isVisible && pageMarks.length > 0 && (
                        <div style={{ position: 'absolute', inset: 0, zIndex: 1, pointerEvents: 'none' }}>
                          <div style={{ position: 'absolute', inset: 0, opacity: 0.38, mixBlendMode: 'multiply' }}>
                          {pageMarks.map((m) => (
                            // All marks share one compositing group, so intersections
                            // within and between highlights never darken twice.
                            <div
                              key={m.id}
                              data-mark-id={m.id}
                              style={{
                                position: 'absolute',
                                inset: 0,

                                pointerEvents: 'none',
                              }}
                            >
                              {m.rects.map((r, ri) => (
                                <div
                                  key={ri}
                                  style={{
                                    position: 'absolute',
                                    left: r.x * w,
                                    top: r.y * h,
                                    width: r.w * w,
                                    height: r.h * h,
                                    background: MARK_SOLID[m.color] ?? MARK_SOLID.lime,
                                    borderRadius: 2,
                                  }}
                                />
                              ))}
                            </div>
                          ))}
                          </div>
                          {/* Accessible margin note previews stay opaque above the highlight paint. */}
                          {pageMarks.filter((m) => m.kind === 'note').map((m) => {
                            const r = m.rects[0];
                            if (!r) return null;
                            return (
                              <button type="button" key={`pin-${m.id}`} className="reomi-pdf-note-pin"
                                aria-label={`${t('notebooks.marks.note')}: ${m.note ?? m.quote}`}
                                style={{ left: Math.max(2, r.x * w - 28), top: r.y * h }}
                                onClick={() => { handleMarkClick(m); setMarksPanelOpen(true); }}>
                                <NNIcon name="edit" size={14}/><span>{m.note ?? m.quote}</span>
                              </button>
                            );
                          })}
                          {/* W4 — card marker chip (lime card icon) at first rect's line for 'card' marks */}
                          {pageMarks.filter((m) => m.kind === 'card').map((m) => {
                            const r = m.rects[0];
                            if (!r) return null;
                            return (
                              <span
                                key={`card-chip-${m.id}`}
                                title={m.quote || t('notebooks.marks.openCard')}
                                style={{
                                  position: 'absolute',
                                  left: r.x * w - 20,
                                  top: r.y * h,
                                  width: 18,
                                  height: 18,
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  borderRadius: 3,
                                  background: 'color-mix(in srgb, var(--lime-500) 25%, var(--surface))',
                                  border: '1px solid var(--lime-500)',
                                  color: 'var(--lime-400)',
                                  pointerEvents: 'auto',
                                  cursor: 'pointer',
                                  userSelect: 'none',
                                  lineHeight: 1,
                                  zIndex: 2,
                                }}
                                onClick={() => m.cardId && handleOpenCard(m.cardId)}
                              >
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                  <rect x="2" y="5" width="20" height="14" rx="2" />
                                  <line x1="2" y1="10" x2="22" y2="10" />
                                </svg>
                              </span>
                            );
                          })}
                        </div>
                      )}
                      {/* W3 — smart-card marquee overlay (live lime dashed rect while dragging). */}
                      {isSmartCard && marquee && marquee.page === n && (
                        <div
                          style={{
                            position: 'absolute',
                            left: Math.min(marquee.x0, marquee.x1),
                            top: Math.min(marquee.y0, marquee.y1),
                            width: Math.abs(marquee.x1 - marquee.x0),
                            height: Math.abs(marquee.y1 - marquee.y0),
                            border: '2px dashed var(--lime-500)',
                            background: 'color-mix(in srgb, var(--lime-500) 12%, transparent)',
                            borderRadius: 3,
                            pointerEvents: 'none',
                            zIndex: 10,
                          }}
                        />
                      )}
                      {/* z2: text layer (rendered by renderTextLayer effect) */}
                      {/* z3: ink canvas — data-ink-layer is on the <canvas> element inside InkLayer */}
                      {isVisible && (
                        <InkLayer
                          strokes={pst?.strokes ?? []}
                          cssW={w}
                          cssH={h}
                          tool={tools.tool}
                          color={tools.color}
                          widthIdx={tools.widthIdx}
                          fingerDraw={tools.fingerDraw}
                          onChange={(next) => commitStrokes(n, next)}
                        />
                      )}
                      {!isVisible && (
                        <>
                          {/* Shimmer placeholder: full-page skeleton while page is off-screen.
                              The shimmer animation lives in .nn-pdf-page-shimmer so the
                              prefers-reduced-motion guard in globals.css can disable it. */}
                          <div
                            className="nn-pdf-page-shimmer"
                            style={{ position: 'absolute', inset: 0, borderRadius: 'inherit' }}
                          />
                          <span
                            style={{
                              position: 'absolute',
                              bottom: 8,
                              right: 10,
                              fontSize: 10,
                              color: 'color-mix(in srgb, var(--text-muted) 50%, transparent)',
                              fontFamily: 'var(--font-mono)',
                              userSelect: 'none',
                            }}
                          >
                            {n}
                          </span>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* M5 — «Разметка» sliding panel (absolute over the reader body). */}
            <MarksPanel
              open={marksPanelOpen}
              onClose={() => setMarksPanelOpen(false)}
              marks={marks}
              inkPages={inkPages}
              onMarkClick={handleMarkClick}
              onMarkDelete={(id) => void handleMarkDelete(id)}
              onMarkColorChange={(id, c) => void handleMarkColorChange(id, c)}
              onMarkNoteChange={(id, note) => void handleMarkNoteChange(id, note)}
              onMarkToCard={handleMarkToCard}
              onOpenCard={handleOpenCard}
              onExport={onExportMarkup ? () => void handleExportMarkup() : undefined}
              onHarvest={chatEnabled ? () => setHarvestOpen(true) : undefined}
              t={t}
            />

            {/* M5 — Selection popover (hand mode only). */}
            <SelectionPopover key={sourceId}
              pageEls={pageElsRef.current}
              handMode={tools.tool === 'hand'}
              onHighlight={handleHighlight}
              onNote={handleNote}
              onCard={(info) => setQuickCardState({ sourceVersion, page: info.page, quote: info.text, rects: info.rects })}
              onAsk={handleAsk}
              t={t}
            />
          </div>
        )}

        {/* M5 — QuickCardDialog (portal outside the scroll area). */}
        {quickCardState && (
          <QuickCardDialog
            open={true}
            onClose={() => setQuickCardState(null)}
            sourceId={sourceId}
            sourceName={sourceName}
            sourceVersion={quickCardState.sourceVersion}
            page={quickCardState.page}
            quote={quickCardState.quote}
            prefillBack={quickCardState.prefillBack}
            rects={quickCardState.rects}
            locale={locale}
            chatEnabled={chatEnabled}
            onCreated={(result, cardId) => {
              // W4: if the server planted a card marker, refresh marks so it appears.
              if (result.markId) {
                fetchMarks(sourceId).then((items) => setMarks(items)).catch(() => {});
              }
              if (cardId) router.push(`/cards?focus=${cardId}`);
            }}
            t={t}
          />
        )}

        {/* Feature #2 — «Урожай выделений → карточки» wizard. Refresh marks on a
            successful apply so the «✓ в карточке» badges + dimming appear. */}
        <HarvestWizard
          open={harvestOpen}
          onClose={() => setHarvestOpen(false)}
          sourceId={sourceId}
          locale={locale as 'en' | 'ru'}
          onApplied={() => {
            fetchMarks(sourceId).then((items) => setMarks(items)).catch(() => {});
          }}
          t={t}
        />
      </div>
    );
  },
);
PdfReader.displayName = 'PdfReader';

const modeFallbackBtn: React.CSSProperties = {
  height: 36,
  padding: '0 14px',
  borderRadius: 'var(--r-md)',
  border: '1px solid var(--border)',
  background: 'var(--surface-2)',
  color: 'var(--text)',
  cursor: 'pointer',
  fontSize: 13,
};
