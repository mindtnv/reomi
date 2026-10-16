import { ensureTestDom, GlobalRegistrator } from '../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { useNN } from '../lib/store';
import { cardFromApi, noteTypeFromApi } from '../lib/mappers';

ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { NoteConversionDialog } = await import('./note-conversion');
const source = { id: 'source', name: 'Source', kind: 'basic', updatedAt: '2026-09-19T00:00:00Z', isBuiltin: true, fields: [{ id: 'q', name: 'Q', ord: 0 }, { id: 'a', name: 'A', ord: 1 }],
  templates: [{ id: 'before', name: 'Card', ord: 0, frontTemplate: '{{Q}}', backTemplate: '{{A}}' }], styling: '' };
const target = { ...source, id: 'target', name: 'Copy', isBuiltin: false, templates: [{ ...source.templates[0], id: 'after' }] };
const row = { id: 'card', noteId: 'note', deckId: 'deck', note: { id: 'note', fieldValues: { Q: 'Question', A: 'Answer', Extra: 'Preserve' }, tags: [] }, noteType: source };
const selected = [cardFromApi(row), cardFromApi({ ...row, id: 'sibling' })];
const preview = { noteCount: 1, sourceVersion: source.updatedAt, targetVersion: target.updatedAt, confirmationToken: 'exact-consent',
  impact: { willCreateCards: 0, willKeepCards: 2, willDeleteCards: 0, willDeleteReviews: 0, removedCards: [] },
  validation: { checkedNotes: 1, invalidNotes: 0, samples: [{ front: 'Question', questions: ['Question'], omittedTemplates: [] }] },
  fieldMapping: [{ source: 'Q', target: 'Q' }, { source: 'A', target: 'A' }],
  unmappedFieldCount: 1, discardedValues: 0, discardedAlternatives: 0, unmappedFields: [{ field: 'Extra', action: 'preserve', nonemptyNotes: 1, example: 'Preserve' }] };
let root: Root; let host: HTMLDivElement; let fetchBefore: typeof fetch;
beforeEach(() => {
  ensureTestDom(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); fetchBefore = globalThis.fetch;
  useNN.setState({ noteTypes: [source, target].map(noteTypeFromApi), cards: selected });
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = fetchBefore; useNN.getState().reset(); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });
afterAll(() => { try { GlobalRegistrator.unregister(); } catch {} });
const button = (key: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find((button) => button.textContent?.includes(key))!;

test('a conversion previews once per note, preserves unmatched fields and applies the exact mapping/token', async () => {
  const writes: any[] = []; let completed = false;
  globalThis.fetch = (async (url: any, init: any) => {
    writes.push({ url: String(url), body: JSON.parse(init.body) });
    return Response.json(String(url).endsWith('/preview') ? preview : { noteIds: ['note'], cards: [{ ...row, noteType: target }] });
  }) as typeof fetch;
  await act(async () => root.render(<NoteConversionDialog cards={selected} targetTypeId="target" onClose={() => {}} onConverted={() => { completed = true; }} />));
  await act(async () => button('noteTypes.kind.preview').click());
  expect(writes).toHaveLength(1); expect(completed).toBe(false);
  expect(writes[0].body).toMatchObject({ noteIds: ['note'], preserveUnmappedFields: true, fieldMap: { Q: 'Q', A: 'A' }, templateMap: { after: 'before' } });
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Preserve');
  await act(async () => button('noteTypes.convert.apply').click());
  expect(writes).toHaveLength(2); expect(writes[1].body).toEqual({ ...writes[0].body, confirmationToken: 'exact-consent' });
  expect(completed).toBe(true);
  expect(useNN.getState().cards.map((card) => card.id)).toEqual(['card']);
  expect(useNN.getState().cards[0].noteType?.id).toBe('target');
});

test('invalid notes disable apply and back retains the explicit discard choice', async () => {
  let writes = 0;
  globalThis.fetch = (async () => { writes++; return Response.json({ ...preview, validation: { ...preview.validation, invalidNotes: 1 } }); }) as unknown as typeof fetch;
  await act(async () => root.render(<NoteConversionDialog cards={selected} targetTypeId="target" onClose={() => {}} onConverted={() => { throw new Error('must not apply'); }} />));
  const checkbox = document.querySelector('[role="dialog"] input[type="checkbox"]') as HTMLInputElement;
  await act(async () => checkbox.click());
  await act(async () => button('noteTypes.kind.preview').click());
  expect(button('noteTypes.convert.apply').disabled).toBe(true);
  expect(writes).toBe(1);
  await act(async () => button('noteTypes.convert.back').click());
  expect((document.querySelector('[role="dialog"] input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
});

test('a late response after leaving cannot complete a stale conversion', async () => {
  const response = Promise.withResolvers<Response>(); let completed = false;
  globalThis.fetch = (() => response.promise) as unknown as typeof fetch;
  await act(async () => root.render(<NoteConversionDialog cards={selected} targetTypeId="target" onClose={() => {}} onConverted={() => { completed = true; }} />));
  await act(async () => { button('noteTypes.kind.preview').click(); });
  await act(async () => root.render(<div>Other screen</div>));
  await act(async () => response.resolve(Response.json(preview)));
  expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(completed).toBe(false);
});

test('an uncertain apply failure offers reload before retrying against stale selection', async () => {
  globalThis.fetch = (async (url: any) => String(url).endsWith('/preview') ? Response.json(preview)
    : Response.json({ error: 'unavailable' }, { status: 503 })) as unknown as typeof fetch;
  await act(async () => root.render(<NoteConversionDialog cards={selected} targetTypeId="target" onClose={() => {}} onConverted={() => { throw new Error('no verified result'); }} />));
  await act(async () => button('noteTypes.kind.preview').click());
  await act(async () => button('noteTypes.convert.apply').click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('noteTypes.convert.checkState');
  expect(button('noteTypes.convert.reload').disabled).toBe(false);
  expect(useNN.getState().cards[0].noteType?.id).toBe('source');
});

test('a chosen destination deck must be acknowledged before the client offers apply', async () => {
  useNN.setState({ decks: [{ id: 'new-deck', name: 'New questions', color: 'lime', species: 'fern', createdAt: 0 }] });
  let sent: any;
  globalThis.fetch = (async (_url: any, init: any) => { sent = JSON.parse(init.body); return Response.json(preview); }) as typeof fetch;
  await act(async () => root.render(<NoteConversionDialog cards={selected} targetTypeId="target" onClose={() => {}} onConverted={() => { throw new Error('must not apply'); }} />));
  const deck = document.querySelector('[aria-label^="noteTypes.convert.newDeck"]') as HTMLButtonElement;
  await act(async () => deck.click());
  await act(async () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find((option) => option.textContent === 'New questions')!.click());
  await act(async () => button('noteTypes.kind.preview').click());
  expect(sent.newCardsDeckId).toBe('new-deck');
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('noteTypes.convert.deckUnsupported');
  expect(button('noteTypes.convert.apply')).toBeUndefined();
});
