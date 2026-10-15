import { ensureTestDom, GlobalRegistrator } from '../../lib/test-dom-setup';
import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act, useState } from 'react';
import type { Root } from 'react-dom/client';
import { newUuidV7 } from '@reomi/shared';
import { useNN } from '../../lib/store';
import type { NotebookNote } from '../../lib/types';
ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { NotePinButton } = await import('./note-pin-button');
let root: Root, host: HTMLDivElement, oldFetch: typeof fetch;
beforeEach(() => { ensureTestDom(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true; oldFetch = globalThis.fetch;
  useNN.setState({ profile: { userId: newUuidV7() } as any }); host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); globalThis.fetch = oldFetch; useNN.getState().reset(); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });
afterAll(() => { try { GlobalRegistrator.unregister(); } catch {} });
test('uncertain pin resolves the original request without toggling again or losing the retry control', async () => {
  const note = { id: 'note', title: 'Note', content: 'Body', metadataRevision: 4, pinned: false } as NotebookNote;
  let requestId = '', writes = 0;
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    if (String(url).endsWith('/session')) return Response.json({ sessionId: newUuidV7() });
    if (init?.method === 'PATCH') { const body = JSON.parse(String(init.body)); requestId = body.requestId; expect(body.expectedRevision).toBe(4); writes++; throw new Error('lost'); }
    return Response.json({ result: { ...note, pinned: true, metadataRevision: 5 }, outcome: 'applied', replayed: true,
      receipt: { id: 'receipt', requestId, kind: 'study-note-pin', target: { kind: 'study-note', id: note.id, revision: '5' }, label: 'Note', undoUntil: null } });
  }) as unknown as typeof fetch;
  function Harness() { const [current, update] = useState(note); return <NotePinButton note={current} onUpdated={update} />; }
  await act(async () => root.render(<Harness />));
  await act(async () => host.querySelector<HTMLButtonElement>('button')!.click());
  expect(host.textContent).toContain('actionsRecovery.uncertain'); expect(host.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'actionsRecovery.retry')!.click());
  expect(writes).toBe(1); expect(host.querySelector('button')!.getAttribute('aria-label')).toBe('notebooks.notes.unpin');
});
