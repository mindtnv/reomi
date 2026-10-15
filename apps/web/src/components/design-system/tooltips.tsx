'use client';
import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';

/** One shared overlay for annotated controls, including controls in portals. */
export function Tooltips() {
  const id = useId();
  const [tip, setTip] = useState<{ text: string; x: number; y: number; above: boolean } | null>(null);
  useEffect(() => {
    let target: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previousDescription: string | null = null;
    let activated: HTMLElement | null = null;
    let activatedAt = 0;
    const hide = () => {
      clearTimeout(timer);
      if (target) {
        if (previousDescription === null) target.removeAttribute('aria-describedby');
        else target.setAttribute('aria-describedby', previousDescription);
      }
      target = null;
      setTip(null);
    };
    const show = (event: Event) => {
      if (event instanceof PointerEvent && event.pointerType === 'touch') return;
      const next = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tooltip]') : null;
      if (event.type === 'focusin' && next && next === activated && Date.now() - activatedAt < 500) return;
      if (next === target) return;
      hide();
      const text = next?.dataset.tooltip?.trim();
      if (!next || !text) return;
      target = next;
      previousDescription = next.getAttribute('aria-describedby');
      timer = setTimeout(() => {
        const currentText = next.dataset.tooltip?.trim();
        if (!next.isConnected || !currentText) return hide();
        const rect = next.getBoundingClientRect();
        const above = rect.bottom + 72 > window.innerHeight;
        next.setAttribute('aria-describedby', [previousDescription, id].filter(Boolean).join(' '));
        setTip({ text: currentText, x: Math.min(window.innerWidth - 156, Math.max(156, rect.left + rect.width / 2)), y: above ? rect.top - 8 : rect.bottom + 8, above });
      }, event.type === 'focusin' ? 100 : 450);
    };
    const leave = (event: Event) => {
      const related = (event as MouseEvent | FocusEvent).relatedTarget;
      if (target && related instanceof Node && target.contains(related)) return;
      hide();
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') hide(); };
    document.addEventListener('pointerover', show);
    document.addEventListener('focusin', show);
    document.addEventListener('pointerout', leave);
    document.addEventListener('focusout', leave);
    const pointerDown = (event: Event) => {
      activated = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tooltip]') : null;
      activatedAt = Date.now();
      hide();
    };
    document.addEventListener('pointerdown', pointerDown);
    document.addEventListener('keydown', key);
    window.addEventListener('scroll', hide, true);
    window.addEventListener('resize', hide);
    return () => {
      hide();
      document.removeEventListener('pointerover', show);
      document.removeEventListener('focusin', show);
      document.removeEventListener('pointerout', leave);
      document.removeEventListener('focusout', leave);
      document.removeEventListener('pointerdown', pointerDown);
      document.removeEventListener('keydown', key);
      window.removeEventListener('scroll', hide, true);
      window.removeEventListener('resize', hide);
    };
  }, [id]);
  return tip ? createPortal(<div id={id} role="tooltip" className="reomi-tooltip" style={{ left: tip.x, top: tip.y, transform: `translate(-50%, ${tip.above ? '-100%' : '0'})` }}>{tip.text}</div>, document.body) : null;
}
