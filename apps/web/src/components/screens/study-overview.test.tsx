import { adaptRecoveryFetch } from '../../lib/test-recovery-fetch';
import { ensureTestDom, GlobalRegistrator } from '../../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { AppNavigationProvider } from '../navigation';
import { DialogProvider } from '../dialog';
import { I18nProvider } from '../../lib/i18n';
import { clearSessionResourceCache } from '../../lib/session-resource';
import { useNN } from '../../lib/store';
import { cardFromApi, profileFromApi } from '../../lib/mappers';
import { clearStudyResult, readStudyResult, saveStudyResult, type StudyResult } from '../../lib/study-result';

// Re-register before loading DOM-dependent modules; other suites tear the DOM down.
ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { NNHome } = await import('./home');
const { NNDecks } = await import('./decks');
const { ReviewSessionDone } = await import('../review-session-done');

const counts = { total: 601, newCount: 601, learningCount: 0, reviewCount: 0, suspendedCount: 0, dueLearning: 0, dueReview: 0, nextLearningAt: null, nextDueAt: null, newRemaining: 20, reviewRemaining: 200, availableNew: 20, availableReview: 0, totalAvailable: 20, limitedNew: 581, limitedReview: 0, serverNow: new Date().toISOString() };
const overview = { overall: counts, decks: { deck: counts }, direct: { deck: counts } };
const navigations: string[] = [];
const router = { bfcacheId: 'test', push(href: string) { navigations.push(href); }, replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {}, hmrRefresh() {} };
const result: StudyResult = { version: 1, userId: 'result-user', completedAt: Date.now(), deckName: 'Study', answers: 2, cards: 1,
  durationMs: 2300, xpGained: 10, grades: { 1: 1, 2: 0, 3: 1, 4: 0 }, mode: 'regular', reviewHref: '/review?deck=deck' };
let root: Root;
let container: HTMLDivElement;
let originalFetch: typeof fetch;

beforeEach(() => {
  ensureTestDom();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.removeItem('reomi:locale'); localStorage.setItem('nn:locale', 'en');
  clearSessionResourceCache();
  clearStudyResult('result-user'); navigations.length = 0;
  originalFetch = globalThis.fetch;
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  useNN.setState({ profile: { userId: 'study-overview-owner' } as any, bootstrapped: true, decks: [{ id: 'deck', name: 'Study', color: 'lime', species: 'fern', createdAt: 0 }], cards: [cardFromApi({ id: 'cached', deckId: 'deck', suspended: true })] });
  globalThis.fetch = adaptRecoveryFetch(((url: any) => Promise.resolve(Response.json(
    String(url).endsWith('/deck-hierarchy') ? {revision:0,decks:useNN.getState().decks} : String(url).endsWith('/decks') ? useNN.getState().decks : String(url).includes('/study-summary') ? overview : String(url).includes('/library') ? { items: [] }
    : String(url).includes('/stats/forecast') ? { days: 7, buckets: [], overdueCount: 0, total: 0 }
    : String(url).includes('/status') ? { chatEnabled: false } : [],
  ))) as unknown as typeof fetch);
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  globalThis.fetch = originalFetch; useNN.getState().reset();
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});
afterAll(() => GlobalRegistrator.unregister());

async function render(screen: React.ReactNode) {
  await act(async () => root.render(
    <AppRouterContext.Provider value={router}><PathnameContext.Provider value="/">
      <I18nProvider><AppNavigationProvider><DialogProvider>{screen}</DialogProvider></AppNavigationProvider></I18nProvider>
    </PathnameContext.Provider></AppRouterContext.Provider>,
  ));
}

describe('study overview screens', () => {
  test('home uses complete server counts rather than the one cached suspended card', async () => {
    await render(<NNHome />);
    expect(container.textContent).toContain('20cards due');
    expect(container.textContent).toContain('601cards');
    expect(container.textContent).not.toContain('forgetting > 60%');
  });

  test('decks use server totals and daily availability', async () => {
    await render(<NNDecks />);
    expect(container.querySelector('.reomi-decks-toolbar [role="radiogroup"]')).toBeNull();
    expect(container.querySelector('.reomi-decks-search input')).not.toBeNull();
    expect(container.querySelector('.nn-topbar-subtitle')?.textContent).toBe('601');
    const review = container.querySelector('a[href="/review?deck=deck"]');
    expect(review).not.toBeNull();
    expect(container.textContent).toContain('601');
  });

  test('a failed count request is shown as unavailable with a retry', async () => {
    globalThis.fetch = adaptRecoveryFetch(((url: any) => Promise.resolve(String(url).includes('/study-summary')
      ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json(String(url).includes('/stats/forecast')
        ? { days: 7, buckets: [], overdueCount: 0, total: 0 } : []))) as unknown as typeof fetch);
    await render(<NNHome />);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not refresh');
    expect(container.textContent).toContain('—cards due');
    expect(container.textContent).toContain('Try again');
  });

  test('home forecast follows the server study-day labels and minutes', async () => {
    useNN.setState({ profile: { userId: 'study-overview-owner', todayMinutes: 99, todayMinutesDate: '2026-10-15', dailyGoalMinutes: 30 } as any });
    globalThis.fetch = adaptRecoveryFetch(((url: any) => Promise.resolve(Response.json(
      String(url).includes('/study-summary') ? {
        ...overview,
        overall: { ...counts, serverNow: '2026-10-15T23:00:00.000Z' },
        studyDay: {
          label: '2026-03-08',
          startsAt: '2026-03-08T05:00:00.000Z',
          endsAt: '2026-03-09T04:00:00.000Z',
          usedNew: 1,
          usedReviews: 0,
          todayMinutes: 12,
          legacy: false,
          zone: 'America/New_York',
          rolloverMinute: 0,
        },
      }
      : String(url).includes('/stats/forecast') ? {
        days: 7,
        labels: ['2026-03-08', '2026-03-09'],
        buckets: [{ day: '2026-03-08', count: 3 }],
        overdueCount: 0,
        total: 3,
      }
      : String(url).includes('/status') ? { chatEnabled: false }
      : [],
    ))) as unknown as typeof fetch);
    await render(<NNHome />);
    expect(container.textContent).toContain('Sunday');
    expect(container.textContent).toContain('Monday');
    expect(container.textContent).not.toContain('Thursday');
    expect(container.textContent).toContain('Mar 8');
    expect(container.textContent).toContain('Mar 9');
    expect(container.textContent).toContain('12');
    expect(container.textContent).not.toContain('99');
    expect(container.textContent).toContain('7 study days · America/New_York');
    expect(container.textContent).toContain('Today · Mar 8');
  });

  test('forecast errors do not render a fabricated zero forecast', async () => {
    globalThis.fetch = adaptRecoveryFetch(((url: any) => Promise.resolve(
      String(url).includes('/stats/forecast') ? Response.json({ error: 'unavailable' }, { status: 503 })
      : Response.json(String(url).endsWith('/deck-hierarchy') ? {revision:0,decks:useNN.getState().decks} : String(url).endsWith('/decks') ? useNN.getState().decks : String(url).includes('/study-summary') ? overview : []),
    )) as unknown as typeof fetch);
    await render(<NNHome />);
    expect(container.textContent).toContain('Could not refresh the forecast');
    expect(container.textContent).not.toContain('Tomorrow');
  });

  test('home refreshes when a scheduled card becomes due and when returning to the window', async () => {
    let loads = 0;
    const due = new Date(Date.now() + 100).toISOString();
    globalThis.fetch = adaptRecoveryFetch(((url: any) => {
      if (String(url).includes('/study-summary')) {
        loads++;
        return Promise.resolve(Response.json({ ...overview, overall: { ...counts,
          totalAvailable: loads === 1 ? 0 : 1, nextDueAt: loads === 1 ? due : null, serverNow: new Date().toISOString(),
        } }));
      }
      return Promise.resolve(Response.json(String(url).includes('/stats/forecast') ? { days: 7, buckets: [], overdueCount: 0, total: 0 } : []));
    }) as unknown as typeof fetch);
    await render(<NNHome />);
    expect(container.textContent).toContain('0cards due');
    for (let i = 0; i < 30 && !container.textContent?.includes('1cards due'); i++) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    }
    expect(container.textContent).toContain('1cards due');
    const before = loads;
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(loads).toBeGreaterThan(before);
  });

  test('inline results distinguish answers from cards and show active duration and grades', async () => {
    await render(<ReviewSessionDone completed={result.answers} xp={result.xpGained} stats={{ cards: result.cards, durationMs: result.durationMs, grades: result.grades, answers: [{ durationMs: 1200, rating: 1 }, { durationMs: 1100, rating: 3 }] }} />);
    expect(container.textContent).toContain('2Answers');
    expect(container.textContent).toContain('1Cards reviewed');
    expect(container.textContent).toContain('0:02');
    expect(container.querySelectorAll('.reomi-session-chart-legend strong').length).toBe(4);
    expect(container.querySelector('a[href="/session/complete"]')).toBeNull();
    const timing = container.querySelectorAll<HTMLButtonElement>('.reomi-duration-bars button');
    expect(timing).toHaveLength(2);
    await act(async () => timing[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })));
    expect(container.querySelector('.reomi-duration-detail')?.textContent).toContain('Answer 2');
    expect(container.textContent).not.toContain('Fern grew');
  });

  test('a new account never reads another account\'s stored result', () => {
    saveStudyResult(result);
    expect(readStudyResult('someone-else')).toBeNull();
  });
});

describe('organized deck workspace', () => {
  const deck = { id: 'deck', name: 'Study', color: 'lime' as const, species: 'fern' as const, createdAt: 0 };
  test('icon and color editor saves both and safe fallback renders unknown legacy icons', async () => {
    const writes: any[] = [];
    const fallback = globalThis.fetch;
    globalThis.fetch = adaptRecoveryFetch((async (url: any, init?: RequestInit) => {
      if (init?.method === 'PATCH') { const body = JSON.parse(String(init.body)); writes.push(body); return Response.json({ ...deck, ...body }); }
      return fallback(url, init);
    }) as typeof fetch);
    useNN.setState({ decks: [{ ...deck, icon: 'legacy-emoji' }] });
    await render(<NNDecks />);
    expect(container.querySelector('.reomi-deck-row-icon svg path')).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('.reomi-deck-row-icon')!.click());
    expect(container.querySelectorAll('dialog[open] .reomi-deck-icon-options button')).toHaveLength(48);
    expect(container.querySelectorAll('dialog[open] .reomi-deck-color-options button')).toHaveLength(30);
    await act(async () => { container.querySelector<HTMLButtonElement>('dialog[open] button[aria-label="Star"]')!.click(); container.querySelector<HTMLButtonElement>('dialog[open] button[aria-label="Sky"]')!.click(); });
    await act(async () => container.querySelector<HTMLButtonElement>('dialog[open] button[type="submit"]')!.click());
    expect(writes).toEqual([{ icon:'star', color:'sky' }]);
    expect(useNN.getState().decks[0]).toMatchObject({icon:'star',color:'sky'});
    expect(container.querySelector('dialog[open]')).toBeNull();
  });
  test('keyboard menu offers explicit relative moves and excludes source descendants', async () => {
    useNN.setState({ decks: [deck, { ...deck,id:'child',name:'Child',parentId:'deck' },{...deck,id:'target',name:'Target'}] });
    const writes: any[] = [];
    let moved: unknown[] | null = null;
    const fallback = globalThis.fetch;
    globalThis.fetch = adaptRecoveryFetch((async (url:any,init?:RequestInit) => {
      if (String(url).endsWith('/deck/move')) {
        writes.push(JSON.parse(String(init?.body)));
        moved = [{...deck,parentId:'target',position:0},{...deck,id:'child',name:'Child',parentId:'deck'},{...deck,id:'target',name:'Target'}];
        return Response.json(moved);
      }
      if (String(url).endsWith('/deck-hierarchy') && moved) return Response.json({ revision: 1, decks: moved });
      return fallback(url,init);
    }) as typeof fetch);
    await render(<NNDecks />);
    await act(async () => container.querySelector('[data-deck-id="deck"]')!.dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true})));
    await act(async () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(b=>b.textContent==='Move deck')!.click());
    const destination = container.querySelector<HTMLButtonElement>('dialog[open] [aria-label^="Destination"]')!;
    await act(async () => destination.click());
    expect([...document.querySelectorAll('[role="option"]')].map(option => option.textContent?.trim())).toEqual(['All decks', 'Target']);
    await act(async () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.trim() === 'Target')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('dialog[open] button[type="submit"]')!.click());
    expect(writes).toEqual([{targetId:'target',placement:'inside'}]);
    expect(useNN.getState().decks.find(d=>d.id==='deck')?.parentId).toBe('target');
  });
  test('desktop drag submits the indicated placement once and preserves subtree scope', async () => {
    useNN.setState({ decks:[deck,{...deck,id:'target',name:'Target'}] });
    const fallback = globalThis.fetch, writes:any[]=[];
    globalThis.fetch = adaptRecoveryFetch((async (url:any,init?:RequestInit) => {
      if (String(url).endsWith('/deck/move')) { writes.push(JSON.parse(String(init?.body))); return Response.json([{...deck,position:1},{...deck,id:'target',name:'Target',position:0}]); }
      return fallback(url,init);
    }) as typeof fetch);
    await render(<NNDecks />);
    const source=container.querySelector<HTMLElement>('[data-deck-id="deck"] .reomi-deck-drag-handle')!;
    const target=container.querySelector<HTMLElement>('[data-deck-id="target"]')!;
    target.getBoundingClientRect=()=>({top:0,height:60,bottom:60,left:0,right:600,width:600,x:0,y:0,toJSON(){}});
    const originalHit=document.elementFromPoint;
    document.elementFromPoint=()=>target;
    source.setPointerCapture=()=>{};
    const event=(type:string,y:number) => new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:1,pointerType:'mouse',button:0,clientX:100,clientY:y});
    try {
      await act(async ()=>source.dispatchEvent(event('pointerdown',10)));
      await act(async ()=>window.dispatchEvent(event('pointermove',59)));
      expect(target.getAttribute('data-drop')).toBe('after');
      await act(async ()=>window.dispatchEvent(event('pointerup',59)));
    } finally { document.elementFromPoint=originalHit; }
    expect(writes).toEqual([{targetId:'target',placement:'after'}]);
    expect(Array.from(container.querySelectorAll('[data-deck-id]')).map(n=>n.getAttribute('data-deck-id'))).toEqual(['target','deck']);
  });
  test('narrow selection opens details and Back restores the tree; failed forecast is explicit', async () => {
    const width=window.innerWidth;
    Object.defineProperty(window,'innerWidth',{value:432,configurable:true});
    const fallback=globalThis.fetch;
    globalThis.fetch = adaptRecoveryFetch((async(url:any,init?:RequestInit)=>String(url).includes('/stats/forecast') ? Response.json({error:'unavailable'},{status:503}) : fallback(url,init)) as typeof fetch);
    try {
      await render(<NNDecks />);
      expect(container.querySelector('.reomi-deck-details')).toBeNull();
      await act(async()=>container.querySelector<HTMLElement>('[data-deck-id="deck"]')!.click());
      expect(container.querySelector('.reomi-deck-detail-total')?.textContent).toContain('601');
      expect(container.querySelector('.reomi-deck-details [role="alert"]')?.textContent).toContain('Could not refresh the forecast');
      expect(container.querySelector('.reomi-deck-forecast')).toBeNull();
      await act(async()=>container.querySelector<HTMLButtonElement>('.reomi-deck-back')!.click());
      expect(container.querySelector('.reomi-deck-details')).toBeNull();
    } finally { Object.defineProperty(window,'innerWidth',{value:width,configurable:true}); }
  });
});


test('deck forecast renders the server study-day labels', async () => {
  const fallback=globalThis.fetch;
  globalThis.fetch = adaptRecoveryFetch((async(url:any,init?:RequestInit)=>String(url).includes('/stats/forecast')
    ? Response.json({days:7,labels:['2026-03-08','2026-03-09'],buckets:[{day:'2026-03-08',count:7}],overdueCount:2,total:7}) : fallback(url,init)) as typeof fetch);
  await render(<NNDecks/>);
  await act(async()=>container.querySelector<HTMLElement>('[data-deck-id="deck"]')!.click());
  const bars = [...container.querySelectorAll('.reomi-deck-forecast strong')].map((node) => node.textContent);
  expect(bars).toEqual(['7', '0']);
  expect(container.querySelector('.reomi-deck-forecast')?.getAttribute('aria-label')).toBe('2026-03-08: 7, 2026-03-09: 0');
  expect(container.querySelector('.reomi-deck-details')?.textContent).toContain('Overdue before today: 2');
  expect(container.textContent).not.toContain('Days in UTC');
});

test('failed move leaves the authoritative tree intact and offers retry in the dialog', async () => {
  const fallback=globalThis.fetch;
  globalThis.fetch = adaptRecoveryFetch((async(url:any,init?:RequestInit)=>String(url).endsWith('/deck/move') ? Response.json({error:'unavailable'},{status:503}) : fallback(url,init)) as typeof fetch);
  await render(<NNDecks/>);
  const initial=useNN.getState().decks;
  await act(async()=>container.querySelector<HTMLButtonElement>('.reomi-deck-drag-handle')!.click());
  await act(async()=>container.querySelector<HTMLButtonElement>('dialog[open] button[type="submit"]')!.click());
  expect(useNN.getState().decks).toEqual(initial);
  expect(container.querySelector('dialog[open] .nn-save-feedback')?.textContent).toContain('Checking whether the change was saved');
  expect(container.querySelector<HTMLButtonElement>('dialog[open] button[type="submit"]')?.disabled).toBe(true);
  expect([...container.querySelectorAll('dialog[open] button')].some(button => button.textContent === 'Retry')).toBe(true);
});

test('pointer drag rejects descendants and Escape cancels without a write', async () => {
  const deck=useNN.getState().decks[0];
  useNN.setState({decks:[deck,{...deck,id:'child',name:'Child',parentId:deck.id},{...deck,id:'target',name:'Target'}]});
  const fallback=globalThis.fetch,writes:any[]=[];
  globalThis.fetch = adaptRecoveryFetch((async(url:any,init?:RequestInit)=>{if(String(url).includes('/move')) writes.push(init); return fallback(url,init);}) as typeof fetch);
  await render(<NNDecks/>);
  const source=container.querySelector<HTMLElement>('[data-deck-id="deck"] .reomi-deck-drag-handle')!;
  const child=container.querySelector<HTMLElement>('[data-deck-id="child"]')!,target=container.querySelector<HTMLElement>('[data-deck-id="target"]')!;
  const originalHit=document.elementFromPoint;
  source.setPointerCapture=()=>{};
  target.getBoundingClientRect=()=>({top:0,height:60,bottom:60,left:0,right:600,width:600,x:0,y:0,toJSON(){}});
  const event=(type:string,y:number)=>new PointerEvent(type,{bubbles:true,cancelable:true,pointerId:1,pointerType:'mouse',button:0,clientX:100,clientY:y});
  try {
    document.elementFromPoint=()=>child;
    await act(async()=>source.dispatchEvent(event('pointerdown',0)));
    await act(async()=>window.dispatchEvent(event('pointermove',30)));
    expect(child.getAttribute('data-drop')).toBeNull();
    await act(async()=>window.dispatchEvent(event('pointerup',30)));
    document.elementFromPoint=()=>target;
    await act(async()=>source.dispatchEvent(event('pointerdown',0)));
    await act(async()=>window.dispatchEvent(event('pointermove',30)));
    expect(target.getAttribute('data-drop')).toBe('inside');
    await act(async()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));
    await act(async()=>window.dispatchEvent(event('pointerup',30)));
    expect(writes).toEqual([]);
    expect(container.querySelector('[data-dragging]')).toBeNull();
  } finally { document.elementFromPoint=originalHit; }
});
