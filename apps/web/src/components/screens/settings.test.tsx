import { ensureTestDom, GlobalRegistrator } from '../../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, expect, test, spyOn } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { AppNavigationProvider } from '../navigation';
import { DialogProvider } from '../dialog';
import { I18nProvider } from '../../lib/i18n';
import * as auth from '../../lib/auth';
import { useNN } from '../../lib/store';
import { profileFromApi } from '../../lib/mappers';
import { clearSessionResourceCache } from '../../lib/session-resource';

ensureTestDom();
const { createRoot }=await import('react-dom/client');
const { NNSettings }=await import('./settings');
let root:Root, container:HTMLDivElement, originalFetch:typeof fetch;
const originalUpdate=useNN.getState().updateProfile;
const originalAddPreset=useNN.getState().addPreset;
const router={bfcacheId:'test',push(){},replace(){},back(){},forward(){},refresh(){},prefetch(){},hmrRefresh(){}};
let writes: any[];
let sessionSpy: ReturnType<typeof spyOn>;
beforeEach(()=>{
  ensureTestDom(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  sessionSpy=spyOn(auth,'useSession').mockReturnValue({data:null,isPending:false,error:null,refetch:async()=>{}} as any);
  clearSessionResourceCache(); localStorage.removeItem('reomi:locale'); localStorage.setItem('nn:locale','en');
  originalFetch=globalThis.fetch; writes=[];
  globalThis.fetch=(async(url:any)=>Response.json(String(url).includes('/ai/status') ? {chatEnabled:true,embeddingEnabled:false,notebooksEnabled:true,webSearchEnabled:false,visionEnabled:true,chatModel:'test-model'} : null)) as typeof fetch;
  useNN.setState({profile:profileFromApi({userId:'settings-user',name:'Dev',desiredRetention:.9,dailyGoalMinutes:15}),bootstrapped:true,presets:[],decks:[],
    updateProfile:async patch=>{writes.push(patch);useNN.setState({profile:{...useNN.getState().profile!,...patch}});}});
  container=document.createElement('div');document.body.appendChild(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();sessionSpy.mockRestore();globalThis.fetch=originalFetch;useNN.getState().reset();useNN.setState({updateProfile:originalUpdate,addPreset:originalAddPreset});delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;});
afterAll(()=>GlobalRegistrator.unregister());
async function render(){await act(async()=>root.render(<AppRouterContext.Provider value={router}><PathnameContext.Provider value="/settings"><I18nProvider><AppNavigationProvider><DialogProvider><NNSettings/></DialogProvider></AppNavigationProvider></I18nProvider></PathnameContext.Provider></AppRouterContext.Provider>));}
async function tab(id:string){await act(async()=>container.querySelector<HTMLButtonElement>(`#settings-tab-${id}`)!.click());}
async function input(selector:string,value:string){const field=container.querySelector<HTMLInputElement>(selector)!;await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(field,value);field.dispatchEvent(new Event('input',{bubbles:true}));});return field;}
async function blur(field:HTMLElement){await act(async()=>field.dispatchEvent(new FocusEvent('focusout',{bubbles:true})));}

test('settings tabs support vertical keyboard navigation and retain separate destructive controls',async()=>{
  await render();
  expect(container.querySelectorAll('[role="tab"]')).toHaveLength(6);
  await act(async()=>container.querySelector('#settings-tab-general')!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true})));
  expect(container.querySelector('#settings-tab-appearance')?.getAttribute('aria-selected')).toBe('true');
  expect(document.activeElement?.id).toBe('settings-tab-appearance');
  expect(container.querySelectorAll('.reomi-theme-option').length).toBeGreaterThan(30);
  await tab('data');
  expect(container.querySelector('details.reomi-settings-delete-details')?.hasAttribute('open')).toBe(false);
  const remove=Array.from(container.querySelectorAll<HTMLButtonElement>('.reomi-settings-danger button')).find(b=>b.textContent?.includes('Delete account'))!;
  expect(remove.disabled).toBe(true);
});

test('a failed name save remains retryable after another setting saves successfully',async()=>{
  let rejectName=true;
  useNN.setState({updateProfile:async patch=>{writes.push(patch);if(patch.name&&rejectName)throw new Error('offline');useNN.setState({profile:{...useNN.getState().profile!,...patch}});}});
  await render();
  const name=await input('input[aria-label="Name"]','New name');await blur(name);
  expect(container.querySelector('.reomi-settings-save-state[role="alert"]')).not.toBeNull();
  await act(async()=>Array.from(container.querySelectorAll<HTMLButtonElement>('[role="radio"]')).find(b=>b.textContent==='30 min')!.click());
  expect(useNN.getState().profile?.dailyGoalMinutes).toBe(30);
  expect(container.querySelector('.reomi-settings-save-state[role="alert"]')).not.toBeNull();
  rejectName=false;
  await act(async()=>container.querySelector<HTMLButtonElement>('.reomi-settings-save-state button')!.click());
  expect(useNN.getState().profile?.name).toBe('New name');
  expect(container.querySelector('.reomi-settings-save-state')?.textContent).toContain('Changes saved');
});

test('a late response does not overwrite a newer unsaved name draft',async()=>{
  let resolve!:()=>void;
  useNN.setState({updateProfile:async patch=>{await new Promise<void>(r=>resolve=r);useNN.setState({profile:{...useNN.getState().profile!,...patch}});}});
  await render();
  const name=await input('input[aria-label="Name"]','First');await blur(name);
  await input('input[aria-label="Name"]','Still typing');
  await act(async()=>resolve());
  expect((container.querySelector('input[aria-label="Name"]') as HTMLInputElement).value).toBe('Still typing');
});

test('retention saves changes made with the keyboard',async()=>{
  await render();await tab('learning');
  const range=await input('input[type="range"]','94');
  await act(async()=>range.dispatchEvent(new KeyboardEvent('keyup',{key:'ArrowRight',bubbles:true})));
  expect(writes).toEqual([{desiredRetention:.94}]);
  expect(container.querySelector('.reomi-settings-range')?.getAttribute('aria-valuetext')).toBe('94%');
});

test('invalid preset values are blocked without submitting',async()=>{
  let requests=0;useNN.setState({addPreset:async()=>{requests++;return {} as any;}});
  await render();await tab('learning');
  await act(async()=>Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent==='New preset')!.click());
  const form=container.querySelector<HTMLFormElement>('.reomi-settings-preset-form')!;
  await act(async()=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
  expect(requests).toBe(0);expect(form.querySelector('[role="alert"]')).not.toBeNull();
  for(const label of form.querySelectorAll<HTMLLabelElement>('label')) if(label.htmlFor) expect(container.querySelector(`#${CSS.escape(label.htmlFor)}`)).not.toBeNull();
});

test('personal-token form sends one request on repeated submit and retains the one-time result',async()=>{
  sessionSpy.mockReturnValue({data:{user:{id:'settings-user',email:'test@example.test'}},isPending:false,error:null,refetch:async()=>{}} as any);
  let requests=0,resolve!:(response:Response)=>void;
  const fallback=globalThis.fetch;
  globalThis.fetch=(async(url:any,init?:RequestInit)=>{
    if(String(url).endsWith('/profile/tokens')) {
      if(init?.method==='POST'){requests++;return new Promise<Response>(r=>resolve=r);}
      return Response.json([]);
    }
    return fallback(url,init);
  }) as typeof fetch;
  await render();await tab('connections');
  expect(container.textContent).toContain('codex mcp add reomi');
  expect(container.textContent).toContain('REOMI_MCP_TOKEN');
  expect(container.textContent).not.toMatch(/nn_pat_/);
  await input('.reomi-mcp-create input','Test integration');
  const form=container.querySelector('.reomi-mcp-create')!;
  await act(async()=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
  expect(requests).toBe(1);
  await act(async()=>resolve(Response.json({token:'test-only-token',item:{id:'test-token',name:'Test integration',scope:'read',prefix:'test',expiresAt:'2030-01-01',lastUsedAt:null,revokedAt:null}})));
  expect(container.querySelector('.reomi-mcp-settings [role="status"]')?.textContent).toContain('test-only-token');
  expect(container.querySelector<HTMLButtonElement>('.reomi-mcp-create button[type="submit"]')?.disabled).toBe(true);
});

test('late profile response cannot restore a signed-out account',async()=>{
  let resolve!:(response:Response)=>void;
  let started!:()=>void;
  const requestStarted=new Promise<void>(r=>started=r);
  globalThis.fetch=(async()=>{started();return new Promise<Response>(r=>resolve=r);}) as unknown as typeof fetch;
  const request=originalUpdate({name:'Old account response'});
  await requestStarted;
  useNN.getState().reset();
  resolve(Response.json({userId:'settings-user',name:'Old account response'}));
  await request;
  expect(useNN.getState().profile).toBeNull();
});
