'use client';

/* eslint-disable react/forbid-elements -- TODO: replace raw input, select, and button with TextInput, Button, or NNSelect. */

// M4 — the floating reader toolbar (inside the reader panel, thumb-reachable on
// iPad: ≥40 px touch targets). Tools hand/pen/highlighter/eraser, 6 colors, 3
// widths, undo/redo, finger-draw toggle, zoom −/%/＋, page jump, and the
// reading controls. All labels i18n (notebooks.reader.*). The local
// inline SVGs cover the ink tools the global NNIcon set doesn't have.
//
// M5-T3 — visual polish: one compact sticky row, frosted backdrop, segmented
// aligned control groups, compact icon buttons (.nn-tb-btn), save-status
// as a tiny pulsing/idle dot with tooltip. Colors+widths collapsed into the
// a contextual second row while drawing, leaving navigation stable.

import React, { useState } from 'react';
import type { InkTool, SaveState } from './types';
import { INK_COLORS, INK_WIDTHS } from './types';

type T = (key: string, params?: Record<string, string | number>) => string;

// ── Local inline icons (ink tools not in the global NNIcon set) ───────────────
const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};
const ToolIcon = ({ name, size = 16 }: { name: InkTool | 'undo' | 'redo' | 'zin' | 'zout' | 'mode' | 'markup' | 'toc'; size?: number }) => {
  const paths: Record<string, React.ReactNode> = {
    // L2 — table of contents (list-with-bullets).
    toc: <><path d="M8 6h13M8 12h13M8 18h13" {...stroke} /><circle cx="3.5" cy="6" r="1" {...stroke} /><circle cx="3.5" cy="12" r="1" {...stroke} /><circle cx="3.5" cy="18" r="1" {...stroke} /></>,
    hand: <path d="M8 13V5.5a1.5 1.5 0 013 0V11m0-1.5a1.5 1.5 0 013 0V12m0-1a1.5 1.5 0 013 0v4a5 5 0 01-5 5h-1.5a4 4 0 01-3-1.4L7 16c-1-1.2-2-2-2-3.2 0-1.2 1.4-1.6 2.4-.6L8 13" {...stroke} />,
    pen: <path d="M4 20h4L19 9a2 2 0 00-3-3L5 17l-1 3zM14 7l3 3" {...stroke} />,
    highlighter: <><path d="M9 14l-3 3 .5 2.5L9 20l9-9-3-3-6 6z" {...stroke} /><path d="M14 6l4 4 2-2a2 2 0 00-3-3l-3 1z" {...stroke} /><path d="M5 21h6" {...stroke} /></>,
    eraser: <><path d="M7 17l-3-3a2 2 0 010-3l7-7a2 2 0 013 0l4 4a2 2 0 010 3l-6 6H8z" {...stroke} /><path d="M10 8l6 6" {...stroke} /></>,
    // W3 — smart-card (✨ wand): marquee-select a region → AI proposes a card.
    'smart-card': <><path d="M5 3v4M3 5h4M19 17v4M17 19h4M13 3l2 2-8 8-2-2 8-8z" {...stroke} /><path d="M13 3l2 2" {...stroke} /></>,
    undo: <path d="M9 7L4 12l5 5M4 12h11a5 5 0 010 10h-1" {...stroke} />,
    redo: <path d="M15 7l5 5-5 5M20 12H9a5 5 0 000 10h1" {...stroke} />,
    zin:  <><circle cx="10.5" cy="10.5" r="6" {...stroke} /><path d="M20 20l-5-5M10.5 8v5M8 10.5h5" {...stroke} /></>,
    zout: <><circle cx="10.5" cy="10.5" r="6" {...stroke} /><path d="M20 20l-5-5M8 10.5h5" {...stroke} /></>,
    mode: <><rect x="3" y="4" width="8" height="16" rx="1.5" {...stroke} /><path d="M14 7h7M14 12h7M14 17h5" {...stroke} /></>,
    markup: <><path d="M12 20h9M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" {...stroke} /></>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: 'block' }}>
      {paths[name] ?? null}
    </svg>
  );
};

// Shared-size toolbar button using the .nn-tb-btn CSS class.
const TBtn = ({
  active,
  disabled,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    data-tooltip={title}
    aria-label={title}
    aria-pressed={active}
    className={`nn-tb-btn${active ? ' active' : ''}`}
  >
    {children}
  </button>
);

export interface ReaderToolbarProps {
  tool: InkTool;
  color: string;
  widthIdx: number;
  fingerDraw: boolean;
  scale: number;
  page: number;
  total: number;
  saveState: SaveState;
  canUndo: boolean;
  canRedo: boolean;
  marksCount?: number;
  marksPanelOpen?: boolean;
  onToggleMarksPanel?: () => void;
  /** L2 — table-of-contents toggle (library reader). Hidden when undefined or
   *  the document has no outline/headings (`tocAvailable === false`). */
  tocOpen?: boolean;
  tocAvailable?: boolean;
  onToggleToc?: () => void;
  onTool: (t: InkTool) => void;
  onColor: (hex: string) => void;
  onWidth: (idx: number) => void;
  onFingerDraw: (v: boolean) => void;
  onZoom: (delta: number) => void;
  onZoomReset: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onJumpPage: (page: number) => void;
  onRetrySave: () => void;
  t: T;
}

export const ReaderToolbar = ({
  tool,
  color,
  widthIdx,
  fingerDraw,
  scale,
  page,
  total,
  saveState,
  canUndo,
  canRedo,
  marksCount = 0,
  marksPanelOpen = false,
  onToggleMarksPanel,
  tocOpen = false,
  tocAvailable = false,
  onToggleToc,
  onTool,
  onColor,
  onWidth,
  onFingerDraw,
  onZoom,
  onZoomReset,
  onUndo,
  onRedo,
  onJumpPage,
  onRetrySave,
  t,
}: ReaderToolbarProps) => {
  const showInkExtras = tool !== 'hand' && tool !== 'eraser' && tool !== 'smart-card';
  const [jumpVal, setJumpVal] = useState(String(page));

  // Keep jump input in sync with programmatic page changes.
  React.useEffect(() => { setJumpVal(String(page)); }, [page]);

  const commitPage = () => {
    const value = Number(jumpVal);
    if (!jumpVal.trim() || !Number.isFinite(value) || value < 1) { setJumpVal(String(page)); return; }
    const next = Math.min(total || 1, Math.round(value));
    setJumpVal(String(next));
    onJumpPage(next);
  };

  return (
    <div role="toolbar" aria-label={t('notebooks.reader.toolbar')} className="nn-chrome nn-reader-toolbar reomi-pdf-toolbar">
      <div className="reomi-reader-toolbar-row nn-scroll">
        {onToggleToc && tocAvailable && <div className="reomi-reader-group" role="group" aria-label={t('notebooks.reader.readingGroup')}>
          <TBtn active={tocOpen} onClick={onToggleToc} title={t('library.reader.toc')}><ToolIcon name="toc" /></TBtn>
        </div>}

        <div className="reomi-reader-group reomi-reader-tools" role="group" aria-label={t('notebooks.reader.inkGroup')}>
          <TBtn active={tool === 'hand'} onClick={() => onTool('hand')} title={t('notebooks.reader.toolHand')}><ToolIcon name="hand" /></TBtn>
          <TBtn active={tool === 'pen'} onClick={() => onTool('pen')} title={t('notebooks.reader.toolPen')}><ToolIcon name="pen" /></TBtn>
          <TBtn active={tool === 'highlighter'} onClick={() => onTool('highlighter')} title={t('notebooks.reader.toolHighlighter')}><ToolIcon name="highlighter" /></TBtn>
          <TBtn active={tool === 'eraser'} onClick={() => onTool('eraser')} title={t('notebooks.reader.toolEraser')}><ToolIcon name="eraser" /></TBtn>
          <TBtn active={tool === 'smart-card'} onClick={() => onTool('smart-card')} title={t('notebooks.reader.toolSmartCard')}><ToolIcon name="smart-card" /></TBtn>
        </div>
        <div className="reomi-reader-group">
          <TBtn disabled={!canUndo} onClick={onUndo} title={t('notebooks.reader.undo')}><ToolIcon name="undo" /></TBtn>
          <TBtn disabled={!canRedo} onClick={onRedo} title={t('notebooks.reader.redo')}><ToolIcon name="redo" /></TBtn>
          {onToggleMarksPanel && <TBtn active={marksPanelOpen} onClick={onToggleMarksPanel} title={t('notebooks.marks.panelTitle')}>
            <span className="reomi-reader-marks-icon"><ToolIcon name="markup" />{marksCount > 0 && <span>{marksCount > 99 ? '99+' : marksCount}</span>}</span>
          </TBtn>}
        </div>

        <div className="reomi-reader-navigation" role="group" aria-label={t('notebooks.reader.navigationGroup')}>
          <div className="reomi-reader-group reomi-reader-zoom">
            <TBtn onClick={() => onZoom(-0.2)} title={t('notebooks.reader.zoomOut')}><ToolIcon name="zout" /></TBtn>
            <button type="button" className="reomi-reader-zoom-value" onClick={onZoomReset} aria-label={t('notebooks.reader.zoomReset')}
              data-tooltip={t('notebooks.reader.zoomReset')}>{Math.round(scale * 100)}%</button>
            <TBtn onClick={() => onZoom(0.2)} title={t('notebooks.reader.zoomIn')}><ToolIcon name="zin" /></TBtn>
          </div>
          <div className="reomi-reader-group reomi-reader-page">
            <input type="number" min={1} max={total || 1} value={jumpVal}
              onChange={event => setJumpVal(event.target.value)} onBlur={commitPage}
              onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitPage(); } }}
              aria-label={t('notebooks.reader.pageJump')} data-tooltip={t('notebooks.reader.pageJump')} />
            <span>/ {total || '—'}</span>
          </div>
          <SaveDot saveState={saveState} onRetry={onRetrySave} t={t} />
        </div>
      </div>

      {showInkExtras && <div className="reomi-reader-ink-options nn-scroll" role="group" aria-label={t('notebooks.reader.inkOptions')}>
        <span className="reomi-reader-options-label">{t(tool === 'pen' ? 'notebooks.reader.toolPen' : 'notebooks.reader.toolHighlighter')}</span>
        <div className="reomi-reader-group">
          {INK_COLORS.map(c => <button key={c.id} type="button" className="reomi-reader-color" onClick={() => onColor(c.hex)}
            aria-label={t(`notebooks.reader.color_${c.id}`)} data-tooltip={t(`notebooks.reader.color_${c.id}`)} aria-pressed={color === c.hex}>
            <span style={{ background: c.hex }} />
          </button>)}
        </div>
        <div className="reomi-reader-group reomi-reader-widths">
          {INK_WIDTHS.map((_, i) => <TBtn key={i} active={widthIdx === i} onClick={() => onWidth(i)} title={t('notebooks.reader.width', { n: i + 1 })}>
            <span style={{ width: 14 + i * 2, height: (i + 1) * 2 + 1, borderRadius: 99, background: 'currentColor' }} />
          </TBtn>)}
        </div>
      </div>}
    </div>
  );
};

const SaveDot = ({ saveState, onRetry, t }: { saveState: SaveState; onRetry: () => void; t: T }) => {
  if (saveState === 'idle') return null;
  if (saveState === 'error') {
    return (
      <button
        type="button"
        onClick={onRetry}
        data-tooltip={t('notebooks.reader.saveError')}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          height: 'var(--reader-control)',
          padding: '0 8px',
          borderRadius: 'var(--r-sm)',
          border: '1px solid var(--rose-400)',
          background: 'var(--tone-rose-bg)',
          color: 'var(--rose-400)',
          cursor: 'pointer',
          fontSize: 11.5,
          fontWeight: 600,
          fontFamily: 'var(--font-sans)',
          flexShrink: 0,
        }}
      >
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--rose-400)', flexShrink: 0 }} />
        {t('notebooks.reader.saveError')}
      </button>
    );
  }
  const dotColor = saveState === 'saving' ? 'var(--amber-400)' : 'var(--lime-400)';
  const dotClass = saveState === 'saving' ? 'nn-save-dot-saving' : '';
  return (
    <span
      data-tooltip={t(saveState === 'saving' ? 'notebooks.reader.saving' : 'notebooks.reader.saved')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 4px',
        flexShrink: 0,
      }}
    >
      <span className={dotClass} style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor, display: 'block' }} />
    </span>
  );
};
