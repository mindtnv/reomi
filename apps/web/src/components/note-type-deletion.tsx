'use client';

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { NoteTypeDeletionPreview } from '@reomi/shared';
import { api, ApiError, ok } from '@/lib/api';
import { useNN } from '@/lib/store';
import { useT } from '@/lib/i18n';
import { LayerParent, useTransientLayer } from '@/lib/use-transient-layer';
import { useModalFocus } from '@/lib/use-modal-focus';
import { downloadProfileExport } from '@/lib/profile-export';
import type { NoteType } from '@/lib/types';
import { NNBtn } from './ui';

export function NoteTypeDeletionDialog({ type, onClose, onPreserve }: {
  type: NoteType; onClose: () => void; onPreserve: () => void;
}) {
  const t = useT();
  const remove = useNN(s => s.deleteNoteType);
  const root = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const owner = useRef(useNN.getState().profile?.userId);
  const current = () => alive.current && useNN.getState().profile?.userId === owner.current;
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const layer = useTransientLayer({ root, modal: true, busy, onClose });
  const [preview, setPreview] = useState<NoteTypeDeletionPreview | null>(null);
  const [error, setError] = useState('');
  const [needsReload, setNeedsReload] = useState(false);
  const [exported, setExported] = useState(false);
  useModalFocus(root);

  const load = async () => {
    if (running.current) return;
    running.current = true; setBusy(true); setError(''); setPreview(null);
    try {
      const result = await ok(await (api as any)['note-types']({ id: type.id })['delete-preview'].get()) as NoteTypeDeletionPreview;
      if (current()) setPreview(result);
    } catch (err) {
      if (current()) {
        setError(t(err instanceof ApiError && err.status === 404 ? 'noteTypes.deletion.unavailable' : 'noteTypes.deletion.loadFailed'));
        setNeedsReload(err instanceof ApiError && err.status === 404);
      }
    } finally { running.current = false; if (current()) setBusy(false); }
  };
  useEffect(() => {
    alive.current = true;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    void load();
    const unsubscribe = useNN.subscribe(state => { if (state.profile?.userId !== owner.current) onClose(); });
    return () => { alive.current = false; document.body.style.overflow = overflow; unsubscribe(); };
  }, []);

  const apply = async () => {
    if (running.current || !preview || !current()) return;
    running.current = true; setBusy(true); setError('');
    try {
      await remove(type.id, preview.confirmationToken);
      if (current()) onClose();
    } catch (err) {
      if (current()) {
        setPreview(null); // Never reuse stale consent after a failed attempt.
        const knownRollback = err instanceof ApiError && ['note_type_operation_busy', 'note_type_operation_timeout'].includes(err.safeMessage);
        const uncertain = !knownRollback && (!(err instanceof ApiError) || err.status >= 500 || err.status === 404);
        setNeedsReload(uncertain);
        setError(t(uncertain ? 'noteTypes.deletion.checkState' : knownRollback ? 'noteTypes.deletion.busy' : 'noteTypes.deletion.changed'));
      }
    } finally { running.current = false; if (current()) setBusy(false); }
  };
  const exportData = async () => {
    if (running.current || !current()) return;
    running.current = true; setBusy(true); setError('');
    try { if (await downloadProfileExport(current)) setExported(true); }
    catch { if (current()) setError(t('settings.data.exportError')); }
    finally { running.current = false; if (current()) setBusy(false); }
  };
  return createPortal(<LayerParent.Provider value={layer.id}><div style={{ position: 'fixed', inset: 0, zIndex: 300, background: 'rgba(0,0,0,.55)', display: 'grid', placeItems: 'center', padding: 12 }}
    onClick={event => { if (event.target === event.currentTarget && !busy) void layer.close('outside'); }}>
    <div ref={root} role="dialog" aria-modal="true" aria-labelledby="type-deletion-title" tabIndex={-1}
      onKeyDown={event => { event.stopPropagation(); if (event.key === 'Escape' && !busy) { event.preventDefault(); void layer.close('escape'); } }}
      style={{ background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 14, padding: 20, width: 'min(620px, 100%)', maxHeight: 'calc(100dvh - 24px)', overflow: 'auto' }}>
      <h2 id="type-deletion-title">{t('noteTypes.deletion.title', { name: preview?.name ?? type.name })}</h2>
      {busy && !preview && <p role="status">{t('states.loading')}</p>}
      {preview && <>
        <p>{t('noteTypes.deletion.counts', { notes: preview.notes, cards: preview.cards, reviews: preview.reviews })}</p>
        <p>{t(preview.notes ? 'noteTypes.deletion.warning' : 'noteTypes.deletion.empty')}</p>
        {preview.notesWithoutCards > 0 && <p>{t('noteTypes.deletion.orphans', { n: preview.notesWithoutCards })}</p>}
        {preview.notes > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBlock: 16 }}>
          <NNBtn variant="soft" disabled={busy || preview.cards === 0} onClick={onPreserve}>{t('noteTypes.deletion.preserve')}</NNBtn>
          <NNBtn variant="soft" disabled={busy} onClick={exportData}>{t('noteTypes.deletion.export')}</NNBtn>
        </div>}
      </>}
      {exported && <p role="status">{t('noteTypes.deletion.exported')}</p>}
      {error && <p role="alert" style={{ color: 'var(--rose-400)' }}>{error}</p>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: 'flex-end' }}>
        <NNBtn variant="ghost" onClick={() => void layer.close()} disabled={busy}>{t('actions.cancel')}</NNBtn>
        {needsReload ? <NNBtn disabled={busy} onClick={() => window.location.reload()}>{t('noteTypes.convert.reload')}</NNBtn>
          : !preview && !busy ? <NNBtn onClick={load}>{t('noteTypes.deletion.refresh')}</NNBtn>
          : <NNBtn variant="danger" disabled={busy || !preview} onClick={apply}>{t('noteTypes.deletion.apply')}</NNBtn>}
      </div>
    </div>
  </div></LayerParent.Provider>, document.body);
}
