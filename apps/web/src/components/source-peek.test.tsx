import { ensureTestDom, GlobalRegistrator } from '../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { useNN } from '../lib/store';
import { cardSourceHref } from '../lib/card-source-link';
import type { CardSourceLink } from '../lib/types';
ensureTestDom();const {createRoot}=await import('react-dom/client');const {SourcePeekPanel}=await import('./source-peek');
let root:Root,host:HTMLDivElement;const original=useNN.getState().getSourceChunks;
beforeEach(()=>{ensureTestDom();(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();useNN.setState({getSourceChunks:original});delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;});
afterAll(()=>{try{GlobalRegistrator.unregister();}catch{}});
const item={id:'link',sourceId:'book',sourceChunkId:'original',sourceTitle:'Original book',position:0,page:3,snippet:'Saved quote',locationAvailable:true} as CardSourceLink;
test('a stale location never uses its former position as an exact source link',()=>{
  expect(cardSourceHref({...item,locationAvailable:false})).toBe('/library/book');
  expect(cardSourceHref({...item,sourceId:null})).toBeNull();
  expect(cardSourceHref(item)).toBe('/library/book?chunk=original&pos=0&page=3');
  expect(cardSourceHref({
    ...item,
    sourceKind: 'youtube',
    sourceUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    startSeconds: 12,
    locationAvailable: false,
  })).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12');
});
test('the reviewer keeps its quote when a different chunk occupies the old position',async()=>{
  useNN.setState({getSourceChunks:async()=>({items:[{id:'replacement',position:0,text:'Unrelated replacement'}],total:1,nextFrom:null}) as any});
  await act(async()=>root.render(<SourcePeekPanel item={item}/>));
  const expand=Array.from(host.querySelectorAll('button')).find(button=>button.textContent==='review.peek.expand')!;
  await act(async()=>expand.click());
  expect(host.textContent).toContain('Saved quote');expect(host.textContent).not.toContain('Unrelated replacement');expect(host.textContent).toContain('assistant.anchorUnavailable');
});
