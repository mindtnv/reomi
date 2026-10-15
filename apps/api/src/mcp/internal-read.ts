import type { User } from '@reomi/db';

// Identity is associated with the Request object, never with a header that a
// remote caller could forge. Only the curated MCP and authenticated chat GET bridges create entries.
const identities = new WeakMap<Request, User>();
const deckScopes = new WeakMap<Request, readonly string[]>();
export function internalReadDeckScope(request: Request): readonly string[] | undefined {
  return request.method === 'GET' ? deckScopes.get(request) : undefined;
}
export function internalReadUser(request: Request) {
  return request.method === 'GET' ? identities.get(request) : undefined;
}
export async function withInternalRead<T>(request: Request, user: User, run: () => Promise<T>, deckIds?: readonly string[]) {
  if (request.method !== 'GET') throw new Error('internal_read_only');
  identities.set(request, user);
  if (deckIds !== undefined) deckScopes.set(request, [...deckIds]);
  try { return await run(); } finally { identities.delete(request); deckScopes.delete(request); }
}
