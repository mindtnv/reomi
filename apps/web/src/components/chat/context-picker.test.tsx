import { ensureTestDom, GlobalRegistrator } from '../../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import type { AssistantObjectSnapshot } from '@reomi/shared';

ensureTestDom();
const {createRoot}=await import('react-dom/client');
const {ContextPicker}=await import('./context-picker');
let root:Root,host:HTMLDivElement;
beforeEach(()=>{ensureTestDom();(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();delete(globalThis as any).IS_REACT_ACT_ENVIRONMENT;});
afterAll(()=>{try{GlobalRegistrator.unregister();}catch{}});
const item=(id:string,label:string):AssistantObjectSnapshot=>({ref:{kind:'card',id},label,available:true});
const waitSearch=()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,170));});

test('late results from an older query or account never replace current choices',async()=>{
  const pending=new Map<string,(value:{items:AssistantObjectSnapshot[];nextCursor:null})=>void>();
  const search=({q}:{q:string})=>new Promise<{items:AssistantObjectSnapshot[];nextCursor:null}>(resolve=>pending.set(q,resolve));
  const render=async(query:string,ownerId:string)=>act(async()=>root.render(<ContextPicker ownerId={ownerId} query={query} search={search} onPick={()=>{}} onClose={()=>{}}/>));
  await render('old','alice');await waitSearch();await render('new','alice');await waitSearch();
  await act(async()=>pending.get('new')!({items:[item('new','Current choice')],nextCursor:null}));
  await act(async()=>pending.get('old')!({items:[item('old','Old private choice')],nextCursor:null}));
  expect(host.textContent).toContain('Current choice');expect(host.textContent).not.toContain('Old private choice');
  await render('bob','bob');expect(host.textContent).not.toContain('Current choice');await waitSearch();
  await act(async()=>pending.get('bob')!({items:[item('bob','Bob choice')],nextCursor:null}));
  expect(host.textContent).toContain('Bob choice');
});

test('keyboard selection works and a failed lookup remains retryable',async()=>{
  let calls=0,picked='';
  const search=async()=>{if(calls++===0)throw new Error('offline');return {items:[item('a','First'),item('b','Second')],nextCursor:null};};
  await act(async()=>root.render(<ContextPicker ownerId="alice" query="" search={search} onPick={value=>{picked=value.ref.id;}} onClose={()=>{}}/>));await waitSearch();
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  await act(async()=>Array.from(host.querySelectorAll('button')).find(b=>b.textContent==='review.retry')!.click());await waitSearch();
  const dialog=host.querySelector('[role="dialog"]')!;
  await act(async()=>dialog.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})));
  await act(async()=>dialog.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})));
  expect(picked).toBe('b');
});

test('Shift+Tab preserves reverse focus navigation instead of accepting a mention', async () => {
  let picked = '';
  await act(async () => root.render(<ContextPicker ownerId="alice" query="" search={async () => ({ items: [item('a', 'First')], nextCursor: null })}
    onPick={value => { picked = value.ref.id; }} onClose={() => {}} />)); await waitSearch();
  const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
  await act(async () => host.querySelector('[role="dialog"]')!.dispatchEvent(event));
  expect(picked).toBe(''); expect(event.defaultPrevented).toBe(false);
});
