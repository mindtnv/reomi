'use client';

/* eslint-disable react/forbid-elements -- #78 */

import { useWindowControlsOverlay } from '@/lib/ui-store';
import { LayerParent, useTransientLayer } from '@/lib/use-transient-layer';
import { assistantFocusControls } from '@/lib/assistant-overlay-focus';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAssistant, useAssistantSnapshot } from './assistant-provider';
import { AssistantView } from './assistant-view';
import { raiseToast } from '@/components/toasts';
import { NNBtn, NNIcon } from '@/components/ui';
import { useT } from '@/lib/i18n';
import { useAppNavigation } from '@/components/navigation';
import { clampAssistantWindow, defaultAssistantWindow, moveAssistantWindow, readAssistantWindow, resizeAssistantWindow, saveAssistantWindow, type AssistantWindowRect } from '@/lib/assistant-window';

export function AssistantHost() {
  const a = useAssistant(), snapshot = useAssistantSnapshot(), t = useT(), router = useAppNavigation();
  const [measuredViewport,setViewport] = useState({ width: 1200,height:800,top:0 });
  const wco = useWindowControlsOverlay();
  const viewport = { ...measuredViewport, insetTop: wco.active && wco.rect ? wco.rect.y + wco.rect.height : 0 };
  const [rect,setRect] = useState<AssistantWindowRect>(() => defaultAssistantWindow(viewport));
  const rectRef = useRef(rect); rectRef.current = rect;
  const [mounted,setMounted] = useState(false);
  const [threadsOpen, setThreadsOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), launcher = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ x:number;y:number;rect:AssistantWindowRect;resize:boolean;pointer:number } | null>(null);
  const mobile = viewport.width < 720;
  const open = snapshot.presentation === 'floating';
  const session = snapshot.selectedKey ? snapshot.sessions[snapshot.selectedKey] : undefined;
  useEffect(() => setThreadsOpen(false), [snapshot.selectedKey]);
  const count = Object.values(snapshot.sessions).filter(s => s.busy || s.unread || s.phase === 'needs_approval').length;
  useLayoutEffect(() => {
    const visual = window.visualViewport;
    const measure = () => ({ width:window.innerWidth, height:visual?.height ?? window.innerHeight, top:Math.max(0,visual?.offsetTop ?? 0) });
    const initial = measure(); setViewport(initial);
    try { setRect(readAssistantWindow(window.localStorage,initial)); } catch { setRect(defaultAssistantWindow(initial)); }
    setMounted(true);
    const resize = () => { const bounds=measure(); setViewport(bounds); if(bounds.width>=720)setRect(current => clampAssistantWindow(current,bounds)); };
    window.addEventListener('resize',resize); window.addEventListener('orientationchange',resize); visual?.addEventListener('resize',resize); visual?.addEventListener('scroll',resize);
    return () => { window.removeEventListener('resize',resize); window.removeEventListener('orientationchange',resize); visual?.removeEventListener('resize',resize); visual?.removeEventListener('scroll',resize); };
  }, []);
  useLayoutEffect(() => {
    if (mounted && viewport.width >= 720) setRect(current => clampAssistantWindow(current, viewport));
  }, [mounted, viewport.width, viewport.height, viewport.insetTop]);
  useEffect(() => {
    if (!open || !mounted) return;
    const previous = document.activeElement;
    const frame = requestAnimationFrame(() => (root.current?.querySelector<HTMLElement>('[data-assistant-queue-editor]') ?? root.current?.querySelector<HTMLElement>('[data-assistant-composer]') ?? root.current?.querySelector<HTMLElement>('button'))?.focus());
    return () => { cancelAnimationFrame(frame); if (previous instanceof HTMLElement && previous !== document.body && previous.isConnected) previous.focus({ preventScroll: true }); else launcher.current?.focus({ preventScroll: true }); };
  }, [open,mounted]);
  const close = () => { setThreadsOpen(false); a.controller.setPresentation('hidden'); };
  const layer = useTransientLayer({ root, enabled: open && mounted, modal: mobile, history: mobile,
    dismissOnOutside: mobile, retainOnNavigation: !mobile, restoreFocus: false, onClose: close,
    portals: () => [...document.querySelectorAll<HTMLElement>('[data-assistant-overlay]')],
    onEscape: () => { if (!drag.current) return false; setRect(drag.current.rect); drag.current = null; return true; },
  });
  const keyboard = (event: React.KeyboardEvent, resize: boolean) => {
    if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','Escape'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    if (event.key === 'Escape') { if (drag.current) { setRect(drag.current.rect); drag.current=null; } else void layer.close('escape'); return; }
    const dx=event.key==='ArrowRight'?16:event.key==='ArrowLeft'?-16:0,dy=event.key==='ArrowDown'?16:event.key==='ArrowUp'?-16:0;
    setRect(current => { const next=event.key==='Home'?defaultAssistantWindow(viewport):(resize||event.shiftKey?resizeAssistantWindow:moveAssistantWindow)(current,dx,dy,viewport); saveAssistantWindow(next); return next; });
  };
  const pointerDown = (event: React.PointerEvent, resize: boolean) => {
    if (mobile || event.button !== 0) return;
    if (!resize && (event.target as HTMLElement).closest('button')) return;
    event.preventDefault(); drag.current={ x:event.clientX,y:event.clientY,rect,resize,pointer:event.pointerId }; event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const pointerMove = (event: React.PointerEvent) => {
    const active=drag.current; if (!active || active.pointer!==event.pointerId) return;
    const next = (active.resize?resizeAssistantWindow:moveAssistantWindow)(active.rect,event.clientX-active.x,event.clientY-active.y,viewport);
    rectRef.current = next; setRect(next);
  };
  const pointerUp = (event: React.PointerEvent) => { if (!drag.current) return; drag.current=null; event.currentTarget.releasePointerCapture?.(event.pointerId); saveAssistantWindow(rectRef.current); };
  if (!mounted || !snapshot.ownerId) return null;
  return createPortal(<LayerParent.Provider value={open ? layer.id : null}>
    {!open && snapshot.presentation !== 'page' && <button ref={launcher} className="reomi-assistant-launcher" aria-label={t('assistant.open')} title={t('assistant.open')}
      onClick={() => { void a.openPage().catch(() => raiseToast({ kind: 'error', titleKey: 'assistant.contextFailed' })); }}>
      <NNIcon name="chat" size={22}/>{count > 0 && <span>{count}</span>}
    </button>}
    {open && <div ref={root} className="reomi-assistant-window" data-assistant-root data-mobile={mobile || undefined} role="dialog" aria-modal={mobile || undefined} aria-label={t('assistant.title')} tabIndex={-1}
      style={mobile ? { left:0,top:viewport.top,width:'100%',height:viewport.height } : { left:rect.x,top:rect.y,width:rect.width,height:rect.height }}
      onKeyDown={event => {
        if (mobile && event.key==='Tab' && !event.defaultPrevented) {
          const controls=root.current ? assistantFocusControls(root.current) : [];
          const first=controls[0],last=controls.at(-1);
          if (event.shiftKey ? document.activeElement===first : document.activeElement===last) { event.preventDefault(); (event.shiftKey?last:first)?.focus(); }
        }
        if (event.key==='Escape' && !event.defaultPrevented) void layer.close('escape');
        event.stopPropagation();
      }}>
      <header className="reomi-assistant-window-header" onPointerDown={event=>pointerDown(event,false)} onPointerMove={pointerMove} onPointerUp={pointerUp}
        onPointerCancel={()=>{ if(drag.current)setRect(drag.current.rect); drag.current=null; }}>
        {mobile ? <NNBtn variant="ghost" size="sm" icon="chevl" ariaLabel={t('actions.back')} onClick={() => void layer.close()}/> : <span tabIndex={0} role="button" className="reomi-assistant-move" aria-label={t('assistant.moveWindow')} title={t('assistant.moveWindow')} onKeyDown={event=>keyboard(event,false)}>⠿</span>}
        <strong>{t('assistant.title')}</strong><span className="reomi-assistant-window-title">{session?.conversation?.title ?? ''}</span>
        <NNBtn variant="ghost" size="sm" icon="chat" data-assistant-threads-toggle ariaLabel={t('chat.threads.title')} title={t('chat.threads.title')} aria-expanded={threadsOpen} onClick={() => setThreadsOpen(value => !value)}/>
        <NNBtn variant="ghost" size="sm" icon="plus" ariaLabel={t('chat.threads.newThread')} title={t('chat.threads.newThread')} onClick={() => { setThreadsOpen(false); void a.openPage(true).catch(() => raiseToast({ kind: 'error', titleKey: 'assistant.contextFailed' })); }}/>
        <NNBtn variant="ghost" size="sm" icon="expand" ariaLabel={t('assistant.expand')} title={t('assistant.expand')} onClick={()=>{ a.controller.setPresentation('page'); router.push(`/chat${session?.conversationId?`?thread=${session.conversationId}`:''}`); }}/>
        {!mobile && <NNBtn variant="ghost" size="sm" icon="sync" ariaLabel={t('assistant.resetWindow')} title={t('assistant.resetWindow')} onClick={()=>{ const next=defaultAssistantWindow(viewport);setRect(next);saveAssistantWindow(next); }}/ >}
        <NNBtn variant="ghost" size="sm" icon="x" ariaLabel={t('assistant.minimize')} title={t('assistant.minimize')} onClick={() => void layer.close()}/>
      </header>
      <AssistantView hideToolbar threadsOpen={threadsOpen} onThreadsOpenChange={setThreadsOpen}/>
      {!mobile && <div className="reomi-assistant-resize" role="button" tabIndex={0} aria-label={t('assistant.resizeWindow')} title={t('assistant.resizeWindow')}
        onKeyDown={event=>keyboard(event,true)} onPointerDown={event=>pointerDown(event,true)} onPointerMove={pointerMove} onPointerUp={pointerUp}
        onPointerCancel={()=>{if(drag.current)setRect(drag.current.rect);drag.current=null;}} />}
    </div>}
  </LayerParent.Provider>,document.body);
}
