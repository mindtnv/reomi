import { ensureTestDom, GlobalRegistrator } from '../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext, SearchParamsContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { AppNavigationProvider, useAppNavigation } from './navigation';
import { readEditorDraft, writeEditorDraft, type DraftScope } from '../lib/editor-drafts';
import { DialogProvider } from './dialog';
import { BASIC_NOTE_TYPE, CLOZE_NOTE_TYPE } from '@reomi/shared';
import { useNN } from '../lib/store';
import { cardFromApi, noteTypeFromApi } from '../lib/mappers';
import { adaptRecoveryFetch } from '../lib/test-recovery-fetch';
import { clearSessionResourceCache } from '../lib/session-resource';

// Re-register before loading DOM-dependent modules; other suites tear the DOM down.
ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { NNCardForm } = await import('./card-form');
const { NNEditor } = await import('./screens/editor');
const { NNCardsBrowser } = await import('./screens/cards-browser');
const { NNCustomStudy } = await import('./screens/custom-study');

const row = { id: '01900000-0000-7000-8000-000000000001', noteId: 'note', deckId: 'deck',
  note: { id: 'note', noteTypeId: BASIC_NOTE_TYPE.id, updatedAt: '2026-09-19T00:00:00.000Z', fieldValues: { Front: 'Question', Back: 'Answer' }, tags: [] },
  noteType: BASIC_NOTE_TYPE };
const card = cardFromApi(row);
const navigations: string[] = [];
const router = { bfcacheId: 'test', push(href: string) { navigations.push(href); }, replace(href: string) { navigations.push(href); }, back() {}, forward() {}, refresh() {}, prefetch() {}, hmrRefresh() {} };
let root: Root;
let container: HTMLDivElement;
let originalFetch: typeof fetch;
const originalUpload = useNN.getState().uploadMedia;

beforeEach(() => {
  ensureTestDom(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  clearSessionResourceCache(); navigations.length = 0;
  originalFetch = globalThis.fetch;
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
  sessionStorage.clear();
  useNN.setState({ profile: { userId: 'card-editor-owner' } as any, bootstrapped: true, cards: [card], noteTypes: [noteTypeFromApi(BASIC_NOTE_TYPE)], decks: [{ id: 'deck', name: 'Study', color: 'lime', species: 'fern', createdAt: 0 }] });
});
afterEach(async () => {
  await act(async () => root.unmount()); container.remove();
  for (let i = localStorage.length - 1; i >= 0; i--) { const key = localStorage.key(i)!; if (key.startsWith('nn:editor-draft:') || key.startsWith('reomi:editor-draft:')) localStorage.removeItem(key); }
  globalThis.fetch = originalFetch; useNN.getState().reset();
  useNN.setState({ uploadMedia: originalUpload });
  delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});
afterAll(() => GlobalRegistrator.unregister());

async function render(props: Partial<React.ComponentProps<typeof NNCardForm>> = {}) {
  await act(async () => root.render(<AppRouterContext.Provider value={router}><PathnameContext.Provider value="/editor">
    <AppNavigationProvider><DialogProvider><NNCardForm card={card} {...props} /></DialogProvider></AppNavigationProvider>
  </PathnameContext.Provider></AppRouterContext.Provider>));
}

function button(key: string) { return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(key))!; }

async function renderEditor(search: URLSearchParams, screen: React.ReactNode = <NNEditor />) {
  await act(async () => root.render(<AppRouterContext.Provider value={router}><PathnameContext.Provider value="/editor"><SearchParamsContext.Provider value={search}>
    <AppNavigationProvider><DialogProvider>{screen}</DialogProvider></AppNavigationProvider>
  </SearchParamsContext.Provider></PathnameContext.Provider></AppRouterContext.Provider>));
}

describe('card editor', () => {
  test('preview switches numbered questions and hides a previously revealed answer', async () => {
    const cloze = cardFromApi({ ...row, renderKind: 'cloze', clozeNumber: 1, noteType: CLOZE_NOTE_TYPE,
      note: { ...row.note, fieldValues: { Text: '{{c1::Paris::city}} is in {{c2::France}}.', Extra: '' } } });
    useNN.setState({ noteTypes: [noteTypeFromApi(CLOZE_NOTE_TYPE)] });
    await render({ card: cloze });
    await act(async () => button('editor.previewToggle').click());
    const preview = container.querySelector('[role="button"]') as HTMLElement;
    expect(preview.textContent).toContain('[city] is in France');
    await act(async () => preview.click());
    expect(preview.textContent).toContain('Paris is in France');
    await act(async () => (container.querySelector('[aria-label^="editor.previewQuestion"]') as HTMLButtonElement).click());
    const option = Array.from(document.querySelectorAll('[role="option"]')).find((node) => node.textContent?.includes('c2'))!;
    await act(async () => (option as HTMLElement).click());
    expect(preview.textContent).toContain('Paris is in […]');
    expect(preview.textContent).not.toContain('France');
  });

  test('preview includes reverse templates instead of always showing template zero', async () => {
    const type = { ...BASIC_NOTE_TYPE, id: 'custom', kind: 'custom' as const, templates: [
      { name: 'Forward', ord: 0, frontTemplate: '{{Front}}', backTemplate: '{{Back}}' },
      { name: 'Reverse', ord: 1, frontTemplate: '{{Back}}', backTemplate: '{{Front}}' },
    ] };
    useNN.setState({ noteTypes: [noteTypeFromApi(type)] });
    await render({ card: cardFromApi({ ...row, noteType: type }) });
    await act(async () => button('editor.previewToggle').click());
    const preview = container.querySelector('[role="button"]') as HTMLElement;
    expect(preview.textContent).toContain('Question');
    await act(async () => (container.querySelector('[aria-label^="editor.previewQuestion"]') as HTMLButtonElement).click());
    const reverse = Array.from(document.querySelectorAll('[role="option"]')).find((node) => node.textContent === 'Reverse')!;
    await act(async () => (reverse as HTMLElement).click());
    expect(preview.textContent).toContain('Answer');
    expect(preview.textContent).not.toContain('Question');
  });

  test('legacy splitting previews and confirms the selected history destination', async () => {
    const clozeRow = { ...row, renderKind: 'cloze', clozeNumber: 0, noteType: CLOZE_NOTE_TYPE,
      note: { ...row.note, fieldValues: { Text: '{{c1::Paris}} {{c2::France}}', Extra: '' } } };
    useNN.setState({ noteTypes: [noteTypeFromApi(CLOZE_NOTE_TYPE)] });
    const requests: any[] = [];
    globalThis.fetch = adaptRecoveryFetch((async (_url: any, init: any) => {
      const body = JSON.parse(init.body); requests.push(body);
      return Response.json(body.preview ? { sourceVersion: row.note.updatedAt, confirmationToken: 'split',
        impact: { willCreateCards: 1, willKeepCards: 1, willDeleteCards: 0, willDeleteReviews: 0, removedCards: [] } }
        : { note: clozeRow.note, cards: [{ ...clozeRow, clozeNumber: 2 }] });
    }) as typeof fetch);
    await render({ card: cardFromApi(clozeRow) });
    await act(async () => button('editor.cloze.split').click());
    await act(async () => (container.querySelector('[aria-label^="editor.cloze.historyTarget"]') as HTMLButtonElement).click());
    const option = Array.from(document.querySelectorAll('[role="option"]')).find((node) => node.textContent === 'c2')!;
    await act(async () => (option as HTMLElement).click());
    await act(async () => button('actions.save').click());
    expect(requests).toHaveLength(1);
    expect(requests[0].clozeRetainHistoryFor).toEqual({ 0: 2 });
    const dialog = container.querySelector('[role="dialog"]')!;
    const apply = Array.from(dialog.querySelectorAll('button')).find((node) => node.textContent === 'editor.cloze.split')!;
    await act(async () => apply.click());
    expect(requests[1]).toMatchObject({ clozeRetainHistoryFor: { 0: 2 }, confirmationToken: 'split' });
  });
  test('double Save and command-Enter submit one request and retain fields on error', async () => {
    let writes = 0;
    const response = Promise.withResolvers<Response>();
    globalThis.fetch = adaptRecoveryFetch((() => { writes++; return response.promise; }) as unknown as typeof fetch);
    await render();
    await act(async () => {
      const save = button('actions.save');
      save.click();
      save.click();
      save.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    });
    expect(writes).toBe(1);
    expect(button('editor.saving').disabled).toBe(true);
    await act(async () => response.resolve(Response.json({ error: 'unavailable' }, { status: 503 })));
    expect(container.querySelector('textarea')!.value).toBe('Question');
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(button('actions.save').disabled).toBe(false);
  });

  test('numbered cloze without a deletion stays in the editor with an actionable error', async () => {
    let writes = 0;
    globalThis.fetch = adaptRecoveryFetch((async () => { writes++; return Response.json({ note: row.note, cards: [] }); }) as unknown as typeof fetch);
    useNN.setState({ noteTypes: [noteTypeFromApi(BASIC_NOTE_TYPE), noteTypeFromApi(CLOZE_NOTE_TYPE)] });
    const cloze = cardFromApi({ ...row, noteType: CLOZE_NOTE_TYPE, renderKind: 'cloze', clozeNumber: 1,
      note: { ...row.note, noteTypeId: CLOZE_NOTE_TYPE.id, fieldValues: { Text: 'Text without a cloze', Extra: '' } } });
    await render({ card: cloze });
    await act(async () => button('actions.save').click());
    expect(writes).toBe(0);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('editor.errors.clozeRequired');
    expect(container.querySelector('textarea')!.value).toBe('Text without a cloze');
  });

  test('missing decks and empty rendered questions cannot submit', async () => {
    let writes = 0;
    globalThis.fetch = adaptRecoveryFetch((async () => { writes++; return Response.json({}); }) as unknown as typeof fetch);
    await render({ card: cardFromApi({ ...row, note: { ...row.note, fieldValues: { Front: '', Back: 'Answer' } } }) });
    await act(async () => button('actions.save').click());
    expect(container.textContent).toContain('editor.errors.noCards');
    expect(writes).toBe(0);
    await act(async () => useNN.setState({ decks: [] }));
    await act(async () => button('actions.save').click());
    expect(container.textContent).toContain('editor.errors.pickDeck');
    expect(writes).toBe(0);
  });

  test('image upload preserves edits made while uploading and blocks premature save', async () => {
    const upload = Promise.withResolvers<{ token: string; mediaId: string }>();
    useNN.setState({ uploadMedia: (() => upload.promise) as typeof originalUpload });
    await render();
    const fileInput = container.querySelector('input[type="file"]')!;
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [new File(['image'], 'diagram.png', { type: 'image/png' })] });
    await act(async () => fileInput.dispatchEvent(new Event('change', { bubbles: true })));
    expect(button('actions.save').disabled).toBe(true);
    const field = container.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'Question with a late edit');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => upload.resolve({ token: '/m/01900000-0000-7000-8000-000000000009', mediaId: '01900000-0000-7000-8000-000000000009' }));
    expect(field.value).toContain('Question with a late edit');
    expect(field.value).toContain('![diagram](/m/');
    expect(button('actions.save').disabled).toBe(false);
  });

  test('editor fetches a deep-linked card outside the mirror and returns to its study scope after save', async () => {
    useNN.setState({ cards: [] });
    globalThis.fetch = adaptRecoveryFetch(((url: any) => Promise.resolve(Response.json(String(url).endsWith('/preview')
      ? { impact: { willCreateCards: 0, willKeepCards: 1, willDeleteCards: 0, willDeleteReviews: 0, removedCards: [] },
        confirmationToken: 'preview', sourceVersion: row.note.updatedAt }
      : String(url).includes('/notes/') ? { note: row.note, cards: [row] } : row))) as unknown as typeof fetch);
    await renderEditor(new URLSearchParams({ card: card.id, returnTo: '/review?deck=deck' }));
    expect(container.querySelector('textarea')?.value).toBe('Question');
    await act(async () => button('editor.saveAndReturn').click());
    expect(navigations.at(-1)).toBe('/review?deck=deck');
  });

  test('missing editor card shows a recoverable error instead of a new-card form', async () => {
    useNN.setState({ cards: [] });
    globalThis.fetch = adaptRecoveryFetch((async () => Response.json({ error: 'not_found' }, { status: 404 })) as unknown as typeof fetch);
    await renderEditor(new URLSearchParams({ card: card.id }));
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.textContent).not.toContain('editor.newCard');
  });

  test('a browser focus link fetches a card outside the first page', async () => {
    useNN.setState({ cards: [] });
    globalThis.fetch = adaptRecoveryFetch(((url: any) => Promise.resolve(Response.json(String(url).endsWith(`/cards/${card.id}`)
      ? row : String(url).includes('/tags') ? { tags: [] } : { items: [], nextCursor: null }))) as unknown as typeof fetch);
    await renderEditor(new URLSearchParams({ focus: card.id }), <NNCardsBrowser />);
    expect(container.querySelector('textarea')?.value).toBe('Question');
    expect(navigations.at(-1)).toBe('/cards');
  });

  test('quick study is single-flight and reuses the saved query on a later launch', async () => {
    const response = Promise.withResolvers<Response>();
    let writes = 0;
    let submitted: any;
    globalThis.fetch = adaptRecoveryFetch(((_url: any, init: any) => { writes++; submitted = JSON.parse(init.body); return response.promise; }) as unknown as typeof fetch);
    await renderEditor(new URLSearchParams(), <NNCustomStudy />);
    await act(async () => {
      button('review.customStudy.quickActions.cram').click();
      button('review.customStudy.quickActions.cram').click();
    });
    expect(writes).toBe(1);
    expect(submitted.includeSuspended).toBe(false);
    await act(async () => response.resolve(Response.json({ ...submitted, id: 'filtered' })));
    expect(navigations.at(-1)).toBe('/review?filteredDeckId=filtered');
    await act(async () => button('review.customStudy.quickActions.cram').click());
    expect(writes).toBe(1);
  });

  test('cancelling a regeneration preview keeps the draft and makes no write', async () => {
    const methods: string[] = [];
    globalThis.fetch = adaptRecoveryFetch((async (_url: any, init: any) => {
      methods.push(init.method);
      return Response.json({ sourceVersion: row.note.updatedAt, confirmationToken: 'consent', impact: {
        willCreateCards: 0, willKeepCards: 1, willDeleteCards: 1, willDeleteReviews: 7,
        removedCards: [{ id: 'sibling', front: 'Other question', reviews: 7 }],
      } });
    }) as typeof fetch);
    await render();
    await act(async () => button('actions.save').click());
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('Other question (7)');
    await act(async () => (dialog.querySelector('button') as HTMLButtonElement).click());
    expect(methods).toEqual(['POST']);
    expect(container.querySelector('textarea')!.value).toBe('Question');
    expect(button('actions.save').disabled).toBe(false);
  });

  test('note conflict preserves the draft and allows an explicit rebase before another save', async () => {
    const nextVersion = '2026-09-19T00:01:00.000Z';
    const requests: any[] = [];
    let attempts = 0;
    globalThis.fetch = adaptRecoveryFetch((async (url: any, init: any) => {
      if (String(url).includes('/cards/')) return Response.json({ ...row, note: { ...row.note, updatedAt: nextVersion, fieldValues: { Front: 'Remote question', Back: 'Answer' } } });
      const body = JSON.parse(init.body); requests.push(body);
      if (String(url).endsWith('/preview')) {
        if (++attempts === 1) return Response.json({ error: 'note_changed' }, { status: 409 });
        return Response.json({ sourceVersion: nextVersion, confirmationToken: 'current', impact: {
          willCreateCards: 0, willKeepCards: 1, willDeleteCards: 0, willDeleteReviews: 0, removedCards: [],
        } });
      }
      return Response.json({ note: { ...row.note, updatedAt: nextVersion }, cards: [row] });
    }) as typeof fetch);
    await render();
    await act(async () => button('actions.save').click());
    expect(container.querySelector('textarea')!.value).toBe('Question');
    expect(Array.from(container.querySelectorAll('textarea[readonly]')).some((field) => (field as HTMLTextAreaElement).value === 'Remote question')).toBe(true);
    await act(async () => button('editor.conflict.reviewDraft').click());
    const buttons = container.querySelector('[role="dialog"]')!.querySelectorAll('button');
    await act(async () => (buttons[buttons.length - 1] as HTMLButtonElement).click());
    await act(async () => button('actions.save').click());
    expect(requests[0].expectedUpdatedAt).toBe(row.note.updatedAt);
    expect(requests[1]).toMatchObject({ expectedUpdatedAt: nextVersion, fieldValues: { Front: 'Question' } });
    expect(requests[2]).toMatchObject({ confirmationToken: 'current', expectedUpdatedAt: nextVersion });
  });

  test('a changed type is explicitly rebased by stable field identity without losing the draft', async () => {
    const oldVersion = '2026-09-19T00:00:00.000Z';
    const newVersion = '2026-09-19T00:01:00.000Z';
    const originalType = { ...BASIC_NOTE_TYPE, updatedAt: oldVersion,
      fields: BASIC_NOTE_TYPE.fields.map((field) => ({ ...field, id: `field-${field.ord}` })) };
    const currentType = { ...originalType, updatedAt: newVersion,
      fields: originalType.fields.map((field) => field.name === 'Front' ? { ...field, name: 'Question' } : field),
      templates: originalType.templates.map((template) => ({ ...template, frontTemplate: '{{Question}}' })) };
    useNN.setState({ noteTypes: [noteTypeFromApi(originalType)] });
    const currentRow = { ...row, noteType: currentType, note: { ...row.note, updatedAt: newVersion, fieldValues: { Question: 'Remote', Back: 'Answer' } } };
    const requests: any[] = [];
    let previews = 0;
    globalThis.fetch = adaptRecoveryFetch((async (url: any, init: any) => {
      if (String(url).endsWith('/note-types')) return Response.json([currentType]);
      if (String(url).includes('/cards/')) return Response.json(currentRow);
      const body = JSON.parse(init.body); requests.push(body);
      if (String(url).endsWith('/preview')) {
        if (++previews === 1) return Response.json({ error: 'note_type_changed' }, { status: 409 });
        return Response.json({ sourceVersion: newVersion, confirmationToken: 'rebased', impact: {
          willCreateCards: 0, willKeepCards: 1, willDeleteCards: 0, willDeleteReviews: 0, removedCards: [],
        } });
      }
      return Response.json({ note: { ...currentRow.note, fieldValues: body.fieldValues }, cards: [currentRow] });
    }) as typeof fetch);
    await render({ card: cardFromApi({ ...row, noteType: originalType }) });
    await act(async () => button('actions.save').click());
    expect(container.querySelector('textarea')!.value).toBe('Question');
    expect(useNN.getState().noteTypes[0].updatedAt).toBe(oldVersion);
    await act(async () => button('editor.conflict.reviewDraft').click());
    const buttons = container.querySelector('[role="dialog"]')!.querySelectorAll('button');
    await act(async () => (buttons[buttons.length - 1] as HTMLButtonElement).click());
    expect(container.querySelector('textarea')!.value).toBe('Question');
    await act(async () => button('actions.save').click());
    expect(requests[0].expectedTypeUpdatedAt).toBe(oldVersion);
    expect(requests[1]).toMatchObject({ expectedTypeUpdatedAt: newVersion, fieldValues: { Question: 'Question', Back: 'Answer' } });
    expect(requests[1].fieldValues.Front).toBeUndefined();
  });
});

test('a question from a later field saves with an empty first field', async () => {
  const type = { ...BASIC_NOTE_TYPE, id: 'later-field', kind: 'custom' as const, fields: [{ name: 'Extra', ord: 0 }, { name: 'Question', ord: 1 }],
    templates: [{ name: 'Question', ord: 0, frontTemplate: '{{Question}}', backTemplate: '{{Extra}}' }] };
  const edited = { ...row, noteType: type, note: { ...row.note, fieldValues: { Extra: '', Question: 'Visible question' } } };
  useNN.setState({ noteTypes: [noteTypeFromApi(type)] });
  let saved: any;
  globalThis.fetch = adaptRecoveryFetch((async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    if (body.preview) return Response.json({ sourceVersion: row.note.updatedAt, confirmationToken: 'valid',
      impact: { willCreateCards: 0, willKeepCards: 1, willDeleteCards: 0, willDeleteReviews: 0, removedCards: [] } });
    saved = body; return Response.json({ note: { ...edited.note, ...body }, cards: [edited] });
  }) as typeof fetch);
  await render({ card: cardFromApi(edited) });
  await act(async () => button('actions.save').click());
  expect(saved.fieldValues).toEqual({ Extra: '', Question: 'Visible question' });
});

test('conversion keeping the card id replaces the editor fields and type, not only its store row', async () => {
  const source = { ...BASIC_NOTE_TYPE, updatedAt: row.note.updatedAt,
    fields: BASIC_NOTE_TYPE.fields.map((field, index) => ({ ...field, id: `source-${index}` })),
    templates: BASIC_NOTE_TYPE.templates.map((template) => ({ ...template, id: 'source-template' })) };
  const target = { ...source, id: 'converted-type', name: 'Mapped type', isBuiltin: false,
    fields: [{ id: 'question', name: 'Question', ord: 0 }, { id: 'answer', name: 'Answer', ord: 1 }],
    templates: [{ id: 'new-template', name: 'Card 1', ord: 0, frontTemplate: '{{Question}}', backTemplate: '{{Answer}}' }] };
  useNN.setState({ noteTypes: [source, target].map(noteTypeFromApi) });
  let saved: any;
  globalThis.fetch = adaptRecoveryFetch((async (url: any) => Response.json(String(url).endsWith('/preview') ? {
    noteCount: 1, sourceVersion: row.note.updatedAt, targetVersion: row.note.updatedAt, confirmationToken: 'convert',
    impact: { willCreateCards: 0, willKeepCards: 1, willDeleteCards: 0, willDeleteReviews: 0, removedCards: [] },
    validation: { checkedNotes: 1, invalidNotes: 0, samples: [] }, fieldMapping: [], unmappedFields: [], unmappedFieldCount: 0, discardedValues: 0, discardedAlternatives: 0,
  } : { noteIds: [row.noteId], cards: [{ ...row, noteType: target, note: { ...row.note, fieldValues: { Question: 'Mapped question', Answer: 'Mapped answer' } } }] })) as unknown as typeof fetch);
  await render({ card: cardFromApi({ ...row, noteType: source }), onSaved: (card) => { saved = card; } });
  await act(async () => button('noteTypes.convert.open').click());
  const select = document.querySelector('[aria-label^="noteTypes.convert.target"]') as HTMLButtonElement;
  await act(async () => select.click());
  await act(async () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((option) => option.textContent?.includes('Mapped type'))!.click());
  const modalButton = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((button) => button.textContent?.includes(text))!;
  await act(async () => modalButton('noteTypes.kind.preview').click());
  await act(async () => modalButton('noteTypes.convert.apply').click());
  expect(saved.id).toBe(row.id);
  expect(container.textContent).toContain('Mapped type');
  expect((container.querySelector('[aria-label="Question"]') as HTMLTextAreaElement).value).toBe('Mapped question');
  expect((container.querySelector('[aria-label="Answer"]') as HTMLTextAreaElement).value).toBe('Mapped answer');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test('a successful conversion removes the old scoped rows even when refreshing the list fails', async () => {
  const source = { ...BASIC_NOTE_TYPE, updatedAt: row.note.updatedAt,
    fields: BASIC_NOTE_TYPE.fields.map((field, index) => ({ ...field, id: `source-${index}` })),
    templates: BASIC_NOTE_TYPE.templates.map((template) => ({ ...template, id: 'source-template' })) };
  const target = { ...source, id: 'target-type', name: 'Target', isBuiltin: false, templates: [{ ...source.templates[0], id: 'target-template' }] };
  useNN.setState({ noteTypes: [source, target].map(noteTypeFromApi), cards: [cardFromApi({ ...row, noteType: source })] });
  let applied = false;
  globalThis.fetch = adaptRecoveryFetch((async (url: any) => {
    const path = String(url);
    if (path.includes('/cards/tags')) return Response.json({ tags: [] });
    if (path.includes('/cards/search')) return applied ? Response.json({ error: 'unavailable' }, { status: 503 }) : Response.json({ items: [{ ...row, noteType: source }], nextCursor: null });
    if (path.endsWith('/convert/preview')) return Response.json({ noteCount: 1, sourceVersion: row.note.updatedAt, targetVersion: row.note.updatedAt, confirmationToken: 'convert',
      impact: { willCreateCards: 0, willKeepCards: 1, willDeleteCards: 0, willDeleteReviews: 0, removedCards: [] }, validation: { checkedNotes: 1, invalidNotes: 0, samples: [] },
      fieldMapping: [], unmappedFields: [], unmappedFieldCount: 0, discardedValues: 0, discardedAlternatives: 0 });
    if (path.endsWith('/notes/convert')) { applied = true; return Response.json({ noteIds: [row.noteId], cards: [{ ...row, noteType: target }] }); }
    return Response.json({ items: [] });
  }) as unknown as typeof fetch);
  await renderEditor(new URLSearchParams({ noteTypeId: source.id!, convertTo: target.id }), <NNCardsBrowser />);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
  await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click());
  await act(async () => button('cards.actions.open').click());
  await act(async () => (Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(b => b.textContent?.includes('noteTypes.convert.open'))!).click());
  const modalButton = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((button) => button.textContent?.includes(text))!;
  await act(async () => modalButton('noteTypes.kind.preview').click());
  await act(async () => modalButton('noteTypes.convert.apply').click());
  expect(applied).toBe(true);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(useNN.getState().cards[0].noteType?.id).toBe(target.id);
  expect(container.textContent).not.toContain('Question');
});


const draftScope: DraftScope = { ownerId: 'draft-owner', kind: 'note', entityId: 'note' };
function LeaveEditor() { const nav = useAppNavigation(); return <button onClick={() => nav.push('/cards')}>Leave editor</button>; }
async function changeFront(value: string) {
  const field = container.querySelector('textarea[data-nn-field]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function flushDraft() { await act(async () => { window.dispatchEvent(new Event('pagehide')); }); }
async function remountForm(props: Partial<React.ComponentProps<typeof NNCardForm>> = {}) {
  await act(async () => root.render(null)); await render(props);
}
describe('editor draft recovery', () => {
  beforeEach(() => { useNN.setState({ profile: { userId: draftScope.ownerId } as any }); });
  test('reload offers exact unsaved source without replacing the server text before consent', async () => {
    await render();
    const source = 'Unsaved **Markdown**\n\n```ts\nconst value: Array<T> = [];\n```';
    await changeFront(source); await flushDraft();
    expect((readEditorDraft(draftScope)?.value as any).fieldValues.Front).toBe(source);
    await remountForm();
    expect(container.textContent).toContain('editor.draft.found');
    expect(container.querySelector('textarea[data-nn-field]')!.textContent).toBe('Question');
    expect(button('actions.save').disabled).toBe(true);
    await act(async () => button('editor.draft.restore').click());
    expect((container.querySelector('textarea[data-nn-field]') as HTMLTextAreaElement).value).toBe(source);
    expect(button('actions.save').disabled).toBe(false);
  });
  test('restoring a cached-baseline draft survives a fresher same-card response', async () => {
    const oldType = noteTypeFromApi(BASIC_NOTE_TYPE);
    writeEditorDraft(draftScope, { fieldValues: { Front: 'Question', Back: 'Answer' }, deckId: 'deck', baseDeckId: 'deck',
      noteTypeId: oldType.id, noteType: oldType, tagsText: '', acceptedAnswersText: '', baseVersion: row.note.updatedAt }, null);
    await render();
    const fresh = cardFromApi({ ...row, note: { ...row.note, updatedAt: '2026-09-20T00:00:00.000Z', fieldValues: { Front: 'Changed elsewhere', Back: 'Answer' } } });
    await render({ card: fresh });
    await act(async () => button('editor.draft.restore').click());
    await flushDraft();
    expect((readEditorDraft(draftScope)?.value as any).fieldValues.Front).toBe('Question');
    await remountForm({ card: fresh });
    expect(container.textContent).toContain('editor.draft.found');
  });
  test('restored source keeps its original version when the server changed during absence', async () => {
    await render(); await changeFront('My old-base changes'); await flushDraft();
    const fresh = cardFromApi({ ...row, note: { ...row.note, updatedAt: '2026-09-20T00:00:00.000Z', fieldValues: { Front: 'Changed elsewhere', Back: 'Answer' } } });
    await remountForm({ card: fresh });
    expect(container.textContent).toContain('editor.draft.stale');
    await act(async () => button('editor.draft.restore').click());
    let body: any;
    globalThis.fetch = adaptRecoveryFetch((async (url: any, init: any) => {
      if (String(url).endsWith('/preview')) { body = JSON.parse(init.body); return Response.json({ error: 'note_changed' }, { status: 409 }); }
      return Response.json({ ...row, note: { ...row.note, fieldValues: { Front: 'Changed elsewhere', Back: 'Answer' } } });
    }) as typeof fetch);
    await act(async () => button('actions.save').click());
    expect(body.expectedUpdatedAt).toBe(row.note.updatedAt);
    expect(body.fieldValues.Front).toBe('My old-base changes');
    expect(readEditorDraft(draftScope)).not.toBeNull();
  });
  test('failed save retains the draft; a confirmed save removes it and cleanup does not recreate it', async () => {
    await render(); await changeFront('Saved draft'); await flushDraft();
    let fail = true;
    globalThis.fetch = adaptRecoveryFetch((async (url: any) => fail ? Response.json({ error: 'offline' }, { status: 503 }) : Response.json(String(url).endsWith('/preview')
      ? { confirmationToken: 'current', sourceVersion: row.note.updatedAt, impact: { willDeleteCards: 0 } }
      : { note: { ...row.note, fieldValues: { Front: 'Saved draft', Back: 'Answer' } }, cards: [row] })) as unknown as typeof fetch);
    await act(async () => button('actions.save').click());
    expect(readEditorDraft(draftScope)).not.toBeNull();
    fail = false;
    await act(async () => button('actions.save').click());
    expect(readEditorDraft(draftScope)).toBeNull();
    await act(async () => root.render(null));
    expect(readEditorDraft(draftScope)).toBeNull();
  });
  test('account switching cannot restore another owner draft and keeps each slot separate', async () => {
    await render(); await changeFront('Private Alice draft'); await flushDraft();
    await act(async () => useNN.setState({ profile: { userId: 'other-owner' } as any }));
    expect(container.textContent).not.toContain('editor.draft.found');
    expect((container.querySelector('textarea[data-nn-field]') as HTMLTextAreaElement).value).toBe('Question');
    await changeFront('Bob draft'); await flushDraft();
    expect((readEditorDraft(draftScope)?.value as any).fieldValues.Front).toBe('Private Alice draft');
    expect((readEditorDraft({ ...draftScope, ownerId: 'other-owner' })?.value as any).fieldValues.Front).toBe('Bob draft');
  });
  test('leave can be cancelled or keep the local draft without a server write', async () => {
    let calls = 0;
    globalThis.fetch = adaptRecoveryFetch((async (_url: any, _init: any) => { calls++; return Response.json({}); }) as typeof fetch);
    await render({ footerExtra: <LeaveEditor /> }); await changeFront('Keep locally');
    await act(async () => button('Leave editor').click());
    expect(container.textContent).toContain('editor.draft.leaveTitle');
    expect(navigations).toEqual([]);
    await act(async () => button('editor.draft.stay').click());
    expect(navigations).toEqual([]);
    await act(async () => button('Leave editor').click());
    await act(async () => button('editor.draft.continue').click());
    expect(navigations).toEqual(['/cards']);
    expect((readEditorDraft(draftScope)?.value as any).fieldValues.Front).toBe('Keep locally');
    expect(calls).toBe(0);
  });
  test('discard before leaving removes the draft without recreating it on unmount', async () => {
    await render({ footerExtra: <LeaveEditor /> }); await changeFront('Discard this'); await flushDraft();
    await act(async () => button('Leave editor').click());
    await act(async () => button('editor.draft.discardAndLeave').click());
    await act(async () => button('editor.draft.continue').click());
    expect(navigations).toEqual(['/cards']);
    expect(readEditorDraft(draftScope)).toBeNull();
    await act(async () => root.render(null));
    expect(readEditorDraft(draftScope)).toBeNull();
  });
  test('reverting the text to its original value removes an obsolete local draft', async () => {
    await render(); await changeFront('Temporary'); await flushDraft();
    expect(readEditorDraft(draftScope)).not.toBeNull();
    await changeFront('Question'); await flushDraft();
    expect(readEditorDraft(draftScope)).toBeNull();
  });
  test('pending drafts can be discarded without changing the server or displayed source', async () => {
    await render(); await changeFront('Old local draft'); await flushDraft(); await remountForm();
    await act(async () => button('editor.draft.discard').click());
    expect(readEditorDraft(draftScope)).toBeNull();
    expect((container.querySelector('textarea[data-nn-field]') as HTMLTextAreaElement).value).toBe('Question');
  });
  test('new-note reload restores its selected type, deck, tags and complete text', async () => {
    const other = noteTypeFromApi({ ...BASIC_NOTE_TYPE, id: 'other-type', name: 'Other type', isBuiltin: false });
    useNN.setState({ noteTypes: [noteTypeFromApi(BASIC_NOTE_TYPE), other], decks: [...useNN.getState().decks, { id: 'deck-2', name: 'Second', color: 'sky', species: 'fern', createdAt: 0 }] });
    writeEditorDraft({ ...draftScope, entityId: 'new' }, { fieldValues: { Front: 'A new unsaved question', Back: 'Answer' }, deckId: 'deck-2', noteTypeId: other.id,
      tagsText: 'two, tags', acceptedAnswersText: '', noteType: other }, null);
    await render({ card: null });
    await act(async () => button('editor.draft.restore').click());
    expect((container.querySelector('textarea[data-nn-field]') as HTMLTextAreaElement).value).toBe('A new unsaved question');
    let created: any;
    globalThis.fetch = adaptRecoveryFetch((async (_url: any, init: any) => { created = JSON.parse(init.body); return Response.json({ error: 'offline' }, { status: 503 }); }) as typeof fetch);
    await act(async () => button('actions.create').click());
    expect(created).toMatchObject({ deckId: 'deck-2', noteTypeId: other.id, tags: ['two', 'tags'], fieldValues: { Front: 'A new unsaved question', Back: 'Answer' } });
    expect(readEditorDraft(draftScope)).toBeNull();
  });
  test('a restored tag string is normalized the same way as the API before create', async () => {
    const other = noteTypeFromApi({ ...BASIC_NOTE_TYPE, id: 'other-type', name: 'Other type', isBuiltin: false });
    useNN.setState({ noteTypes: [noteTypeFromApi(BASIC_NOTE_TYPE), other], decks: [...useNN.getState().decks, { id: 'deck-2', name: 'Second', color: 'sky', species: 'fern', createdAt: 0 }] });
    writeEditorDraft({ ...draftScope, entityId: 'new' }, { fieldValues: { Front: 'Tagged question', Back: 'Answer' }, deckId: 'deck-2', noteTypeId: other.id,
      tagsText: '  Grammar , grammar, Grammar, a, b, hello   world, caf\u00e9, cafe\u0301, gram\u0000mar', acceptedAnswersText: '', noteType: other }, null);
    await render({ card: null });
    await act(async () => button('editor.draft.restore').click());
    let created: any;
    globalThis.fetch = adaptRecoveryFetch((async (_url: any, init: any) => { created = JSON.parse(init.body); return Response.json({ error: 'offline' }, { status: 503 }); }) as typeof fetch);
    await act(async () => button('actions.create').click());
    expect(created.tags).toEqual(['Grammar', 'grammar', 'a', 'b', 'hello world', 'caf\u00e9']);
  });
  test('an over-long tag is refused in the editor before the request', async () => {
    const other = noteTypeFromApi({ ...BASIC_NOTE_TYPE, id: 'other-type', name: 'Other type', isBuiltin: false });
    useNN.setState({ noteTypes: [noteTypeFromApi(BASIC_NOTE_TYPE), other], decks: [...useNN.getState().decks, { id: 'deck-2', name: 'Second', color: 'sky', species: 'fern', createdAt: 0 }] });
    writeEditorDraft({ ...draftScope, entityId: 'new' }, { fieldValues: { Front: 'Too long', Back: 'Answer' }, deckId: 'deck-2', noteTypeId: other.id,
      tagsText: 'a'.repeat(129), acceptedAnswersText: '', noteType: other }, null);
    await render({ card: null });
    await act(async () => button('editor.draft.restore').click());
    let created = false;
    globalThis.fetch = adaptRecoveryFetch((async (_url: any, _init: any) => { created = true; return Response.json({ error: 'offline' }, { status: 503 }); }) as typeof fetch);
    await act(async () => button('actions.create').click());
    expect(created).toBe(false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('editor.errors.tagTooLong');
  });
  test('restoring through another direction does not move the note back to its old deck', async () => {
    useNN.setState({ decks: [...useNN.getState().decks, { id: 'deck-2', name: 'Second', color: 'sky', species: 'fern', createdAt: 0 }] });
    await render(); await changeFront('Shared note draft'); await flushDraft();
    await remountForm({ card: cardFromApi({ ...row, id: 'second-direction', deckId: 'deck-2' }) });
    await act(async () => button('editor.draft.restore').click());
    let request: any;
    globalThis.fetch = adaptRecoveryFetch((async (_url: any, init: any) => { request = JSON.parse(init.body); return Response.json({ error: 'offline' }, { status: 503 }); }) as typeof fetch);
    await act(async () => button('actions.save').click());
    expect(request.fieldValues.Front).toBe('Shared note draft');
    expect(request.deckId).toBeUndefined();
  });
  test('save-and-leave waits for a confirmed write; failures stay in the editor', async () => {
    let fail = true; let writes = 0;
    globalThis.fetch = adaptRecoveryFetch((async (url: any, init: any) => {
      if (String(url).endsWith('/preview')) return Response.json({ confirmationToken: 'current', sourceVersion: row.note.updatedAt, impact: { willDeleteCards: 0 } });
      if (init.method === 'PATCH') writes++;
      return fail ? Response.json({ error: 'offline' }, { status: 503 }) : Response.json({ note: { ...row.note, fieldValues: { Front: 'Save before exit', Back: 'Answer' } }, cards: [row] });
    }) as typeof fetch);
    await render({ footerExtra: <LeaveEditor /> }); await changeFront('Save before exit');
    for (const attempt of [1, 2]) {
      await act(async () => button('Leave editor').click());
      await act(async () => button('editor.draft.saveAndLeave').click());
      await act(async () => button('editor.draft.continue').click());
      if (attempt === 1) { expect(navigations).toEqual([]); fail = false; }
    }
    expect(writes).toBe(2);
    expect(navigations).toEqual(['/cards']);
    expect(readEditorDraft(draftScope)).toBeNull();
  });
  test('storage denial is visible and triggers native protection instead of claiming a saved draft', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!;
    const original = localStorage;
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
      get length() { return original.length; }, key: original.key.bind(original), getItem: original.getItem.bind(original),
      removeItem: original.removeItem.bind(original), setItem() { throw new Error('quota'); },
    } });
    try {
      await render(); await changeFront('Cannot store locally'); await flushDraft();
      expect(container.textContent).toContain('editor.draft.unavailable');
      expect(container.textContent).not.toContain('editor.draft.saved');
      const unload = new Event('beforeunload', { cancelable: true });
      await act(async () => { window.dispatchEvent(unload); });
      expect(unload.defaultPrevented).toBe(true);
    } finally { Object.defineProperty(globalThis, 'localStorage', descriptor); }
  });
  test('a restored draft renders the original field definition and sends its original type version', async () => {
    const oldType = noteTypeFromApi({ ...BASIC_NOTE_TYPE, updatedAt: '2026-09-18T00:00:00.000Z' });
    writeEditorDraft(draftScope, { fieldValues: { Front: 'Old schema draft', Back: 'Answer' }, deckId: 'deck', noteTypeId: oldType.id,
      tagsText: '', acceptedAnswersText: '', baseVersion: row.note.updatedAt, noteType: oldType }, null);
    const changedType = noteTypeFromApi({ ...oldType, updatedAt: '2026-09-20T00:00:00.000Z', fields: oldType.fields.map(f => f.name === 'Front' ? { ...f, name: 'Prompt' } : f),
      templates: oldType.templates.map(t => ({ ...t, frontTemplate: '{{Prompt}}' })) });
    useNN.setState({ noteTypes: [changedType] });
    await render(); await act(async () => button('editor.draft.restore').click());
    expect((container.querySelector('textarea[data-nn-field]') as HTMLTextAreaElement).value).toBe('Old schema draft');
    let preview: any;
    globalThis.fetch = adaptRecoveryFetch((async (url: any, init: any) => {
      if (String(url).endsWith('/preview')) { preview = JSON.parse(init.body); return Response.json({ error: 'note_type_changed' }, { status: 409 }); }
      return Response.json(String(url).endsWith('/note-types') ? [changedType] : row);
    }) as typeof fetch);
    await act(async () => button('actions.save').click());
    expect(preview.expectedTypeUpdatedAt).toBe(oldType.updatedAt);
    expect(preview.fieldValues.Front).toBe('Old schema draft');
  });

  test('a late confirmed save clears only its original owner slot after account reset', async () => {
    const response = Promise.withResolvers<Response>();
    const started = Promise.withResolvers<void>();
    globalThis.fetch = adaptRecoveryFetch((async (url: any) => {
      if (String(url).endsWith('/preview')) return Response.json({ confirmationToken: 'current', sourceVersion: row.note.updatedAt, impact: { willDeleteCards: 0 } });
      started.resolve(); return response.promise;
    }) as unknown as typeof fetch);
    await render(); await changeFront('Private pending save'); await flushDraft();
    await act(async () => { button('actions.save').click(); await started.promise; });
    await act(async () => root.render(null));
    useNN.getState().reset(); useNN.setState({ profile: { userId: 'other-owner' } as any });
    const otherScope = { ...draftScope, ownerId: 'other-owner' };
    writeEditorDraft(otherScope, { fieldValues: { Front: 'Other account draft' } }, null);
    await act(async () => response.resolve(Response.json({ note: { ...row.note, fieldValues: { Front: 'Private pending save', Back: 'Answer' } }, cards: [row] })));
    expect(readEditorDraft(draftScope)).toBeNull();
    expect((readEditorDraft(otherScope)?.value as any).fieldValues.Front).toBe('Other account draft');
    expect(useNN.getState().cards).toEqual([]);
  });

});

test('shared card editor previews unsaved fields and preserves them on returning to edit', async () => {
  const { CardEditor } = await import('./card-editor');
  let writes = 0;
  globalThis.fetch = adaptRecoveryFetch((async (_url: any, init?: RequestInit) => { if (init?.method && init.method !== 'GET') writes++; return Response.json({ items: [] }); }) as typeof fetch);
  await renderEditor(new URLSearchParams(), <CardEditor card={card} />);
  const field = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, '**Unsaved preview**');
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => button('cards.panel.view').click());
  expect(container.querySelector('.reomi-card-detail-preview strong')?.textContent).toBe('Unsaved preview');
  expect(container.querySelector('.reomi-card-detail-preview')?.hasAttribute('hidden')).toBe(false);
  await act(async () => button('cards.panel.edit').click());
  expect((container.querySelector('textarea') as HTMLTextAreaElement).value).toBe('**Unsaved preview**');
  expect(container.querySelector('.reomi-card-form-scroll .reomi-card-form-footer')).toBeNull();
  expect(container.querySelector('.reomi-card-form-footer')).not.toBeNull();
  expect(writes).toBe(0);
});

test('draft library resumes new cards and types with their correct scope and hides other owners', async () => {
  useNN.setState({ profile: { userId: 'draft-library-owner' } as any });
  writeEditorDraft({ ownerId: 'draft-library-owner', kind: 'note', entityId: 'new' }, {
    fieldValues: { Front: 'Unfinished card', Back: 'Answer' }, deckId: 'deck', noteTypeId: BASIC_NOTE_TYPE.id,
    tagsText: '', acceptedAnswersText: '', noteType: noteTypeFromApi(BASIC_NOTE_TYPE),
  }, null);
  writeEditorDraft({ ownerId: 'draft-library-owner', kind: 'type', entityId: 'new' }, {
    name: 'Unfinished type', fields: BASIC_NOTE_TYPE.fields, templates: BASIC_NOTE_TYPE.templates, styling: '', kind: 'basic',
  }, null);
  await renderEditor(new URLSearchParams({ drafts: '1' }));
  expect(container.querySelectorAll('.reomi-draft-card')).toHaveLength(2);
  const rows = Array.from(container.querySelectorAll('.reomi-draft-card'));
  for (const text of ['Unfinished card', 'Unfinished type']) {
    const row = rows.find(row => row.textContent?.includes(text))!;
    await act(async () => Array.from(row.querySelectorAll('button')).find(button => button.textContent?.includes('editor.draft.openOriginal'))!.click());
    expect(navigations.at(-1)).toBe(text === 'Unfinished type' ? '/note-types?new=1' : `/editor?deck=deck&noteType=${BASIC_NOTE_TYPE.id}`);
  }
  await act(async () => useNN.setState({ profile: { userId: 'another-owner' } as any }));
  expect(container.querySelectorAll('.reomi-draft-card')).toHaveLength(0);
  expect(container.textContent).not.toContain('Unfinished');
});

describe('card context actions', () => {
  async function mountCards() {
    const second = { ...row, id: '01900000-0000-7000-8000-000000000002' };
    globalThis.fetch = adaptRecoveryFetch((async () => Response.json({ items: [row, second], nextCursor: null })) as unknown as typeof fetch);
    await renderEditor(new URLSearchParams(), <NNCardsBrowser />);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)); });
    return Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
  }
  test('right click preserves selected scope, another row scopes to one, Escape restores focus', async () => {
    const checks = await mountCards();
    await act(async () => { checks[0].click(); checks[1].click(); });
    const firstRow = checks[0].closest('[data-card-row]') as HTMLElement;
    await act(async () => firstRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 200, clientY: 200 })));
    expect(checks.filter(c => c.checked)).toHaveLength(2);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(firstRow);
    await act(async () => firstRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true })));
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
    expect(document.activeElement?.textContent).toContain('cards.bulk.delete');
    await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await act(async () => checks[1].click());
    const secondRow = checks[1].closest('[data-card-row]') as HTMLElement;
    await act(async () => secondRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })));
    expect(checks.map(c => c.checked)).toEqual([false, true]);
  });
  test('visible trigger opens actions; deleting still asks for confirmation', async () => {
    await mountCards();
    const trigger = container.querySelector<HTMLButtonElement>('.reomi-card-row-actions')!;
    await act(async () => trigger.click());
    const menu = document.querySelector('[role="menu"]')!;
    const remove = Array.from(menu.querySelectorAll<HTMLButtonElement>('button')).find(b => b.textContent?.includes('cards.bulk.delete'))!;
    await act(async () => remove.click());
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('cards.bulk.deleteConfirm');
  });
});


test('graph list collapses independently of cluster filters and starts closed on mobile', async () => {
  const { NNGraphForce } = await import('./screens/graph');
  const width = window.innerWidth;
  globalThis.fetch = adaptRecoveryFetch((async () => Response.json({ edges: [], nodes: [], reason: 'not_indexed' })) as unknown as typeof fetch);
  await renderEditor(new URLSearchParams(), <NNGraphForce />);
  const toggle = () => container.querySelector<HTMLButtonElement>('.reomi-graph-legend-toggle')!;
  const list = () => container.querySelector<HTMLDivElement>('#graph-cluster-list')!;
  expect(toggle().getAttribute('aria-expanded')).toBe('true');
  const cluster = list().querySelector<HTMLButtonElement>('button')!;
  await act(async () => cluster.click());
  expect(cluster.getAttribute('aria-pressed')).toBe('false');
  await act(async () => toggle().click());
  expect(list().hidden).toBe(true);
  await act(async () => toggle().click());
  expect(cluster.getAttribute('aria-pressed')).toBe('false');
  try {
    await act(async () => { Object.defineProperty(window, 'innerWidth', { value: 432, configurable: true }); window.dispatchEvent(new Event('resize')); });
    expect(list().hidden).toBe(true);
    await act(async () => toggle().click());
    expect(list().hidden).toBe(false);
  } finally { Object.defineProperty(window, 'innerWidth', { value: width, configurable: true }); }
});

for (const action of ['addTag','removeTag'] as const) test(`${action} chooses existing tags and sends the selected value`, async () => {
  const writes:any[]=[];
  const tagged={...row,note:{...row.note,tags:['architecture']}};
  globalThis.fetch = adaptRecoveryFetch((async(url:any,init?:RequestInit)=>{
    const path=String(url);
    if(path.endsWith('/cards/tags')) return Response.json({tags:['architecture','csharp','patterns']});
    if(path.endsWith('/cards/bulk')) { writes.push(JSON.parse(String(init?.body))); return Response.json({ok:true}); }
    return Response.json({items:[tagged],nextCursor:null});
  }) as typeof fetch);
  await renderEditor(new URLSearchParams(),<NNCardsBrowser/>);
  await act(async()=>{await new Promise(r=>setTimeout(r,350));});
  await act(async()=>container.querySelector<HTMLButtonElement>('.reomi-card-row-actions')!.click());
  await act(async()=>Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')).find(b=>b.textContent?.includes(`cards.bulk.${action}`))!.click());
  const dialog=document.querySelector('[role="dialog"]')!;
  expect(dialog.textContent).toContain('#architecture');
  if(action==='addTag') expect(dialog.textContent).toContain('#csharp');
  else expect(dialog.textContent).not.toContain('#csharp');
  expect(dialog.textContent).not.toContain('cards.bulk.tagPrompt');
  const option=Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent?.includes('#architecture'))!;
  await act(async()=>option.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})));
  expect(writes).toHaveLength(1);
  expect(writes[0]).toMatchObject({action,cardIds:[row.id],payload:{tag:'architecture'}});
});

test('cards filter width persists, supports keyboard resizing and stays out of the mobile drawer', async () => {
  const key='reomi:cards:filters-width', legacy='nn:cards:filters-width', previous=localStorage.getItem(key), width=window.innerWidth;
  localStorage.removeItem(key); localStorage.removeItem(legacy);
  globalThis.fetch = adaptRecoveryFetch((async()=>Response.json({items:[row],tags:[],nextCursor:null})) as unknown as typeof fetch);
  try {
    await renderEditor(new URLSearchParams(),<NNCardsBrowser/>);
    const separator=()=>container.querySelector<HTMLElement>('[role="separator"][aria-label="cards.sidebar.resize"]');
    expect(separator()?.getAttribute('aria-valuenow')).toBe('196');
    await act(async()=>separator()!.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true})));
    expect(localStorage.getItem(key)).toBe('440');
    await act(async()=>root.render(null));
    await renderEditor(new URLSearchParams(),<NNCardsBrowser/>);
    expect(separator()?.getAttribute('aria-valuenow')).toBe('440');
    await act(async()=>separator()!.dispatchEvent(new MouseEvent('dblclick',{bubbles:true})));
    expect(localStorage.getItem(key)).toBe('196');
    await act(async()=>{Object.defineProperty(window,'innerWidth',{value:432,configurable:true});window.dispatchEvent(new Event('resize'));});
    expect(separator()).toBeNull();
    expect(localStorage.getItem(key)).toBe('196');
  } finally {
    Object.defineProperty(window,'innerWidth',{value:width,configurable:true});
    localStorage.removeItem(legacy);
    if(previous===null)localStorage.removeItem(key);else localStorage.setItem(key,previous);
  }
});

test('empty card search offers scoped creation and clearing the search', async () => {
  globalThis.fetch = adaptRecoveryFetch((async()=>Response.json({items:[],tags:[],nextCursor:null})) as unknown as typeof fetch);
  await renderEditor(new URLSearchParams({q:'deck:"Study"'}),<NNCardsBrowser/>);
  await act(async()=>{await new Promise(r=>setTimeout(r,350));});
  const empty=container.querySelector('.reomi-cards-empty')!;
  expect(empty.textContent).toContain('cards.empty.deckHint');
  await act(async()=>Array.from(empty.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent?.includes('topbar.newCard'))!.click());
  expect(navigations).toContain('/editor?deck=deck');
  await act(async()=>Array.from(empty.querySelectorAll<HTMLButtonElement>('button')).find(b=>b.textContent?.includes('cards.empty.clearSearch'))!.click());
  expect(container.querySelector<HTMLInputElement>('.reomi-cards-search input')?.value).toBe('');
});
