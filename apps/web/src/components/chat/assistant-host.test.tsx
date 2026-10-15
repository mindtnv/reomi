import { ensureTestDom, GlobalRegistrator } from '../../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act, useEffect } from 'react';
import type { Root } from 'react-dom/client';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext, SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { AppNavigationProvider } from '../navigation';
import { DialogProvider } from '../dialog';
import { useNN } from '../../lib/store';
import type { AssistantController, AssistantTransport } from '../../lib/assistant-controller';
import type { ChatStreamHandlers } from '../../lib/chat-stream';
import { hasBlockingReviewOverlay } from '../../lib/review-interactions';

ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { AssistantProvider, useAssistant, useAssistantPageContext } = await import('./assistant-provider');
const { AssistantHost } = await import('./assistant-host');
const { AssistantPageEntry, NotebookAssistantEntry } = await import('./assistant-entry');
let root: Root, host: HTMLDivElement, previousFetch: typeof fetch, controller: AssistantController;
let callbacks: ChatStreamHandlers, signal: AbortSignal | undefined, finish: (() => void) | undefined;
let policySelection:string|undefined;
let pageCard: string | null = null;
let pageKind: 'card' | 'deck' = 'card';
let legacy=false;
let models:{id:string;label:string;default:boolean}[]=[];
const originalWidth = window.innerWidth, originalHeight = window.innerHeight;
const router = { bfcacheId: 'test', push() {}, replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {}, hmrRefresh() {} };
const statusLoader = async () => ({ chatEnabled:true, models, assistant:legacy?undefined:{ contextVersion:1,objectSearch:true,maxConcurrentTurns:3,sourceStudy:false } });
const transport: AssistantTransport = {
  create: async context => ({ id:'thread',title:'Test conversation',updatedAt:new Date().toISOString(),contextVersion:1,context:{...context,refs:[],revision:0} }),
  load: async id => ({ conversation:{id,title:'Test conversation',updatedAt:new Date().toISOString()},messages:[] }),
  stream: async (_id,_content,handlers,options) => { callbacks=handlers;signal=options.signal;policySelection=options.policySelection;await new Promise<void>(resolve=>{finish=resolve;options.signal?.addEventListener('abort',()=>resolve(),{once:true});}); },
  resume:async()=>{},regenerate:async()=>{},
};
const factory=()=>transport;
function Capture(){useAssistantPageContext(pageCard ? { kind: pageKind, id: pageCard } : null);const a=useAssistant();useEffect(()=>{controller=a.controller;},[a.controller]);return null;}
beforeEach(()=>{
  ensureTestDom(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
  legacy=false;models=[];pageCard=null;pageKind='card';
  Object.defineProperty(window,'innerWidth',{value:1200,writable:true,configurable:true});Object.defineProperty(window,'innerHeight',{value:900,writable:true,configurable:true});
  localStorage.removeItem('nn:assistant:drafts:v1:alice');localStorage.removeItem('nn:assistant:drafts:v1:bob');
  localStorage.removeItem('reomi:assistant:drafts:v1:alice');localStorage.removeItem('reomi:assistant:drafts:v1:bob');
  localStorage.removeItem('reomi:assistant:window');localStorage.removeItem('reomi:chat:rail-width');
  previousFetch=globalThis.fetch;globalThis.fetch=(async()=>Response.json({items:[],nextCursor:null})) as unknown as typeof fetch;
  useNN.setState({profile:{userId:'alice'} as any,cards:[],decks:[]});
  host=document.createElement('div');document.body.appendChild(host);root=createRoot(host);
});
afterEach(async()=>{finish?.();await act(async()=>root.unmount());host.remove();globalThis.fetch=previousFetch;useNN.getState().reset();window.innerWidth=originalWidth;window.innerHeight=originalHeight;delete(globalThis as any).IS_REACT_ACT_ENVIRONMENT;});
afterAll(()=>{try{GlobalRegistrator.unregister();}catch{}});
async function render(page=false,thread?:string,notebook=false){await act(async()=>root.render(<AppRouterContext.Provider value={router}><PathnameContext.Provider value={page?'/chat':'/library/book'}><SearchParamsContext.Provider value={new URLSearchParams(thread?{thread}:{})}><AppNavigationProvider><DialogProvider>
  <AssistantProvider transportFactory={factory} statusLoader={statusLoader}><Capture/>{notebook?<NotebookAssistantEntry mode="notebook" notebookId="01900000-0000-7000-8000-000000000001" activeThreadId={thread}/>:page?<AssistantPageEntry/>:<div className="reader-marker" style={{height:200,overflow:'auto'}}><div style={{height:1000}}>Book content</div></div>}<AssistantHost/></AssistantProvider>
</DialogProvider></AppNavigationProvider></SearchParamsContext.Provider></PathnameContext.Provider></AppRouterContext.Provider>));}
const button=(label:string)=>document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

test('minimizing during a response keeps the stream and restores the same transcript',async()=>{
  await render();await act(async()=>button('assistant.open').click());
  const key=controller!.getSnapshot().selectedKey!;let pending!:Promise<void>;
  await act(async()=>{controller.setDraft(key,'Question');pending=controller.send(key);await new Promise(resolve=>setTimeout(resolve,0));callbacks.onToken?.('A live answer');});
  expect(document.body.textContent).toContain('A live answer');
  await act(async()=>button('assistant.minimize').click());expect(signal?.aborted).toBe(false);
  expect(document.querySelector('[data-assistant-root]')).toBeNull();
  await act(async()=>button('assistant.open').click());expect(document.body.textContent).toContain('A live answer');
  await act(async()=>{callbacks.onDone?.('answer');finish?.();await pending;});
});

test('expanding the window uses one composer and preserves the selected session',async()=>{
  await render();await act(async()=>button('assistant.open').click());
  const key=controller!.getSnapshot().selectedKey!;await act(async()=>controller.setDraft(key,'Persistent draft'));
  await act(async()=>button('assistant.expand').click());await render(true);
  expect(document.querySelectorAll('[data-assistant-composer]')).toHaveLength(1);
  expect((document.querySelector('[data-assistant-composer]') as HTMLTextAreaElement).value).toBe('Persistent draft');
  expect(controller.getSnapshot().selectedKey).toBe(key);
});

test('mobile close restores underlying reading position and assistant keys do not reach study shortcuts',async()=>{
  await render();const reader=host.querySelector('.reader-marker') as HTMLElement;reader.scrollTop=123;
  await act(async()=>{window.innerWidth=390;window.dispatchEvent(new Event('resize'));button('assistant.open').click();});
  const dialog=document.querySelector('[data-assistant-root]')!;expect(dialog.getAttribute('aria-modal')).toBe('true');
  let grades=0;const shortcut=()=>grades++;window.addEventListener('keydown',shortcut);
  try{await act(async()=>document.querySelector('[data-assistant-composer]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'1',bubbles:true})));expect(grades).toBe(0);}finally{window.removeEventListener('keydown',shortcut);}
  await act(async()=>button('actions.back').click());
  expect(host.querySelector('.reader-marker')).toBe(reader);expect(reader.scrollTop).toBe(123);
  expect(document.querySelector('[data-assistant-root]')).toBeNull();
  expect(document.activeElement).toBe(button('assistant.open'));
});

test('desktop assistant does not globally disable review keys; mobile and confirmation dialogs do',()=>{
  const overlay=document.createElement('div');overlay.setAttribute('role','dialog');overlay.setAttribute('data-assistant-root','');document.body.appendChild(overlay);
  try{
    expect(hasBlockingReviewOverlay(document,false)).toBe(false);
    const picker=document.createElement('div');picker.setAttribute('role','dialog');picker.setAttribute('data-assistant-overlay','');overlay.appendChild(picker);
    expect(hasBlockingReviewOverlay(document,false)).toBe(false);
    overlay.setAttribute('aria-modal','true');expect(hasBlockingReviewOverlay(document,false)).toBe(true);
    overlay.removeAttribute('aria-modal');picker.removeAttribute('data-assistant-overlay');expect(hasBlockingReviewOverlay(document,false)).toBe(true);
  }finally{overlay.remove();}
});

test('keyboard window controls work, and Escape closes a picker before the assistant',async()=>{
  models=[{id:'fast',label:'Fast',default:true},{id:'deep',label:'Deep',default:false}];
  await render();await act(async()=>button('assistant.open').click());
  const dialog=document.querySelector<HTMLElement>('[data-assistant-root]')!,left=parseFloat(dialog.style.left),width=parseFloat(dialog.style.width);
  await act(async()=>document.querySelector('[aria-label="assistant.moveWindow"]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true})));
  expect(parseFloat(dialog.style.left)).toBe(left-16);
  await act(async()=>document.querySelector('[aria-label="assistant.resizeWindow"]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true})));
  expect(parseFloat(dialog.style.width)).toBe(width+16);
  await act(async()=>button('chat.composer.model').click());
  const menu=document.querySelector('[role="menu"]')!;expect(menu).not.toBeNull();
  await act(async()=>menu.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
  expect(document.querySelector('[role="menu"]')).toBeNull();expect(document.querySelector('[data-assistant-root]')).not.toBeNull();
});

test('older API capabilities disable context controls without dropping the draft',async()=>{
  legacy=true;await render();await act(async()=>button('assistant.open').click());
  const key=controller!.getSnapshot().selectedKey!;await act(async()=>controller.setDraft(key,'Keep until the server is ready'));
  expect(button('assistant.addContext').disabled).toBe(true);expect(button('assistant.send').disabled).toBe(true);
  expect(document.body.textContent).toContain('assistant.errors.context_unsupported');
  expect((document.querySelector('[data-assistant-composer]') as HTMLTextAreaElement).value).toBe('Keep until the server is ready');
});

test('global and notebook links open the requested identity even outside the loaded thread page',async()=>{
  await render(true,'old-global-thread');
  expect(controller!.getSnapshot().sessions[controller.getSnapshot().selectedKey!]!.conversationId).toBe('old-global-thread');
  await render(false,'old-notebook-thread',true);
  expect(controller.getSnapshot().sessions[controller.getSnapshot().selectedKey!]!.conversationId).toBe('old-notebook-thread');
  expect(document.querySelectorAll('[data-assistant-composer]')).toHaveLength(1);
});

test('saving a source answer keeps its original destination after composer context changes', async () => {
  await render();
  const sourceId = '01900000-0000-7000-8000-000000000001';
  let key!: string, sending!: Promise<void>;
  await act(async () => {
    key = controller.newConversation([{ ref: { kind: 'source', id: sourceId }, label: 'Original book', available: true }]);
    controller.setPresentation('floating'); controller.setDraft(key, 'Explain the book');
    sending = controller.send(key); await new Promise(resolve => setTimeout(resolve, 0));
    callbacks.onToken?.('An answer worth keeping'); callbacks.onDone?.('01900000-0000-7000-8000-000000000099'); finish?.(); await sending;
    controller.setRefs(key, [{ ref: { kind: 'source', id: '01900000-0000-7000-8000-000000000002' }, label: 'Different book', available: true }]);
  });
  const requests: { url: string; body: any }[] = [];
  globalThis.fetch = (async (url: any, init: any) => { requests.push({ url: String(url), body: JSON.parse(init.body) }); return Response.json({ id: 'saved' }); }) as typeof fetch;
  await act(async () => { button('notebooks.notes.saveAnswer').click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(requests).toHaveLength(1);
  expect(requests[0]!.url).toContain(`/sources/${sourceId}/notes`);
  expect(requests[0]!.body).toMatchObject({ content: 'An answer worth keeping', kind: 'answer', messageId: '01900000-0000-7000-8000-000000000099' });
});


test('an ambiguous policy request preserves its draft and can be resent with an explicit choice', async () => {
  await render();let key!:string,sending!:Promise<void>;
  await act(async()=>{key=controller.newConversation();controller.setPresentation('floating');controller.setDraft(key,'Only appropriate sources');sending=controller.send(key);await new Promise(resolve=>setTimeout(resolve,0));});
  await act(async()=>{callbacks.onError?.('context_policy_selection_required',{status:400} as any);finish?.();await sending;});
  expect(controller.getSnapshot().sessions[key]!.draft).toBe('Only appropriate sources');
  const choice=Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='assistant.onlyMaterials')!;
  await act(async()=>{choice.click();await new Promise(resolve=>setTimeout(resolve,0));});
  expect(policySelection).toBe('strict');
  await act(async()=>{callbacks.onContext?.({version:1,revision:1,policy:'strict',refs:[],sourceIds:[],deckIds:[]});callbacks.onDone?.('answer');finish?.();await new Promise(resolve=>setTimeout(resolve,0));});
  expect(controller.getSnapshot().sessions[key]!.policy).toBe('strict');
});

test('pending confirmation controls become read-only when context protocol support disappears',async()=>{
  await render();let key!:string,sending!:Promise<void>;
  await act(async()=>{key=controller.newConversation();controller.setPresentation('floating');controller.setDraft(key,'Create a deck');sending=controller.send(key);await new Promise(resolve=>setTimeout(resolve,0));});
  await act(async()=>{callbacks.onAwaitConfirmation?.({toolCall:{id:'pending-write',name:'create_deck',args:{name:'Deck'}}});finish?.();await sending;controller.setContextVersion(0);});
  const controls=document.querySelector('fieldset.reomi-confirm-content') as HTMLFieldSetElement;
  expect(controls).not.toBeNull();expect(controls.disabled).toBe(true);
  expect(controls.querySelector('textarea')?.getAttribute('aria-label')).toBe('chat.confirm.feedbackPlaceholder');
  expect(controller.getSnapshot().sessions[key]!.messages.at(-1)!.toolCalls![0]!.decision).toBeUndefined();
});

test('mobile assistant follows the visible viewport when the keyboard pans the page', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(window, 'visualViewport');
  const visual = Object.assign(new EventTarget(), { height: 430, offsetTop: 110 });
  Object.defineProperty(window, 'visualViewport', { configurable: true, value: visual });
  window.innerWidth = 390;
  try {
    await render(); await act(async () => button('assistant.open').click());
    const dialog = document.querySelector<HTMLElement>('[data-assistant-root]')!;
    expect(dialog.style.height).toBe('430px');
    expect(dialog.style.top).toBe('110px');
    const key = controller.getSnapshot().selectedKey!;
    await act(async () => {
      controller.setDraft(key, 'Keyboard draft');
      visual.offsetTop = 160; visual.dispatchEvent(new Event('scroll'));
    });
    expect(dialog.style.top).toBe('160px');
    await act(async () => {
      visual.height = 844; visual.offsetTop = 0; visual.dispatchEvent(new Event('resize'));
    });
    expect(dialog.style.height).toBe('844px'); expect(dialog.style.top).toBe('0px');
    expect((document.querySelector('[data-assistant-composer]') as HTMLTextAreaElement).value).toBe('Keyboard draft');
  } finally {
    if (descriptor) Object.defineProperty(window, 'visualViewport', descriptor);
    else delete (window as any).visualViewport;
  }
});

test('mobile context inspection receives focus, participates in Tab cycling, and Escape restores its trigger', async () => {
  window.innerWidth = 390;
  await render();
  await act(async () => {
    controller.newConversation([{ ref: { kind: 'card', id: '01900000-0000-7000-8000-000000000001' }, label: 'Context card', available: true }]);
    controller.setPresentation('floating'); await new Promise(resolve => setTimeout(resolve, 20));
  });
  await act(async () => button('assistant.addContext').click());
  const trigger = button('assistant.inspectContext');
  await act(async () => { trigger.focus(); trigger.click(); });
  const overlay = document.querySelector<HTMLElement>('[data-assistant-overlay][aria-label="assistant.inspectContext"]')!;
  const close = overlay.querySelector<HTMLButtonElement>('button')!;
  expect(document.activeElement).toBe(close);
  const back = button('actions.back');
  back.getClientRects = close.getClientRects = (() => [{ width: 30, height: 30 }]) as any;
  await act(async () => close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(back);
  await act(async () => back.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })));
  expect(document.activeElement).toBe(close);
  await act(async () => close.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  expect(document.querySelector('[data-assistant-overlay][aria-label="assistant.inspectContext"]')).toBeNull();
  expect(document.querySelector('[data-assistant-root]')).not.toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test('installed-window titlebar geometry constrains restored and moved assistant windows', async () => {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, 'windowControlsOverlay');
  const saved = localStorage.getItem('nn:assistant:window');
  let height = 32;
  const overlay = Object.assign(new EventTarget(), { visible: true, getTitlebarAreaRect: () => ({ x: 70, y: 0, width: 1100, height }) });
  Object.defineProperty(navigator, 'windowControlsOverlay', { configurable: true, value: overlay });
  localStorage.removeItem('reomi:assistant:window');
  localStorage.setItem('nn:assistant:window', JSON.stringify({ version: 1, x: 12, y: 12, width: 440, height: 620 }));
  try {
    await render(); await act(async () => button('assistant.open').click());
    const dialog = document.querySelector<HTMLElement>('[data-assistant-root]')!;
    expect(dialog.style.top).toBe('44px');
    await act(async () => { height = 48; overlay.dispatchEvent(new Event('geometrychange')); });
    expect(dialog.style.top).toBe('60px');
  } finally {
    if (descriptor) Object.defineProperty(navigator, 'windowControlsOverlay', descriptor); else delete (navigator as any).windowControlsOverlay;
    localStorage.removeItem('reomi:assistant:window');
    if (saved === null) localStorage.removeItem('nn:assistant:window'); else localStorage.setItem('nn:assistant:window', saved);
  }
});

test('focus cycling excludes disabled confirmation fieldsets and programmatic-only controls', async () => {
  const { assistantFocusControls } = await import('../../lib/assistant-overlay-focus');
  const panel = document.createElement('div');
  panel.innerHTML = '<button>Enabled</button><fieldset disabled><button tabindex="0">Blocked</button></fieldset><button tabindex="-1">Skipped</button>';
  host.appendChild(panel);
  for (const element of panel.querySelectorAll<HTMLElement>('button')) element.getClientRects = (() => [{ width: 30, height: 30 }]) as any;
  expect(assistantFocusControls(panel).map(element => element.textContent)).toEqual(['Enabled']);
});

test('Escape from the composer minimizes only the floating assistant and preserves its draft', async () => {
  await render(); await act(async () => button('assistant.open').click());
  const key = controller.getSnapshot().selectedKey!;
  await act(async () => controller.setDraft(key, 'Keep this draft'));
  let underlyingEscape = 0;
  const listener = () => { underlyingEscape++; }; window.addEventListener('keydown', listener);
  try {
    await act(async () => document.querySelector('[data-assistant-composer]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    expect(controller.getSnapshot().presentation).toBe('hidden');
    expect(controller.getSnapshot().sessions[key]!.draft).toBe('Keep this draft');
    expect(underlyingEscape).toBe(0);
  } finally { window.removeEventListener('keydown', listener); }
});


test('launcher, window controls, composer and context chips expose accessible names', async () => {
  await render();
  expect(button('assistant.open')).not.toBeNull();
  await act(async () => button('assistant.open').click());
  const key = controller.getSnapshot().selectedKey!;
  await act(async () => controller.setRefs(key, [{ ref: { kind: 'card', id: '01900000-0000-7000-8000-000000000001' }, label: 'Named card', available: true }]));
  for (const label of ['assistant.moveWindow', 'assistant.resizeWindow', 'assistant.expand', 'assistant.resetWindow', 'assistant.minimize', 'assistant.addContext', 'assistant.send']) {
    expect(document.querySelector(`button[aria-label="${label}"], [role="button"][aria-label="${label}"]`)).not.toBeNull();
  }
  expect(document.querySelector('[data-assistant-composer]')?.getAttribute('aria-label')).toBeTruthy();
  expect(document.querySelector('.reomi-assistant-pins')).toBeNull();
  expect(document.querySelector('.reomi-assistant-composer-scope')).toBeNull();
  expect(button('assistant.addContext').textContent).toBe('@');
  await act(async () => button('assistant.addContext').click());
  const namedCard = Array.from(document.querySelectorAll('button')).find(element => element.textContent?.includes('Named card'));
  expect(namedCard).toBeDefined();
  for (const element of document.querySelectorAll('[data-assistant-root] button')) {
    expect((element.getAttribute('aria-label') || element.textContent || '').trim().length).toBeGreaterThan(0);
  }
});


test('page launches reuse their own context and preserve previous contextual conversations', async () => {
  const first = '01900000-0000-7000-8000-000000000001';
  const second = '01900000-0000-7000-8000-000000000002';
  const resolved: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/chat/context/resolve')) {
      const id = JSON.parse(String(init?.body)).refs[0].id;
      resolved.push(id);
      return Response.json({ items: [{ ref: { kind: 'card', id }, label: id === first ? 'Deadlock' : 'Next card', available: true }] });
    }
    return Response.json({ items: [], nextCursor: null });
  }) as typeof fetch;
  pageCard = first; await render();
  await act(async () => { button('assistant.open').click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  const key = controller.getSnapshot().selectedKey!;
  expect(controller.getSnapshot().sessions[key]!.pins[0]!.ref).toEqual({ kind: 'card', id: first });
  expect(document.body.textContent).toContain('assistant.cardStartTitle');
  await act(async () => button('assistant.minimize').click());
  await act(async () => { button('assistant.open').click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(controller.getSnapshot().sessions[key]!.refs).toEqual([]);
  await act(async () => button('assistant.minimize').click());
  pageCard = second; await render();
  expect(controller.getSnapshot().sessions[key]!.pins[0]!.ref.id).toBe(first);
  await act(async () => { button('assistant.open').click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(controller.getSnapshot().selectedKey).not.toBe(key);
  expect(controller.getSnapshot().sessions[controller.getSnapshot().selectedKey!]!.pins[0]!.ref.id).toBe(second);
  expect(controller.getSnapshot().sessions[key]!.pins[0]!.ref.id).toBe(first);
  expect(resolved).toEqual([first, second]);
});


test('a chat deep link waits for the account instead of loading an unauthenticated conversation', async () => {
  const previousLoad = transport.load;
  const loaded: string[] = [];
  transport.load = async id => { loaded.push(id); return previousLoad(id); };
  try {
    useNN.setState({ profile: undefined as any });
    await render(true, 'waiting-thread');
    expect(loaded).toEqual([]);
    expect(document.querySelector('.reomi-assistant-page-entry')?.getAttribute('aria-busy')).toBe('true');
    await act(async () => useNN.setState({ profile: { userId: 'alice' } as any }));
    expect(loaded).toEqual(['waiting-thread']);
  } finally { transport.load = previousLoad; }
});


test('chat rail and wrapper resize together even with a long draft, with headers inside their columns', async () => {
  const saved = localStorage.getItem('nn:chat:rail-width');
  localStorage.removeItem('nn:chat:rail-width');
  localStorage.removeItem('reomi:chat:rail-width');
  try {
    await render(true);
    await act(async () => controller.newConversation([{ ref: { kind: 'card', id: '01900000-0000-7000-8000-000000000001' }, label: 'A very long material title '.repeat(12), available: true }]));
    const wrapper = host.querySelector<HTMLElement>('.reomi-assistant-page > .reomi-assistant-threads')!;
    const rail = wrapper.querySelector<HTMLElement>('.reomi-thread-rail')!;
    const handle = wrapper.querySelector('[role="separator"]')!;
    expect(wrapper.style.width).toBe('280px');
    await act(async () => handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
    expect(wrapper.style.width).toBe('420px'); expect(rail.style.width).toBe('420px');
    await act(async () => handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
    expect(wrapper.style.width).toBe('220px'); expect(rail.style.width).toBe('220px');
    expect(host.querySelector('.reomi-assistant-main > .reomi-assistant-page-toolbar')).not.toBeNull();
    expect(wrapper.querySelector('.reomi-thread-rail-header')).not.toBeNull();
    expect(wrapper.querySelector('.reomi-assistant-thread-filters')).toBeNull();
  } finally { localStorage.removeItem('reomi:chat:rail-width'); if (saved === null) localStorage.removeItem('nn:chat:rail-width'); else localStorage.setItem('nn:chat:rail-width', saved); }
});


test('initial window placement uses the real viewport, not the provisional hydration bounds', async () => {
  const saved = localStorage.getItem('nn:assistant:window'); localStorage.removeItem('nn:assistant:window'); localStorage.removeItem('reomi:assistant:window');
  window.innerWidth = 1728; window.innerHeight = 998;
  try {
    await render(); await act(async () => button('assistant.open').click());
    const windowElement = document.querySelector<HTMLElement>('[data-assistant-root]')!;
    expect(windowElement.style.left).toBe('1304px'); expect(windowElement.style.top).toBe('434px');
    expect(document.querySelector('.reomi-assistant-conversation-bar')).toBeNull();
    expect(button('chat.threads.title').closest('.reomi-assistant-window-header')).not.toBeNull();
  } finally { if(saved===null)localStorage.removeItem('nn:assistant:window');else localStorage.setItem('nn:assistant:window',saved); }
});

test('an open assistant follows card to deck navigation without retaining the card in the new draft', async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if(String(input).includes('/chat/context/resolve')) {
      const ref=JSON.parse(String(init?.body)).refs[0];
      return Response.json({items:[{ref,label:ref.kind==='deck'?'Architecture':'Heap',available:true}]});
    }
    return Response.json({items:[],nextCursor:null});
  }) as typeof fetch;
  pageCard='01900000-0000-7000-8000-000000000001'; await render();
  await act(async()=>{button('assistant.open').click();await new Promise(resolve=>setTimeout(resolve,0));});
  const oldKey=controller.getSnapshot().selectedKey!;
  await act(async()=>controller.setDraft(oldKey,'Keep this card draft'));
  pageKind='deck';pageCard='01900000-0000-7000-8000-000000000002';await render();
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});
  const next=controller.getSnapshot().sessions[controller.getSnapshot().selectedKey!]!;
  expect(next.key).not.toBe(oldKey);expect(next.pins.map(item=>item.ref)).toEqual([{kind:'deck',id:pageCard}]);
  expect(controller.getSnapshot().sessions[oldKey]!.draft).toBe('Keep this card draft');
  pageKind='card';pageCard='01900000-0000-7000-8000-000000000001';await render();
  expect(controller.getSnapshot().selectedKey).toBe(oldKey);
});


test('late page context cannot overwrite a newer screen and sending waits for resolution', async () => {
  let finishDeck!: () => void;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/chat/context/resolve')) {
      const ref = JSON.parse(String(init?.body)).refs[0];
      const reply = () => Response.json({ items: [{ ref, label: ref.kind, available: true }] });
      if (ref.kind === 'deck') return new Promise<Response>(resolve => { finishDeck = () => resolve(reply()); });
      return reply();
    }
    return Response.json({ items: [], nextCursor: null });
  }) as typeof fetch;
  pageCard = '01900000-0000-7000-8000-000000000001'; await render();
  await act(async () => { button('assistant.open').click(); await new Promise(resolve => setTimeout(resolve, 0)); });
  const originalKey = controller.getSnapshot().selectedKey!;
  await act(async () => controller.setDraft(originalKey, 'Do not send with stale context'));
  pageKind = 'deck'; pageCard = '01900000-0000-7000-8000-000000000002'; await render();
  expect(button('assistant.send').disabled).toBe(true);
  expect((document.querySelector('[data-assistant-composer]') as HTMLTextAreaElement).readOnly).toBe(true);
  pageKind = 'card'; pageCard = '01900000-0000-7000-8000-000000000001'; await render();
  await act(async () => finishDeck());
  expect(controller.getSnapshot().selectedKey).toBe(originalKey);
  expect(controller.getSnapshot().sessions[originalKey]!.pins[0]!.ref.kind).toBe('card');
  expect((document.querySelector('[data-assistant-composer]') as HTMLTextAreaElement).readOnly).toBe(false);
});

test('a completed single read has one disclosure and only three result rows until expanded', async () => {
  await render(); await act(async () => button('assistant.open').click());
  const key = controller.getSnapshot().selectedKey!; let sending!: Promise<void>;
  await act(async () => { controller.setDraft(key, 'Show decks'); sending = controller.send(key); await new Promise(resolve => setTimeout(resolve, 0)); });
  await act(async () => {
    callbacks.onToolCall?.({ id: 'decks', name: 'list_decks', args: {} });
    callbacks.onToolResult?.({ id: 'decks', ok: true, summary: Array.from({ length: 8 }, (_, i) => `- Deck ${i} [deck:deck-${i}] — 10 card(s), 2 due`).join('\n') });
    callbacks.onToken?.('You have eight decks.'); callbacks.onDone?.('answer'); finish?.(); await sending;
  });
  const trace = document.querySelector('.reomi-tool-trace')!;
  expect(trace).not.toBeNull(); expect(trace.querySelectorAll('.reomi-tool-result-row')).toHaveLength(0);
  expect(document.querySelector('.reomi-chat-activity')).toBeNull();
  await act(async () => trace.querySelector<HTMLButtonElement>('button')!.click());
  expect(trace.querySelectorAll('.reomi-tool-result-row')).toHaveLength(3);
  await act(async () => trace.querySelector<HTMLButtonElement>('.reomi-tool-more')!.click());
  expect(trace.querySelectorAll('.reomi-tool-result-row')).toHaveLength(8);
});

test('Back dismisses a model popup before hiding a pending approval, without deciding the write', async () => {
  const { transientLayers } = await import('../../lib/layer-stack');
  models = [{ id: 'fast', label: 'Fast', default: true }]; window.innerWidth = 390;
  await render(); let key!: string, sending!: Promise<void>;
  await act(async () => { key = controller.newConversation(); controller.setPresentation('floating'); controller.setDraft(key, 'Propose a deck'); sending = controller.send(key); await new Promise(resolve => setTimeout(resolve, 0)); });
  await act(async () => { callbacks.onAwaitConfirmation?.({ toolCall: { id: 'pending-write', name: 'create_deck', args: { name: 'Deck' } } }); finish?.(); await sending; });
  await act(async () => button('chat.composer.model').click());
  await act(async () => { await transientLayers.dismissTop('back'); });
  expect(document.querySelector('[role="menu"]')).toBeNull(); expect(controller.getSnapshot().presentation).toBe('floating');
  await act(async () => { await transientLayers.dismissTop('back'); });
  expect(controller.getSnapshot().presentation).toBe('hidden');
  expect(controller.getSnapshot().sessions[key]!.phase).toBe('needs_approval');
  expect(controller.getSnapshot().sessions[key]!.messages.at(-1)!.toolCalls![0]!.decision).toBeUndefined();
});

test('route departure closes desktop assistant menus while retaining its running session', async () => {
  const { transientLayers } = await import('../../lib/layer-stack');
  models = [{ id: 'fast', label: 'Fast', default: true }]; await render();
  await act(async () => button('assistant.open').click()); const key = controller.getSnapshot().selectedKey!; let sending!: Promise<void>;
  await act(async () => { controller.setDraft(key, 'Keep working'); sending = controller.send(key); await new Promise(resolve => setTimeout(resolve, 0)); });
  await act(async () => button('chat.composer.model').click());
  await act(async () => { expect(await transientLayers.confirmNavigation()).toBe(true); await transientLayers.closeForNavigation(); });
  expect(controller.getSnapshot().presentation).toBe('floating'); expect(signal?.aborted).toBe(false);
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await act(async () => { callbacks.onDone?.('finished'); finish?.(); await sending; });
});

test('Escape closes the slash menu and a queued edit without losing either draft or assistant', async () => {
  await render(); await act(async () => button('assistant.open').click());
  const key = controller.getSnapshot().selectedKey!;
  await act(async () => {
    const input = document.querySelector<HTMLTextAreaElement>('[data-assistant-composer]')!; input.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, '/'); input.setSelectionRange(1, 1); input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(document.querySelector('.reomi-assistant-slash-layer')).not.toBeNull();
  await act(async () => document.querySelector('[data-assistant-composer]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(document.querySelector('.reomi-assistant-slash-layer')).toBeNull(); expect(controller.getSnapshot().sessions[key]!.draft).toBe('/');
  let sending!: Promise<void>;
  await act(async () => { controller.setDraft(key, 'First'); sending = controller.send(key); await new Promise(resolve => setTimeout(resolve, 0)); controller.setDraft(key, 'Queued second'); await controller.send(key); });
  const item = controller.getSnapshot().sessions[key]!.queue[0]!;
  await act(async () => controller.setQueueEditing(key, item.id, true));
  await act(async () => document.querySelector('[data-assistant-queue-editor]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  expect(controller.getSnapshot().sessions[key]!.queue[0]).toMatchObject({ editing: false, content: 'Queued second' });
  expect(controller.getSnapshot().presentation).toBe('floating');
  await act(async () => { callbacks.onDone?.('finished'); finish?.(); await sending; });
});
