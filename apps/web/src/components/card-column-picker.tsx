'use client';

/* eslint-disable react/forbid-elements -- #78 #72 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { NNBtn } from './ui';
import { Checkbox } from './design-system/primitives';
import { CARD_COLUMNS } from '@/lib/card-columns';
import { useT } from '@/lib/i18n';

export function CardColumnPicker({ selected, onChange, onReset }: {
  selected: string[]; onChange: (ids: string[]) => void; onReset: () => void;
}) {
  const t = useT();
  const id = useId();
  const trigger = useRef<HTMLSpanElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const close = (focus = false) => { setOpen(false); if (focus) trigger.current?.querySelector('button')?.focus(); };
  useLayoutEffect(() => {
    if (!open || !trigger.current || !popup.current) return;
    const anchor = trigger.current.getBoundingClientRect(), panel = popup.current.getBoundingClientRect();
    setPosition({ left: Math.max(8, Math.min(anchor.right - panel.width, window.innerWidth - panel.width - 8)), top: Math.max(8, Math.min(anchor.bottom + 7, window.innerHeight - panel.height - 8)) });
    popup.current.querySelector<HTMLInputElement>('input:not(:disabled)')?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!popup.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    const scroll = (event: Event) => { if (!popup.current?.contains(event.target as Node)) setOpen(false); };
    const resize = () => setOpen(false);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('scroll', scroll);
    window.addEventListener('resize', resize);
    return () => { document.removeEventListener('pointerdown', outside); window.removeEventListener('scroll', scroll); window.removeEventListener('resize', resize); };
  }, [open]);
  return <span ref={trigger} className="reomi-columns-control">
    <NNBtn icon="panel" variant={open ? 'soft' : 'ghost'} ariaLabel={t('cards.columnPicker.title')} title={t('cards.columnPicker.title')}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)} />
    {open && createPortal(<div id={id} ref={popup} role="dialog" aria-label={t('cards.columnPicker.title')} className="reomi-column-picker" style={position}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); } }}
      onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node) && !trigger.current?.contains(event.relatedTarget as Node)) close(); }}>
      <header><strong>{t('cards.columnPicker.title')}</strong><span>{selected.length} / {CARD_COLUMNS.length}</span></header>
      <div>{CARD_COLUMNS.map(column => <Checkbox key={column.id} checked={selected.includes(column.id)} disabled={column.id === 'question'}
        onChange={checked => onChange(checked ? [...selected, column.id] : selected.filter(id => id !== column.id))}>
        <span>{t(column.labelKey)}</span>
        {column.id === 'question' && <small>{t('cards.columnPicker.required')}</small>}
      </Checkbox>)}</div>
      <footer><NNBtn size="sm" variant="soft" icon="sync" onClick={onReset}>{t('cards.columnPicker.reset')}</NNBtn></footer>
    </div>, document.body)}
  </span>;
}
