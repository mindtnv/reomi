'use client';

/* eslint-disable react/forbid-elements -- #78 */
import { AssistantAskButton } from '../chat/assistant-ask-button';
import { SourceStudioPanel } from '../notebook/source-studio-panel';
import { SourceAnnotationNotes } from '../pdf-reader/source-annotation-notes';
import { SourceNotesPanel } from '../notebook/source-notes-panel';
import { Modal, type ModalHandle } from '../design-system/modal';

// LibraryReader (L2) — the full-screen reader at `/library/[id]`. The complete
// M4/M5 reading-first workflow (PDF + ink + highlights + notes + quick-card +
// «Разметка» panel + selection popover) moved here OUT of the notebook workspace
// (Р6): reading no longer requires a notebook. On top of M5 it adds:
//   • a table of contents (PDF outline / distinct text headings)
//   • server-side reading progress (PUT /library/items/:id/reading-state, 5 s
//     debounce) with a one-time migration of the nn:pdf:pos localStorage cache
//   • Ask opens the shared contextual assistant without creating a notebook
//   • deep links ?page=&chunk=&pos=&mark=
//
// pdf.js loading is UNTOUCHED — PdfReader still dynamically imports the vendored
// native-ESM build; this screen only changes where it is mounted.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAppNavigation, useNavigationWorkspace, useWorkspaceState } from '@/components/navigation';
import { NNBtn, NNIcon, NNLoadError, NNSkeleton } from '@/components/ui';
import { api, ok, type ApiError } from '@/lib/api';
import { resolveMediaSrc } from '@/lib/media-url';
import { toApiError } from '@/lib/resource-state';
import { useKnowledgeRefresh } from '@/lib/use-knowledge-refresh';
import { canReadSource } from '@/lib/source-reading';
import { ThemeToggle } from '@/components/theme-toggle';
import { useNN } from '@/lib/store';
import type {
  LibraryItemDetail,
  Source,
  SourceChunkRow,
  SourceLinkedCard,
  SourceMark,
} from '@/lib/types';
import { useT } from '@/lib/i18n';
import { readBrowserValue, writeBrowserValue } from '@/lib/storage-migration';
import { transientLayers } from '@/lib/layer-stack';
import { ActiveLayerScope, LayerParent, useTransientLayer } from '@/lib/use-transient-layer';
import { useWcoTopInsets } from '@/lib/ui-store';
import { useDialog } from '@/components/dialog';
import { raiseToast } from '@/components/toasts';
import { PdfReader, type PdfOutlineEntry, type PdfReaderHandle } from '@/components/pdf-reader/pdf-reader';
import { TextChunkReader, type TextChunkReaderHandle } from '@/components/screens/text-reader';
import { askAssistant } from '../chat/assistant-provider';
import { ASSISTANT_CONTEXT_LIMITS } from '@reomi/shared';
import { buildMarkupMarkdown, downloadMarkdown } from '@/lib/markup-export';
import { createReadingProgressWriter } from '@/lib/reading-progress';

type Tr = (key: string, params?: Record<string, string | number>) => string;

const TOC_KEY = (id: string) => `nn:lib:toc:${id}`;
const POS_KEY = (id: string) => `nn:pdf:pos:${id}`;

/** A unified TOC entry (PDF outline → page; text heading → chunk position). */
interface TocEntry {
  label: string;
  depth: number;
  page?: number | null;
  pos?: number;
}

export interface SourceStudyWorkspaceProps {
  sourceId: string;
  initialLocation?: { page?: number; chunkId?: string; pos?: number; markId?: string };
  origin?: { title: string; onReturn(): void };
}
export const SourceStudyWorkspace = ({ sourceId, initialLocation, origin }: SourceStudyWorkspaceProps) => {
  const t = useT();
  const router = useAppNavigation();
  const searchParams = useSearchParams();
  const navigationWorkspace = useNavigationWorkspace();
  const navigationEntry = navigationWorkspace?.entry?.id;
  const navigationScope = `source:${sourceId}`;
  const remembered = navigationWorkspace?.entry?.views[navigationScope];
  const { confirm } = useDialog();

  const getSource = useNN((s) => s.getSource);
  const getLibraryItem = useNN((s) => s.getLibraryItem);
  const getSourceChunks = useNN((s) => s.getSourceChunks);
  const putReadingState = useNN((s) => s.putReadingState);
  const patchLibraryItem = useNN((s) => s.patchLibraryItem);
  const uploadMedia = useNN((s) => s.uploadMedia);
  const listSourceCards = useNN((s) => s.listSourceCards);

  const [source, setSource] = useState<Source | null>(null);
  const [detail, setDetail] = useState<LibraryItemDetail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);
  const metadataRefresh = useRef(0);
  useEffect(() => () => { metadataRefresh.current++; }, [sourceId]);
  useKnowledgeRefresh(async () => {
    const sequence = ++metadataRefresh.current, owner = useNN.getState().profile?.userId;
    const fresh = await getSource(sourceId);
    if (sequence === metadataRefresh.current && useNN.getState().profile?.userId === owner) setSource(previous => previous?.id === fresh.id ? { ...previous, ...fresh } : previous);
  });

  // PDF | Text reader mode. PDF sources default to 'pdf' (persisted per source);
  // non-PDF sources are always 'text'.
  const [readerMode, setReaderMode] = useWorkspaceState<'pdf' | 'text'>(navigationScope, 'mode', 'text');
  const pdfReaderRef = useRef<PdfReaderHandle>(null);
  const textReaderRef = useRef<TextChunkReaderHandle>(null);

  // chatEnabled gates the quick-card AI formulate button (degrade silently).
  const [chatEnabled, setChatEnabled] = useState(false);

  // ── TOC state ─────────────────────────────────────────────────────────────────
  const [tocOpen, setTocOpen] = useWorkspaceState(navigationScope, 'tocOpen', false);
  const [tocEntries, setTocEntries] = useState<TocEntry[] | null>(null);


  // ── Cards drawer (L4 §8.4 — «N карточек» badge → list of source's cards) ──────────
  const [cardsDrawerOpen, setCardsDrawerOpen] = useWorkspaceState(navigationScope,'cardsDrawerOpen',false);
  const [notesOpen, setNotesOpen] = useWorkspaceState(navigationScope, 'notesOpen', false);
  const [studyTab, setStudyTab] = useWorkspaceState<'notes' | 'annotations' | 'artifacts'>(navigationScope, 'studyTab', 'notes');
  const notesModal = useRef<ModalHandle>(null);
  const changeStudyTab = async (tab: typeof studyTab) => {
    if (tab === studyTab || await notesModal.current?.checkClose()) setStudyTab(tab);
  };
  useEffect(() => {
    if (!notesOpen) return;
    let forwarding = false;
    const owner = useNN.getState().profile?.userId;
    const handoff = (event: Event) => {
      if (forwarding) return;
      event.stopImmediatePropagation();
      const intent = (event as CustomEvent).detail;
      void transientLayers.confirmNavigation().then(async allowed => {
        if (!allowed || !notesModal.current || useNN.getState().profile?.userId !== owner) return;
        await transientLayers.closeForNavigation();
        if (!notesModal.current || useNN.getState().profile?.userId !== owner) return;
        forwarding = true;
        window.dispatchEvent(new CustomEvent('nn:assistant:ask', { detail: intent }));
        forwarding = false;
      });
    };
    window.addEventListener('nn:assistant:ask', handoff, true);
    return () => { window.removeEventListener('nn:assistant:ask', handoff, true); };
  }, [notesOpen, sourceId]);

  const artifactParam = searchParams.get('artifact') ?? undefined;
  const newNoteParam = searchParams.get('newNote') === '1';
  useEffect(() => {
    if (artifactParam) { setNotesOpen(true); setStudyTab('artifacts'); }
    else if (newNoteParam) { setNotesOpen(true); setStudyTab('notes'); }
  }, [artifactParam, newNoteParam]);

  const restoringHistory = navigationWorkspace?.restored && Boolean(remembered);
  // Deep-link params (?page=&chunk=&pos=&mark=) — consume-and-clear once.
  const pageParam = restoringHistory ? null : origin ? (initialLocation?.page != null ? String(initialLocation.page) : null) : searchParams.get('page');
  const chunkParam = restoringHistory ? null : origin ? initialLocation?.chunkId ?? null : searchParams.get('chunk');
  const posParam = restoringHistory ? null : origin ? (initialLocation?.pos != null ? String(initialLocation.pos) : null) : searchParams.get('pos');
  const markParam = restoringHistory ? null : origin ? initialLocation?.markId ?? null : searchParams.get('mark');
  const pendingPageRef = useRef<number | undefined>(undefined);
  const pendingMarkRef = useRef<string | undefined>(undefined);
  const pendingChunkRef = useRef<{ chunkId?: string; pos?: number } | null>(null);

  // ── Load the source + library detail ────────────────────────────────────────────
  // The initial reader mode AND the initial scroll position (deep-link > server
  // reading-state > localStorage cache) are resolved SYNCHRONOUSLY here, before
  // `setLoaded(true)` mounts the reader — PdfReader reads `initialPage` only once
  // at mount, so the refs must be set in the same tick as the mount-triggering
  // state change (an effect would run one render too late).
  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setLoadError(null);
    setSource(null);
    setDetail(null);
    setTocOpen(false);
    setTocEntries(null);
    if(remembered?.fields.cardsDrawerOpen===undefined)setCardsDrawerOpen(false);
    pendingPageRef.current = undefined;
    pendingMarkRef.current = undefined;
    pendingChunkRef.current = null;
    docInfoDoneRef.current = false;
    (async () => {
      try {
        const [src, det] = await Promise.all([
          getSource(sourceId),
          getLibraryItem(sourceId).catch(() => null),
        ]);
        if (cancelled) return;

        // Resolve the initial reader mode.
        let mode: 'pdf' | 'text' = 'text';
        if (src.kind === 'pdf') {
          let stored: string | null = null;
          try {
            stored = readBrowserValue(localStorage, `nn:nb:readermode:${src.id}`);
          } catch {
            stored = null;
          }
          mode = remembered?.fields.mode === 'text' || remembered?.fields.mode === 'pdf' ? remembered.fields.mode : stored === 'text' ? 'text' : 'pdf';
        }

        // Resolve the initial scroll target — deep link wins, then the persisted
        // server reading-state, then the localStorage position cache (migrated).
        const pageNum = pageParam != null ? Number(pageParam) : undefined;
        const posNum = posParam != null ? Number(posParam) : undefined;
        if (src.kind === 'pdf' && markParam) {
          mode = 'pdf';
          pendingMarkRef.current = markParam;
        } else if (src.kind === 'pdf' && pageNum != null && Number.isFinite(pageNum) && pageNum >= 1) {
          mode = 'pdf';
          pendingPageRef.current = pageNum;
        } else if (chunkParam || (posNum != null && Number.isFinite(posNum))) {
          if (src.kind === 'pdf') mode = 'text';
          pendingChunkRef.current = { chunkId: chunkParam ?? undefined, pos: posNum };
        } else if (remembered?.scrolls[mode === 'pdf' ? 'pdf' : 'text']) {
          // The reader's navigation adapter restores the exact history anchor.
          // Do not also start the legacy progress jump.
        } else if (mode === 'pdf' && typeof remembered?.fields.page === 'number') {
          pendingPageRef.current = remembered.fields.page;
        } else if (mode === 'text' && typeof remembered?.fields.chunkPos === 'number') {
          pendingChunkRef.current = {pos:remembered.fields.chunkPos};
        } else {
          // No history anchor — use server reading position.

          const rs = det?.readingState ?? null;
          if (src.kind === 'pdf') {
            if (rs?.page != null && rs.page >= 1) {
              pendingPageRef.current = rs.page;
            } else {
              try {
                const raw = readBrowserValue(localStorage, POS_KEY(sourceId));
                if (raw) {
                  const { page } = JSON.parse(raw) as { page?: number };
                  if (typeof page === 'number' && page >= 1) {
                    pendingPageRef.current = page;
                    void putReadingState(sourceId, { page });
                  }
                }
              } catch {
                /* ignore */
              }
            }
          } else if (rs?.chunkPos != null && rs.chunkPos >= 0) {
            pendingChunkRef.current = { pos: rs.chunkPos };
          }
        }

        setSource(src);
        setDetail(det);
        setReaderMode(mode);
        // Persist a deep-link mode override (so a citation that forced text/pdf
        // sticks); a plain restore keeps the stored preference untouched.
        if (src.kind === 'pdf' && (markParam || pageParam || chunkParam || posParam)) {
          try {
            writeBrowserValue(localStorage, `nn:nb:readermode:${src.id}`, mode);
          } catch {
            /* best-effort */
          }
        }
        // Clear the deep-link params from the URL (eat-and-clear).
        if (!origin && (pageParam || chunkParam || posParam || markParam)) {
          router.replace(`/library/${sourceId}`, { scroll: false, track: false });
        }
      } catch (error) {
        if (!cancelled) {
          setSource(null);
          setDetail(null);
          setLoadError(toApiError(error));
        }
      } finally {
        if (!cancelled) setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceId, getSource, getLibraryItem, loadRevision, navigationEntry]);

  // chatEnabled (degrade — hide AI formulate).
  useEffect(() => {
    void (async () => {
      try {
        const s = (await ok(await (api as any).ai.status.get())) as { chatEnabled: boolean };
        setChatEnabled(Boolean(s.chatEnabled));
      } catch {
        /* hide */
      }
    })();
  }, []);

  const setReaderModePersisted = useCallback(
    (m: 'pdf' | 'text') => {
      setReaderMode(m);
      try {
        writeBrowserValue(localStorage, `nn:nb:readermode:${sourceId}`, m);
      } catch {
        /* best-effort */
      }
    },
    [sourceId, setReaderMode],
  );

  const progressWriter = useMemo(() => createReadingProgressWriter(sourceId, useNN.getState().profile?.userId,
    () => useNN.getState().profile?.userId, putReadingState), [sourceId, putReadingState]);
  const writeProgress = progressWriter.write;
  useEffect(() => () => progressWriter.flush(), [progressWriter]);

  const onPdfPageChange = useCallback(
    (page: number, numPages: number) => {
      const percent = numPages > 0 ? Math.min(1, Math.max(0, page / numPages)) : undefined;
      writeProgress({ page, percent });
      navigationWorkspace?.journal?.field(navigationScope,'page',page,navigationEntry);
    },
    [writeProgress, navigationWorkspace?.journal, navigationScope, navigationEntry],
  );

  const onTextPositionChange = useCallback(
    (pos: number, total: number) => {
      const percent = total > 0 ? Math.min(1, Math.max(0, (pos + 1) / total)) : undefined;
      writeProgress({ chunkPos: pos, percent });
      navigationWorkspace?.journal?.field(navigationScope,'chunkPos',pos,navigationEntry);
    },
    [writeProgress, navigationWorkspace?.journal, navigationScope, navigationEntry],
  );

  // ── L3 — lazy PDF cover + pageCount/author backfill (NULL DB fields only) ──────
  // Fires once per open from PdfReader after the doc loads. We render page 1 to a
  // ~480px webp, upload it as a media object, and PATCH coverMediaId — plus
  // pageCount/author — but ONLY for fields the server still has as NULL (never
  // clobber a manual edit). One attempt, no retries.
  const docInfoDoneRef = useRef(false);
  const onDocInfo = useCallback(
    async (info: { numPages: number; author?: string; renderCover: () => Promise<Blob | null> }) => {
      if (docInfoDoneRef.current) return;
      docInfoDoneRef.current = true;
      const cur = detail ?? null;
      const patch: { pageCount?: number; author?: string; coverMediaId?: string } = {};
      if ((cur?.pageCount ?? null) == null && info.numPages > 0) {
        patch.pageCount = info.numPages;
      }
      if ((cur?.author ?? null) == null && info.author) {
        patch.author = info.author;
      }
      // Cover only when none is set yet.
      const hasCover = cur?.coverMediaId != null;
      try {
        if (!hasCover) {
          const blob = await info.renderCover();
          if (blob) {
            const file = new File([blob], 'cover.webp', { type: 'image/webp' });
            const { mediaId } = await uploadMedia(file);
            patch.coverMediaId = mediaId;
          }
        }
        if (Object.keys(patch).length > 0) {
          const updated = await patchLibraryItem(sourceId, patch);
          setDetail((prev) => (prev ? { ...prev, ...updated } : prev));
        }
      } catch {
        /* best-effort — a cover failure never affects reading */
      }
    },
    [detail, sourceId, uploadMedia, patchLibraryItem],
  );

  // ── TOC building (PDF outline via the reader handle / text headings) ──────────────
  const buildTextToc = useCallback(async () => {
    // Walk chunk pages and collect the FIRST chunk of each distinct heading.
    const entries: TocEntry[] = [];
    const seen = new Set<string>();
    let from = 0;
    for (let guard = 0; guard < 60; guard++) {
      let page: { items: SourceChunkRow[]; total: number; nextFrom: number | null };
      try {
        page = await getSourceChunks(sourceId, from, 200);
      } catch {
        break;
      }
      for (const c of page.items) {
        const h = c.heading?.trim();
        if (!h || seen.has(h)) continue;
        seen.add(h);
        entries.push({ label: h, depth: 0, pos: c.position });
      }
      if (page.nextFrom == null) break;
      from = page.nextFrom;
    }
    return entries;
  }, [getSourceChunks, sourceId]);

  const ensureToc = useCallback(async () => {
    if (tocEntries !== null) return tocEntries;
    let entries: TocEntry[] = [];
    if (source?.kind === 'pdf' && readerMode === 'pdf') {
      const outline: PdfOutlineEntry[] = (await pdfReaderRef.current?.getOutline()) ?? [];
      entries = outline.map((o) => ({ label: o.title, depth: o.depth, page: o.page }));
    } else {
      entries = await buildTextToc();
    }
    setTocEntries(entries);
    return entries;
  }, [tocEntries, source, readerMode, buildTextToc]);

  const onToggleToc = useCallback(() => {
    setTocOpen((v) => {
      const next = !v;
      try {
        writeBrowserValue(localStorage, TOC_KEY(sourceId), next ? '1' : '0');
      } catch {
        /* best-effort */
      }
      if (next) void ensureToc();
      return next;
    });
  }, [ensureToc, sourceId]);

  // Probe TOC availability in the BACKGROUND so the toolbar button can hide when
  // there's no outline/headings (the toggle is gated on `tocAvailable`). For PDF
  // the outline needs the doc loaded — retry a few times until it resolves.
  useEffect(() => {
    if (!loaded || !source || tocEntries !== null) return;
    let cancelled = false;
    let attempts = 0;
    const probe = async () => {
      if (cancelled) return;
      if (source.kind === 'pdf' && readerMode === 'pdf') {
        const outline = (await pdfReaderRef.current?.getOutline()) ?? [];
        if (cancelled) return;
        if (outline.length > 0) {
          setTocEntries(outline.map((o) => ({ label: o.title, depth: o.depth, page: o.page })));
          return;
        }
        // Doc may not be ready yet (returns []) — retry, then settle on empty.
        if (attempts++ < 8) {
          window.setTimeout(() => void probe(), 700);
          return;
        }
        setTocEntries([]);
      } else {
        const entries = await buildTextToc();
        if (!cancelled) setTocEntries(entries);
      }
    };
    void probe();
    return () => {
      cancelled = true;
    };
  }, [loaded, source, readerMode, tocEntries, buildTextToc]);

  // Hydrate the persisted TOC-open preference once the source is known.
  useEffect(() => {
    if (!loaded || !source) return;
    try {
      if (remembered?.fields.tocOpen === true || (remembered?.fields.tocOpen === undefined && readBrowserValue(localStorage, TOC_KEY(sourceId)) === '1')) {
        setTocOpen(true);
        void ensureToc();
      }
    } catch {
      /* default closed */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, source]);

  // Rebuild the TOC when switching reader mode (PDF outline ↔ text headings differ).
  const lastTocModeRef = useRef<'pdf' | 'text' | null>(null);
  useEffect(() => {
    if (lastTocModeRef.current != null && lastTocModeRef.current !== readerMode) {
      setTocEntries(null);
      if (tocOpen) void ensureToc();
    }
    lastTocModeRef.current = readerMode;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readerMode]);

  const onTocJump = useCallback(
    (entry: TocEntry) => {
      if (source?.kind === 'pdf' && readerMode === 'pdf' && entry.page != null) {
        pdfReaderRef.current?.scrollToPage(entry.page, true);
      } else if (entry.pos != null) {
        textReaderRef.current?.scrollToChunk(undefined, entry.pos);
      }
    },
    [source, readerMode],
  );

  // Fulfil a pending text-chunk jump (deep link or restored position) once the
  // text reader mounts. The TextChunkReader itself pages forward + flashes; here
  // we just hand it the target. (The deep-link page/mark targets for PDF are
  // resolved synchronously in the load effect and ride PdfReader's initialPage.)
  useEffect(() => {
    if (readerMode !== 'text') return;
    const p = pendingChunkRef.current;
    if (!p) return;
    pendingChunkRef.current = null;
    textReaderRef.current?.scrollToChunk(p.chunkId, p.pos);
  }, [readerMode, loaded]);

  // ── L4 §8.4 — «Экспорт в Markdown» ────────────────────────────────────────────
  // Pure assembly (marks + ink markedText come from the reader) → blob download.
  const onExportMarkup = useCallback(
    (data: { marks: SourceMark[]; ink: { page: number; markedText: string | null }[] }) => {
      const title = source?.title ?? 'markup';
      const md = buildMarkupMarkdown({
        title,
        author: detail?.author ?? null,
        marks: data.marks,
        ink: data.ink,
        cardCount: detail?.cardCount ?? 0,
        labels: {
          pageHeading: t('library.reader.exportPage'),
          inkLabel: t('library.reader.exportInk'),
          cardsFooter: (n) => t('library.reader.exportCards', { n }),
        },
      });
      downloadMarkdown(title, md);
      raiseToast({ kind: 'info', title: t('library.reader.exportDone') });
    },
    [source, detail, t],
  );

  const onAskChat = useCallback((quote: string, page: number) => {
    const clean = quote.trim();
    if (clean.length > ASSISTANT_CONTEXT_LIMITS.excerptChars) {
      raiseToast({ kind: 'error', titleKey: 'assistant.contextLimit' });
      return;
    }
    askAssistant({ ref: clean ? { kind: 'source_passage', id: sourceId, locator: { quote: clean, page } }
      : { kind: 'source', id: sourceId }, ...(clean ? { prefill: t('notebooks.marks.selectionAskPrompt') } : {}) });
  }, [sourceId, t]);

  // ── Render ────────────────────────────────────────────────────────────────────
  if (loaded && !source) {
    if (loadError && loadError.status !== 404) {
      return (
        <div style={{ flex: 1, minHeight: 0, display: 'grid', placeItems: 'center', padding: 24 }}>
          <div style={{ width: 'min(520px, 100%)' }}>
            <NNLoadError
              title={t('toasts.error')}
              description={loadError.safeMessage}
              retryLabel={t('notebooks.overview.retry')}
              requestId={loadError.requestId}
              onRetry={() => setLoadRevision((value) => value + 1)}
            />
          </div>
        </div>
      );
    }
    return (
      <div className="nn-empty-state" style={{ flex: 1, minHeight: 0 }}>
        <span className="nn-empty-state-icon"><NNIcon name="doc" size={32} color="var(--text-dim)" /></span>
        <p className="nn-empty-state-hint">{t('library.reader.notFound')}</p>
        <NNBtn variant="soft" size="sm" icon="chevl" onClick={() => router.push('/library')}>
          {t('library.reader.back')}
        </NNBtn>
      </div>
    );
  }

  const isPdfReady = source?.kind === 'pdf' && readerMode === 'pdf' && canReadSource(source, 'pdf');
  const tocAvailable = (tocEntries?.length ?? 0) > 0;
  const parentRoute = navigationWorkspace?.journal?.parent()?.href.split(/[/?#]/)[1];
  const returnLabel = parentRoute && ['library','cards','decks','notebooks','review','editor','chat'].includes(parentRoute) ? t('navigation.returnTo',{place:t(`nav.${parentRoute}`)}) : undefined;

  return (
    <div className="reomi-library-reader">
      <ReaderHeader
        source={source}
        author={detail?.author ?? null}
        coverUrl={detail?.coverUrl ?? null}
        cardCount={detail?.cardCount ?? 0}
        onOpenCards={() => setCardsDrawerOpen(true)}
        onNotes={() => setNotesOpen(true)}
        onBack={origin?.onReturn ?? (() => router.returnTo('/library'))}
        backLabel={origin?.title ?? returnLabel}
        onDetails={() => router.push(`/library?focus=${sourceId}`)}
        t={t}
      />
      <div className="reomi-reader-workspace">
        {/* TOC panel (left slide-out) */}
        {tocOpen && (
          <TocPanel
            entries={tocEntries}
            onJump={(e) => onTocJump(e)}
            onClose={() => onToggleToc()}
            t={t}
          />
        )}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {!loaded || !source ? (
            <div aria-busy="true" style={{ padding: 24, display: 'flex', justifyContent: 'center', flex: 1, overflow: 'hidden', background: 'var(--surface-2)' }}>
              <NNSkeleton width="min(760px, 100%)" height="min(900px, 78vh)" radius={8} />
            </div>
          ) : isPdfReady ? (
            <PdfReader
              key={source.id}
              ref={pdfReaderRef}
              sourceId={source.id}
              sourceName={source.title}
              sourceVersion={new Date(source.updatedAt).toISOString()}
              initialPage={pendingPageRef.current}
              initialMarkId={pendingMarkRef.current}
              onMode={setReaderModePersisted}
              onAskChat={onAskChat}
              chatEnabled={chatEnabled}
              onPageChange={onPdfPageChange}
              onDocInfo={onDocInfo}
              onExportMarkup={onExportMarkup}
              tocOpen={tocOpen}
              tocAvailable={tocAvailable}
              onToggleToc={onToggleToc}
              t={t}
            />
          ) : (
            <TextReaderShell
              source={source}
              getSourceChunks={getSourceChunks}
              textReaderRef={textReaderRef}
              chatEnabled={chatEnabled}
              onPositionChange={onTextPositionChange}
              tocOpen={tocOpen}
              onToggleToc={onToggleToc}
              onMode={setReaderModePersisted}
              t={t}
            />
          )}
        </div>
      </div>

      {/* Cards drawer (L4 §8.4) — the «N карточек» badge in the header. */}
      <Modal controlRef={notesModal} open={notesOpen} title={t('assistant.savedStudy')} closeLabel={t('actions.close')} onClose={() => setNotesOpen(false)}>
        <div style={{ display: 'flex', gap: 8, padding: 8 }}>
          <NNBtn size="sm" active={studyTab === 'notes'} onClick={() => void changeStudyTab('notes')}>{t('notebooks.marks.studyNotes')}</NNBtn>
          <NNBtn size="sm" active={studyTab === 'annotations'} onClick={() => void changeStudyTab('annotations')}>{t('notebooks.marks.annotationNotes')}</NNBtn>
          <NNBtn size="sm" active={studyTab === 'artifacts'} onClick={() => void changeStudyTab('artifacts')}>{t('notebooks.studio.listHeading')}</NNBtn>
        </div>
        <div style={{ height: '65dvh', minHeight: 240 }}>
          <div hidden={studyTab !== 'notes'} style={{ height: '100%' }}><ActiveLayerScope active={studyTab === 'notes'}><SourceNotesPanel key={sourceId} sourceId={sourceId} initialCreate={newNoteParam} /></ActiveLayerScope></div>
          {studyTab === 'annotations' && <div className="nn-scroll" style={{ height: '100%', overflow: 'auto' }}><SourceAnnotationNotes key={sourceId} sourceId={sourceId} onOpen={mark => { void notesModal.current?.close().then(allowed => { if (allowed) pdfReaderRef.current?.scrollToPage(mark.page, true); }); }}/></div>}
          <div hidden={studyTab !== 'artifacts'} style={{ height: '100%' }}><ActiveLayerScope active={studyTab === 'artifacts'}><SourceStudioPanel key={sourceId} sourceId={sourceId} initialArtifactId={artifactParam} chatEnabled={chatEnabled} /></ActiveLayerScope></div>
        </div>
      </Modal>
      {cardsDrawerOpen && (
        <CardsDrawer
          sourceId={sourceId}
          listSourceCards={listSourceCards}
          onOpenCard={(cardId) => router.push(`/cards?focus=${cardId}`)}
          onClose={() => setCardsDrawerOpen(false)}
          t={t}
        />
      )}
    </div>
  );
};

// ── Header ────────────────────────────────────────────────────────────────────

const ReaderHeader = ({
  source,
  author,
  coverUrl,
  cardCount,
  onOpenCards,
  onNotes,
  onBack,
  backLabel,
  onDetails,
  t,
}: {
  source: Source | null;
  author: string | null;
  coverUrl: string | null;
  cardCount: number;
  onOpenCards: () => void;
  onNotes: () => void;
  onBack: () => void;
  backLabel?: string;
  onDetails: () => void;
  t: Tr;
}) => {
  const { wco, left: wcoLeft, right: wcoRight } = useWcoTopInsets();
  return (
  <div
    className="nn-chrome reomi-reader-header"
    data-wco={wco ? '1' : undefined}
    style={{
paddingLeft: 16 + wcoLeft, paddingRight: 16 + wcoRight,
    }}
  >
    <NNBtn variant="ghost" size="sm" icon="chevl" onClick={onBack} ariaLabel={backLabel ?? t('library.reader.back')}>
      {backLabel ?? t('library.reader.back')}
    </NNBtn>
    {coverUrl && (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={resolveMediaSrc(coverUrl)}
        alt=""
        style={{ width: 22, height: 30, objectFit: 'cover', borderRadius: 3, flexShrink: 0, border: '1px solid var(--border)' }}
      />
    )}
    <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
      <h2
        style={{
          fontSize: 14,
          fontWeight: 700,
          fontFamily: 'var(--font-sans)',
          color: 'var(--text)',
          margin: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          letterSpacing: '-0.01em',
        }}
      >
        {source?.title ?? t('library.reader.loading')}
      </h2>
      {author && (
        <span
          style={{
            fontSize: 11.5,
            color: 'var(--text-dim)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontFamily: 'var(--font-sans)',
          }}
        >
          {author}
        </span>
      )}
    </div>
    {cardCount > 0 && (
      <button
        type="button"
        onClick={onOpenCards}
        title={t('library.reader.cardsBadge', { n: cardCount })}
        className="nn-tb-btn"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          height: 26,
          padding: '0 9px',
          width: 'auto',
          borderRadius: 'var(--r-sm)',
          border: '1px solid var(--lime-500)',
          background: 'color-mix(in srgb, var(--lime-500) 10%, var(--surface))',
          color: 'var(--lime-400)',
          fontSize: 11.5,
          fontWeight: 600,
          fontFamily: 'var(--font-sans)',
          whiteSpace: 'nowrap',
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="2" y="5" width="20" height="14" rx="2" />
          <line x1="2" y1="10" x2="22" y2="10" />
        </svg>
        {t('library.reader.cardsBadge', { n: cardCount })}
      </button>
    )}
    {source && <AssistantAskButton object={{ kind: 'source', id: source.id }} compact />}
    {source && <NNBtn variant="ghost" size="sm" icon="note" ariaLabel={t('notebooks.notes.heading')} title={t('notebooks.notes.heading')} onClick={onNotes} />}
    <ThemeToggle />
    <NNBtn variant="ghost" size="sm" icon="dots" ariaLabel={t('library.reader.details')} title={t('library.reader.details')} onClick={onDetails} />
  </div>
  );
};

// ── Text-mode shell (light toolbar + TextChunkReader) ─────────────────────────

const TextReaderShell = ({
  source,
  getSourceChunks,
  textReaderRef,
  onPositionChange,
  chatEnabled,
  tocOpen,
  onToggleToc,
  onMode,
  t,
}: {
  source: Source;
  getSourceChunks: (
    id: string,
    from?: number,
    limit?: number,
  ) => Promise<{ items: SourceChunkRow[]; total: number; nextFrom: number | null }>;
  textReaderRef: React.RefObject<TextChunkReaderHandle | null>;
  chatEnabled: boolean;
  onPositionChange: (pos: number, total: number) => void;
  tocOpen: boolean;
  onToggleToc: () => void;
  onMode: (m: 'pdf' | 'text') => void;
  t: Tr;
}) => {
  if (!canReadSource(source, 'text')) {
    const failed = source.status === 'error';
    return (
      <div className="nn-empty-state reomi-reader-empty" style={{ flex: 1 }}>
        <span className="nn-empty-state-icon"><NNIcon name="doc" size={30} color="var(--accent-500)" /></span>
        <h3>{t(failed ? 'library.reader.unavailable' : source.status === 'deleting' ? 'library.status.deleting' : 'library.reader.preparing')}</h3>
        <p className="nn-empty-state-hint">{t(failed ? 'library.reader.unavailableHint' : 'notebooks.reader.notReady')}</p>
        {source.kind === 'pdf' && source.status !== 'deleting' && (
          <NNBtn variant="soft" size="sm" onClick={() => onMode('pdf')}>{t('notebooks.reader.modePdf')}</NNBtn>
        )}
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className="nn-chrome nn-reader-toolbar reomi-pdf-toolbar" role="toolbar" aria-label={t('notebooks.reader.toolbar')}>
        <div className="reomi-reader-toolbar-row nn-scroll">
          <div className="reomi-reader-group">
            <button type="button" onClick={onToggleToc} className={`nn-tb-btn${tocOpen ? ' active' : ''}`}
              aria-pressed={tocOpen} data-tooltip={t('library.reader.toc')} aria-label={t('library.reader.toc')}>
              <NNIcon name="menu" size={16} />
            </button>
            {source.kind === 'pdf' && <div className="reomi-reader-mode">
              <button type="button" onClick={() => onMode('pdf')} aria-pressed={false}>{t('notebooks.reader.modePdf')}</button>
              <button type="button" aria-pressed={true}>{t('notebooks.reader.modeText')}</button>
            </div>}
          </div>
        </div>
      </div>
      <TextChunkReader
        ref={textReaderRef}
        sourceId={source.id}
        sourceName={source.title}
        chatEnabled={chatEnabled}
        getSourceChunks={getSourceChunks}
        onPositionChange={onPositionChange}
        t={t}
      />
    </div>
  );
};

// ── TOC panel ─────────────────────────────────────────────────────────────────

const TocPanel = ({
  entries,
  onJump,
  onClose,
  t,
}: {
  entries: TocEntry[] | null;
  onJump: (e: TocEntry) => void;
  onClose: () => void;
  t: Tr;
}) => (
  <div
    className="nn-scroll"
    style={{
      width: 260,
      flexShrink: 0,
      borderRight: '1px solid var(--border)',
      overflowY: 'auto',
      background: 'var(--surface)',
      display: 'flex',
      flexDirection: 'column',
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 12px', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--surface)', zIndex: 1 }}>
      <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-dim)', flex: 1 }}>
        {t('library.reader.toc')}
      </span>
      <NNBtn variant="ghost" size="sm" icon="x" ariaLabel={t('library.reader.tocClose')} onClick={onClose} />
    </div>
    <div style={{ padding: '6px 6px 16px', display: 'flex', flexDirection: 'column', gap: 1 }}>
      {entries === null ? (
        <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <NNSkeleton style={{ height: 22 }} />
          <NNSkeleton style={{ height: 22 }} />
          <NNSkeleton style={{ height: 22 }} />
        </div>
      ) : entries.length === 0 ? (
        <p style={{ fontSize: 12, color: 'var(--text-dim)', padding: '8px 10px', margin: 0 }}>
          {t('library.reader.tocEmpty')}
        </p>
      ) : (
        entries.map((e, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onJump(e)}
            title={e.label}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 8px',
              paddingLeft: 8 + e.depth * 12,
              background: 'transparent',
              border: 'none',
              borderRadius: 'var(--r-sm)',
              cursor: 'pointer',
              textAlign: 'left',
              width: '100%',
            }}
            className="nn-toc-row"
          >
            <span
              style={{
                fontSize: 12.5,
                color: e.depth === 0 ? 'var(--text)' : 'var(--text-muted)',
                fontWeight: e.depth === 0 ? 600 : 500,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
                flex: 1,
              }}
            >
              {e.label}
            </span>
            {e.page != null && (
              <span style={{ fontSize: 10.5, color: 'var(--text-dim)', flexShrink: 0, fontFamily: 'var(--font-mono)' }}>
                {e.page}
              </span>
            )}
          </button>
        ))
      )}
    </div>
  </div>
);

// ── Cards drawer (L4 §8.4 — «N карточек» list from GET /sources/:id/cards) ─────

const CardsDrawer = ({
  sourceId,
  listSourceCards,
  onOpenCard,
  onClose,
  t,
}: {
  sourceId: string;
  listSourceCards: (id: string) => Promise<SourceLinkedCard[]>;
  onOpenCard: (cardId: string) => void;
  onClose: () => void;
  t: Tr;
}) => {
  const root = useRef<HTMLDivElement>(null);
  const layer = useTransientLayer({ root, modal: true, onClose });
  const [rows, setRows] = useState<SourceLinkedCard[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const items = await listSourceCards(sourceId);
        if (!cancelled) setRows(items);
      } catch {
        if (!cancelled) setRows([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceId, listSourceCards]);

  return (
    <LayerParent.Provider value={layer.id}>
      <div
        className="nn-dialog-backdrop"
        onClick={() => void layer.close()}
        style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'var(--scrim)' }}
      />
      <div
        ref={root} role="dialog" aria-modal="true" aria-label={t('library.reader.cardsTitle')} tabIndex={-1}
        className="nn-scroll"
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 360,
          maxWidth: '100%',
          zIndex: 91,
          background: 'var(--surface)',
          borderLeft: '1px solid var(--border)',
          boxShadow: 'var(--shadow-lg)',
          display: 'flex',
          flexDirection: 'column',
          overflowY: 'auto',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '12px 14px',
            borderBottom: '1px solid var(--border)',
            position: 'sticky',
            top: 0,
            background: 'var(--surface)',
            zIndex: 1,
          }}
        >
          <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', margin: 0, flex: 1, fontFamily: 'var(--font-sans)' }}>
            {t('library.reader.cardsTitle')}
          </h3>
          <NNBtn variant="ghost" size="sm" icon="x" ariaLabel={t('library.reader.tocClose')} onClick={() => void layer.close()} />
        </div>
        <div style={{ padding: '8px 8px 16px', display: 'flex', flexDirection: 'column', gap: 3 }}>
          {rows === null ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 6 }}>
              <NNSkeleton style={{ height: 44 }} />
              <NNSkeleton style={{ height: 44 }} />
              <NNSkeleton style={{ height: 44 }} />
            </div>
          ) : rows.length === 0 ? (
            <p style={{ fontSize: 12.5, color: 'var(--text-dim)', margin: 0, padding: '8px 10px' }}>
              {t('library.reader.cardsEmpty')}
            </p>
          ) : (
            rows.map((c) => (
              <button
                key={c.cardId}
                type="button"
                onClick={() => onOpenCard(c.cardId)}
                className="nn-lib-nb-link"
                style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 3, padding: '8px 10px' }}
              >
                <span style={{ fontSize: 12.5, color: 'var(--text)', textAlign: 'left', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', lineHeight: 1.4 }}>
                  {c.front}
                </span>
                {c.deckName && (
                  <span style={{ fontSize: 10.5, color: 'var(--text-dim)', fontFamily: 'var(--font-sans)' }}>
                    {c.deckName}
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </div>
    </LayerParent.Provider>
  );
};

export const LibraryReader = SourceStudyWorkspace;
