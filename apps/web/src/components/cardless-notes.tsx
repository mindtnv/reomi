'use client';


import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '@/lib/api';
import { deckPathLabel } from '@/lib/decks';
import { useT } from '@/lib/i18n';
import { useNN, type CardlessNote } from '@/lib/store';
import type { Deck } from '@/lib/types';
import { LayerParent, useTransientLayer } from '@/lib/use-transient-layer';
import { useModalFocus } from '@/lib/use-modal-focus';
import { NNSelect } from '@/components/nn-select';
import { raiseToast } from './toasts';
import { NNBtn, NNTag } from './ui';

const selectStyle: React.CSSProperties = {
  width: '100%',
  padding: 10,
  background: 'var(--surface)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 10,
};

function noteText(note: CardlessNote): string {
  return Object.entries(note.fieldValues)
    .filter(([, value]) => value.trim())
    .map(([name, value]) => `${name}\n${value}`)
    .join('\n\n');
}

function restoreErrorKey(error: unknown): string {
  const code = error instanceof ApiError ? error.safeMessage : '';
  if (code === 'note_has_cards') return 'cards.cardless.noteHasCards';
  if (code === 'deck_not_found') return 'cards.cardless.deckMissing';
  if (code === 'not_found') return 'cards.cardless.missing';
  if (code === 'no_cards_generated') return 'cards.cardless.noCards';
  return 'cards.cardless.restoreFailed';
}

export function CardlessNotes({ onChanged }: { onChanged?: () => void }) {
  const t = useT();
  const owner = useNN((state) => state.profile?.userId);
  const bootstrapped = useNN((state) => state.bootstrapped);
  const cardCount = useNN((state) => state.cards.length);
  const decks = useNN((state) => state.decks);
  const listCardlessNotes = useNN((state) => state.listCardlessNotes);
  const restoreCardlessNote = useNN((state) => state.restoreCardlessNote);
  const deleteNote = useNN((state) => state.deleteNote);
  const [items, setItems] = useState<CardlessNote[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [open, setOpen] = useState(false);
  const [deckByNote, setDeckByNote] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<Record<string, string>>({});
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const request = useRef(0);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    const generation = ++request.current;
    try {
      const res = await listCardlessNotes();
      if (!alive.current || generation !== request.current) return;
      setItems(res.items);
      setLoadError(false);
    } catch {
      if (!alive.current || generation !== request.current) return;
      setLoadError(true);
    }
  }, [listCardlessNotes]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (!bootstrapped || !owner) {
      setItems(null);
      setLoadError(false);
      setOpen(false);
      return;
    }
    void refresh();
  }, [bootstrapped, owner, cardCount, refresh]);

  useEffect(() => {
    if (!bootstrapped || !owner) return;
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [bootstrapped, owner, refresh]);

  useEffect(() => {
    if (items && items.length === 0) setOpen(false);
  }, [items]);

  const drop = (id: string) => {
    setItems((current) => current?.filter((note) => note.id !== id) ?? current);
    setRowError((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
  };

  const restore = async (note: CardlessNote) => {
    const deckId = deckByNote[note.id] ?? decks[0]?.id;
    if (!deckId || busyId) return;
    setBusyId(note.id);
    setRowError((current) => ({ ...current, [note.id]: '' }));
    try {
      await restoreCardlessNote(note.id, deckId);
      if (!alive.current) return;
      drop(note.id);
      raiseToast({ kind: 'success', title: t('cards.cardless.restored') });
      onChanged?.();
    } catch (error) {
      if (!alive.current) return;
      const code = error instanceof ApiError ? error.safeMessage : '';
      if (code === 'note_has_cards' || code === 'not_found') drop(note.id);
      setRowError((current) => ({ ...current, [note.id]: t(restoreErrorKey(error)) }));
    } finally {
      if (alive.current) setBusyId(null);
    }
  };

  const remove = async (note: CardlessNote) => {
    if (busyId) return;
    setBusyId(note.id);
    setRowError((current) => ({ ...current, [note.id]: '' }));
    try {
      await deleteNote(note.id);
      if (!alive.current) return;
      drop(note.id);
      raiseToast({ kind: 'success', title: t('cards.cardless.deleted') });
    } catch (error) {
      if (!alive.current) return;
      if (error instanceof ApiError && error.safeMessage === 'not_found') drop(note.id);
      setRowError((current) => ({ ...current, [note.id]: t('cards.cardless.deleteFailed') }));
    } finally {
      if (alive.current) setBusyId(null);
    }
  };

  const count = items?.length ?? 0;
  if (!bootstrapped || (!loadError && count === 0)) return null;

  return (
    <>
      <NNBtn
        size="sm"
        variant={loadError ? 'danger' : 'soft'}
        icon="note"
        ariaLabel={t('cards.cardless.open')}
        title={t('cards.cardless.open')}
        onClick={() => { setOpen(true); void refresh(); }}
      >
        {loadError ? t('cards.cardless.failed') : t('cards.cardless.open')}
        {!loadError && <span aria-hidden="true"> {count}</span>}
      </NNBtn>
      {open && <CardlessNotesDialog
        items={items}
        loadError={loadError}
        busyId={busyId}
        decks={decks}
        deckByNote={deckByNote}
        rowError={rowError}
        onDeck={(id, deckId) => setDeckByNote((current) => ({ ...current, [id]: deckId }))}
        onRestore={(note) => void restore(note)}
        pendingDelete={pendingDelete}
        onAskDelete={(id) => setPendingDelete(id)}
        onCancelDelete={() => setPendingDelete(null)}
        onDelete={(note) => void remove(note)}
        onRetry={() => void refresh()}
        onClose={() => setOpen(false)}
      />}
    </>
  );
}

function CardlessNotesDialog({ items, loadError, busyId, decks, deckByNote, rowError, pendingDelete, onDeck, onRestore, onAskDelete, onCancelDelete, onDelete, onRetry, onClose }: {
  items: CardlessNote[] | null;
  loadError: boolean;
  busyId: string | null;
  decks: Deck[];
  deckByNote: Record<string, string>;
  rowError: Record<string, string>;
  pendingDelete: string | null;
  onDeck: (id: string, deckId: string) => void;
  onRestore: (note: CardlessNote) => void;
  onAskDelete: (id: string) => void;
  onCancelDelete: () => void;
  onDelete: (note: CardlessNote) => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const root = useRef<HTMLDivElement>(null);
  useModalFocus(root);
  const layer = useTransientLayer({ root, modal: true, busy: Boolean(busyId), onClose });
  const orderedDecks = [...decks].sort((a, b) => deckPathLabel(decks, a.id).localeCompare(deckPathLabel(decks, b.id)));

  return createPortal(
    <LayerParent.Provider value={layer.id}>
      <div
        onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget && !busyId) void layer.close('outside'); }}
        className="reomi-overlay-backdrop reomi-conversion-backdrop"
      >
        <div
          ref={root}
          role="dialog"
          aria-modal="true"
          aria-labelledby="cardless-notes-title"
          tabIndex={-1}
          onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape' && !busyId) { event.preventDefault(); void layer.close('escape'); } }}
          className="reomi-flow-dialog reomi-conversion-dialog"
        >
          <header>
            <div>
              <h2 id="cardless-notes-title">{t('cards.cardless.title')}</h2>
            </div>
            <NNBtn onClick={() => void layer.close()} disabled={Boolean(busyId)} variant="ghost" icon="x" ariaLabel={t('actions.close')} />
          </header>
          <p className="reomi-flow-intro">{t('cards.cardless.intro')}</p>
          {items === null && !loadError && <p role="status">{t('cards.cardless.loading')}</p>}
          {loadError && (
            <p role="alert">
              {t('cards.cardless.failed')}{' '}
              <NNBtn size="sm" variant="ghost" onClick={onRetry}>{t('cards.cardless.retry')}</NNBtn>
            </p>
          )}
          <div style={{ display: 'grid', gap: 16 }}>
            {items?.map((note) => {
              const text = noteText(note);
              const deckId = deckByNote[note.id] ?? orderedDecks[0]?.id ?? '';
              return (
                <article key={note.id} style={{ display: 'grid', gap: 8, padding: 12, border: '1px solid var(--border)', borderRadius: 12 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong>{note.noteTypeName}</strong>
                    {note.tags.map((tag) => <NNTag key={tag}>{tag}</NNTag>)}
                  </div>
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap', maxHeight: '9rem', overflow: 'auto', font: 'inherit', color: 'var(--text)' }}>
                    {text || t('cards.cardless.emptyText')}
                  </pre>
                  <label>
                    {t('cards.cardless.chooseDeck')}
                    <NNSelect
                      ariaLabel={t('cards.cardless.chooseDeck')}
                      style={selectStyle}
                      value={deckId}
                      disabled={!orderedDecks.length || busyId === note.id}
                      onChange={(value) => onDeck(note.id, value)}
                      options={orderedDecks.map((deck) => ({ value: deck.id, label: deckPathLabel(decks, deck.id) }))}
                    />
                  </label>
                  {!orderedDecks.length && <p>{t('cards.cardless.noDeck')}</p>}
                  {rowError[note.id] && <p role="alert" style={{ color: 'var(--rose-400)' }}>{rowError[note.id]}</p>}
                  {pendingDelete === note.id ? (
                    <div style={{ display: 'grid', gap: 8 }}>
                      <p>{t('cards.cardless.deleteConfirm')}</p>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <NNBtn variant="danger" disabled={Boolean(busyId)} onClick={() => onDelete(note)}>
                          {t('actions.delete')}
                        </NNBtn>
                        <NNBtn variant="ghost" disabled={Boolean(busyId)} onClick={onCancelDelete}>
                          {t('actions.cancel')}
                        </NNBtn>
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <NNBtn variant="primary" disabled={!deckId || Boolean(busyId)} onClick={() => onRestore(note)}>
                        {t('cards.cardless.restore')}
                      </NNBtn>
                      <NNBtn variant="danger" disabled={Boolean(busyId)} onClick={() => onAskDelete(note.id)}>
                        {t('actions.delete')}
                      </NNBtn>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </div>
      </div>
    </LayerParent.Provider>,
    document.body,
  );
}
