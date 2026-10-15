'use client';
import { useEffect, useLayoutEffect, useRef, useState, useContext, type CSSProperties } from 'react';
import { NNBtn } from './ui';
import { CardEditor } from './card-editor';
import { ResizeHandle } from './design-system/resize-handle';
import { CARD_PANEL, boundedPanelWidth, readCardPanelWidth } from '@/lib/panel-width';
import { writeBrowserValue } from '@/lib/storage-migration';
import { useT } from '@/lib/i18n';
import type { Card } from '@/lib/types';
import { useIsMobile } from '@/lib/use-breakpoint';
import { LayerParent, useTransientLayer } from '@/lib/use-transient-layer';
import { NavigationReturn } from './navigation';

export function CardDetailPanel({ card, deckName, index, total, onMove, onClose, onOpen, onDeleted, onDirtyChange }: {
  card: Card; deckName: string; index: number; total: number;
  onMove: (delta: 1 | -1) => void; onClose: () => void; onOpen: (id: string) => void;
  onDeleted: (id: string) => void; onDirtyChange: (dirty: boolean) => void;
}) {
  const t = useT();
  const panel = useRef<HTMLElement>(null);
  const mobile = useIsMobile(), parent = useContext(LayerParent);
  const layer = useTransientLayer({ root: panel, enabled: mobile, modal: true, onClose });
  const [preferredWidth, setPreferredWidth] = useState<number>(CARD_PANEL.default);
  const [availableWidth, setAvailableWidth] = useState(1200);
  useLayoutEffect(() => {
    setPreferredWidth(readCardPanelWidth());
    const workspace = panel.current?.closest('.reomi-cards-workspace');
    if (!workspace) return;
    const measure = () => setAvailableWidth(workspace.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);
  const maxWidth = Math.min(CARD_PANEL.max, Math.max(CARD_PANEL.min, availableWidth - 160));
  const width = boundedPanelWidth(preferredWidth, CARD_PANEL.min, maxWidth, CARD_PANEL.default);
  const resize = (value: number) => {
    const next = boundedPanelWidth(value, CARD_PANEL.min, maxWidth, CARD_PANEL.default);
    setPreferredWidth(next);
    try { writeBrowserValue(localStorage, CARD_PANEL.key, String(next)); } catch { /* Keep the in-memory width. */ }
  };
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    heading.current?.focus({preventScroll:true});
    return () => { if (previous?.isConnected) previous.focus({preventScroll:true}); };
  }, []);
  return <LayerParent.Provider value={mobile ? layer.id : parent}><section ref={panel} role={mobile ? 'dialog' : undefined} aria-modal={mobile || undefined} className="reomi-card-detail" aria-labelledby="card-detail-title" style={{ '--card-detail-width': `${width}px` } as CSSProperties}>
    {availableWidth > 900 && <ResizeHandle edge="left" width={width} min={CARD_PANEL.min} max={maxWidth} defaultWidth={CARD_PANEL.default}
      label={t('cards.panel.resizeWidth')} onChange={resize} />}
    <header className="reomi-card-detail-header">
      <NavigationReturn />
      <div><h2 id="card-detail-title" ref={heading} tabIndex={-1}>{t('cards.panel.title')}</h2><span>{deckName}</span></div>
      <span className="reomi-card-detail-position">{index >= 0 ? `${index + 1} / ${total}` : ''}</span>
      <NNBtn size="sm" icon="chevl" ariaLabel={t('cards.panel.prev')} disabled={index <= 0} onClick={() => onMove(-1)} />
      <NNBtn size="sm" icon="chevr" ariaLabel={t('cards.panel.next')} disabled={index < 0 || index >= total - 1} onClick={() => onMove(1)} />
      <NNBtn size="sm" icon="x" ariaLabel={t('cards.panel.close')} onClick={() => mobile ? void layer.close() : onClose()} />
    </header>
    <CardEditor card={card} onOpen={onOpen} onDeleted={onDeleted} onDirtyChange={onDirtyChange} onSaved={() => onDirtyChange(false)} />
  </section></LayerParent.Provider>;
}
