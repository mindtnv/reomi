'use client';

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ASSISTANT_CONTEXT_LIMITS, MARK_NOTE_MAX, MARK_QUOTE_MAX, MARK_RECTS_MAX, SOURCE_MARK_COLORS, type MarkRect, type SourceMarkColor } from '@reomi/shared';
import { clientRectsToMarkRects } from '@/lib/pdf-ink';
import { NNBtn, NNIcon } from '@/components/ui';
import { copyCodeText } from '@/components/chat/code-copy';
import { MARK_COLOR_CSS } from './mark-colors';
import { transientLayers } from '@/lib/layer-stack';
import { useTransientLayer } from '@/lib/use-transient-layer';
import { useNavigationGuard } from '@/components/navigation';
import { useDialog } from '@/components/dialog';

type T = (key: string, params?: Record<string, string | number>) => string;
export interface SelectionInfo {
  text: string; rects: MarkRect[]; page: number;
  anchorX: number; anchorY: number; anchorBottom: number;
}
export interface SelectionPopoverProps {
  pageEls: Map<number, HTMLDivElement>; handMode: boolean;
  onHighlight(info: SelectionInfo, color: SourceMarkColor): void | Promise<void>;
  onNote(info: SelectionInfo, text: string): void | Promise<void>;
  onCard(info: SelectionInfo): void; onAsk(info: SelectionInfo): void; t: T;
}
interface State { info: SelectionInfo; noteOpen: boolean; noteText: string; busy: boolean; error: string | null }

export function SelectionPopover({ pageEls, handMode, onHighlight, onNote, onCard, onAsk, t }: SelectionPopoverProps) {
  const { select } = useDialog();
  const [state, setState] = useState<State | null>(null);
  const [placement, setPlacement] = useState<React.CSSProperties>({ left: 8, top: 8, width: 360 });
  const root = useRef<HTMLDivElement>(null), noteRef = useRef<HTMLTextAreaElement>(null);
  const rangeRef = useRef<Range | null>(null), interacting = useRef(false), alive = useRef(true);
  const current = useRef(state); current.current = state;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const dismiss = useCallback(() => { interacting.current = false; rangeRef.current = null; setState(null); window.getSelection()?.removeAllRanges(); }, []);
  const layer = useTransientLayer({ root, enabled: Boolean(state), busy: Boolean(state?.busy), onClose: dismiss });
  useNavigationGuard(async () => {
    const selected = current.current;
    if (!selected) return true;
    if (selected.busy) return false;
    if (!selected.noteOpen || !selected.noteText.trim()) return true;
    const choice = await select({ title: t('editor.draft.leaveTitle'), value: 'save', options: [
      { value: 'save', label: t('editor.draft.saveAndLeave') }, { value: 'discard', label: t('editor.draft.discardAndLeave') },
    ], cancelLabel: t('editor.draft.stay') });
    if (!alive.current || current.current?.info !== selected.info) return false;
    if (choice === 'discard') return true;
    if (choice !== 'save') return false;
    setState(value => value ? { ...value, busy: true, error: null } : value);
    try { await onNote(selected.info, selected.noteText.trim()); dismiss(); return true; }
    catch { setState(value => value ? { ...value, busy: false, error: 'assistant.selectionSaveFailed' } : value); return false; }
  }, state && (state.noteOpen || state.busy) ? layer.id : false);
  useEffect(() => { if (!handMode) dismiss(); }, [handMode, dismiss]);
  const capture = useCallback(() => {
    if (!handMode || current.current?.noteOpen || current.current?.busy || interacting.current || root.current?.contains(document.activeElement)) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) { setState(null); return; }
    const range = selection.getRangeAt(0), text = range.toString().trim();
    if (!text) { setState(null); return; }
    const entry = [...pageEls].find(([, element]) => element.contains(range.commonAncestorContainer));
    if (!entry) { setState(null); return; }
    const [page, element] = entry, box = element.getBoundingClientRect();
    // Browser range rectangles also include PDF layout sentinels and wrapper
    // boxes. Measure only selected glyph text, excluding whitespace sentinels.
    const layer = element.querySelector('.nn-textlayer');
    const clientRects: DOMRect[] = [];
    if (layer) {
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        if (!node.textContent?.trim() || !range.intersectsNode(node)) continue;
        const glyphRange = document.createRange();
        glyphRange.selectNodeContents(node);
        if (node === range.startContainer) glyphRange.setStart(node, range.startOffset);
        if (node === range.endContainer) glyphRange.setEnd(node, range.endOffset);
        if (!glyphRange.collapsed) clientRects.push(...Array.from(glyphRange.getClientRects()));
      }
    } else clientRects.push(...Array.from(range.getClientRects()));
    const rects = clientRectsToMarkRects(clientRects, box).slice(0, MARK_RECTS_MAX);
    if (!rects.length) { setState(null); return; }
    const first = clientRects[0]!;
    rangeRef.current = range.cloneRange();
    setState({ info: { text, rects, page, anchorX: (first.left + first.right) / 2, anchorY: first.top, anchorBottom: first.bottom }, noteOpen: false, noteText: '', busy: false, error: null });
  }, [handMode, pageEls]);
  useEffect(() => {
    let frame = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const up = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(capture); };
    const selection = () => { clearTimeout(timer); timer = setTimeout(capture, 60); };
    window.addEventListener('pointerup', up); document.addEventListener('selectionchange', selection);
    return () => { cancelAnimationFrame(frame); clearTimeout(timer); window.removeEventListener('pointerup', up); document.removeEventListener('selectionchange', selection); };
  }, [capture]);
  useLayoutEffect(() => {
    if (!state || !root.current) return;
    const position = () => {
      const viewport = window.visualViewport;
      const width = Math.min(360, (viewport?.width ?? window.innerWidth) - 16);
      const minX = (viewport?.offsetLeft ?? 0) + 8, minY = (viewport?.offsetTop ?? 0) + 8;
      const maxHeight = Math.max(100, (viewport?.height ?? window.innerHeight) - 16);
      const r = rangeRef.current?.getClientRects()[0];
      const center = r ? (r.left + r.right) / 2 : state.info.anchorX;
      const anchorTop = r?.top ?? state.info.anchorY, anchorBottom = r?.bottom ?? state.info.anchorBottom;
      const height = Math.min(root.current?.getBoundingClientRect().height ?? 230, maxHeight);
      const above = anchorTop - height - 10;
      const top = Math.max(minY, Math.min(above >= minY ? above : anchorBottom + 10, minY + maxHeight - height));
      setPlacement({ left: Math.max(minX, Math.min(center - width / 2, minX + (viewport?.width ?? window.innerWidth) - 16 - width)), top, width, maxHeight });
    };
    position();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(position);
    observer?.observe(root.current);
    window.addEventListener('resize', position); window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position); window.visualViewport?.addEventListener('scroll', position);
    return () => { observer?.disconnect(); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); window.visualViewport?.removeEventListener('resize', position); window.visualViewport?.removeEventListener('scroll', position); };
  }, [state?.info, state?.noteOpen]);
  if (!state) return null;
  const { info, noteOpen, noteText, busy, error } = state;
  const markTooLong = info.text.length > MARK_QUOTE_MAX;
  const askTooLong = info.text.length > ASSISTANT_CONTEXT_LIMITS.excerptChars;
  const allowAction = async () => {
    const registered = transientLayers.get(layer.id);
    return !registered || await transientLayers.canDismiss(registered);
  };
  const run = async (action: () => void | Promise<void>, errorKey = 'assistant.selectionSaveFailed', guard = true, closeAfter = true) => {
    if (guard && noteOpen && noteText.trim() && !await allowAction()) return;
    if (!alive.current) return;
    setState(value => value ? { ...value, busy: true, error: null } : value);
    try {
      await action();
      if (alive.current && current.current?.info === info) {
        if (closeAfter) { dismiss(); window.getSelection()?.removeAllRanges(); }
        else setState(value => value?.info === info ? { ...value, busy: false, error: null } : value);
      }
    } catch {
      if (alive.current) setState(value => value?.info === info ? { ...value, busy: false, error: errorKey } : value);
    }
  };
  const pageElement = pageEls.get(info.page);
  return <>{pageElement && createPortal(<div aria-hidden="true" data-pdf-selection-paint style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 2, opacity: 0.3, mixBlendMode: 'multiply' }}>
    {info.rects.map((rect, index) => <div key={index} style={{ position: 'absolute', left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%`, background: 'var(--accent-500)' }}/>)}</div>, pageElement)}{createPortal(<div ref={root} id="nn-sel-popover" className="reomi-pdf-selection" role="dialog" aria-label={t('notebooks.marks.selectionTitle')} style={placement}
    onPointerDownCapture={() => { interacting.current = true; }} onMouseDown={event => { if ((event.target as HTMLElement).closest('button')) event.preventDefault(); }}
    onKeyDown={event => { event.stopPropagation(); }}>
    <header><span>{t('notebooks.marks.selectionTitle')} · {t('notebooks.marks.pageGroup', { n: info.page })}</span><NNBtn size="sm" variant="ghost" icon="x" ariaLabel={t('actions.close')} onClick={() => void layer.close()}/></header>
    <blockquote title={info.text}>{info.text}</blockquote>
    <div className="reomi-pdf-selection-colors" role="group" aria-label={t('notebooks.marks.highlightColors')}>
      {SOURCE_MARK_COLORS.map(color => <button key={color} type="button" disabled={busy || markTooLong} aria-label={t(`notebooks.marks.color_${color}`)} title={t(markTooLong ? 'notebooks.marks.selectionTooLong' : `notebooks.marks.color_${color}`)} onClick={() => void run(() => onHighlight(info, color))}>
        <span style={{ background: MARK_COLOR_CSS[color] }}/>
      </button>)}
    </div>
    <div className="reomi-pdf-selection-actions">
      <NNBtn variant="soft" size="sm" icon="chat" disabled={busy || askTooLong} title={askTooLong ? t('notebooks.marks.selectionTooLong') : undefined} onClick={() => void run(() => onAsk(info))}>{t('assistant.askObject')}</NNBtn>
      <NNBtn variant="ghost" size="sm" icon="cards" disabled={busy || askTooLong} onClick={() => void run(() => onCard(info))}>{t('notebooks.marks.cardAction')}</NNBtn>
      <NNBtn variant="ghost" size="sm" icon="edit" disabled={busy || markTooLong} onClick={async () => { if (noteOpen && noteText.trim() && !await allowAction()) return; setState(value => value ? { ...value, noteOpen: !value.noteOpen, ...(value.noteOpen ? { noteText: '' } : {}) } : value); if (!noteOpen) requestAnimationFrame(() => noteRef.current?.focus({ preventScroll: true })); }}>{t('notebooks.marks.note')}</NNBtn>
      <NNBtn variant="ghost" size="sm" icon="copy" disabled={busy} onClick={() => void run(() => copyCodeText(info.text), 'notebooks.marks.copyFailed', false, !noteOpen)}>{t('notebooks.marks.copyAction')}</NNBtn>
    </div>
    {markTooLong && <small>{t('notebooks.marks.selectionTooLong')}</small>}
    {noteOpen && <div className="reomi-pdf-selection-note"><textarea ref={noteRef} aria-label={t('notebooks.marks.note')} placeholder={t('notebooks.marks.notePlaceholder')} value={noteText} maxLength={MARK_NOTE_MAX} disabled={busy} rows={3} onChange={event => setState(value => value ? { ...value, noteText: event.target.value } : value)}/>
      <NNBtn variant="primary" size="sm" disabled={busy || !noteText.trim()} onClick={() => void run(() => onNote(info, noteText.trim()), 'assistant.selectionSaveFailed', false)}>{t('notebooks.marks.noteSave')}</NNBtn></div>}
    {busy && <small role="status">{t('states.loading')}</small>}
    {error && <p role="alert">{t(error)}</p>}
  </div>, document.body)}</>;
}
