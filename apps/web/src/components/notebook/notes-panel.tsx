'use client';

/* eslint-disable react/forbid-elements -- TODO: replace raw input, select, and button with TextInput, Button, or NNSelect. */

import { useWorkspaceState } from '@/components/navigation';
import { useNavigationScroll } from '@/lib/use-navigation-scroll';
import { AssistantAskButton } from '../chat/assistant-ask-button';

// NotesPanel («Блокноты 2.0» N1, Р12 «Заметки» tab) — the right-dock notes
// surface of a notebook workspace.
//
//  • Search (debounce 300ms → server `?q=`), list (pinned-first from the server)
//    with title + excerpt + a kind badge («ответ» for kind='answer') + a pin
//    affordance.
//  • Click a row → a viewer that renders the markdown content through the SAME
//    pipeline cards use (renderCardHtml → SafeHtml). [src:] grounding tokens stay
//    as plain text in N1 (the citation chips land in N2). Actions: edit (textarea),
//    pin/unpin, delete (confirm), «В карточки» → prefill the chat composer.
//  • Create: «+ Заметка» → an inline title+content form. NOTE_CONTENT_MAX is
//    surfaced live (char counter) and over-cap submit is blocked client-side.
//
// All data is panel-local; the parent owns the store methods + the imperative
// composer-prefill handoff. Inline styles + CSS vars + ui.tsx primitives only.

import { NotePinButton } from './note-pin-button';
import { WrittenNoteEditor } from './written-note-editor';
import { useNN } from '@/lib/store';
import { ReadingText, TextInput } from '@/components/design-system/primitives';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NNBtn, NNIcon, NNBadge, NNSkeleton } from '@/components/ui';
import { renderCardHtml, SafeHtml } from '@/lib/render-card';
import { useDialog } from '@/components/dialog';
import { raiseToast } from '@/components/toasts';
import type { NotebookNote } from '@/lib/types';
import type { CreateNoteInput } from '@/lib/store';

// A single-field "basic" note-type that feeds note markdown through the card
// render pipeline (markdown-it → DOMPurify via SafeHtml) — same pattern as the
// chat AssistantMarkdown. The sanitizer stays the single security boundary.
const NOTE_MD_NOTE_TYPE = {
  kind: 'basic' as const,
  templates: [{ name: 'note', ord: 0, frontTemplate: '{{Body}}', backTemplate: '{{Body}}' }],
};

type Tfn = (key: string, params?: Record<string, string | number>) => string;

export interface NotesPanelProps {
  notebookId?: string;
  studyScope?: { kind: 'source'; id: string } | { kind: 'saved' };
  allowCreate?: boolean;
  initialCreate?: boolean;
  initialNoteId?: string | null;
  onInitialOpen?: () => void;
  getNote?: (scopeId: string, noteId: string) => Promise<NotebookNote>;
  listNotes: (scopeId: string, q?: string, offset?: number) => Promise<NotebookNote[] | { items: NotebookNote[]; nextOffset: number | null }>;
  createNote: (notebookId: string, input: CreateNoteInput) => Promise<NotebookNote>;
  patchNote: (
    notebookId: string,
    noteId: string,
    patch: { title?: string; content?: string; pinned?: boolean },
  ) => Promise<NotebookNote>;
  deleteNote: (notebookId: string, noteId: string) => Promise<void>;
  /** «В карточки» — prefill the chat composer with a make-flashcards prompt. */
  onPrefillChat: (text: string, noteId?: string) => void;
  /** Imperative refresh handle the parent can call after a save-from-chat. */
  refreshRef?: React.MutableRefObject<(() => void) | null>;
  t: Tfn;
}

const NoteMarkdown = ({ content }: { content: string }) => {
  const html = useMemo(
    () => renderCardHtml(NOTE_MD_NOTE_TYPE, { Body: content }, 'front'),
    [content],
  );
  return (
    <ReadingText><SafeHtml
      html={html}
      style={{
        fontFamily: 'inherit',
        fontSize: 'inherit',
        lineHeight: 'inherit',
        color: 'var(--text)',
        wordBreak: 'break-word',
      }}
    /></ReadingText>
  );
};

export const NotesPanel = ({
  notebookId: legacyNotebookId,
  studyScope,
  allowCreate = true,
  initialCreate = false,
  initialNoteId: requestedInitialNoteId,
  onInitialOpen,
  listNotes,
  getNote,
  deleteNote,
  onPrefillChat,
  refreshRef,
  t,
}: NotesPanelProps) => {
  const { confirm } = useDialog();
  const account = useNN(state => state.profile?.userId) ?? '';
  const closeGuardRef = useRef<(() => Promise<boolean>) | null>(null);
  const guarded = async (action: () => void) => { if (!closeGuardRef.current || await closeGuardRef.current()) action(); };
  const notebookId = studyScope?.kind === 'source' ? studyScope.id : studyScope?.kind === 'saved' ? '' : legacyNotebookId ?? '';
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  const [notes, setNotes] = useState<NotebookNote[]>([]);
  const [loaded, setLoaded] = useState(false);
  const openIntent = useRef(0);
  useEffect(() => () => { openIntent.current++; }, [notebookId]);
  const consumedInitial = useRef<string | null>(null);
  const refreshSequence = useRef(0);
  useEffect(() => () => { refreshSequence.current++; }, [notebookId]);
  const [search, setSearch] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');

  // Which note is open (viewer/editor); null = list view.
  const navigationScope = studyScope?.kind === 'source' ? `source:${notebookId}` : `notebook:${notebookId}`;
  const [openId, setOpenId] = useWorkspaceState<string | null>(navigationScope,'noteId',null);
  const initialNoteId=requestedInitialNoteId??openId;
  const notePosition=useNavigationScroll(navigationScope,'note',{ready:loaded,queryKey:openId??''});
  const listPosition=useNavigationScroll(navigationScope,'notes-list',{ready:loaded});
  const openNoteRef = useRef(openId);
  openNoteRef.current = openId;
  const notesOwnerRef = useRef(notebookId);
  const [editing, setEditing] = useWorkspaceState(navigationScope, 'noteEditing', false);

  // Create form.
  const [creating, setCreating] = useWorkspaceState(navigationScope, 'noteCreating', false);

  useEffect(() => { if (initialCreate && allowCreate) setCreating(true); }, [initialCreate, allowCreate]);

  // ── Debounce the search query (300ms) ─────────────────────────────────────────
  useEffect(() => {
    const id = window.setTimeout(() => setDebouncedQ(search.trim()), 300);
    return () => window.clearTimeout(id);
  }, [search]);

  const refresh = useCallback(
    async (q: string) => {
      const sequence = ++refreshSequence.current;
      try {
        const rows = await listNotes(notebookId, q || undefined);
        if (sequence !== refreshSequence.current) return;
        const items = Array.isArray(rows) ? rows : rows.items;
        const sameOwner = notesOwnerRef.current === notebookId;
        notesOwnerRef.current = notebookId;
        // A first-page refresh is not evidence that a note opened by its ID was
        // deleted. Keep that viewer snapshot until the user leaves it; a newer
        // copy in the page wins. Never carry it into a different study owner.
        setNotes(previous => {
          const active = sameOwner ? previous.find(note => note.id === openNoteRef.current) : undefined;
          return active && !items.some(note => note.id === active.id) ? [...items, active] : items;
        });
        setNextOffset(Array.isArray(rows) ? null : rows.nextOffset);
        setLoadError(false);
      } catch {
        if (sequence === refreshSequence.current) setLoadError(true);
      } finally {
        if (sequence === refreshSequence.current) setLoaded(true);
      }
    },
    [listNotes, notebookId],
  );

  useEffect(() => {
    void refresh(debouncedQ);
  }, [debouncedQ, refresh]);

  const loadMore = async () => {
    if (nextOffset === null || loadingMore) return;
    const sequence = refreshSequence.current;
    setLoadingMore(true);
    try {
      const page = await listNotes(notebookId, debouncedQ || undefined, nextOffset);
      if (sequence !== refreshSequence.current) return;
      const items = Array.isArray(page) ? page : page.items;
      setNotes(previous => [...new Map([...previous, ...items].map(note => [note.id, note])).values()]);
      setNextOffset(Array.isArray(page) ? null : page.nextOffset); setLoadError(false);
    } catch { if (sequence === refreshSequence.current) setLoadError(true); }
    finally { setLoadingMore(false); }
  };

  // Expose an imperative refresh to the parent (used after «save answer from chat»).
  useEffect(() => {
    if (!refreshRef) return;
    refreshRef.current = () => void refresh(debouncedQ);
    return () => {
      refreshRef.current = null;
    };
  }, [refreshRef, refresh, debouncedQ]);

  const openNote = useMemo(
    () => (openId ? notes.find((n) => n.id === openId) ?? null : null),
    [notes, openId],
  );

  useEffect(() => {
    if (!initialNoteId) { consumedInitial.current = null; openIntent.current++; return; }
    if (!loaded || loadError || consumedInitial.current === initialNoteId) return;
    if (search || debouncedQ) { setLoaded(false); setSearch(''); setDebouncedQ(''); void refresh(''); return; }
    consumedInitial.current = initialNoteId;
    const intent = ++openIntent.current;
    if (notes.some(note => note.id === initialNoteId)) { setOpenId(initialNoteId); setEditing(false); }
    else if (getNote) {
      void getNote(notebookId,initialNoteId).then(note => {
        if (openIntent.current !== intent) return;
        setNotes(previous => [...previous.filter(item => item.id !== note.id),note]);
        setOpenId(note.id);setEditing(false);onInitialOpen?.();
      }).catch(error => {
        if (openIntent.current !== intent) return;
        if (error?.status === 404) { setOpenId(null); raiseToast({kind:'error',title:t('notebooks.notes.notFound')});onInitialOpen?.(); }
        else {consumedInitial.current=null;setLoadError(true);}
      });
      return;
    } else raiseToast({ kind: 'error', title: t('notebooks.notes.notFound') });
    onInitialOpen?.();
  }, [initialNoteId, loaded, loadError, notes, search, debouncedQ, onInitialOpen, refresh, getNote, notebookId, t, setOpenId]);

  const resetCreate = () => setCreating(false);
  const startEdit = () => setEditing(true);
  const saved = (note: NotebookNote, close: boolean) => {
    setNotes(previous => [note, ...previous.filter(item => item.id !== note.id)]);
    if (close) { setCreating(false); setEditing(false); setOpenId(note.id); }
  };
  const editorOwner = studyScope?.kind === 'source' ? { kind: 'source' as const, id: notebookId }
    : legacyNotebookId ? { kind: 'notebook' as const, id: legacyNotebookId } : undefined;

  // ── Pin / delete / to-cards ───────────────────────────────────────────────────
  const pinUpdated = (updated: NotebookNote) => setNotes(previous => previous.map(note => note.id === updated.id ? updated : note)
    .sort((a, b) => a.pinned === b.pinned ? Date.parse(b.updatedAt) - Date.parse(a.updatedAt) : a.pinned ? -1 : 1));

  const removeNote = useCallback(
    async (n: NotebookNote) => {
      const yes = await confirm({
        title: t('notebooks.notes.delete'),
        message: t('notebooks.notes.deleteConfirm'),
        danger: true,
        confirmLabel: t('notebooks.notes.delete'),
      });
      if (!yes) return;
      try {
        await deleteNote(notebookId, n.id);
        setNotes((prev) => prev.filter((x) => x.id !== n.id));
        if (openId === n.id) {
          setOpenId(null);
          setEditing(false);
        }
      } catch {
        raiseToast({ kind: 'info', title: t('notebooks.notes.createFailed') });
      }
    },
    [confirm, t, deleteNote, notebookId, openId],
  );

  const toCards = useCallback(
    (n: NotebookNote) => {
      onPrefillChat(t('notebooks.notes.toCardsPrompt', { content: n.content }), n.id);
    },
    [onPrefillChat, t],
  );

  // ── Render: note viewer / editor ───────────────────────────────────────────────
  if (openNote) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 10px',
            borderBottom: '1px solid var(--border)',
            flexShrink: 0,
          }}
        >
          <NNBtn
            variant="ghost"
            size="sm"
            icon="chevl"
            onClick={() => void guarded(() => { setOpenId(null); setEditing(false); })}
          >
            {t('notebooks.notes.back')}
          </NNBtn>
          <span style={{ flex: 1 }} />
          {!editing && <AssistantAskButton object={{ kind: 'written_note', id: openNote.id }} compact />}
          {openNote.ownerKind === 'source' && <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{openNote.sourceOriginTitle}{!openNote.sourceId ? ` · ${t('assistant.unavailable')}` : ''}</span>}
          {!editing && (
            <>
              <NotePinButton note={openNote} onUpdated={pinUpdated} readCurrent={getNote ? () => getNote(notebookId, openNote.id) : undefined} />
              <NNBtn
                variant="ghost"
                size="sm"
                icon="edit"
                ariaLabel={t('notebooks.notes.edit')}
                title={t('notebooks.notes.edit')}
                onClick={startEdit}
              />
              <NNBtn
                variant="ghost"
                size="sm"
                icon="x"
                ariaLabel={t('notebooks.notes.delete')}
                title={t('notebooks.notes.delete')}
                onClick={() => void removeNote(openNote)}
              />
            </>
          )}
        </div>

        <div ref={notePosition.ref} className="nn-scroll" style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
          {editing ? (
            <WrittenNoteEditor key={`${account}:${openNote.id}`} note={openNote} studyOwner={editorOwner} closeGuardRef={closeGuardRef}
              onSaved={saved} onClose={() => setEditing(false)} getCurrent={getNote ? id => getNote(notebookId, id) : undefined} />
          ) : (
            <>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 10,
                }}
              >
                <h3
                  style={{
                    fontSize: 15,
                    fontWeight: 700,
                    color: 'var(--text)',
                    margin: 0,
                    fontFamily: 'var(--font-sans)',
                    flex: 1,
                    minWidth: 0,
                    wordBreak: 'break-word',
                  }}
                >
                  {openNote.title}
                </h3>
                {openNote.kind === 'answer' && (
                  <NNBadge tone="violet" size="xs">
                    {t('notebooks.notes.badgeAnswer')}
                  </NNBadge>
                )}
              </div>
              <NoteMarkdown content={openNote.content} />
              <div style={{ marginTop: 16 }}>
                <NNBtn variant="soft" size="sm" icon="stack" onClick={() => toCards(openNote)}>
                  {t('notebooks.notes.toCards')}
                </NNBtn>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // ── Render: list ────────────────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          padding: '12px 14px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            className="nn-chrome"
            style={{
              fontSize: 11,
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.07em',
              color: 'var(--text-dim)',
              flex: 1,
            }}
          >
            {t('notebooks.notes.heading')}
          </span>
          {allowCreate && <NNBtn
            variant="soft"
            size="sm"
            icon="plus"
            onClick={() => void guarded(() => { openIntent.current++; if (initialNoteId) onInitialOpen?.(); setCreating(v => !v); })}
            active={creating}
          >
            {t('notebooks.notes.add')}
          </NNBtn>}
        </div>

        <div style={{ position: 'relative' }}>
          <span
            style={{
              position: 'absolute',
              left: 8,
              top: '50%',
              transform: 'translateY(-50%)',
              pointerEvents: 'none',
              display: 'flex',
            }}
          >
            <NNIcon name="search" size={13} color="var(--text-dim)" />
          </span>
          <TextInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label={t('notebooks.notes.search')}
            placeholder={t('notebooks.notes.search')}
            style={{ paddingLeft: 30 }}
          />
        </div>

        {creating && <WrittenNoteEditor key={`${account}:${notebookId}:new`} studyOwner={editorOwner} closeGuardRef={closeGuardRef}
          onSaved={saved} onClose={resetCreate} getCurrent={getNote ? id => getNote(notebookId, id) : undefined} />}

      </div>

      <div ref={listPosition.ref} className="nn-scroll" style={{ flex: 1, overflowY: 'auto', padding: '8px 8px 12px' }}>
        {loadError && <p role="alert">{t('assistant.notesLoadFailed')} <NNBtn size="sm" onClick={() => void refresh(debouncedQ)}>{t('review.retry')}</NNBtn></p>}
        {nextOffset !== null && <NNBtn size="sm" loading={loadingMore} onClick={() => void loadMore()}>{t('assistant.more')}</NNBtn>}
        {!loaded ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <NNSkeleton style={{ height: 52 }} />
            <NNSkeleton style={{ height: 52 }} />
          </div>
        ) : notes.length === 0 ? (
          <div className="nn-empty-state" style={{ paddingTop: 28, paddingBottom: 28 }}>
            <span className="nn-empty-state-icon">
              <NNIcon name="doc" size={26} color="var(--text-dim)" />
            </span>
            <p className="nn-empty-state-hint">
              {debouncedQ ? t('notebooks.notes.searchEmpty') : t('notebooks.notes.empty')}
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {notes.map((n) => (
              <NoteRow
                key={n.id}
                note={n}
                onOpen={() => void guarded(() => {
                  openIntent.current++;
                  if (initialNoteId) onInitialOpen?.();
                  setOpenId(n.id);
                  setEditing(false); setCreating(false);
                })}
                pin={<NotePinButton note={n} onUpdated={pinUpdated} readCurrent={getNote ? () => getNote(notebookId, n.id) : undefined} />}
                t={t}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const NoteRow = ({
  note,
  onOpen,
  pin,
  t,
}: {
  note: NotebookNote;
  onOpen: () => void;
  pin: React.ReactNode;
  t: Tfn;
}) => (
  <div className="nn-source-row" style={{ cursor: 'pointer' }}>
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
      <button
        type="button"
        onClick={onOpen}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
          flex: 1,
          minWidth: 0,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: 0,
          textAlign: 'left',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
          {note.pinned && <NNIcon name="pin" size={11} color="var(--lime-400)" />}
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
              flex: 1,
            }}
          >
            {note.title}
          </span>
          {note.kind === 'answer' && (
            <NNBadge tone="violet" size="xs">
              {t('notebooks.notes.badgeAnswer')}
            </NNBadge>
          )}
        </span>
        {note.excerpt && (
          <span
            style={{
              fontSize: 11.5,
              color: 'var(--text-dim)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: '100%',
            }}
          >
            {note.excerpt}
          </span>
        )}
      </button>
      <div className="nn-source-row-actions" style={{ display: 'flex', flexShrink: 0 }}>
        {pin}
      </div>
    </div>
  </div>
);
