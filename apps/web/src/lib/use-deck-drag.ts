'use client';
import { useEffect, useRef, useState, type RefObject, type PointerEvent as ReactPointerEvent } from 'react';
import type { DeckPlacement } from '@reomi/shared';
import type { Deck } from './types';
import { canBeParentOf } from './decks';

type Target = { id: string | null; placement: DeckPlacement };
export function useDeckDrag({ decks, disabled, root, expand, onMove }: {
  decks: Deck[]; disabled: boolean; root: RefObject<HTMLDivElement | null>;
  expand: (id: string) => void; onMove: (id: string, target: string | null, placement: DeckPlacement) => void;
}) {
  const current = useRef({ decks, disabled, expand, onMove });
  current.current = { decks, disabled, expand, onMove };
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<Target | null>(null);
  const session = useRef<{ id: string; pointerId: number; startX: number; startY: number; x: number; y: number; active: boolean; target: Target | null } | null>(null);
  const suppressClick = useRef(false);
  useEffect(() => {
    let frame = 0;
    let clickTimer: ReturnType<typeof setTimeout> | undefined;
    let hovered: string | null = null;
    let hoverSince = 0;
    const finish = (commit: boolean) => {
      const drag = session.current;
      session.current = null; cancelAnimationFrame(frame); hovered = null;
      setDragging(null); setDrop(null);
      if (drag?.active) {
        suppressClick.current = true;
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => { suppressClick.current = false; }, 0);
        if (commit && drag.target && !current.current.disabled) current.current.onMove(drag.id, drag.target.id, drag.target.placement);
      }
    };
    const locate = () => {
      const drag = session.current;
      if (!drag?.active) return;
      const element = document.elementFromPoint(drag.x, drag.y);
      let target: Target | null = null;
      if (element && root.current?.contains(element)) {
        if (element.closest('[data-deck-root-drop]')) target = { id: null, placement: 'inside' };
        else {
          const row = element.closest<HTMLElement>('[data-deck-id]');
          const id = row?.dataset.deckId;
          if (row && id && canBeParentOf(current.current.decks, drag.id, id)) {
            const rect = row.getBoundingClientRect();
            const ratio = (drag.y - rect.top) / rect.height;
            target = { id, placement: ratio < .25 ? 'before' : ratio > .75 ? 'after' : 'inside' };
          }
        }
      }
      drag.target = target;
      setDrop(previous => previous?.id === target?.id && previous?.placement === target?.placement ? previous : target);
      const hover = target?.placement === 'inside' ? target.id : null;
      if (hover !== hovered) { hovered = hover; hoverSince = performance.now(); }
      if (hovered && performance.now() - hoverSince > 650) { current.current.expand(hovered); hoverSince = Infinity; }
      const rect = root.current?.getBoundingClientRect();
      if (rect && root.current && drag.x >= rect.left && drag.x <= rect.right) {
        if (drag.y < rect.top + 40) root.current.scrollTop -= 8;
        else if (drag.y > rect.bottom - 40) root.current.scrollTop += 8;
      }
    };
    const tick = () => { if (session.current?.active) { locate(); frame = requestAnimationFrame(tick); } };
    const move = (event: PointerEvent) => {
      const drag = session.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (current.current.disabled) { finish(false); return; }
      drag.x = event.clientX; drag.y = event.clientY;
      if (!drag.active && Math.hypot(drag.x - drag.startX, drag.y - drag.startY) >= 5) {
        drag.active = true; setDragging(drag.id); frame = requestAnimationFrame(tick);
      }
      if (drag.active) { event.preventDefault(); locate(); }
    };
    const up = (event: PointerEvent) => {
      if (session.current?.pointerId !== event.pointerId) return;
      if (session.current.active) { session.current.x = event.clientX; session.current.y = event.clientY; locate(); }
      finish(true);
    };
    const cancel = () => finish(false);
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && session.current) { event.preventDefault(); cancel(); } };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', key);
    return () => {
      cancelAnimationFrame(frame); clearTimeout(clickTimer); session.current = null;
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel); window.removeEventListener('blur', cancel); window.removeEventListener('keydown', key);
    };
  }, [root]);
  const start = (event: ReactPointerEvent<HTMLElement>, id: string) => {
    if (disabled || event.button !== 0 || event.pointerType === 'touch') return;
    event.stopPropagation(); event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    suppressClick.current = false;
    session.current = { id, pointerId: event.pointerId, startX:event.clientX,startY:event.clientY,x:event.clientX,y:event.clientY,active:false,target:null };
  };
  const consumeClick = () => { const value=suppressClick.current; suppressClick.current=false; return value; };
  return { dragging, drop, start, consumeClick };
}
