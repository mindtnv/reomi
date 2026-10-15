import { ensureTestDom, GlobalRegistrator } from '../../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext, SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { AppNavigationProvider, useWorkspaceState } from '../navigation';
import { NavigationJournal, NAVIGATION_HISTORY_KEY } from '../../lib/navigation-context';
import { DialogProvider } from '../dialog';
import { BASIC_NOTE_TYPE } from '@reomi/shared';
import { cardFromApi } from '../../lib/mappers';
import { useNN } from '../../lib/store';
ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { NNCardsBrowser } = await import('./cards-browser');
let root: Root, host: HTMLDivElement, oldFetch: typeof fetch;
const original={searchCards:useNN.getState().searchCards,getCardTags:useNN.getState().getCardTags};
const router={push(){},replace(){},back(){},forward(){},refresh(){},prefetch(){},hmrRefresh(){},bfcacheId:'test'};
beforeEach(()=>{
  ensureTestDom();(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;oldFetch=globalThis.fetch;
  globalThis.fetch=(async()=>Response.json({items:[]})) as unknown as typeof fetch;
  window.sessionStorage.clear();
  useNN.setState({profile:{userId:'cards-owner'} as any,bootstrapped:true,cards:[],decks:[],noteTypes:[],cardTags:[],getCardTags:async()=>[],searchCards:async()=>({items:[],nextCursor:null})});
  host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();globalThis.fetch=oldFetch;useNN.setState(original);useNN.getState().reset();delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;});
afterAll(()=>{try{GlobalRegistrator.unregister();}catch{}});
test('Cards reload retains the last typed query instead of replacing it with the older URL',async()=>{
  const journal=new NavigationJournal('cards-owner','/cards?q=old',null,window.sessionStorage);
  journal.field('cards','query','saved query');journal.field('cards','sortField','due');journal.field('cards','sortDir','asc');journal.flush();
  window.history.replaceState({[NAVIGATION_HISTORY_KEY]:journal.marker()},'');
  await act(async()=>root.render(<AppRouterContext.Provider value={router}><PathnameContext.Provider value="/cards"><SearchParamsContext.Provider value={new URLSearchParams('q=old')}><AppNavigationProvider><DialogProvider><NNCardsBrowser/></DialogProvider></AppNavigationProvider></SearchParamsContext.Provider></PathnameContext.Provider></AppRouterContext.Provider>));
  expect((host.querySelector('input[aria-label="cards.search.placeholder"]') as HTMLInputElement).value).toBe('saved query');
  expect(host.querySelector('button[aria-label="navigation.reset"]')).not.toBeNull();
});

test('restoring a focused card retains its preview tab without restoring bulk selection',async()=>{
  const card=cardFromApi({id:'card-a',deckId:'deck-a',noteId:'note-a',state:'new',due:'2026-09-22T00:00:00Z',updatedAt:'2026-09-22T00:00:00Z',createdAt:'2026-09-22T00:00:00Z',renderKind:'basic',renderFrontText:'Question',renderBackText:'Answer',note:{id:'note-a',fieldValues:{Front:'Question',Back:'Answer'},tags:[]},noteType:BASIC_NOTE_TYPE} as any);
  useNN.setState({cards:[card],decks:[{id:'deck-a',name:'Deck',color:'lime',createdAt:0} as any],noteTypes:[BASIC_NOTE_TYPE as any]});
  globalThis.fetch=(async(url:any)=>Response.json(String(url).endsWith('/cards/card-a')?{...card,state:'new',due:'2026-09-22T00:00:00Z'}:{items:[]})) as unknown as typeof fetch;
  const journal=new NavigationJournal('cards-owner','/cards',null,sessionStorage);
  journal.field('cards','focusedId','card-a');journal.field('card:card-a','mode','view');journal.flush();
  history.replaceState({[NAVIGATION_HISTORY_KEY]:journal.marker()},'');
  await act(async()=>root.render(<AppRouterContext.Provider value={router}><PathnameContext.Provider value="/cards"><SearchParamsContext.Provider value={new URLSearchParams()}><AppNavigationProvider><DialogProvider><NNCardsBrowser/></DialogProvider></AppNavigationProvider></SearchParamsContext.Provider></PathnameContext.Provider></AppRouterContext.Provider>));
  expect((host.querySelector('.reomi-card-detail-preview') as HTMLElement)?.hidden).toBe(false);
  expect(host.querySelectorAll('input[type="checkbox"]:checked').length).toBe(0);
});

test('switching objects in a mounted panel restores only that object and ignores a late old setter',async()=>{
  let change: ((value:string)=>void)|undefined;
  function Panel({id}:{id:string}) {const [mode,setMode]=useWorkspaceState(`card:${id}`,'mode','edit');change=setMode;return <output>{mode}</output>;}
  async function render(id:string) {await act(async()=>root.render(<AppRouterContext.Provider value={router}><PathnameContext.Provider value="/cards"><SearchParamsContext.Provider value={new URLSearchParams()}><AppNavigationProvider><Panel id={id}/></AppNavigationProvider></SearchParamsContext.Provider></PathnameContext.Provider></AppRouterContext.Provider>));}
  await render('a');await act(async()=>change?.('view'));const late=change;
  await render('b');expect(host.textContent).toBe('edit');
  await act(async()=>late?.('edit'));expect(host.textContent).toBe('edit');
  await render('a');expect(host.textContent).toBe('view');
});

test('a cached inspected card is revalidated on restoration and a deleted card is not resurrected',async()=>{
  const card=cardFromApi({id:'deleted-card',deckId:'deck-a',noteId:'note-a',state:'new',due:'2026-09-22T00:00:00Z',updatedAt:'2026-09-22T00:00:00Z',createdAt:'2026-09-22T00:00:00Z',renderKind:'basic',renderFrontText:'Old question',renderBackText:'Old answer',note:{id:'note-a',fieldValues:{Front:'Old question',Back:'Old answer'},tags:[]},noteType:BASIC_NOTE_TYPE} as any);
  useNN.setState({cards:[card],noteTypes:[BASIC_NOTE_TYPE as any]});
  const journal=new NavigationJournal('cards-owner','/cards',null,sessionStorage);journal.field('cards','focusedId',card.id);journal.flush();history.replaceState({[NAVIGATION_HISTORY_KEY]:journal.marker()},'');
  let checked=false;globalThis.fetch=(async(url:any)=>{if(String(url).endsWith('/cards/deleted-card')){checked=true;return Response.json({error:'not_found'},{status:404});}return Response.json({items:[]});}) as unknown as typeof fetch;
  await act(async()=>root.render(<AppRouterContext.Provider value={router}><PathnameContext.Provider value="/cards"><SearchParamsContext.Provider value={new URLSearchParams()}><AppNavigationProvider><DialogProvider><NNCardsBrowser/></DialogProvider></AppNavigationProvider></SearchParamsContext.Provider></PathnameContext.Provider></AppRouterContext.Provider>));
  expect(checked).toBe(true);expect(host.querySelector('.reomi-card-detail')).toBeNull();expect(host.textContent).toContain('editor.errors.notFound');
});
