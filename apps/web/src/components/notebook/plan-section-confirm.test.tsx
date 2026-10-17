import { ensureTestDom, GlobalRegistrator } from '../../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { applyPlanSelections, type PlanOffer } from '@reomi/shared';
import type { ToolCallVM } from '../../lib/chat-activity';
import en from '../../lib/messages/en';
import ru from '../../lib/messages/ru';
import { I18nProvider } from '../../lib/i18n';
import { useNN } from '../../lib/store';

ensureTestDom();
import type { ConfirmPayload } from '../chat/chat-presentation';

const { createRoot } = await import('react-dom/client');
const { ConfirmControls } = await import('../chat/chat-presentation');
const { PlanPanel, useNotebookPlan } = await import('./plan-panel');

const POD = 'https://kubernetes.io/docs/concepts/workloads/pods/';
const DEPLOYMENT = 'https://kubernetes.io/docs/concepts/workloads/deployments/';
const TASK_POD = 'https://kubernetes.io/docs/tasks/run-application/run-a-pod/';
const TASK_DEPLOY = 'https://kubernetes.io/docs/tasks/run-application/deploy-an-app/';
const API = 'https://kubernetes.io/docs/reference/kubernetes-api/workload-resources/pod-v1/';
const WORKLOADS = '/docs/concepts/workloads/';
const TASKS = '/docs/tasks/run-application/';
const REFERENCE = '/docs/reference/kubernetes-api/';
const NOTEBOOK = 'nb-pages';

const args = {
  goal: 'Learn Kubernetes workloads',
  level: null,
  modules: [{
    title: 'Workloads',
    outcome: 'Run pods and deployments.',
    prerequisiteIndexes: [],
    urls: ['https://kubernetes.io/docs/'],
  }],
};

const offer: PlanOffer = {
  modules: [{
    sections: [
      {
        prefix: WORKLOADS,
        kind: 'content',
        selected: true,
        pages: [
          { url: POD, title: 'Pod', estimatedTokens: 1200 },
          { url: DEPLOYMENT, title: 'Deployment', estimatedTokens: 1200 },
        ],
      },
      {
        prefix: TASKS,
        kind: 'content',
        selected: true,
        pages: [
          { url: TASK_POD, title: 'Run a pod', estimatedTokens: 1200 },
          { url: TASK_DEPLOY, title: 'Deploy an app', estimatedTokens: 1200 },
        ],
      },
      {
        prefix: REFERENCE,
        kind: 'reference',
        selected: false,
        pages: [{ url: API, title: 'Pod v1', estimatedTokens: 1200 }],
      },
    ],
    ignoredUrls: ['https://kubernetes.io/docs/'],
    docVersion: null,
    needsPages: false,
    catalog: { v: 1, remainingTokens: 0, entries: [], pending: [] },
  }],
};

const toolCall: ToolCallVM = {
  id: 'call-plan',
  name: 'create_topic_plan',
  args,
  status: 'ok',
  awaitingConfirmation: true,
  impact: { planOffer: offer },
};

const plannedPlan = {
  notebook: { id: NOTEBOOK, title: 'Kubernetes' },
  plan: {
    id: 'plan-pages',
    userId: 'plan-owner',
    goal: 'Learn Kubernetes workloads',
    level: null,
    modules: [
      {
        id: 'mod-workloads', position: 0, title: 'Workloads', outcome: 'Run pods',
        prerequisiteIds: [], status: 'readable',
        sources: [{ sourceId: 'src-pods', title: 'Pods page', openable: true }],
      },
      {
        id: 'mod-services', position: 1, title: 'Services', outcome: 'Expose pods',
        prerequisiteIds: [], status: 'readable',
        sources: [{ sourceId: 'src-svc', title: 'Service page', openable: true }],
      },
      {
        id: 'mod-storage', position: 2, title: 'Storage', outcome: 'Keep data',
        prerequisiteIds: [], status: 'planned',
        sources: [{ sourceId: 'src-vol', title: 'Volume page', openable: false }],
      },
    ],
  },
};

const loadedPlan = {
  ...plannedPlan,
  plan: {
    ...plannedPlan.plan,
    modules: plannedPlan.plan.modules.map((module) => (
      module.id === 'mod-storage' ? { ...module, status: 'ingesting' } : module
    )),
  },
};

function translate(locale: 'en' | 'ru') {
  const dict = locale === 'en' ? en : ru;
  return (key: string, params?: Record<string, string | number>) => {
    const value = key.split('.').reduce<unknown>((node, part) => {
      if (node && typeof node === 'object' && part in (node as Record<string, unknown>)) {
        return (node as Record<string, unknown>)[part];
      }
      return undefined;
    }, dict);
    const template = typeof value === 'string' ? value : key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (_, name: string) => (name in params ? String(params[name]) : `{${name}}`));
  };
}

function section(prefix: string) {
  return [...document.querySelectorAll('section')].find((el) => el.querySelector('h4')?.textContent === prefix);
}

function leaveOut(prefix: string, pageTitle?: string) {
  const card = section(prefix);
  const region = pageTitle
    ? [...(card?.querySelectorAll('li') ?? [])].find((el) => el.querySelector('span')?.textContent === pageTitle)
    : card?.querySelector('header');
  return [...(region?.querySelectorAll('button') ?? [])].find((el) => el.textContent === 'Leave out');
}

function moduleSection(title: string) {
  return [...document.querySelectorAll('.reomi-notebook-plan section')].find((el) => el.querySelector('h3')?.textContent === title);
}

function PlanDock({ notebookId }: { notebookId: string }) {
  const read = useNotebookPlan(notebookId);
  if (read.load !== 'present') return null;
  return (
    <PlanPanel
      plan={read.plan}
      onOpenSource={() => {}}
      onLoadModule={(moduleId) => { void read.loadModule(moduleId); }}
    />
  );
}

let root: Root;
let host: HTMLDivElement;
const polls: number[] = [];
const realSetInterval = globalThis.setInterval;

beforeEach(() => {
  ensureTestDom();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  localStorage.setItem('reomi:locale', 'en');
  polls.length = 0;
  globalThis.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (timeout === 2000) polls.push(timeout);
    return realSetInterval(handler, timeout, ...args);
  }) as typeof setInterval;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  globalThis.setInterval = realSetInterval;
  useNN.getState().reset();
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
});

afterAll(() => { try { GlobalRegistrator.unregister(); } catch { /* already unregistered */ } });

test('a docs confirm card shows the workloads count, drops the tasks section, and a planned module loads its pages', async () => {
  const payloads: ConfirmPayload[] = [];
  await act(async () => {
    root.render(
      <ConfirmControls
        toolCall={toolCall}
        t={translate('en')}
        onConfirm={(_decision, payload) => { if (payload) payloads.push(payload); }}
      />,
    );
  });

  const workloads = section(WORKLOADS);
  expect(workloads?.textContent).toContain('2 pages · 2400 tokens');
  const reference = section(REFERENCE);
  expect(reference?.textContent).toContain('Not included');
  expect(reference?.querySelector('button')).toBeNull();
  expect(host.querySelector('input, select')).toBeNull();

  await act(async () => { leaveOut(WORKLOADS, 'Pod')!.click(); });
  await act(async () => { leaveOut(TASKS)!.click(); });
  await act(async () => {
    [...host.querySelectorAll('button')].find((el) => el.textContent === 'Apply')!.click();
  });

  expect(payloads).toEqual([{
    planSelections: [
      {
        moduleIndex: 0,
        prefix: WORKLOADS,
        include: true,
        pages: [{ url: POD, include: false }],
      },
      { moduleIndex: 0, prefix: TASKS, include: false },
    ],
  }]);
  expect(applyPlanSelections(args, offer, payloads[0]?.planSelections)?.modules[0]?.pages.map((page) => page.url)).toEqual([
    DEPLOYMENT,
  ]);

  await act(async () => {
    root.render(<ConfirmControls toolCall={toolCall} t={translate('ru')} onConfirm={() => {}} />);
  });
  expect(section(WORKLOADS)?.textContent).toContain('2 стр. · 2400 токенов');
  expect(section(REFERENCE)?.textContent).toContain('Не входит');

  let planReads = 0;
  const opened: string[] = [];
  useNN.setState({
    getNotebookPlan: async () => {
      planReads += 1;
      return plannedPlan;
    },
    openNotebookPlanModule: async (id: string, moduleId: string) => {
      opened.push(`${id}:${moduleId}`);
      return loadedPlan;
    },
  } as never);
  polls.length = 0;
  await act(async () => {
    root.render(
      <I18nProvider>
        <PlanDock notebookId={NOTEBOOK} />
      </I18nProvider>,
    );
  });
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  const storage = moduleSection('Storage');
  expect(storage?.textContent).toContain('Planned');
  expect(storage?.textContent).toContain('Load pages');
  expect([...(storage?.querySelectorAll('button') ?? [])].filter((el) => el.textContent === 'Open')).toHaveLength(0);
  expect([...host.querySelectorAll('button')].filter((el) => el.textContent === 'Load pages')).toHaveLength(1);
  expect([...host.querySelectorAll('button')].filter((el) => el.textContent === 'Open')).toHaveLength(2);
  expect(planReads).toBe(1);
  expect(polls).toHaveLength(0);
  expect(host.querySelector('.reomi-notebook-plan input, .reomi-notebook-plan select')).toBeNull();

  await act(async () => {
    [...(storage?.querySelectorAll('button') ?? [])].find((el) => el.textContent === 'Load pages')!.click();
  });
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  expect(opened).toEqual([`${NOTEBOOK}:mod-storage`]);
  expect(moduleSection('Storage')?.textContent).toContain('Still loading');
  expect(moduleSection('Storage')?.textContent).not.toContain('Load pages');
  expect(planReads).toBe(1);
  expect(polls).toHaveLength(1);

  await act(async () => root.unmount());
  root = createRoot(host);
  localStorage.setItem('reomi:locale', 'ru');
  polls.length = 0;
  await act(async () => {
    root.render(
      <I18nProvider>
        <PlanDock notebookId={NOTEBOOK} />
      </I18nProvider>,
    );
  });
  for (let i = 0; i < 4; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(moduleSection('Storage')?.textContent).toContain('Загрузить страницы');
  expect(polls).toHaveLength(0);
});
