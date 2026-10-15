'use client';

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {visibleAssistantViewport} from '@/lib/assistant-overlay-geometry';
import { LayerParent, useTransientLayer } from '@/lib/use-transient-layer';
import { createPortal } from 'react-dom';
import { ASSISTANT_OBJECT_KINDS, assistantRefKey, type AssistantObjectKind, type AssistantObjectSnapshot } from '@reomi/shared';
import { assistantApi, ok } from '@/lib/api';
import { NNBtn, NNIcon } from '@/components/ui';
import { useT } from '@/lib/i18n';

export interface ContextPickerHandle { keyDown(event: React.KeyboardEvent): boolean }
interface Props {
  ownerId: string; query: string; onPick(value: AssistantObjectSnapshot): void; onClose(): void;
  handleRef?: React.MutableRefObject<ContextPickerHandle | null>;
  anchorRef?: React.RefObject<HTMLElement | null>;
  allowPassages?: boolean;
  selectedMaterials?: React.ReactNode;
  search?: (query: { q: string; type?: string; parentKind?: string; parentId?: string; cursor?: string }) => Promise<{ items: AssistantObjectSnapshot[]; nextCursor: string | null }>;
}
const searchObjects: NonNullable<Props['search']> = async query => await ok(await assistantApi.chat.context.search.get({ query: { ...query, limit: 20 } }));
const icons: Record<AssistantObjectKind,string> = { card: 'cards', deck: 'stack', source: 'book', source_passage: 'doc', notebook: 'notebook', written_note: 'edit', flashcard_note: 'doc', note_type: 'grid', artifact: 'doc', conversation: 'chat' };

export function ContextPicker({ ownerId, query, onPick, onClose, handleRef, anchorRef, allowPassages = true, selectedMaterials, search = searchObjects }: Props) {
  const t = useT();
  const [type, setType] = useState('');
  const [source, setSource] = useState<AssistantObjectSnapshot | null>(null);
  const [sectionQuery, setSectionQuery] = useState('');
  const [items, setItems] = useState<AssistantObjectSnapshot[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [index, setIndex] = useState(0);
  const [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  const root=useRef<HTMLDivElement>(null);
  const layer = useTransientLayer({ root, onClose, portals: () => [anchorRef?.current?.closest<HTMLElement>('.reomi-assistant-composer,.reomi-assistant-threads') ?? null] });
  const [placement,setPlacement]=useState<React.CSSProperties | null>(null);
  useLayoutEffect(()=>{
    if(!anchorRef?.current)return;
    const update=()=>{
      const rect=anchorRef.current!.getBoundingClientRect(),viewport=visibleAssistantViewport();
      const width=Math.min(Math.max(rect.width,300),viewport.width-24),above=rect.top-viewport.top-12,below=viewport.top+viewport.height-rect.bottom-12;
      const useAbove=above>=below;
      setPlacement({position:'fixed',left:Math.max(viewport.left+12,Math.min(rect.left,viewport.left+viewport.width-width-12)),width,right:'auto',zIndex:110,
        ...(useAbove?{bottom:window.innerHeight-rect.top+8,top:'auto'}:{top:rect.bottom+8,bottom:'auto'}),
        maxHeight:Math.max(1,Math.min(360,(useAbove?above:below)-8))});
    };
    update();window.addEventListener('resize',update);window.addEventListener('scroll',update,true);window.visualViewport?.addEventListener('resize',update);window.visualViewport?.addEventListener('scroll',update);
    return()=>{window.removeEventListener('resize',update);window.removeEventListener('scroll',update,true);window.visualViewport?.removeEventListener('resize',update);window.visualViewport?.removeEventListener('scroll',update);};
  },[anchorRef]);
  useLayoutEffect(() => { setSource(null); setSectionQuery(''); setItems([]); }, [ownerId]);
  const run = useCallback(async (more?: string) => {
    const request = ++sequence.current; setBusy(true); setError(false);
    try {
      const page = await search({ q: source ? sectionQuery : query, type: source ? 'source_passage' : type || undefined,
        parentKind: source ? 'source' : undefined, parentId: source?.ref.id, cursor: more });
      if (request !== sequence.current) return;
      setItems(old => more ? [...new Map([...old,...page.items].map(s => [assistantRefKey(s.ref),s])).values()] : page.items);
      setCursor(page.nextCursor); if (!more) setIndex(0);
    } catch { if (request === sequence.current) setError(true); }
    finally { if (request === sequence.current) setBusy(false); }
  }, [query, source, sectionQuery, type, search]);
  useEffect(() => {
    sequence.current++; setItems([]); setCursor(null); setBusy(true);
    const timer = setTimeout(() => void run(), 150);
    return () => { clearTimeout(timer); sequence.current++; };
  }, [run, ownerId, revision]);
  const keyDown = useCallback((event: React.KeyboardEvent): boolean => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void layer.close(); return true; }
    if ((event.target as HTMLElement).closest?.('button,select')) return false;
    if (event.key === 'Enter' && (busy || !items.length)) { event.preventDefault(); return true; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setIndex(i => Math.max(0, Math.min(items.length - 1, i + (event.key === 'ArrowDown' ? 1 : -1)))); return true; }
    if ((event.key === 'Enter' || event.key === 'Tab' && !event.shiftKey) && items[index] && !busy) { event.preventDefault(); onPick(items[index]!); return true; }
    return false;
  }, [items,index,busy,onClose,onPick]);
  useEffect(() => { if (!handleRef) return; handleRef.current = { keyDown }; return () => { handleRef.current = null; }; }, [handleRef,keyDown]);
  const panel=<LayerParent.Provider value={layer.id}><div ref={root} className="reomi-assistant-context-picker" role="dialog" data-assistant-overlay aria-label={t('assistant.addContext')} onKeyDown={keyDown} style={placement??undefined}>
    <div className="reomi-assistant-picker-toolbar">
      {source ? <><NNBtn size="sm" variant="ghost" icon="chevl" onClick={() => setSource(null)}>{source.label}</NNBtn>
        <input autoFocus value={sectionQuery} onChange={e => setSectionQuery(e.target.value)} aria-label={t('assistant.findSections')} placeholder={t('assistant.findSections')} /></>
        : <select aria-label={t('assistant.objectType')} value={type} onChange={e => setType(e.target.value)}>
          <option value="">{t('assistant.allObjects')}</option>{ASSISTANT_OBJECT_KINDS.filter(kind => kind !== 'source_passage').map(kind => <option key={kind} value={kind}>{t(`assistant.kinds.${kind}`)}</option>)}
        </select>}
      <NNBtn size="sm" variant="ghost" icon="x" ariaLabel={t('actions.close')} onClick={() => void layer.close()} />
    </div>
    {selectedMaterials}
    {error ? <div role="alert">{t('assistant.searchFailed')} <NNBtn size="sm" onClick={() => setRevision(v => v + 1)}>{t('review.retry')}</NNBtn></div>
      : <div role="listbox" aria-busy={busy} aria-label={t('assistant.results')} className="nn-scroll" style={placement?{maxHeight:Math.max(60,Number(placement.maxHeight)-52-(selectedMaterials?128:0))}:undefined}>
        {items.map((item,i) => <div key={assistantRefKey(item.ref)} className="reomi-assistant-picker-row" data-active={i === index || undefined}>
          <button role="option" aria-selected={i === index} onMouseDown={e => e.preventDefault()} onMouseEnter={() => setIndex(i)} onClick={() => onPick(item)}>
            <NNIcon name={icons[item.ref.kind]} size={15} /><span><strong>{item.label}</strong><small>{t(`assistant.kinds.${item.ref.kind}`)}{item.parent ? ` · ${item.parent.label}` : ''}</small></span>
          </button>
          {allowPassages && item.ref.kind === 'source' && <NNBtn size="sm" variant="ghost" icon="chevr" ariaLabel={t('assistant.sections')} title={t('assistant.sections')} onClick={() => { setSource(item); setSectionQuery(''); }} />}
        </div>)}
        {!items.length && <p>{t(busy ? 'states.loading' : 'assistant.noResults')}</p>}
        {cursor && <NNBtn size="sm" disabled={busy} onClick={() => void run(cursor)}>{t('assistant.more')}</NNBtn>}
      </div>}
  </div></LayerParent.Provider>;
  return placement?createPortal(panel,document.body):panel;
}
