'use client';

/* eslint-disable react/forbid-elements -- TODO: replace raw input, select, and button with TextInput, Button, or NNSelect. */
import { useEffect, useRef, useState } from 'react';
import { useNN } from '@/lib/store';
import { useT } from '@/lib/i18n';
import { NNBtn } from './ui';

/** A destination can be created without unmounting the card/harvest draft. */
export function InlineDeckCreate({ onCreated, disabled = false }: { onCreated(id: string): void; disabled?: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false), [name, setName] = useState('');
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const pending = useRef(false), mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const create = async () => {
    if (pending.current || disabled || !name.trim()) return;
    pending.current = true; setBusy(true); setFailed(false);
    const owner = useNN.getState().profile?.userId;
    try {
      const deck = await useNN.getState().addDeck({ name: name.trim(), color: 'lime', species: 'fern' });
      if (!mounted.current || useNN.getState().profile?.userId !== owner) return;
      onCreated(deck.id); setOpen(false); setName('');
    } catch { if (mounted.current && useNN.getState().profile?.userId === owner) setFailed(true); }
    finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  if (!open) return <NNBtn type="button" size="sm" variant="ghost" icon="plus" disabled={disabled}
    onClick={() => { setOpen(true); setFailed(false); }}>{t('assistant.newDestinationDeck')}</NNBtn>;
  return <div className="reomi-inline-deck-create" onKeyDown={event => {
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void create(); }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) setOpen(false); }
  }}>
    <input autoFocus className="reomi-input" aria-label={t('decks.name')} maxLength={100} value={name}
      disabled={busy || disabled} onChange={event => setName(event.target.value)} placeholder={t('decks.namePlaceholder')} />
    <div style={{ display: 'flex', gap: 6 }}>
      <NNBtn type="button" size="sm" variant="primary" loading={busy} disabled={busy || disabled || !name.trim()} onClick={() => void create()}>{t('actions.create')}</NNBtn>
      <NNBtn type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>{t('actions.cancel')}</NNBtn>
    </div>
    {failed && <p role="alert">{t('assistant.createDeckFailed')}</p>}
  </div>;
}
