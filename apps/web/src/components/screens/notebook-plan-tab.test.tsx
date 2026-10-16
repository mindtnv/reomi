import { ensureTestDom, GlobalRegistrator } from '../../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext, SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { AppNavigationProvider } from '../navigation';
import { DialogProvider } from '../dialog';
import { I18nProvider } from '../../lib/i18n';
import { useNN } from '../../lib/store';
import type { AssistantTransport } from '../../lib/assistant-controller';

ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { NotebookWorkspace } = await import('./notebook-workspace');
const { AssistantProvider } = await import('../chat/assistant-provider');

const NOTEBOOK = 'nb-plan';
const READY = 'src-ready';
const PENDING = 'src-pending';
const INDEXING = 'src-indexing';
const INDEX_FAILED = 'src-index-failed';
const PARSE_FAILED = 'src-parse-failed';
const DOCK_KEY = `nn:nb:docktab:${NOTEBOOK}`;
const STORED_DOCK_KEY = `reomi:nb:docktab:${NOTEBOOK}`;

const studiedPlan = {
  notebook: { id: NOTEBOOK, title: 'Algebra' },
  plan: {
    id: 'plan-1',
    userId: 'plan-owner',
    goal: 'Learn algebra',
    level: 'intro',
    modules: [
      {
        id: 'mod-empty', position: 0, title: 'Empty chapter', outcome: 'Nothing yet',
        prerequisiteIds: [], status: 'empty', sources: [],
      },
      {
        id: 'mod-loading', position: 1, title: 'Loading chapter', outcome: 'Wait for the draft',
        prerequisiteIds: [], status: 'ingesting',
        sources: [
          { sourceId: PENDING, title: 'Draft page', openable: false },
          { sourceId: READY, title: 'Ready page', openable: true },
        ],
      },
      {
        id: 'mod-readable', position: 2, title: 'Readable chapter', outcome: 'Read both pages',
        prerequisiteIds: [], status: 'readable',
        sources: [
          { sourceId: INDEXING, title: 'Indexing page', openable: true },
          { sourceId: INDEX_FAILED, title: 'Index failed page', openable: true },
        ],
      },
      {
        id: 'mod-closed', position: 3, title: 'Closed chapter', outcome: 'Parser failed',
        prerequisiteIds: [], status: 'unavailable',
        sources: [{ sourceId: PARSE_FAILED, title: 'Broken page', openable: false }],
      },
    ],
  },
};

const textSource = (id: string, title: string) => ({
  id, title, kind: 'text', status: 'ready', errorCode: null, chunkCount: 1, charCount: 12,
});

let root: Root;
let host: HTMLDivElement;
let oldFetch: typeof fetch;
let params: URLSearchParams;
let pushes: string[];
const calls: { method: string; url: string }[] = [];
const originalWidth = window.innerWidth;
const cardWrite = async () => { throw new Error('card write'); };

const transport: AssistantTransport = {
  create: async () => ({ id: 'thread', title: 'Test', updatedAt: '2026-10-01T00:00:00.000Z', contextVersion: 1, context: { version: 1, policy: 'focus', pins: [], refs: [], revision: 0 } }) as never,
  load: async () => ({ conversation: { id: 'thread', title: 'Test', updatedAt: '2026-10-01T00:00:00.000Z' } as never, messages: [] }),
  stream: async () => {},
  resume: async () => {},
  regenerate: async () => {},
};
const statusLoader = async () => ({ chatEnabled: false, models: [], assistant: { contextVersion: 1, objectSearch: true, maxConcurrentTurns: 3, sourceStudy: true } });

function radio(label: string) {
  return [...document.querySelectorAll('button[role="radio"]')].find((el) => el.textContent === label) as HTMLButtonElement | undefined;
}

function moduleSection(status: string) {
  return [...document.querySelectorAll('.reomi-notebook-plan section')].find((el) => el.textContent?.includes(status));
}

function openButtons(section: Element | undefined) {
  return [...(section?.querySelectorAll('button') ?? [])].filter((button) => button.textContent === 'Open');
}

beforeEach(() => {
  ensureTestDom();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(window, 'innerWidth', { value: 1100, writable: true, configurable: true });
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem('reomi:locale', 'en');
  history.replaceState({}, '');
  calls.length = 0;
  pushes = [];
  params = new URLSearchParams();
  oldFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ method: (init?.method ?? 'GET').toUpperCase(), url });
    return Response.json({ chatEnabled: false, items: [], nextCursor: null, nextOffset: null, models: [] });
  }) as typeof fetch;
  useNN.setState({
    profile: { userId: 'plan-owner' } as never,
    listNotebooks: async () => [{ id: NOTEBOOK, title: 'Algebra', updatedAt: '2026-10-01T00:00:00.000Z', noteCount: 0 }] as never,
    listSources: async () => [],
    getNotebook: async () => ({ id: NOTEBOOK, title: 'Algebra', updatedAt: '2026-10-01T00:00:00.000Z', overview: null, suggestedQuestions: [] }) as never,
    getNotebookPlan: async () => studiedPlan,
    listNotebookNotes: async () => [],
    getNotebookNote: async () => ({ id: 'note-1', title: 'Saved', content: 'A note', kind: 'manual', pinned: false, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' }) as never,
    createNotebookNote: cardWrite,
    patchNotebookNote: cardWrite,
    deleteNotebookNote: cardWrite,
    listArtifacts: async () => [],
    createArtifact: cardWrite,
    getArtifact: async () => null as never,
    deleteArtifact: cardWrite,
    regenerateArtifact: cardWrite,
    submitQuizAttempt: cardWrite,
    listQuizAttempts: async () => [],
    getCoverage: async () => ({ sources: [], gaps: [] }) as never,
    conceptMap: async () => ({ nodes: [], edges: [] }) as never,
    suggestSources: async () => ({ items: [] }) as never,
    generateOverview: cardWrite,
    getSource: async (id: string) => textSource(id, 'Ready page') as never,
    getLibraryItem: async (id: string) => ({ ...textSource(id, 'Ready page'), readingState: null }) as never,
    getSourceChunks: async () => ({ items: [{ id: 'chunk', sourceId: READY, position: 0, text: 'A page.' }], total: 1, nextFrom: null }) as never,
    listSourceCards: async () => [],
    putReadingState: async () => ({}) as never,
    patchLibraryItem: cardWrite,
    uploadMedia: cardWrite,
    addUrlSource: cardWrite,
    addTextSource: cardWrite,
    uploadSource: cardWrite,
    renameSource: cardWrite,
    attachSources: cardWrite,
    detachSource: cardWrite,
    listLibrary: async () => ({ items: [] }) as never,
  } as never);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.querySelector('.reomi-notebook-source-reader')?.remove();
  globalThis.fetch = oldFetch;
  useNN.getState().reset();
  window.innerWidth = originalWidth;
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

afterAll(() => { try { GlobalRegistrator.unregister(); } catch { /* already unregistered */ } });

const router = {
  bfcacheId: 'test',
  push(href: string) { pushes.push(href); },
  replace() {},
  back() {},
  forward() {},
  refresh() {},
  prefetch() {},
  hmrRefresh() {},
};

function tree() {
  return (
    <AppRouterContext.Provider value={router as never}>
      <PathnameContext.Provider value={`/notebooks/${NOTEBOOK}`}>
        <SearchParamsContext.Provider value={params}>
          <I18nProvider>
            <AppNavigationProvider>
              <DialogProvider>
                {/* The notebook chat entry reads the shell assistant. Without it the dock never mounts. */}
                <AssistantProvider transportFactory={() => transport} statusLoader={statusLoader}>
                  <NotebookWorkspace notebookId={NOTEBOOK} />
                </AssistantProvider>
              </DialogProvider>
            </AppNavigationProvider>
          </I18nProvider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );
}

async function renderWorkspace() {
  await act(async () => { root.render(tree()); });
  for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function storageUntouched() {
  expect(localStorage.getItem(STORED_DOCK_KEY)).toBeNull();
  expect(localStorage.getItem(DOCK_KEY)).toBeNull();
}

test('a notebook with a studied plan selects Plan and shows every module status', async () => {
  await renderWorkspace();
  expect(radio('Plan')?.getAttribute('aria-checked')).toBe('true');
  expect(radio('Overview')?.getAttribute('aria-checked')).toBe('false');
  const plan = document.querySelector('.reomi-notebook-plan');
  expect(plan).not.toBeNull();
  expect(plan!.textContent).toContain('Learn algebra');
  expect(plan!.textContent).toContain('intro');
  expect(plan!.textContent).toContain('Empty chapter');
  expect(plan!.textContent).toContain('No pages yet');
  const loading = moduleSection('Still loading');
  expect(loading?.textContent).toContain('Draft page');
  expect(loading?.textContent).toContain('Ready page');
  expect(openButtons(loading).map((button) => button.textContent)).toEqual(['Open']);
  const readable = moduleSection('Ready to read');
  expect(readable?.textContent).toContain('Indexing page');
  expect(readable?.textContent).toContain('Index failed page');
  expect(openButtons(readable)).toHaveLength(2);
  const closed = moduleSection('Unavailable');
  expect(closed?.textContent).toContain('Broken page');
  expect(openButtons(closed)).toHaveLength(0);
  expect(plan!.querySelector('input, textarea, form')).toBeNull();
  storageUntouched();
});

test('a stored Overview stays selected while Plan remains available', async () => {
  localStorage.setItem(STORED_DOCK_KEY, 'overview');
  await renderWorkspace();
  expect(radio('Overview')?.getAttribute('aria-checked')).toBe('true');
  expect(radio('Plan')).not.toBeUndefined();
  expect(document.querySelector('.reomi-notebook-plan')).toBeNull();
  expect(document.body.textContent).toContain('Add sources to generate an overview.');
});

test('note and artifact deep links select their tabs without writing dock storage', async () => {
  params = new URLSearchParams('note=note-1');
  await renderWorkspace();
  expect(radio('Notes')?.getAttribute('aria-checked')).toBe('true');
  storageUntouched();

  await act(async () => root.unmount());
  params = new URLSearchParams('newNote=1');
  root = createRoot(host);
  await renderWorkspace();
  expect(radio('Notes')?.getAttribute('aria-checked')).toBe('true');
  storageUntouched();

  await act(async () => root.unmount());
  params = new URLSearchParams('artifact=artifact-1');
  root = createRoot(host);
  await renderWorkspace();
  expect(radio('Studio')?.getAttribute('aria-checked')).toBe('true');
  storageUntouched();
});

test('Overview and Studio replace the plan surface', async () => {
  await renderWorkspace();
  await act(async () => { radio('Overview')!.click(); });
  expect(document.querySelector('.reomi-notebook-plan')).toBeNull();
  expect([...document.querySelectorAll('.reomi-notebook-dock span')].some((el) => el.textContent === 'Overview')).toBe(true);
  await act(async () => { radio('Studio')!.click(); });
  expect(document.body.textContent).toContain('Connect a chat model to generate study documents.');
  expect(document.querySelector('.reomi-notebook-plan')).toBeNull();
});

test('Open on a readable link shows the notebook reader and does not create a card', async () => {
  await renderWorkspace();
  const open = openButtons(moduleSection('Still loading'))[0];
  expect(open).not.toBeUndefined();
  await act(async () => { open!.click(); });
  const throughClick = calls.slice();
  expect(pushes.at(-1)).toBe(`/notebooks/${NOTEBOOK}?source=${READY}`);
  params = new URLSearchParams(`source=${READY}`);
  await renderWorkspace();
  expect(document.querySelector('.reomi-notebook-source-reader')).not.toBeNull();
  expect(throughClick.every((call) => call.method === 'GET')).toBe(true);
  expect(throughClick.some((call) => /\/cards|\/notes|\/reviews|quick-card/.test(call.url))).toBe(false);
});
