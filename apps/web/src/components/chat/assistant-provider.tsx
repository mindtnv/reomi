'use client';

import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { assistantRefKey, type AssistantObjectRef, type AssistantObjectSnapshot, type ChatModelOption, type AssistantContextPolicy } from '@reomi/shared';
import { AssistantController, type AssistantConversation, type AssistantTransport } from '@/lib/assistant-controller';
import { createAssistantTransport } from '@/lib/assistant-transport';
import { assistantApi, ok } from '@/lib/api';
import { useNN } from '@/lib/store';
import { raiseToast } from '@/components/toasts';
import { readAssistantDrafts, writeAssistantDrafts } from '@/lib/assistant-drafts';
import { readBrowserValue } from '@/lib/storage-migration';

export interface AssistantStatus {
  chatEnabled: boolean; embeddingEnabled?: boolean; degraded?: boolean; visionEnabled?: boolean; fetchPageEnabled?: boolean;
  models: ChatModelOption[];
  assistant?: { contextVersion: number; objectSearch: boolean; maxConcurrentTurns: number; sourceStudy: boolean };
}
export interface AssistantAskIntent { ref: AssistantObjectRef; prefill?: string; newConversation?: boolean }
interface PendingAsk { object: AssistantObjectSnapshot; prefill: string; key: string }
interface ThreadFilter { kind?: string; id?: string; q?: string; label?: string }
interface AssistantContextValue {
  controller: AssistantController;
  pageContext: AssistantObjectRef | null;
  openPage(fresh?: boolean): Promise<void>;
  pageOpening: boolean;
  registerPageContext(ref: AssistantObjectRef): () => void;
  draftError: string | null; exportDrafts(): void;
  status: AssistantStatus | null; checking: boolean; statusError: string | null; refreshStatus(): void;
  threads: AssistantConversation[]; threadsLoaded: boolean; threadsError: string | null; loadingMore: boolean; nextCursor: string | null;
  filter: ThreadFilter; setFilter(filter: ThreadFilter): void; refreshThreads(): void; loadMore(): void;
  pendingAsk: PendingAsk | null; acceptAsk(choice: 'new' | 'current' | 'cancel'): void; ask(intent: AssistantAskIntent): Promise<void>;
  newConversation(pins?: AssistantObjectSnapshot[]): string;
  patchConversation(id: string, patch: { title?: string; pinned?: boolean }): Promise<void>;
  deleteConversation(id: string): Promise<void>;
  setPins(key: string, refs: AssistantObjectSnapshot[], policy?: AssistantContextPolicy): Promise<void>;
}
const AssistantContext = createContext<AssistantContextValue | null>(null);
export function useAssistant() {
  const value = useContext(AssistantContext);
  if (!value) throw new Error('AssistantProvider is required');
  return value;
}
export function useAssistantSnapshot() {
  const { controller } = useAssistant();
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}

/** Register the visible object; only an explicit launcher click attaches it. */
export function useAssistantPageContext(ref: AssistantObjectRef | null) {
  const register = useContext(AssistantContext)?.registerPageContext;
  const identity = ref ? assistantRefKey(ref) : '';
  useLayoutEffect(() => {
    if (ref && register) return register(ref);
  }, [register, identity]);
}

interface ProviderProps {
  children: React.ReactNode;
  transportFactory?: (ownerId: string) => AssistantTransport;
  statusLoader?: () => Promise<AssistantStatus>;
}
const loadStatus = async () => await ok(await assistantApi.ai.status.get()) as unknown as AssistantStatus;
export function AssistantProvider(props: ProviderProps) {
  const ownerId = useNN(s => s.profile?.userId) ?? '';
  return <AssistantRuntime key={ownerId} {...props} ownerId={ownerId} />;
}
function AssistantRuntime({ ownerId, children, transportFactory = createAssistantTransport, statusLoader = loadStatus }: ProviderProps & { ownerId: string }) {
  const [controller] = useState(() => new AssistantController({ ownerId, transport: transportFactory(ownerId) }));
  const [pageContext, setPageContext] = useState<AssistantObjectRef | null>(null);
  const registerPageContext = useCallback((ref: AssistantObjectRef) => {
    setPageContext(ref);
    return () => setPageContext(current => current === ref ? null : current);
  }, []);
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [checking, setChecking] = useState(Boolean(ownerId));
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusRevision, setStatusRevision] = useState(0);
  const lease = useRef(0);
  const [draftError,setDraftError]=useState<string|null>(null);
  useLayoutEffect(()=>{
    if(!ownerId)return;
    let writable=false,last='',timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const saved=readAssistantDrafts(window.localStorage,ownerId);
      if(saved.ok){controller.restoreDrafts(saved.records);writable=true;last=JSON.stringify(controller.drafts());}
      else setDraftError(saved.error);
    }catch{setDraftError('draft_storage_unavailable');}
    const flush=()=>{
      if(timer){clearTimeout(timer);timer=undefined;}
      if(!writable)return;
      const records=controller.drafts(),signature=JSON.stringify(records);
      if(signature===last)return;
      try{
        const result=writeAssistantDrafts(window.localStorage,ownerId,records);
        if(result.ok){last=signature;setDraftError(null);}else setDraftError(result.error);
      }catch{setDraftError('draft_storage_unavailable');}
    };
    const unsubscribe=controller.subscribe(()=>{if(!timer)timer=setTimeout(flush,250);});
    const unload=(event:BeforeUnloadEvent)=>{
      flush();
      if(Object.values(controller.getSnapshot().sessions).some(s=>s.uploading)){event.preventDefault();event.returnValue='';}
    };
    window.addEventListener('pagehide',flush);window.addEventListener('beforeunload',unload);
    return()=>{unsubscribe();flush();window.removeEventListener('pagehide',flush);window.removeEventListener('beforeunload',unload);};
  },[controller,ownerId]);
  const exportDrafts=useCallback(()=>{
    const blob=new Blob([JSON.stringify({version:1,ownerId,records:controller.drafts()},null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`reomi-drafts-${new Date().toISOString().slice(0,10)}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),0);
  },[controller,ownerId]);
  useEffect(() => {
    const token = ++lease.current;
    return () => { queueMicrotask(() => { if (lease.current === token) controller.dispose(); }); };
  }, [controller]);
  useEffect(() => {
    if (!ownerId) return;
    let cancelled = false; setChecking(true);
    void statusLoader().then(value => {
      if (cancelled) return;
      const models=Array.isArray(value.models)?value.models:[];
      setStatus({ ...value, models }); setStatusError(null); controller.setContextVersion(value.assistant?.contextVersion ?? 0);
      let saved:string|null=null;try{saved=readBrowserValue(localStorage,'nn:chat:model');}catch{}
      const fallback=models.find(m=>m.id===saved)?.id??models.find(m=>m.default)?.id??models[0]?.id;
      for(const session of Object.values(controller.getSnapshot().sessions)){
        if(!models.some(m=>m.id===session.model))controller.setModel(session.key,fallback);
        if(!value.fetchPageEnabled)controller.setResearch(session.key,false);
      }
    }).catch(() => { if (!cancelled) { setStatusError('status_unavailable'); controller.setContextVersion(0); } })
      .finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, [ownerId, controller, statusLoader, statusRevision]);

  const [threads, setThreads] = useState<AssistantConversation[]>([]);
  const [threadsLoaded, setThreadsLoaded] = useState(false);
  const [threadsError, setThreadsError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilterState] = useState<ThreadFilter>({});
  const filterRef = useRef(filter); filterRef.current = filter;
  const [threadRevision, setThreadRevision] = useState(0);
  const listSequence = useRef(0);
  const loadThreads = useCallback(async (cursor?: string) => {
    if (!ownerId) return;
    const sequence = ++listSequence.current;
    const currentFilter = filterRef.current;
    if (cursor) setLoadingMore(true); else setThreadsLoaded(false);
    try {
      const result = await ok(await assistantApi.chat['context-v1'].conversations.get({ query: { limit: 30, cursor,
        contextKind: currentFilter.kind, contextId: currentFilter.id, ...(currentFilter.q ? { q: currentFilter.q } : {}),
      } }));
      if (sequence !== listSequence.current) return;
      const incoming = result.items as unknown as AssistantConversation[];
      setThreads(previous => cursor ? [...new Map([...previous, ...incoming].map(c => [c.id, c])).values()] : incoming);
      setNextCursor(result.nextCursor); setThreadsError(null);
    } catch { if (sequence === listSequence.current) setThreadsError('threads_unavailable'); }
    finally { if (sequence === listSequence.current) { setThreadsLoaded(true); setLoadingMore(false); } }
  }, [ownerId]);
  useEffect(() => { void loadThreads(); return () => { listSequence.current++; }; }, [loadThreads, filter, threadRevision]);
  const setFilter = useCallback((next: ThreadFilter) => {
    setFilterState(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
  }, []);
  const refreshThreads = useCallback(() => setThreadRevision(v => v + 1), []);
  const loadMore = useCallback(() => { if (nextCursor && !loadingMore) void loadThreads(nextCursor); }, [nextCursor, loadingMore, loadThreads]);
  useEffect(() => {
    const refresh = () => refreshThreads();
    window.addEventListener('nn:knowledge-changed', refresh);
    return () => window.removeEventListener('nn:knowledge-changed', refresh);
  }, [refreshThreads]);

  const newConversation = useCallback((pins: AssistantObjectSnapshot[] = []) => {
    const key = controller.newConversation(pins);
    let saved: string | null = null;
    try { saved = readBrowserValue(localStorage, 'nn:chat:model'); } catch {}
    const model = status?.models?.find(m => m.id === saved)?.id ?? status?.models?.find(m => m.default)?.id ?? status?.models?.[0]?.id;
    controller.setModel(key, model);
    try { if (status?.fetchPageEnabled) controller.setResearch(key, readBrowserValue(localStorage, 'nn:chat:research') === '1'); } catch {}
    return key;
  }, [controller, status]);
  const [pageOpening, setPageOpening] = useState(false);
  const [pendingAsk, setPendingAsk] = useState<PendingAsk | null>(null);
  const askSequence = useRef(0);
  const attach = useCallback((key: string, object: AssistantObjectSnapshot, prefill: string) => {
    const session = controller.getSnapshot().sessions[key]; if (!session) return;
    const pinned = new Set(session.pins.map(s => assistantRefKey(s.ref)));
    const refs = [...new Map([...session.refs, object].map(s => [assistantRefKey(s.ref), s])).values()].filter(s => !pinned.has(assistantRefKey(s.ref)));
    controller.setRefs(key, refs);
    if (prefill) controller.setDraft(key, session.draft ? `${session.draft}\n\n${prefill}` : prefill);
    controller.select(key); controller.setPresentation('floating');
  }, [controller]);
  const ask = useCallback(async (intent: AssistantAskIntent) => {
    setPageOpening(false);
    if(useNN.getState().profile?.userId!==ownerId)return;
    const sequence = ++askSequence.current;
    const response = await ok(await assistantApi.chat.context.resolve.post({ refs: [intent.ref] }));
    if (sequence !== askSequence.current || useNN.getState().profile?.userId !== ownerId) return;
    const object = response.items[0]; if (!object) return;
    const snapshot = controller.getSnapshot(), active = snapshot.selectedKey ? snapshot.sessions[snapshot.selectedKey] : undefined;
    const sameObject = active && [...active.pins,...active.refs].some(s => s.ref.id === object.ref.id && (s.ref.kind === object.ref.kind || (s.ref.kind.startsWith('source') && object.ref.kind.startsWith('source'))));
    controller.setPresentation('floating');
    if (!intent.newConversation && active && sameObject) { attach(active.key, object, intent.prefill ?? ''); return; }
    if (!intent.newConversation && active && (active.messages.length || active.draft || active.pins.length || active.refs.length)) {
      setPendingAsk({ object, prefill: intent.prefill ?? '', key: active.key }); return;
    }
    const key = newConversation([object]);
    if (intent.prefill) controller.setDraft(key, intent.prefill);
  }, [controller, ownerId, newConversation, attach]);
  const acceptAsk = useCallback((choice: 'new' | 'current' | 'cancel') => {
    if (!pendingAsk) return;
    try {
      if (choice === 'current') attach(pendingAsk.key, pendingAsk.object, pendingAsk.prefill);
      if (choice === 'new') { const key = newConversation([pendingAsk.object]); controller.setDraft(key, pendingAsk.prefill); }
    } catch { raiseToast({ kind: 'error', titleKey: 'assistant.contextLimit' }); return; }
    setPendingAsk(null);
  }, [pendingAsk, attach, newConversation, controller]);
  // Page launches own contextual drafts; switching screens never rewrites an existing transcript.
  const pageSessions = useRef(new Map<string, string>());
  const openPage = useCallback(async (fresh = false) => {
    if (useNN.getState().profile?.userId !== ownerId) return;
    setPageOpening(false);
    const ref = pageContext;
    if (!ref) {
      if (fresh || !controller.getSnapshot().selectedKey) newConversation();
      controller.setPresentation('floating'); return;
    }
    const identity = assistantRefKey(ref), sequence = ++askSequence.current;
    const state = controller.getSnapshot();
    const active = state.selectedKey ? state.sessions[state.selectedKey] : undefined;
    const matches = (session: typeof active) => session && session.pins.length === 1 && assistantRefKey(session.pins[0]!.ref) === identity;
    const cached = pageSessions.current.get(identity);
    const existing = !fresh ? matches(active) ? active : cached ? state.sessions[cached] : undefined : undefined;
    if (existing && matches(existing)) {
      pageSessions.current.set(identity, existing.key);
      setPendingAsk(null); controller.select(existing.key); controller.setPresentation('floating'); return;
    }
    setPageOpening(true);
    try {
    const response = await ok(await assistantApi.chat.context.resolve.post({ refs: [ref] }));
    if (sequence !== askSequence.current || controller.getSnapshot().selectedKey !== state.selectedKey || useNN.getState().profile?.userId !== ownerId) return;
    const object = response.items[0]; if (!object) return;
    const key = newConversation([object]); pageSessions.current.set(identity, key);
    setPendingAsk(null); controller.setPresentation('floating');
    } finally { if (sequence === askSequence.current) setPageOpening(false); }
  }, [controller, ownerId, pageContext, newConversation]);
  const openPageRef = useRef(openPage); openPageRef.current = openPage;
  useEffect(() => {
    // Also invalidates an in-flight resolution when its screen is left.
    askSequence.current++; setPageOpening(false);
    if (pageContext && controller.getSnapshot().presentation === 'floating') {
      void openPageRef.current().catch(() => {
        if (useNN.getState().profile?.userId === ownerId) raiseToast({ kind: 'error', titleKey: 'assistant.contextFailed' });
      });
    }
  }, [pageContext, controller, ownerId]);
  const askRef = useRef(ask); askRef.current = ask;
  useEffect(() => {
    const handler = (event: Event) => { void askRef.current((event as CustomEvent<AssistantAskIntent>).detail).catch(() => {
      if (useNN.getState().profile?.userId === ownerId) raiseToast({ kind: 'error', titleKey: 'assistant.contextFailed' });
    }); };
    window.addEventListener('nn:assistant:ask', handler);
    return () => { askSequence.current++; window.removeEventListener('nn:assistant:ask', handler); };
  }, [controller]);
  const patchConversation = useCallback(async (id: string, patch: { title?: string; pinned?: boolean }) => {
    if(useNN.getState().profile?.userId!==ownerId)return;
    const result = await ok(await assistantApi.chat['context-v1'].conversations({ id }).patch(patch)) as unknown as AssistantConversation;
    if (useNN.getState().profile?.userId !== ownerId) return;
    controller.updateConversation(result); refreshThreads();
  }, [controller, ownerId, refreshThreads]);
  const deleteConversation = useCallback(async (id: string) => {
    if(useNN.getState().profile?.userId!==ownerId)return;
    for (const session of Object.values(controller.getSnapshot().sessions)) if (session.conversationId === id) controller.stop(session.key);
    await ok(await assistantApi.chat['context-v1'].conversations({ id }).delete());
    if (useNN.getState().profile?.userId !== ownerId) return;
    controller.forgetConversation(id); refreshThreads();
  }, [controller, ownerId, refreshThreads]);
  const setPins = useCallback(async (key: string, refs: AssistantObjectSnapshot[], policy?: AssistantContextPolicy) => {
    if(useNN.getState().profile?.userId!==ownerId)return;
    const session = controller.getSnapshot().sessions[key]; if (!session) return;
    if (!session.conversationId) { controller.setLocalPins(key, refs, policy ?? session.policy); return; }
    const result = await ok(await assistantApi.chat['context-v1'].conversations({ id: session.conversationId }).patch({
      context: { version: 1, policy: policy ?? session.policy, refs: refs.map(s => s.ref) }, expectedContextRevision: session.conversation?.context?.revision ?? 0,
    })) as unknown as AssistantConversation;
    if (useNN.getState().profile?.userId !== ownerId) return;
    controller.updateConversation(result, true); refreshThreads();
  }, [controller, ownerId, refreshThreads]);
  const value = useMemo<AssistantContextValue>(() => ({ controller, pageContext, openPage, pageOpening, registerPageContext, draftError, exportDrafts, status, checking, statusError, refreshStatus: () => setStatusRevision(v => v + 1),
    threads, threadsLoaded, threadsError, loadingMore, nextCursor, filter, setFilter, refreshThreads, loadMore,
    pendingAsk, ask, acceptAsk, newConversation, patchConversation, deleteConversation, setPins,
  }), [controller,pageContext,openPage,pageOpening,registerPageContext,draftError,exportDrafts,status,checking,statusError,threads,threadsLoaded,threadsError,loadingMore,nextCursor,filter,setFilter,refreshThreads,loadMore,pendingAsk,ask,acceptAsk,newConversation,patchConversation,deleteConversation,setPins]);
  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

export function askAssistant(intent: AssistantAskIntent) {
  window.dispatchEvent(new CustomEvent('nn:assistant:ask', { detail: intent }));
}
