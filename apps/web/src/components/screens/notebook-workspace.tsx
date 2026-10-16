'use client';


// NotebookWorkspace (L2 — clean NotebookLM, Р6). The notebook is now pure
// research/chat: the FULL reader (PDF + ink + marks + quick-card) lives at
// `/library/[id]`; reading no longer requires a notebook.
//
//   ┌── sources ──┬──────── chat ────────┐
//   │ status      │ ChatPanel (notebook) │
//   │ ☑ in chat   │ + thread switcher    │
//   │ N cards     │                      │
//   │ + add       │  ┌─ citation viewer ─┤  ← right drawer on a [src:] click
//   │ + attach    │  │ text chunk reader │
//   └─────────────┴──┴───────────────────┘
//
//  • Desktop (≥1100): two columns (sources │ chat). Tablet/mobile: a 2-tab
//    switcher (Источники │ Чат) with the citation viewer as a fullscreen sheet.
//  • Clicking a chat citation [src:] opens a TEXT-mode chunk viewer (no PDF load)
//    keyed ALWAYS on sourceChunkId/position, with a «Открыть в библиотеке» link
//    into the full reader. Cited passages of a detached source still open (the
//    viewer is source-scoped); a deleted source → tombstone.
//  • On mount the workspace consumes sessionStorage['nn:nb:prefill:<id>'] (the
//    library reader's «Спросить» handoff) into the chat composer.
//
//  URL: `?source=<id>&chunk=<chunkId>&pos=<n>` opens the citation viewer;
//  `?thread=<convId>` selects a chat thread.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useNavigationScroll } from '@/lib/use-navigation-scroll';
import { useAppNavigation, useNavigationWorkspace, useWorkspaceState } from '@/components/navigation';
import {
  MAX_SOURCE_BYTES_DEFAULT,
  isSourceTextReadable,
  SOURCE_MIME_TO_KIND,
  type IngestErrorCode,
  type NotebookColor,
  type SourceMime,
} from '@reomi/shared';
import { NNBtn, NNCard, NNIcon, NNBadge, NNLoadError, NNSkeleton } from '@/components/ui';
import { restoreNotebookSourceScope, newlyReadableNotebookSources } from '@/lib/notebook-source-scope';
import { resolveMediaSrc } from '@/lib/media-url';
import { isCooldownError, useNN } from '@/lib/store';
import type { ApiError } from '@/lib/api';
import { toApiError } from '@/lib/resource-state';
import type {
  Notebook,
  Source,
  SourceLinkedCard,
} from '@/lib/types';
import type { SourceCitation } from '@reomi/shared';
import { useBreakpoint } from '@/lib/use-breakpoint';
import { useWcoTopInsets } from '@/lib/ui-store';
import { useT } from '@/lib/i18n';
import { relativeUpdated } from '@/lib/notebook-format';
import { sourceKindToneName } from '@/lib/source-kind';
import { useDialog } from '@/components/dialog';
import { raiseToast } from '@/components/toasts';
import {
  AddSourceForm,
  statusTone,
  type AddKind,
} from '@/components/screens/notebooks';
import { ChatPanel, type ComposerPrefillHandle } from '@/components/chat/chat-panel';
import { SourceStudyWorkspace } from '@/components/screens/library-reader';
import { createPortal } from 'react-dom';
import { NotesPanel } from '@/components/notebook/notes-panel';
import { OverviewPanel } from '@/components/notebook/overview-panel';
import { PlanPanel, useNotebookPlan } from '@/components/notebook/plan-panel';
import { StudioPanel } from '@/components/notebook/studio-panel';
import { DOCK_TAB_LABELS, dockTabOptions, resolveDockTab, type DockTab } from '@/lib/plan-dock';
import { sourceOperationLabel } from '@/lib/source-operation-label';
import { useKnowledgeRefresh } from '@/lib/use-knowledge-refresh';
import { useSourceStatus } from '@/lib/use-source-status';
import { readBrowserValue, removeBrowserValue, writeBrowserValue } from '@/lib/storage-migration';
import { api, ok } from '@/lib/api';
import type { LibraryItem, SuggestedSource, SuggestSourcesResult } from '@/lib/types';

import { SegmentedControl, Button, TextInput } from '@/components/design-system/primitives';

type WorkspaceTab = 'sources' | 'chat' | 'dock';

/**
 * Derive a saved-answer note title (Р7): the first ~60 chars of the content with
 * markdown emphasis + [src:]/[card:] grounding tokens stripped, collapsed
 * whitespace, ellipsized. Falls back to a generic label for empty content.
 */
function noteTitleFromContent(content: string, fallback: string): string {
  const stripped = content
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → label
    .replace(/\[(?:src|card):[^\]]+\]/g, '') // grounding tokens
    .replace(/[#*_`>~]/g, '') // markdown emphasis/heading/code marks
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length === 0) return fallback;
  return stripped.length > 60 ? `${stripped.slice(0, 60).trimEnd()}…` : stripped;
}

type Tfn = (key: string, params?: Record<string, string | number>) => string;

// ── Workspace header tone + source-cover tones (A4 redesign) ───────────────────
const NOTEBOOK_COLOR_VAR: Record<NotebookColor, string> = {
  lime: 'var(--lime-500)',
  amber: 'var(--amber-500)',
  violet: 'var(--violet-500)',
  sky: 'var(--sky-400)',
  rose: 'var(--rose-500)',
  neutral: 'var(--text-muted)',
};

/** A source-row mini book-spine cover: the private cover read when present,
 *  else a kind-toned gradient with the title's first letter in the serif face. */
const SourceCover = ({
  source,
  w = 26,
  h = 36,
}: {
  source: Source;
  w?: number;
  h?: number;
}) => {
  const [failed, setFailed] = useState(false);
  const tone = sourceKindToneName(source.kind);
  const showImage = Boolean(source.coverMediaId) && !failed;
  const letter = source.title.trim().charAt(0).toUpperCase() || '?';
  return (
    <span
      className="nn-nb-cover"
      style={{
        width: w,
        height: h,
        background: showImage
          ? 'var(--surface-3)'
          : `linear-gradient(150deg, var(--${tone}-500), var(--${tone}-600, var(--${tone}-500)))`,
      }}
      aria-hidden
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={resolveMediaSrc(`/m/${source.coverMediaId}`)}
          alt=""
          onError={() => setFailed(true)}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        <span className="nn-nb-cover-letter" style={{ fontSize: Math.round(h * 0.42) }}>
          {letter}
        </span>
      )}
    </span>
  );
};

export const NotebookWorkspace = ({ notebookId }: { notebookId: string }) => {
  const t = useT();
  const router = useAppNavigation();
  const navigationWorkspace=useNavigationWorkspace();
  const navigationEntry=navigationWorkspace?.entry?.id;
  const navigationScope=`notebook:${notebookId}`;
  const searchParams = useSearchParams();
  const bp = useBreakpoint();
  const isDesktop = bp === 'desktop';
  const isTablet = bp === 'tablet';
  const { edit, prompt, confirm } = useDialog();
  // WCO (installed desktop PWA): the workspace renders its own topbar instead of
  // NNTopbar, so it carries the same titlebar duties — drag region + insets.
  const { wco, left: wcoLeft, right: wcoRight } = useWcoTopInsets();

  const listNotebooks = useNN((s) => s.listNotebooks);
  const listSources = useNN((s) => s.listSources);
  const getSource = useNN((s) => s.getSource);
  const addUrlSource = useNN((s) => s.addUrlSource);
  const addTextSource = useNN((s) => s.addTextSource);
  const uploadSource = useNN((s) => s.uploadSource);
  const renameSource = useNN((s) => s.renameSource);
  const getSourceChunks = useNN((s) => s.getSourceChunks);
  const listSourceCards = useNN((s) => s.listSourceCards);
  const listLibrary = useNN((s) => s.listLibrary);
  const attachSources = useNN((s) => s.attachSources);
  const detachSource = useNN((s) => s.detachSource);
  const getNotebookNote = useNN(s => s.getNotebookNote);
  const listNotebookNotes = useNN((s) => s.listNotebookNotes);
  const createNotebookNote = useNN((s) => s.createNotebookNote);
  const patchNotebookNote = useNN((s) => s.patchNotebookNote);
  const deleteNotebookNote = useNN((s) => s.deleteNotebookNote);
  const getNotebook = useNN((s) => s.getNotebook);
  const generateOverview = useNN((s) => s.generateOverview);
  const listArtifacts = useNN((s) => s.listArtifacts);
  const createArtifact = useNN((s) => s.createArtifact);
  const getArtifact = useNN((s) => s.getArtifact);
  const deleteArtifact = useNN((s) => s.deleteArtifact);
  const regenerateArtifact = useNN((s) => s.regenerateArtifact);
  const submitQuizAttempt = useNN((s) => s.submitQuizAttempt);
  const listQuizAttempts = useNN((s) => s.listQuizAttempts);
  const getCoverage = useNN((s) => s.getCoverage);
  const conceptMap = useNN((s) => s.conceptMap);
  const suggestSources = useNN((s) => s.suggestSources);

  const [notebook, setNotebook] = useState<Notebook | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [sourcesLoaded, setSourcesLoaded] = useState(false);
  const [sourcesError, setSourcesError] = useState<ApiError | null>(null);
  const [sourcesRevision, setSourcesRevision] = useState(0);

  // ── /ai/status.chatEnabled — gates the studio/overview generation (degrade) ──
  const [chatEnabled, setChatEnabled] = useState(false);

  // ── Notebook detail (overview cache + fingerprints + suggestedQuestions, N2) ──
  const [notebookDetail, setNotebookDetail] = useState<Notebook | null>(null);
  const [detailLoaded, setDetailLoaded] = useState(false);

  // Per-turn chat source scope: ids checked into the chat. Default = all ready
  // sources; persisted per-notebook in localStorage.
  const scopeKey = `nn:nb:scope:${notebookId}`;
  const [scope, setScope] = useState<Set<string>>(new Set());
  const scopeHydratedRef = useRef(false);

  // Chat thread selection (notebook mode — the workspace owns the switcher).
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);

  // M5 — composer prefill ref (chat ← library «Спросить» handoff + viewer).
  const composerPrefillRef = useRef<ComposerPrefillHandle | null>(null);

  // ── Right dock (Р12): tabs + collapse ─────────────────────────────────────────
  const dockKey = `nn:nb:dock:${notebookId}`;
  const dockTabKey = `nn:nb:docktab:${notebookId}`;
  const [, setDockTab] = useWorkspaceState<DockTab>(navigationScope, 'dockTab', 'overview');
  const [dockCollapsed, setDockCollapsed] = useWorkspaceState(navigationScope, 'dockCollapsed', false);
  // Tablet (720–1100): the dock is a right-side sheet over the sources│chat layout
  // (Р12), toggled from a header button (with a badge-dot when notes are present).
  const [dockSheetOpen, setDockSheetOpen] = useWorkspaceState(navigationScope, 'dockSheetOpen', false);
  // Imperative refresh of the notes panel (after «save answer from chat»).
  const notesRefreshRef = useRef<(() => void) | null>(null);

  const selectDockTab = useCallback(
    (next: DockTab) => {
      setDockTab(next);
      try {
        writeBrowserValue(localStorage, dockTabKey, next);
      } catch {
        /* best-effort */
      }
    },
    [dockTabKey,setDockTab],
  );

  // Hydrate route-local dock state for every notebook. The component can stay
  // mounted while `[id]` changes, so a one-time boolean would leak the previous
  // notebook's preference into the next workspace. Tab choice stays unread
  // (`undefined`) until this effect, and a missing key stays null.
  const [dockStorage, setDockStorage] = useState<{ id: string; tab: string | null } | null>(null);
  const storedTab = dockStorage?.id === notebookId ? dockStorage.tab : undefined;
  const dockHydratedNotebookRef = useRef<string | null>(null);
  useEffect(() => {
    if (dockHydratedNotebookRef.current === notebookId) return;
    dockHydratedNotebookRef.current = notebookId;
    let tab: string | null = null;
    try {
      const saved=navigationWorkspace?.entry?.views[navigationScope]?.fields;
      if(saved?.dockCollapsed===undefined)setDockCollapsed(readBrowserValue(localStorage, dockKey) === 'collapsed');
      tab = readBrowserValue(localStorage, dockTabKey);
    } catch {
      setDockCollapsed(false);
      tab = null;
    }
    setDockStorage({ id: notebookId, tab });
    if(!navigationWorkspace?.entry?.views[navigationScope]?.fields.dockSheetOpen)setDockSheetOpen(false);
  }, [dockKey, dockTabKey, notebookId]);

  const toggleDock = useCallback(() => {
    setDockCollapsed((prev) => {
      const next = !prev;
      try {
        writeBrowserValue(localStorage, dockKey, next ? 'collapsed' : 'open');
      } catch {
        /* best-effort */
      }
      return next;
    });
  }, [dockKey]);

  // Prefill the chat composer (notes «В карточки» + library handoff share this).
  const prefillChat = useCallback((text: string) => {
    composerPrefillRef.current?.prefill(text);
  }, []);

  // «В заметки» (Р7) — save a finished assistant answer as a note.
  const onSaveAnswer = useCallback(
    async (payload: { content: string; citations: unknown[]; messageId?: string }) => {
      try {
        await createNotebookNote(notebookId, {
          title: noteTitleFromContent(payload.content, t('notebooks.notes.addTitle')),
          content: payload.content,
          kind: 'answer',
          citations: payload.citations,
          messageId: payload.messageId,
        });
        raiseToast({ kind: 'info', title: t('notebooks.notes.savedFromChat') });
        notesRefreshRef.current?.();
        if (isTablet) {
          setDockTab('notes');
          setDockSheetOpen(true);
        } else if (dockCollapsed) {
          toggleDock();
        }
      } catch {
        raiseToast({ kind: 'error', title: t('notebooks.notes.createFailed') });
      }
    },
    [createNotebookNote, notebookId, t, dockCollapsed, toggleDock, isTablet],
  );

  // Studio «В заметку» — copy a ready artifact's markdown into a manual note.
  const onSaveArtifactNote = useCallback(
    async (title: string, contentMd: string) => {
      try {
        await createNotebookNote(notebookId, { title, content: contentMd });
        raiseToast({ kind: 'info', title: t('notebooks.studio.savedToNote') });
        notesRefreshRef.current?.();
      } catch {
        raiseToast({ kind: 'error', title: t('notebooks.notes.createFailed') });
      }
    },
    [createNotebookNote, notebookId, t],
  );

  // ── Full source study workspace over the current notebook ───────────────
  const [viewer, setViewer] = useState<{
    sourceId: string;
    chunkId?: string;
    pos?: number;
    page?: number;
  } | null>(null);

  const readerReturnFocus = useRef<HTMLElement | null>(null);
  const closeSourceReader = useCallback(() => {
    router.returnTo(`/notebooks/${notebookId}`);
    const target = readerReturnFocus.current; readerReturnFocus.current = null;
    requestAnimationFrame(() => { if (target?.isConnected) target.focus({preventScroll:true}); });
  }, [router,notebookId]);

  // Mobile tab.
  const [tab, setTab] = useWorkspaceState<WorkspaceTab>(navigationScope, 'tab', 'chat');

  // Add-source form state (M1 flow).
  const [addOpen, setAddOpen] = useState(false);
  const [addKind, setAddKind] = useState<AddKind>('file');
  const [addTitle, setAddTitle] = useState('');
  const [addUrl, setAddUrl] = useState('');
  const [addText, setAddText] = useState('');
  const [addFile, setAddFile] = useState<File | null>(null);
  const [adding, setAdding] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const maxMb = Math.floor(MAX_SOURCE_BYTES_DEFAULT / (1024 * 1024));

  // L1 — "Add from library" attach picker.
  const [attachOpen, setAttachOpen] = useState(false);

  // ── Deep-link params (?source=&chunk=&pos= / ?thread=) ───────────────────────
  const sourceParam = searchParams.get('source');
  const chunkParam = searchParams.get('chunk');
  const posParam = searchParams.get('pos');
  const pageParam = searchParams.get('page');
  const threadParam = searchParams.get('thread');
  const noteParam = searchParams.get('note');
  const artifactParam = searchParams.get('artifact');
  const newNoteParam = searchParams.get('newNote') === '1';
  useEffect(() => {
    if (!noteParam && !artifactParam && !newNoteParam) return;
    setDockCollapsed(false);
    if (isTablet) setDockSheetOpen(true);
    if (!isDesktop && !isTablet) setTab('dock');
  }, [noteParam, artifactParam, newNoteParam, isDesktop, isTablet]);
  const planRead = useNotebookPlan(notebookId);
  const journalDock = navigationWorkspace?.entry?.views[navigationScope]?.fields.dockTab;
  const journalTab = typeof journalDock === 'string' ? journalDock : null;
  const deepLink = artifactParam ? 'studio' : noteParam || newNoteParam ? 'notes' : null;
  const resolution = resolveDockTab({ deepLink, journalTab, storedTab, plan: planRead.load });
  const dockOptions = dockTabOptions(planRead.load === 'present');
  const shown = resolution !== 'wait' && dockOptions.includes(resolution) ? resolution : null;
  useEffect(() => {
    if (resolution === 'wait') return;
    if (journalTab === resolution) return;
    const storedChoice = storedTab === 'overview' || storedTab === 'notes' || storedTab === 'studio';
    // A missing plan is the default Overview. Writing it would hide a plan that arrives later.
    if (resolution === 'plan' || deepLink !== null || storedChoice) setDockTab(resolution);
  }, [resolution, journalTab, storedTab, deepLink, setDockTab]);
  const consumeStudyLink = useCallback((kind: 'note' | 'artifact') => {
    const next = new URLSearchParams(searchParams.toString());
    next.delete(kind);
    router.replace(`/notebooks/${notebookId}${next.size ? `?${next}` : ''}`, { scroll: false, track: false });
  }, [searchParams, notebookId, router]);

  const metadataRefresh = useRef(0);
  const metadataPending = useRef(false);
  const refreshWorkspaceMetadata = async () => {
    if (!sourcesLoaded) { metadataPending.current = true; return; }
    const sequence = ++metadataRefresh.current, owner = useNN.getState().profile?.userId;
    const [detail, rows] = await Promise.all([getNotebook(notebookId), listSources(notebookId)]);
    if (sequence !== metadataRefresh.current || useNN.getState().profile?.userId !== owner) return;
    setNotebook(detail); setSources(rows);
    const ids = new Set(rows.map(row => row.id));
    setScope(previous => new Set([...previous].filter(id => ids.has(id))));
  };
  useKnowledgeRefresh(refreshWorkspaceMetadata);
  useEffect(() => {
    if (sourcesLoaded && metadataPending.current) { metadataPending.current = false; void refreshWorkspaceMetadata().catch(() => {}); }
    return () => { metadataRefresh.current++; };
  }, [notebookId, sourcesLoaded]);

  // ── Load notebook + sources ───────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setSourcesLoaded(false);
    setSourcesError(null);
    scopeHydratedRef.current = false;
    setScope(new Set());
    setActiveThreadId(null);
    setViewer(null);
    setAttachOpen(false);
    (async () => {
      try {
        const nbs = await listNotebooks();
        if (!cancelled) setNotebook(nbs.find((n) => n.id === notebookId) ?? null);
      } catch {
        if (!cancelled) setNotebook(null);
      }
      try {
        const rows = await listSources(notebookId);
        if (cancelled) return;
        setSources(rows);
        if (!scopeHydratedRef.current) {
          scopeHydratedRef.current = true;
          let stored: unknown = null;
          try {
            const raw = readBrowserValue(localStorage, scopeKey);
            stored = raw ? JSON.parse(raw) : null;
          } catch {
            stored = null;
          }
          const next = restoreNotebookSourceScope(rows, stored);
          setScope(next);
        }
      } catch (error) {
        if (!cancelled) {
          setSources([]);
          setSourcesError(toApiError(error));
        }
      } finally {
        if (!cancelled) setSourcesLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notebookId, sourcesRevision]);

  // ── /ai/status.chatEnabled (degrade — gates studio/overview generation) ───────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = (await ok(await (api as any).ai.status.get())) as { chatEnabled: boolean };
        if (!cancelled) setChatEnabled(Boolean(s.chatEnabled));
      } catch {
        if (!cancelled) setChatEnabled(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Notebook detail (overview cache + fingerprints + suggestedQuestions, N2) ──
  // Owned here so the dock's OverviewPanel AND the ChatPanel empty-state share one
  // copy of `suggestedQuestions`. Refetched only on notebook switch.
  useEffect(() => {
    let cancelled = false;
    setDetailLoaded(false);
    setNotebookDetail(null);
    (async () => {
      try {
        const nb = await getNotebook(notebookId);
        if (!cancelled) setNotebookDetail(nb);
      } catch {
        /* keep null */
      } finally {
        if (!cancelled) setDetailLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [notebookId, getNotebook]);

  const onDetailChange = useCallback((patch: Partial<Notebook>) => {
    setNotebookDetail((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  // «Обновить подсказки» (A2 ChatPanel.onRefreshSuggestions) — regenerate the
  // overview (its `questions` ARE the suggested-prompt pills) and merge the
  // refreshed cache into the shared detail state, exactly like OverviewPanel's
  // manual generate. The ChatPanel guards this on chatEnabled + a busy flag.
  const refreshSuggestions = useCallback(async () => {
    try {
      const res = await generateOverview(notebookId);
      onDetailChange({
        overview: res.overview,
        suggestedQuestions: res.questions,
        overviewFingerprint: res.fingerprint,
        currentFingerprint: res.fingerprint,
      });
    } catch (err) {
      // 429 cooldown → an info toast («wait a moment»), not an error toast.
      if (isCooldownError(err)) {
        raiseToast({ kind: 'info', title: t('notebooks.overview.cooldown') });
      } else {
        raiseToast({ kind: 'error', title: t('notebooks.overview.failed') });
      }
    }
  }, [generateOverview, notebookId, onDetailChange, t]);

  // ── Consume the library handoff prefill on mount ───────────────────────────────
  const consumedPrefillRef = useRef<string | null>(null);
  useEffect(() => {
    if (consumedPrefillRef.current === notebookId) return;
    consumedPrefillRef.current = notebookId;
    // Defer so the ChatPanel has populated composerPrefillRef.
    const id = window.setTimeout(() => {
      try {
        const key = `nn:nb:prefill:${notebookId}`;
        const text = readBrowserValue(sessionStorage, key);
        if (text) {
          removeBrowserValue(sessionStorage, key);
          composerPrefillRef.current?.prefill(text);
            }
      } catch {
        /* best-effort */
      }
    }, 50);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notebookId]);

  // Persist the chat scope (best-effort).
  const setScopePersisted = useCallback(
    (next: Set<string> | ((prev: Set<string>) => Set<string>)) => {
      setScope((prev) => {
        const resolved = typeof next === 'function' ? next(prev) : next;
        try {
          writeBrowserValue(localStorage, scopeKey, JSON.stringify([...resolved]));
        } catch {
          /* best-effort */
        }
        return resolved;
      });
    },
    [scopeKey],
  );

  const toggleScope = useCallback(
    (id: string) => {
      setScope((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        try {
          writeBrowserValue(localStorage, scopeKey, JSON.stringify([...next]));
        } catch {
          /* best-effort */
        }
        return next;
      });
    },
    [scopeKey],
  );

  // Scope selection follows parsed readability, independently of embeddings.
  const readyIds = useMemo(
    () => sources.filter((s) => isSourceTextReadable(s.status, s.errorCode)).map((s) => s.id),
    [sources],
  );
  const allSelected = readyIds.length > 0 && readyIds.every((id) => scope.has(id));
  const toggleSelectAll = useCallback(() => {
    setScopePersisted(allSelected ? new Set() : new Set(readyIds));
  }, [allSelected, readyIds, setScopePersisted]);

  // ── Poll non-terminal sources (shared useSourceStatus hook) ───────────────────
  useSourceStatus({
    items: sources,
    fetchOne: (id) => getSource(id).catch(() => null),
    onUpdate: (fresh) => {
      const byId = new Map(fresh.map((s) => [s.id, s]));
      // Determine transitions outside React's state updater. Completing indexing
      // must not reselect a source the user could already read and unchecked.
      const newlyReadyIds = newlyReadableNotebookSources(sources, fresh);
      setSources((prev) =>
        prev.map((s) => {
          const updated = byId.get(s.id);
          if (!updated) return s;
          // `getSource` (the poll's fetchOne) doesn't carry the list-only reading
          // state; keep the existing values so the rail subline doesn't blank.
          return {
            ...updated,
            readingStatus: updated.readingStatus ?? s.readingStatus ?? null,
            readingPercent: updated.readingPercent ?? s.readingPercent ?? null,
          };
        }),
      );
      if (newlyReadyIds.length > 0) {
        setScopePersisted((prev) => new Set([...prev, ...newlyReadyIds]));
      }
    },
  });

  // ── Open the citation viewer (keyed on sourceChunkId/position, NOT page) ───────
  const openViewer = useCallback(
    (v: { sourceId: string; chunkId?: string; pos?: number; page?: number }) => {
      if (!readerReturnFocus.current && document.activeElement instanceof HTMLElement) readerReturnFocus.current = document.activeElement;
      const next=new URLSearchParams(searchParams.toString());
      for(const key of ['source','chunk','pos','page'])next.delete(key);
      next.set('source',v.sourceId);
      if(v.chunkId)next.set('chunk',v.chunkId);
      if(v.pos!=null)next.set('pos',String(v.pos));
      if(v.page!=null)next.set('page',String(v.page));
      router.push(`/notebooks/${notebookId}?${next}`,{scroll:false,track:false});
      // Keep the previous sheet state for return; the reader hides its presentation.

    },
    [isDesktop,router,searchParams,notebookId,setDockSheetOpen],
  );

  // ── Resolve a `[src:]` chunk to its source, then open the citation viewer ──────
  // The studio artifact viewer's footnote chips carry only a `chunkId` (the
  // artifact stores no chunk→source map); resolve it by scanning the artifact's
  // source snapshot's chunk pages. Bounded (MAX pages/source); if unresolved we
  // fall back to opening the first candidate source keyed on the chunkId (the
  // reader will page-forward to it).
  const CITATION_PROBE_MAX_PAGES = 20;
  const CITATION_PROBE_PAGE = 200;
  const resolvingCitationRef = useRef(false);
  const openCitationByChunk = useCallback(
    async (chunkId: string, candidateSourceIds: string[]) => {
      if (resolvingCitationRef.current) return;
      const candidates =
        candidateSourceIds.length > 0
          ? candidateSourceIds
          : sources.filter((s) => isSourceTextReadable(s.status, s.errorCode)).map((s) => s.id);
      if (candidates.length === 0) return;
      // Single candidate — open directly (the reader pages forward to the chunk).
      if (candidates.length === 1) {
        openViewer({ sourceId: candidates[0]!, chunkId });
        return;
      }
      resolvingCitationRef.current = true;
      try {
        for (const sid of candidates) {
          let from = 0;
          for (let page = 0; page < CITATION_PROBE_MAX_PAGES; page++) {
            let res;
            try {
              res = await getSourceChunks(sid, from, CITATION_PROBE_PAGE);
            } catch {
              break; // this source errored — try the next candidate
            }
            if (res.items.some((c) => c.id === chunkId)) {
              openViewer({ sourceId: sid, chunkId });
              return;
            }
            if (res.nextFrom == null) break;
            from = res.nextFrom;
          }
        }
        // Unresolved — open the first candidate keyed on the chunk (reader pages on).
        openViewer({ sourceId: candidates[0]!, chunkId });
      } finally {
        resolvingCitationRef.current = false;
      }
    },
    [sources, getSourceChunks, openViewer],
  );

  // The notebook reader is a real history entry, while the notebook stays mounted.
  useEffect(() => {
    if (!sourceParam) {setViewer(null);return;}
    if (!sourcesLoaded) return;
    setViewer({sourceId:sourceParam,chunkId:chunkParam??undefined,
      pos:posParam!=null&&Number.isFinite(Number(posParam))?Number(posParam):undefined,
      page:pageParam!=null&&Number.isFinite(Number(pageParam))?Number(pageParam):undefined});
  },[sourcesLoaded,sourceParam,chunkParam,posParam,pageParam,navigationEntry]);

  // Consume ?thread= once (notebook chat thread selection).
  const consumedThreadParamRef = useRef<string | null>(null);
  useEffect(() => {
    if (!threadParam) return;
    if (consumedThreadParamRef.current === threadParam) return;
    consumedThreadParamRef.current = threadParam;
    setActiveThreadId(threadParam);
    if (!isDesktop) setTab('chat');
  }, [threadParam, isDesktop]);

  // ── Add-source (M1 flow) ──────────────────────────────────────────────────────
  const resetAddForm = useCallback(() => {
    setAddOpen(false);
    setAddKind('file');
    setAddTitle('');
    setAddUrl('');
    setAddText('');
    setAddFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, []);

  const onSubmitAdd = useCallback(async () => {
    if (adding) return;
    setAdding(true);
    try {
      let created: Source;
      if (addKind === 'url') {
        const url = addUrl.trim();
        if (!url) return;
        created = await addUrlSource(notebookId, addTitle.trim() || url, url);
      } else if (addKind === 'text') {
        if (!addText.trim()) return;
        created = await addTextSource(
          notebookId,
          addTitle.trim() || t('notebooks.add.textLabel'),
          addText,
        );
      } else {
        if (!addFile) return;
        const mime: SourceMime | null =
          addFile.type in SOURCE_MIME_TO_KIND
            ? (addFile.type as SourceMime)
            : addFile.name.toLowerCase().endsWith('.pdf')
              ? 'application/pdf'
              : addFile.name.toLowerCase().endsWith('.epub')
                ? 'application/epub+zip'
                : null;
        if (!mime) {
          raiseToast({ kind: 'error', title: t('notebooks.status.unsupported_mime') });
          return;
        }
        created = await uploadSource(notebookId, addFile, addTitle.trim() || addFile.name, mime);
      }
      setSources((prev) => [created, ...prev]);
      resetAddForm();
    } catch {
      raiseToast({ kind: 'error', title: t('notebooks.add.failed') });
    } finally {
      setAdding(false);
    }
  }, [
    adding,
    addKind,
    addUrl,
    addText,
    addFile,
    addTitle,
    notebookId,
    addUrlSource,
    addTextSource,
    uploadSource,
    resetAddForm,
    t,
  ]);

  const onRenameSource = useCallback(async (src: Source) => {
    await edit({ title: t('notebooks.sources.renameTitle'), label: t('notebooks.sources.renameLabel'), defaultValue: src.title,
      path: `/sources/${src.id}`, revision: src.metadataRevision ?? 0, maxLength: 300,
      patch: title => ({ title }), validate: title => title.trim() ? null : ' ',
      readCurrent: async () => { const current = await getSource(src.id); return { revision: current.metadataRevision ?? 0, value: current.title }; },
      onSaved: result => { if (result.result) setSources(previous => previous.map(row => row.id === src.id ? { ...row, ...(result.result as Source) } : row)); },
    });
  }, [edit, t, getSource]);

  // L1 — detach (NOT delete): the material stays in the library; only its link to
  // this notebook is removed. MUST prune the source id from the chat scope —
  // else a detach→re-attach silently restores a stale checkbox.
  const onDetachSource = useCallback(
    async (src: Source) => {
      const yes = await confirm({
        title: t('library.detach.title'),
        message: t('library.detach.message'),
        confirmLabel: t('library.detach.confirm'),
      });
      if (!yes) return;
      try {
        await detachSource(notebookId, src.id);
      } catch {
        raiseToast({ kind: 'error', title: t('library.workspace.detachFailed') });
        return;
      }
      setSources((prev) => prev.filter((s) => s.id !== src.id));
      setScopePersisted(new Set([...scope].filter((id) => id !== src.id)));
      if (viewer?.sourceId === src.id) setViewer(null);
      raiseToast({ kind: 'info', title: t('library.toast.detached') });
    },
    [confirm, t, detachSource, notebookId, scope, setScopePersisted, viewer],
  );

  // L1 — attach existing library sources to this notebook, then refetch the list.
  const onAttachSources = useCallback(
    async (sourceIds: string[]) => {
      if (sourceIds.length === 0) return;
      try {
        await attachSources(notebookId, sourceIds);
      } catch {
        raiseToast({ kind: 'error', title: t('library.workspace.detachFailed') });
        return;
      }
      setAttachOpen(false);
      try {
        const rows = await listSources(notebookId);
        setSources(rows);
      } catch {
        /* keep current on transient error */
      }
    },
    [attachSources, notebookId, listSources, t],
  );

  // «Читать в библиотеке» → the full-screen library reader (NOT ?focus=).
  const onReadInLibrary = useCallback(
    (src: Source) => {
      openViewer({ sourceId: src.id });
    },
    [openViewer],
  );

  // Notebook-mode chat thread change.
  const onThreadChange = useCallback(
    (id: string | null) => {
      setActiveThreadId(id);
      const base = `/notebooks/${notebookId}`;
      router.replace(id ? `${base}?thread=${id}` : base, { scroll: false, track: false });
    },
    [router, notebookId],
  );

  // The checked source ids (stable array) passed to the chat panel.
  const scopeIds = useMemo(() => [...scope], [scope]);


  // ── Panels ─────────────────────────────────────────────────────────────────────
  const sourcesPanel = sourcesError ? (
    <div style={{ padding: 18 }}>
      <NNLoadError
        title={t('toasts.error')}
        description={sourcesError.safeMessage}
        retryLabel={t('notebooks.overview.retry')}
        requestId={sourcesError.requestId}
        onRetry={() => setSourcesRevision((value) => value + 1)}
      />
    </div>
  ) : (
    <SourcesPanel
      navigationScope={navigationScope}
      sources={sources}
      loaded={sourcesLoaded}
      scope={scope}
      addOpen={addOpen}
      addProps={{
        kind: addKind,
        setKind: setAddKind,
        title: addTitle,
        setTitle: setAddTitle,
        url: addUrl,
        setUrl: setAddUrl,
        text: addText,
        setText: setAddText,
        file: addFile,
        setFile: setAddFile,
        fileInputRef,
        adding,
        maxMb,
        onSubmit: onSubmitAdd,
        onCancel: resetAddForm,
      }}
      onOpenAdd={() => setAddOpen(true)}
      onAttachFromLibrary={() => setAttachOpen(true)}
      onToggleScope={toggleScope}
      readyCount={readyIds.length}
      selectedCount={readyIds.filter((id) => scope.has(id)).length}
      allSelected={allSelected}
      onToggleSelectAll={toggleSelectAll}
      onRename={onRenameSource}
      onDetach={onDetachSource}
      onReadInLibrary={onReadInLibrary}
      listSourceCards={listSourceCards}
      onOpenCard={(cardId) => router.push(`/cards?focus=${cardId}`)}
      t={t}
    />
  );

  // Suggested questions for the empty notebook thread (Р6) — from the detail cache.
  const suggestedQuestions = notebookDetail?.suggestedQuestions ?? undefined;

  // Stable identity — the inline-citation DOM decoration effect in ChatPanel
  // keys on this callback; a fresh arrow per render would re-run it every time.
  const onCitationClick = useCallback(
    (c: SourceCitation) => {
      if (!c.sourceId) return;
      openViewer({
        sourceId: c.sourceId,
        chunkId: c.sourceChunkId,
        pos: c.position,
        page: c.page,
      });
    },
    [openViewer],
  );

  const chatPanel = (
    <ChatPanel
      mode="notebook"
      notebookId={notebookId}
      sourceIds={scopeIds}
      activeThreadId={activeThreadId}
      composerPrefillRef={composerPrefillRef}
      onThreadChange={onThreadChange}
      onSaveAnswer={onSaveAnswer}
      suggestedQuestions={suggestedQuestions}
      onRefreshSuggestions={chatEnabled ? refreshSuggestions : undefined}
      onSourceCitation={onCitationClick}
    />
  );

  // ── Right dock (Р12): Обзор / Заметки / Студия (N2) ────────────────────────────
  // A suggested-question pill → prefill the composer (same handoff as «Спросить»).
  const askInChat = useCallback(
    (question: string) => {
      prefillChat(question);
      // Tablet: the dock sheet covers the chat — close it so the prefill is seen.
      setDockSheetOpen(false);
    },
    [prefillChat, isDesktop],
  );

  const overviewPanel = (
    <OverviewPanel
      notebookId={notebookId}
      detail={notebookDetail}
      detailLoaded={detailLoaded}
      sources={sources}
      chatEnabled={chatEnabled}
      generateOverview={generateOverview}
      getCoverage={getCoverage}
      conceptMap={conceptMap}
      onOpenCitation={(sourceId, chunkId) => openViewer({ sourceId, chunkId })}
      onDetailChange={onDetailChange}
      onAskQuestion={askInChat}
      t={t}
    />
  );

  // Prefill the chat + reveal it (mobile → chat tab; tablet → close the dock
  // sheet so the composer is visible). Shared by notes/studio prefill actions.
  const prefillAndReveal = useCallback(
    (text: string) => {
      prefillChat(text);
      setDockSheetOpen(false);
    },
    [prefillChat, isDesktop],
  );

  const notesPanel = (
    <NotesPanel
      key={notebookId}
      notebookId={notebookId}
      initialNoteId={noteParam}
      initialCreate={newNoteParam}
      onInitialOpen={() => consumeStudyLink('note')}
      listNotes={listNotebookNotes}
      getNote={getNotebookNote}
      createNote={createNotebookNote}
      patchNote={patchNotebookNote}
      deleteNote={deleteNotebookNote}
      onPrefillChat={prefillAndReveal}
      refreshRef={notesRefreshRef}
      t={t}
    />
  );

  const studioPanel = (
    <StudioPanel
      key={notebookId}
      notebookId={notebookId}
      initialArtifactId={artifactParam}
      onInitialOpen={() => consumeStudyLink('artifact')}
      scopeIds={scopeIds}
      chatEnabled={chatEnabled}
      listArtifacts={listArtifacts}
      createArtifact={createArtifact}
      getArtifact={getArtifact}
      deleteArtifact={deleteArtifact}
      regenerateArtifact={regenerateArtifact}
      submitQuizAttempt={submitQuizAttempt}
      listQuizAttempts={listQuizAttempts}
      onOpenCitation={(chunkId, sids) => void openCitationByChunk(chunkId, sids)}
      onSaveToNote={onSaveArtifactNote}
      onPrefillChat={prefillAndReveal}
      t={t}
    />
  );

  const dockSegments = shown ? (
    <SegmentedControl
      label={dockOptions.map((tab) => t(DOCK_TAB_LABELS[tab])).join(' / ')}
      value={shown}
      onChange={selectDockTab}
      options={dockOptions.map((tab) => ({ value: tab, label: t(DOCK_TAB_LABELS[tab]) }))}
      style={{ flex: 1, minWidth: 0 }}
    />
  ) : (
    <NNSkeleton height={28} style={{ flex: 1 }} />
  );
  const dockContent = shown === 'plan' && planRead.load === 'present' ? (
    <PlanPanel plan={planRead.plan} onOpenSource={(sourceId) => openViewer({ sourceId })} />
  ) : shown === 'overview' ? (
    overviewPanel
  ) : shown === 'notes' ? (
    notesPanel
  ) : shown === 'studio' ? (
    studioPanel
  ) : planRead.load === 'error' ? (
    <div style={{ padding: 18 }}>
      <NNLoadError title={t('toasts.error')} retryLabel={t('notebooks.overview.retry')} onRetry={planRead.retry} />
    </div>
  ) : (
    <div style={{ padding: 18 }}>
      <NNSkeleton height={120} />
    </div>
  );

  // Dock header: tab pills (Обзор/Заметки/Студия) + a collapse toggle (desktop).
  // The collapse toggle lives in the dock header so the chat column reclaims width.
  const dockHeader = (
    <div
      className="nn-chrome"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 10px',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
        minHeight: 44,
      }}
    >
      {dockSegments}
      <NNBtn
        variant="ghost"
        size="sm"
        icon="chevr"
        ariaLabel={t('notebooks.notes.dockCollapse')}
        title={t('notebooks.notes.dockCollapse')}
        onClick={toggleDock}
      />
    </div>
  );

  const dockColumn = (
    <div
      className="nn-dock-col reomi-notebook-dock"
      style={{
        width: 304,
        flexShrink: 0,
        borderLeft: '1px solid var(--panel-edge)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: 'var(--surface)',
      }}
    >
      {dockHeader}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {dockContent}
      </div>
    </div>
  );

  // Keep the notebook mounted underneath the full shared reader. Its source
  // selection, dock drafts and scroll positions survive opening and returning.
  const citationViewer = viewer && typeof document !== 'undefined' ? createPortal(
    <div className="reomi-notebook-source-reader" role="region" aria-label={t('assistant.readSource')}>
      <SourceStudyWorkspace key={`${navigationEntry}:${viewer.sourceId}:${viewer.chunkId ?? ''}:${viewer.page ?? ''}:${viewer.pos ?? ''}`}
        sourceId={viewer.sourceId} initialLocation={viewer}
        origin={{ title: notebook?.title ?? t('nav.notebooks'), onReturn: closeSourceReader }} />
    </div>, document.body,
  ) : null;

  // L1 — "Add from library" picker. N4 (Р11): the picker also surfaces a
  // «Рекомендуем» section fed by GET …/suggest-sources (vectors-only).
  const attachPicker = attachOpen ? (
    <LibraryAttachPicker
      notebookId={notebookId}
      attachedIds={new Set(sources.map((s) => s.id))}
      listLibrary={listLibrary}
      suggestSources={suggestSources}
      onConfirm={onAttachSources}
      onClose={() => setAttachOpen(false)}
      t={t}
    />
  ) : null;

  // ── Layout ─────────────────────────────────────────────────────────────────────
  // Topbar tone tile + meta. The basic `notebook` row carries color/emoji/
  // updatedAt; `sources.length` is the live attached count.
  const headerAccent = notebook?.color ? NOTEBOOK_COLOR_VAR[notebook.color] : 'var(--violet-500)';
  const headerEmoji = notebook?.emoji && notebook.emoji.length > 0 ? notebook.emoji : null;
  const headerUpdated = relativeUpdated(notebook?.updatedAt, t);
  const headerMeta = [
    t('notebooks.workspace.headerSources', { count: sources.length }),
    headerUpdated ? t('notebooks.meta.updated', { time: headerUpdated }) : null,
  ]
    .filter(Boolean)
    .join(t('notebooks.workspace.headerMetaSep'));

  const header = (
    <div
      className="nn-chrome nn-nb-ws-header"
      data-wco={wco ? '1' : undefined}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: `7px ${12 + wcoRight}px 7px ${12 + wcoLeft}px`,
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}
    >
      <Button variant="bare"
        type="button"
        className="nn-nb-ws-back"
        onClick={() => router.push('/notebooks')}
      >
        <NNIcon name="chevl" size={14} color="currentColor" />
        {t('notebooks.sources.back')}
      </Button>
      <span
        className="nn-nb-ws-tile"
        style={{
          background: `color-mix(in srgb, ${headerAccent} 14%, transparent)`,
          border: `1px solid color-mix(in srgb, ${headerAccent} 25%, transparent)`,
          color: headerAccent,
        }}
        aria-hidden
      >
        {headerEmoji ?? <NNIcon name="book" size={14} color={headerAccent} />}
      </span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <h2
          style={{
            fontSize: 16,
            fontWeight: 600,
            fontFamily: 'var(--font-sans)',
            color: 'var(--text)',
            margin: 0,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            letterSpacing: '-0.02em',
            lineHeight: 1.2,
          }}
        >
          {notebook?.title ?? t('notebooks.sources.heading')}
        </h2>
        <span
          style={{
            fontSize: 12.5,
            color: 'var(--text-dim)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {headerMeta}
        </span>
      </div>
      {/* Tablet (Р12): open the dock as a right-side sheet. A badge-dot signals
          non-empty notes. */}
      {isTablet && (
        <span style={{ position: 'relative', display: 'inline-flex' }}>
          <NNBtn
            variant="soft"
            size="sm"
            icon="doc"
            ariaLabel={t('notebooks.workspace.tabDock')}
            title={t('notebooks.workspace.tabDock')}
            onClick={() => setDockSheetOpen(true)}
          >
            {t('notebooks.workspace.tabDock')}
          </NNBtn>
          {(notebook?.noteCount ?? 0) > 0 && (
            <span
              aria-hidden
              style={{
                position: 'absolute',
                top: -2,
                right: -2,
                width: 7,
                height: 7,
                borderRadius: 999,
                background: 'var(--lime-400)',
                border: '1.5px solid var(--surface)',
              }}
            />
          )}
        </span>
      )}
    </div>
  );

  // Tablet (720–1100, Р12): two columns (sources │ chat) with the dock as a
  // right-side SHEET over the chat (toggled from the header button) and the
  // citation viewer as a fullscreen sheet. Distinct from the mobile tab switcher.
  if (isTablet) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        {attachPicker}
        {header}
        <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <div
            className="reomi-notebook-sources"
            style={{
              width: 224,
              flexShrink: 0,
              borderRight: '1px solid var(--panel-edge)',
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
            }}
          >
            {sourcesPanel}
          </div>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            {chatPanel}
          </div>
        </div>
        {/* Dock sheet (right side) — slides over the chat column. */}
        {dockSheetOpen && !viewer && (
          <>
            <div
              className="nn-dialog-backdrop"
              onClick={() => setDockSheetOpen(false)}
              style={{ position: 'fixed', inset: 0, zIndex: 70, background: 'var(--scrim)' }}
            />
            <div
              style={{
                position: 'fixed',
                top: 0,
                right: 0,
                bottom: 0,
                width: 'min(420px, 90vw)',
                zIndex: 71,
                display: 'flex',
                flexDirection: 'column',
                background: 'var(--surface)',
                borderLeft: '1px solid var(--panel-edge)',
                boxShadow: 'var(--shadow-lg)',
              }}
            >
              <div className="nn-chrome" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: '1px solid var(--border)', flexShrink: 0, minHeight: 44 }}>
                {dockSegments}
                <NNBtn variant="ghost" size="sm" icon="x" ariaLabel={t('library.details.close')} title={t('library.details.close')} onClick={() => setDockSheetOpen(false)} />
              </div>
              <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                {dockContent}
              </div>
            </div>
          </>
        )}
        {/* Citation viewer — fullscreen sheet. */}
        {citationViewer}
      </div>
    );
  }

  if (isDesktop) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        {attachPicker}
        {header}
        <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          <div
            className="reomi-notebook-sources"
            style={{
              width: 240,
              flexShrink: 0,
              borderRight: '1px solid var(--panel-edge)',
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
            }}
          >
            {sourcesPanel}
          </div>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            {chatPanel}
          </div>
          {/* Right side: the citation viewer (transient) takes precedence over the
              dock; otherwise the dock column (or a thin expand rail when collapsed). */}
          {citationViewer}
          {dockCollapsed ? (
              <DockExpandRail label={t('notebooks.notes.dockExpand')} onExpand={toggleDock} />
            ) : (
              dockColumn
            )}
        </div>
      </div>
    );
  }

  // Tablet / mobile — a 2-tab switcher (sources │ chat); viewer is a fullscreen sheet.
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {attachPicker}
      {header}
      <div
        className="nn-chrome"
        style={{
          display: 'flex',
          gap: 4,
          padding: '6px 10px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
          overflowX: 'auto',
        }}
      >
        {([
          { key: 'sources', labelKey: 'notebooks.workspace.tabSources' },
          { key: 'chat', labelKey: 'notebooks.workspace.tabChat' },
          { key: 'dock', labelKey: 'notebooks.workspace.tabDock' },
        ] as { key: WorkspaceTab; labelKey: string }[]).map(({ key: tk, labelKey }) => (
          <Button variant="bare"
            key={tk}
            type="button"
            className={`nn-ws-tab${tab === tk ? ' active' : ''}`}
            onClick={() => setTab(tk)}
          >
            {t(labelKey)}
          </Button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {tab === 'sources' && (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {sourcesPanel}
          </div>
        )}
        {tab === 'chat' && chatPanel}
        {tab === 'dock' && (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {/* Internal segment tabs (Обзор/Заметки/Студия) — usable on a phone. */}
            <div
              className="nn-chrome"
              style={{
                display: 'flex',
                padding: '8px 10px',
                borderBottom: '1px solid var(--border)',
                flexShrink: 0,
              }}
            >
              {dockSegments}
            </div>
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              {dockContent}
            </div>
          </div>
        )}
      </div>
      {/* Citation viewer — fullscreen sheet (mobile). */}
      {citationViewer}
    </div>
  );
};

// ── Right-dock collapsed rail (desktop) ────────────────────────────────────────
// A thin vertical strip with a single «expand» affordance — clicking re-opens the
// dock. Cheap to render; keeps the chat column wide while collapsed.

const DockExpandRail = ({ label, onExpand }: { label: string; onExpand: () => void }) => (
  <div
    style={{
      width: 40,
      flexShrink: 0,
      borderLeft: '1px solid var(--panel-edge)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      paddingTop: 8,
      background: 'var(--surface)',
    }}
  >
    <NNBtn variant="ghost" size="sm" icon="doc" ariaLabel={label} title={label} onClick={onExpand} />
  </div>
);

// ── Left: sources panel ──────────────────────────────────────────────────────

interface SourcesPanelProps {
  navigationScope: string;
  sources: Source[];
  loaded: boolean;
  scope: Set<string>;
  addOpen: boolean;
  addProps: React.ComponentProps<typeof AddSourceForm>;
  onOpenAdd: () => void;
  onAttachFromLibrary: () => void;
  onToggleScope: (id: string) => void;
  /** Number of READY sources (the selectable pool). */
  readyCount: number;
  /** Number of READY sources currently checked into the chat scope. */
  selectedCount: number;
  /** True when every readable source is checked (drives the select-all box). */
  allSelected: boolean;
  onToggleSelectAll: () => void;
  onRename: (src: Source) => void;
  onDetach: (src: Source) => void;
  onReadInLibrary: (src: Source) => void;
  listSourceCards: (id: string) => Promise<SourceLinkedCard[]>;
  onOpenCard: (cardId: string) => void;
  t: Tfn;
}

const SourcesPanel = ({
  navigationScope,
  sources,
  loaded,
  scope,
  addOpen,
  addProps,
  onOpenAdd,
  onAttachFromLibrary,
  onToggleScope,
  readyCount,
  selectedCount,
  allSelected,
  onToggleSelectAll,
  onRename,
  onDetach,
  onReadInLibrary,
  listSourceCards,
  onOpenCard,
  t,
}: SourcesPanelProps) => {
  const position=useNavigationScroll(navigationScope,'sources',{ready:loaded});
  return (
  <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
    {/* Rail header — «Источники» + mono count + add. */}
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '0 14px',
        height: 44,
        flexShrink: 0,
        borderBottom: '1px solid var(--border)',
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
        {t('notebooks.sources.heading')}
      </span>
      <span className="nn-chrome" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-dim)' }}>
        {sources.length}
      </span>
      <span style={{ flex: 1 }} />
      <NNBtn
        variant="ghost"
        size="sm"
        icon="plus"
        ariaLabel={t('notebooks.sources.add')}
        title={t('notebooks.sources.add')}
        onClick={onOpenAdd}
      />
    </div>

    <div ref={position.ref} className="nn-scroll" style={{ flex: 1, overflowY: 'auto', padding: '12px 12px 8px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* «Подключить из библиотеки» — dashed connect button. */}
      <Button variant="bare" type="button" className="nn-nb-connect" onClick={onAttachFromLibrary}>
        <NNIcon name="book" size={15} color="var(--lime-400)" />
        <span style={{ flex: 1 }}>{t('notebooks.sources.connectFromLibrary')}</span>
        <NNIcon name="chevr" size={13} color="var(--text-dim)" />
      </Button>

      {addOpen && <AddSourceForm {...addProps} />}

      {/* «В этом блокноте» label + «все» + select-all checkbox. */}
      {sources.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px 2px' }}>
          <span
            className="nn-chrome"
            style={{
              flex: 1,
              fontSize: 10.5,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              color: 'var(--text-dim)',
            }}
          >
            {t('notebooks.sources.inThisNotebook')}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{t('notebooks.sources.all')}</span>
          <NNCheck
            on={allSelected}
            disabled={readyCount === 0}
            label={allSelected ? t('notebooks.sources.clearSelection') : t('notebooks.sources.selectAll')}
            onChange={onToggleSelectAll}
          />
        </div>
      )}

      {!loaded ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <NNSkeleton style={{ height: 50 }} />
          <NNSkeleton style={{ height: 50 }} />
          <NNSkeleton style={{ height: 50 }} />
        </div>
      ) : sources.length === 0 ? (
        <div className="nn-empty-state" style={{ paddingTop: 24, paddingBottom: 24 }}>
          <span className="nn-empty-state-icon"><NNIcon name="stack" size={28} color="var(--text-dim)" /></span>
          <p className="nn-empty-state-hint">{t('notebooks.sources.empty')}</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {sources.map((src) => (
            <WorkspaceSourceRow
              key={src.id}
              source={src}
              inScope={scope.has(src.id)}
              onToggleScope={() => onToggleScope(src.id)}
              onRename={() => onRename(src)}
              onDetach={() => onDetach(src)}
              onReadInLibrary={() => onReadInLibrary(src)}
              listSourceCards={listSourceCards}
              onOpenCard={onOpenCard}
              t={t}
            />
          ))}
        </div>
      )}
    </div>

    {/* Footer — «Выбрано N из M» + lime select-all / clear link. */}
    {sources.length > 0 && (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '12px 14px',
          flexShrink: 0,
          borderTop: '1px solid var(--border)',
        }}
      >
        <span style={{ flex: 1, fontSize: 11.5, color: 'var(--text-dim)' }}>
          {t('notebooks.sources.selectedOf', { count: selectedCount, total: readyCount })}
        </span>
        <Button variant="bare"
          type="button"
          className="nn-nb-rail-link"
          disabled={readyCount === 0}
          onClick={onToggleSelectAll}
          style={readyCount === 0 ? { opacity: 0.4, cursor: 'default' } : undefined}
        >
          {allSelected ? t('notebooks.sources.clearSelection') : t('notebooks.sources.selectAll')}
        </Button>
      </div>
    )}
  </div>
);
};

// ── NBCheck — the lime-filled «in chat» scope checkbox (visually hidden native
//    input for a11y + a painted box, matching the design's NBCheck). ──────────
const NNCheck = ({
  on,
  disabled = false,
  label,
  onChange,
}: {
  on: boolean;
  disabled?: boolean;
  label: string;
  onChange: () => void;
}) => (
  <label
    style={{
      display: 'inline-flex',
      cursor: disabled ? 'default' : 'pointer',
      flexShrink: 0,
      position: 'relative',
    }}
    title={label}
  >
    <TextInput
      type="checkbox"
      className="nn-nb-check-input"
      checked={on}
      disabled={disabled}
      onChange={onChange}
      aria-label={label}
      style={{
        position: 'absolute',
        opacity: 0,
        width: 16,
        height: 16,
        margin: 0,
        cursor: disabled ? 'default' : 'pointer',
      }}
    />
    <span className={`nn-nb-check${on ? ' on' : ''}${disabled ? ' disabled' : ''}`} aria-hidden>
      {on && <NNIcon name="check" size={11} color="var(--text-on-accent)" strokeWidth={2.6} />}
    </span>
  </label>
);

const WorkspaceSourceRow = ({
  source,
  inScope,
  onToggleScope,
  onRename,
  onDetach,
  onReadInLibrary,
  listSourceCards,
  onOpenCard,
  t,
}: {
  source: Source;
  inScope: boolean;
  onToggleScope: () => void;
  onRename: () => void;
  onDetach: () => void;
  onReadInLibrary: () => void;
  listSourceCards: (id: string) => Promise<SourceLinkedCard[]>;
  onOpenCard: (cardId: string) => void;
  t: Tfn;
}) => {
  const isError = source.status === 'error';
  const ready = source.status === 'ready';
  const readable = isSourceTextReadable(source.status, source.errorCode);
  const statusLabel = sourceOperationLabel(source, t) ?? (isError && source.errorCode
      ? t(`notebooks.status.${source.errorCode as IngestErrorCode}`)
      : t(`notebooks.status.${source.status}`));

  // Subline: ready → «{author} · прочитано N%» (author → kind label when absent;
  // percent omitted when null). Non-ready rows show the ingest status badge.
  const kindLabel = t(
    source.kind === 'pdf'
      ? 'notebooks.sources.kindPdf'
      : source.kind === 'epub'
        ? 'notebooks.sources.kindEpub'
        : source.kind === 'url'
          ? 'notebooks.sources.kindUrl'
          : source.kind === 'youtube'
            ? 'notebooks.sources.kindYoutube'
            : 'notebooks.sources.kindText',
  );
  const sublineParts: string[] = [];
  if (ready) {
    sublineParts.push(source.author?.trim() || kindLabel);
    if (typeof source.readingPercent === 'number') {
      sublineParts.push(t('notebooks.sources.readPercent', { pct: Math.round(source.readingPercent * 100) }));
    }
  }
  const subline = sublineParts.join(' · ');

  const [cardsOpen, setCardsOpen] = useState(false);
  const [cards, setCards] = useState<SourceLinkedCard[] | null>(null);
  const [cardsLoading, setCardsLoading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const toggleCards = useCallback(async () => {
    const next = !cardsOpen;
    setCardsOpen(next);
    if (next && cards === null && !cardsLoading) {
      setCardsLoading(true);
      try {
        setCards(await listSourceCards(source.id));
      } catch {
        setCards([]);
      } finally {
        setCardsLoading(false);
      }
    }
  }, [cardsOpen, cards, cardsLoading, listSourceCards, source.id]);

  return (
    <div className="nn-source-row" data-navigation-anchor={source.id}>
      {/* Main row: mini-cover + title/subline (→ read in library) + lime check */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Button variant="bare"
          type="button"
          onClick={onReadInLibrary}
          title={t('assistant.readSource')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flex: 1,
            minWidth: 0,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            textAlign: 'left',
          }}
        >
          <SourceCover source={source} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span
              style={{
                display: 'block',
                fontSize: 13,
                fontWeight: 500,
                color: 'var(--text)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {source.title}
            </span>
            {ready ? (
              subline && (
                <span
                  style={{
                    display: 'block',
                    fontSize: 11,
                    color: 'var(--text-dim)',
                    marginTop: 1,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {subline}
                </span>
              )
            ) : (
              <span style={{ display: 'inline-flex', marginTop: 3 }}>
                <NNBadge tone={statusTone(source.status)} size="xs">
                  {statusLabel}
                </NNBadge>
              </span>
            )}
          </span>
        </Button>
        {readable && (
          <NNCheck
            on={inScope}
            label={t('notebooks.workspace.inChat')}
            onChange={onToggleScope}
          />
        )}
        {/* One compact ⋯ only — rename/cards/library/detach all live in the menu.
            Two inline buttons + a sub-row crushed the 292px rail (titles ellipsed
            to nothing); reference rows are cover · text · check, actions hidden. */}
        <div className="nn-source-row-actions" style={{ flexShrink: 0, position: 'relative' }}>
          <Button variant="bare"
            type="button"
            className="nn-nb-icon-btn"
            aria-label={t('library.item.menu')}
            title={t('library.item.menu')}
            onClick={() => setMenuOpen((v) => !v)}
            style={{
              width: 28,
              height: 28,
              flexShrink: 0,
              borderRadius: 8,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'transparent',
              border: 'none',
              color: 'var(--text-dim)',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            <NNIcon name="dots" size={14} />
          </Button>
          {menuOpen && (
            <>
              <div onClick={() => setMenuOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 40 }} />
              <div className="nn-lib-menu" style={{ right: 0, top: 'calc(100% + 4px)', minWidth: 200 }}>
                <Button variant="bare"
                  type="button"
                  className="nn-lib-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onRename();
                  }}
                >
                  <NNIcon name="edit" size={14} color="var(--text-muted)" />
                  {t('notebooks.sources.rename')}
                </Button>
                {readable && (
                  <Button variant="bare"
                    type="button"
                    className="nn-lib-menu-item"
                    onClick={() => {
                      setMenuOpen(false);
                      void toggleCards();
                    }}
                  >
                    <NNIcon name="stack" size={14} color="var(--text-muted)" />
                    {cards === null
                      ? t('notebooks.workspace.cardsButton')
                      : t('notebooks.workspace.cardsCount', { count: cards.length })}
                  </Button>
                )}
                <Button variant="bare"
                  type="button"
                  className="nn-lib-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onReadInLibrary();
                  }}
                >
                  <NNIcon name="book" size={14} color="var(--text-muted)" />
                  {t('assistant.readSource')}
                </Button>
                <Button variant="bare"
                  type="button"
                  className="nn-lib-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onDetach();
                  }}
                >
                  <NNIcon name="x" size={14} color="var(--text-muted)" />
                  {t('library.workspace.detach')}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>

      {cardsOpen && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4, paddingLeft: 20 }}>
          {cardsLoading ? (
            <NNSkeleton style={{ height: 28 }} />
          ) : (cards ?? []).length === 0 ? (
            <span style={{ fontSize: 11, color: 'var(--text-dim)', padding: '2px 0' }}>
              {t('notebooks.workspace.cardsEmpty')}
            </span>
          ) : (
            (cards ?? []).map((c) => (
              <Button variant="bare"
                key={c.cardId}
                type="button"
                onClick={() => onOpenCard(c.cardId)}
                title={c.front}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '4px 6px',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r-xs)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  width: '100%',
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    color: 'var(--text-muted)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                    flex: 1,
                  }}
                >
                  {c.front}
                </span>
                <NNIcon name="chevr" size={10} color="var(--text-dim)" />
              </Button>
            ))
          )}
        </div>
      )}
    </div>
  );
};

// ── L1 — "Add from library" attach picker (modal) ──────────────────────────────

const LibraryAttachPicker = ({
  notebookId,
  attachedIds,
  listLibrary,
  suggestSources,
  onConfirm,
  onClose,
  t,
}: {
  notebookId: string;
  attachedIds: Set<string>;
  listLibrary: (params?: { q?: string; limit?: number }) => Promise<{ items: LibraryItem[]; nextCursor: string | null }>;
  suggestSources: (notebookId: string) => Promise<SuggestSourcesResult>;
  onConfirm: (sourceIds: string[]) => Promise<void> | void;
  onClose: () => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) => {
  const [search, setSearch] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  // N4 (Р11): recommendations fetched ONCE when the picker opens.
  const [suggested, setSuggested] = useState<SuggestedSource[]>([]);

  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedQ(search.trim()), 300);
    return () => window.clearTimeout(id);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await listLibrary({ q: debouncedQ || undefined, limit: 60 });
        if (!cancelled) setItems(res.items);
      } catch {
        if (!cancelled) setItems([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [listLibrary, debouncedQ]);

  // Recommendations: fetched once on open. Already-attached items are filtered
  // out (the server already excludes attached sources, but a race could slip
  // one through). Empty / not_indexed ⇒ no section.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await suggestSources(notebookId);
        if (!cancelled) setSuggested(res.items.filter((s) => !attachedIds.has(s.sourceId)));
      } catch {
        if (!cancelled) setSuggested([]);
      }
    })();
    return () => {
      cancelled = true;
    };
    // attachedIds is a fresh Set each render; the suggest fetch is open-once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggestSources, notebookId]);

  const toggle = useCallback((id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const confirm = useCallback(async () => {
    if (picked.size === 0 || busy) return;
    setBusy(true);
    await onConfirm([...picked]);
    setBusy(false);
  }, [picked, busy, onConfirm]);

  return (
    <>
      <div className="nn-dialog-backdrop" onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'var(--scrim)' }} />
      <div style={{ position: 'fixed', inset: 0, zIndex: 91, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, pointerEvents: 'none' }}>
        <NNCard padding={16} style={{ width: 460, maxWidth: '100%', maxHeight: '76vh', display: 'flex', flexDirection: 'column', gap: 10, pointerEvents: 'auto', boxShadow: 'var(--shadow-lg)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h3 style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', margin: 0, flex: 1, fontFamily: 'var(--font-sans)' }}>
              {t('library.workspace.attachTitle')}
            </h3>
            <NNBtn variant="ghost" size="sm" icon="x" ariaLabel={t('library.details.close')} onClick={onClose} />
          </div>

          <TextInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('library.workspace.attachSearch')}
            style={{
              width: '100%',
              height: 32,
              padding: '0 10px',
              fontSize: 13,
              fontFamily: 'var(--font-sans)',
              color: 'var(--text)',
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r-sm)',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />

          {/* N4 (Р11): «Рекомендуем» — sources near the notebook's centroid.
              Hidden while a search query is active (it filters the main list, not
              the recs) and when there are no recommendations. */}
          {!debouncedQ && suggested.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span
                className="nn-chrome"
                style={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                  color: 'var(--text-dim)',
                  padding: '0 2px',
                }}
              >
                {t('notebooks.attach.suggestedHeading')}
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {suggested.map((s) => {
                  const checked = picked.has(s.sourceId);
                  return (
                    <label
                      key={s.sourceId}
                      className="nn-lib-nb-link"
                      style={{
                        cursor: 'pointer',
                        background: checked ? 'var(--surface-3)' : 'var(--surface-2)',
                      }}
                    >
                      <TextInput
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(s.sourceId)}
                        style={{ width: 14, height: 14, accentColor: 'var(--accent-500)', flexShrink: 0, cursor: 'pointer' }}
                      />
                      <NNIcon name={s.kind === 'youtube' ? 'play' : s.kind === 'url' ? 'link' : s.kind === 'text' ? 'edit' : 'book'} size={13} color="var(--text-muted)" />
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>
                        {s.title}
                      </span>
                      <NNBadge tone="lime" size="xs">
                        {t('notebooks.attach.suggestedMatch', { pct: Math.round(s.score * 100) })}
                      </NNBadge>
                    </label>
                  );
                })}
              </div>
              <div style={{ height: 1, background: 'var(--border)', margin: '4px 0 0' }} />
            </div>
          )}

          <div className="nn-scroll" style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2, minHeight: 80 }}>
            {items === null ? (
              <NNSkeleton style={{ height: 100 }} />
            ) : items.length === 0 ? (
              <p style={{ fontSize: 12.5, color: 'var(--text-dim)', textAlign: 'center', padding: '24px 0', margin: 0 }}>
                {debouncedQ ? t('library.workspace.attachNoResults') : t('library.workspace.attachEmpty')}
              </p>
            ) : (
              items.map((it) => {
                const already = attachedIds.has(it.id);
                const checked = picked.has(it.id);
                return (
                  <label
                    key={it.id}
                    className="nn-lib-nb-link"
                    style={{
                      cursor: already ? 'default' : 'pointer',
                      opacity: already ? 0.5 : 1,
                      background: checked ? 'var(--surface-3)' : 'var(--surface-2)',
                    }}
                  >
                    <TextInput
                      type="checkbox"
                      checked={checked || already}
                      disabled={already}
                      onChange={() => !already && toggle(it.id)}
                      style={{ width: 14, height: 14, accentColor: 'var(--accent-500)', flexShrink: 0, cursor: already ? 'default' : 'pointer' }}
                    />
                    <NNIcon name={it.kind === 'youtube' ? 'play' : it.kind === 'url' ? 'link' : it.kind === 'text' ? 'edit' : 'book'} size={13} color="var(--text-muted)" />
                    <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' }}>
                      {it.title}
                    </span>
                    {already && <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{t('library.details.alreadyIn')}</span>}
                  </label>
                );
              })
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <NNBtn variant="ghost" size="sm" onClick={onClose} disabled={busy}>{t('actions.cancel')}</NNBtn>
            <NNBtn variant="primary" size="sm" onClick={confirm} disabled={picked.size === 0 || busy}>
              {t('library.workspace.attachConfirm', { count: picked.size })}
            </NNBtn>
          </div>
        </NNCard>
      </div>
    </>
  );
};
