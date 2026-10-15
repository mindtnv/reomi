import { ensureTestDom, GlobalRegistrator } from '../../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act, StrictMode, useEffect } from 'react';
import type { Root } from 'react-dom/client';
import { useNN } from '../../lib/store';
import type { AssistantController, AssistantTransport } from '../../lib/assistant-controller';
import type { ChatStreamHandlers } from '../../lib/chat-stream';

ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { AssistantProvider, useAssistant, useAssistantSnapshot } = await import('./assistant-provider');
let root: Root, host: HTMLDivElement, previousFetch: typeof fetch, current: AssistantController;
let currentApi:ReturnType<typeof useAssistant>;
let handlers: ChatStreamHandlers;
let activeSignal: AbortSignal | undefined;
const statusLoader = async () => ({ chatEnabled: true, models: [], assistant: { contextVersion: 1, objectSearch: true, maxConcurrentTurns: 3, sourceStudy: false } });
const transport: AssistantTransport = {
  create: async context => ({ id: 'thread', title: null, updatedAt: new Date().toISOString(), contextVersion: 1, context: { ...context, revision: 0, refs: [] } }),
  load: async id => ({ conversation: { id, title: null, updatedAt: new Date().toISOString() }, messages: [] }),
  stream: async (_id, _text, callbacks, options) => { handlers = callbacks; activeSignal = options.signal;
    await new Promise<void>(resolve => options.signal?.addEventListener('abort', () => resolve(), { once: true })); },
  resume: async () => {}, regenerate: async () => {},
};
const factory = () => transport;
function Consumer({ page }: { page: string }) {
  const value = useAssistant(),{ controller }=value; const snapshot = useAssistantSnapshot();
  useEffect(() => { current = controller;currentApi=value; }, [controller,value]);
  return <div>{page} · {snapshot.ownerId} · {snapshot.selectedKey ? snapshot.sessions[snapshot.selectedKey]?.messages.at(-1)?.content : ''}</div>;
}
beforeEach(() => {
  ensureTestDom(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.removeItem('nn:assistant:drafts:v1:alice');localStorage.removeItem('nn:assistant:drafts:v1:bob');
  localStorage.removeItem('reomi:assistant:drafts:v1:alice');localStorage.removeItem('reomi:assistant:drafts:v1:bob');
  previousFetch = globalThis.fetch; globalThis.fetch = (async () => Response.json({ items: [], nextCursor: null })) as unknown as typeof fetch;
  useNN.setState({ profile: { userId: 'alice' } as any });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = previousFetch; useNN.getState().reset(); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });
afterAll(() => { try { GlobalRegistrator.unregister(); } catch {} });
async function render(page: string) {
  await act(async () => root.render(<StrictMode><AssistantProvider transportFactory={factory} statusLoader={statusLoader}><Consumer page={page} /></AssistantProvider></StrictMode>));
}

test('shell provider survives child route replacement and StrictMode effect replay', async () => {
  await render('Reader'); const original = current!; let request!: Promise<void>;
  await act(async () => {
    const key = original.newConversation(); original.setDraft(key, 'Explain this'); request = original.send(key);
    await new Promise(resolve => setTimeout(resolve, 0)); handlers.onToken?.('Answer in progress');
  });
  await render('Cards');
  expect(current!).toBe(original);
  expect(host.textContent).toContain('Cards · alice · Answer in progress');
  expect(activeSignal?.aborted).toBe(false);
  await act(async () => original.stop(original.getSnapshot().selectedKey!)); await request;
});

test('account replacement cancels old streams and cannot show late private content', async () => {
  await render('Reader'); const original = current!; let request!: Promise<void>;
  await act(async () => { const key = original.newConversation(); original.setDraft(key, 'Private draft'); request = original.send(key); await new Promise(resolve => setTimeout(resolve, 0)); });
  const oldHandlers = handlers, oldSignal = activeSignal;
  await act(async () => useNN.setState({ profile: { userId: 'bob' } as any }));
  await request;
  expect(current!).not.toBe(original);
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => oldHandlers.onToken?.('Alice private response'));
  expect(host.textContent).toContain('bob');
  expect(host.textContent).not.toContain('Alice private response');
});

test('asking about another object requires a choice and never silently replaces the current context',async()=>{
  await render('Cards');let key!:string;await act(async()=>{key=current!.newConversation();current.setDraft(key,'Existing topic');});
  const ref={kind:'source' as const,id:'01900000-0000-7000-8000-000000000001'};
  globalThis.fetch=(async()=>Response.json({items:[{ref,label:'New book',available:true}]})) as unknown as typeof fetch;
  await act(async()=>currentApi.ask({ref,prefill:'Explain this'}));
  expect(current.getSnapshot().selectedKey).toBe(key);expect(current.getSnapshot().sessions[key]!.refs).toEqual([]);
  expect(currentApi.pendingAsk?.object.label).toBe('New book');
  await act(async()=>currentApi.acceptAsk('current'));
  expect(current.getSnapshot().sessions[key]!.draft).toBe('Existing topic\n\nExplain this');
  expect(current.getSnapshot().sessions[key]!.refs[0]?.ref).toEqual(ref);
  await act(async()=>currentApi.ask({ref,newConversation:true,prefill:'New topic'}));
  const next=current.getSnapshot().selectedKey!;expect(next).not.toBe(key);
  expect(current.getSnapshot().sessions[next]!.pins[0]?.ref).toEqual(ref);
  expect(current.getSnapshot().sessions[key]!.draft).toBe('Existing topic\n\nExplain this');
});
