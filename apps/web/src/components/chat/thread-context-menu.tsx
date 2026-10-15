'use client';

/* eslint-disable react/forbid-elements -- TODO: replace raw input, select, and button with TextInput, Button, or NNSelect. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTransientLayer } from '@/lib/use-transient-layer';
import { createPortal } from 'react-dom';
import { NNIcon } from '@/components/ui';

export interface ThreadMenuAction { label: string; icon: string; danger?: boolean; run: () => void }
export function ThreadContextMenu({ x, y, label, actions, anchor, onClose }: {
  x: number; y: number; label: string; actions: ThreadMenuAction[]; anchor: HTMLElement;
  onClose: (restoreFocus: boolean) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const layer = useTransientLayer({ root: ref, onClose: reason => onClose(reason !== 'outside' && reason !== 'navigation'), restoreFocus: false });
  const [position, setPosition] = useState({ x, y });
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    setPosition({ x: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)), y: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) });
    menu.querySelector<HTMLButtonElement>('button')?.focus();
  }, [x, y]);
  useEffect(() => {
    const dismiss = () => onClose(false);
    const scroll = (event: Event) => { if (!ref.current?.contains(event.target as Node)) dismiss(); };
    window.addEventListener('scroll', scroll, true);
    return () => {
      window.removeEventListener('scroll', scroll, true);
    };
  }, [onClose, anchor]);
  return createPortal(<div ref={ref} className="reomi-thread-menu" role="menu" aria-label={label}
    style={{ left: position.x, top: position.y }} onContextMenu={event => event.preventDefault()}
    onKeyDown={event => {
      if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); void layer.close(); return; }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }}>
    {actions.map(action => <button key={action.label} type="button" role="menuitem" data-danger={action.danger || undefined}
      onClick={() => { void layer.close().then(closed => { if (closed) action.run(); }); }}><NNIcon name={action.icon} size={16} /><span>{action.label}</span></button>)}
  </div>, document.body);
}
