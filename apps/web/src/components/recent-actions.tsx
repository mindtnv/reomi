'use client';

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { UiActionReceipt } from '@reomi/shared';
import { fetchUiActionOffers, getUiActionReceipt, undoUiActionRequest } from '@/lib/ui-actions-api';
import { useNN } from '@/lib/store';
import { useT } from '@/lib/i18n';
import { useOperations } from './operations-provider';
import { raiseToast } from './toasts';
import { NNBtn, NNIcon } from './ui';
import { Modal } from './design-system/modal';

type UndoState = 'pending' | 'failed' | 'uncertain' | 'conflict';
interface ActionsValue {
  rows: UiActionReceipt[];
  statuses: Record<string, UndoState>;
  error: boolean;
  loaded: boolean;
  storageUnavailable: boolean;
  hasMore: boolean;
  now: number;
  refresh: () => Promise<void>;
  more: () => void;
  undo: (receipt: UiActionReceipt) => Promise<void>;
}
const ActionsContext = createContext<ActionsValue | null>(null);

function OwnerActions({ owner, children }: { owner: string; children: React.ReactNode }) {
  const t = useT();
  const [rows, setRows] = useState<UiActionReceipt[]>([]), [statuses, setStatuses] = useState<Record<string, UndoState>>({});
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false), [storageUnavailable, setStorageUnavailable] = useState(false), [hasMore, setHasMore] = useState(false);
  const [now, setNow] = useState(Date.now);
  const alive = useRef(true), inFlight = useRef<Promise<void> | null>(null), pages = useRef(1), offset = useRef(0);
  const pending = useRef(new Set<string>()), received = useRef(new Set<string>());
  const known = useRef(rows), local = useRef(statuses); known.current = rows; local.current = statuses;
  const owned = () => alive.current && useNN.getState().profile?.userId === owner;
  const completed = (receipt: UiActionReceipt) => {
    if (!owned()) return;
    setRows(previous => previous.filter(row => row.id !== receipt.id));
    setStatuses(previous => { const next = { ...previous }; delete next[receipt.id]; return next; });
    raiseToast({ id: `undo:${receipt.id}`, kind: 'success', title: t('actionsRecovery.undone') });
    window.dispatchEvent(new Event('nn:knowledge-changed'));
  };
  const refresh = useCallback((): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    inFlight.current = (async () => {
      try {
        const next: UiActionReceipt[] = []; let cursor: string | undefined;
        for (let page = 0; page < pages.current; page++) {
          const result = await fetchUiActionOffers(owner, cursor);
          if (!owned()) return;
          offset.current = Date.parse(result.serverTime) - Date.now(); next.push(...result.items); cursor = result.nextCursor ?? undefined;
          if (!cursor) break;
        }
        // Read-only reconciliation is safe after a lost undo response, even if
        // the consumed offer no longer appears in the list. Never replay here.
        for (const row of known.current.filter(row => local.current[row.id] === 'uncertain')) {
          try {
            const result = await getUiActionReceipt(owner, row.requestId);
            if (!owned()) return;
            if (result.receipt.consumedAt) { completed(result.receipt); continue; }
          } catch { /* Keep the uncertain row usable for explicit retry. */ }
          if (!next.some(item => item.id === row.id)) next.push(row);
        }
        if (!owned()) return;
        const visible = new Set(next.map(row => row.id));
        received.current = new Set([...received.current].filter(id => visible.has(id)));
        setRows([...new Map(next.map(row => [row.id, row])).values()]); setHasMore(Boolean(cursor)); setError(false); setLoaded(true);
        setNow(Date.now() + offset.current);
      } catch { if (owned()) setError(true); }
      finally { inFlight.current = null; }
    })();
    return inFlight.current;
  }, [owner]);
  const undo = useCallback(async (receipt: UiActionReceipt) => {
    if (!owned() || pending.current.has(receipt.id)) return;
    pending.current.add(receipt.id); setStatuses(previous => ({ ...previous, [receipt.id]: 'pending' }));
    try {
      const result = await undoUiActionRequest(owner, receipt.id);
      if (result.receipt.consumedAt) completed(result.receipt);
      await refresh();
    } catch (reason) {
      if (!owned()) return;
      const status = (reason as { status?: number }).status ?? 0;
      setStatuses(previous => ({ ...previous, [receipt.id]: status === 404 || status === 409 ? 'conflict' : status >= 400 && status < 500 ? 'failed' : 'uncertain' }));
    } finally { pending.current.delete(receipt.id); }
  }, [owner, refresh]);
  useEffect(() => {
    alive.current = true;
    const load = () => { if (document.visibilityState !== 'hidden') void refresh(); };
    const accepted = (event: Event) => {
      const detail = (event as CustomEvent<{ owner: string; receipt: UiActionReceipt }>).detail;
      if (!owned() || detail?.owner !== owner || !detail.receipt?.undoUntil || Date.parse(detail.receipt.undoUntil) <= Date.now() + offset.current || received.current.has(detail.receipt.id)) return;
      received.current.add(detail.receipt.id);
      setRows(previous => [detail.receipt, ...previous.filter(row => row.id !== detail.receipt.id)]);
      raiseToast({ id: `action:${detail.receipt.id}`, kind: 'success', title: t(`actionsRecovery.kinds.${detail.receipt.kind}`),
        description: detail.receipt.label, action: { label: t('actionsRecovery.undo'), onClick: () => void undo(detail.receipt) } });
      load();
    };
    const storage = (event: Event) => { if ((event as CustomEvent).detail?.owner === owner) setStorageUnavailable(true); };
    window.addEventListener('nn:ui-action', accepted); window.addEventListener('nn:ui-action-storage-unavailable', storage);
    window.addEventListener('focus', load); document.addEventListener('visibilitychange', load);
    const timer = setInterval(load, 30000), clock = setInterval(() => { if (owned()) setNow(Date.now() + offset.current); }, 1000);
    load();
    return () => { alive.current = false; clearInterval(timer); clearInterval(clock);
      window.removeEventListener('nn:ui-action', accepted); window.removeEventListener('nn:ui-action-storage-unavailable', storage);
      window.removeEventListener('focus', load); document.removeEventListener('visibilitychange', load); };
  }, [owner, refresh, undo, t]);
  const value = useMemo(() => ({ rows, statuses, error, loaded, storageUnavailable, hasMore, now, refresh, undo,
    more: () => { pages.current++; void refresh(); } }), [rows, statuses, error, loaded, storageUnavailable, hasMore, now, refresh, undo]);
  return <ActionsContext.Provider value={value}>{children}</ActionsContext.Provider>;
}
export function RecentActionsProvider({ children }: { children: React.ReactNode }) {
  const owner = useNN(state => state.profile?.userId);
  return owner ? <OwnerActions key={owner} owner={owner}>{children}</OwnerActions> : children;
}
export function RecentActions() {
  const context = useContext(ActionsContext), t = useT();
  if (!context) return null;
  return <section className="nn-recent-actions" aria-label={t('actionsRecovery.recent')}>
    <h3>{t('actionsRecovery.recent')}</h3>
    {context.storageUnavailable && <p role="status">{t('actionsRecovery.reloadUnavailable')}</p>}
    {context.error && <p role="status">{t('operations.stale')} <NNBtn size="sm" onClick={() => void context.refresh()}>{t('operations.refresh')}</NNBtn></p>}
    {!context.loaded && !context.error && !context.rows.length && <p role="status">{t('operations.loading')}</p>}
    {context.loaded && !context.error && !context.rows.length && <p className="nn-recent-actions-empty">{t('actionsRecovery.noActions')}</p>}
    <ul>{context.rows.map(receipt => {
      const state = context.statuses[receipt.id], expired = !receipt.undoUntil || Date.parse(receipt.undoUntil) <= context.now;
      return <li className="nn-operation-row" data-tone="muted" key={receipt.id}>
        <span className="nn-operation-icon" aria-hidden="true"><NNIcon name={receipt.kind === 'study-note-pin' ? 'pin' : 'edit'} size={16} /></span>
        <div className="nn-operation-copy"><strong>{receipt.label}</strong><span>{t(`actionsRecovery.kinds.${receipt.kind}`)}</span>
          <small>{expired ? t('actionsRecovery.expired') : t('actionsRecovery.expires', { minutes: Math.max(1, Math.ceil((Date.parse(receipt.undoUntil!) - context.now) / 60000)) })}</small>
          {state && state !== 'pending' && <span role="status">{t(state === 'conflict' ? 'actionsRecovery.undoConflict' : state === 'uncertain' ? 'actionsRecovery.uncertain' : 'actionsRecovery.undoFailed')}</span>}
        </div>
        <NNBtn size="sm" variant="ghost" disabled={state === 'pending' || state === 'conflict' || expired && state !== 'uncertain'} onClick={() => void context.undo(receipt)}>
          {t(state === 'pending' ? 'actionsRecovery.undoing' : 'actionsRecovery.undo')}
        </NNBtn>
      </li>;
    })}</ul>
    {context.hasMore && <NNBtn size="sm" variant="ghost" onClick={context.more}>{t('operations.more')}</NNBtn>}
  </section>;
}
/** Keeps the action capability usable when mounted without the operations feature. */
export function StandaloneActions() {
  const operations = useOperations(), context = useContext(ActionsContext), t = useT();
  const [open, setOpen] = useState(false);
  if (operations || !context) return null;
  return <><NNBtn size="sm" onClick={() => setOpen(true)}>{t('actionsRecovery.recent')}</NNBtn>
    <Modal open={open} title={t('actionsRecovery.recent')} closeLabel={t('actions.close')} onClose={() => setOpen(false)}><RecentActions /></Modal></>;
}
