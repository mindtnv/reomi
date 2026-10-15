'use client';

/* eslint-disable react/forbid-elements -- #78 */
import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {AssistantObjectSnapshot} from '@reomi/shared';
import {assistantApi,ok} from '@/lib/api';
import {useNN} from '@/lib/store';
import {useAssistantOverlayFocus} from '@/lib/assistant-overlay-focus';
import {useT} from '@/lib/i18n';
import {NNBtn} from '../ui';
export function NotebookScopePicker({object,onApply}:{object:AssistantObjectSnapshot;onApply(next:AssistantObjectSnapshot,original:AssistantObjectSnapshot):Promise<void>|void}) {
  const t=useT();const generation=useRef(0);
  const [basis,setBasis]=useState(object);
  useEffect(()=>()=>{generation.current++;},[object.ref.id]);const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(false);
  const popup=useRef<HTMLDivElement>(null);
  const layer = useAssistantOverlayFocus(open,popup,()=>setOpen(false),busy);
  const [sources,setSources]=useState<{id:string;title:string}[]>([]),[selected,setSelected]=useState<string[]>([]),[loaded,setLoaded]=useState(false);
  const load=async()=>{
    const current=++generation.current;setBasis(object);setOpen(true);setLoaded(false);setError(false);const owner=useNN.getState().profile?.userId;
    try {const data=await ok(await assistantApi.notebooks({id:object.ref.id}).sources.get()) as unknown as {items:{id:string;title:string}[]};if(generation.current!==current||useNN.getState().profile?.userId!==owner)return;
      const items=data.items.map(item=>({id:item.id,title:item.title}));setSources(items);
      const prior=object.ref.kind==='notebook'?object.ref.sourceIds:undefined;
      setSelected(prior===undefined?items.map(item=>item.id):prior.filter(id=>items.some(item=>item.id===id)));setLoaded(true);
    }catch{setError(true);}
  };
  const save=async()=>{
    if(busy||!loaded)return;setBusy(true);setError(false);const owner=useNN.getState().profile?.userId;
    try {const data=await ok(await assistantApi.chat.context.resolve.post({refs:[{kind:'notebook',id:basis.ref.id,sourceIds:selected}]}));
      if(useNN.getState().profile?.userId!==owner)return;const next=data.items[0];if(!next)throw new Error('context_unavailable');
      await onApply(next,basis);setOpen(false);
    }catch{setError(true);}finally{setBusy(false);}
  };
  return <><NNBtn size="sm" variant="ghost" icon="filter" ariaLabel={`${t('assistant.chooseNotebookSources')}: ${object.label}`} onClick={()=>void load()} />
    {open&&createPortal(<div ref={popup} tabIndex={-1} className="reomi-notebook-scope-picker" data-assistant-overlay role="dialog" aria-label={t('assistant.chooseNotebookSources')}
      onKeyDown={event=>{if(event.key!=='Tab')event.stopPropagation();}}>
      <strong>{object.label}</strong><p>{t('assistant.chooseNotebookSources')}</p>
      {error&&<p role="alert">{t('assistant.contextFailed')} <NNBtn size="sm" disabled={busy} onClick={()=>void load()}>{t('review.retry')}</NNBtn></p>}
      {loaded?<><div><NNBtn size="sm" disabled={busy} onClick={()=>setSelected(sources.map(source=>source.id))}>{t('assistant.selectAllSources')}</NNBtn>
        <NNBtn size="sm" disabled={busy} onClick={()=>setSelected([])}>{t('assistant.clearSources')}</NNBtn></div>
        <div className="nn-scroll" style={{maxHeight:260,overflowY:'auto'}}>{sources.map(source=><label key={source.id} style={{display:'flex',gap:8,padding:6}}>
          <input type="checkbox" disabled={busy} checked={selected.includes(source.id)} onChange={event=>setSelected(ids=>event.target.checked?[...ids,source.id]:ids.filter(id=>id!==source.id))}/>{source.title}
        </label>)}</div><small>{t('assistant.selectedSources',{count:selected.length})}</small></>:<p>{t('states.loading')}</p>}
      <div><NNBtn size="sm" disabled={busy||!loaded} onClick={()=>void save()}>{t('actions.save')}</NNBtn><NNBtn size="sm" variant="ghost" disabled={busy} onClick={()=>void layer.close()}>{t('actions.cancel')}</NNBtn></div>
    </div>,document.body)}</>;
}
