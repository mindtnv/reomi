'use client';

import { restoreLayerFocus, LayerParent, useTransientLayer } from '@/lib/use-transient-layer';

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAppNavigation, useNavigationWorkspace, useWorkspaceState, NavigationReturn } from '@/components/navigation';
import { format } from 'date-fns';
import {
  buildCardPredicate,
  parseCardQuery,
  CardQueryError,
  stateLabel,
  type CardLike,
} from '@reomi/shared';
import { NNBtn, NNBadge, NNTag, NNIcon, NNLoadError, NNSkeleton } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { TextInput } from '@/components/design-system/primitives';
import { CardActionsMenu, type CardMenuAction } from '@/components/card-actions-menu';
import { ResizeHandle } from '@/components/design-system/resize-handle';
import { CARD_FILTERS, boundedPanelWidth, readCardFiltersWidth } from '@/lib/panel-width';
import { writeBrowserValue } from '@/lib/storage-migration';
import { CardColumnPicker } from '@/components/card-column-picker';
import { CARD_COLUMNS, defaultCardColumns, readCardColumns, saveCardColumns, cardTableMinWidth, type SortField } from '@/lib/card-columns';
import { CardsViewSwitcher } from '@/components/cards-view-switcher';
import { raiseToast } from '@/components/toasts';
import { NoteConversionDialog } from '@/components/note-conversion';
import { NNTopbar } from '@/components/shell';
import { cardCreationDeck } from '@/lib/card-creation-deck';
import { CardDetailPanel } from '@/components/card-detail-panel';

import { RENDER_KIND_BADGE_TONE } from '@/lib/source-kind';
import { useNN } from '@/lib/store';
import type { Card } from '@/lib/types';
import { useBreakpoint } from '@/lib/use-breakpoint';
import { useT, useDateLocale } from '@/lib/i18n';
import { useDialog } from '@/components/dialog';
import {
  buildDeckTree,
  deckPathLabel,
  flattenTree,
  getDescendantIds,
} from '@/lib/decks';
import { addOrReplaceToken, toggleToken, tokenizeQuery } from '@/lib/card-query-ui';
import { toApiError } from '@/lib/resource-state';
import { api, ok, type ApiError } from '@/lib/api';
import { cardFromApi } from '@/lib/mappers';
import { studyDateIso } from '@/lib/study-date';
import { setDueStateGroups } from '@/lib/set-due-preview';

const DEFAULT_CARDS_PAGE = 500;

// Sort keys map: UI column → server `sort` field (the part before the direction).
type SortDir = 'asc' | 'desc';

const STATE_CHIPS: { value: string; labelKey: string }[] = [
  { value: 'is:new', labelKey: 'cards.states.new' },
  { value: 'is:learn', labelKey: 'cards.states.learning' },
  { value: 'is:review', labelKey: 'cards.states.review' },
  { value: 'is:due', labelKey: 'cards.states.due' },
  { value: 'is:suspended', labelKey: 'cards.states.suspended' },
];

const stateTone: Record<string, BadgeTone> = {
  new: 'sky',
  learning: 'amber',
  review: 'lime',
  relearning: 'rose',
};

/**
 * Build the structural CardLike the shared predicate operates over from the
 * STORED server render columns + the embedded note/noteType (must-fix #5: the
 * predicate consumes the server-rendered text VERBATIM and NEVER re-renders or
 * re-strips cloze).
 */
function toCardLike(card: Card): CardLike {
  return {
    renderText: card.renderText,
    renderFrontText: card.renderFrontText,
    renderBackText: card.renderBackText,
    fieldValues: card.note?.fieldValues ?? {},
    noteTypeKind: card.renderKind,
    noteTypeName: card.noteType?.name ?? card.renderKind,
    templateOrd: card.templateOrd,
    tags: card.tags,
    deckId: card.deckId,
    state: stateLabel(card.fsrs.state),
    suspended: card.suspended,
    due: new Date(card.fsrs.due).getTime(),
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    lapses: card.fsrs.lapses ?? 0,
    reps: card.fsrs.reps ?? 0,
    stability: card.fsrs.stability ?? 0,
    difficulty: card.fsrs.difficulty ?? 0,
    scheduledDays: card.fsrs.scheduled_days ?? 0,
  };
}

function truncate(s: string, n = 90): string {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean;
}

import { useNavigationScroll, NavigationRestoreNotice } from '@/lib/use-navigation-scroll';
import { restoreCollectionPages } from '@/lib/navigation-restore';

export const NNCardsBrowser = () => {
  const t = useT();
  const { confirm, prompt, select, alert } = useDialog();
  const dateLocale = useDateLocale();
  const bp = useBreakpoint();
  const isMobile = bp === 'mobile';
  const [columnIds, setColumnIds] = useState(() => defaultCardColumns(isMobile));
  useLayoutEffect(() => { setColumnIds(readCardColumns(isMobile)); }, [isMobile]);
  const changeColumns = (ids: string[]) => { setColumnIds(ids); saveCardColumns(ids, isMobile); };

  const router = useAppNavigation();
  const searchParams = useSearchParams();
  const navigationWorkspace = useNavigationWorkspace();
  const navigationEntry = navigationWorkspace?.entry?.id;

  const cards = useNN((s) => s.cards);
  const decks = useNN((s) => s.decks);
  const cardTags = useNN((s) => s.cardTags);
  const bootstrapped = useNN((s) => s.bootstrapped);
  const noteTypes = useNN((s) => s.noteTypes);
  const searchCards = useNN((s) => s.searchCards);
  const bulkCards = useNN((s) => s.bulkCards);
  const refetchCard = useNN((s) => s.refetchCard);
  const getCardTags = useNN((s) => s.getCardTags);

  // Query string: URL `?q=` is the source of truth, mirrored into local state
  // for instant typing (URL writes are debounced).
  const noteTypeScope = searchParams.get('noteTypeId') ?? undefined;
  const conversionTarget = searchParams.get('convertTo') ?? undefined;
  const [conversionCards, setConversionCards] = useState<Card[] | null>(null);
  const urlQ = searchParams.get('q') ?? '';
  const [query, setQuery] = useWorkspaceState('cards', 'query', urlQ);

  const [sortField, setSortField] = useWorkspaceState<SortField>('cards', 'sortField', 'created');
  const [sortDir, setSortDir] = useWorkspaceState<SortDir>('cards', 'sortDir', 'desc');

  // Hybrid completeness signal (must-fix #4): server results for the current `q`.
  const [serverResults, setServerResults] = useState<Card[] | null>(null);
  const [serverQ, setServerQ] = useState<string | null>(null);
  const [serverKey, setServerKey] = useState<string | null>(null);
  useEffect(() => {
    searchGeneration.current += 1;
    loadMoreGeneration.current += 1;
    const current = new Map(useNN.getState().cards.map((card) => [card.id, card]));
    setServerResults((previous) => previous === null ? previous
      : previous.flatMap((card) => { const fresh = current.get(card.id); return fresh ? [fresh] : []; }));
    setServerKey(null);
  }, [noteTypes]);
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Honest pagination: the cursor for the NEXT server page (null = no more rows).
  const [serverCursor, setServerCursor] = useState<string | null>(null);
  // Surface transport failures instead of silently sitting on stale local rows.
  const [serverError, setServerError] = useState<ApiError | null>(null);

  // Two decoupled intents (must-fix: stop conflating look / edit-one / bulk):
  //  • `selected` (checkboxes / Ctrl+Shift-click) → drives the contextual actions.
  //  • `focusedId` (plain row click) → the single card shown in the bottom edit dock.
  const bulkLock = useRef(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [actionMenu, setActionMenu] = useState<{ x: number; y: number; anchor: HTMLElement } | null>(null);
  const closeActions = useCallback((restoreFocus: boolean) => {
    if (restoreFocus) restoreLayerFocus(actionMenu?.anchor);
    setActionMenu(null);
  }, [actionMenu]);
  const lastClickedRef = useRef<string | null>(null);
  const [focusedId, setFocusedId] = useWorkspaceState<string | null>('cards', 'focusedId', null);
  const [resolvedFocus,setResolvedFocus]=useState<{id:string;entryId?:string}|null>(null);
  const [focusError, setFocusError] = useState<ApiError | null>(null);
  const [focusAttempt, setFocusAttempt] = useState(0);



  const workspaceRef = useRef<HTMLDivElement>(null);
  const [filtersPreferredWidth, setFiltersPreferredWidth] = useState<number>(CARD_FILTERS.default);
  const [workspaceWidth, setWorkspaceWidth] = useState(1200);
  useLayoutEffect(() => {
    setFiltersPreferredWidth(readCardFiltersWidth());
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const measure = () => { if (workspace.clientWidth) setWorkspaceWidth(workspace.clientWidth); };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(workspace);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  const filtersMaxWidth = Math.min(CARD_FILTERS.max, Math.max(CARD_FILTERS.min, workspaceWidth - 400));
  const filtersWidth = boundedPanelWidth(filtersPreferredWidth, CARD_FILTERS.min, filtersMaxWidth, CARD_FILTERS.default);
  const resizeFilters = (value: number) => {
    const next = boundedPanelWidth(value, CARD_FILTERS.min, filtersMaxWidth, CARD_FILTERS.default);
    setFiltersPreferredWidth(next);
    try { writeBrowserValue(localStorage, CARD_FILTERS.key, String(next)); } catch {}
  };

  const [sidebarOpen, setSidebarOpen] = useState(false); // mobile drawer
  const filterDrawer = useRef<HTMLElement>(null);
  const filterLayer = useTransientLayer({ root: filterDrawer, enabled: isMobile && sidebarOpen, modal: true, onClose: () => setSidebarOpen(false) });
  useEffect(() => { if (isMobile && sidebarOpen) filterDrawer.current?.focus({ preventScroll: true }); }, [isMobile, sidebarOpen]);
  const [filtersVisible, setFiltersVisible] = useWorkspaceState('cards', 'filtersVisible', true);

  const urlWriteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const serverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queryRef = useRef(query);
  const searchGeneration = useRef(0);
  const loadMoreGeneration = useRef(0);
  const loadingMoreRef = useRef(false);

  const invalidatePendingSearches = useCallback(() => {
    searchGeneration.current += 1;
    loadMoreGeneration.current += 1;
    loadingMoreRef.current = false;
    setSearching(false);
    setLoadingMore(false);
  }, []);

  useEffect(() => { invalidatePendingSearches(); setSelected(new Set()); setServerKey(null); }, [noteTypeScope, invalidatePendingSearches]);

  // Fetch the distinct tag universe once on mount (C3 — not from the ≤500 mirror).
  useEffect(() => {
    void getCardTags().catch(() => {});
  }, [getCardTags]);

  const previousUrl = useRef({ entry: navigationEntry, q: urlQ });
  // Keep local query in sync when the URL changes externally (deck drill-in,
  // back/forward). Clear transient selection before the new entry paints.
  useLayoutEffect(() => {
    const previous = previousUrl.current;
    previousUrl.current = {entry:navigationEntry,q:urlQ};
    if (previous.entry !== navigationEntry) {
      invalidatePendingSearches(); setSelected(new Set()); setActionMenu(null); setServerKey(null);
      queryRef.current = query;
      return;
    }
    if (previous.q === urlQ || queryRef.current === urlQ) return;
    invalidatePendingSearches();
    setServerError(null);
    setSearching(true);
    queryRef.current = urlQ;
    setQuery(urlQ);
    setSelected(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlQ, navigationEntry]);

  // Deep links must resolve beyond the bootstrap page, with a visible error.

  const focusParam = searchParams.get('focus');
  const focusTarget = focusParam ?? focusedId;
  useEffect(() => {
    if (!focusTarget || !bootstrapped) return;
    // Consuming ?focus keeps the mounted editor and its draft. The target was
    // just validated in this entry; a second loading cycle would unmount it.
    if (!focusParam && resolvedFocus?.id === focusTarget && resolvedFocus.entryId === navigationEntry) return;
    let active = true;
    setFocusError(null);setResolvedFocus(null);
    void (async () => {
      try {
        const card = cardFromApi(await ok(await api.cards({ id: focusTarget }).get()));
        if(card.id!==focusTarget)throw new Error('Unexpected card response');
        if (!active) return;
        useNN.setState((state) => ({ cards: [...state.cards.filter((c) => c.id !== card.id), card] }));
        if (focusedId !== card.id && !(await router.confirmLeave())) return;
        if (!active) return;
        setFocusedId(card.id);setResolvedFocus({id:card.id,entryId:navigationEntry});
        if (!focusParam) return;
        const params = new URLSearchParams(Array.from(searchParams.entries()));
        params.delete('focus');
        const qs = params.toString();
        router.replace(qs ? `/cards?${qs}` : '/cards', { track: false, viewOnly:true });
      } catch (error) {
        if (active) {
          const failure=toApiError(error);setFocusError(failure);
          if(failure.status===404||failure.status===403){
            setFocusedId(null);setResolvedFocus(null);
            if(focusParam){const params=new URLSearchParams(searchParams.toString());params.delete('focus');router.replace(`/cards${params.size?`?${params}`:''}`,{track:false,viewOnly:true});}
          }
        }
      }
    })();
    return () => { active = false; };
  }, [focusTarget, focusParam, bootstrapped, focusAttempt, navigationEntry]);

  // Resolve a deck NAME (or path) to its id + descendants for the predicate.
  const resolveDeckIds = useCallback(
    (value: string, nested: boolean): string[] => {
      const target = value.trim().toLowerCase();
      if (!target) return [];
      // Match by name OR by full path label (e.g. "Languages / French").
      const matches = decks.filter((d) => {
        if (d.name.toLowerCase() === target) return true;
        return deckPathLabel(decks, d.id).toLowerCase() === target;
      });
      const ids = new Set<string>();
      for (const d of matches) {
        ids.add(d.id);
        if (nested) for (const id of getDescendantIds(decks, d.id)) ids.add(id);
      }
      return [...ids];
    },
    [decks],
  );

  // Parse the query → predicate. CardQueryError surfaces as an inline hint.
  const { predicate, queryError } = useMemo(() => {
    try {
      const ast = parseCardQuery(query);
      return {
        predicate: buildCardPredicate(ast, { now: Date.now(), resolveDeckIds }),
        queryError: null as string | null,
      };
    } catch (err) {
      const msg = err instanceof CardQueryError ? err.message : String(err);
      // On error, match nothing — but keep the previous render stable-ish.
      return { predicate: () => true, queryError: msg };
    }
  }, [query, resolveDeckIds]);

  // Client-side filtered + sorted view over the mirror (instant type-ahead).
  const clientFiltered = useMemo(() => {
    if (queryError) return [] as Card[];
    const out = cards.filter((c) => (!noteTypeScope || c.noteType?.id === noteTypeScope) && predicate(toCardLike(c)));
    return sortCards(out, sortField, sortDir);
  }, [cards, predicate, queryError, sortField, sortDir, noteTypeScope]);

  const sortStr = `${sortField} ${sortDir}`;
  const currentSearchKey = `${query}\u0000${sortStr}\u0000${noteTypeScope ?? ''}`;

  // True when the displayed rows are the authoritative server result set for the
  // current query (vs the provisional client mirror).
  const serverActive = serverResults !== null && serverKey === currentSearchKey;

  // Provisional whenever the mirror can be truncated OR no matching authoritative
  // response has completed yet. A previous authoritative result stays visible
  // while the matching query refreshes.
  const provisional = cards.length >= DEFAULT_CARDS_PAGE || !serverActive;

  // Once an authoritative result exists, retain it across query/sort refreshes.
  // The client mirror is only the cold-start fallback before the first response.
  const rows = useMemo(() => {
    if (serverResults !== null) {
      return sortCards(serverResults, sortField, sortDir);
    }
    return clientFiltered;
  }, [serverResults, clientFiltered, sortField, sortDir]);

  // More server pages exist beyond what's shown → render an honest "Load more"
  // and an "N+" count instead of silently capping at the page size.
  const hasMore = serverActive && serverCursor !== null;

  const runServerSearch = useCallback(
    async (q: string) => {
      const requestKey = `${q}\u0000${sortStr}\u0000${noteTypeScope ?? ''}`;
      const generation = ++searchGeneration.current;
      // A fresh authoritative search supersedes any pagination append in flight.
      loadMoreGeneration.current += 1;
      loadingMoreRef.current = false;
      setLoadingMore(false);
      setSearching(true);
      setServerError(null);
      try {
        const { items, nextCursor } = await searchCards(q, { sort: sortStr, noteTypeId: noteTypeScope });
        if (generation !== searchGeneration.current) return;
        setServerResults(items);
        setSelected((previous) => new Set([...previous].filter((id) => items.some((card) => card.id === id))));
        setServerQ(q);
        setServerKey(requestKey);
        setServerCursor(nextCursor);
      } catch (err) {
        if (generation !== searchGeneration.current) return;
        console.error('searchCards failed', err);
        setServerError(toApiError(err));
      } finally {
        if (generation === searchGeneration.current) setSearching(false);
      }
    },
    [searchCards, sortStr, noteTypeScope],
  );

  const restoreRows = useCallback(async (anchor: import('@/lib/navigation-context').ScrollAnchor, signal: AbortSignal) => {
    if (!serverActive || serverResults === null) return 'missing' as const;
    const generation = searchGeneration.current;
    const result = await restoreCollectionPages({throughId:anchor.endId,initial:{items:serverResults,nextCursor:serverCursor},
      anchors:[anchor.id,...(anchor.nearby??[])].filter((id):id is string=>Boolean(id)),signal,
      fetchPage:cursor=>searchCards(query,{sort:sortStr,cursor,noteTypeId:noteTypeScope})});
    if (!signal.aborted && generation === searchGeneration.current) {setServerResults(result.items);setServerCursor(result.nextCursor);}
    return result.reason;
  },[serverActive,serverResults,serverCursor,searchCards,query,sortStr,noteTypeScope]);
  const tablePosition = useNavigationScroll('cards','table',{ready:serverActive&&!searching,queryKey:currentSearchKey,restoreRows});
  const filterPosition = useNavigationScroll('cards','filters',{ready:bootstrapped});

  const latestSearch = useRef(runServerSearch);
  latestSearch.current = runServerSearch;

  // Honest "Load more": fetch the next page from the cursor and APPEND it to the
  // displayed server results (no silent truncation at the 500-row cap).
  const loadMore = useCallback(async () => {
    if (!serverCursor || serverQ === null || serverKey !== currentSearchKey) return;
    if (loadingMoreRef.current) return;
    const generation = ++loadMoreGeneration.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    setServerError(null);
    try {
      const { items, nextCursor } = await searchCards(serverQ, {
        sort: sortStr,
        cursor: serverCursor,
        noteTypeId: noteTypeScope,
      });
      if (generation !== loadMoreGeneration.current) return;
      setServerResults((prev) => {
        const base = prev ?? [];
        const byId = new Map(base.map((c) => [c.id, c]));
        for (const c of items) byId.set(c.id, c);
        return [...byId.values()];
      });
      setServerCursor(nextCursor);
    } catch (err) {
      if (generation !== loadMoreGeneration.current) return;
      console.error('searchCards (load more) failed', err);
      setServerError(toApiError(err));
    } finally {
      if (generation === loadMoreGeneration.current) {
        loadingMoreRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [currentSearchKey, searchCards, serverCursor, serverKey, serverQ, sortStr, noteTypeScope]);

  // Auto-fire the debounced server search whenever results are provisional for
  // the current query (and the query is parseable).
  useEffect(() => {
    if (queryError) {
      setSearching(false);
      return;
    }
    if (serverActive) return;
    if (serverTimer.current) clearTimeout(serverTimer.current);
    setSearching(true);
    serverTimer.current = setTimeout(() => {
      void runServerSearch(query);
    }, 300);
    return () => {
      if (serverTimer.current) clearTimeout(serverTimer.current);
    };
  }, [query, queryError, runServerSearch, serverActive]);

  // Debounced write of the query into the URL (?q=).
  const writeUrl = useCallback(
    (q: string) => {
      if (urlWriteTimer.current) clearTimeout(urlWriteTimer.current);
      urlWriteTimer.current = setTimeout(() => {
        const params = new URLSearchParams(Array.from(searchParams.entries()));
        if (q) params.set('q', q);
        else params.delete('q');
        const qs = params.toString();
        router.replace(qs ? `/cards?${qs}` : '/cards', { track: false, viewOnly:true });
      }, 250);
    },
    [router, searchParams],
  );

  const onQueryChange = (q: string) => {
    invalidatePendingSearches();
    queryRef.current = q;
    setQuery(q);
    setSelected(new Set());
    // Keep the previous authoritative rows mounted while the new query resolves.
    setSearching(true);
    setServerError(null);
    writeUrl(q);
  };

  const onQueryEnter = () => {
    if (urlWriteTimer.current) clearTimeout(urlWriteTimer.current);
    if (serverTimer.current) clearTimeout(serverTimer.current);
    const params = new URLSearchParams(Array.from(searchParams.entries()));
    if (query) params.set('q', query);
    else params.delete('q');
    const qs = params.toString();
    router.replace(qs ? `/cards?${qs}` : '/cards', { track: false, viewOnly:true });
    if (!queryError) void runServerSearch(query);
  };

  // Sidebar token insertion.
  const applyToken = (key: string, value: string) => {
    onQueryChange(addOrReplaceToken(query, key, value));
    if (isMobile) setSidebarOpen(false);
  };
  const applyChip = (token: string) => {
    onQueryChange(toggleToken(query, token));
    if (isMobile) setSidebarOpen(false);
  };

  // Header click toggles sort (same column flips dir; new column resets to its
  // natural direction — text asc, everything else desc).
  const onSortClick = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir(field === 'front' ? 'asc' : 'desc');
    }
    // A sort change refreshes server authority without blanking the table.
    invalidatePendingSearches();
    setSearching(true);
    setServerError(null);
  };

  const changeFocused = async (id: string | null) => {
    if (id === focusedId) return;
    if (await router.confirmLeave()) setFocusedId(id);
  };

  // Row click. Three distinct intents:
  //  • Shift+click   → range-add to `selected` (bulk), leaves the dock untouched.
  //  • Ctrl/Cmd+click → toggle `id` in `selected` (bulk), leaves the dock untouched.
  //  • plain click   → open the detail panel on this card (`focusedId`); never
  //                    touches `selected`, so a single look never raises the bulk bar.
  const onRowSelect = (id: string, e: React.MouseEvent) => {
    if ((e.shiftKey || e.metaKey || e.ctrlKey) && (!serverActive || searching || bulkBusy)) return;
    if (e.shiftKey && lastClickedRef.current) {
      setSelected((prev) => {
        const next = new Set(prev);
        const ids = rows.map((c) => c.id);
        const a = ids.indexOf(lastClickedRef.current!);
        const b = ids.indexOf(id);
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let i = lo; i <= hi; i++) next.add(ids[i]!);
        }
        return next;
      });
    } else if (e.metaKey || e.ctrlKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    } else {
      void changeFocused(id);
    }
    lastClickedRef.current = id;
  };

  const toggleCheckbox = (id: string) => {
    if (!serverActive || searching || bulkBusy) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    lastClickedRef.current = id;
  };

  // The focused card drives the card detail panel (resolved from the live mirror
  // so saves/edits reflect without a manual refetch).
  const focusedCard = useMemo(
    () => (focusedId&&resolvedFocus?.id===focusedId&&resolvedFocus.entryId===navigationEntry ? cards.find((c) => c.id === focusedId) ?? null : null),
    [focusedId, cards, resolvedFocus, navigationEntry],
  );

  // prev/next walk the CURRENT filtered+sorted result list, moving the dock focus.
  const movePanel = (delta: 1 | -1) => {
    if (!focusedCard) return;
    const ids = rows.map((c) => c.id);
    const idx = ids.indexOf(focusedCard.id);
    if (idx === -1) return;
    const nextIdx = idx + delta;
    if (nextIdx < 0 || nextIdx >= ids.length) return;
    const nextId = ids[nextIdx]!;
    void changeFocused(nextId);
    lastClickedRef.current = nextId;
  };

  // Close the dock with Escape (only while it's open). Bound globally so it works
  // regardless of where focus sits inside the dock.
  useEffect(() => {
    if (!focusedId || isMobile) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // A dialog / command-palette / cheatsheet that consumed Escape calls
      // preventDefault — don't also tear down the dock behind it.
      if (e.defaultPrevented) return;
      // Escape inside a dock field should not nuke an in-progress edit.
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
      void changeFocused(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusedId, isMobile]);

  const actionsUnavailable = bulkBusy || searching || !serverActive;
  useEffect(() => { setActionMenu(null); }, [searching, serverActive, query, noteTypeScope]);
  const openActions = (anchor: HTMLElement, point?: { x: number; y: number }, cardId?: string) => {
    if (actionsUnavailable) return;
    if (cardId && !selected.has(cardId)) setSelected(new Set([cardId]));
    const rect = anchor.getBoundingClientRect();
    setActionMenu({ anchor, x: point?.x ?? rect.left, y: point?.y ?? rect.bottom });
  };

  // Capture the selection once; a whole scheduling batch is one server write.
  const performBulk = async (operation: (ids: string[]) => Promise<void>) => {
    if (bulkLock.current || selected.size === 0 || !serverActive || searching) return;

    const ids = [...selected];
    if (ids.length > 1000) { setBulkError(true); return; }
    bulkLock.current = true;
    setBulkBusy(true);
    setBulkError(false);
    try {
      await operation(ids);
    } catch {
      setBulkError(true);
    } finally {
      bulkLock.current = false;
      setBulkBusy(false);
      // Refresh even after an ambiguous network failure; never leave a stale
      // table after the server may have committed a mutation.
      void latestSearch.current(queryRef.current);
    }
  };

  const runBulk = (action: 'move' | 'delete' | 'suspend' | 'unsuspend' | 'addTag' | 'removeTag') => performBulk(async (ids) => {
    if (action === 'delete') {
      if (!(await confirm({ title: t('cards.bulk.deleteConfirm', { n: ids.length }), danger: true }))) return;
      await bulkCards('delete', ids);
      setSelected(new Set());
    } else if (action === 'move') {
      const deckId = await select<string>({ title: t('cards.bulk.movePrompt'), options: decks.map((deck) => ({ value: deck.id, label: deckPathLabel(decks, deck.id) })) });
      if (deckId) await bulkCards('move', ids, { deckId });
    } else if (action === 'addTag' || action === 'removeTag') {
      const available = action === 'addTag' ? await getCardTags()
        : [...new Set(rows.filter(card => ids.includes(card.id)).flatMap(card => card.tags))];
      if (!available.length) { await alert({ title: t('cards.bulk.noTags') }); return; }
      const tag = await select<string>({ title: t(action === 'addTag' ? 'cards.bulk.addTag' : 'cards.bulk.removeTag'),
        searchable: true, options: available.slice().sort((a,b) => a.localeCompare(b)).map(value => ({ value, label: `#${value}` })) });
      if (tag !== null) { await bulkCards(action, ids, { tag }); await getCardTags(); }
    } else await bulkCards(action, ids);
  });

  const runForget = () => performBulk(async (ids) => {
    if (await confirm({ title: t('cards.actions.forgetConfirm', { n: ids.length }), danger: true })) await bulkCards('forget', ids);
  });

  const runSetDue = () => performBulk(async (ids) => {
    const selectedIds = new Set(ids);
    const groups = setDueStateGroups(rows.filter((card) => selectedIds.has(card.id)).map((card) => stateLabel(card.fsrs.state)));
    const message = [
      groups.includes('new') ? t('cards.actions.setDueNew') : null,
      groups.includes('learning') ? t('cards.actions.setDueLearning') : null,
      groups.includes('review') ? t('cards.actions.setDueReview') : null,
    ].filter((line) => line !== null).join('\n');
    const value = await prompt({
      title: t('cards.actions.setDueTitle'), inputType: 'date',
      message: message || undefined,
      defaultValue: new Date().toISOString().slice(0, 10),
      validate: (value) => studyDateIso(value) ? null : t('cards.actions.invalidDate'),
    });
    const iso = value ? studyDateIso(value) : null;
    if (iso) await bulkCards('setDue', ids, { setDue: iso });
  });

  const fmtDate = (ms: number) => {
    if (!ms) return '—';
    const d = new Date(ms);
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return format(d, sameYear ? 'MMM d' : 'MMM d, yyyy', { locale: dateLocale });
  };

  const visibleColumns = CARD_COLUMNS.filter(c => columnIds.includes(c.id));
  const tableMinWidth = cardTableMinWidth(visibleColumns) + 40;
  const gridTemplate = `28px 32px ${visibleColumns.map((c) => c.width).join(' ')}`;

  const selectedCards = rows.filter(card => selected.has(card.id));
  const cardActions: CardMenuAction[] = [
    ...(selectedCards.length === 1 ? [{ label: t('cards.panel.edit'), icon: 'edit', run: () => { void changeFocused(selectedCards[0].id); } }] : []),
    { label: t('noteTypes.convert.open'), icon: 'card-type', run: () => {
      if (focusedId) { void alert({ title: t('noteTypes.convert.closeEditor') }); return; }
      setConversionCards(selectedCards);
    } },
    { label: t('cards.bulk.move'), icon: 'stack', run: () => { void runBulk('move'); } },
    { label: t('cards.bulk.addTag'), icon: 'tag', run: () => { void runBulk('addTag'); } },
    { label: t('cards.bulk.removeTag'), icon: 'x', run: () => { void runBulk('removeTag'); } },
    ...(selectedCards.some(card => !card.suspended) ? [{ label: t('cards.bulk.suspend'), icon: 'pause', run: () => { void runBulk('suspend'); } }] : []),
    ...(selectedCards.some(card => card.suspended) ? [{ label: t('cards.bulk.unsuspend'), icon: 'play', run: () => { void runBulk('unsuspend'); } }] : []),
    { label: t('cards.actions.setDue'), icon: 'clock', run: () => { void runSetDue(); } },
    { label: t('cards.actions.forget'), icon: 'sync', run: () => { void runForget(); } },
    { label: t('cards.bulk.delete'), icon: 'x', danger: true, run: () => { void runBulk('delete'); } },
  ].map(action => ({ ...action, disabled: actionsUnavailable }));

  const loading = !bootstrapped;
  const emptyResults = !loading && !searching && serverActive && rows.length === 0 && !serverError && !queryError;

  // ── render ──────────────────────────────────────────────────────────────────

  const creationDeck = cardCreationDeck(query, decks);
  const createCard = async () => {
    router.push(creationDeck ? `/editor?deck=${encodeURIComponent(creationDeck.id)}` : '/editor');
  };

  const sidebar = (
    <Sidebar
      decks={decks}
      tags={cardTags}
      onDeck={(name) => applyToken('deck', name)}
      onTag={(tag) => applyToken('tag', tag)}
      onChip={applyChip}
      onAll={() => onQueryChange('')}
      activeQuery={query}
    />
  );

  return (
    <>
    <NNTopbar title={t('cards.title')} actions={<NNBtn className="reomi-create-icon" variant="soft" icon="plus"
      ariaLabel={t('topbar.newCard')} title={creationDeck ? t('cards.createInDeck', { name: creationDeck.name }) : t('topbar.newCard')}
      onClick={() => void createCard()} />} />
    <div ref={workspaceRef} className="reomi-cards-workspace" style={{ '--cards-filters-width': `${filtersWidth}px` } as React.CSSProperties} data-filters={!isMobile && filtersVisible ? 'open' : 'closed'}>
      {/* Query bar */}
      <div className="reomi-cards-toolbar">
        <NNBtn size="md" variant={(isMobile ? sidebarOpen : filtersVisible) ? 'soft' : 'ghost'} icon="filter"
          ariaLabel={t('cards.sidebar.filters')}
          title={t('cards.sidebar.filters')}
          aria-expanded={isMobile ? sidebarOpen : filtersVisible}
          onClick={() => isMobile ? setSidebarOpen(true) : setFiltersVisible(value => !value)}
        />
        <CardsViewSwitcher />
        <div className="reomi-cards-search">
          <span style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
            <NNIcon name="search" size={16} color="var(--text-dim)" />
          </span>
          <TextInput
            aria-label={t('cards.search.placeholder')}
            aria-invalid={Boolean(queryError) || undefined}
            aria-describedby={queryError ? 'cards-query-error' : undefined}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                onQueryEnter();
              }
            }}
            placeholder={t('cards.search.placeholder')}
            style={{ paddingLeft: 34 }}
          />
        </div>
        {!focusedCard && <NavigationReturn/>}
        <NNBtn size="sm" variant="ghost" ariaLabel={t('navigation.reset')} onClick={async()=>{
          if (!(await router.confirmLeave())) return;
          navigationWorkspace?.resetView('cards'); setSelected(new Set());
          queryRef.current=''; if(urlWriteTimer.current)clearTimeout(urlWriteTimer.current);
          router.replace('/cards',{track:false,viewOnly:true});
        }}>{t('navigation.reset')}</NNBtn>
        <CardColumnPicker selected={columnIds} onChange={changeColumns} onReset={() => changeColumns(defaultCardColumns(isMobile))} />
        <NNBtn variant="ghost" icon="clock" onClick={() => router.push('/editor?drafts=1')}
          title={t('editor.draft.libraryTitle')} ariaLabel={t('editor.draft.libraryTitle')} />
        <NNBtn
          className="reomi-note-types-entry"
          size="md"
          variant="ghost"
          icon="card-type"
          onClick={() => router.push('/note-types')}
          title={t('noteTypes.pageTitle')}
          ariaLabel={t('noteTypes.pageTitle')}
        />
      </div>

      {/* Filters belong to the cards workspace, not the global navigation. */}
      {!isMobile && filtersVisible && (
        <aside className="reomi-cards-filters" aria-label={t('cards.sidebar.filters')}>
          <div ref={filterPosition.ref} className="reomi-cards-filters-scroll nn-scroll">{sidebar}</div>
          <ResizeHandle edge="right" label={t('cards.sidebar.resize')} width={filtersWidth} min={CARD_FILTERS.min} max={filtersMaxWidth} defaultWidth={CARD_FILTERS.default} onChange={resizeFilters} />
        </aside>
      )}

      {isMobile && sidebarOpen && (
        <div
          onClick={() => void filterLayer.close()}
          style={{ position: 'fixed', inset: 0, background: 'var(--scrim)', zIndex: 40 }}
        >
          <aside ref={filterDrawer} role="dialog" aria-modal="true" aria-label={t('cards.sidebar.filters')} tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              bottom: 0,
              width: 260,
              background: 'var(--surface)',
              borderRight: '1px solid var(--border)',
              overflow: 'auto',
              zIndex: 41,
            }}
          >
            <LayerParent.Provider value={filterLayer.id}>{sidebar}</LayerParent.Provider>
          </aside>
        </div>
      )}

      {/* Main column */}
      <div
        className="reomi-cards-main"
        aria-busy={searching || loadingMore}
        style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0 }}
      >
        {conversionCards && <NoteConversionDialog cards={conversionCards} targetTypeId={conversionTarget} onClose={() => { setConversionCards(null); void latestSearch.current(queryRef.current); }} onConverted={(converted) => {
          const notes = new Set(converted.map((card) => card.noteId));
          setServerResults((previous) => previous === null ? previous : [...previous.filter((card) => !notes.has(card.noteId)),
            ...converted.filter((card) => (!noteTypeScope || card.noteType?.id === noteTypeScope) && predicate(toCardLike(card)))]);
          raiseToast({ kind: 'success', title: t('noteTypes.convert.done', { n: notes.size }) });
          setConversionCards(null); setSelected(new Set()); void latestSearch.current(queryRef.current);
        }} />}
        {(noteTypeScope || conversionTarget) && <div role="status" style={{ padding: 12, fontSize: 13, borderBottom: '1px solid var(--border)' }}>
          {t(noteTypeScope ? conversionTarget ? 'noteTypes.convert.selectionHint' : 'noteTypes.convert.sourceHint' : 'noteTypes.convert.targetHint', { source: noteTypes.find((type) => type.id === noteTypeScope)?.name ?? '', target: noteTypes.find((type) => type.id === conversionTarget)?.name ?? '' })}
          <NNBtn size="sm" variant="ghost" onClick={() => { const params = new URLSearchParams(searchParams.toString()); params.delete('noteTypeId'); params.delete('convertTo'); router.replace(`/cards?${params.toString()}`, { track: false, viewOnly:true }); }}>{t('noteTypes.convert.clearScope')}</NNBtn>
        </div>}
        {/* Status line: result count / provisional / error */}
        <div className="reomi-cards-status"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '6px 16px',
            borderTop: '1px solid var(--panel-edge)',
            fontSize: 11.5,
            color: 'var(--text-dim)',
            flexShrink: 0,
            minHeight: 32,
            order: 10,
          }}
        >
          {queryError ? (
            <span id="cards-query-error" role="alert" style={{ color: 'var(--rose-400)' }}>{queryError}</span>
          ) : (
            <>
              <span>
                {hasMore
                  ? t('cards.search.resultCountMore', { n: rows.length })
                  : t('cards.search.resultCount', { n: rows.length })}
              </span>
              {searching && <span>{t('cards.search.searching')}</span>}
              {!searching && serverError && (
                <span style={{ color: 'var(--rose-400)' }}>{t('cards.search.serverError')}</span>
              )}
              {!searching && !serverError && provisional && !serverActive && (
                <NNBadge tone="amber" size="xs">{t('cards.search.localResults')}</NNBadge>
              )}
            </>
          )}
          {!isMobile && <span className="reomi-cards-query-help" title={t('cards.search.help')}>{t('cards.search.help')}</span>}
        </div>

        {bulkError && <div role="alert" style={{ padding: 12, fontSize: 13, color: 'var(--rose-400)' }}>
          {t(selected.size > 1000 ? 'cards.bulk.tooMany' : 'cards.bulk.failed')}
        </div>}
        <NavigationRestoreNotice failure={tablePosition.failure} retry={tablePosition.retry}/>
        {focusError && <NNLoadError title={t('editor.errors.loadFailed')} description={t(focusError.status === 404 ? 'editor.errors.notFound' : 'review.loadFailedBody')}
          retryLabel={t('review.retry')} onRetry={() => setFocusAttempt((n) => n + 1)} requestId={focusError.requestId} />}

        {/* Body: the table ALWAYS spans the full width — neither the bottom edit
            dock nor the floating bulk pill reformats or clips it. */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0, flexDirection: 'column' }}>
          {/* Table */}
          <div ref={tablePosition.ref} className="reomi-cards-table-scroll" tabIndex={0} aria-label={t('cards.title')} style={{ flex: 1, overflow: 'auto', minWidth: 0 }}>
            <div className="reomi-cards-table" data-empty={emptyResults || undefined} style={{ minWidth: emptyResults ? 0 : tableMinWidth, width: '100%' }}>
            {/* Header */}
            <div className="reomi-cards-table-header"
              style={{
                display: emptyResults ? 'none' : 'grid',
                gridTemplateColumns: gridTemplate,
                gap: 8,
                padding: '8px 14px',
                borderBottom: '1px solid var(--border)',
                position: 'sticky',
                top: 0,
                background: 'var(--surface)',
                zIndex: 1,
                fontSize: 10.5,
                fontWeight: 600,
                color: 'var(--text-dim)',
                textTransform: 'uppercase',
                letterSpacing: 0.8,
              }}
            >
              <span />
              <span />
              {visibleColumns.map((col) => {
                const active = col.sort && col.sort === sortField;
                return (
                  <button
                    key={col.id}
                    type="button"
                    onClick={() => col.sort && onSortClick(col.sort)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      padding: 0,
                      cursor: col.sort ? 'pointer' : 'default',
                      color: active ? 'var(--text)' : 'var(--text-dim)',
                      font: 'inherit',
                      textTransform: 'uppercase',
                      letterSpacing: 0.8,
                      textAlign: col.align ?? 'left',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 3,
                      justifyContent: col.align === 'right' ? 'flex-end' : 'flex-start',
                    }}
                  >
                    {t(col.labelKey)}
                    {active && <span aria-hidden style={{ fontSize: 9 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>}
                  </button>
                );
              })}
            </div>

            {/* Rows */}
            {loading || (rows.length === 0 && !serverActive && !serverError && !queryError) ? (
              <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {Array.from({ length: 8 }).map((_, i) => (
                  <NNSkeleton key={i} height={34} />
                ))}
              </div>
            ) : rows.length === 0 && serverError && !serverActive ? (
              <div style={{ padding: 16 }}>
                <NNLoadError
                  title={t('cards.search.serverError')}
                  retryLabel={t('notebooks.overview.retry')}
                  onRetry={() => void runServerSearch(query)}
                  requestId={serverError.requestId}
                />
              </div>
            ) : rows.length === 0 && queryError ? (
              <div role="alert" style={{ padding: 24, color: 'var(--rose-400)', fontSize: 13 }}>
                {queryError}
              </div>
            ) : rows.length === 0 ? (
              <div className="reomi-cards-empty" role="status">
                <span className="reomi-cards-empty-icon"><NNIcon name={query.trim() ? 'search' : 'cards'} size={26}/></span>
                <h2>{t(query.trim() ? 'cards.empty.title' : 'cards.empty.collectionTitle')}</h2>
                <p>{creationDeck ? t('cards.empty.deckHint', { name: creationDeck.name }) : t('cards.empty.subtitle')}</p>
                <div className="reomi-cards-empty-actions">
                  <NNBtn variant="primary" icon="plus" onClick={() => void createCard()}>{t('topbar.newCard')}</NNBtn>
                  {query.trim() && <NNBtn variant="soft" onClick={() => onQueryChange('')}>{t('cards.empty.clearSearch')}</NNBtn>}
                </div>
              </div>
            ) : (
              rows.map((card) => {
                // Two independent visual states: `isFocused` = open in the dock
                // (strong cue + left accent); `isChecked` = in the bulk selection
                // (subtle tint). They can coexist.
                const isFocused = focusedId === card.id;
                const isChecked = selected.has(card.id);
                // Resting background precedence: focused > checked > none.
                const restBg = isFocused
                  ? 'var(--surface-3)'
                  : isChecked
                    ? 'var(--surface-2)'
                    : 'transparent';
                const sLabel = stateLabel(card.fsrs.state);
                // Table reads the STORED server render columns (plaintext, tags +
                // cloze already stripped) — NO client HTML render / re-strip here
                // (perf + safety, must-fix #5).
                const q = card.renderFrontText;
                const a = card.renderBackText;
                return (
                  <div
                    key={card.id}
                    data-card-row={card.id}
                    data-navigation-anchor={card.id}
                    tabIndex={0}
                    onContextMenu={event => {
                      event.preventDefault();
                      openActions(event.currentTarget, { x: event.clientX, y: event.clientY }, card.id);
                    }}
                    onKeyDown={event => {
                      if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                        event.preventDefault(); event.stopPropagation();
                        openActions(event.currentTarget, undefined, card.id);
                      } else if (event.key === 'Enter' && event.target === event.currentTarget) {
                        event.preventDefault(); void changeFocused(card.id);
                      }
                    }}
                    onClick={(e) => onRowSelect(card.id, e)}
                    onMouseEnter={(e) => {
                      if (!isFocused) (e.currentTarget as HTMLDivElement).style.background = 'var(--surface-2)';
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLDivElement).style.background = restBg;
                    }}
                    onMouseDown={(e) => {
                      // Pressed tint is uniform across rows. React re-applies the
                      // `style` prop each render, so this imperative background is
                      // reset on the next render (e.g. focus / selection change).
                      (e.currentTarget as HTMLDivElement).style.background = 'var(--surface-3)';
                      (e.currentTarget as HTMLDivElement).style.transform = 'translateY(0.5px)';
                    }}
                    onMouseUp={(e) => {
                      (e.currentTarget as HTMLDivElement).style.background = isFocused ? 'var(--surface-3)' : 'var(--surface-2)';
                      (e.currentTarget as HTMLDivElement).style.transform = '';
                    }}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: gridTemplate,
                      gap: 8,
                      padding: '9px 14px',
                      borderBottom: '1px solid var(--border)',
                      alignItems: 'center',
                      cursor: 'pointer',
                      background: restBg,
                      // Strong left accent marks the card currently open in the dock.
                      boxShadow: isFocused ? 'inset 2px 0 0 var(--accent-500)' : undefined,
                      opacity: card.suspended ? 0.55 : 1,
                      fontSize: 12.5,
                    }}
                  >
                    <span onClick={(e) => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center' }}>
                      <input
                        type="checkbox"
                        aria-label={t('cards.actions.selectCard', { title: truncate(q, 60) })}
                        disabled={actionsUnavailable}
                        checked={isChecked}
                        onChange={() => toggleCheckbox(card.id)}
                        style={{ cursor: 'pointer' }}
                      />
                    </span>
                    <button type="button" className="reomi-card-row-actions" aria-haspopup="menu"
                      aria-label={t('cards.actions.forCard', { title: truncate(q, 60) })}
                      title={t('cards.actions.open')} disabled={actionsUnavailable}
                      onClick={event => { event.stopPropagation(); openActions(event.currentTarget, undefined, card.id); }}>
                      <NNIcon name="dots" size={16} />
                    </button>
                    {visibleColumns.map((col) => (
                      <span
                        key={col.id}
                        style={{
                          textAlign: col.align ?? 'left',
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: col.id === 'tags' ? 'normal' : 'nowrap',
                          color: 'var(--text)',
                        }}
                      >
                        {col.id === 'question' && (
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            {card.suspended && <NNBadge tone="rose" size="xs">{t('cards.states.suspended')}</NNBadge>}
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{truncate(q)}</span>
                          </span>
                        )}
                        {col.id === 'answer' && <span style={{ color: 'var(--text-muted)' }}>{truncate(a)}</span>}
                        {col.id === 'deck' && (
                          <span style={{ color: 'var(--text-muted)' }}>{deckPathLabel(decks, card.deckId) || '—'}</span>
                        )}
                        {col.id === 'variant' && <NNBadge tone={RENDER_KIND_BADGE_TONE[card.renderKind] ?? 'neutral'} size="xs">{card.renderKind}</NNBadge>}
                        {col.id === 'state' && (
                          <NNBadge tone={stateTone[sLabel] ?? 'neutral'} size="xs">{t(`cards.states.${sLabel}`)}</NNBadge>
                        )}
                        {col.id === 'due' && <span className="mono" style={{ color: 'var(--text-muted)' }}>{fmtDate(new Date(card.fsrs.due).getTime())}</span>}
                        {col.id === 'lapses' && <span className="mono" style={{ color: card.fsrs.lapses ? 'var(--rose-400)' : 'var(--text-dim)' }}>{card.fsrs.lapses ?? 0}</span>}
                        {col.id === 'tags' && (
                          <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 4 }}>
                            {card.tags.length === 0
                              ? <span style={{ color: 'var(--text-dim)' }}>—</span>
                              : card.tags.slice(0, 3).map((tag, i) => <NNTag key={`${tag}-${i}`} color="sky">{tag}</NNTag>)}
                            {card.tags.length > 3 && <span style={{ color: 'var(--text-dim)' }}>+{card.tags.length - 3}</span>}
                          </span>
                        )}
                        {col.id === 'created' && <span className="mono" style={{ color: 'var(--text-muted)' }}>{fmtDate(card.createdAt)}</span>}
                        {col.id === 'edited' && <span className="mono" style={{ color: 'var(--text-muted)' }}>{fmtDate(card.updatedAt)}</span>}
                      </span>
                    ))}
                  </div>
                );
              })
            )}

            {/* Honest pagination: more server rows exist beyond this page. */}
            {hasMore && (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '12px 14px' }}>
                <NNBtn size="sm" variant="soft" onClick={() => void loadMore()} loading={loadingMore} disabled={loadingMore}>
                  {t('cards.search.loadMore')}
                </NNBtn>
              </div>
            )}
            </div>
          </div>
        </div>

        {focusedCard && <CardDetailPanel card={focusedCard}
          deckName={deckPathLabel(decks, focusedCard.deckId)} index={rows.findIndex(card => card.id === focusedCard.id)} total={rows.length}
          onMove={movePanel} onClose={() => void changeFocused(null)} onDirtyChange={() => {}}
          onOpen={id => { void router.confirmLeave().then(allowed => { if (allowed) void refetchCard(id).then(() => setFocusedId(id)); }); }}
          onDeleted={id => {
            setFocusedId(null);
            setSelected(prev => { const next = new Set(prev); next.delete(id); return next; });
          }} />}


        {selected.size > 0 && (
          <div className="reomi-bulk-actions" role="toolbar" aria-label={t('cards.bulk.selected', { n: selected.size })}>
            <NNBadge tone="lime" size="sm">{t('cards.bulk.selected', { n: selected.size })}</NNBadge>
            <NNBtn disabled={actionsUnavailable} size="sm" variant="soft" icon="dots" aria-haspopup="menu"
              onClick={event => openActions(event.currentTarget)}>{t('cards.actions.open')}</NNBtn>
            <NNBtn disabled={bulkBusy} size="sm" variant="ghost" icon="x" aria-label={t('cards.bulk.clear')}
              onClick={() => { setActionMenu(null); setSelected(new Set()); }} />
          </div>
        )}
        {actionMenu && <CardActionsMenu x={actionMenu.x} y={actionMenu.y} mobile={isMobile}
          label={t('cards.bulk.selected', { n: selected.size })} closeLabel={t('actions.close')}
          onClose={closeActions} actions={cardActions} />}

      </div>
    </div>
    </>
  );
};

// Sort helper shared by client + server-result views (server already sorts, but
// re-sorting client-side keeps the two paths visually identical).
function sortCards(list: Card[], field: SortField, dir: SortDir): Card[] {
  const mul = dir === 'asc' ? 1 : -1;
  const val = (c: Card): number | string => {
    switch (field) {
      case 'created':
        return c.createdAt;
      case 'updated':
        return c.updatedAt;
      case 'due':
        return new Date(c.fsrs.due).getTime();
      case 'lapses':
        return c.fsrs.lapses ?? 0;
      case 'reps':
        return c.fsrs.reps ?? 0;
      case 'front':
        return c.renderFrontText.toLowerCase();
    }
  };
  return [...list].sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    if (va < vb) return -1 * mul;
    if (va > vb) return 1 * mul;
    // Tiebreak by id for a stable order (matches the server keyset tuple).
    return a.id < b.id ? -1 * mul : a.id > b.id ? 1 * mul : 0;
  });
}

// ── sidebar builder ───────────────────────────────────────────────────────────

const sectionLabelStyle: React.CSSProperties = {
  fontSize: 10.5,
  fontWeight: 600,
  color: 'var(--text-dim)',
  padding: '20px 10px 8px',
};

const itemStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  padding: '7px 10px',
  borderRadius: 10,
  border: 'none',
  color: 'var(--text-muted)',
  fontFamily: 'var(--font-sans)',
  fontSize: 13,
  textAlign: 'left',
  cursor: 'pointer',
};

const Sidebar = ({
  decks,
  tags,
  onDeck,
  onTag,
  onChip,
  onAll,
  activeQuery,
}: {
  decks: import('@/lib/types').Deck[];
  tags: string[];
  onDeck: (name: string) => void;
  onTag: (tag: string) => void;
  onChip: (token: string) => void;
  onAll: () => void;
  activeQuery: string;
}) => {
  const t = useT();
  const tree = useMemo(() => buildDeckTree(decks), [decks]);
  const rows = useMemo(
    () => flattenTree(tree, new Set(decks.map((d) => d.id))),
    [tree, decks],
  );

  return (
    <div className="reomi-cards-filter-list">
      <button type="button" onClick={onAll} className="reomi-filter-all" aria-pressed={!activeQuery.trim()}>
        <NNIcon name="stack" size={14} />
        <span>{t('cards.sidebar.allCards')}</span>
      </button>

      <div style={sectionLabelStyle}>{t('cards.sidebar.decks')}</div>
      {rows.map((node) => (
        <button
          key={node.deck.id}
          type="button"
          onClick={() => onDeck(node.deck.name)}
          aria-pressed={tokenizeQuery(activeQuery).includes(addOrReplaceToken('', 'deck', node.deck.name))}
          style={{ ...itemStyle, paddingLeft: 10 + node.depth * 12 }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 2,
              flexShrink: 0,
              background: `var(--${node.deck.color === 'neutral' ? 'ink-500' : `${node.deck.color}-500`})`,
            }}
          />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{node.deck.name}</span>
        </button>
      ))}

      <div style={sectionLabelStyle}>{t('cards.sidebar.states')}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '0 14px' }}>
        {STATE_CHIPS.map((chip) => {
          const active = activeQuery.split(/\s+/).includes(chip.value);
          return (
            <button
              key={chip.value}
              type="button"
              onClick={() => onChip(chip.value)}
              style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
            >
              <NNBadge tone={active ? 'lime' : 'neutral'} size="sm">{t(chip.labelKey)}</NNBadge>
            </button>
          );
        })}
      </div>

      <div style={sectionLabelStyle}>{t('cards.sidebar.tags')}</div>
      {tags.length === 0 ? (
        <div style={{ ...itemStyle, color: 'var(--text-dim)', cursor: 'default' }}>{t('cards.sidebar.noTags')}</div>
      ) : (
        tags.map((tag) => (
          <button key={tag} type="button" onClick={() => onTag(tag)} style={itemStyle}>
            <NNIcon name="tag" size={13} color="var(--sky-400)" />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tag}</span>
          </button>
        ))
      )}
    </div>
  );
};
