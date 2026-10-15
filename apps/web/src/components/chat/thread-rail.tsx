'use client';

/* eslint-disable react/forbid-elements -- TODO: replace raw input, select, and button with TextInput, Button, or NNSelect. */

import { restoreLayerFocus } from '@/lib/use-transient-layer';

// ThreadRail — the chat screen's left rail, extracted from chat.tsx (A-pack).
// Adds: search-as-you-filter (A1), date-grouped sections with a Pinned group on
// top (A2/C4 — pure helpers from lib/chat-threads), and a pin/unpin affordance
// per row. Inline rename + delete behave exactly as before (state moved here).
// Hand-rolled styles (inline + CSS vars, Principle 4); primitives from ui.tsx.

import React, { useMemo, useState, useLayoutEffect, useCallback, useEffect } from 'react';
import { ThreadContextMenu } from './thread-context-menu';
import { ResizeHandle } from '@/components/design-system/resize-handle';
import { CHAT_RAIL, boundedPanelWidth, readChatRailWidth } from '@/lib/panel-width';
import { writeBrowserValue } from '@/lib/storage-migration';
import { TextInput } from '@/components/design-system/primitives';
import { NNBtn, NNIcon, NNSkeleton } from '@/components/ui';
import {
  conversationTitle,
  filterThreads,
  groupThreads,
  relativeUpdated,
  type ConversationVM,
  type ThreadGroupKey,
} from '@/lib/chat-threads';

type T = (key: string, params?: Record<string, string | number>) => string;

const GROUP_LABEL_KEY: Record<ThreadGroupKey, string> = {
  pinned: 'chat.threads.groupPinned',
  today: 'chat.threads.groupToday',
  yesterday: 'chat.threads.groupYesterday',
  week: 'chat.threads.groupWeek',
  older: 'chat.threads.groupOlder',
};

export interface ThreadRailProps {
  conversations: ConversationVM[];
  activeId: string | null;
  loaded: boolean;
  isMobile: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onTogglePin: (id: string, pinned: boolean) => void;
  searchValue?: string;
  onSearchChange?: (value: string) => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  t: T;
  panelWidth?: number;
  onWidthChange?: (width: number) => void;
  headerActions?: React.ReactNode;
}

export const ThreadRail = ({
  conversations,
  activeId,
  loaded,
  isMobile,
  onOpen,
  onNew,
  onRename,
  onDelete,
  onTogglePin,
  searchValue,
  onSearchChange,
  hasMore,
  loadingMore,
  onLoadMore,
  panelWidth, onWidthChange, headerActions,
  t,
}: ThreadRailProps) => {
  const [localWidth, setRailWidth] = useState<number>(CHAT_RAIL.default);
  const railWidth = panelWidth ?? localWidth;
  useLayoutEffect(() => { setRailWidth(readChatRailWidth()); }, []);
  const resize = (value: number) => { const next = boundedPanelWidth(value, CHAT_RAIL.min, CHAT_RAIL.max, CHAT_RAIL.default); setRailWidth(next); onWidthChange?.(next); try { writeBrowserValue(localStorage, CHAT_RAIL.key, String(next)); } catch {} };
  const [localSearch, setLocalSearch] = useState('');
  const search = searchValue ?? localSearch;
  const setSearch = (value: string) => { setLocalSearch(value); onSearchChange?.(value); };
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [menu, setMenu] = useState<{ id: string; x: number; y: number; trigger: HTMLElement } | null>(null);
  const closeMenu = useCallback((restoreFocus: boolean) => {
    if (restoreFocus) restoreLayerFocus(menu?.trigger);
    setMenu(null);
  }, [menu]);
  useEffect(() => { setMenu(null); }, [activeId, search]);
  const menuConversation = menu ? conversations.find(c => c.id === menu.id) : undefined;

  const groups = useMemo(() => {
    const filtered = filterThreads(conversations, search, t('chat.threads.untitled'));
    return groupThreads(filtered);
  }, [conversations, search, t]);

  const startRename = (c: ConversationVM) => {
    setRenamingId(c.id);
    setRenameDraft((c.title ?? '').trim());
  };
  const commitRename = () => {
    const id = renamingId;
    if (!id) return;
    const draftTitle = renameDraft;
    setRenamingId(null);
    setRenameDraft('');
    if (draftTitle.trim().length > 0) onRename(id, draftTitle);
  };

  const hasQuery = search.trim().length > 0;

  return (
    <aside
      className="reomi-thread-rail"
      style={{
        width: isMobile ? '100%' : railWidth,
        position: 'relative',
        maxWidth: '100%',
        flexShrink: 0,
        borderRight: isMobile ? 'none' : '1px solid var(--panel-edge)',
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      {!isMobile && <ResizeHandle width={railWidth} min={CHAT_RAIL.min} max={CHAT_RAIL.max} defaultWidth={CHAT_RAIL.default} label={t('chat.threads.resize')} onChange={resize} />}
      <div className="reomi-thread-rail-header"
        style={{
          padding: '12px 14px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          minHeight: 60,
        }}
      >
        <span
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--text-dim)',
            fontFamily: 'var(--font-sans)',
          }}
        >
          {t('chat.threads.title')}
        </span>
        {headerActions}
        <NNBtn className="reomi-create-icon" variant="ghost" icon="plus" ariaLabel={t('chat.threads.newThread')} title={t('chat.threads.newThread')} onClick={onNew} />
      </div>

      {/* Search (A1) — client-side filter over effective titles. */}
      <div style={{ padding: '0 12px 6px' }}>
        <div style={{ position: 'relative' }}>
          <span
            style={{
              position: 'absolute',
              left: 9,
              top: '50%',
              transform: 'translateY(-50%)',
              display: 'inline-flex',
              pointerEvents: 'none',
            }}
          >
            <NNIcon name="search" size={13} color="var(--text-dim)" />
          </span>
          <TextInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && search.length > 0) {
                e.preventDefault();
                e.stopPropagation();
                setSearch('');
              }
            }}
            placeholder={t('chat.threads.searchPlaceholder')}
            aria-label={t('chat.threads.searchPlaceholder')}
            style={{ paddingLeft: 28, paddingRight: 28, minHeight: 34, fontSize: 12 }}
          />
          {hasQuery && (
            <button
              type="button"
              aria-label={t('chat.threads.searchPlaceholder')}
              onClick={() => setSearch('')}
              style={{
                position: 'absolute',
                right: 6,
                top: '50%',
                transform: 'translateY(-50%)',
                display: 'inline-flex',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                color: 'var(--text-dim)',
                padding: 2,
              }}
            >
              <NNIcon name="x" size={13} />
            </button>
          )}
        </div>
      </div>

      <div className="nn-scroll" style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
        {!loaded ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 4 }}>
            <NNSkeleton height={38} />
            <NNSkeleton height={38} />
            <NNSkeleton height={38} />
          </div>
        ) : conversations.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text-dim)', padding: '12px 8px', margin: 0 }}>
            {t('chat.threads.empty')}
          </p>
        ) : groups.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text-dim)', padding: '12px 8px', margin: 0 }}>
            {t('chat.threads.searchNoResults')}
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.key} style={{ display: 'flex', flexDirection: 'column' }}>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 500,
                  color: 'var(--text-dim)',
                  fontFamily: 'var(--font-sans)',
                  padding: '10px 8px 4px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                }}
              >
                {group.key === 'pinned' && <NNIcon name="pin" size={11} color="var(--text-dim)" />}
                {t(GROUP_LABEL_KEY[group.key])}
              </span>
              {group.items.map((c) => {
                const isActive = c.id === activeId;
                const isRenaming = renamingId === c.id;
                return (
                  <div
                    key={c.id}
                    className="nn-thread-row reomi-thread-item"
                    data-active={isActive || undefined}
                    onContextMenu={event => {
                      if (isRenaming) return;
                      event.preventDefault();
                      setMenu({ id: c.id, x: event.clientX, y: event.clientY, trigger: event.currentTarget });
                    }}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (!isRenaming) onOpen(c.id);
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      startRename(c);
                    }}
                    onKeyDown={(e) => {
                      if (isRenaming || e.target !== e.currentTarget) return;
                      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                        e.preventDefault();
                        const rect = e.currentTarget.getBoundingClientRect();
                        setMenu({ id: c.id, x: rect.right - 216, y: rect.bottom + 4, trigger: e.currentTarget });
                        return;
                      }
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        onOpen(c.id);
                      }
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 6,
                      padding: '11px 12px',
                      borderRadius: 'var(--r-md)',
                      cursor: 'pointer',
                      background: isActive ? 'var(--surface-3)' : 'transparent',
                      transition: 'background 120ms ease',
                    }}
                  >
                    {isRenaming ? (
                      <input
                        autoFocus
                        value={renameDraft}
                        maxLength={200}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setRenameDraft(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            commitRename();
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            setRenamingId(null);
                            setRenameDraft('');
                          }
                        }}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          padding: '4px 8px',
                          borderRadius: 'var(--r-sm)',
                          border: '1px solid var(--border-2)',
                          background: 'var(--surface-2)',
                          color: 'var(--text)',
                          fontFamily: 'var(--font-sans)',
                          fontSize: 13.5,
                          outline: 'none',
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          minWidth: 0,
                          gap: 1,
                          flex: 1,
                        }}
                      >
                        <span
                          style={{
                            fontSize: 13.5,
                            fontWeight: isActive ? 600 : 500,
                            color: isActive ? 'var(--text)' : 'var(--text-muted)',
                            fontFamily: 'var(--font-sans)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'normal',
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            lineHeight: 1.4,
                          }}
                        >
                          {conversationTitle(c, t('chat.threads.untitled'))}
                        </span>
                        {c.context?.refs.length ? <span className="reomi-assistant-thread-context">
                          {c.context.refs.slice(0,2).map(s => `${s.label}${s.available ? '' : ` · ${t('assistant.unavailable')}`}`).join(' · ')}
                          {c.context.refs.length > 2 ? ` +${c.context.refs.length - 2}` : ''}
                        </span> : null}
                        {c.activity && <span className="reomi-assistant-thread-activity" data-activity={c.activity}>{t(`assistant.activity.${c.activity}`)}</span>}
                        {relativeUpdated(c.updatedAt, t) && (
                          <span
                            style={{
                              fontSize: 10.5,
                              color: 'var(--text-dim)',
                              fontFamily: 'var(--font-sans)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {relativeUpdated(c.updatedAt, t)}
                          </span>
                        )}
                      </div>
                    )}
                    {!isRenaming && (
                      <button type="button" className="reomi-thread-item-actions"
                        aria-label={t('chat.threads.actions')} data-tooltip={t('chat.threads.actions')}
                        aria-haspopup="menu" aria-expanded={menu?.id === c.id}
                        onDoubleClick={event => event.stopPropagation()}
                        onClick={event => {
                          event.stopPropagation();
                          if (menu?.id === c.id) { closeMenu(true); return; }
                          const rect = event.currentTarget.getBoundingClientRect();
                          setMenu({ id: c.id, x: rect.right - 216, y: rect.bottom + 5, trigger: event.currentTarget });
                        }}><NNIcon name="dots" size={17} /></button>
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
      {hasMore && <NNBtn size="sm" variant="ghost" disabled={loadingMore} onClick={onLoadMore}>{t(loadingMore ? 'states.loading' : 'assistant.more')}</NNBtn>}
      {menu && menuConversation && <ThreadContextMenu anchor={menu.trigger} x={menu.x} y={menu.y} label={t('chat.threads.actions')} onClose={closeMenu} actions={[
        { icon: 'pin', label: t(menuConversation.pinned ? 'chat.threads.unpin' : 'chat.threads.pin'), run: () => onTogglePin(menuConversation.id, !menuConversation.pinned) },
        { icon: 'edit', label: t('chat.threads.rename'), run: () => startRename(menuConversation) },
        { icon: 'x', label: t('chat.threads.delete'), danger: true, run: () => onDelete(menuConversation.id) },
      ]} />}
    </aside>
  );
};
