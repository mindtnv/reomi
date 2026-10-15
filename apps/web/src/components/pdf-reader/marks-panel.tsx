'use client';

import { Button } from '@/components/design-system/primitives';


// M5 — «Разметка» panel: a sliding panel over the right edge of the reader
// showing all marks (highlights + notes) and ink pages grouped by page number.
// Clicking a mark scrolls+flashes it in the reader.
//
// M5-T3 polish: clean list, color dot + quote 2-line clamp, hover actions,
// consistent header style, empty state with icon + hint.

import React, { useCallback } from 'react';
import type { SourceMarkColor } from '@reomi/shared';
import { MARK_COLOR_CSS } from './mark-colors';
import { SOURCE_MARK_COLORS } from '@reomi/shared';
import type { SourceMark } from '@/lib/types';
import { NNIcon } from '@/components/ui';

type T = (key: string, params?: Record<string, string | number>) => string;

const MARK_COLOR_HEX = MARK_COLOR_CSS;

export interface MarksPanelProps {
  open: boolean;
  onClose: () => void;
  marks: SourceMark[];
  inkPages: number[];
  onMarkClick: (mark: SourceMark) => void;
  onMarkDelete: (markId: string) => void;
  onMarkColorChange: (markId: string, color: SourceMarkColor) => void;
  onMarkNoteChange: (markId: string, note: string) => void;
  onMarkToCard: (mark: SourceMark) => void;
  /** W4: jump to the linked card in the cards browser. */
  onOpenCard?: (cardId: string) => void;
  /** L4 §8.4: «Экспорт в Markdown» — present only when there is markup to export. */
  onExport?: () => void;
  /** Feature #2: «Собрать карточки из разметки» — open the harvest wizard. Present
   *  only when AI is enabled (the parent gates it on chatEnabled, mirroring the
   *  quick-card «✨ Сформулировать» gate). */
  onHarvest?: () => void;
  t: T;
}

function groupByPage(marks: SourceMark[], inkPages: number[]) {
  const map = new Map<number, { marks: SourceMark[]; hasInk: boolean }>();
  for (const m of marks) {
    const g = map.get(m.page) ?? { marks: [], hasInk: false };
    g.marks.push(m);
    map.set(m.page, g);
  }
  for (const p of inkPages) {
    const g = map.get(p) ?? { marks: [], hasInk: false };
    g.hasInk = true;
    map.set(p, g);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]);
}

export function MarksPanel({
  open,
  onClose,
  marks,
  inkPages,
  onMarkClick,
  onMarkDelete,
  onMarkColorChange,
  onMarkNoteChange,
  onMarkToCard,
  onOpenCard,
  onExport,
  onHarvest,
  t,
}: MarksPanelProps) {
  const groups = groupByPage(marks, inkPages);
  const hasMarkup = marks.length > 0 || inkPages.length > 0;
  // Feature #2 — harvest is offered only when there's un-harvested markup to
  // collect (a highlight/note not yet stamped, or any ink page).
  const harvestable =
    marks.some((m) => (m.kind === 'highlight' || m.kind === 'note') && !m.harvestedAt) ||
    inkPages.length > 0;

  if (!open) return null;

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: 284,
        background: 'var(--surface)',
        borderLeft: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 50,
        boxShadow: '-2px 0 12px var(--inset-shadow)',
      }}
    >
      {/* Header */}
      <div
        className="nn-chrome"
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
          minHeight: 40,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.07em',
            color: 'var(--text-dim)',
            userSelect: 'none',
            flex: 1,
          }}
        >
          {t('notebooks.marks.panelTitle')}
        </span>
        {onExport && hasMarkup && (
          <Button variant="bare"
            type="button"
            onClick={onExport}
            title={t('notebooks.marks.export')}
            aria-label={t('notebooks.marks.export')}
            style={{
              width: 28,
              height: 28,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 'var(--r-sm)',
              border: 'none',
              background: 'transparent',
              color: 'var(--text-muted)',
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--lime-400)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-muted)')}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          </Button>
        )}
        <Button variant="bare"
          type="button"
          onClick={onClose}
          aria-label="Close marks panel"
          style={{
            width: 28,
            height: 28,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 'var(--r-sm)',
            border: 'none',
            background: 'transparent',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            fontSize: 14,
            lineHeight: 1,
          }}
        >
          ×
        </Button>
      </div>

      {/* Content */}
      <div
        className="nn-scroll"
        style={{
          flex: 1,
          overflowY: 'auto',
        }}
      >
        {/* Feature #2 — «Собрать карточки из разметки» (AI-gated by the parent). */}
        {onHarvest && harvestable && (
          <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
            <Button variant="bare"
              type="button"
              onClick={onHarvest}
              style={{
                width: '100%',
                height: 34,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 7,
                borderRadius: 'var(--r-md)',
                border: '1px solid var(--lime-500)',
                background: 'color-mix(in srgb, var(--lime-500) 12%, var(--surface))',
                color: 'var(--lime-400)',
                cursor: 'pointer',
                fontSize: 12.5,
                fontWeight: 600,
                fontFamily: 'var(--font-sans)',
              }}
            >
              <NNIcon name="sparkle" size={14} color="var(--lime-400)" />
              {t('notebooks.harvest.button')}
            </Button>
          </div>
        )}
        {groups.length === 0 ? (
          <div className="nn-empty-state" style={{ paddingTop: 32 }}>
            <span className="nn-empty-state-icon"><NNIcon name="edit" size={28} color="var(--text-dim)" /></span>
            <p className="nn-empty-state-hint">
              {t('notebooks.marks.panelEmpty')}
            </p>
          </div>
        ) : (
          groups.map(([page, group]) => (
            <PageGroup
              key={page}
              page={page}
              marks={group.marks}
              hasInk={group.hasInk}
              onMarkClick={onMarkClick}
              onMarkDelete={onMarkDelete}
              onMarkColorChange={onMarkColorChange}
              onMarkNoteChange={onMarkNoteChange}
              onMarkToCard={onMarkToCard}
              onOpenCard={onOpenCard}
              t={t}
            />
          ))
        )}
      </div>
    </div>
  );
}

function PageGroup({
  page,
  marks,
  hasInk,
  onMarkClick,
  onMarkDelete,
  onMarkColorChange,
  onMarkNoteChange,
  onMarkToCard,
  onOpenCard,
  t,
}: {
  page: number;
  marks: SourceMark[];
  hasInk: boolean;
  onMarkClick: (m: SourceMark) => void;
  onMarkDelete: (id: string) => void;
  onMarkColorChange: (id: string, color: SourceMarkColor) => void;
  onMarkNoteChange: (id: string, note: string) => void;
  onMarkToCard: (m: SourceMark) => void;
  onOpenCard?: (cardId: string) => void;
  t: T;
}) {
  return (
    <div style={{ marginBottom: 2 }}>
      <div
        className="nn-chrome"
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: 'var(--text-dim)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          padding: '8px 12px 3px',
          userSelect: 'none',
        }}
      >
        {t('notebooks.marks.pageGroup', { n: page })}
      </div>
      {hasInk && (
        <div
          style={{
            padding: '4px 12px',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            color: 'var(--text-muted)',
          }}
        >
          <span style={{ fontSize: 10 }}>✏️</span>
          <span>{t('notebooks.marks.panelInkPage', { n: page })}</span>
        </div>
      )}
      {marks.map((m) => (
        <MarkRow
          key={m.id}
          mark={m}
          onClick={() => onMarkClick(m)}
          onDelete={() => onMarkDelete(m.id)}
          onColorChange={(c) => onMarkColorChange(m.id, c)}
          onNoteChange={(note) => onMarkNoteChange(m.id, note)}
          onToCard={() => onMarkToCard(m)}
          onOpenCard={onOpenCard}
          t={t}
        />
      ))}
    </div>
  );
}

function MarkRow({
  mark,
  onClick,
  onDelete,
  onColorChange,
  onNoteChange,
  onToCard,
  onOpenCard,
  t,
}: {
  mark: SourceMark;
  onClick: () => void;
  onDelete: () => void;
  onColorChange: (c: SourceMarkColor) => void;
  onNoteChange: (note: string) => void;
  onToCard: () => void;
  onOpenCard?: (cardId: string) => void;
  t: T;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const [noteEdit, setNoteEdit] = React.useState(mark.note ?? '');
  // Feature #2 — a harvested highlight/note is dimmed + badged so a re-run reads
  // as "already turned into a card". Card-kind markers are never harvest targets.
  const harvested = Boolean(mark.harvestedAt) && mark.kind !== 'card';

  const handleClick = useCallback(() => {
    onClick();
    setExpanded((v) => !v);
  }, [onClick]);

  return (
    <div
      className="nn-mark-row"
      style={{
        padding: '6px 12px',
        borderBottom: '1px solid var(--border)',
        cursor: 'pointer',
        transition: 'background 80ms',
        opacity: harvested ? 0.6 : 1,
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = '')}
    >
      {/* Quote excerpt row */}
      <div
        onClick={handleClick}
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'flex-start',
        }}
      >
        {/* Color dot (or card icon for kind 'card') */}
        {mark.kind === 'card' ? (
          <span
            style={{
              width: 14,
              height: 14,
              flexShrink: 0,
              marginTop: 1,
              color: 'var(--lime-400)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="5" width="20" height="14" rx="2" />
              <line x1="2" y1="10" x2="22" y2="10" />
            </svg>
          </span>
        ) : (
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              background: MARK_COLOR_HEX[mark.color] ?? 'var(--lime-500)',
              flexShrink: 0,
              marginTop: 4,
            }}
          />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            style={{
              margin: 0,
              fontSize: 12.5,
              color: 'var(--text)',
              lineHeight: 1.45,
              overflow: 'hidden',
              display: '-webkit-box',
              WebkitBoxOrient: 'vertical',
              WebkitLineClamp: expanded ? undefined : 2,
            }}
          >
            {mark.quote}
          </p>
          {mark.kind === 'note' && mark.note && !expanded && (
            <p
              style={{
                margin: '3px 0 0',
                fontSize: 11,
                color: 'var(--text-muted)',
                lineHeight: 1.4,
                fontStyle: 'italic',
                overflow: 'hidden',
                display: '-webkit-box',
                WebkitBoxOrient: 'vertical',
                WebkitLineClamp: 1,
              }}
            >
              {mark.note}
            </p>
          )}
          {harvested && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                marginTop: 4,
                padding: '1px 6px',
                borderRadius: 'var(--r-pill)',
                background: 'color-mix(in srgb, var(--lime-500) 14%, transparent)',
                color: 'var(--lime-400)',
                fontSize: 10,
                fontWeight: 600,
                fontFamily: 'var(--font-sans)',
                lineHeight: 1.4,
              }}
            >
              {t('notebooks.harvest.badge')}
            </span>
          )}
        </div>
        {/* Hover-revealed delete */}
        <Button variant="bare"
          type="button"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title={t('notebooks.marks.delete')}
          className="nn-mark-row-actions"
          style={{
            width: 22,
            height: 22,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            background: 'transparent',
            color: 'var(--text-dim)',
            cursor: 'pointer',
            borderRadius: 'var(--r-xs)',
            flexShrink: 0,
            fontSize: 13,
            lineHeight: 1,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--rose-400)')}
          onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-dim)')}
        >
          ×
        </Button>
      </div>

      {/* Expanded controls */}
      {expanded && (
        <div style={{ marginTop: 8, marginLeft: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {mark.kind === 'card' ? (
            /* Card marks: read-only — show jump-to-card button only. */
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              {mark.cardId && onOpenCard && (
                <Button variant="bare"
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onOpenCard(mark.cardId!); }}
                  style={{
                    height: 24,
                    padding: '0 9px',
                    borderRadius: 'var(--r-sm)',
                    border: '1px solid var(--lime-500)',
                    background: 'color-mix(in srgb, var(--lime-500) 10%, var(--surface))',
                    color: 'var(--lime-400)',
                    cursor: 'pointer',
                    fontSize: 11,
                    fontWeight: 600,
                    fontFamily: 'var(--font-sans)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('notebooks.marks.openCard')}
                </Button>
              )}
            </div>
          ) : (
            <>
              {/* Color picker + «В карточку» */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                {SOURCE_MARK_COLORS.map((c) => (
                  <Button variant="bare"
                    key={c}
                    type="button"
                    title={t(`notebooks.marks.color_${c}`)}
                    aria-pressed={mark.color === c}
                    onClick={() => onColorChange(c)}
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: '50%',
                      background: MARK_COLOR_HEX[c],
                      border: mark.color === c
                        ? '2px solid var(--text)'
                        : '2px solid transparent',
                      boxShadow: mark.color === c
                        ? '0 0 0 1px var(--surface-2)'
                        : 'var(--mark-swatch-shadow)',
                      cursor: 'pointer',
                      padding: 0,
                      transition: 'box-shadow 100ms',
                    }}
                  />
                ))}
                {/* «В карточку» — open the quick-card dialog prefilled from this mark. */}
                <Button variant="bare"
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onToCard(); }}
                  style={{
                    marginLeft: 'auto',
                    height: 24,
                    padding: '0 9px',
                    borderRadius: 'var(--r-sm)',
                    border: '1px solid var(--border)',
                    background: 'var(--surface-2)',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    fontSize: 11,
                    fontWeight: 600,
                    fontFamily: 'var(--font-sans)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('notebooks.marks.cardAction')}
                </Button>
              </div>
              {/* Note textarea */}
              <textarea
                value={noteEdit}
                onChange={(e) => setNoteEdit(e.target.value)}
                onBlur={() => { if (noteEdit !== (mark.note ?? '')) onNoteChange(noteEdit); }}
                placeholder={t('notebooks.marks.notePlaceholder')}
                rows={2}
                style={{
                  width: '100%',
                  padding: '5px 7px',
                  borderRadius: 'var(--r-sm)',
                  border: '1px solid var(--border)',
                  background: 'var(--surface-2)',
                  color: 'var(--text)',
                  fontSize: 12,
                  fontFamily: 'var(--font-sans)',
                  resize: 'vertical',
                  boxSizing: 'border-box',
                  lineHeight: 1.4,
                }}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}
