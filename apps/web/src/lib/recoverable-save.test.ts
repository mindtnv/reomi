import { expect, test } from 'bun:test';
import { RecoverableSave } from './recoverable-save';
import type { UiActionResult } from '@reomi/shared';

const result = (id = 'note'): UiActionResult => ({ receipt: { id: 'receipt', requestId: 'request', kind: 'study-note-create',
  label: 'Note', target: { kind: 'study-note', id, revision: '1' }, createdAt: new Date().toISOString(), undoUntil: null, consumedAt: null },
  result: { id, title: 'Saved A' }, outcome: 'applied', replayed: false, serverTime: new Date().toISOString() });

test('acknowledgement of A never claims that later input B is saved', async () => {
  const save = new RecoverableSave<{ title: string }>('owner');
  save.edit('A');
  const response = Promise.withResolvers<UiActionResult>();
  const pending = save.run({ title: 'A' }, 'A', () => response.promise, async () => result());
  save.edit('B');
  expect(save.getSnapshot().status).toBe('saving');
  response.resolve(result());
  const accepted = await pending;
  expect(accepted?.currentMatches).toBe(false);
  expect(save.getSnapshot().status).toBe('dirty');
  expect(save.getSnapshot().pending).toBeNull();
});

test('lost responses keep the original payload and resolve before another create', async () => {
  const save = new RecoverableSave<{ title: string }>('owner');
  save.edit('A');
  let writes = 0;
  const execute = async () => { writes++; throw new Error('response lost'); };
  await save.run({ title: 'A' }, 'A', execute, async () => result());
  expect(save.getSnapshot().status).toBe('uncertain');
  expect(save.getSnapshot().pending?.payload).toEqual({ title: 'A' });
  save.edit('B');
  const reconciled = await save.run({ title: 'B' }, 'B', execute, async () => result());
  expect(writes).toBe(1);
  expect(reconciled?.submitted.payload).toEqual({ title: 'A' });
  expect(save.getSnapshot().status).toBe('dirty');
});

test('definitive validation failure is retryable and teardown ignores late receipts', async () => {
  const save = new RecoverableSave<{ title: string }>('owner');
  save.edit('invalid');
  await save.run({ title: '' }, 'invalid', async () => { throw Object.assign(new Error('invalid_note'), { status: 400 }); }, async () => result());
  expect(save.getSnapshot().status).toBe('failed');
  const response = Promise.withResolvers<UiActionResult>();
  const pending = save.run({ title: 'Valid' }, 'valid', () => response.promise, async () => result());
  save.dispose(); response.resolve(result());
  expect(await pending).toBeNull();
  expect(save.getSnapshot().status).not.toBe('saved');
});

test('a recovered pending request reuses its identity after a confirmed missing receipt', async () => {
  const first = new RecoverableSave<{ title: string }>('owner');
  first.edit('A');
  await first.run({ title: 'A' }, 'A', async () => { throw new Error('offline'); }, async () => result());
  const pending = first.getSnapshot().pending!;
  const recovered = new RecoverableSave<{ title: string }>('owner');
  recovered.restorePending(pending); recovered.edit('A');
  let seen = '';
  await recovered.run({ title: 'ignored' }, 'A', async request => { seen = request.requestId; return result(); },
    async () => { throw Object.assign(new Error('receipt_not_found'), { status: 404, safeMessage: 'receipt_not_found' }); });
  expect(seen).toBe(pending.requestId);
  expect(recovered.getSnapshot().status).toBe('saved');
});

test('missing reconciliation support does not discard an uncertain request or mint a second create', async () => {
  const save = new RecoverableSave<{ title: string }>('owner');
  await save.run({ title: 'A' }, 'A', async () => { throw new Error('lost'); }, async () => result());
  const pending = save.getSnapshot().pending;
  let writes = 0;
  await save.run({ title: 'B' }, 'B', async () => { writes++; return result(); },
    async () => { throw Object.assign(new Error('NotFound'), { status: 404, safeMessage: 'NotFound' }); });
  expect(save.getSnapshot().status).toBe('uncertain');
  expect(save.getSnapshot().pending).toEqual(pending);
  expect(writes).toBe(0);
});

test('expired uncertainty survives another reload instead of becoming a fresh create identity', async () => {
  const first = new RecoverableSave<{ title: string }>('owner');
  await first.run({ title: 'A' }, 'A', async () => { throw new Error('lost'); }, async () => result());
  const original = first.getSnapshot().pending!;
  const missing = async () => { throw Object.assign(new Error('receipt_not_found'), { status: 404, safeMessage: 'receipt_not_found' }); };
  const expired = async () => { throw Object.assign(new Error('request_expired'), { status: 409, safeMessage: 'request_expired' }); };
  await first.run({ title: 'B' }, 'B', expired, missing);
  expect(first.getSnapshot().status).toBe('conflict'); expect(first.getSnapshot().pending).toEqual(original);
  const reloaded = new RecoverableSave<{ title: string }>('owner'); reloaded.restorePending(first.getSnapshot().pending!);
  let identity = '';
  await reloaded.run({ title: 'B' }, 'B', async request => { identity = request.requestId; return expired(); }, missing);
  expect(identity).toBe(original.requestId); expect(reloaded.getSnapshot().pending).toEqual(original);
});

test('reauthentication between a missing-receipt read and replay does not erase uncertainty', async () => {
  const save = new RecoverableSave<{ title: string }>('owner');
  await save.run({ title: 'A' }, 'A', async () => { throw new Error('lost'); }, async () => result());
  const original = save.getSnapshot().pending;
  await save.run({ title: 'B' }, 'B', async () => { throw Object.assign(new Error('unauthorized'), { status: 401 }); },
    async () => { throw Object.assign(new Error('receipt_not_found'), { status: 404, safeMessage: 'receipt_not_found' }); });
  expect(save.getSnapshot().status).toBe('uncertain'); expect(save.getSnapshot().pending).toEqual(original);
});
