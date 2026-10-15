'use client';

/* eslint-disable react/forbid-elements -- TODO: replace raw input, select, and button with TextInput, Button, or NNSelect. */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { newUuidV7, OPERATION_GROUPS, type OperationItem, type OperationRetryInput } from '@reomi/shared';
import { useNN } from '@/lib/store';
import { useT } from '@/lib/i18n';
import { resolveOperationHref, OperationRequestError, requestOperationRetry } from '@/lib/operations-api';
import { RecentActions } from './recent-actions';
import { useOperations } from './operations-provider';
import { useAppNavigation } from './navigation';
import { Modal } from './design-system/modal';
import { NNBtn, NNIcon } from './ui';

export function OperationsButton({ mobile = false }: { mobile?: boolean }) {
  const context = useOperations();
  const t = useT();
  if (!context) return null;
  const count = context.snapshot.feed?.active.total ?? 0;
  return <button type="button" className={mobile ? 'nn-operations-mobile-button' : 'nn-sidebar-nav-item nn-operations-button'}
    aria-label={count ? t('operations.count', { count }) : t('operations.title')}
    title={t('operations.title')} aria-haspopup="dialog" aria-expanded={context.open} onClick={event => { event.currentTarget.focus({ preventScroll: true }); context.setOpen(true); }}>
    <span className="nn-sidebar-nav-icon"><NNIcon name="clock" size={mobile ? 22 : 18} /></span><span className="nn-sidebar-label">{t('operations.title')}</span>
    {count > 0 && <><span className="nn-sidebar-badge nn-operations-count" aria-hidden="true">{count}</span><span className="nn-sidebar-badge-dot" aria-hidden="true" /></>}
  </button>;
}

function OperationRow({ row, missing = false }: { row: OperationItem; missing?: boolean }) {
  const context = useOperations()!;
  const t = useT(), navigation = useAppNavigation();
  const live = useRef({ row, missing, panelOpen: context.open }); live.current = { row, missing, panelOpen: context.open };
  const [confirmDefaults, setConfirmDefaults] = useState(false);
  const [opening, setOpening] = useState(false), [openFailure, setOpenFailure] = useState<'failed' | 'unavailable' | null>(null);
  const openLock = useRef(false), openController = useRef<AbortController | null>(null);
  const [state, setState] = useState<'idle' | 'pending' | 'failed' | 'uncertain'>('idle');
  const [retryAt, setRetryAt] = useState(0), [now, setNow] = useState(Date.now);
  const [requestError, setRequestError] = useState<string | null>(null);
  const request = useRef<OperationRetryInput | null>(null);
  const pending = useRef(false), alive = useRef(true), generation = useRef(0);
  const root = useRef<HTMLLIElement>(null), focused = useRef(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true; generation.current++; pending.current = false; request.current = null;
    setState('idle'); setRetryAt(0); setRequestError(null); setConfirmDefaults(false); setOpening(false); setOpenFailure(null); openLock.current = false;
    return () => { alive.current = false; generation.current++; controller.current?.abort(); openController.current?.abort(); };
  }, [row.runId]);
  useLayoutEffect(() => {
    if (focused.current && document.activeElement === document.body) root.current?.focus({ preventScroll: true });
  }, [row.runId, row.phase, row.canRead, row.retry.allowed, openFailure, missing]);
  useEffect(() => {
    if (retryAt <= Date.now()) return;
    const timer = setInterval(() => { const current = Date.now(); setNow(current); if (current >= retryAt) clearInterval(timer); }, 500);
    return () => clearInterval(timer);
  }, [retryAt]);
  const retry = async (acceptDefaults = false) => {
    if (pending.current || retryAt > Date.now()) return;
    pending.current = true;
    const turn = generation.current;
    const current = () => alive.current && generation.current === turn && useNN.getState().profile?.userId === context.owner;
    try {
      if (!request.current) {
        if (row.retry.needsDefaults && !acceptDefaults) { setConfirmDefaults(true); return; }
        if (!current()) return;
        request.current = { kind: row.kind, id: row.id, runId: row.runId, requestId: newUuidV7(), acceptDefaults: row.retry.needsDefaults };
      }
      setConfirmDefaults(false); setState('pending'); setRequestError(null);
      controller.current = new AbortController();
      await requestOperationRetry(request.current, controller.current.signal);
      if (!current()) return;
      setState('idle'); request.current = null;
      await context.observer.refresh();
    } catch (error) {
      if (!current()) return;
      const known = error instanceof OperationRequestError && error.status >= 400 && error.status < 500;
      setState(known ? 'failed' : 'uncertain');
      if (error instanceof OperationRequestError && error.status === 429) setRetryAt(Date.now() + error.retryAfterMs);
      if (error instanceof OperationRequestError && error.status >= 500 && error.requestId) setRequestError(error.message);
      if (known) await context.observer.refresh();
    } finally { if (generation.current === turn) pending.current = false; }
  };
  const open = async () => {
    if (openLock.current) return;
    openLock.current = true; setOpening(true); setOpenFailure(null);
    const turn = generation.current;
    openController.current = new AbortController();
    try {
      const href = await resolveOperationHref(row.destination, openController.current.signal);
      if (alive.current && turn === generation.current && useNN.getState().profile?.userId === context.owner && live.current.panelOpen && !live.current.missing && live.current.row.runId === row.runId) navigation.push(href);
    } catch (error) {
      if (alive.current && turn === generation.current && useNN.getState().profile?.userId === context.owner) {
        setOpenFailure(error instanceof OperationRequestError && error.status === 404 ? 'unavailable' : 'failed');
        void context.observer.refresh();
      }
    } finally { if (turn === generation.current) { openLock.current = false; if (alive.current) setOpening(false); } }
  };
  const unavailable = missing || openFailure === 'unavailable';
  const canOpen = row.kind === 'source' ? row.canRead : row.phase === 'ready';
  const fallback = row.destination.kind === 'notebook-artifact' ? '/notebooks' : row.kind === 'source' ? '/library' : '/library/study';
  const fallbackLabel = row.destination.kind === 'notebook-artifact' ? 'nav.notebooks' : row.kind === 'source' ? 'nav.library' : 'assistant.savedStudy';
  const phase = row.phase === 'ready' && row.artifactType === 'quiz' ? t('operations.quizReady') : t(`operations.phases.${row.phase}`);
  const tone = unavailable ? 'muted' : row.phase === 'failed' || row.phase === 'search_unavailable' ? 'attention' : row.phase === 'ready' ? 'ready' : 'active';
  return <li ref={root} tabIndex={-1} className="nn-operation-row" data-tone={tone} data-operation-id={row.id}
    onFocus={() => { focused.current = true; }} onBlur={event => { if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget as Node)) focused.current = false; }}>
    <span className="nn-operation-icon" aria-hidden="true"><NNIcon name={unavailable ? row.kind === 'source' ? 'book' : 'doc' : tone === 'attention' ? 'warning' : row.phase === 'ready' ? 'check' : row.kind === 'artifact' ? 'sparkle' : 'book'} size={17} /></span>
    <div className="nn-operation-copy"><strong title={row.title}>{row.title}</strong>{!unavailable && <><span>{phase}</span>
      {row.canRead && ['parsing', 'queued', 'failed'].includes(row.phase) && <span>{t('operations.readable')}</span>}
      {row.progress && <progress max={row.progress.total} value={row.progress.completed}
        aria-label={t('operations.progress', { completed: row.progress.completed, total: row.progress.total })} />}
      {row.phase === 'failed' && !row.retry.allowed && <small>{t(row.retry.reason === 'ai_unavailable' ? 'operations.aiUnavailable' : 'operations.sourceUnavailable')}</small>}</>}
      {(missing || openFailure) && <span role="alert">{t(missing || openFailure === 'unavailable' ? 'operations.resultUnavailable' : 'operations.openFailed')}</span>}
      {state === 'failed' && <span role="alert">{t('operations.retryFailed')}</span>}
      {state === 'uncertain' && <span role="status">{t('operations.uncertain')}</span>}
      {requestError && <small>{requestError}</small>}
      {confirmDefaults && <div role="group" aria-label={t('operations.defaults')}><p>{t('operations.defaults')}</p>
        <NNBtn size="sm" onClick={() => void retry(true)}>{t('operations.retry')}</NNBtn>
        <NNBtn size="sm" variant="ghost" onClick={() => setConfirmDefaults(false)}>{t('actions.cancel')}</NNBtn></div>}
      {retryAt > now && <small>{t('operations.cooldown', { seconds: Math.ceil((retryAt - now) / 1000) })}</small>}
    </div>
    <div className="nn-operation-actions">
      {canOpen && !missing && openFailure !== 'unavailable' && <NNBtn size="sm" variant="soft" disabled={opening} onClick={event => { event.currentTarget.focus({ preventScroll: true }); void open(); }}>{t(opening ? 'operations.opening' : row.kind === 'source' ? 'operations.read' : 'operations.open')}</NNBtn>}
      {(missing || openFailure === 'unavailable') && <NNBtn size="sm" variant="soft" onClick={() => navigation.push(fallback)}>{t(fallbackLabel)}</NNBtn>}
      {!missing && row.retry.allowed && <NNBtn size="sm" variant="ghost" disabled={state === 'pending' || retryAt > now} onClick={() => void retry()}>
        {t(state === 'pending' ? 'operations.retrying' : 'operations.retry')}
      </NNBtn>}
    </div>
  </li>;
}

export function OperationsHost() {
  const context = useOperations();
  const t = useT();
  // Freeze group/order while a row has focus; update row data in-place. New rows
  // arrive after blur, so a completion cannot move a keyboard user's control.
  const [focused, setFocused] = useState(false);
  const stable = useRef<Map<string, { group: typeof OPERATION_GROUPS[number]; row: OperationItem; missing?: boolean }>>(new Map());
  if (!context) return null;
  const { snapshot, observer, open, setOpen } = context;
  const incoming = new Map<string, { group: typeof OPERATION_GROUPS[number]; row: OperationItem }>(OPERATION_GROUPS.flatMap(group => snapshot.feed?.[group].items.map(row => [`${row.kind}:${row.id}`, { group, row }] as const) ?? []));
  if (!focused) stable.current = incoming;
  else for (const [key, value] of stable.current) { const next = incoming.get(key); stable.current.set(key, next ? { group: value.group, row: next.row } : { ...value, missing: true }); }
  return <Modal open={open} title={t('operations.title')} description={t('operations.description')} closeLabel={t('actions.close')} closeIcon={<NNIcon name="x" size={18} />} initialFocus="panel" onClose={() => setOpen(false)} className="nn-operations-panel">
    <div className="nn-operations-content" onFocus={event => setFocused(Boolean((event.target as Element).closest('[data-operation-id]')))} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setFocused(false); }}>
      {snapshot.status === 'loading' && <p role="status">{t('operations.loading')}</p>}
      {(snapshot.status === 'stale' || snapshot.status === 'unavailable') && <div className="nn-operation-notice" role="status">
        <p>{t(`operations.${snapshot.status}`)}</p><NNBtn size="sm" onClick={() => void observer.refresh()}>{t('operations.refresh')}</NNBtn>
      </div>}
      {snapshot.feed && OPERATION_GROUPS.map(group => {
        const items = [...stable.current.values()].filter(value => value.group === group);
        const page = snapshot.feed![group];
        if (!items.length && (!page.total || focused)) return null;
        return <section key={group} className="nn-operation-group" data-group={group} aria-label={t(`operations.${group}`)}>
          <h3>{t(`operations.${group}`)} {!focused && <span>{page.total}</span>}</h3>
          <ul>{items.map(({ row, missing }) => <OperationRow key={`${row.kind}:${row.id}`} row={row} missing={missing} />)}</ul>
          {page.nextCursor && <NNBtn size="sm" variant="ghost" disabled={snapshot.loadingMore !== null} onClick={() => void observer.loadMore(group)}>{t('operations.more')}</NNBtn>}
        </section>;
      })}
      {snapshot.feed && stable.current.size === 0 && OPERATION_GROUPS.every(group => !snapshot.feed![group].total) && <div className="nn-operations-empty"><span className="nn-operation-icon" aria-hidden="true"><NNIcon name="check" size={20} /></span><p>{t('operations.empty')}</p></div>}
      <RecentActions />
    </div>
    <footer className="nn-operations-history"><NNIcon name="clock" size={13} /><span>{t('operations.history')}</span></footer>
  </Modal>;
}
