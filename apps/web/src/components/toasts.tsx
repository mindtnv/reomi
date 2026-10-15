'use client';

/* eslint-disable react/forbid-elements -- #78 */

import React, { useEffect, useRef, useState, type CSSProperties } from 'react';
import { NNIcon, type IconName } from './ui';
import { useT } from '@/lib/i18n';

export type ToastKind = 'freeze' | 'dailyGoal' | 'leech' | 'info' | 'success' | 'error';
export interface ToastPayload {
  id?: string;
  kind: ToastKind;
  title?: string;
  description?: string;
  titleKey?: string;
  descriptionKey?: string;
  durationMs?: number;
  action?: { label: string; onClick: () => void };
}
interface ToastState extends ToastPayload { id: string; }
const KIND_META: Record<ToastKind, { icon: IconName; accent: string }> = {
  freeze: { icon: 'check', accent: 'var(--sky-400)' },
  dailyGoal: { icon: 'trophy', accent: 'var(--accent-500)' },
  leech: { icon: 'pause', accent: 'var(--amber-400)' },
  info: { icon: 'check', accent: 'var(--text-muted)' },
  success: { icon: 'check', accent: 'var(--accent-500)' },
  error: { icon: 'warning', accent: 'var(--rose-400)' },
};
function Toast({ toast, onDismiss }: { toast: ToastState; onDismiss: (id: string) => void }) {
  const t = useT();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (hovered || focused) return;
    const timer = window.setTimeout(() => dismiss.current(toast.id), toast.durationMs ?? (toast.kind === 'error' ? 6500 : 4200));
    return () => window.clearTimeout(timer);
  }, [toast, hovered, focused]);
  const meta = KIND_META[toast.kind];
  const title = toast.titleKey ? t(toast.titleKey) : toast.title;
  const description = toast.descriptionKey ? t(toast.descriptionKey) : toast.description;
  return <div className="reomi-toast" role={toast.kind === 'error' ? 'alert' : 'status'}
    style={{ '--toast-accent': meta.accent } as CSSProperties}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setFocused(false); }}>
    <span className="reomi-toast-icon" aria-hidden><NNIcon name={meta.icon} size={17} /></span>
    <div className="reomi-toast-copy">{title && <strong>{title}</strong>}{description && <p>{description}</p>}
      {toast.action && <button type="button" className="nn-toast-action" onClick={toast.action.onClick}>{toast.action.label}</button>}
    </div>
    <button type="button" aria-label={t('actions.close')} onClick={() => onDismiss(toast.id)}><NNIcon name="x" size={14} /></button>
  </div>;
}
export function ToastsStack() {
  const [toasts, setToasts] = useState<ToastState[]>([]);
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<ToastPayload>).detail;
      if (!detail || !KIND_META[detail.kind]) return;
      const id = detail.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setToasts(previous => [...previous.filter(toast => toast.id !== id), { ...detail, id }].slice(-4));
    };
    window.addEventListener('nn:toast', handler);
    return () => window.removeEventListener('nn:toast', handler);
  }, []);
  return <div className="reomi-toast-stack">{toasts.map(toast => <Toast key={toast.id} toast={toast} onDismiss={id => setToasts(previous => previous.filter(item => item.id !== id))} />)}</div>;
}
export function raiseToast(payload: ToastPayload) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<ToastPayload>('nn:toast', { detail: payload }));
}
