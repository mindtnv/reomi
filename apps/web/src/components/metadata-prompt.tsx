'use client';

import { TextInput } from '@/components/design-system/primitives';

import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { UiActionResult } from '@reomi/shared';
import { RecoverableSave } from '@/lib/recoverable-save';
import { saveUiAction, getUiActionReceipt } from '@/lib/ui-actions-api';
import { useNN } from '@/lib/store';
import { useT } from '@/lib/i18n';
import { LayerParent, useTransientLayer } from '@/lib/use-transient-layer';
import { useModalFocus } from '@/lib/use-modal-focus';
import { useNavigationGuard } from './navigation';
import { SaveFeedback } from './save-feedback';
import { NNBtn } from './ui';

export interface MetadataPromptOptions {
  title: string;
  label?: string;
  defaultValue: string;
  path: `/sources/${string}` | `/notebooks/${string}` | `/decks/${string}`;
  revision: number;
  patch: (value: string) => Record<string, unknown>;
  validate?: (value: string) => string | null | undefined;
  multiline?: boolean;
  maxLength?: number;
  trim?: boolean;
  onSaved?: (result: UiActionResult) => void | Promise<void>;
  readCurrent?: () => Promise<{ revision: number; value: string }>;
}

export function MetadataPrompt({ owner, options, resolve, onClose }: { owner: string; options: MetadataPromptOptions;
  resolve: (result: UiActionResult | null) => void; onClose: () => void }) {
  const t = useT(), root = useRef<HTMLDivElement>(null);
  useModalFocus(root);
  const [value, setValue] = useState(options.defaultValue), [version, setVersion] = useState(options.revision);
  const baseline = useRef(options.defaultValue);
  const [controller] = useState(() => new RecoverableSave<{ value: string; revision: number }>(owner));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [error, setError] = useState<string | null>(null), [asking, setAsking] = useState(false);
  const [latest, setLatest] = useState<{ revision: number; value: string } | null>(null);
  const decision = useRef<((allowed: boolean) => void) | null>(null);
  const alive = useRef(true);
  useLayoutEffect(() => controller.edit(value), [controller, value]);
  useEffect(() => { controller.activate(); alive.current = true; return () => { alive.current = false; controller.dispose(); decision.current?.(false); }; }, [controller]);
  const submit = async (explicitRevision?: number) => {
    const text = options.trim === false ? value : value.trim();
    const validation = options.validate?.(text);
    if (validation && snapshot.status !== 'uncertain') { setError(validation); return; }
    setError(null);
    if (explicitRevision !== undefined) controller.resolveConflict();
    const result = await controller.run({ value: text, revision: explicitRevision ?? version }, value,
      request => saveUiAction(owner, options.path, 'PATCH', { expectedRevision: request.payload.revision, patch: options.patch(request.payload.value) }, request.requestId),
      requestId => getUiActionReceipt(owner, requestId));
    if (!result || !alive.current || useNN.getState().profile?.userId !== owner) return;
    if (result.response.outcome !== 'applied') return;
    setVersion(Number(result.response.receipt.target.revision)); baseline.current = result.submitted.fingerprint;
    if (result.response.replayed) {
      window.dispatchEvent(new CustomEvent('nn:ui-action', { detail: { owner, receipt: result.response.receipt } }));
      window.dispatchEvent(new Event('nn:knowledge-changed'));
    }
    // A list refresh is independent of the already-confirmed mutation.
    void Promise.resolve(options.onSaved?.(result.response)).catch(() => {});
    if (result.currentMatches) { decision.current?.(true); decision.current = null; resolve(result.response); onClose(); }
  };
  const allowClose = async () => {
    if (snapshot.status === 'saving') return false;
    if (value === baseline.current && !snapshot.pending) return true;
    if (decision.current) return false;
    setAsking(true);
    return new Promise<boolean>(res => { decision.current = res; });
  };
  const layer = useTransientLayer({ root, modal: true, busy: snapshot.status === 'saving', onClose: () => { resolve(null); onClose(); } });
  useNavigationGuard(allowClose, layer.id);
  const close = () => layer.close();
  const choose = (allowed: boolean) => { setAsking(false); decision.current?.(allowed); decision.current = null; };
  const decisionRoot = useRef<HTMLDivElement>(null);
  const decisionLayer = useTransientLayer({ root: decisionRoot, parent: layer.id, enabled: asking, modal: true, busy: snapshot.status === 'saving', onClose: () => choose(false) });
  useLayoutEffect(() => { if (asking) decisionRoot.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true }); }, [asking]);
  return <LayerParent.Provider value={layer.id}><div className="reomi-overlay-backdrop">
    <div ref={root} className="reomi-flow-dialog" role="dialog" aria-modal="true" aria-label={options.title} tabIndex={-1}
>
      <header><h2>{options.title}</h2><NNBtn variant="ghost" icon="x" ariaLabel={t('actions.close')} disabled={snapshot.status === 'saving'} onClick={() => void close()} /></header>
      <form inert={asking} onSubmit={event => { event.preventDefault(); void submit(); }}>
        <label>{options.label ?? options.title}
          {options.multiline ? <textarea className="reomi-input" aria-label={options.label ?? options.title} value={value} maxLength={options.maxLength} rows={6} onChange={event => setValue(event.target.value)} />
            : <TextInput className="reomi-input" aria-label={options.label ?? options.title} value={value} maxLength={options.maxLength} onChange={event => setValue(event.target.value)} />}
        </label>
        {error && <p role="alert">{error}</p>}
        <SaveFeedback status={snapshot.status} errorCode={snapshot.error} onRetry={() => void submit()} />
        {snapshot.status === 'conflict' && <div>
          {options.readCurrent ? <NNBtn variant="ghost" size="sm" onClick={() => {
            void options.readCurrent!().then(current => { if (alive.current) setLatest(current); }).catch(() => setError(t('actionsRecovery.failed')));
          }}>{t('actionsRecovery.current')}</NNBtn> : <p>{t('actionsRecovery.reopenConflict')}</p>}
          {latest && <><p>{t('actionsRecovery.currentVersion')}: {latest.value}</p><NNBtn onClick={() => void submit(latest.revision)}>{t('actionsRecovery.keepMine')}</NNBtn></>}
        </div>}
        <footer><NNBtn variant="ghost" disabled={snapshot.status === 'saving'} onClick={() => void close()}>{t('actions.cancel')}</NNBtn>
          <NNBtn type="submit" variant="primary" disabled={snapshot.status === 'saving' || snapshot.status === 'conflict'}>{t('actions.save')}</NNBtn></footer>
      </form>
      {asking && <div ref={decisionRoot} className="nn-close-decision" role="alertdialog" aria-modal="true" aria-label={t('editor.draft.leaveTitle')}>
        <p>{t('editor.draft.leaveBody')}</p>
        {snapshot.pending && <p>{t('actionsRecovery.uncertainClose')}</p>}
        <NNBtn onClick={() => void submit()} disabled={snapshot.status === 'saving' || snapshot.status === 'conflict'}>{t('editor.draft.saveAndLeave')}</NNBtn>
        <NNBtn variant="ghost" disabled={snapshot.status === 'saving'} onClick={() => choose(true)}>{t('editor.draft.discardAndLeave')}</NNBtn>
        <NNBtn variant="ghost" onClick={() => void decisionLayer.close()}>{t('editor.draft.stay')}</NNBtn>
      </div>}
    </div>
  </div></LayerParent.Provider>;
}
