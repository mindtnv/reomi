'use client';

// LibraryScreen (L1) — the user's personal material store (`/library`). A
// "library item" IS a sources row; this screen lists them with a cover grid /
// list toggle, search + kind/reading filters + sort, a "Continue reading" shelf,
// a multi-file upload queue (drag-drop + picker), inline url/text add dialogs,
// and a details panel (metadata edit + attach-to-notebook + delete).
//
//  • Data is screen-local (like /notebooks) — thin store pass-throughs, no
//    bootstrap mirror. Non-terminal ingest statuses poll via useSourceStatus.
//  • PDF covers are prepared sequentially while browsing; placeholders remain
//    available during preparation or if rendering fails.
//  • A 409 duplicate_source on upload opens "Already in your library: open?";
//    409 library_full raises a toast.
//
// Inline styles + CSS vars + ui.tsx primitives only (no Tailwind).

import { sourceOperationLabel } from '@/lib/source-operation-label';
import { readBrowserValue, writeBrowserValue } from '@/lib/storage-migration';
import { useTransientLayer } from '@/lib/use-transient-layer';
import { useNavigationGuard } from '@/components/navigation';
import { useSmallAction } from '@/lib/use-small-action';
import { SaveFeedback } from '@/components/save-feedback';
import { LibraryIngestIndicator } from '@/components/library-ingest-indicator';
import { useLibraryPdfCovers } from '@/lib/library-pdf-cover';
import React, { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react';
import { useSearchParams } from 'next/navigation';
import type { IngestErrorCode, SourceKind, SourceMime, SourceStatus } from '@reomi/shared';
import { PageSurface, TextInput, SegmentedControl } from '@/components/design-system/primitives';
import { NNBtn, NNCard, NNIcon, NNBadge, NNInlineRefresh, NNLoadError, NNSkeleton, type IconName } from '@/components/ui';
import {
  DuplicateSourceError,
  LibraryFullError,
  useNN,
  type LibraryQuery,
} from '@/lib/store';
import type {
  LibraryItem,
  LibraryItemDetail,
  LibrarySearchGroup,
  LibrarySearchHit,
  LibrarySearchResult,
  Notebook,
  ReadingStatus,
} from '@/lib/types';
import { useBreakpoint } from '@/lib/use-breakpoint';
import { useT } from '@/lib/i18n';
import { useDialog } from '@/components/dialog';
import { raiseToast } from '@/components/toasts';
import { isNonTerminal, useSourceStatus } from '@/lib/use-source-status';
import { useKnowledgeRefresh } from '@/lib/use-knowledge-refresh';
import { useSessionResource, peekSessionResource, invalidateSessionResourceScope } from '@/lib/session-resource';
import { AppLink, useAppNavigation, useNavigationWorkspace, useWorkspaceState } from '@/components/navigation';

import { useNavigationScroll, NavigationRestoreNotice } from '@/lib/use-navigation-scroll';
import { restoreCollectionPages, refreshLoadedCollection } from '@/lib/navigation-restore';
import { toApiError } from '@/lib/resource-state';
import type { ApiError } from '@/lib/api';

type Tr = (key: string, params?: Record<string, string | number>) => string;
type ViewMode = 'grid' | 'list';
type SortMode = 'added' | 'title' | 'lastRead';
type KindFilter = 'all' | SourceKind;
type ReadingFilter = 'all' | ReadingStatus;

const VIEW_KEY = 'nn:lib:view';
const KIND_FILTERS: KindFilter[] = ['all', 'pdf', 'epub', 'url', 'text'];
const READING_FILTERS: ReadingFilter[] = ['all', 'unread', 'reading', 'finished'];
const SORTS: SortMode[] = ['added', 'title', 'lastRead'];

/** A deterministic placeholder accent colour from an id (no covers in L1). */
const COVER_COLORS = [
  'var(--lime-500)',
  'var(--violet-500)',
  'var(--sky-400)',
  'var(--amber-500)',
  'var(--rose-500)',
];
function coverColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return COVER_COLORS[h % COVER_COLORS.length]!;
}
function initials(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}
function kindIcon(kind: SourceKind): IconName {
  if (kind === 'url') return 'link';
  if (kind === 'text') return 'edit';
  return 'book';
}

function statusTone(status: LibraryItem['status']): string {
  if (status === 'ready') return 'lime';
  if (status === 'error') return 'rose';
  if (status === 'deleting') return 'neutral';
  return 'sky';
}

function mimeForFile(file: File): SourceMime | null {
  const lower = file.name.toLowerCase();
  if (file.type === 'application/pdf' || lower.endsWith('.pdf')) return 'application/pdf';
  if (file.type === 'application/epub+zip' || lower.endsWith('.epub')) return 'application/epub+zip';
  return null;
}

export const LibraryScreen = () => {
  const t = useT();
  const navigation = useAppNavigation();
  const searchParams = useSearchParams();
  const workspace = useNavigationWorkspace();
  const bp = useBreakpoint();
  const isMobile = bp === 'mobile';
  const { confirm, prompt, edit } = useDialog();

  const listLibrary = useNN((s) => s.listLibrary);
  const getLibraryItem = useNN((s) => s.getLibraryItem);
  const addLibraryUrl = useNN((s) => s.addLibraryUrl);
  const addLibraryText = useNN((s) => s.addLibraryText);
  const uploadLibraryItem = useNN((s) => s.uploadLibraryItem);
  const getSource = useNN((s) => s.getSource);

  // ── List state + filters ──────────────────────────────────────────────────────
  const [search, setSearch] = useWorkspaceState('library', 'search', '');
  const queryEntry = workspace?.entry?.id;
  const [debounced, setDebounced] = useState({ entry: queryEntry, value: search.trim() });
  const debouncedQ = debounced.entry === queryEntry ? debounced.value : search.trim();
  const setDebouncedQ = useCallback((value: string) => setDebounced({entry: queryEntry, value}), [queryEntry]);
  const [kind, setKind] = useWorkspaceState<KindFilter>('library', 'kind', 'all');
  const [reading, setReading] = useWorkspaceState<ReadingFilter>('library', 'reading', 'all');
  const [tag, setTag] = useWorkspaceState<string | null>('library', 'tag', null);
  const [unattached, setUnattached] = useWorkspaceState('library', 'unattached', false);
  const [sort, setSort] = useWorkspaceState<SortMode>('library', 'sort', 'added');
  const [view, setView] = useState<ViewMode>('grid');
  // Search mode: by title/author (the list) vs by content (semantic search).
  const [searchMode, setSearchMode] = useWorkspaceState<'title' | 'content'>('library', 'searchMode', 'title');

  // Hydrate the persisted view mode.
  useEffect(() => {
    try {
      const v = readBrowserValue(localStorage, VIEW_KEY);
      if (v === 'grid' || v === 'list') setView(v);
    } catch {
      /* default grid */
    }
  }, []);
  const setViewPersisted = useCallback((v: ViewMode) => {
    setView(v);
    try {
      writeBrowserValue(localStorage, VIEW_KEY, v);
    } catch {
      /* best-effort */
    }
  }, []);

  // Debounce the search box (300ms).
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedQ(search.trim()), 300);
    return () => window.clearTimeout(id);
  }, [search, setDebouncedQ]);

  const query = useMemo<LibraryQuery>(() => {
    const q: LibraryQuery = { sort };
    if (debouncedQ) q.q = debouncedQ;
    if (kind !== 'all') q.kind = kind;
    if (reading !== 'all') q.reading = reading;
    if (tag) q.tag = tag;
    if (unattached) q.shelf = 'unattached';
    return q;
  }, [sort, debouncedQ, kind, reading, tag, unattached]);

  // Persist the search mode (nn:lib:searchmode).
  const SEARCHMODE_KEY = 'nn:lib:searchmode';
  useEffect(() => {
    try {
      const v = readBrowserValue(localStorage, SEARCHMODE_KEY);
      if (!workspace?.entry?.views.library?.fields.searchMode && (v === 'content' || v === 'title')) setSearchMode(v);
    } catch {
      /* default title */
    }
  }, []);
  const setSearchModePersisted = useCallback((m: 'title' | 'content') => {
    setSearchMode(m);
    try {
      writeBrowserValue(localStorage, SEARCHMODE_KEY, m);
    } catch {
      /* best-effort */
    }
  }, []);

  // ── Add-source UI ──────────────────────────────────────────────────────────────
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [addDialog, setAddDialog] = useState<'url' | 'text' | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadQueue, setUploadQueue] = useState<{ total: number; done: number; name: string } | null>(null);
  const [dragActive, setDragActive] = useState(false);

  // ── Details panel ────────────────────────────────────────────────────────────
  const [detailId, setDetailId] = useWorkspaceState<string | null>('library', 'detailId', null);

  // L2 — clicking a material opens the full-screen reader; details moved to a
  // ⋯ button on each card/row.
  const openReader = useCallback((id: string) => navigation.push(`/library/${id}`), [navigation]);

  // ── Fetch list when filters change ──────────────────────────────────────────────
  // A stable scope gives us latest-request-wins across different filter keys;
  // each key remains session-cached so returning to a previous filter is instant.
  const libraryKey = useMemo(() => `library:list:${JSON.stringify(query)}`, [query]);
  const libraryRequest=useRef(0);
  const fetchLibrary = useCallback(() => {
    const generation=++libraryRequest.current,owner=useNN.getState().profile?.userId;
    return refreshLoadedCollection(peekSessionResource<{items:LibraryItem[];nextCursor:string|null}>(libraryKey),async cursor=>{
      if(generation!==libraryRequest.current||useNN.getState().profile?.userId!==owner)throw new DOMException('Cancelled','AbortError');
      return listLibrary({...query,...(cursor?{cursor}:{})});
    },t('navigation.refreshFailed'));
  }, [listLibrary, query, libraryKey, t]);
  const libraryResource = useSessionResource({
    key: libraryKey,
    scope: 'library:list',
    fetcher: fetchLibrary,
    keepPreviousData: true,
  });
  const items = libraryResource.data?.items ?? [];
  const nextCursor = libraryResource.data?.nextCursor ?? null;
  const loaded = libraryResource.data !== null || libraryResource.status === 'error';
  const setItems = useCallback((update: SetStateAction<LibraryItem[]>) => {
    libraryResource.mutate((current) => {
      const previous = current?.items ?? [];
      const next = typeof update === 'function'
        ? (update as (value: LibraryItem[]) => LibraryItem[])(previous)
        : update;
      return { items: next, nextCursor: current?.nextCursor ?? null };
    });
  }, [libraryResource.mutate]);
  const refresh = libraryResource.refresh;
  useKnowledgeRefresh(() => { invalidateSessionResourceScope('library:list'); refresh(); });

  const restoreRows = useCallback(async (anchor: import('@/lib/navigation-context').ScrollAnchor, signal: AbortSignal) => {
    if (!libraryResource.data || searchMode !== 'title') return 'missing' as const;
    const result = await restoreCollectionPages({ throughId:anchor.endId, initial: libraryResource.data, anchors: [anchor.id, ...(anchor.nearby ?? [])].filter((id): id is string => Boolean(id)),
      fetchPage: cursor => listLibrary({...query, cursor}), signal });
    if (!signal.aborted && result.reason !== 'cancelled') libraryResource.mutate({items:result.items,nextCursor:result.nextCursor});
    return result.reason;
  }, [libraryResource.data, libraryResource.mutate, searchMode, listLibrary, query]);
  const listPosition = useNavigationScroll('library', 'list', {ready: Boolean(libraryResource.data), queryKey: libraryKey, restoreRows});

  // Distinct tags from the loaded items (the simple client-side collection path).
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) for (const tg of it.tags) set.add(tg);
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [items]);

  // ── Content (semantic) search ──────────────────────────────────────────────────
  const searchLibrary = useNN((s) => s.searchLibrary);
  const contentEnabled = searchMode === 'content' && debouncedQ.length >= 3;
  const fetchContent = useCallback(() => searchLibrary(debouncedQ), [searchLibrary, debouncedQ]);
  const contentResource = useSessionResource({
    key: `library:content:${debouncedQ}`,
    scope: 'library:content',
    enabled: contentEnabled,
    fetcher: fetchContent,
    keepPreviousData: true,
  });
  const contentResult = contentResource.data;
  const contentLoading = contentResource.status === 'loading' || contentResource.status === 'refreshing';

  const openHit = useCallback(
    (group: LibrarySearchGroup, hit: LibrarySearchHit) => {
      // PDF with a page → ?page=; else text-mode chunk position → ?chunk=.
      const qs =
        group.source.kind === 'pdf' && hit.page != null
          ? `?page=${hit.page}`
          : `?chunk=${hit.position}`;
      navigation.push(`/library/${group.source.id}${qs}`);
    },
    [navigation],
  );

  // ── "Continue reading" shelf (separate fetch — reading=reading, lastRead) ──────
  const fetchShelf = useCallback(
    async () => (await listLibrary({ reading: 'reading', sort: 'lastRead', limit: 6 })).items,
    [listLibrary],
  );
  const shelfResource = useSessionResource({
    key: 'library:shelf:reading',
    fetcher: fetchShelf,
    keepPreviousData: true,
  });
  const shelf = shelfResource.data ?? [];
  const setShelf = useCallback((update: SetStateAction<LibraryItem[]>) => {
    shelfResource.mutate((previous) => {
      const value = previous ?? [];
      return typeof update === 'function'
        ? (update as (current: LibraryItem[]) => LibraryItem[])(value)
        : update;
    });
  }, [shelfResource.mutate]);

  useLibraryPdfCovers(items, updated => {
    setItems(previous => previous.map(item => item.id === updated.id ? { ...item, ...updated } : item));
    setShelf(previous => previous.map(item => item.id === updated.id ? { ...item, ...updated } : item));
  });

  // ── Poll non-terminal ingests (shared hook) ────────────────────────────────────
  const applyFresh = useCallback((fresh: LibraryItem[]) => {
    // Poll the complete library row so progress, covers and metadata arrive together.
    const byId = new Map(fresh.map((s) => [s.id, s]));
    setItems((prev) =>
      prev.map((it) => {
        const f = byId.get(it.id);
        return f ? { ...it, ...f } : it;
      }),
    );
    setShelf((prev) =>
      prev.map((it) => {
        const f = byId.get(it.id);
        return f ? { ...it, ...f } : it;
      }),
    );
  }, [setItems, setShelf]);
  useSourceStatus({
    items,
    fetchOne: async (id) => {
      try {
        return await getLibraryItem(id);
      } catch {
        return null;
      }
    },
    onUpdate: applyFresh,
  });

  // ── Deep link ?focus=<id> opens the details panel (chat citation / backlink) ──
  const focusParam = searchParams.get('focus');
  const consumedFocusRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusParam || consumedFocusRef.current === focusParam) return;
    consumedFocusRef.current = focusParam;
    setDetailId(focusParam);
    navigation.replace('/library', { scroll: false, track: false, viewOnly: true });
  }, [focusParam, navigation]);

  // ── Upload queue (sequential presign → POST → finalize) ────────────────────────
  const runUploads = useCallback(
    async (files: File[]) => {
      const accepted: { file: File; mime: SourceMime }[] = [];
      for (const file of files) {
        const mime = mimeForFile(file);
        if (!mime) {
          raiseToast({ kind: 'error', title: t('library.toast.unsupported') });
          continue;
        }
        accepted.push({ file, mime });
      }
      if (accepted.length === 0) return;
      for (let i = 0; i < accepted.length; i++) {
        const { file, mime } = accepted[i]!;
        setUploadQueue({ total: accepted.length, done: i, name: file.name });
        try {
          const created = await uploadLibraryItem(file, file.name, mime);
          setItems((prev) => [created, ...prev.filter((p) => p.id !== created.id)]);
        } catch (err) {
          if (err instanceof DuplicateSourceError) {
            // Offer to open the existing item rather than silently skipping.
            await confirmDuplicate(file.name, err.existingSourceId);
          } else if (err instanceof LibraryFullError) {
            raiseToast({ kind: 'error', title: t('library.toast.libraryFull') });
            break;
          } else {
            raiseToast({ kind: 'error', title: t('library.toast.uploadFailed') });
          }
        }
      }
      setUploadQueue(null);
      void refresh();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [uploadLibraryItem, t, refresh],
  );

  const confirmDuplicate = useCallback(
    async (title: string, existingId: string) => {
      const yes = await confirm({
        title: t('library.duplicate.title'),
        message: t('library.duplicate.message', { title }),
        confirmLabel: t('library.duplicate.open'),
        cancelLabel: t('library.duplicate.cancel'),
      });
      if (yes) setDetailId(existingId);
    },
    [confirm, t],
  );

  const onPickFiles = useCallback(() => {
    setAddMenuOpen(false);
    fileInputRef.current?.click();
  }, []);
  const onFilesChosen = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files ? Array.from(e.target.files) : [];
      if (e.target) e.target.value = '';
      if (files.length > 0) void runUploads(files);
    },
    [runUploads],
  );

  // Full-screen drag-and-drop.
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragActive(false);
      const files = e.dataTransfer?.files ? Array.from(e.dataTransfer.files) : [];
      if (files.length > 0) void runUploads(files);
    },
    [runUploads],
  );

  // ── Inline url/text add ─────────────────────────────────────────────────────────
  const onAddInline = useCallback(
    async (dialogKind: 'url' | 'text', title: string, value: string) => {
      try {
        const created =
          dialogKind === 'url'
            ? await addLibraryUrl(title, value)
            : await addLibraryText(title, value);
        setItems((prev) => [created, ...prev]);
        setAddDialog(null);
      } catch (err) {
        if (err instanceof LibraryFullError) {
          raiseToast({ kind: 'error', title: t('library.toast.libraryFull') });
        } else {
          raiseToast({ kind: 'error', title: t('library.add.failed') });
        }
      }
    },
    [addLibraryUrl, addLibraryText, t],
  );

  // ── Details panel data ──────────────────────────────────────────────────────────
  const onItemPatched = useCallback((updated: Partial<LibraryItem> & Pick<LibraryItem, 'id'>) => {
    setItems((prev) => prev.map((it) => (it.id === updated.id && (it.metadataRevision ?? 0) <= (updated.metadataRevision ?? it.metadataRevision ?? 0) ? { ...it, ...updated } : it)));
    setShelf((prev) => prev.map((it) => (it.id === updated.id && (it.metadataRevision ?? 0) <= (updated.metadataRevision ?? it.metadataRevision ?? 0) ? { ...it, ...updated } : it)));
  }, []);
  const onItemDeleted = useCallback((id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
    setShelf((prev) => prev.filter((it) => it.id !== id));
    setDetailId(null);
    raiseToast({ kind: 'info', title: t('library.toast.deleted') });
  }, [t]);

  const hasFilters = debouncedQ !== '' || kind !== 'all' || reading !== 'all';
  const clearFilters = useCallback(() => {
    setSearch('');
    setDebouncedQ('');
    setKind('all');
    setReading('all');
  }, [setSearch, setDebouncedQ, setKind, setReading]);

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <PageSurface ref={listPosition.ref} className="reomi-library"
      aria-busy={libraryResource.status === 'loading' || libraryResource.status === 'refreshing'}
      onDragOver={(e) => {
        if (e.dataTransfer?.types?.includes('Files')) {
          e.preventDefault();
          setDragActive(true);
        }
      }}
      onDragLeave={(e) => {
        // Only clear when leaving the screen, not on child transitions.
        if (e.currentTarget === e.target) setDragActive(false);
      }}
      onDrop={onDrop}
      style={{ position: 'relative' }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept=".pdf,.epub,application/pdf,application/epub+zip"
        multiple
        onChange={onFilesChosen}
        style={{ display: 'none' }}
      />

      {/* Drag overlay */}
      {dragActive && (
        <div className="nn-lib-drop-overlay">
          <div className="nn-lib-drop-inner">
            <NNIcon name="book" size={34} color="var(--lime-400)" />
            <span>{t('library.add.dropHint')}</span>
          </div>
        </div>
      )}

      {/* Header */}
      <LibraryHeader
        refreshing={libraryResource.status==='refreshing'}
        onReset={()=>{workspace?.resetView('library');setDebouncedQ('');navigation.replace('/library',{track:false});}}
        search={search}
        setSearch={setSearch}
        kind={kind}
        setKind={setKind}
        reading={reading}
        setReading={setReading}
        tag={tag}
        setTag={setTag}
        allTags={allTags}
        unattached={unattached}
        setUnattached={setUnattached}
        sort={sort}
        setSort={setSort}
        view={view}
        setView={setViewPersisted}
        searchMode={searchMode}
        setSearchMode={setSearchModePersisted}
        addMenuOpen={addMenuOpen}
        setAddMenuOpen={setAddMenuOpen}
        onPickFiles={onPickFiles}
        onAddUrl={() => {
          setAddMenuOpen(false);
          setAddDialog('url');
        }}
        onAddText={() => {
          setAddMenuOpen(false);
          setAddDialog('text');
        }}
        isMobile={isMobile}
        t={t}
      />

      <NavigationRestoreNotice failure={listPosition.failure} retry={listPosition.retry}/>
      {/* Upload progress strip */}
      {uploadQueue && (
        <div className="nn-lib-upload-strip">
          <NNIcon name="sync" size={14} color="var(--lime-400)" />
          <span>{t('library.add.uploadingFile', { name: uploadQueue.name })}</span>
          <span style={{ color: 'var(--text-dim)' }}>
            {t('library.add.uploadProgress', { done: uploadQueue.done + 1, total: uploadQueue.total })}
          </span>
        </div>
      )}


      {libraryResource.status === 'error' && (
        <div style={{ margin: '10px 0' }}>
          <NNLoadError
            title={t('toasts.error')}
            description={libraryResource.error?.safeMessage}
            retryLabel={t('notebooks.overview.retry')}
            requestId={libraryResource.error?.requestId}
            onRetry={refresh}
          />
        </div>
      )}

      {/* Continue reading shelf (hidden in content-search mode) */}
      {searchMode === 'title' && shelf.length > 0 && (
        <ContinueShelf items={shelf} onOpen={openReader} t={t} />
      )}

      {/* Content-search results take over the body when in content mode */}
      {searchMode === 'content' ? (
        <>
          {contentResource.status === 'error' && (
            <div style={{ margin: '10px 0' }}>
              <NNLoadError
                title={t('toasts.error')}
                description={contentResource.error?.safeMessage}
                retryLabel={t('notebooks.overview.retry')}
                requestId={contentResource.error?.requestId}
                onRetry={contentResource.refresh}
              />
            </div>
          )}
          {(contentResource.status !== 'error' || contentResult) && (
            <ContentSearchResults
              result={contentResult}
              loading={contentLoading}
              query={debouncedQ}
              onOpenHit={openHit}
              t={t}
            />
          )}
        </>
      ) : !loaded ? (
        <LibrarySkeleton view={view} />
      ) : items.length === 0 ? (
        hasFilters ? (
          <div className="nn-empty-state" style={{ paddingTop: 48 }}>
            <span className="nn-empty-state-icon"><NNIcon name="search" size={30} color="var(--text-dim)" /></span>
            <p className="nn-empty-state-hint">{t('library.empty.noResults')}</p>
            <NNBtn variant="soft" size="sm" onClick={clearFilters}>{t('library.empty.clearFilters')}</NNBtn>
          </div>
        ) : (
          <div className="nn-empty-state" style={{ paddingTop: 56 }}>
            <span className="nn-empty-state-icon"><NNIcon name="book" size={36} color="var(--text-dim)" /></span>
            <h3 className="nn-h1" style={{ fontSize: 22 }}>
              {t('library.empty.title')}
            </h3>
            <p className="nn-empty-state-hint" style={{ maxWidth: 320 }}>{t('library.empty.hint')}</p>
            <NNBtn variant="primary" size="sm" icon="plus" onClick={onPickFiles}>{t('library.empty.cta')}</NNBtn>
          </div>
        )
      ) : view === 'grid' ? (
        <div className="nn-lib-grid">
          {items.map((it) => (
            <LibraryCard key={it.id} item={it} onOpen={() => openReader(it.id)} onDetails={() => setDetailId(it.id)} t={t} />
          ))}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 12 }}>
          {items.map((it) => (
            <LibraryListRow key={it.id} item={it} onOpen={() => openReader(it.id)} onDetails={() => setDetailId(it.id)} t={t} />
          ))}
        </div>
      )}

      {/* Load more (added-sort keyset only; hidden in content-search mode) */}
      {searchMode === 'title' && loaded && nextCursor && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 20 }}>
          <NNBtn
            variant="soft"
            size="sm"
            onClick={async () => {
              try {
                const res = await listLibrary({ ...query, cursor: nextCursor });
                libraryResource.mutate((current) => ({
                  items: [...(current?.items ?? []), ...res.items],
                  nextCursor: res.nextCursor,
                }));
              } catch {
                /* ignore */
              }
            }}
          >
            {t('notebooks.reader.loadMore')}
          </NNBtn>
        </div>
      )}

      {/* Inline add dialog */}
      {addDialog && (
        <AddInlineDialog
          kind={addDialog}
          onSubmit={onAddInline}
          onClose={() => setAddDialog(null)}
          t={t}
        />
      )}

      {/* Details panel */}
      {detailId && (
        <DetailsPanel
          key={detailId}
          itemId={detailId}
          getLibraryItem={getLibraryItem}
          onClose={() => setDetailId(null)}
          onPatched={onItemPatched}
          onDeleted={onItemDeleted}
          confirm={confirm}
          prompt={prompt}
          edit={edit}
          onOpenNotebook={(id) => navigation.push(`/notebooks/${id}`)}
          onOpenReader={() => openReader(detailId)}
          isMobile={isMobile}
          t={t}
        />
      )}
    </PageSurface>
  );
};

// ── Header ──────────────────────────────────────────────────────────────────────

const LibraryHeader = ({
  refreshing,
  onReset,
  search,
  setSearch,
  kind,
  setKind,
  reading,
  setReading,
  tag,
  setTag,
  allTags,
  unattached,
  setUnattached,
  sort,
  setSort,
  view,
  setView,
  searchMode,
  setSearchMode,
  addMenuOpen,
  setAddMenuOpen,
  onPickFiles,
  onAddUrl,
  onAddText,
  isMobile,
  t,
}: {
  refreshing: boolean;
  onReset: () => void;
  search: string;
  setSearch: (v: string) => void;
  kind: KindFilter;
  setKind: (k: KindFilter) => void;
  reading: ReadingFilter;
  setReading: (r: ReadingFilter) => void;
  tag: string | null;
  setTag: (t: string | null) => void;
  allTags: string[];
  unattached: boolean;
  setUnattached: (v: boolean) => void;
  sort: SortMode;
  setSort: (s: SortMode) => void;
  view: ViewMode;
  setView: (v: ViewMode) => void;
  searchMode: 'title' | 'content';
  setSearchMode: (m: 'title' | 'content') => void;
  addMenuOpen: boolean;
  setAddMenuOpen: (v: boolean) => void;
  onPickFiles: () => void;
  onAddUrl: () => void;
  onAddText: () => void;
  isMobile: boolean;
  t: Tr;
}) => {
  const menuRoot = useRef<HTMLDivElement>(null);
  useTransientLayer({ root: menuRoot, enabled: addMenuOpen, onClose: () => setAddMenuOpen(false) });
  return (
  <div className="reomi-library-toolbar">
    {/* Search-mode toggle + search + add */}
    <div style={{ display: 'flex', alignItems: 'center', flexWrap:isMobile?'wrap':'nowrap',gap: 10 }}>
      <SegmentedControl label={t('library.header.searchPlaceholder')} value={searchMode}
        onChange={setSearchMode} options={[{ value: 'title', label: t('library.search.byTitle') }, { value: 'content', label: t('library.search.byContent') }]} />
      <AppLink className="reomi-button" data-variant="ghost" href="/library/study">{t('assistant.savedStudy')}</AppLink>
      <div style={{ position: 'relative', flex: isMobile?'1 0 100%':1,order:isMobile?1:undefined,minWidth: 0 }}>
        {refreshing&&<span style={{position:'absolute',right:10,top:'50%',transform:'translateY(-50%)',pointerEvents:'none'}}><NNInlineRefresh label={t('states.loading')}/></span>}
        <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
          <NNIcon name="search" size={15} color="var(--text-dim)" />
        </span>
        <TextInput
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t(searchMode === 'content' ? 'library.search.contentPlaceholder' : 'library.header.searchPlaceholder')}
          aria-label={t('library.header.searchPlaceholder')}
          style={{ paddingLeft: 32,paddingRight:100 }}
        />
      </div>
      <NNBtn variant="ghost" icon="sync" ariaLabel={t('navigation.reset')} title={t('navigation.reset')} onClick={onReset}/>
      <div ref={menuRoot} style={{ position: 'relative' }}>
        <NNBtn className="reomi-create-icon" variant="soft" icon="plus" ariaLabel={t('library.header.add')} title={t('library.header.add')} aria-expanded={addMenuOpen} onClick={event => { event.currentTarget.focus({ preventScroll: true }); setAddMenuOpen(!addMenuOpen); }} />
        {addMenuOpen && (
          <>
            <div role="group" aria-label={t('library.header.add')} className="nn-lib-menu" style={{ right: 0 }}>
              <button type="button" className="nn-lib-menu-item" onClick={onPickFiles}>
                <NNIcon name="book" size={14} color="var(--text-muted)" />{t('library.header.addFiles')}
              </button>
              <button type="button" className="nn-lib-menu-item" onClick={onAddUrl}>
                <NNIcon name="link" size={14} color="var(--text-muted)" />{t('library.header.addUrl')}
              </button>
              <button type="button" className="nn-lib-menu-item" onClick={onAddText}>
                <NNIcon name="edit" size={14} color="var(--text-muted)" />{t('library.header.addText')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>

    {searchMode === 'title' && (
      <div className="reomi-library-filters">
        <label><span>{t('library.header.formatLabel')}</span><select value={kind} onChange={event => setKind(event.target.value as typeof kind)}>
          {KIND_FILTERS.map(k => <option key={k} value={k}>{t(`library.header.kind${k === 'all' ? 'All' : k === 'pdf' ? 'Pdf' : k === 'epub' ? 'Epub' : k === 'url' ? 'Url' : 'Text'}`)}</option>)}
        </select></label>
        <label><span>{t('library.header.readingLabel')}</span><select value={reading} onChange={event => setReading(event.target.value as typeof reading)}>
          {READING_FILTERS.map(r => <option key={r} value={r}>{t(`library.header.reading${r === 'all' ? 'All' : r === 'unread' ? 'Unread' : r === 'reading' ? 'Reading' : 'Finished'}`)}</option>)}
        </select></label>
        {allTags.length > 0 && <label><span>{t('library.header.tagLabel')}</span><select value={tag ?? ''} onChange={event => setTag(event.target.value || null)}>
          <option value="">{t('library.header.tagAll')}</option>{allTags.map(value => <option key={value} value={value}>{value}</option>)}
        </select></label>}
        <button type="button" className="reomi-filter-toggle" aria-pressed={unattached} onClick={() => setUnattached(!unattached)}><NNIcon name="notebook" size={14} />{t('library.header.shelfUnattached')}</button>
        <label className="reomi-library-sort"><span>{t('library.header.sortLabel')}</span><select value={sort} onChange={event => setSort(event.target.value as SortMode)}>
          {SORTS.map(value => <option key={value} value={value}>{t(`library.header.sort${value === 'added' ? 'Added' : value === 'title' ? 'Title' : 'LastRead'}`)}</option>)}
        </select></label>
        <div className="reomi-library-views">
          <NNBtn variant={view === 'grid' ? 'soft' : 'ghost'} icon="grid" aria-pressed={view === 'grid'} ariaLabel={t('library.header.viewGrid')} title={t('library.header.viewGrid')} onClick={() => setView('grid')} />
          <NNBtn variant={view === 'list' ? 'soft' : 'ghost'} icon="stack" aria-pressed={view === 'list'} ariaLabel={t('library.header.viewList')} title={t('library.header.viewList')} onClick={() => setView('list')} />
        </div>
      </div>
    )}
  </div>
);
};

// ── Continue reading shelf ────────────────────────────────────────────────────

const ContinueShelf = ({ items, onOpen, t }: { items: LibraryItem[]; onOpen: (id: string) => void; t: Tr }) => (
  <div style={{ marginBottom: 18 }}>
    <h3 className="nn-section-label" style={{ margin: '0 0 8px' }}>
      {t('library.shelf.continueReading')}
    </h3>
    <div className="nn-scroll" style={{ display: 'flex', gap: 10, overflowX: 'auto', paddingBottom: 4 }}>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          onClick={() => onOpen(it.id)}
          className="nn-lib-shelf-card"
        >
          <CoverPlaceholder item={it} size={56} />
          <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {it.title}
            </div>
            {it.author && (
              <div style={{ fontSize: 11, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {it.author}
              </div>
            )}
            <div className="nn-lib-progress" style={{ marginTop: 6 }}>
              <div className="nn-lib-progress-fill" style={{ width: `${Math.round((it.percent ?? 0) * 100)}%` }} />
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 3 }}>
              {it.pageCount && it.percent != null
                ? t('library.shelf.page', { page: Math.max(1, Math.round(it.percent * it.pageCount)), total: it.pageCount })
                : t('library.shelf.percent', { percent: Math.round((it.percent ?? 0) * 100) })}
            </div>
          </div>
        </button>
      ))}
    </div>
  </div>
);

// ── Content (semantic) search results ─────────────────────────────────────────

const ContentSearchResults = ({
  result,
  loading,
  query,
  onOpenHit,
  t,
}: {
  result: LibrarySearchResult | null;
  loading: boolean;
  query: string;
  onOpenHit: (group: LibrarySearchGroup, hit: LibrarySearchHit) => void;
  t: Tr;
}) => {
  if (query.length < 3) {
    return (
      <div className="nn-empty-state" style={{ paddingTop: 48 }}>
        <span className="nn-empty-state-icon"><NNIcon name="search" size={30} color="var(--text-dim)" /></span>
        <p className="nn-empty-state-hint">{t('library.search.typeMore')}</p>
      </div>
    );
  }
  if (result?.reason === 'embedding_disabled') {
    return (
      <div className="nn-empty-state" style={{ paddingTop: 48 }}>
        <span className="nn-empty-state-icon"><NNIcon name="brain" size={28} color="var(--text-dim)" /></span>
        <p className="nn-empty-state-hint">{t('library.search.disabled')}</p>
      </div>
    );
  }
  if (loading && !result) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
        {Array.from({ length: 3 }).map((_, i) => (
          <NNSkeleton key={i} style={{ height: 80 }} />
        ))}
      </div>
    );
  }
  if (!result || result.groups.length === 0) {
    return (
      <div className="nn-empty-state" style={{ paddingTop: 48 }}>
        <span className="nn-empty-state-icon"><NNIcon name="search" size={30} color="var(--text-dim)" /></span>
        <p className="nn-empty-state-hint">{t('library.search.noResults')}</p>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 8 }}>
      {result.groups.map((g) => (
        <div key={g.source.id} className="nn-lib-search-group">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <div style={{ width: 34, flexShrink: 0 }}>
              <CoverPlaceholder item={{ id: g.source.id, title: g.source.title, kind: g.source.kind, coverUrl: g.source.coverUrl }} aspect />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {g.source.title}
              </div>
              {g.source.author && (
                <div style={{ fontSize: 11.5, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {g.source.author}
                </div>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {g.hits.map((h) => (
              <button
                key={h.sourceChunkId}
                type="button"
                onClick={() => onOpenHit(g, h)}
                className="nn-lib-search-hit"
              >
                <div style={{ fontSize: 11, color: 'var(--text-dim)', marginBottom: 2 }}>
                  {h.heading
                    ? h.heading
                    : h.page != null
                      ? t('library.search.hitPage', { page: h.page })
                      : t('library.search.hitChunk', { pos: h.position + 1 })}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                  {h.snippet}
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};

// ── Cover placeholder ─────────────────────────────────────────────────────────

const CoverPlaceholder = ({ item, size, aspect }: { item: LibraryItem | { id: string; title: string; kind: SourceKind; coverUrl?: string | null }; size?: number; aspect?: boolean }) => {
  const color = coverColor(item.id);
  // Render the real cover image when present; on a load error fall through to the
  // generated placeholder (state flips `failed` so the img is replaced).
  const [failed, setFailed] = useState(false);
  const coverUrl = 'coverUrl' in item ? item.coverUrl : null;
  useEffect(() => setFailed(false), [coverUrl]);
  const showImage = Boolean(coverUrl) && !failed;
  return (
    <div
      style={{
        width: size ?? '100%',
        aspectRatio: aspect ? '3 / 4' : undefined,
        height: aspect ? undefined : size,
        borderRadius: 'var(--r-md)',
        background: showImage
          ? 'var(--surface-3)'
          : `linear-gradient(135deg, color-mix(in srgb, ${color} 22%, var(--surface-3)), var(--surface-3))`,
        border: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        flexShrink: 0,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={coverUrl!}
          alt=""
          onError={() => setFailed(true)}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        <>
          <span style={{ fontSize: size && size <= 60 ? 16 : 26, fontWeight: 800, color, fontFamily: 'var(--font-sans)', letterSpacing: '0.02em' }}>
            {initials(item.title)}
          </span>
          <span style={{ position: 'absolute', bottom: 6, right: 6, opacity: 0.8 }}>
            <NNIcon name={kindIcon(item.kind)} size={size && size <= 60 ? 12 : 16} color={color} />
          </span>
        </>
      )}
    </div>
  );
};

// ── Grid card ─────────────────────────────────────────────────────────────────

const LibraryCard = ({ item, onOpen, onDetails, t }: { item: LibraryItem; onOpen: () => void; onDetails: () => void; t: Tr }) => {
  const notReady = item.status !== 'ready' && (item.total === 0 || item.status === 'deleting');
  const statusLabel = labelForStatus(item, t);
  return (
    <button type="button" data-navigation-anchor={item.id} onClick={onOpen} className="nn-lib-card">
      <div style={{ position: 'relative' }}>
        <CoverPlaceholder item={item} aspect />
        {['pending', 'parsing', 'indexing'].includes(item.status) && <LibraryIngestIndicator item={item} t={t} />}
        {notReady && !['pending', 'parsing', 'indexing'].includes(item.status) && (
          <span className="reomi-library-status" title={statusLabel}>
            <NNBadge tone={statusTone(item.status)} size="xs">{statusLabel}</NNBadge>
          </span>
        )}
        {/* Details (⋯) — stops propagation so the card click still opens the reader. */}
        <span
          role="button"
          tabIndex={0}
          aria-label={t('library.item.menu')}
          title={t('library.item.menu')}
          onClick={(e) => {
            e.stopPropagation();
            onDetails();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              e.stopPropagation();
              onDetails();
            }
          }}
          className="nn-lib-card-menu"
          style={{
            position: 'absolute',
            top: 6,
            right: 6,
            width: 26,
            height: 26,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 'var(--r-sm)',
            background: 'color-mix(in srgb, var(--surface) 80%, transparent)',
            border: '1px solid var(--border)',
            cursor: 'pointer',
          }}
        >
          <NNIcon name="dots" size={14} color="var(--text-muted)" />
        </span>
        {item.percent != null && item.percent > 0 && item.status === 'ready' && (
          <div className="nn-lib-progress" style={{ position: 'absolute', left: 6, right: 6, bottom: 6 }}>
            <div className="nn-lib-progress-fill" style={{ width: `${Math.round(item.percent * 100)}%` }} />
          </div>
        )}
      </div>
      <div style={{ padding: '8px 2px 2px', textAlign: 'left' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', lineHeight: 1.3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {item.title}
        </div>
        {item.author && (
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.author}
          </div>
        )}
        <div style={{ display: 'flex', gap: 5, marginTop: 6, flexWrap: 'wrap' }}>
          {item.notebookCount > 0 && (
            <NNBadge tone="neutral" size="xs">
              {item.notebookCount === 1 ? t('library.item.notebooksOne') : t('library.item.notebooks', { count: item.notebookCount })}
            </NNBadge>
          )}
          {item.cardCount > 0 && (
            <NNBadge tone="lime" size="xs">
              {item.cardCount === 1 ? t('library.item.cardsOne') : t('library.item.cards', { count: item.cardCount })}
            </NNBadge>
          )}
        </div>
      </div>
    </button>
  );
};

// ── List row ──────────────────────────────────────────────────────────────────

const LibraryListRow = ({ item, onOpen, onDetails, t }: { item: LibraryItem; onOpen: () => void; onDetails: () => void; t: Tr }) => {
  const notReady = item.status !== 'ready' && (item.total === 0 || item.status === 'deleting');
  return (
    <button type="button" data-navigation-anchor={item.id} onClick={onOpen} className="nn-lib-row">
      <CoverPlaceholder item={item} size={40} />
      <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.title}
        </div>
        {item.author && (
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {item.author}
          </div>
        )}
      </div>
      {item.notebookCount > 0 && (
        <NNBadge tone="neutral" size="xs">
          {item.notebookCount === 1 ? t('library.item.notebooksOne') : t('library.item.notebooks', { count: item.notebookCount })}
        </NNBadge>
      )}
      {item.cardCount > 0 && (
        <NNBadge tone="lime" size="xs">
          {item.cardCount === 1 ? t('library.item.cardsOne') : t('library.item.cards', { count: item.cardCount })}
        </NNBadge>
      )}
      {notReady && <NNBadge tone={statusTone(item.status)} size="xs">{labelForStatus(item, t)}</NNBadge>}
      {/* Details (⋯) — stops propagation so the row click still opens the reader. */}
      <span
        role="button"
        tabIndex={0}
        aria-label={t('library.item.menu')}
        title={t('library.item.menu')}
        onClick={(e) => {
          e.stopPropagation();
          onDetails();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            onDetails();
          }
        }}
        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 26, height: 26, borderRadius: 'var(--r-sm)', cursor: 'pointer' }}
      >
        <NNIcon name="dots" size={14} color="var(--text-dim)" />
      </span>
    </button>
  );
};

function labelForStatus(item: LibraryItem, t: Tr): string {
  const operationLabel = sourceOperationLabel(item, t);
  if (operationLabel) return operationLabel;
  if (item.status === 'error' && item.total > 0) return t('library.status.readable');
  if (item.status === 'error' && item.errorCode) {
    return t(`library.status.${item.errorCode as IngestErrorCode}`);
  }
  return t(`library.status.${item.status}`);
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

const LibrarySkeleton = ({ view }: { view: ViewMode }) =>
  view === 'grid' ? (
    <div className="nn-lib-grid">
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i}>
          <NNSkeleton style={{ aspectRatio: '3 / 4', borderRadius: 'var(--r-md)' }} />
          <NNSkeleton style={{ height: 12, marginTop: 8, width: '80%' }} />
        </div>
      ))}
    </div>
  ) : (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12 }}>
      {Array.from({ length: 6 }).map((_, i) => (
        <NNSkeleton key={i} style={{ height: 52 }} />
      ))}
    </div>
  );

// ── Inline add dialog (url / text) ────────────────────────────────────────────

const AddInlineDialog = ({
  kind,
  onSubmit,
  onClose,
  t,
}: {
  kind: 'url' | 'text';
  onSubmit: (kind: 'url' | 'text', title: string, value: string) => Promise<void>;
  onClose: () => void;
  t: Tr;
}) => {
  const [title, setTitle] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '8px 10px',
    fontSize: 13.5,
    fontFamily: 'var(--font-sans)',
    color: 'var(--text)',
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--r-md)',
    outline: 'none',
    boxSizing: 'border-box',
  };
  const labelStyle: React.CSSProperties = { fontSize: 11.5, fontWeight: 600, color: 'var(--text-dim)', marginBottom: 4, display: 'block' };
  const canSubmit = !busy && value.trim().length > 0;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    const fallback = title.trim() || (kind === 'url' ? value.trim() : t('library.add.textLabel'));
    await onSubmit(kind, fallback, kind === 'url' ? value.trim() : value);
    setBusy(false);
  };

  return (
    <>
      <div className="nn-dialog-backdrop" onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 80, background: 'var(--scrim)' }} />
      <div style={{ position: 'fixed', inset: 0, zIndex: 81, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, pointerEvents: 'none' }}>
        <NNCard padding={18} style={{ width: 420, maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: 12, pointerEvents: 'auto', boxShadow: 'var(--shadow-lg)' }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', margin: 0, fontFamily: 'var(--font-sans)' }}>
            {t(kind === 'url' ? 'library.add.urlTitle' : 'library.add.textTitle')}
          </h3>
          <div>
            <label style={labelStyle}>{t('library.add.titleLabel')}</label>
            <input style={inputStyle} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('library.add.titlePlaceholder')} maxLength={300} />
          </div>
          {kind === 'url' ? (
            <div>
              <label style={labelStyle}>{t('library.add.urlLabel')}</label>
              <input style={inputStyle} value={value} onChange={(e) => setValue(e.target.value)} placeholder={t('library.add.urlPlaceholder')} maxLength={2000} />
            </div>
          ) : (
            <div>
              <label style={labelStyle}>{t('library.add.textLabel')}</label>
              <textarea style={{ ...inputStyle, minHeight: 140, resize: 'vertical' }} value={value} onChange={(e) => setValue(e.target.value)} placeholder={t('library.add.textPlaceholder')} />
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <NNBtn variant="ghost" size="sm" onClick={onClose} disabled={busy}>{t('actions.cancel')}</NNBtn>
            <NNBtn variant="primary" size="sm" onClick={submit} disabled={!canSubmit}>
              {busy ? t('library.add.adding') : t('library.add.submit')}
            </NNBtn>
          </div>
        </NNCard>
      </div>
    </>
  );
};

// ── Details panel (slide-over) ────────────────────────────────────────────────

const DetailsPanel = ({
  itemId,
  getLibraryItem,
  onClose,
  onPatched,
  onDeleted,
  confirm,
  prompt,
  edit,
  onOpenNotebook,
  onOpenReader,
  isMobile,
  t,
}: {
  itemId: string;
  getLibraryItem: (id: string) => Promise<LibraryItemDetail>;
  onClose: () => void;
  onPatched: (item: Partial<LibraryItem> & Pick<LibraryItem, 'id'>) => void;
  onDeleted: (id: string) => void;
  confirm: ReturnType<typeof useDialog>['confirm'];
  prompt: ReturnType<typeof useDialog>['prompt'];
  edit: ReturnType<typeof useDialog>['edit'];
  onOpenNotebook: (id: string) => void;
  onOpenReader: () => void;
  isMobile: boolean;
  t: Tr;
}) => {
  const { select } = useDialog();
  const panelRef = useRef<HTMLDivElement>(null);
  const patchLibraryItem = useNN((s) => s.patchLibraryItem);
  const deleteLibraryItem = useNN((s) => s.deleteLibraryItem);
  const reingestLibraryItem = useNN((s) => s.reingestLibraryItem);
  const listNotebooks = useNN((s) => s.listNotebooks);
  const attachSources = useNN((s) => s.attachSources);

  const [detail, setDetail] = useState<LibraryItemDetail | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [tagDraft, setTagDraft] = useState('');
  const ownerId = useNN(state => state.profile?.userId) ?? '';
  const tagAction = useSmallAction(ownerId, tagDraft);
  const tagIntent = useRef<'add' | 'remove'>('add');
  const panelLayer = useTransientLayer({ root: panelRef, modal: true, onClose, busy: tagAction.busy });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const requestVersion = useRef(0);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const translateRef = useRef(t); translateRef.current = t;

  const reload = useCallback(async () => {
    const version = ++requestVersion.current;
    setLoadError(null);
    try {
      const d = await getLibraryItem(itemId);
      if (version !== requestVersion.current) return;
      setDetail(d);
    } catch (error) {
      if (version !== requestVersion.current) return;
      const failure = toApiError(error);
      if (failure.status === 404 || failure.status === 403) {
        raiseToast({ kind: 'info', title: translateRef.current('navigation.itemUnavailable') });
        closeRef.current();
      } else setLoadError(failure);
    } finally {
      if (version === requestVersion.current) setLoaded(true);
    }
  }, [getLibraryItem, itemId]);

  useEffect(() => {
    void reload();
    return () => { requestVersion.current++; };
  }, [reload]);
  useKnowledgeRefresh(reload);

  useSourceStatus({ items: detail ? [detail] : [], fetchOne: async () => {
    await reload(); return null;
  }, onUpdate: () => {} });

  const applyPatch = useCallback(
    async (patch: Parameters<typeof patchLibraryItem>[1]) => {
      try {
        const updated = await patchLibraryItem(itemId, patch);
        setDetail((prev) => (prev ? { ...prev, ...updated } : prev));
        onPatched(updated);
      } catch {
        raiseToast({ kind: 'error', title: t('library.details.saveFailed') });
      }
    },
    [patchLibraryItem, itemId, onPatched, t],
  );

  const editField = useCallback(async (field: 'title' | 'author' | 'description') => {
    if (!detail) return;
    await edit({ title: t(field === 'title' ? 'library.details.renameTitle' : field === 'author' ? 'library.details.authorTitle' : 'actionsRecovery.description'),
      defaultValue: detail[field] ?? '', path: `/sources/${itemId}`, revision: detail.metadataRevision ?? 0,
      maxLength: field === 'title' ? 300 : field === 'author' ? 500 : 2000, multiline: field === 'description', trim: field !== 'description',
      patch: value => ({ [field]: value }), validate: value => field === 'title' && !value.trim() ? ' ' : null,
      readCurrent: async () => { const current = await getLibraryItem(itemId); return { revision: current.metadataRevision ?? 0, value: current[field] ?? '' }; },
      onSaved: async result => {
        const row = result.result as LibraryItemDetail;
        const patch = { id: itemId, [field]: row[field], metadataRevision: row.metadataRevision };
        setDetail(current => current && (current.metadataRevision ?? 0) <= (row.metadataRevision ?? 0) ? { ...current, ...patch } : current); onPatched(patch);
      },
    });
  }, [detail, edit, t, itemId, getLibraryItem, onPatched]);
  const onRename = () => editField('title');
  const onEditAuthor = () => editField('author');

  const acceptTags = (accepted: Awaited<ReturnType<typeof tagAction.run>>) => {
    if (!accepted || useNN.getState().profile?.userId !== ownerId || !accepted.response.result) return;
    const row = accepted.response.result as LibraryItemDetail;
    const patch = { id: itemId, tags: row.tags, metadataRevision: row.metadataRevision };
    setDetail(current => current && (current.metadataRevision ?? 0) <= (row.metadataRevision ?? 0) ? { ...current, ...patch } : current); onPatched(patch);
    if (accepted.response.outcome === 'applied' && accepted.currentMatches && tagIntent.current === 'add') setTagDraft('');
  };
  const onAddTag = async () => {
    if (!detail || tagAction.busy || tagAction.uncertain) return;
    const tag = tagDraft.trim();
    if (!tag || detail.tags.includes(tag)) return;
    tagIntent.current = 'add';
    acceptTags(await tagAction.run(`/sources/${itemId}`, { expectedRevision: detail.metadataRevision ?? 0, patch: { tags: [...detail.tags, tag] } }));
  };
  const onRemoveTag = async (tag: string) => {
    if (!detail || tagAction.busy || tagAction.uncertain) return;
    tagIntent.current = 'remove';
    acceptTags(await tagAction.run(`/sources/${itemId}`, { expectedRevision: detail.metadataRevision ?? 0, patch: { tags: detail.tags.filter(item => item !== tag) } }));
  };

  useNavigationGuard(async () => {
    if (tagAction.busy) return false;
    if (!tagDraft.trim() && !tagAction.snapshot.pending) return true;
    const choice = await select({ title: t('editor.draft.leaveTitle'), message: tagAction.snapshot.pending ? t('actionsRecovery.uncertainClose') : undefined,
      value: 'save', options: [{ value: 'save', label: t('editor.draft.saveAndLeave') }, { value: 'discard', label: t('editor.draft.discardAndLeave') }], cancelLabel: t('editor.draft.stay') });
    if (choice === 'discard') return true;
    if (choice !== 'save' || !detail) return false;
    const accepted = tagAction.uncertain ? await tagAction.retry() : await tagAction.run(`/sources/${itemId}`, {
      expectedRevision: detail.metadataRevision ?? 0, patch: { tags: [...new Set([...detail.tags, tagDraft.trim()])].filter(Boolean) },
    });
    acceptTags(accepted);
    return Boolean(accepted?.currentMatches && accepted.response.outcome === 'applied');
  }, panelLayer.id);

  const onDelete = useCallback(async () => {
    if (!detail) return;
    const yes = await confirm({
      title: t('library.delete.title'),
      message:
        detail.notebookCount > 0
          ? t('library.delete.messageAttached', { count: detail.notebookCount })
          : t('library.delete.message'),
      danger: true,
      confirmLabel: t('library.delete.confirm'),
    });
    if (!yes) return;
    try {
      await deleteLibraryItem(itemId);
      onDeleted(itemId);
    } catch {
      raiseToast({ kind: 'error', title: t('library.details.saveFailed') });
    }
  }, [detail, confirm, t, deleteLibraryItem, itemId, onDeleted]);

  const onReingest = useCallback(async () => {
    if (!detail) return;
    const yes = await confirm({
      title: t('library.reingest.title'),
      message:
        detail.kind === 'url'
          ? t('library.reingest.messageUrl')
          : t('library.reingest.message'),
      confirmLabel: t('library.reingest.confirm'),
    });
    if (!yes) return;
    try {
      await reingestLibraryItem(itemId);
      raiseToast({ kind: 'info', title: t('library.reingest.started') });
      // Reflect the pending status immediately; the poll effect tracks it to ready.
      setDetail((prev) => (prev ? { ...prev, status: 'pending', errorCode: null } : prev));
      void reload();
    } catch {
      raiseToast({ kind: 'error', title: t('library.reingest.failed') });
    }
  }, [detail, confirm, t, reingestLibraryItem, itemId, reload]);

  const detailPosition = useNavigationScroll('library', 'details', {ready:loaded&&Boolean(detail),queryKey:itemId});

  const onAttached = useCallback(() => {
    setPickerOpen(false);
    void reload();
    raiseToast({ kind: 'info', title: t('library.details.addedToNotebook') });
  }, [reload, t]);

  return (
    <>
      <div className="nn-dialog-backdrop" onClick={() => void panelLayer.close('outside')} style={{ position: 'fixed', inset: 0, zIndex: 70, background: 'var(--scrim)' }} />
      <div
        ref={node => { panelRef.current = node; detailPosition.ref(node); }}
        role="dialog" aria-modal="true" aria-label={detail?.title ?? t('nav.library')} tabIndex={-1}
        className="nn-scroll"
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: isMobile ? '100%' : 420,
          maxWidth: '100%',
          zIndex: 71,
          background: 'var(--surface)',
          borderLeft: '1px solid var(--border)',
          boxShadow: 'var(--shadow-lg)',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, background: 'var(--surface)', zIndex: 1 }}>
          <span className="nn-section-label" style={{ margin: 0, flex: 1 }}>
            {t('library.details.title')}
          </span>
          <NNBtn variant="ghost" size="sm" icon="x" ariaLabel={t('library.details.close')} title={t('library.details.close')} onClick={() => void panelLayer.close()} />
        </div>

        {loadError && <NNLoadError title={t('navigation.loadFailed')} description={loadError.safeMessage} requestId={loadError.requestId} retryLabel={t('navigation.retry')} onRetry={() => void reload()} />}
        {loadError && !detail ? null : !loaded || !detail ? (
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <NNSkeleton style={{ height: 120 }} />
            <NNSkeleton style={{ height: 16, width: '70%' }} />
            <NNSkeleton style={{ height: 14, width: '50%' }} />
          </div>
        ) : (
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Cover + title */}
            <div style={{ display: 'flex', gap: 14 }}>
              <div style={{ width: 96, flexShrink: 0 }}>
                <CoverPlaceholder item={detail} aspect />
              </div>
              <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', lineHeight: 1.3, fontFamily: 'var(--font-sans)' }}>
                  {detail.title}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
                  {detail.author || t('library.details.authorPlaceholder')}
                </div>
                {detail.status !== 'ready' && (
                  <div style={{ marginTop: 4 }}>
                    <NNBadge tone={detail.total > 0 && detail.status === 'error' ? 'neutral' : statusTone(detail.status)} size="xs">{labelForStatus(detail, t)}</NNBadge>
                    {['error', 'indexing'].includes(detail.status) && detail.total > 0 && <p style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>{t(detail.status === 'error' ? 'library.status.index_failed' : 'library.status.indexWaiting')}</p>}
                  </div>
                )}
              </div>
            </div>

            {/* Quick actions */}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <NNBtn variant="primary" size="sm" icon="book" onClick={onOpenReader}>{t('library.details.read')}</NNBtn>
              <NNBtn variant="soft" size="sm" icon="edit" onClick={onRename}>{t('library.details.rename')}</NNBtn>
              <NNBtn variant="soft" size="sm" onClick={onEditAuthor}>{t('library.details.editAuthor')}</NNBtn>
              <NNBtn variant="soft" size="sm" onClick={() => void editField('description')}>{t('actionsRecovery.description')}</NNBtn>
              <NNBtn variant="soft" size="sm" icon="plus" onClick={() => setPickerOpen(true)}>{t('library.details.addToNotebook')}</NNBtn>
            </div>

            {/* Reading status */}
            <div>
              <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-dim)', marginBottom: 6, display: 'block' }}>
                {t('library.details.readingStatus')}
              </label>
              <div style={{ display: 'flex', gap: 4 }}>
                {(['unread', 'reading', 'finished'] as ReadingStatus[]).map((rs) => (
                  <button
                    key={rs}
                    type="button"
                    onClick={() => applyPatch({ readingStatus: rs })}
                    className={`nn-lib-chip${detail.readingStatus === rs ? ' active' : ''}`}
                  >
                    {t(`library.header.reading${rs === 'unread' ? 'Unread' : rs === 'reading' ? 'Reading' : 'Finished'}`)}
                  </button>
                ))}
              </div>
            </div>

            {/* Tags */}
            <div>
              <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-dim)', marginBottom: 6, display: 'block' }}>
                {t('library.details.tags')}
              </label>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 6 }}>
                {detail.tags.map((tag) => (
                  <span key={tag} className="nn-lib-tag">
                    {tag}
                    <button type="button" disabled={tagAction.busy || tagAction.uncertain} onClick={() => void onRemoveTag(tag)} aria-label={t('actions.delete')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', display: 'inline-flex', padding: 0 }}>
                      <NNIcon name="x" size={11} />
                    </button>
                  </span>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  value={tagDraft}
                  onChange={(e) => setTagDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void onAddTag();
                    }
                  }}
                  placeholder={t('library.details.tagsPlaceholder')}
                  maxLength={64}
                  style={{
                    flex: 1,
                    height: 30,
                    padding: '0 10px',
                    fontSize: 12.5,
                    fontFamily: 'var(--font-sans)',
                    color: 'var(--text)',
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--r-sm)',
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
                <NNBtn variant="soft" size="sm" onClick={onAddTag} disabled={!tagDraft.trim() || tagAction.busy || tagAction.uncertain}>{t('library.details.addTag')}</NNBtn>
              </div>
              <SaveFeedback status={tagAction.snapshot.status} errorCode={tagAction.snapshot.error} onRetry={() => { void tagAction.retry().then(acceptTags); }} />
              {tagAction.snapshot.status === 'conflict' && <NNBtn size="sm" onClick={() => { void reload().then(() => tagAction.controller.resolveConflict()); }}>{t('actionsRecovery.current')}</NNBtn>}
            </div>

            {/* Notebooks */}
            <div>
              <label style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-dim)', marginBottom: 6, display: 'block' }}>
                {t('library.details.notebooks')}
              </label>
              {detail.notebooks.length === 0 ? (
                <p style={{ fontSize: 12.5, color: 'var(--text-dim)', margin: 0 }}>{t('library.details.notebooksEmpty')}</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {detail.notebooks.map((nb) => (
                    <button
                      key={nb.id}
                      type="button"
                      onClick={() => onOpenNotebook(nb.id)}
                      className="nn-lib-nb-link"
                    >
                      <NNIcon name="doc" size={13} color="var(--text-muted)" />
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{nb.title}</span>
                      <NNIcon name="chevr" size={11} color="var(--text-dim)" />
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Cards count */}
            {detail.cardCount > 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {t('library.details.cardsCount', { count: detail.cardCount })}
              </div>
            )}

            {/* Reingest (non-text, terminal status) + Delete */}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              {detail.kind !== 'text' && (detail.status === 'ready' || detail.status === 'error') && (
                <NNBtn variant="soft" size="sm" icon="sync" onClick={() => void onReingest()}>
                  {t('library.reingest.action')}
                </NNBtn>
              )}
              <NNBtn variant="danger" size="sm" icon="x" onClick={onDelete}>{t('library.details.delete')}</NNBtn>
            </div>
          </div>
        )}

        {/* Notebook picker overlay */}
        {pickerOpen && detail && (
          <NotebookAttachPicker
            sourceId={detail.id}
            attachedIds={new Set(detail.notebooks.map((n) => n.id))}
            listNotebooks={listNotebooks}
            attachSources={attachSources}
            onAttached={onAttached}
            onClose={() => setPickerOpen(false)}
            t={t}
          />
        )}
      </div>
    </>
  );
};

// ── Notebook picker (attach one source from the details panel) ─────────────────

const NotebookAttachPicker = ({
  sourceId,
  attachedIds,
  listNotebooks,
  attachSources,
  onAttached,
  onClose,
  t,
}: {
  sourceId: string;
  attachedIds: Set<string>;
  listNotebooks: () => Promise<Notebook[]>;
  attachSources: (notebookId: string, sourceIds: string[]) => Promise<void>;
  onAttached: () => void;
  onClose: () => void;
  t: Tr;
}) => {
  const [notebooks, setNotebooks] = useState<Notebook[] | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        setNotebooks(await listNotebooks());
      } catch {
        setNotebooks([]);
      }
    })();
  }, [listNotebooks]);

  const attach = useCallback(
    async (nbId: string) => {
      if (busy) return;
      setBusy(true);
      try {
        await attachSources(nbId, [sourceId]);
        onAttached();
      } catch {
        raiseToast({ kind: 'error', title: t('library.details.saveFailed') });
      } finally {
        setBusy(false);
      }
    },
    [busy, attachSources, sourceId, onAttached, t],
  );

  return (
    <>
      <div className="nn-dialog-backdrop" onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'var(--scrim)' }} />
      <div style={{ position: 'fixed', inset: 0, zIndex: 91, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, pointerEvents: 'none' }}>
        <NNCard padding={16} style={{ width: 380, maxWidth: '100%', display: 'flex', flexDirection: 'column', gap: 10, pointerEvents: 'auto', maxHeight: '70vh', boxShadow: 'var(--shadow-lg)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', margin: 0, flex: 1, fontFamily: 'var(--font-sans)' }}>{t('library.details.pickNotebook')}</h3>
            <NNBtn variant="ghost" size="sm" icon="x" ariaLabel={t('library.details.close')} onClick={onClose} />
          </div>
          {notebooks === null ? (
            <NNSkeleton style={{ height: 80 }} />
          ) : notebooks.length === 0 ? (
            <p style={{ fontSize: 12.5, color: 'var(--text-dim)', margin: 0 }}>{t('library.details.pickNotebookEmpty')}</p>
          ) : (
            <div className="nn-scroll" style={{ display: 'flex', flexDirection: 'column', gap: 3, overflowY: 'auto' }}>
              {notebooks.map((nb) => {
                const already = attachedIds.has(nb.id);
                return (
                  <button
                    key={nb.id}
                    type="button"
                    disabled={already || busy}
                    onClick={() => attach(nb.id)}
                    className="nn-lib-nb-link"
                    style={{ opacity: already ? 0.55 : 1, cursor: already ? 'default' : 'pointer' }}
                  >
                    <NNIcon name="doc" size={13} color="var(--text-muted)" />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>{nb.title}</span>
                    {already && <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{t('library.details.alreadyIn')}</span>}
                  </button>
                );
              })}
            </div>
          )}
        </NNCard>
      </div>
    </>
  );
};

export { CoverPlaceholder };
