'use client';

import Link, { type LinkProps } from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type Dispatch,
  type SetStateAction,
  type ReactNode,
} from 'react';
import {
  NavigationProgressController,
  type NavigationProgressSnapshot,
} from '@/lib/navigation-progress';

import { NavigationJournal, NAVIGATION_HISTORY_KEY, NAVIGATION_AUTH_RETURN_KEY, NAVIGATION_RELOAD_KEY, navigationStorageKey, navigationResumeHref, readNavigationMarker, readNavigationReloadMarker, safeNavigationHref, type NavigationEntry, type NavigationIntent } from '@/lib/navigation-context';
import { readBrowserValue, removeBrowserValue, writeBrowserValue } from '@/lib/storage-migration';
import { useNN } from '@/lib/store';
import { useT } from '@/lib/i18n';
import { installNavigationHistoryBridge } from '@/lib/navigation-history';
import { transientLayers } from '@/lib/layer-stack';
import { LayerHistory } from '@/lib/layer-history';
import { LayerParent } from '@/lib/use-transient-layer';
import { NNBtn } from '@/components/ui';
import { raiseToast } from '@/components/toasts';
import { unavailableOriginFallback } from '@/lib/navigation-origin';
import { useSession } from '@/lib/auth';

type NavigationOptions = {
  intent?: NavigationIntent;
  /** Internal query synchronization that retains the same editor/object. */
  viewOnly?: boolean;
  scroll?: boolean;
  /** Query-only URL synchronization should opt out of global route progress. */
  track?: boolean;
};

type NavigationContextValue = {
  begin: (href: LinkProps['href'], track?: boolean) => void;
  push: (href: string, options?: NavigationOptions) => void;
  replace: (href: string, options?: NavigationOptions) => void;
  back: () => void;
  returnTo: (fallback?: string) => void;
  journal: NavigationJournal | null;
  entry: NavigationEntry | null;
  revision: number;
  restored: boolean;
  capture: (callback: () => void) => () => void;
  resetView: (scope: string) => void;
  confirmLeave: (href?: string) => Promise<boolean>;
  registerGuard: (guard: (href?: string) => Promise<boolean>, layerId?: string | null) => () => void;
  hasGuard: () => boolean;
};

const NavigationContext = createContext<NavigationContextValue | null>(null);

const IDLE_PROGRESS: NavigationProgressSnapshot = { phase: 'idle', navigationId: 0 };

function hrefText(href: LinkProps['href']): string {
  if (typeof href === 'string') return href;
  const pathname = href.pathname ?? '';
  const search = href.search
    ? String(href.search)
    : href.query
      ? new URLSearchParams(
          Object.entries(href.query).flatMap(([key, value]) => {
            if (value == null) return [];
            return Array.isArray(value)
              ? value.map((item) => [key, String(item)] as [string, string])
              : [[key, String(value)] as [string, string]];
          }),
        ).toString()
      : '';
  const hash = href.hash ? String(href.hash) : '';
  return `${pathname}${search ? `${search.startsWith('?') ? '' : '?'}${search}` : ''}${hash ? `${hash.startsWith('#') ? '' : '#'}${hash}` : ''}`;
}

function targetUrl(href: LinkProps['href']): URL | null {
  if (typeof window === 'undefined') return null;
  try {
    const target = new URL(hrefText(href), window.location.href);
    return target.origin === window.location.origin ? target : null;
  } catch {
    return null;
  }
}

function NavigationProgress({ snapshot }: { snapshot: NavigationProgressSnapshot }) {
  if (snapshot.phase === 'idle') return null;
  return (
    <div
      className="nn-navigation-progress"
      data-phase={snapshot.phase}
      role="progressbar"
      aria-label="Loading page"
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span />
    </div>
  );
}

export function AppNavigationSessionProvider({children}:{children:ReactNode}) {
  const authenticated=useSession();
  return <AppNavigationProvider sessionOwner={authenticated.data?.session?.userId??null}>{children}</AppNavigationProvider>;
}

export function AppNavigationProvider({ children, sessionOwner }: { children: ReactNode; sessionOwner?: string | null }) {
  const router = useRouter();
  const pathname = usePathname() ?? '/';
  const search = useSearchParams()?.toString() ?? '';
  const renderedHref = `${pathname}${search ? `?${search}` : ''}`;
  const profileOwner = useNN(state => state.profile?.userId);
  // Session identity is available before the profile/bootstrap request. Restored
  // filters must initialize before a collection makes its first request.
  const owner = sessionOwner === undefined ? profileOwner : sessionOwner ?? undefined;
  const t = useT();
  const storageNotified = useRef(false);
  const ownerRef = useRef(owner); ownerRef.current = owner;
  const journalRef = useRef<NavigationJournal | null>(null);
  const pendingRef = useRef<NavigationEntry | null>(null);
  const layerHistoryRef = useRef<LayerHistory | null>(null);
  const traversingRef = useRef(false);
  const renderedEntryRef = useRef<NavigationEntry | null>(null);
  const approvedTraversal = useRef(false);
  const authenticationReturn = useRef<string | null>(null);
  const authenticationMarker=useRef<ReturnType<typeof readNavigationMarker>>(null);
  const returning=useRef<symbol|null>(null);
  const [revision, setRevision] = useState(0);
  const captures = useRef(new Set<() => void>());
  const restoredRef = useRef(false);
  if (typeof window !== 'undefined' && owner && journalRef.current?.owner !== owner) {
    journalRef.current?.clear();
    let storage: Storage | undefined;
    try { storage = window.sessionStorage; } catch { /* Optional persistence. */ }
    let authMarker=authenticationMarker.current;
    try {const stored=storage?readBrowserValue(storage,NAVIGATION_AUTH_RETURN_KEY):null;if(!authMarker&&stored&&stored.length<1000)authMarker=readNavigationMarker(JSON.parse(stored));}catch{/* Optional session storage. */}
    const marker = authMarker ?? readNavigationMarker(window.history.state?.[NAVIGATION_HISTORY_KEY]) ?? readNavigationMarker(window.__nnNavigationInitialMarker)
      ?? readNavigationReloadMarker(owner,(performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming|undefined)?.type,storage);
    delete window.__nnNavigationInitialMarker;
    const resumeHref=authMarker?navigationResumeHref(owner,authMarker,storage):null;
    const canResume=resumeHref&&(pathname.startsWith('/auth/')||new URL(resumeHref,'https://navigation.invalid').pathname===pathname);
    if(marker&&marker.owner!==owner&&storage){try{removeBrowserValue(storage,navigationStorageKey(marker.owner));removeBrowserValue(storage,NAVIGATION_AUTH_RETURN_KEY);}catch{/* Memory isolation remains. */}}
    journalRef.current = new NavigationJournal(owner, canResume?resumeHref:renderedHref, marker, storage);
    restoredRef.current = marker?.id === journalRef.current.current.id;
    authenticationReturn.current=canResume?journalRef.current.current.id:null;
    pendingRef.current = null;
    traversingRef.current = false;
    renderedEntryRef.current = null;
    approvedTraversal.current = false;returning.current=null;
  }
  const journal = owner ? journalRef.current : null;
  if (!owner) journalRef.current?.suspend();
  else journal?.activate();
  const pending = pendingRef.current;
  const sameLocation = (a:string,b:string) => {const canonical=(value:string)=>{const url=new URL(value,'https://navigation.invalid');return url.pathname+'?'+url.searchParams.toString();};return canonical(a)===canonical(b);};
  const resumingAuthentication=Boolean(journal&&authenticationReturn.current===journal.current.id&&!pathname.startsWith('/auth/')&&new URL(journal.current.href,'https://navigation.invalid').pathname===pathname);
  let entry = journal?.current ?? null;
  if (journal && traversingRef.current && !sameLocation(journal.current.href, renderedHref)) entry = renderedEntryRef.current;
  if(resumingAuthentication)restoredRef.current=true;
  else if (journal && pending && sameLocation(pending.href, renderedHref)) entry = pending;
  else if (journal && !traversingRef.current && !sameLocation(journal.current.href, renderedHref) && safeNavigationHref(renderedHref)) {
    // Unmanaged internal URL changes get a fresh view; never apply unrelated old filters.
    entry = journal.plan(renderedHref, 'object');
    pendingRef.current = entry;
  }
  const capture = useCallback((callback: () => void) => { captures.current.add(callback); return () => { captures.current.delete(callback); }; }, []);
  const flush = useCallback(() => { for (const callback of captures.current) callback(); journalRef.current?.flush(); }, []);
  const stamp = useCallback(() => {
    const current = journalRef.current;
    if (current && ownerRef.current === current.owner && sameLocation(current.current.href, window.location.pathname + window.location.search)) {
      window.history.replaceState({ ...window.history.state, [NAVIGATION_HISTORY_KEY]: current.marker() }, '');
      layerHistoryRef.current?.refresh();
    }
  }, []);
  useLayoutEffect(() => {
    if(resumingAuthentication&&journal&&!sameLocation(journal.current.href,renderedHref)){router.replace(journal.current.href,{scroll:false});return;}
    if (!journal || !entry || !sameLocation(entry.href, renderedHref) || (traversingRef.current && entry !== journal.current)) return;
    traversingRef.current = false; renderedEntryRef.current = entry;
    if (entry !== journal.current) journal.commit(entry);
    if (pendingRef.current?.id === entry.id) pendingRef.current = null;
    stamp();
    if(resumingAuthentication){authenticationReturn.current=null;authenticationMarker.current=null;try{removeBrowserValue(sessionStorage,NAVIGATION_AUTH_RETURN_KEY);}catch{}}
  }, [journal, entry, renderedHref, stamp, resumingAuthentication, router]);
  useEffect(() => {
    const hide = () => {
      flush();
      const current=journalRef.current;
      if(current&&ownerRef.current===current.owner){try{writeBrowserValue(sessionStorage,NAVIGATION_RELOAD_KEY,JSON.stringify(current.marker()));}catch{/* Journal already reports degraded persistence. */}}
    };
    const clear = () => { authenticationReturn.current=null;authenticationMarker.current=null;try{removeBrowserValue(sessionStorage,NAVIGATION_AUTH_RETURN_KEY);removeBrowserValue(sessionStorage,NAVIGATION_RELOAD_KEY);}catch{} journalRef.current?.clear(); journalRef.current = null; pendingRef.current = null; captures.current.clear(); setRevision(n => n + 1); };
    window.addEventListener('pagehide', hide);
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('nn:navigation-clear', clear);
    return () => { window.removeEventListener('pagehide', hide); document.removeEventListener('visibilitychange', hide); window.removeEventListener('nn:navigation-clear', clear); flush(); };
  }, [flush]);
  const resetView = useCallback((scope: string) => { journalRef.current?.resetView(scope); setRevision(n => n + 1); }, []);
  useEffect(() => {
    if (!journal) return;
    const notify = () => { if (!storageNotified.current) { storageNotified.current = true; raiseToast({kind:'info',title:t('navigation.storageUnavailable')}); } };
    journal.onDegraded = notify;
    if (journal.degraded) notify();
    return () => { journal.onDegraded = undefined; };
  }, [journal, t]);
  useEffect(() => useNN.subscribe((state, previous) => {
    if (state.profile?.userId === previous.profile?.userId) return;
    const current = journalRef.current;
    if (!state.profile?.userId) current?.suspend();
    else if (current && current.owner !== state.profile.userId) current.clear();
    pendingRef.current = null;
  }), []);

  const pathnameRef = useRef(pathname);
  const activeRef = useRef<{ id: number; pathname: string } | null>(null);
  const [progress, setProgress] = useState(IDLE_PROGRESS);
  const controllerRef = useRef<NavigationProgressController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = new NavigationProgressController(setProgress);
  }

  const guardRef = useRef<{ run: (href?: string) => Promise<boolean>; layerId?: string | null } | null>(null);
  const guardsRef = useRef<Array<{ run: (href?: string) => Promise<boolean>; layerId?: string | null }>>([]);
  const checkingGuard = useRef(false);
  const registerGuard = useCallback((guard: (href?: string) => Promise<boolean>, layerId?: string | null) => {
    const entry = { run: guard, layerId }; guardsRef.current.push(entry); guardRef.current = entry;
    return () => { guardsRef.current = guardsRef.current.filter(item => item !== entry); guardRef.current = guardsRef.current.at(-1) ?? null; };
  }, []);
  const confirmLeave = useCallback(async (href?: string) => {
    if (!guardRef.current && !transientLayers.hasLayers()) return true;
    if (checkingGuard.current) return false;
    checkingGuard.current = true;
    const owner = ownerRef.current;
    const checked = new Set<object>();
    try {
      if (!await transientLayers.confirmNavigation()) return false;
      for (let step = 0; step < 32; step++) {
        const entry = [...guardsRef.current].reverse().find(item => !item.layerId && !checked.has(item));
        if (!entry) return ownerRef.current === owner;
        checked.add(entry);
        if (!await entry.run(href) || ownerRef.current !== owner) return false;
      }
      return false;
    }
    finally { checkingGuard.current = false; }
  }, []);
  const hasGuard = useCallback(() => guardRef.current !== null || transientLayers.hasLayers(), []);
  const guarded = useCallback((action: () => void, href?: string) => {
    const owner = ownerRef.current;
    const perform = async () => { await layerHistoryRef.current?.settled(); if (ownerRef.current === owner) action(); };
    if (!guardRef.current && !transientLayers.hasLayers()) { void perform(); return; }
    void confirmLeave(href).then(async allowed => { if (allowed) { await transientLayers.closeForNavigation(); await perform(); } });
  }, [confirmLeave]);

  const beginResolved = useCallback((target: URL, track = true) => {
    if (!track) return;

    // Hash/query-only changes stay local and must not flash a global indicator.
    if (target.pathname === pathnameRef.current) return;

    const id = controllerRef.current!.begin();
    activeRef.current = { id, pathname: target.pathname };
  }, []);

  const begin = useCallback((href: LinkProps['href'], track = true) => {
    const target = targetUrl(href);
    if (!target) return;
    beginResolved(target, track);
  }, [beginResolved]);

  const navigate = useCallback((href: string, options: NavigationOptions | undefined, replace: boolean) => {
    const target = targetUrl(href);
    if (!target && !safeNavigationHref(href)) return;
    const requestedPath=target?.pathname??href.split(/[?#]/)[0];
    if(!replace&&options?.intent==='section'&&['/library','/cards','/decks','/notebooks'].includes(href)&&requestedPath===pathnameRef.current)return;
    const perform = () => {
      flush();
      const current = journalRef.current;
      const safe = safeNavigationHref(target ? target.pathname + target.search + target.hash : href);
      if (target?.pathname.startsWith('/auth/') && replace) {
        const marker=current?.marker()??readNavigationMarker(window.__nnNavigationInitialMarker)??readNavigationMarker(window.history.state?.[NAVIGATION_HISTORY_KEY]);
        authenticationMarker.current=marker;
        if(current)authenticationReturn.current=current.current.id;
        try{if(marker)writeBrowserValue(sessionStorage,NAVIGATION_AUTH_RETURN_KEY,JSON.stringify(marker));}catch{}
      }
      if (current && ownerRef.current === current.owner && safe) {
        const actual=window.location.pathname+window.location.search+window.location.hash;
        if (!replace && safe === actual && safe === current.current.href) return;
        const resume = authenticationReturn.current===current.current.id && window.location.pathname.startsWith('/auth/') && safe.split(/[?#]/)[0]===current.current.href.split(/[?#]/)[0];
        const planned = resume ? {...current.current} : current.plan(safe, options?.intent ?? 'object', replace);
        if (resume) {replace=true;authenticationReturn.current=null;}
        pendingRef.current = planned;
        restoredRef.current = resume || options?.intent === 'section';
        href = planned.href;
        stamp();
      }
      begin(href, options?.track);
      startTransition(() => (replace ? router.replace : router.push)(href, { scroll: options?.scroll ?? false }));
    };
    if(replace&&options?.viewOnly&&requestedPath===pathnameRef.current) {
      const owner = ownerRef.current;
      void (layerHistoryRef.current?.settled() ?? Promise.resolve()).then(() => { if (ownerRef.current === owner) perform(); });
    }
    else guarded(perform, href);
  }, [begin, router, guarded, flush, stamp]);
  const push = useCallback((href: string, options?: NavigationOptions) => navigate(href, options, false), [navigate]);
  const replace = useCallback((href: string, options?: NavigationOptions) => navigate(href, options, true), [navigate]);
  const back = useCallback(() => {
    if (transientLayers.top() && !transientLayers.top()!.retainOnNavigation) { void transientLayers.dismissTop('back'); return; }
    guarded(() => { flush(); approvedTraversal.current = true; router.back(); });
  }, [router, guarded, flush]);
  const returnTo = useCallback((fallback = '/cards') => {
    if(returning.current)return;
    guarded(async () => {
      const token=Symbol('return');returning.current=token;
      flush();
      const current=journalRef.current;
      const from=current?.current.id;
      let parent=current?.parent();
      let destination=parent?.href??safeNavigationHref(fallback)??'/cards';
      let committed=false;
      begin(destination);
      const progressId=activeRef.current?.id;
      try {
        if(parent&&current){
          const unavailable=await unavailableOriginFallback(parent.href,(kind,id)=>kind==='notebook'?useNN.getState().getNotebook(id):useNN.getState().getSource(id));
          if(journalRef.current!==current||ownerRef.current!==current.owner||current.current.id!==from||(pendingRef.current&&pendingRef.current.id!==from))return;
          if(unavailable){
            destination=unavailable;
            let ancestor=parent.parent?current.entry(parent.parent):undefined;
            for(let depth=0;ancestor&&depth<16&&ancestor.href!==destination;depth++)ancestor=ancestor.parent?current.entry(ancestor.parent):undefined;
            parent=ancestor?.href===destination?ancestor:null;
            raiseToast({kind:'info',title:t('navigation.originUnavailable')});
          }
        }
        const distance=parent&&current?current.distanceTo(parent.id):null;
        if(distance!==null&&distance!==0){committed=true;approvedTraversal.current=true;begin(destination);window.history.go(distance);return;}
        if(current){
          const planned=current.plan(destination,'section',true);
          if(parent){planned.views=structuredClone(parent.views);planned.parent=parent.parent;}
          pendingRef.current=planned;restoredRef.current=true;destination=planned.href;
        }
        committed=true;begin(destination);
        startTransition(()=>router.replace(destination,{scroll:false}));
      }catch{raiseToast({kind:'error',title:t('navigation.returnFailed')});}
      finally{
        if(returning.current===token)returning.current=null;
        if(!committed&&progressId!==undefined&&activeRef.current?.id===progressId){controllerRef.current?.complete(progressId);activeRef.current=null;}
      }
    });
  }, [guarded, flush, router, begin, t]);

  useEffect(() => {
    pathnameRef.current = pathname;
    const active = activeRef.current;
    if (!active || active.pathname !== pathname) return;
    controllerRef.current?.complete(active.id);
    activeRef.current = null;
  }, [pathname]);

  // The pre-hydration event bridge precedes Next's listener, including on Window
  // where registration order matters. No router or History API is patched.
  useEffect(() => {
    let bounce: { owner: string; currentId: string; targetId: string; delta: number; href: string; checking: boolean } | null = null;
    let approvedId: string | null = null;
    const mobile = window.matchMedia('(max-width: 719px)');
    const makeLayers = () => new LayerHistory(transientLayers, {
      state: () => window.history.state, enabled: () => mobile.matches,
      push: state => window.history.pushState(state, ''), go: delta => window.history.go(delta),
      replace: state => window.history.replaceState(state, '', journalRef.current?.current.href),
    });
    let layers = makeLayers();
    layerHistoryRef.current = layers;
    const onPopState = (event: PopStateEvent) => {
      if (layers.onPop(event)) return;
      const current = journalRef.current;
      const marker = readNavigationMarker(event.state?.[NAVIGATION_HISTORY_KEY]);
      if (!current || ownerRef.current !== current.owner || marker?.owner !== current.owner) return;
      const href = window.location.pathname + window.location.search + window.location.hash;
      const targetEntry = current.entry(marker.id);
      if (!targetEntry || targetEntry.href !== safeNavigationHref(href)) return;
      if (bounce?.owner !== current.owner) bounce = null;
      if (bounce) {
        event.stopImmediatePropagation();
        if (marker.id !== bounce.currentId) {
          // A second Back/Forward updates the requested destination, but does
          // not start another guard or consume the outstanding decision.
          bounce.targetId=marker.id;bounce.delta=marker.position-current.current.position;bounce.href=href;
          window.history.go(-bounce.delta); return;
        }
        if (bounce.checking) return;
        bounce.checking=true;
        const request = bounce;
        void confirmLeave(request.href).then(async allowed => {
          if (bounce !== request) return;
          bounce = null;
          const distance=current.distanceTo(request.targetId);
          if (allowed && ownerRef.current === current.owner && distance!==null && distance!==0) { await transientLayers.closeForNavigation(); await layers.settled(); approvedId = request.targetId; window.history.go(distance); }
        });
        return;
      }
      if ((guardRef.current || transientLayers.hasLayers()) && approvedId !== marker.id && !approvedTraversal.current) {
        const delta = current.distanceTo(marker.id);
        if (delta !== null && delta !== 0) {
          event.stopImmediatePropagation();
          bounce = { owner:current.owner,currentId: current.current.id, targetId: marker.id, delta, href,checking:false };
          window.history.go(-delta); return;
        }
      }
      approvedId = null; approvedTraversal.current = false;
      flush(); pendingRef.current = null;
      if (current.traverse(marker.id, href)) { traversingRef.current = true; restoredRef.current = true; setRevision(n => n + 1); }
      beginResolved(new URL(window.location.href));
    };
    installNavigationHistoryBridge();
    window.__nnNavigationPop = onPopState;
    let active = true;
    // React Strict Mode replays mount effects. Do not schedule two physical
    // traversals from the same reload marker before either popstate can arrive.
    queueMicrotask(() => { if (active) { layers.start(window.__nnNavigationInitialLayer); delete window.__nnNavigationInitialLayer; } });
    const resizeLayers = () => layers.refresh();
    const hideLayers = () => layers.dispose();
    const restoreLayers = (event: PageTransitionEvent) => {
      if (!event.persisted || !active) return;
      // A reload can traverse to the previous document's base entry via BFCache.
      // Its old marker coordinator and transient DOM must not bounce us again.
      void transientLayers.closeForNavigation().then(() => {
        if (!active) return;
        layers = makeLayers(); layerHistoryRef.current = layers; layers.start();
      });
    };
    mobile.addEventListener('change', resizeLayers);
    window.addEventListener('pagehide', hideLayers); window.addEventListener('pageshow', restoreLayers);
    return () => {
      active = false; bounce = null; layers.dispose(); mobile.removeEventListener('change', resizeLayers);
      window.removeEventListener('pagehide', hideLayers); window.removeEventListener('pageshow', restoreLayers);
      if (layerHistoryRef.current === layers) layerHistoryRef.current = null;
      if (window.__nnNavigationPop === onPopState) delete window.__nnNavigationPop;
    };
  }, [beginResolved, confirmLeave, flush]);

  useEffect(() => () => controllerRef.current?.dispose(), []);

  const value = useMemo(() => ({ begin, push, replace, back, returnTo, confirmLeave, registerGuard, hasGuard, journal, entry, revision, restored: restoredRef.current, capture, resetView }), [begin, push, replace, back, returnTo, confirmLeave, registerGuard, hasGuard, journal, entry, revision, capture, resetView]);
  return (
    <NavigationContext.Provider value={value}>
      <NavigationProgress snapshot={progress} />
      {children}
    </NavigationContext.Provider>
  );
}

export function useAppNavigation(): Pick<NavigationContextValue, 'push' | 'replace' | 'back' | 'returnTo' | 'confirmLeave'> {
  const context = useContext(NavigationContext);
  if (!context) throw new Error('useAppNavigation must be used inside AppNavigationProvider');
  return context;
}

/** Editors register stable, stacked guards; closing a dialog reveals the underlying guard. */
export function useNavigationGuard(guard: (href?: string) => Promise<boolean>, ownedLayer?: string | null | false) {
  const context = useContext(NavigationContext);
  const inherited = useContext(LayerParent);
  const layerId = ownedLayer === undefined ? inherited : ownedLayer;
  const latest = useRef(guard); latest.current = guard;
  useEffect(() => {
    if (layerId === false) return;
    const removeNavigation = context?.registerGuard(href => latest.current(href), layerId);
    const removeLayer = layerId ? transientLayers.addGuard(layerId, () => latest.current()) : undefined;
    return () => { removeNavigation?.(); removeLayer?.(); };
  }, [context?.registerGuard, layerId]);
}

export type AppLinkProps = LinkProps &
  Omit<ComponentPropsWithoutRef<'a'>, keyof LinkProps | 'href'> & {
    track?: boolean;
    intent?: NavigationIntent;
  };

export function AppLink({ track = true, intent, onNavigate, ...props }: AppLinkProps) {
  const context = useContext(NavigationContext);
  return (
    <Link
      {...props}
      onNavigate={(event) => {
        let prevented = false;
        onNavigate?.({
          preventDefault: () => {
            prevented = true;
            event.preventDefault();
          },
        });
        if (!prevented && context) {
          event.preventDefault();
          (props.replace ? context.replace : context.push)(hrefText(props.href), { scroll: props.scroll, track, intent });
        } else if (!prevented) context?.begin(props.href, track);
      }}
    />
  );
}

export function useNavigationWorkspace() { return useContext(NavigationContext); }

/** Fields change synchronously with the addressed entry, including same-route traversal. */
export function useWorkspaceState<T>(scope: string, key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const context = useNavigationWorkspace();
  const entryId = context?.entry?.id;
  const revision = context?.revision ?? 0;
  const generation = context?.journal?.generation;
  const identity = `${entryId ?? ''}\u0000${revision}\u0000${generation ?? ''}\u0000${scope}\u0000${key}`;
  const currentIdentity = useRef(identity); currentIdentity.current = identity;
  const defaults = useRef(initial); defaults.current = initial;
  const getDefault = () => typeof defaults.current === 'function' ? (defaults.current as () => T)() : defaults.current;
  const read = () => (context?.entry?.views[scope]?.fields[key] as T | undefined) ?? getDefault();
  const [local, setLocal] = useState(() => ({ identity, value: read() }));
  const value = local.identity === identity ? local.value : read();
  const latest = useRef(value); latest.current = value;
  const set = useCallback<Dispatch<SetStateAction<T>>>(update => {
    if (currentIdentity.current !== identity) return;
    if (context?.journal && (context.journal.current.id !== entryId || context.journal.generation !== generation)) return;
    const next = typeof update === 'function' ? (update as (v: T) => T)(latest.current) : update;
    latest.current = next;
    context?.journal?.field(scope, key, next, entryId);
    setLocal({ identity, value: next });
  }, [context?.journal, entryId, identity, generation, scope, key]);
  return [value, set];
}

export function NavigationReturn({ fallback = '/cards', showLabel = false }: { fallback?: string; showLabel?: boolean }) {
  const context = useNavigationWorkspace();
  const t = useT();
  if (!context?.entry?.parent) return null;
  const parent = context.journal?.entry(context.entry.parent);
  const section = parent?.href.split(/[/?#]/)[1];
  const isSource = parent && (/^\/library\/[^/?]+/.test(parent.href) || (section==='notebooks' && new URL(parent.href,'https://navigation.invalid').searchParams.has('source')));
  const label = isSource ? t('navigation.source') : section && ['library', 'cards', 'decks', 'notebooks', 'review', 'editor', 'chat'].includes(section) ? t(`nav.${section}`) : t('actions.back');
  const title=t('navigation.returnTo',{place:label});
  return <NNBtn size="sm" variant="ghost" icon="chevl" className="nn-navigation-return" ariaLabel={title} title={title} onClick={()=>context.returnTo(fallback)}>{showLabel ? title : null}</NNBtn>;
}

export function useWorkspaceSet(scope: string, key: string): [Set<string>, Dispatch<SetStateAction<Set<string>>>] {
  const [ids,setIds]=useWorkspaceState<string[]>(scope,key,()=>[]);
  const value=useMemo(()=>new Set(ids),[ids]);
  const set=useCallback<Dispatch<SetStateAction<Set<string>>>>(update=>setIds(previous=>[...(typeof update==='function'?update(new Set(previous)):update)]),[setIds]);
  return [value,set];
}
