import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import { ensureTestDom, GlobalRegistrator } from '../lib/test-dom-setup';
import React, { act } from 'react';
import { useNN } from '../lib/store';
import { clearSessionResourceCache } from '../lib/session-resource';
import { DialogProvider } from './dialog';
ensureTestDom();
const { createRoot } = await import('react-dom/client');
const { LibraryDocumentation } = await import('./library-documentation');
let root: ReturnType<typeof createRoot>, host: HTMLDivElement, originalFetch: typeof fetch;
beforeEach(() => {
  ensureTestDom(); (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  originalFetch = globalThis.fetch; clearSessionResourceCache();
  useNN.setState({ profile: { userId: 'owner-a' } as any, bootstrapped: true });
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); globalThis.fetch = originalFetch;
  clearSessionResourceCache(); useNN.getState().reset(); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
});
afterAll(() => { try { GlobalRegistrator.unregister(); } catch {} });

test('late error details and busy state do not cross account boundaries', async () => {
  let completeErrors!: (response: Response) => void;
  const requests: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input); requests.push(url);
    if (url.endsWith('/errors')) return new Promise<Response>(resolve => { completeErrors = resolve; });
    const owner = useNN.getState().profile?.userId;
    return Response.json({ items: [{ id: owner, rootUrl: 'https://example.com/docs/', title: owner, locale: 'en', folderId: 'folder',
      state: 'attention', total: 2, completed: 1, pending: 0, failed: 1, deleted: 0, errorCode: null }] });
  }) as typeof fetch;
  await act(async () => root.render(<DialogProvider><LibraryDocumentation open={false} onClose={() => {}} onChanged={() => {}} onOpenFolder={() => {}} /></DialogProvider>));
  expect(host.textContent).toContain('owner-a');
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent?.includes('library.documentation.failures'))!.click());
  expect(completeErrors).toBeDefined();
  await act(async () => useNN.setState({ profile: { userId: 'owner-b' } as any }));
  expect(host.textContent).toContain('owner-b'); expect(host.textContent).not.toContain('owner-a');
  await act(async () => completeErrors(Response.json({ items: [{ id: 'private', title: 'Private outgoing title', url: 'https://private.example/docs', errorCode: 'fetch_failed' }] })));
  expect(host.textContent).not.toContain('Private outgoing title');
  expect([...host.querySelectorAll('button')].find(button => button.textContent?.includes('library.documentation.checkUpdates'))?.disabled).toBe(false);
  expect(requests.filter(url => url.endsWith('/errors'))).toHaveLength(1);
});

test('an uncertain update response reconciles the accepted server job', async () => {
  let state = 'completed', updates = 0;
  globalThis.fetch = (async (input: unknown) => {
    if (String(input).endsWith('/updates')) { updates++; state = 'queued'; return Response.json({ error: 'connection_interrupted' }, { status: 502 }); }
    return Response.json({ items: [{ id: 'connection', rootUrl: 'https://example.com/docs/', title: 'Docs', locale: 'en', folderId: 'folder',
      state, total: 2, completed: 0, pending: 2, failed: 0, deleted: 0, errorCode: null }] });
  }) as typeof fetch;
  await act(async () => root.render(<DialogProvider><LibraryDocumentation open={false} onClose={() => {}} onChanged={() => {}} onOpenFolder={() => {}} /></DialogProvider>));
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent?.includes('library.documentation.checkUpdates'))!.click());
  expect(updates).toBe(1);
  expect(host.textContent).toContain('library.documentation.states.queued');
  expect(host.textContent).toContain('library.documentation.cancelImport');
  expect(host.querySelector('progress')).not.toBeNull();
});
