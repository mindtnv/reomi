'use client';

// NotebooksScreen — the «Блокноты 2.0» list (N1, Р13). A grid of notebook
// tiles: an emoji avatar on a color-tinted backdrop, title, a one-line
// description, count chips (sources · notes · cards), an «updated N ago» line,
// a ⋯ menu (pin / archive / rename / delete), a pinned indicator. Plus a title
// search (client filter), an «Архив» toggle (a separate `?archived=true` fetch),
// and unified empty states. Creating a notebook opens a dialog with an emoji
// preset grid + a color palette.
//
//  • Opening a notebook navigates to `/notebooks/[id]` (the 3-panel workspace).
//  • Notebook organization and entry to readable sources are independent of AI
//    availability. Individual AI features retain their own capability gates.
//
// The source-side exports (AddSourceForm / sourceIcon / statusTone / SourceRow /
// mimeFor / NONTERMINAL / AddKind) are CONSUMED by notebook-workspace.tsx and
// stay here unchanged.

import React, { useCallback, useMemo, useState, useRef, type SetStateAction } from 'react';
import {
  NOTEBOOK_COLORS,
  SOURCE_MIME_TO_KIND,
  SOURCE_NONTERMINAL_STATUSES,
  type IngestErrorCode,
  type NotebookColor,
  type SourceMime,
  type SourceStatus,
} from '@reomi/shared';
import { NNBtn, NNCard, NNIcon, NNBadge, NNInlineRefresh, NNLoadError, NNSkeleton } from '@/components/ui';
import { TextInput, PageSurface } from '@/components/design-system/primitives';
import { useNN } from '@/lib/store';
import type { Notebook, NotebookCoverSource, Source } from '@/lib/types';
import { useTransientLayer } from '@/lib/use-transient-layer';
import { useIsMobile } from '@/lib/use-breakpoint';
import { useT } from '@/lib/i18n';
import { relativeUpdated } from '@/lib/notebook-format';
import { sourceKindToneVar } from '@/lib/source-kind';
import { resolveMediaSrc } from '@/lib/media-url';
import { useDialog } from '@/components/dialog';
import { raiseToast } from '@/components/toasts';
import { useKnowledgeRefresh } from '@/lib/use-knowledge-refresh';
import { useSessionResource, invalidateSessionResourceScope } from '@/lib/session-resource';
import { useAppNavigation, useNavigationWorkspace, useWorkspaceState } from '@/components/navigation';

type Tfn = (key: string, params?: Record<string, string | number>) => string;

// ── Notebook color → CSS-var accent (the emoji-avatar backdrop tint, Р13) ──────
const NOTEBOOK_COLOR_VAR: Record<NotebookColor, string> = {
  lime: 'var(--lime-500)',
  amber: 'var(--amber-500)',
  violet: 'var(--violet-500)',
  sky: 'var(--sky-400)',
  rose: 'var(--rose-500)',
  neutral: 'var(--text-muted)',
};

/** Emoji presets for the create dialog (Р13: «простая сетка ~24 emoji»). */
const EMOJI_PRESETS = [
  '📓', '📘', '📗', '📕', '📚', '🧠', '💡', '🔬',
  '🧪', '🧬', '⚙️', '🛠️', '🧮', '📐', '🌍', '🗺️',
  '🎯', '🚀', '🎨', '🎵', '💻', '📈', '🏛️', '⚖️',
];

/**
 * Enter/Space activation for card-divs carrying role="button" (a11y) — the
 * target guard keeps inner real buttons (⋯ menu, «Открыть») from double-firing:
 * their own Enter-click bubbles a keydown up to the card.
 */
const pressToOpen = (open: () => void) => (e: React.KeyboardEvent) => {
  if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    open();
  }
};

/** Card meta line: «N источников · M документов» (the `documents` count is the
 *  notebook's studio artifacts). Reuses the existing flat-count i18n style. */
function metaLine(nb: Notebook, t: Tfn): string {
  const sources = t('notebooks.meta.sourcesMeta', { count: nb.sourceCount ?? 0 });
  const docs = t('notebooks.meta.documentsMeta', { count: nb.artifactCount ?? 0 });
  return `${sources}${t('notebooks.meta.metaSep')}${docs}`;
}

/** One fanned mini-cover — a private cover read when present, else a
 *  kind-tinted gradient tile with the title's first letter in the serif face. */
const NotebookMiniCover = ({
  cover,
  index,
  count,
  w,
  h,
}: {
  cover: NotebookCoverSource;
  index: number;
  count: number;
  w: number;
  h: number;
}) => {
  const [failed, setFailed] = useState(false);
  const tone = sourceKindToneVar(cover.kind);
  const showImage = Boolean(cover.coverMediaId) && !failed;
  const letter = cover.title.trim().charAt(0).toUpperCase() || '?';
  return (
    <span
      style={{
        marginLeft: index === 0 ? 0 : -7,
        transform: `rotate(${(index - (count - 1) / 2) * 4}deg)`,
        transformOrigin: 'bottom center',
        zIndex: index,
        position: 'relative',
        filter: 'drop-shadow(0 2px 3px var(--ambient-shadow))',
      }}
      aria-hidden
    >
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: w,
          height: h,
          borderRadius: 4,
          overflow: 'hidden',
          background: showImage
            ? 'var(--surface-3)'
            : `linear-gradient(135deg, color-mix(in srgb, ${tone} 30%, var(--surface-3)), var(--surface-3))`,
          border: '1px solid var(--border)',
        }}
      >
        {showImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={resolveMediaSrc(`/m/${cover.coverMediaId}`)}
            alt=""
            onError={() => setFailed(true)}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <span
            style={{
              fontFamily: 'var(--font-serif)',
              fontSize: Math.round(h * 0.4),
              fontWeight: 400,
              color: tone,
              lineHeight: 1,
            }}
          >
            {letter}
          </span>
        )}
      </span>
    </span>
  );
};

/** The fanned mini-cover stack (≤4) at the foot of a notebook card. */
const NotebookCoverFan = ({ covers }: { covers: NotebookCoverSource[] }) => {
  const shown = covers.slice(0, 4);
  if (shown.length === 0) return null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'flex-end' }}>
      {shown.map((c, i) => (
        <NotebookMiniCover key={i} cover={c} index={i} count={shown.length} w={22} h={31} />
      ))}
    </span>
  );
};

export const NONTERMINAL = new Set<SourceStatus>(SOURCE_NONTERMINAL_STATUSES);

/** Badge tone per status — error/terminal are visually distinct. */
export function statusTone(status: SourceStatus): string {
  if (status === 'ready') return 'lime';
  if (status === 'error') return 'rose';
  if (status === 'deleting') return 'neutral';
  return 'sky';
}

/** Whether the kind picker maps this file's mime to an allowed upload kind. */
export function mimeFor(file: File): SourceMime | null {
  const mime = file.type;
  if (mime in SOURCE_MIME_TO_KIND) return mime as SourceMime;
  // Fall back on extension (some browsers report empty type for epub).
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.epub')) return 'application/epub+zip';
  return null;
}

import { useNavigationScroll, NavigationRestoreNotice } from '@/lib/use-navigation-scroll';

export type AddKind = 'file' | 'url' | 'text';

export const NotebooksScreen = () => {
  const t = useT();
  const navigation = useAppNavigation();
  const workspace = useNavigationWorkspace();
  const isMobile = useIsMobile();
  const { prompt, confirm, edit } = useDialog();

  const listNotebooks = useNN((s) => s.listNotebooks);
  const createNotebook = useNN((s) => s.createNotebook);
  const patchNotebook = useNN((s) => s.patchNotebook);
  const deleteNotebook = useNN((s) => s.deleteNotebook);

  const [archived, setArchived] = useWorkspaceState('notebooks', 'archived', false);
  const [search, setSearch] = useWorkspaceState('notebooks', 'search', '');
  const [createOpen, setCreateOpen] = useState(false);

  // ── Notebook list (re-fetched per archive toggle) ─────────────────────────────
  const fetchNotebooks = useCallback(
    () => listNotebooks({ archived }),
    [listNotebooks, archived],
  );
  const notebooksResource = useSessionResource({
    key: `notebooks:list:${archived ? 'archived' : 'active'}`,
    scope: 'notebooks:list',
    fetcher: fetchNotebooks,
    keepPreviousData: true,
  });
  useKnowledgeRefresh(() => { invalidateSessionResourceScope('notebooks:list'); notebooksResource.refresh(); });
  const notebooks = notebooksResource.data ?? [];
  const notebooksLoaded = notebooksResource.data !== null || notebooksResource.status === 'error';
  const listPosition = useNavigationScroll('notebooks','list',{ready:Boolean(notebooksResource.data),queryKey:JSON.stringify([archived,search])});
  const setNotebooks = useCallback((update: SetStateAction<Notebook[]>) => {
    notebooksResource.mutate((previous) => {
      const value = previous ?? [];
      return typeof update === 'function'
        ? (update as (current: Notebook[]) => Notebook[])(value)
        : update;
    });
  }, [notebooksResource.mutate]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return notebooks;
    return notebooks.filter((n) => n.title.toLowerCase().includes(q));
  }, [notebooks, search]);

  // ── Actions ─────────────────────────────────────────────────────────────────
  const onCreate = useCallback(
    async (input: { title: string; emoji: string | null; color: NotebookColor | null; description: string | null }) => {
      try {
        const created = await createNotebook(input.title);
        // The create route takes only `title`; apply the rest via PATCH if set.
        if (input.emoji || input.color || input.description) {
          const updated = await patchNotebook(created.id, {
            emoji: input.emoji,
            color: input.color,
            description: input.description,
          });
          setNotebooks((prev) => [updated, ...prev]);
        } else {
          setNotebooks((prev) => [created, ...prev]);
        }
        setCreateOpen(false);
      } catch {
        raiseToast({ kind: 'error', title: t('notebooks.list.tooMany') });
      }
    },
    [createNotebook, patchNotebook, t],
  );

  const onRename = useCallback(async (nb: Notebook) => {
    await edit({ title: t('notebooks.list.renameTitle'), label: t('notebooks.list.createLabel'), defaultValue: nb.title,
      path: `/notebooks/${nb.id}`, revision: nb.metadataRevision ?? 0, maxLength: 200,
      patch: title => ({ title }), validate: title => title.trim() ? null : ' ',
      readCurrent: async () => { const current = await useNN.getState().getNotebook(nb.id); return { revision: current.metadataRevision ?? 0, value: current.title }; },
      onSaved: result => { if (result.result) setNotebooks(previous => previous.map(row => row.id === nb.id ? { ...row, title: (result.result as Notebook).title, metadataRevision: (result.result as Notebook).metadataRevision } : row)); },
    });
  }, [edit, t]);

  const onTogglePin = useCallback(
    async (nb: Notebook) => {
      try {
        const updated = await patchNotebook(nb.id, { pinned: !nb.pinned });
        setNotebooks((prev) => {
          const merged = prev.map((n) =>
            n.id === nb.id ? { ...n, pinned: updated.pinned } : n,
          );
          // Maintain pinned-first, updatedAt-second ordering client-side.
          return [...merged].sort((a, b) =>
            a.pinned === b.pinned
              ? Date.parse(b.updatedAt) - Date.parse(a.updatedAt)
              : a.pinned
                ? -1
                : 1,
          );
        });
      } catch {
        raiseToast({ kind: 'error', title: t('notebooks.meta.saveFailed') });
      }
    },
    [patchNotebook, t],
  );

  const onToggleArchive = useCallback(
    async (nb: Notebook) => {
      try {
        await patchNotebook(nb.id, { archived: !nb.archived });
        // The row leaves the current shelf (active ↔ archive).
        setNotebooks((prev) => prev.filter((n) => n.id !== nb.id));
      } catch {
        raiseToast({ kind: 'error', title: t('notebooks.meta.saveFailed') });
      }
    },
    [patchNotebook, t],
  );

  const onDelete = useCallback(
    async (nb: Notebook) => {
      const yes = await confirm({
        title: t('notebooks.list.delete'),
        message: t('notebooks.list.deleteConfirm'),
        danger: true,
        confirmLabel: t('actions.delete'),
      });
      if (!yes) return;
      try {
        await deleteNotebook(nb.id);
        setNotebooks((prev) => prev.filter((n) => n.id !== nb.id));
      } catch {
        raiseToast({ kind: 'error', title: t('notebooks.meta.saveFailed') });
      }
    },
    [confirm, t, deleteNotebook],
  );

  // ── Render: notebook grid list ────────────────────────────────────────────────
  // «Продолжить» = the first notebook of the (server-sorted pinned/recency) list.
  // Shown only on the active shelf when there's at least one notebook and no
  // active search filter (spec A3.2).
  const continueNb = !archived && !search.trim() && notebooks.length > 0 ? notebooks[0] : null;

  return (
    <PageSurface ref={listPosition.ref} className="reomi-notebooks"
      aria-busy={notebooksResource.status === 'loading' || notebooksResource.status === 'refreshing'}
    >
      {createOpen && (
        <CreateNotebookDialog onCreate={onCreate} onClose={() => setCreateOpen(false)} t={t} />
      )}

      <div className="reomi-page-toolbar">
        <span className="nn-nb-search">
          <NNIcon name="search" size={14} color="var(--text-dim)" />
          <TextInput value={search} onChange={e => setSearch(e.target.value)} placeholder={t('notebooks.list.search')} aria-label={t('notebooks.list.search')} />
        </span>
        <span className="reomi-result-count">{notebooks.length}</span>
        <NNBtn variant={archived ? 'soft' : 'ghost'} icon="archive"
          aria-pressed={archived} ariaLabel={archived ? t('notebooks.list.showActive') : t('notebooks.list.showArchive')}
          title={archived ? t('notebooks.list.showActive') : t('notebooks.list.showArchive')}
          onClick={() => setArchived(value => !value)} />
        <NNBtn className="reomi-create-icon" variant="soft" icon="plus" ariaLabel={t('notebooks.list.create')} title={t('notebooks.list.create')} onClick={() => setCreateOpen(true)} />
      </div>

      <div style={{display:'flex',justifyContent:'flex-end'}}><NNBtn size="sm" variant="ghost" ariaLabel={t('navigation.reset')} onClick={()=>{workspace?.resetView('notebooks');navigation.replace('/notebooks',{track:false});}}>{t('navigation.reset')}</NNBtn></div>
      <NavigationRestoreNotice failure={listPosition.failure} retry={listPosition.retry}/>
      {notebooksResource.status === 'refreshing' && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '-10px 0 10px' }}>
          <NNInlineRefresh label={t('states.loading')} />
        </div>
      )}

      {notebooksResource.status === 'error' && (
        <div style={{ marginBottom: 14 }}>
          <NNLoadError
            title={t('toasts.error')}
            description={notebooksResource.error?.safeMessage}
            retryLabel={t('notebooks.overview.retry')}
            requestId={notebooksResource.error?.requestId}
            onRetry={notebooksResource.refresh}
          />
        </div>
      )}

      {/* «Продолжить» strip */}
      {continueNb && (
        <>
          <div className="nn-nb-section-label">{t('notebooks.list.sectionContinue')}</div>
          <ContinueCard
            notebook={continueNb}
            onOpen={() => navigation.push(`/notebooks/${continueNb.id}`)}
            t={t}
          />
        </>
      )}

      {/* «Все блокноты» section label (only with a populated grid) */}
      {!archived && filtered.length > 0 && (
        <div className="nn-nb-section-label">{t('notebooks.list.sectionAll')}</div>
      )}

      {!notebooksLoaded ? (
        <div className="nn-nb-grid">
          <NNSkeleton style={{ height: 168 }} />
          <NNSkeleton style={{ height: 168 }} />
          <NNSkeleton style={{ height: 168 }} />
        </div>
      ) : filtered.length === 0 ? (
        <div className="nn-empty-state" style={{ paddingTop: 48, paddingBottom: 48 }}>
          <span className="nn-empty-state-icon">
            <NNIcon name="stack" size={34} color="var(--text-dim)" />
          </span>
          <p className="nn-empty-state-hint">
            {search.trim()
              ? t('notebooks.list.searchEmpty')
              : archived
                ? t('notebooks.list.emptyArchived')
                : t('notebooks.list.empty')}
          </p>
          {!search.trim() && !archived && (
            <NNBtn variant="primary" size="sm" icon="plus" onClick={() => setCreateOpen(true)}>
              {t('notebooks.list.create')}
            </NNBtn>
          )}
        </div>
      ) : (
        <div className="nn-nb-grid">
          {filtered.map((nb) => (
            <NotebookCard
              key={nb.id}
              notebook={nb}
              onOpen={() => navigation.push(`/notebooks/${nb.id}`)}
              onRename={() => onRename(nb)}
              onTogglePin={() => onTogglePin(nb)}
              onToggleArchive={() => onToggleArchive(nb)}
              onDelete={() => onDelete(nb)}
              t={t}
            />
          ))}
          {/* «Новый блокнот» dashed create tile — only on the active shelf */}
          {!archived && <CreateTile onClick={() => setCreateOpen(true)} t={t} />}
        </div>
      )}
    </PageSurface>
  );
};

// ── «Продолжить» strip — the first (pinned/recency-sorted) notebook ─────────────

const ContinueCard = ({
  notebook,
  onOpen,
  t,
}: {
  notebook: Notebook;
  onOpen: () => void;
  t: Tfn;
}) => {
  const accent = notebook.color ? NOTEBOOK_COLOR_VAR[notebook.color] : 'var(--violet-500)';
  const avatarChar =
    notebook.emoji && notebook.emoji.length > 0
      ? notebook.emoji
      : notebook.title.trim().charAt(0).toUpperCase() || '?';
  const subtitle = notebook.description?.trim() ? notebook.description : metaLine(notebook, t);
  const generating = (notebook.generatingCount ?? 0) > 0;
  const generatingLabel = notebook.generatingTitle
    ? t('notebooks.meta.generatingTitle', { title: notebook.generatingTitle })
    : t('notebooks.meta.generatingCount', { count: notebook.generatingCount ?? 0 });

  return (
    <div
      className="nn-nb-continue"
      onClick={onOpen}
      onKeyDown={pressToOpen(onOpen)}
      role="button"
      tabIndex={0}
    >
      <span className="nn-nb-continue-glow" aria-hidden />
      <span
        className="nn-nb-continue-tile"
        style={{
          background: `color-mix(in srgb, ${accent} 14%, transparent)`,
          border: `1px solid color-mix(in srgb, ${accent} 28%, transparent)`,
          color: accent,
        }}
        aria-hidden
      >
        {avatarChar}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontSize: 14.5,
            fontWeight: 600,
            color: 'var(--text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {notebook.title}
        </span>
        <span
          style={{
            display: 'block',
            fontSize: 12,
            color: 'var(--text-muted)',
            marginTop: 2,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {subtitle}
        </span>
      </span>
      {generating && (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            fontSize: 11,
            color: 'var(--amber-400)',
            flexShrink: 0,
            whiteSpace: 'nowrap',
          }}
        >
          <span className="nn-nb-pulse" aria-hidden />
          {generatingLabel}
        </span>
      )}
      <NNBtn variant="ghost" icon="arrow" ariaLabel={t('notebooks.list.open')} title={t('notebooks.list.open')} onClick={onOpen} />
    </div>
  );
};

// ── «Новый блокнот» dashed create tile ──────────────────────────────────────────

const CreateTile = ({ onClick, t }: { onClick: () => void; t: Tfn }) => (
  <button type="button" className="nn-nb-create" onClick={onClick}>
    <span className="nn-nb-create-plus" aria-hidden>
      <NNIcon name="plus" size={16} color="var(--lime-400)" />
    </span>
    <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--text)' }}>
      {t('notebooks.list.newCardTitle')}
    </span>
    <span style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: -4 }}>
      {t('notebooks.list.newCardHint')}
    </span>
  </button>
);

// ── Notebook grid card ─────────────────────────────────────────────────────────

const NotebookCard = ({
  notebook,
  onOpen,
  onRename,
  onTogglePin,
  onToggleArchive,
  onDelete,
  t,
}: {
  notebook: Notebook;
  onOpen: () => void;
  onRename: () => void;
  onTogglePin: () => void;
  onToggleArchive: () => void;
  onDelete: () => void;
  t: Tfn;
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRoot = useRef<HTMLDivElement>(null);
  useTransientLayer({ root: menuRoot, enabled: menuOpen, onClose: () => setMenuOpen(false) });
  const accent = notebook.color ? NOTEBOOK_COLOR_VAR[notebook.color] : 'var(--text-muted)';
  const avatarChar =
    notebook.emoji && notebook.emoji.length > 0
      ? notebook.emoji
      : notebook.title.trim().charAt(0).toUpperCase() || '?';
  const updated = relativeUpdated(notebook.updatedAt, t);
  const covers = notebook.coverSources ?? [];

  return (
    <div
      data-navigation-anchor={notebook.id}
      className="nn-nb-card"
      onClick={onOpen}
      onKeyDown={pressToOpen(onOpen)}
      role="button"
      tabIndex={0}
    >
      {notebook.pinned && (
        <span className="nn-nb-pin" title={t('notebooks.meta.pinned')}>
          <NNIcon name="pin" size={12} color="var(--lime-400)" />
        </span>
      )}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span
          className="nn-nb-tile"
          style={{
            background: `color-mix(in srgb, ${accent} 13%, transparent)`,
            border: `1px solid color-mix(in srgb, ${accent} 30%, transparent)`,
            color: accent,
          }}
          aria-hidden
        >
          {avatarChar}
        </span>
        <span style={{ flex: 1 }} />
        <div ref={menuRoot}
          className="nn-nb-menu-anchor"
          style={{ position: 'relative', flexShrink: 0 }}
          onClick={(e) => e.stopPropagation()}
        >
          <NNBtn
            variant="ghost"
            size="sm"
            icon="dots"
            ariaLabel={t('library.item.menu')}
            title={t('library.item.menu')}
            aria-expanded={menuOpen} onClick={event => { event.currentTarget.focus({ preventScroll: true }); setMenuOpen(v => !v); }}
          />
          {menuOpen && (
            <>
              <div role="group" aria-label={notebook.title} className="nn-lib-menu" style={{ right: 0, top: 'calc(100% + 4px)', minWidth: 180 }}>
                <button
                  type="button"
                  className="nn-lib-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onTogglePin();
                  }}
                >
                  <NNIcon name="pin" size={14} color="var(--text-muted)" />
                  {notebook.pinned ? t('notebooks.meta.unpin') : t('notebooks.meta.pin')}
                </button>
                <button
                  type="button"
                  className="nn-lib-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onRename();
                  }}
                >
                  <NNIcon name="edit" size={14} color="var(--text-muted)" />
                  {t('notebooks.list.rename')}
                </button>
                <button
                  type="button"
                  className="nn-lib-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onToggleArchive();
                  }}
                >
                  <NNIcon name="stack" size={14} color="var(--text-muted)" />
                  {notebook.archived ? t('notebooks.meta.unarchive') : t('notebooks.meta.archive')}
                </button>
                <button
                  type="button"
                  className="nn-lib-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onDelete();
                  }}
                >
                  <NNIcon name="x" size={14} color="var(--rose-400)" />
                  {t('notebooks.list.delete')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Title + meta line */}
      <div style={{ marginTop: 14 }}>
        <div
          style={{
            fontSize: 15.5,
            fontWeight: 600,
            letterSpacing: -0.2,
            color: 'var(--text)',
            fontFamily: 'var(--font-sans)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {notebook.title}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 3 }}>
          {metaLine(notebook, t)}
        </div>
      </div>

      {/* Cover fan + relative-updated */}
      <div
        style={{
          marginTop: 'auto',
          paddingTop: 14,
          display: 'flex',
          alignItems: 'flex-end',
          gap: 10,
        }}
      >
        <NotebookCoverFan covers={covers} />
        <span style={{ flex: 1 }} />
        {updated && (
          <span style={{ fontSize: 10.5, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>
            {updated}
          </span>
        )}
      </div>
    </div>
  );
};

// ── Create-notebook dialog (emoji preset grid + color palette) ──────────────────

const CreateNotebookDialog = ({
  onCreate,
  onClose,
  t,
}: {
  onCreate: (input: {
    title: string;
    emoji: string | null;
    color: NotebookColor | null;
    description: string | null;
  }) => Promise<void>;
  onClose: () => void;
  t: Tfn;
}) => {
  const [title, setTitle] = useState('');
  const [emoji, setEmoji] = useState<string | null>(null);
  const [color, setColor] = useState<NotebookColor | null>('lime');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    await onCreate({
      title: trimmed,
      emoji,
      color,
      description: description.trim() || null,
    });
    setBusy(false);
  }, [title, busy, emoji, color, description, onCreate]);

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
  const labelStyle: React.CSSProperties = {
    fontSize: 11.5,
    fontWeight: 600,
    color: 'var(--text-dim)',
    marginBottom: 5,
    display: 'block',
  };

  return (
    <>
      <div
        className="nn-dialog-backdrop"
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 90, background: 'var(--scrim)' }}
      />
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 91,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
          pointerEvents: 'none',
        }}
      >
        <NNCard
          padding={18}
          style={{
            width: 440,
            maxWidth: '100%',
            maxHeight: '84vh',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            pointerEvents: 'auto',
            boxShadow: 'var(--shadow-lg)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h3
              style={{
                fontSize: 15,
                fontWeight: 700,
                color: 'var(--text)',
                margin: 0,
                flex: 1,
                fontFamily: 'var(--font-sans)',
              }}
            >
              {t('notebooks.list.createTitle')}
            </h3>
            <NNBtn variant="ghost" size="sm" icon="x" ariaLabel={t('actions.cancel')} onClick={onClose} />
          </div>

          <div>
            <label style={labelStyle}>{t('notebooks.list.createLabel')}</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('notebooks.list.createPlaceholder')}
              maxLength={200}
              autoFocus
              style={inputStyle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submit();
              }}
            />
          </div>

          <div>
            <label style={labelStyle}>{t('notebooks.meta.emojiLabel')}</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              <button
                type="button"
                className="nn-emoji-cell"
                title={t('notebooks.meta.emojiNone')}
                aria-pressed={emoji === null}
                style={{
                  borderColor: emoji === null ? 'var(--lime-500)' : 'var(--border)',
                  fontSize: 12,
                  color: 'var(--text-dim)',
                }}
                onClick={() => setEmoji(null)}
              >
                —
              </button>
              {EMOJI_PRESETS.map((e) => (
                <button
                  key={e}
                  type="button"
                  className="nn-emoji-cell"
                  aria-pressed={emoji === e}
                  style={{ borderColor: emoji === e ? 'var(--lime-500)' : 'var(--border)' }}
                  onClick={() => setEmoji(e)}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label style={labelStyle}>{t('notebooks.meta.colorLabel')}</label>
            <div style={{ display: 'flex', gap: 6 }}>
              {NOTEBOOK_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={c}
                  aria-pressed={color === c}
                  onClick={() => setColor(c)}
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: '50%',
                    cursor: 'pointer',
                    background: NOTEBOOK_COLOR_VAR[c],
                    border:
                      color === c
                        ? '2px solid var(--text)'
                        : '2px solid transparent',
                    boxShadow: color === c ? '0 0 0 2px var(--surface)' : undefined,
                  }}
                />
              ))}
            </div>
          </div>

          <div>
            <label style={labelStyle}>{t('notebooks.meta.createDescription')}</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              style={{ ...inputStyle, minHeight: 60, resize: 'vertical', lineHeight: 1.45 }}
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <NNBtn variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              {t('actions.cancel')}
            </NNBtn>
            <NNBtn
              variant="primary"
              size="sm"
              onClick={() => void submit()}
              disabled={busy || title.trim().length === 0}
            >
              {t('actions.create')}
            </NNBtn>
          </div>
        </NNCard>
      </div>
    </>
  );
};

// ── Source row ──────────────────────────────────────────────────────────────────

export const SourceRow = ({
  source,
  onRename,
  onDelete,
}: {
  source: Source;
  onRename: () => void;
  onDelete: () => void;
}) => {
  const t = useT();
  const isError = source.status === 'error';
  // An error code (if present) wins over the bare 'error' status for the label.
  const statusLabel =
    isError && source.errorCode
      ? t(`notebooks.status.${source.errorCode as IngestErrorCode}`)
      : t(`notebooks.status.${source.status}`);
  const showProgress = source.status === 'indexing' || source.status === 'ready';

  return (
    <NNCard padding={14}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <NNIcon name={sourceIcon(source.kind)} size={18} color="var(--text-muted)" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--text)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {source.title}
          </div>
          {showProgress && source.total > 0 && (
            <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 3 }}>
              {t('notebooks.sources.progress', {
                indexed: String(source.indexed),
                total: String(source.total),
              })}
            </div>
          )}
        </div>
        <NNBadge tone={statusTone(source.status)} size="sm">
          {statusLabel}
        </NNBadge>
        <div style={{ display: 'flex', gap: 4 }}>
          <NNBtn
            variant="ghost"
            size="sm"
            icon="edit"
            ariaLabel={t('notebooks.sources.rename')}
            title={t('notebooks.sources.rename')}
            onClick={onRename}
          />
          <NNBtn
            variant="ghost"
            size="sm"
            icon="x"
            ariaLabel={t('notebooks.sources.delete')}
            title={t('notebooks.sources.delete')}
            onClick={onDelete}
          />
        </div>
      </div>
    </NNCard>
  );
};

export function sourceIcon(kind: Source['kind']): 'doc' | 'link' {
  return kind === 'url' ? 'link' : 'doc';
}

// ── Add-source inline form ────────────────────────────────────────────────────

export const AddSourceForm = ({
  kind,
  setKind,
  title,
  setTitle,
  url,
  setUrl,
  text,
  setText,
  file,
  setFile,
  fileInputRef,
  adding,
  maxMb,
  onSubmit,
  onCancel,
}: {
  kind: AddKind;
  setKind: (k: AddKind) => void;
  title: string;
  setTitle: (v: string) => void;
  url: string;
  setUrl: (v: string) => void;
  text: string;
  setText: (v: string) => void;
  file: File | null;
  setFile: (f: File | null) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  adding: boolean;
  maxMb: number;
  onSubmit: () => void;
  onCancel: () => void;
}) => {
  const t = useT();
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
  const labelStyle: React.CSSProperties = {
    fontSize: 11.5,
    fontWeight: 600,
    color: 'var(--text-dim)',
    marginBottom: 4,
    display: 'block',
  };

  const canSubmit =
    !adding &&
    ((kind === 'file' && !!file) ||
      (kind === 'url' && url.trim().length > 0) ||
      (kind === 'text' && text.trim().length > 0));

  return (
    <NNCard padding={16} style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {(['file', 'url', 'text'] as AddKind[]).map((k) => (
          <NNBtn
            key={k}
            variant={kind === k ? 'soft' : 'ghost'}
            size="sm"
            active={kind === k}
            onClick={() => setKind(k)}
          >
            {t(`notebooks.add.kind${k === 'file' ? 'File' : k === 'url' ? 'Url' : 'Text'}`)}
          </NNBtn>
        ))}
      </div>

      <div>
        <label style={labelStyle}>{t('notebooks.add.titleLabel')}</label>
        <input
          style={inputStyle}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('notebooks.add.titlePlaceholder')}
          maxLength={300}
        />
      </div>

      {kind === 'file' && (
        <div>
          <label style={labelStyle}>{t('notebooks.add.fileLabel')}</label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.epub,application/pdf,application/epub+zip"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            style={{ fontSize: 13, color: 'var(--text-muted)' }}
          />
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 5 }}>
            {t('notebooks.add.fileHint', { mb: String(maxMb) })}
          </div>
        </div>
      )}

      {kind === 'url' && (
        <div>
          <label style={labelStyle}>{t('notebooks.add.urlLabel')}</label>
          <input
            style={inputStyle}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder={t('notebooks.add.urlPlaceholder')}
            maxLength={2000}
          />
        </div>
      )}

      {kind === 'text' && (
        <div>
          <label style={labelStyle}>{t('notebooks.add.textLabel')}</label>
          <textarea
            style={{ ...inputStyle, minHeight: 120, resize: 'vertical' }}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('notebooks.add.textPlaceholder')}
          />
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <NNBtn variant="ghost" size="sm" onClick={onCancel} disabled={adding}>
          {t('actions.cancel')}
        </NNBtn>
        <NNBtn variant="primary" size="sm" onClick={onSubmit} disabled={!canSubmit}>
          {adding ? t('notebooks.add.uploading') : t('notebooks.add.submit')}
        </NNBtn>
      </div>
    </NNCard>
  );
};
