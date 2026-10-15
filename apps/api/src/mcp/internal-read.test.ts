import { expect, test } from 'bun:test';
import type { User } from '@reomi/db';
import { internalReadDeckScope, internalReadUser, withInternalRead } from './internal-read';

test('internal context is request-local, copied, and removed after a failed read', async () => {
  const user = { id: 'owner' } as User;
  const request = new Request('http://localhost/cards');
  const other = new Request(request);
  const scope = ['selected'];
  await expect(withInternalRead(request, user, async () => {
    scope.push('not-authorized');
    expect(internalReadDeckScope(request)).toEqual(['selected']);
    expect(internalReadUser(request)).toBe(user);
    expect(internalReadDeckScope(other)).toBeUndefined();
    expect(internalReadUser(other)).toBeUndefined();
    throw new Error('read failed');
  }, scope)).rejects.toThrow('read failed');
  expect(internalReadDeckScope(request)).toBeUndefined();
  expect(internalReadUser(request)).toBeUndefined();
});

test('headers cannot supply internal context and an empty selection stays explicit', async () => {
  const request = new Request('http://localhost/cards', { headers: {
    'x-user-id': 'owner', 'x-deck-scope': 'selected',
  } });
  expect(internalReadUser(request)).toBeUndefined();
  expect(internalReadDeckScope(request)).toBeUndefined();
  await withInternalRead(request, { id: 'owner' } as User, async () => {
    expect(internalReadDeckScope(request)).toEqual([]);
  }, []);
  expect(internalReadDeckScope(request)).toBeUndefined();
});
