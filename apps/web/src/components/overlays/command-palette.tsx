'use client';

/* eslint-disable react/forbid-elements -- TODO: replace raw input, select, and button with TextInput, Button, or NNSelect. */

import { useState, useEffect, useRef, useMemo, useId } from 'react';
import { useTransientLayer } from '@/lib/use-transient-layer';
import { NNIcon, NNKbd, NNBtn } from '@/components/ui';
import { useAppNavigation } from '@/components/navigation';

import { useNN } from '@/lib/store';
import { useStudyOverview } from '@/lib/use-study-overview';
import type { Card, LibraryItem, Notebook } from '@/lib/types';
import { useT } from '@/lib/i18n';
import { paletteSelection, movePaletteSelection, paletteDeckHref } from '@/lib/command-palette';

type Item = { id: string; group: string; icon: string; label: string; sub?: string; href: string };
type Search = { query: string; cards: Card[]; sources: LibraryItem[]; moreCards: boolean; pending: boolean; errors: string[] };
const matches = (query: string, ...fields: (string | undefined | null)[]) => fields.some(value => value?.toLocaleLowerCase().includes(query));

export function CommandPalette({ defaultQuery = '', onClose }: { defaultQuery?: string; onClose?: () => void }) {
  const t = useT();
  const router = useAppNavigation();
  const dialog = useRef<HTMLDialogElement>(null);
  const layer = useTransientLayer({ root: dialog, modal: true, onClose: () => onClose?.() });
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [query, setQuery] = useState(defaultQuery);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const decks = useNN(state => state.decks);
  const cards = useNN(state => state.cards);
  const study = useStudyOverview();
  const searchCards = useNN(state => state.searchCards);
  const listLibrary = useNN(state => state.listLibrary);
  const listNotebooks = useNN(state => state.listNotebooks);

  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [notebookError, setNotebookError] = useState(false);
  const [search, setSearch] = useState<Search>({ query: '', cards: [], sources: [], moreCards: false, pending: true, errors: [] });
  const normalized = query.trim().toLocaleLowerCase();

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    const previous = document.activeElement as HTMLElement | null;
    node.showModal(); input.current?.focus();
    return () => { node.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setNotebookError(false);
    void listNotebooks().then(rows => { if (!cancelled) setNotebooks(rows); }, () => { if (!cancelled) setNotebookError(true); });
    return () => { cancelled = true; };
  }, [listNotebooks, retry]);

  useEffect(() => {
    let cancelled = false;
    const q = query.trim();
    setSearch({ query: q.toLocaleLowerCase(), cards: [], sources: [], moreCards: false, pending: true, errors: [] });
    const timer = setTimeout(async () => {
      const [cardResult, sourceResult] = await Promise.allSettled([
        q ? searchCards(q, { limit: '7' }) : Promise.resolve({ items: [] as Card[], nextCursor: null }),
        listLibrary(q ? { q, limit: 6 } : { limit: 3 }),
      ]);
      if (cancelled) return;
      setSearch({ query: q.toLocaleLowerCase(), pending: false,
        cards: cardResult.status === 'fulfilled' ? cardResult.value.items : [],
        sources: sourceResult.status === 'fulfilled' ? sourceResult.value.items : [],
        moreCards: cardResult.status === 'fulfilled' && (cardResult.value.items.length > 6 || Boolean(cardResult.value.nextCursor)),
        errors: [...(cardResult.status === 'rejected' ? ['cards'] : []), ...(sourceResult.status === 'rejected' ? ['sources'] : [])],
      });
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, searchCards, listLibrary, retry]);

  const items = useMemo(() => {
    const group = (key: string) => t(`overlays.palette.groups.${key}`);
    const quick = 'overlays.palette.quick.';
    const staticItems: Item[] = [
      { id: 'review', group: group('quickActions'), icon: 'review', label: t(quick + 'reviewNow.label'), sub: t(quick + 'reviewNow.sub', { n: study.data?.overall.totalAvailable ?? '—' }), href: '/review' },
      { id: 'create-card', group: group('quickActions'), icon: 'plus', label: t(quick + 'newCard.label'), sub: t(quick + 'newCard.sub'), href: '/editor' },
      { id: 'create-deck', group: group('quickActions'), icon: 'decks', label: t(quick + 'newDeck.label'), href: '/decks?create=1' },
      ...([
        ['home', '/', 'home', 'goHome'], ['review', '/review', 'review', 'goReview'],
        ['cards', '/cards', 'cards', 'goCards'], ['graph', '/graph', 'graph', 'goGraph'],
        ['decks', '/decks', 'decks', 'goDecks'], ['library', '/library', 'library', 'goLibrary'],
        ['notebooks', '/notebooks', 'notebook', 'goNotebooks'], ['chat', '/chat', 'chat', 'goChat'],
        ['garden', '/garden', 'garden', 'goGarden'], ['note-types', '/note-types', 'grid', 'goNoteTypes'],
        ['stats', '/stats', 'chart', 'goStats'], ['settings', '/settings', 'settings', 'goSettings'],
      ] as const).map(([id, href, icon, label]) => ({ id: `nav-${id}`, group: group('navigate'), icon, label: t(quick + label), href })),
    ].filter(item => !normalized || matches(normalized, item.label, item.sub, item.group));
    const deckById = new Map(decks.map(deck => [deck.id, deck]));
    const serverCurrent = search.query === normalized;
    const cardRows = normalized
      ? serverCurrent && !search.pending && !search.errors.includes('cards') ? search.cards : cards.filter(card => matches(normalized, card.renderFrontText, card.renderBackText, ...card.tags))
      : cards.slice(0, 3);
    const dynamic: Item[] = [
      ...cardRows.slice(0, normalized ? 6 : 3).map(card => ({ id: `card-${card.id}`, group: group('cards'), icon: 'cards', label: card.renderFrontText.trim() || t('overlays.palette.untitledCard'), sub: deckById.get(card.deckId)?.name || t('overlays.palette.cardItemSub'), href: `/cards?focus=${card.id}` })),
      ...(normalized && serverCurrent && search.moreCards ? [{ id: 'cards-more', group: group('cards'), icon: 'arrow', label: t('overlays.palette.showAllCards'), href: `/cards?q=${encodeURIComponent(query.trim())}` }] : []),
      ...decks.filter(deck => !normalized || matches(normalized, deck.name)).slice(0, normalized ? 8 : 3).map(deck => ({ id: `deck-${deck.id}`, group: group('decks'), icon: 'decks', label: deck.name, href: paletteDeckHref(deck.name) })),
      ...(serverCurrent ? search.sources : []).map(source => ({ id: `source-${source.id}`, group: group('sources'), icon: 'book', label: source.title, sub: t('overlays.palette.sourceItemSub', { kind: source.kind.toUpperCase() }), href: `/library/${source.id}` })),
      ...notebooks.filter(book => !normalized || matches(normalized, book.title)).slice(0, normalized ? 6 : 3).map(book => ({ id: `notebook-${book.id}`, group: group('notebooks'), icon: 'notebook', label: book.title, sub: t('overlays.palette.notebookItemSub'), href: `/notebooks/${book.id}` })),
    ];
    return [...staticItems.filter(item => item.group === group('quickActions')), ...dynamic, ...staticItems.filter(item => item.group === group('navigate'))];
  }, [query, normalized, cards, decks, notebooks, search, study.data, t]);
  const groups = useMemo(() => {
    const result = new Map<string, Item[]>();
    for (const item of items) result.set(item.group, [...(result.get(item.group) ?? []), item]);
    return result;
  }, [items]);
  const ids = items.map(item => item.id);
  const selectedId = paletteSelection(ids, activeId);
  const selectedIndex = items.findIndex(item => item.id === selectedId);
  const pending = search.pending || search.query !== normalized;
  const hasError = notebookError || search.errors.length > 0;
  const open = (item: Item) => { onClose?.(); router.push(item.href, {intent:item.id.startsWith('nav-') ? 'section' : 'object'}); };

  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [selectedId]);

  return <dialog ref={dialog} className="reomi-palette" aria-label={t('overlays.palette.title')}
    onCancel={event => { event.preventDefault(); void layer.close('escape'); }}
    onClick={event => {
      if (event.target !== event.currentTarget) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) void layer.close('outside');
    }}>
    <div className="reomi-palette-search">
      <NNIcon name="search" size={20} />
      <input ref={input} role="combobox" aria-label={t('overlays.palette.title')} aria-autocomplete="list" aria-expanded="true"
        aria-controls={listId} aria-activedescendant={selectedIndex >= 0 ? `${listId}-${selectedIndex}` : undefined}
        value={query} maxLength={200} placeholder={t('overlays.palette.searchPlaceholder')}
        onChange={event => { setQuery(event.target.value); setActiveId(null); list.current?.scrollTo({ top: 0 }); }}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && !event.shiftKey) {
            event.preventDefault(); event.stopPropagation(); setActiveId(movePaletteSelection(ids, selectedId, event.key));
          } else if (event.key === 'Enter') {
            event.preventDefault(); event.stopPropagation(); const item = items[selectedIndex]; if (item) open(item);
          }
        }} />
      {query && <NNBtn icon="x" ariaLabel={t('overlays.palette.clear')} title={t('overlays.palette.clear')} onClick={() => { setQuery(''); setActiveId(null); input.current?.focus(); }} />}
      <button type="button" className="reomi-palette-close" aria-label={t('actions.close')} onClick={() => void layer.close()}><NNKbd>esc</NNKbd></button>

    </div>
    <div ref={list} id={listId} className="reomi-palette-results nn-scroll" role="listbox" aria-label={t('overlays.palette.results')} aria-busy={pending}>
      {[...groups].map(([label, rows]) => <div key={label} role="group" aria-label={label}>
        <div className="reomi-palette-group" aria-hidden>{label}</div>
        {rows.map(item => { const index = items.indexOf(item); return <div key={item.id} id={`${listId}-${index}`} role="option" aria-selected={item.id === selectedId}
          className="reomi-palette-option" onPointerMove={() => setActiveId(item.id)} onMouseDown={event => event.preventDefault()} onClick={() => open(item)}>
          <span className="reomi-palette-icon"><NNIcon name={item.icon} size={18} /></span>
          <span className="reomi-palette-copy"><span>{item.label}</span>{item.sub && <small>{item.sub}</small>}</span>
          <NNIcon name="arrow" size={14} />
        </div>; })}
      </div>)}
      {!items.length && !pending && <p className="reomi-palette-empty">{t('overlays.palette.noResults')} «{query}»</p>}
    </div>
    <div className="reomi-palette-status" role="status" aria-live="polite">
      {pending ? t('overlays.palette.searching') : hasError ? <><span>{t('overlays.palette.partialError')}</span><button type="button" onClick={() => setRetry(value => value + 1)}>{t('overlays.palette.retry')}</button></> : t('overlays.palette.resultCount', { n: items.length })}
    </div>
    <footer className="reomi-palette-footer"><span><NNKbd>↑↓</NNKbd> {t('overlays.palette.hints.navigate')}</span><span><NNKbd>↵</NNKbd> {t('overlays.palette.hints.open')}</span><span><NNKbd>⌘ / Ctrl K</NNKbd> {t('overlays.palette.hints.toggle')}</span></footer>
  </dialog>;
}
