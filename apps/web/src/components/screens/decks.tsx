'use client';

import { restoreLayerFocus } from '@/lib/use-transient-layer';

import React, { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import type { DeckPlacement } from '@reomi/shared';
import { AppLink, useAppNavigation, useNavigationWorkspace, useWorkspaceState, useWorkspaceSet } from '@/components/navigation';
import { Modal } from '@/components/design-system/modal';
import { TextInput, Field, PageSurface } from '@/components/design-system/primitives';
import { NNAppPage } from '@/components/app-page';
import { NNIcon, NNBtn } from '@/components/ui';
import { CardActionsMenu, type CardMenuAction } from '@/components/card-actions-menu';
import { DeckAppearance, deckIconName, deckColorValue } from '@/components/deck-appearance';
import { useAssistantPageContext } from '@/components/chat/assistant-provider';
import { DeckDetails, deckCardsHref } from '@/components/deck-details';
import { useDeckDrag } from '@/lib/use-deck-drag';
import { useSmallAction } from '@/lib/use-small-action';
import { uiActionRequest } from '@/lib/ui-actions-api';
import { SaveFeedback } from '@/components/save-feedback';
import { draftFingerprint } from '@/lib/editor-drafts';
import { mirrorAccountGeneration, useNN } from '@/lib/store';
import { api, ok } from '@/lib/api';
import { deckFromApi } from '@/lib/mappers';
import { useStudyOverview } from '@/lib/use-study-overview';
import type { Deck, DeckColor } from '@/lib/types';
import { useBreakpoint } from '@/lib/use-breakpoint';
import { useT } from '@/lib/i18n';
import { useDialog } from '@/components/dialog';
import { raiseToast } from '@/components/toasts';
import { filterDeckTree } from '@/lib/deck-filter';
import { buildDeckTree, flattenTree, deckPathLabel, canBeParentOf } from '@/lib/decks';
import { readBrowserValue, writeBrowserValue } from '@/lib/storage-migration';

import { useNavigationScroll, NavigationRestoreNotice } from '@/lib/use-navigation-scroll';

const EXPANDED_KEY = 'nn:decks:collapsed';
export const NNDecks = () => {
  const t = useT();
  const { confirm, prompt, select, edit } = useDialog();
  const bp = useBreakpoint();
  const isMobile = bp === 'mobile';
  const wide = bp === 'desktop';
  const router = useAppNavigation();
  const params = useSearchParams();
  const workspace = useNavigationWorkspace();
  const bootstrapped = useNN(s => s.bootstrapped);
  const decks = useNN(s => s.decks);
  const presets = useNN(s => s.presets);
  const addDeck = useNN(s => s.addDeck);
  const deleteDeck = useNN(s => s.deleteDeck);
  const bindDeckPreset = useNN(s => s.bindDeckPreset);
  const study = useStudyOverview();
  const [deckSearch, setDeckSearch] = useWorkspaceState('decks', 'deckSearch', '');
  const [filterCollapsed, setFilterCollapsed] = useWorkspaceSet('decks', 'filterCollapsed');
  const [collapsed, setCollapsed] = useWorkspaceSet('decks', 'collapsed');
  const [selectedId, setSelectedId] = useWorkspaceState<string | null>('decks', 'selectedId', null);
  const selectedRef = useRef(selectedId); selectedRef.current = selectedId;
  const ownerId = useNN(state => state.profile?.userId) ?? '';
  const [hierarchyError, setHierarchyError] = useState(false);
  const [hierarchyRevision, setHierarchyRevision] = useState<number | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  useEffect(() => {
    if (!bootstrapped || !ownerId) return;
    let active = true;
    const account = mirrorAccountGeneration();
    const before = useNN.getState();
    setHierarchyError(false);
    void uiActionRequest<{ revision: number; decks: unknown[] }>(ownerId, '/deck-hierarchy').then((snapshot) => {
      const current = useNN.getState();
      if (!active || account !== mirrorAccountGeneration() || current.profile?.userId !== before.profile?.userId) return;
      if (!Array.isArray(snapshot.decks) || !Number.isSafeInteger(snapshot.revision)) throw new Error('invalid_hierarchy');
      const fresh = snapshot.decks.map(deckFromApi);
      setHierarchyRevision(snapshot.revision);
      useNN.setState({ decks: fresh });
      if (selectedRef.current && !fresh.some(deck => deck.id === selectedRef.current)) {
        setSelectedId(null);
        raiseToast({ kind: 'info', title: t('navigation.itemUnavailable') });
      }
    }).catch(() => { if (active) setHierarchyError(true); });
    return () => { active = false; };
  }, [bootstrapped, ownerId, workspace?.entry?.id, refreshRevision]);
  useEffect(() => {
    const refresh = () => setRefreshRevision(value => value + 1);
    window.addEventListener('nn:knowledge-changed', refresh);
    return () => window.removeEventListener('nn:knowledge-changed', refresh);
  }, []);
  const filterActive = Boolean(deckSearch.trim());
  const clearFilters = () => { setDeckSearch(''); setFilterCollapsed(new Set()); };
  useEffect(() => { if (workspace?.entry?.views.decks?.fields.collapsed) return; try { const raw = readBrowserValue(localStorage, EXPANDED_KEY); if (raw) setCollapsed(new Set(JSON.parse(raw))); } catch {} }, []);
  const saveCollapsed = (next: Set<string>) => {
    setCollapsed(next);
    try { writeBrowserValue(localStorage, EXPANDED_KEY, JSON.stringify([...next])); } catch {}
  };
  const toggleCollapsed = (id: string) => {
    const next = new Set(filterActive ? filterCollapsed : collapsed);
    next.has(id) ? next.delete(id) : next.add(id);
    if (filterActive) setFilterCollapsed(next); else saveCollapsed(next);
  };
  const expand = (id: string) => { const next = new Set(collapsed); next.delete(id); saveCollapsed(next); };
  const tree = useMemo(() => buildDeckTree(decks), [decks]);
  const filteredTree = useMemo(() => filterDeckTree(tree, deckSearch), [tree, deckSearch]);
  const effectiveCollapsed = filterActive ? filterCollapsed : collapsed;
  const expanded = useMemo(() => new Set(decks.filter(d => !effectiveCollapsed.has(d.id)).map(d => d.id)), [decks, effectiveCollapsed]);
  const rows = useMemo(() => flattenTree(filteredTree, expanded), [filteredTree, expanded]);
  const filterNodes = useMemo(() => flattenTree(filteredTree, new Set(decks.map(d => d.id))), [filteredTree, decks]);
  const hasOpenBranch = filterNodes.some(node => node.children.length > 0 && !effectiveCollapsed.has(node.deck.id));
  const toggleAll = () => {
    const next = hasOpenBranch ? new Set(filterNodes.filter(node => node.children.length > 0).map(node => node.deck.id)) : new Set<string>();
    if (filterActive) setFilterCollapsed(next); else saveCollapsed(next);
  };
  const selected = rows.length > 0 ? decks.find(d => d.id === selectedId) ?? (wide ? rows[0]?.deck : undefined) : undefined;
  useAssistantPageContext(selected ? { kind: 'deck', id: selected.id } : null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const mutate = async (operation: () => Promise<unknown>) => {
    if (pending.current) return false;
    pending.current = true; setBusy(true);
    try { await operation(); setHierarchyRevision(null); setRefreshRevision(value => value + 1); return true; }
    catch { raiseToast({ kind: 'error', title: t('common.toasts.error') }); return false; }
    finally { pending.current = false; setBusy(false); }
  };

  const [creating, setCreating] = useState(false);
  const [appearanceId, setAppearanceId] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState<DeckColor>('lime');
  const [newIcon, setNewIcon] = useState('decks');
  const [newParentId, setNewParentId] = useState<string | null>(null);
  const [appearanceRevision, setAppearanceRevision] = useState(0);
  const appearanceBaseline = useRef('');
  const [appearanceLatest, setAppearanceLatest] = useState<Deck | null>(null);
  const appearanceAction = useSmallAction(ownerId, draftFingerprint({ newColor, newIcon }));
  const [formError, setFormError] = useState('');
  const closeForm = () => { if (busy || appearanceAction.busy) return; setCreating(false); setAppearanceId(null); setFormError(''); };
  const openCreateAt = (parentId: string | null) => {
    const parent = decks.find(d => d.id === parentId);
    setNewParentId(parentId); setNewName(''); setNewColor(parent?.color ?? 'lime'); setNewIcon(parent?.icon ? deckIconName(parent.icon) : 'decks'); setFormError(''); setCreating(true);
  };
  const openAppearance = (deck: Deck) => { appearanceBaseline.current = draftFingerprint({ newColor: deck.color, newIcon: deckIconName(deck.icon) }); setAppearanceId(deck.id); setAppearanceRevision(deck.metadataRevision ?? 0); setAppearanceLatest(null); appearanceAction.controller.reset(draftFingerprint({ newColor: deck.color, newIcon: deckIconName(deck.icon) })); setNewColor(deck.color); setNewIcon(deckIconName(deck.icon)); setFormError(''); };
  const createRequested = params?.get('create') === '1';
  const focusRequested = params?.get('focus');
  const consumedFocus = useRef<string | null>(null);
  useEffect(() => {
    if (!focusRequested) { consumedFocus.current = null; return; }
    if (!bootstrapped || consumedFocus.current === focusRequested) return;
    consumedFocus.current = focusRequested;
    const deck = decks.find(d => d.id === focusRequested);
    if (deck) {
      setSelectedId(deck.id); setDeckSearch('');
      const ancestors = new Set<string>();
      let parent: string | null | undefined = deck.parentId;
      while (parent && !ancestors.has(parent)) { ancestors.add(parent); parent = decks.find(d => d.id === parent)?.parentId ?? null; }
      setCollapsed(previous => {
        const next = new Set([...previous].filter(id => !ancestors.has(id)));
        try { writeBrowserValue(localStorage, EXPANDED_KEY, JSON.stringify([...next])); } catch {}
        return next;
      });
    } else raiseToast({ kind: 'error', title: t('common.toasts.error') });
    const next = new URLSearchParams(params?.toString()); next.delete('focus');
    router.replace(`/decks${next.size ? `?${next}` : ''}`, { scroll: false, track: false });
  }, [focusRequested, bootstrapped, decks, params, router, t]);
  useEffect(() => { if (createRequested) { openCreateAt(null); router.replace('/decks'); } }, [createRequested]);
  const acceptAppearance = (accepted: Awaited<ReturnType<typeof appearanceAction.run>>, account: number) => {
    if (account !== mirrorAccountGeneration() || !accepted?.response.result || useNN.getState().profile?.userId !== ownerId) return;
    const updated = deckFromApi(accepted.response.result);
    useNN.setState(state => ({ decks: state.decks.map(row => row.id === updated.id ? updated : row) }));
    if (accepted.response.outcome === 'applied') { setAppearanceRevision(updated.metadataRevision ?? 0); if (accepted.currentMatches) closeForm(); }
  };
  const saveForm = async () => {
    if (creating && !newName.trim()) return false;
    if (appearanceId) {
      const account = mirrorAccountGeneration();
      const accepted = await appearanceAction.run(`/decks/${appearanceId}`, { expectedRevision: appearanceRevision, patch: { color: newColor, icon: newIcon } });
      acceptAppearance(accepted, account);
      return Boolean(accepted?.currentMatches && accepted.response.outcome === 'applied');
    }
    const saved = await mutate(async () => {
      {
        const deck = await addDeck({ name: newName.trim(), color: newColor, icon: newIcon, species: 'fern', parentId: newParentId ?? undefined });
        if (newParentId) expand(newParentId);
        setSelectedId(deck.id);
      }
    });
    if (saved) closeForm(); else setFormError(t('common.toasts.error'));
    return saved;
  };

  const beforeAppearanceClose = async () => {
    if (busy || appearanceAction.busy) return false;
    const dirty = appearanceId ? draftFingerprint({ newColor, newIcon }) !== appearanceBaseline.current || appearanceAction.uncertain : creating && Boolean(newName.trim());
    if (!dirty) return true;
    const choice = await select({ title: t('editor.draft.leaveTitle'), message: appearanceAction.uncertain ? t('actionsRecovery.uncertainClose') : undefined,
      value: 'save', options: [{ value: 'save', label: t('editor.draft.saveAndLeave') }, { value: 'discard', label: t('editor.draft.discardAndLeave') }], cancelLabel: t('editor.draft.stay') });
    if (choice === 'discard') return true;
    if (choice !== 'save') return false;
    if (appearanceAction.uncertain) { const account = mirrorAccountGeneration(); const accepted = await appearanceAction.retry(); acceptAppearance(accepted, account); return Boolean(accepted?.currentMatches && accepted.response.outcome === 'applied'); }
    return saveForm();
  };

  const [movingId, setMovingId] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState('');
  const [placement, setPlacement] = useState<DeckPlacement>('inside');
  const [moveError, setMoveError] = useState('');
  const moveAction = useSmallAction(ownerId);
  const moveIntent = useRef<{ id: string; targetId: string | null; placement: DeckPlacement } | null>(null);
  const moveOptions = useMemo(() => flattenTree(tree, new Set(decks.map(d => d.id))).filter(n => movingId && canBeParentOf(decks, movingId, n.deck.id)), [tree, decks, movingId]);
  const acceptMove = (accepted: Awaited<ReturnType<typeof moveAction.run>>, account: number) => {
    if (account !== mirrorAccountGeneration() || !accepted?.response.result || useNN.getState().profile?.userId !== ownerId) return;
    if (Array.isArray(accepted.response.result)) useNN.setState({ decks: accepted.response.result.map(deckFromApi) });
    if (accepted.response.outcome !== 'applied') return;
    setHierarchyRevision(Number(accepted.response.receipt.target.revision));
    const intent = moveIntent.current;
    if (intent) { if (intent.targetId && intent.placement === 'inside') expand(intent.targetId); setSelectedId(intent.id); }
    setMovingId(null); setMoveError('');
  };
  const performMove = async (id: string, targetId: string | null, place: DeckPlacement) => {
    if (hierarchyRevision === null || moveAction.busy || moveAction.uncertain) return;
    moveIntent.current = { id, targetId, placement: place };
    const account = mirrorAccountGeneration();
    acceptMove(await moveAction.run(`/decks/${id}/move`, { expectedRevision: hierarchyRevision, targetId, placement: place }, 'POST'), account);
  };

  const [menu, setMenu] = useState<{ id: string; x: number; y: number; anchor: HTMLElement } | null>(null);
  const closeMenu = useCallback((restore: boolean) => { if (restore) restoreLayerFocus(menu?.anchor); setMenu(null); }, [menu]);
  const openMenu = (id: string, anchor: HTMLElement, point?: { x: number; y: number }) => {
    if (busy) return;
    const rect = anchor.getBoundingClientRect(); setMenu({ id, anchor, x: point?.x ?? rect.left, y: point?.y ?? rect.bottom });
  };
  const menuDeck = decks.find(d => d.id === menu?.id);
  const actions: CardMenuAction[] = menuDeck ? [
    { label: t('cards.openCards'), icon: 'cards', run: () => router.push(deckCardsHref(decks, menuDeck.id)) },
    { label: t('decks.details.study'), icon: 'play', run: () => router.push(`/review?deck=${menuDeck.id}`) },
    { label: t('decks.addCard'), icon: 'plus', run: () => router.push(`/editor?deck=${menuDeck.id}`) },
    { label: t('decks.newSubDeck'), icon: 'decks', run: () => openCreateAt(menuDeck.id) },
    { label: t('actions.rename'), icon: 'edit', run: () => { const account = mirrorAccountGeneration(); void edit({ title: t('decks.renamePrompt'), defaultValue: menuDeck.name,
      path: `/decks/${menuDeck.id}`, revision: menuDeck.metadataRevision ?? 0, maxLength: 100,
      patch: name => ({ name }), validate: name => name.trim() ? null : ' ',
      readCurrent: async () => { const rows: any = await ok(await api.decks.get()); const current = rows.find((row: any) => row.id === menuDeck.id); if (!current) throw new Error('not_found'); return { revision: current.metadataRevision ?? 0, value: current.name }; },
      onSaved: result => { if (account !== mirrorAccountGeneration() || !result.result) return; const updated = deckFromApi(result.result); useNN.setState(state => ({ decks: state.decks.map(row => row.id === updated.id ? updated : row) })); },
    }); } },
    { label: t('decks.appearance.title'), icon: 'star', run: () => openAppearance(menuDeck) },
    { label: t('decks.move.title'), icon: 'stack', run: () => { setMovingId(menuDeck.id); setMoveTarget(''); setPlacement('inside'); setMoveError(''); } },
    { label: t('decks.deckOptionsMenu'), icon: 'settings', run: () => { void (async () => {
      const picked = await select<string>({ title: t('decks.presetPickTitle', { deck: menuDeck.name }), value: menuDeck.presetId ?? '__none__', options: [{ value:'__none__', label:t('decks.presetPickNone') }, ...presets.map(p => ({ value:p.id,label:p.name }))] });
      if (picked !== null) await mutate(() => bindDeckPreset(menuDeck.id, picked === '__none__' ? null : picked));
    })(); } },
    { label: t('actions.delete'), icon: 'x', danger: true, run: () => { void (async () => {
      if (await confirm({ title: t('decks.deleteConfirm', { name: menuDeck.name }), danger:true })) await mutate(() => deleteDeck(menuDeck.id));
    })(); } },
  ] : [];

  const treeRef = useRef<HTMLDivElement>(null);
  const treePosition = useNavigationScroll('decks', 'tree', {ready:bootstrapped,queryKey:deckSearch});
  const setTreeRef = useCallback((node:HTMLDivElement|null)=>{treeRef.current=node;treePosition.ref(node);},[treePosition.ref]);
  const { dragging, drop, start: startDrag, consumeClick } = useDeckDrag({ decks, disabled: busy || moveAction.busy || moveAction.uncertain || hierarchyRevision === null || filterActive || isMobile,
    root: treeRef, expand, onMove: (id,target,placement) => { void performMove(id,target,placement); } });
  return <NNAppPage title={t('nav.decks')} subtitle={study.data ? String(study.data.overall.total) : undefined}
    actions={<NNBtn className="reomi-create-icon" variant="soft" icon="plus" ariaLabel={t('decks.newDeck')} onClick={() => openCreateAt(null)} />}>
    <PageSurface className="reomi-decks-page">
      <Modal open={creating || Boolean(appearanceId)} title={t(creating ? 'decks.newDeck' : 'decks.appearance.title')} closeLabel={t('actions.close')} busy={busy || appearanceAction.busy} beforeClose={beforeAppearanceClose} onClose={closeForm}>
        <form onSubmit={event => { event.preventDefault(); void saveForm(); }}><div className="reomi-modal-body">
          {creating && <><p className="reomi-modal-description">{t('decks.underParent')}: {newParentId ? deckPathLabel(decks,newParentId) : t('decks.move.root')}</p>
            <Field label={t('decks.name')}><TextInput autoFocus required maxLength={100} value={newName} disabled={busy} onChange={event => setNewName(event.target.value)} placeholder={t('decks.namePlaceholder')}/></Field></>}
          <DeckAppearance icon={newIcon} color={newColor} disabled={busy || appearanceAction.busy} onIcon={setNewIcon} onColor={setNewColor}/>
          {appearanceId && <SaveFeedback status={appearanceAction.snapshot.status} errorCode={appearanceAction.snapshot.error} onRetry={() => { const account = mirrorAccountGeneration(); void appearanceAction.retry().then(accepted => acceptAppearance(accepted, account)); }} />}
          {appearanceId && appearanceAction.snapshot.status === 'conflict' && <div>
            <NNBtn size="sm" onClick={() => { void api.decks.get().then(ok).then(rows => { const row = rows.find(row => row.id === appearanceId); if (row && useNN.getState().profile?.userId === ownerId) setAppearanceLatest(deckFromApi(row)); }).catch(() => setFormError(t('common.toasts.error'))); }}>{t('actionsRecovery.current')}</NNBtn>
            {appearanceLatest && <><p>{appearanceLatest.name} · {appearanceLatest.color} · {appearanceLatest.icon}</p><NNBtn size="sm" onClick={() => { appearanceAction.controller.resolveConflict(); const account = mirrorAccountGeneration(); void appearanceAction.run(`/decks/${appearanceId}`, { expectedRevision: appearanceLatest.metadataRevision ?? 0, patch: { color: newColor, icon: newIcon } }).then(accepted => acceptAppearance(accepted, account)); }}>{t('actionsRecovery.keepMine')}</NNBtn></>}
          </div>}
          {formError && <p role="alert">{formError}</p>}
        </div><footer className="reomi-modal-footer"><NNBtn variant="ghost" disabled={busy || appearanceAction.busy} onClick={() => { void beforeAppearanceClose().then(allowed => { if (allowed) closeForm(); }); }}>{t('actions.cancel')}</NNBtn><NNBtn variant="primary" type="submit" loading={busy || appearanceAction.busy} disabled={(creating && !newName.trim()) || Boolean(appearanceId && (appearanceAction.uncertain || appearanceAction.snapshot.status === 'conflict'))}>{t(creating ? 'actions.create' : 'actions.save')}</NNBtn></footer></form>
      </Modal>
      <Modal open={Boolean(movingId)} title={t('decks.move.title')} closeLabel={t('actions.close')} busy={busy || moveAction.busy} onClose={() => setMovingId(null)}>
        <form onSubmit={event => { event.preventDefault(); if (movingId) void performMove(movingId, moveTarget || null, placement); }}>
          <div className="reomi-modal-body"><p>{decks.find(d => d.id === movingId)?.name}</p>
            <Field label={t('decks.move.destination')}><select className="reomi-input" aria-label={t('decks.move.destination')} value={moveTarget} disabled={busy} onChange={event => { setMoveTarget(event.target.value); if (!event.target.value) setPlacement('inside'); }}>
              <option value="">{t('decks.move.root')}</option>{moveTarget && !decks.some(deck => deck.id === moveTarget) && <option value={moveTarget} disabled>{t('navigation.itemUnavailable')}</option>}{moveOptions.map(n => <option key={n.deck.id} value={n.deck.id}>{deckPathLabel(decks,n.deck.id)}</option>)}
            </select></Field>
            <Field label={t('decks.move.placement')}><select className="reomi-input" aria-label={t('decks.move.placement')} value={placement} disabled={busy || !moveTarget} onChange={event => setPlacement(event.target.value as DeckPlacement)}>
              {(['inside','before','after'] as const).map(value => <option key={value} value={value}>{t(`decks.move.${value}`)}</option>)}
            </select></Field><p className="reomi-modal-description">{t('decks.move.subtree')}</p>
            <SaveFeedback status={moveAction.snapshot.status} errorCode={moveAction.snapshot.error} onRetry={() => { const account = mirrorAccountGeneration(); void moveAction.retry().then(accepted => acceptMove(accepted, account)); }} />
            {moveAction.snapshot.status === 'conflict' && <NNBtn size="sm" onClick={() => { setHierarchyRevision(null); setRefreshRevision(value => value + 1); moveAction.controller.resolveConflict(); }}>{t('actionsRecovery.current')}</NNBtn>}
            {moveError && <p role="alert">{moveError}</p>}
          </div><footer className="reomi-modal-footer"><NNBtn variant="ghost" disabled={busy || moveAction.busy} onClick={() => setMovingId(null)}>{t('actions.cancel')}</NNBtn><NNBtn type="submit" variant="primary" loading={busy || moveAction.busy} disabled={!decks.some(deck => deck.id === movingId) || hierarchyRevision === null || moveAction.uncertain || moveAction.snapshot.status === 'conflict'}>{t('decks.move.apply')}</NNBtn></footer>
        </form>
      </Modal>
      <SaveFeedback status={moveAction.snapshot.status} errorCode={moveAction.snapshot.error} onRetry={() => { const account = mirrorAccountGeneration(); void moveAction.retry().then(accepted => acceptMove(accepted, account)); }} />
      {moveAction.snapshot.status === 'conflict' && <NNBtn size="sm" onClick={() => { setRefreshRevision(value => value + 1); moveAction.controller.resolveConflict(); }}>{t('actionsRecovery.current')}</NNBtn>}
      {(decks.length > 0 || filterActive) && <div className="reomi-decks-toolbar">
        <div className="reomi-decks-search"><NNIcon name="search" size={16} />
          <TextInput value={deckSearch} aria-label={t('decks.filters.search')} placeholder={t('decks.filters.search')}
            onChange={event => { setDeckSearch(event.target.value); setFilterCollapsed(new Set()); }} />
        </div>
        <NNBtn size="sm" variant="ghost" ariaLabel={t('navigation.reset')} onClick={()=>{workspace?.resetView('decks');router.replace('/decks',{track:false});}}>{t('navigation.reset')}</NNBtn>
        <span className="reomi-decks-count">{t('decks.filters.count', { n: filterNodes.length })}</span>
        {filterActive && <NNBtn icon="x" variant="ghost" ariaLabel={t('decks.filters.clear')} title={t('decks.filters.clear')} onClick={clearFilters} />}
        <NNBtn icon={hasOpenBranch ? 'chevd' : 'chevr'} variant="ghost" disabled={!filterNodes.some(node => node.children.length > 0)}
          ariaLabel={t(hasOpenBranch ? 'decks.filters.collapseAll' : 'decks.filters.expandAll')}
          title={t(hasOpenBranch ? 'decks.filters.collapseAll' : 'decks.filters.expandAll')} onClick={toggleAll} />
      </div>}
      <NavigationRestoreNotice failure={treePosition.failure} retry={treePosition.retry}/>
      {hierarchyError && <div role="alert" className="reomi-deck-status">{t('common.toasts.error')} <NNBtn onClick={() => setRefreshRevision(value => value + 1)}>{t('review.retry')}</NNBtn></div>}
      {study.error && <div role="alert" className="reomi-deck-status">{t('home.countsError')} <NNBtn onClick={study.reload}>{t('review.retry')}</NNBtn></div>}
      <div className="reomi-deck-workspace" data-detail={selected ? 'open' : 'closed'}>
        <div className="reomi-deck-tree-pane nn-scroll" data-empty={rows.length === 0 || undefined} ref={setTreeRef}>
          {filterActive && rows.length > 0 && <p className="reomi-deck-drag-hint">{t('decks.move.filterHint')}</p>}
          {dragging && <div className="reomi-deck-root-drop" style={{ left: (treeRef.current?.getBoundingClientRect().left ?? 0) + 12, top: (treeRef.current?.getBoundingClientRect().bottom ?? 0) - 54, width: (treeRef.current?.getBoundingClientRect().width ?? 0) - 24 }} data-deck-root-drop data-active={drop?.id === null || undefined}>{t('decks.move.toRoot')}</div>}
          {rows.length === 0 ? <div className="reomi-decks-empty">
            <span className="reomi-decks-empty-icon" aria-hidden="true"><NNIcon name={decks.length ? 'search' : 'decks'} size={28}/></span>
            <h2>{t(decks.length ? 'decks.filters.noResults' : 'decks.emptyTitle')}</h2>
            {!decks.length && <p>{t('decks.emptyHint')}</p>}
            <NNBtn variant={decks.length ? 'soft' : 'primary'} icon={decks.length ? 'x' : 'plus'} onClick={decks.length ? clearFilters : () => openCreateAt(null)}>{t(decks.length ? 'decks.filters.clear' : 'decks.newDeck')}</NNBtn></div> :
          <div className="reomi-deck-list" role="tree" aria-label={t('nav.decks')} aria-busy={busy}>
            {rows.map((node,index) => {
              const d = node.deck, counts = study.data?.decks[d.id];
              const hasChildren = decks.some(child => child.parentId === d.id);
              const isCollapsed = effectiveCollapsed.has(d.id);
              return <div key={d.id} data-navigation-anchor={d.id} role="treeitem" tabIndex={0} aria-level={node.depth + 1} aria-selected={selected?.id === d.id}
                aria-expanded={hasChildren ? !isCollapsed : undefined} aria-label={d.name}
                className="nn-deck-row reomi-organized-deck-row" data-deck-id={d.id} data-selected={selected?.id === d.id || undefined}
                data-drop={drop?.id === d.id ? drop.placement : undefined} data-dragging={dragging === d.id || undefined}
                onClick={() => { if (!consumeClick()) setSelectedId(d.id); }} onContextMenu={event => { event.preventDefault(); openMenu(d.id,event.currentTarget,{x:event.clientX,y:event.clientY}); }}
                onKeyDown={event => {
                  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); event.stopPropagation(); openMenu(d.id,event.currentTarget); return; }
                  if (event.target !== event.currentTarget) return;
                  const items = treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]');
                  let focusIndex: number | undefined;
                  if (event.key === 'ArrowDown') focusIndex = Math.min(rows.length-1,index+1);
                  if (event.key === 'ArrowUp') focusIndex = Math.max(0,index-1);
                  if (event.key === 'Home') focusIndex=0;
                  if (event.key === 'End') focusIndex=rows.length-1;
                  if (focusIndex !== undefined) { event.preventDefault(); items?.[focusIndex]?.focus(); }
                  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(d.id); }
                  if (event.key === 'ArrowRight' && hasChildren) { event.preventDefault(); if (isCollapsed) toggleCollapsed(d.id); else items?.[index+1]?.focus(); }
                  if (event.key === 'ArrowLeft') { event.preventDefault(); if (hasChildren && !isCollapsed) toggleCollapsed(d.id); else { const parentIndex=rows.findIndex(n=>n.deck.id===d.parentId); if(parentIndex>=0) items?.[parentIndex]?.focus(); } }
                }}>
                <button type="button" className="reomi-deck-drag-handle" onPointerDown={event => startDrag(event,d.id)} disabled={busy || filterActive}
                  aria-label={t('decks.move.drag')} title={t('decks.move.drag')}
                  onClick={event => { event.stopPropagation(); if (consumeClick()) return; setMovingId(d.id); setMoveTarget(''); setPlacement('inside'); setMoveError(''); }}
                  >
                  <span aria-hidden="true">⠿</span>
                </button>
                <div className="reomi-deck-name" style={{ paddingLeft: Math.min(node.depth,6) * (isMobile ? 12 : 16) }}>
                  <button type="button" className="reomi-deck-disclosure" aria-label={t(isCollapsed ? 'decks.expand' : 'decks.collapse')}
                    aria-hidden={!hasChildren || undefined} tabIndex={hasChildren ? 0 : -1} style={{ visibility: hasChildren ? 'visible' : 'hidden', transform: !isCollapsed ? 'rotate(90deg)' : undefined }}
                    onClick={event => { event.stopPropagation(); toggleCollapsed(d.id); }}><NNIcon name="chevr" size={13}/></button>
                  <button type="button" className="reomi-deck-row-icon" style={{ color: deckColorValue(d.color) }} aria-label={`${t('decks.appearance.title')}: ${d.name}`}
                    onClick={event => { event.stopPropagation(); openAppearance(d); }}><NNIcon name={deckIconName(d.icon)} size={19}/></button>
                  <div className="reomi-deck-name-copy"><strong title={deckPathLabel(decks,d.id)}>{d.name}</strong><small>{counts ? t('decks.totalCards',{n:counts.total}) : '—'}{hasChildren ? ` · ${t('decks.subCount',{n:decks.filter(child=>child.parentId===d.id).length})}` : ''}</small></div>
                </div>
                <div className="reomi-deck-row-stats">
                  <span title={t('cards.states.new')}><i style={{background:'var(--sky-500)'}}/>{counts?.newCount ?? '—'}<small>{t('decks.row.new')}</small></span>
                  <span title={t('cards.states.learning')}><i style={{background:'var(--amber-500)'}}/>{counts?.learningCount ?? '—'}<small>{t('decks.row.learning')}</small></span>
                </div>
                {counts && counts.totalAvailable > 0 ? <AppLink className="reomi-deck-due" data-active href={`/review?deck=${d.id}`} onClick={event=>event.stopPropagation()}
                  aria-label={t('decks.review')} title={t('decks.reviewCount',{n:counts.totalAvailable})}>
                  <NNIcon name="review" size={13}/>{counts.totalAvailable}
                </AppLink> : <span className="reomi-deck-due" title={counts ? t('decks.details.caughtUp') : t('cards.loading')}><NNIcon name="review" size={13}/>{counts ? 0 : '—'}</span>}
                <button type="button" className="reomi-deck-more" aria-label={`${t('decks.deckMenu')}: ${d.name}`} aria-haspopup="menu" disabled={busy}
                  onClick={event=>{event.stopPropagation();openMenu(d.id,event.currentTarget);}}><NNIcon name="dots" size={16}/></button>
              </div>;
            })}
          </div>}
        </div>
        {selected && <DeckDetails key={selected.id} deck={selected} decks={decks} counts={study.data?.decks[selected.id]} onBack={()=>setSelectedId(null)} onAppearance={()=>openAppearance(selected)}/>}
      </div>
      {menu && menuDeck && <CardActionsMenu x={menu.x} y={menu.y} label={menuDeck.name} closeLabel={t('actions.close')} mobile={isMobile} actions={actions} onClose={closeMenu}/>}
    </PageSurface>
  </NNAppPage>;
};
