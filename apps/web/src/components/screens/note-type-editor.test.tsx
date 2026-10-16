import { ensureTestDom, GlobalRegistrator } from '../../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext, SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { AppNavigationProvider } from '../navigation';
import { DialogProvider } from '../dialog';
import { useNN } from '../../lib/store';
import { readEditorDraft } from '../../lib/editor-drafts';
import { adaptRecoveryFetch } from '../../lib/test-recovery-fetch';
import { noteTypeFromApi } from '../../lib/mappers';

ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { NNNoteTypeEditor } = await import('./note-type-editor');
const type = { id: 'type', name: 'My draft', kind: 'custom', styling: '', isBuiltin: false,
  updatedAt: '2026-09-19T00:00:00.000Z',
  fields: [{ id: 'q', name: 'Q', ord: 0 }, { id: 'a', name: 'A', ord: 1 }],
  templates: [{ id: 'forward', name: 'Forward', ord: 0, frontTemplate: '{{Q}}', backTemplate: '{{A}}' },
    { id: 'reverse', name: 'Reverse', ord: 1, frontTemplate: '{{A}}', backTemplate: '{{Q}}' }],
};
const router = { bfcacheId: 'test', push() {}, replace() {}, back() {}, forward() {}, refresh() {}, prefetch() {}, hmrRefresh() {} };
let root: Root;
let host: HTMLDivElement;
let savedFetch: typeof fetch;
beforeEach(() => {
  ensureTestDom(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  savedFetch = globalThis.fetch;
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  localStorage.clear(); sessionStorage.clear();
  useNN.setState({ profile: { userId: 'type-editor-owner' } as any, bootstrapped: true, noteTypes: [noteTypeFromApi(type)], cards: [] });
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); globalThis.fetch = savedFetch;
  useNN.getState().reset(); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});
afterAll(() => { try { GlobalRegistrator.unregister(); } catch {} });
const button = (text: string) => Array.from(host.querySelectorAll('button')).find((node) => node.textContent?.includes(text))!;
async function render(search = new URLSearchParams({ edit: type.id }), adapt = true) {
  if (adapt) globalThis.fetch = adaptRecoveryFetch(globalThis.fetch);
  await act(async () => root.render(<AppRouterContext.Provider value={router}><PathnameContext.Provider value="/note-types">
    <SearchParamsContext.Provider value={search}><AppNavigationProvider><DialogProvider>
      <NNNoteTypeEditor />
    </DialogProvider></AppNavigationProvider></SearchParamsContext.Provider>
  </PathnameContext.Provider></AppRouterContext.Provider>));
}

describe('note type confirmation UI', () => {
  test('unsupported CSS is read-only and remains preserved on save', async () => {
    const css = '.card { color: red; }';
    useNN.setState({ noteTypes: [noteTypeFromApi({ ...type, styling: css })] });
    let saved: any;
    globalThis.fetch = (async (_url: any, init: any) => {
      if (init.method === 'GET') return Response.json({ items: [] });
      const body = JSON.parse(init.body);
      if (body.preview) return Response.json({ sourceVersion: type.updatedAt, confirmationToken: 'unchanged', impact: {
        willCreateCards: 0, willKeepCards: 0, willDeleteCards: 0, willDeleteReviews: 0, removedCards: [],
      } });
      saved = body; return Response.json({ ...type, ...body });
    }) as typeof fetch;
    await render();
    const stored = host.querySelector('[aria-label="noteTypes.styling.saved"]') as HTMLTextAreaElement;
    expect(stored.value).toBe(css);
    expect(stored.readOnly).toBe(true);
    expect(Array.from(host.querySelectorAll('textarea:not([readonly])')).some((field) => (field as HTMLTextAreaElement).value === css)).toBe(false);
    await act(async () => button('noteTypes.actions.save').click());
    expect(saved.styling).toBe(css);
  });
  test('shows the deletion impact before applying and reuses its exact confirmation', async () => {
    const requests: any[] = [];
    globalThis.fetch = (async (_url: any, init: any) => {
      const body = JSON.parse(init.body); requests.push(body);
      return Response.json(body.preview ? { sourceVersion: type.updatedAt, confirmationToken: 'consent', impact: {
        willCreateCards: 0, willKeepCards: 1, willDeleteCards: 1, willDeleteReviews: 9,
        removedCards: [{ id: 'removed', front: 'Removed question', reviews: 9 }],
      } } : { ...type, templates: body.templates });
    }) as typeof fetch;
    await render();
    await act(async () => (host.querySelectorAll('[aria-label="noteTypes.templates.remove"]')[1] as HTMLButtonElement).click());
    await act(async () => { button('noteTypes.actions.save').click(); button('noteTypes.actions.save').click(); });
    expect(requests).toHaveLength(1);
    expect((host.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(true);
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain('Removed question (9)');
    const dialogButtons = host.querySelector('[role="dialog"]')!.querySelectorAll('button');
    await act(async () => (dialogButtons[dialogButtons.length - 1] as HTMLButtonElement).click());
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ confirmationToken: 'consent', expectedUpdatedAt: type.updatedAt });
    expect(requests[1].templates).toHaveLength(1);
  });

  test('conflict shows the current saved type and retains the local draft', async () => {
    globalThis.fetch = (async (_url: any, init: any) => init?.method === 'PATCH' || init?.method === 'POST'
      ? Response.json({ error: 'note_type_changed' }, { status: 409 })
      : Response.json([{ ...type, name: 'Other tab saved', updatedAt: '2026-09-19T00:01:00.000Z' }])) as typeof fetch;
    await render();
    await act(async () => button('noteTypes.actions.save').click());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('noteTypes.errors.changed');
    expect(host.textContent).toContain('Other tab saved');
    expect((host.querySelector('input') as HTMLInputElement).value).toBe('My draft');
    expect(host.querySelectorAll('textarea')[0].value).toBe('{{Q}}');
  });

  test('leaving while preview is pending does not open a stale dialog or apply changes', async () => {
    const response = Promise.withResolvers<Response>();
    let requests = 0;
    globalThis.fetch = (async () => { requests++; return response.promise; }) as unknown as typeof fetch;
    await render();
    await act(async () => button('noteTypes.actions.save').click());
    await act(async () => root.render(<div>Another screen</div>));
    await act(async () => response.resolve(Response.json({ sourceVersion: type.updatedAt, confirmationToken: 'old',
      impact: { willCreateCards: 1, willKeepCards: 2, willDeleteCards: 0, willDeleteReviews: 0, removedCards: [] } })));
    expect(requests).toBe(1);
    expect(host.textContent).toBe('Another screen');
  });
});

test('invalid existing notes keep the draft open and prevent applying the type', async () => {
  let requests = 0;
  globalThis.fetch = (async () => { requests++; return Response.json({ sourceVersion: type.updatedAt, confirmationToken: 'blocked',
    impact: { willCreateCards: 0, willKeepCards: 0, willDeleteCards: 2, willDeleteReviews: 0, removedCards: [] },
    validation: { checkedNotes: 2, invalidNotes: 2, samples: [{ front: 'Real saved question', questions: [], omittedTemplates: ['Forward'], error: 'no_cards_generated' }] },
  }); }) as unknown as typeof fetch;
  await render();
  await act(async () => button('noteTypes.actions.save').click());
  expect(requests).toBe(1);
  expect(host.textContent).toContain('noteTypes.validation.blocked');
  expect(host.textContent).toContain('Real saved question');
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});

test('type-in authors can explicitly select an answer field', async () => {
  useNN.setState({ noteTypes: [noteTypeFromApi({ ...type, kind: 'typein', fields: type.fields.map((field, index) => ({ ...field, typeinAnswer: index === 1 })) })] });
  let saved: any;
  globalThis.fetch = (async (_url: any, init: any) => {
    if (init.method === 'GET') return Response.json({ items: [] });
    const body = JSON.parse(init.body);
    if (body.preview) return Response.json({ sourceVersion: type.updatedAt, confirmationToken: 'role', impact: { willCreateCards: 0, willKeepCards: 0, willDeleteCards: 0, willDeleteReviews: 0, removedCards: [] } });
    saved = body; return Response.json({ ...type, ...body });
  }) as typeof fetch;
  await render();
  const select = host.querySelector('[aria-label^="noteTypes.answerField"]') as HTMLButtonElement;
  expect(select.textContent).toContain('A');
  await act(async () => select.click());
  await act(async () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((option) => option.textContent === 'Q')!.click());
  await act(async () => button('noteTypes.actions.save').click());
  expect(saved.fields.filter((field: any) => field.typeinAnswer).map((field: any) => field.name)).toEqual(['Q']);
});


test('mode conversion previews separately and applies only the exact confirmed impact', async () => {
  const writes: { url: string; body: any }[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    if (init?.method === 'GET') return Response.json({ items: [] });
    const body = JSON.parse(init.body); writes.push({ url: String(url), body });
    if (String(url).endsWith('/kind/preview')) return Response.json({ sourceVersion: type.updatedAt, confirmationToken: 'kind-consent',
      kindTransition: { from: 'custom', to: 'typein', resetsQuestions: true },
      impact: { willCreateCards: 2, willKeepCards: 0, willDeleteCards: 2, willDeleteReviews: 8, removedCards: [] },
      validation: { checkedNotes: 1, invalidNotes: 0, samples: [{ front: 'Question', questions: ['Question'], answer: 'Answer', omittedTemplates: [] }] },
    });
    return Response.json({ ...type, kind: body.kind });
  }) as typeof fetch;
  await render(new URLSearchParams({ kind: type.id }));
  const modeDialog = document.querySelector('[aria-labelledby="note-type-mode-title"]')!;
  expect(modeDialog.textContent).toContain('noteTypes.kind.intro');
  expect(host.textContent).toContain('noteTypes.list.title');
  const mode = modeDialog.querySelector('[aria-label^="noteTypes.kind.mode"]') as HTMLButtonElement;
  await act(async () => mode.click());
  await act(async () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((option) => option.textContent === 'editor.variants.type')!.click());
  await act(async () => Array.from(modeDialog.querySelectorAll('button')).find(button => button.textContent?.includes('noteTypes.kind.preview'))!.click());
  expect(writes).toHaveLength(1);
  expect(writes[0].body).toMatchObject({ kind: 'typein', answerFieldId: 'a', expectedUpdatedAt: type.updatedAt });
  const dialog = host.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain('noteTypes.kind.reset');
  expect(dialog.textContent).toContain('Question');
  const buttons = dialog.querySelectorAll('button');
  await act(async () => (buttons[buttons.length - 1] as HTMLButtonElement).click());
  expect(writes).toHaveLength(2);
  expect(writes[1].url).toEndWith('/kind');
  expect(writes[1].body).toMatchObject({ confirmationToken: 'kind-consent', kind: 'typein', answerFieldId: 'a' });
});

test('large type edits keep the draft and offer saving a separate copy without changing notes', async () => {
  const requests: { url: string; method: string; body: any }[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ url: String(url), method: init.method, body });
    if (String(url).includes('/preview')) return Response.json({ error: 'note_type_operation_too_large' }, { status: 413 });
    return Response.json({ ...type, ...body, id: 'new-copy', isBuiltin: false });
  }) as typeof fetch;
  await render();
  const fieldsBefore = Array.from(host.querySelectorAll('textarea')).map(n => n.value);
  await act(async () => button('noteTypes.actions.save').click());
  expect(host.textContent).toContain('noteTypes.errors.tooLarge');
  expect(host.textContent).toContain('noteTypes.errors.copyHint');
  expect(Array.from(host.querySelectorAll('textarea')).map(n => n.value)).toEqual(fieldsBefore);
  await act(async () => button('noteTypes.actions.saveCopy').click());
  expect(requests).toHaveLength(2);
  expect(requests[1]!.method).toBe('POST');
  expect(new URL(requests[1]!.url).pathname).toBe('/note-types');
  expect(requests[1]!.body).toMatchObject({ kind: 'custom', fields: type.fields, templates: type.templates });
  expect(useNN.getState().noteTypes.find(n => n.id === type.id)?.templates).toEqual(type.templates);
  expect(useNN.getState().noteTypes.some(n => n.id === 'new-copy')).toBe(true);
});

test('budget timeout preserves draft and reports a retryable error', async () => {
  globalThis.fetch = (async (_url: any, _init: any) => Response.json({ error: 'note_type_operation_timeout' }, { status: 503 })) as typeof fetch;
  await render();
  await act(async () => button('noteTypes.actions.save').click());
  expect(host.textContent).toContain('noteTypes.errors.busy');
  expect((host.querySelector('fieldset') as HTMLFieldSetElement).disabled).toBe(false);
  expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe(type.templates[0]!.frontTemplate);
});

test('an uncertain type save reconciles its receipt without repeating its preview or write', async () => {
  let previews = 0, writes = 0, requestId = '';
  const committed = { ...type, updatedAt: '2026-09-23T00:00:00.000Z' };
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const path = String(url);
    if (path.endsWith('/session')) return Response.json({ sessionId: '01900000-0000-7000-8000-000000000010' });
    if (path.endsWith('/preview')) { previews++; return Response.json({ sourceVersion: type.updatedAt, confirmationToken: 'consent', impact: { willCreateCards: 0, willKeepCards: 0, willDeleteCards: 0, willDeleteReviews: 0, removedCards: [] } }); }
    if (init?.method === 'PATCH') { writes++; requestId = JSON.parse(String(init.body)).requestId; throw new Error('lost reply'); }
    if (path.includes('/receipts/')) return Response.json({ result: committed, replayed: true, outcome: 'applied', serverTime: new Date().toISOString(),
      receipt: { id: 'receipt', requestId, kind: 'note-type-save', label: type.name, target: { kind: 'note-type', id: type.id, revision: committed.updatedAt },
        createdAt: committed.updatedAt, undoUntil: null, consumedAt: null } });
    return Response.json({ items: [] });
  }) as unknown as typeof fetch;
  await render(new URLSearchParams({ edit: type.id }), false);
  await act(async () => button('noteTypes.actions.save').click());
  expect(host.textContent).toContain('actionsRecovery.uncertain');
  await act(async () => window.dispatchEvent(new Event('pagehide')));
  expect((readEditorDraft({ ownerId: 'type-editor-owner', kind: 'type', entityId: type.id })?.value as any).pendingSave.requestId).toBe(requestId);
  await act(async () => button('actionsRecovery.retry').click());
  expect(writes).toBe(1); expect(previews).toBe(1);
  expect(useNN.getState().noteTypes.find(row => row.id === type.id)?.updatedAt).toBe(committed.updatedAt);
});


test('type draft reload preserves template source and the original definition version', async () => {
  const scope = { ownerId: 'type-draft-owner', kind: 'type' as const, entityId: type.id };
  useNN.setState({ profile: { userId: scope.ownerId } as any });
  try {
    await render();
    const front = host.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(front, '<b>{{Q}}</b>');
      front.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    expect((readEditorDraft(scope)?.value as any).templates[0].frontTemplate).toBe('<b>{{Q}}</b>');
    await act(async () => root.render(null));
    useNN.setState({ noteTypes: [noteTypeFromApi({ ...type, updatedAt: '2026-09-20T00:00:00.000Z' })] });
    await render();
    expect(host.textContent).toContain('editor.draft.stale');
    await act(async () => button('editor.draft.restore').click());
    expect((host.querySelector('textarea') as HTMLTextAreaElement).value).toBe('<b>{{Q}}</b>');
    let request: any;
    globalThis.fetch = (async (_url: any, init: any) => {
      if (init.method === 'GET') return Response.json([{ ...type, updatedAt: '2026-09-20T00:00:00.000Z' }]);
      request = JSON.parse(init.body); return Response.json({ error: 'note_type_changed' }, { status: 409 });
    }) as typeof fetch;
    await act(async () => button('noteTypes.actions.save').click());
    expect(request.expectedUpdatedAt).toBe(type.updatedAt);
    expect(readEditorDraft(scope)).not.toBeNull();
  } finally {
    await act(async () => root.render(null));
    for (let i = localStorage.length - 1; i >= 0; i--) { const key = localStorage.key(i)!; if (key.startsWith('nn:editor-draft:') || key.startsWith('reomi:editor-draft:')) localStorage.removeItem(key); }
  }
});
