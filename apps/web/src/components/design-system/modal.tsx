'use client';

import { useEffect, useId, useRef, useImperativeHandle, type Ref, type ReactNode } from 'react';
import { Button } from './primitives';
import { LayerParent, useTransientLayer } from '@/lib/use-transient-layer';
import { useNavigationGuard } from '../navigation';
import { transientLayers } from '@/lib/layer-stack';
export interface ModalHandle { close(): Promise<boolean>; checkClose(): Promise<boolean> }

/** Native modal provides focus containment, inert background and focus restoration. */
export function Modal({ open, title, description, closeLabel, closeIcon, initialFocus, busy = false, onClose, children, className = '', beforeClose, controlRef }: {
  open: boolean; title: string; closeLabel: string; busy?: boolean;
  description?: string; closeIcon?: ReactNode; initialFocus?: 'panel';
  onClose: () => void; children: ReactNode; className?: string;
  beforeClose?: () => Promise<boolean>; controlRef?: Ref<ModalHandle>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const layer = useTransientLayer({ root: ref, enabled: open, onClose, busy, modal: true });
  useImperativeHandle(controlRef, () => ({ close: () => layer.close(), checkClose: async () => { const current = transientLayers.get(layer.id); return !current || await transientLayers.canDismiss(current); } }));
  useNavigationGuard(beforeClose ?? (async () => true), open ? layer.id : false);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      if (initialFocus === 'panel') dialog.focus({ preventScroll: true });
      else dialog.querySelector<HTMLElement>('input:not([type="hidden"]), textarea, select, .reomi-select')?.focus();
    }
    else if (!open && dialog.open) dialog.close();
    return () => { if (dialog.open) dialog.close(); };
  }, [open, initialFocus]);
  return <dialog ref={ref} tabIndex={initialFocus === 'panel' ? -1 : undefined} className={`reomi-modal ${className}`} aria-labelledby={titleId} aria-describedby={description ? `${titleId}-description` : undefined} aria-busy={busy || undefined}
    onCancel={event => { event.preventDefault(); void layer.close('escape'); }}
    onClick={event => {
      if (event.target !== event.currentTarget || busy) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) void layer.close('outside');
    }}>
    <header className="reomi-modal-header"><div><h2 id={titleId}>{title}</h2>
      {description && <p id={`${titleId}-description`} className="reomi-modal-description">{description}</p>}</div>
      <Button variant="ghost" className="reomi-create-icon" aria-label={closeLabel} title={closeLabel} disabled={busy} onClick={() => void layer.close()}>{closeIcon ?? <span aria-hidden>×</span>}</Button>
    </header>
    <LayerParent.Provider value={open ? layer.id : false}>{children}</LayerParent.Provider>
  </dialog>;
}
