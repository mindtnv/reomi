import { beforeEach, describe, expect, test } from 'bun:test';
import { buildApp } from '../src/app.ts';
import { callApp, resetTestDb, signUpAndCookie } from './helpers.ts';

const app = buildApp();
beforeEach(resetTestDb);

async function issue(cookie: string, scope: 'read' | 'write' = 'read') {
  const response = await callApp(app, 'POST', '/profile/tokens', {
    cookie, body: { name: 'Test agent', scope, expiresInDays: 30 },
  });
  expect(response.status).toBe(200);
  return response.json<{ token: string; item: { id: string; prefix: string; scope: string } }>();
}

async function rpc(token: string, method: string, params: unknown = {}) {
  return callApp(app, 'POST', '/mcp', {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: 1, method, params },
  });
}

describe('personal MCP credentials', () => {
  test('requires a browser session to create, list and revoke tokens', async () => {
    expect((await callApp(app, 'GET', '/profile/tokens')).status).toBe(401);
    expect((await callApp(app, 'POST', '/profile/tokens', { body: { name: 'x' } })).status).toBe(401);
    const { cookie } = await signUpAndCookie(app, 'mcp@example.com');
    const created = await issue(cookie);
    expect(created.token).toMatch(/^nn_pat_[A-Za-z0-9_-]{43}$/);
    const list = await callApp(app, 'GET', '/profile/tokens', { cookie });
    const text = await list.text();
    expect(text).toContain(created.item.id);
    expect(text).not.toContain(created.token);
    expect(text).not.toContain('tokenHash');
    const { db, personalAccessTokens } = await import('@reomi/db');
    const { eq } = await import('drizzle-orm');
    const [stored] = await db.select().from(personalAccessTokens).where(eq(personalAccessTokens.id, created.item.id));
    expect(stored!.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(created.token);
    expect((await callApp(app, 'GET', '/profile/tokens', {
      headers: { authorization: `Bearer ${created.token}` },
    })).status).toBe(401);
  });

  test('isolates token lists and revocation and rejects revoked credentials', async () => {
    const { cookie: alice } = await signUpAndCookie(app, 'alice-mcp@example.com');
    const { cookie: bob } = await signUpAndCookie(app, 'bob-mcp@example.com');
    const created = await issue(alice);
    expect(await (await callApp(app, 'GET', '/profile/tokens', { cookie: bob })).text()).not.toContain(created.item.id);
    expect((await callApp(app, 'DELETE', `/profile/tokens/${created.item.id}`, { cookie: bob })).status).toBe(404);
    expect((await rpc(created.token, 'tools/list')).status).toBe(200);
    expect((await callApp(app, 'DELETE', `/profile/tokens/${created.item.id}`, { cookie: alice })).status).toBe(200);
    expect((await rpc(created.token, 'tools/list')).status).toBe(401);
  });

  test('validates names, scope and expiry', async () => {
    const { cookie } = await signUpAndCookie(app, 'bounds-mcp@example.com');
    for (const body of [
      { name: ' ' }, { name: 'x', scope: 'admin' },
      { name: 'x', expiresInDays: 0 }, { name: 'x', expiresInDays: 366 },
    ]) expect((await callApp(app, 'POST', '/profile/tokens', { cookie, body })).status).toBe(400);
  });

  test('rejects cross-origin token administration and keeps active tokens visible after rotation', async () => {
    const { db, personalAccessTokens } = await import('@reomi/db');
    const { cookie, userId } = await signUpAndCookie(app, 'rotation-mcp@example.com');
    const active = await issue(cookie);
    expect((await callApp(app, 'POST', '/profile/tokens', { cookie, headers: { origin: 'https://evil.example' }, body: { name: 'bad' } })).status).toBe(403);
    await db.insert(personalAccessTokens).values(Array.from({ length: 101 }, (_, n) => ({ userId, name: `Old ${n}`, tokenHash: `test-revoked-${n}`, prefix: 'revoked', expiresAt: new Date(0), revokedAt: new Date() })));
    const list = await (await callApp(app, 'GET', '/profile/tokens', { cookie })).json<any[]>();
    expect(list).toHaveLength(100);
    expect(list[0].id).toBe(active.item.id);
  });
});

describe('MCP protocol', () => {
  test('initializes and discovers read tools without AI credentials', async () => {
    const { cookie } = await signUpAndCookie(app, 'protocol-mcp@example.com');
    const { token } = await issue(cookie);
    const initialized = await rpc(token, 'initialize', {
      protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' },
    });
    expect(initialized.status).toBe(200);
    const initializedBody = await initialized.json<any>();
    expect(initializedBody.result.serverInfo.name).toBe('reomi');
    expect(initializedBody.result.instructions).toContain('Reomi');
    expect(initializedBody.result.instructions).not.toContain('NeuroNexus');
    const tools = (await (await rpc(token, 'tools/list')).json<any>()).result.tools;
    expect(tools.length).toBeGreaterThan(20);
    expect(tools.find((t: any) => t.name === 'browse_cards')).toBeDefined();
    expect(tools.find((t: any) => t.name === 'create_card')).toBeUndefined();
    const result = await rpc(token, 'tools/call', { name: 'list_decks', arguments: {} });
    expect((await result.json<any>()).result.isError).not.toBe(true);
  });

  test('rejects cookie-only auth and hostile browser origins', async () => {
    const { cookie } = await signUpAndCookie(app, 'origin-mcp@example.com');
    const { token } = await issue(cookie);
    expect((await callApp(app, 'POST', '/mcp', { cookie, body: {} })).status).toBe(401);
    expect((await callApp(app, 'POST', '/mcp', {
      headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example' }, body: {},
    })).status).toBe(403);
  });

  test('serves Reomi resources, keeps legacy URIs equivalent, and hides unknown ones', async () => {
    const denied = await callApp(app, 'POST', '/mcp', {
      headers: { accept: 'application/json, text/event-stream' },
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    });
    expect(denied.status).toBe(401);
    expect(denied.headers['www-authenticate']).toBe('Bearer realm="Reomi MCP"');
    const { cookie, userId } = await signUpAndCookie(app, 'identity-mcp@example.com');
    const { token } = await issue(cookie);
    const uris = (await (await rpc(token, 'resources/list')).json<any>()).result.resources.map((item: { uri: string }) => item.uri);
    expect(uris).toEqual(['reomi://guide', 'reomi://connection']);
    const guide = (await (await rpc(token, 'resources/read', { uri: 'reomi://guide' })).json<any>()).result.contents[0].text;
    const legacyGuide = (await (await rpc(token, 'resources/read', { uri: 'neuronexus://guide' })).json<any>()).result.contents[0].text;
    expect(legacyGuide).toBe(guide);
    expect(guide).toContain('Reomi');
    const connection = JSON.parse((await (await rpc(token, 'resources/read', { uri: 'reomi://connection' })).json<any>()).result.contents[0].text);
    const legacyConnection = JSON.parse((await (await rpc(token, 'resources/read', { uri: 'neuronexus://connection' })).json<any>()).result.contents[0].text);
    expect(legacyConnection).toEqual(connection);
    expect(connection.scope).toBe('read');
    const unknown = JSON.stringify(await (await rpc(token, 'resources/read', { uri: 'https://example.invalid/secret' })).json<any>());
    expect(unknown).not.toContain(userId);
    expect(unknown).not.toContain('identity-mcp@example.com');
    expect(unknown).not.toContain(token);
    const names = (await (await rpc(token, 'tools/list')).json<any>()).result.tools.map((item: { name: string }) => item.name);
    expect(names).toContain('browse_cards');
    expect(names).toContain('list_decks');
    expect(names).not.toContain('create_card');
    expect(names).not.toContain('confirm_action');
    expect((await invoke(token, 'create_card', { deckId: 'nope' })).isError).toBe(true);
    expect((await invoke(token, 'confirm_action', { actionId: '00000000-0000-7000-8000-000000000000', decision: 'apply', confirmed: true })).isError).toBe(true);
    expect((await callApp(app, 'POST', '/mcp', {
      headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example', accept: 'application/json, text/event-stream' },
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    })).status).toBe(403);
  });
});

async function invoke(token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await rpc(token, 'tools/call', { name, arguments: args });
  expect(response.status).toBe(200);
  const body = await response.json<any>();
  expect(body.error).toBeUndefined();
  return body.result;
}
const data = (result: any) => result.structuredContent?.data;

async function fixture(scope: 'read' | 'write' = 'write') {
  const { cookie, userId } = await signUpAndCookie(app, 'fixture-mcp@example.com');
  return { cookie, userId, ...await issue(cookie, scope) };
}
async function apply(token: string, actionId: string) {
  return invoke(token, 'confirm_action', { actionId, decision: 'apply', confirmed: true });
}

test('a confirmed MCP hierarchy mutation and a versioned UI move serialize without applying stale decisions', async () => {
  const { cookie, token } = await fixture();
  const create = async (name: string) => (await callApp(app, 'POST', '/decks', { cookie, body: { name } })).json<any>();
  const a = await create('A'), b = await create('B'), c = await create('C');
  const snapshot = await (await callApp(app, 'GET', '/ui-actions/v1/deck-hierarchy', { cookie })).json<any>();
  const preview = data(await invoke(token, 'update_deck', { id: b.id, parentId: a.id }));
  const { newUuidV7 } = await import('@reomi/shared');
  const [ui, agent] = await Promise.all([
    callApp(app, 'POST', `/ui-actions/v1/decks/${c.id}/move`, { cookie,
      body: { requestId: newUuidV7(), sessionId: newUuidV7(), expectedRevision: snapshot.revision, targetId: a.id, placement: 'before' } }),
    apply(token, preview.actionId),
  ]);
  if (ui.status === 200) {
    expect(agent.isError).toBe(true);
    const receipt = (await ui.json<any>()).receipt;
    expect((await callApp(app, 'POST', `/ui-actions/v1/receipts/${receipt.id}/undo`, { cookie })).status).toBe(200);
  } else { expect(ui.status).toBe(409); expect(agent.isError).not.toBe(true); }
  const current = await (await callApp(app, 'GET', '/decks', { cookie })).json<any[]>();
  expect(new Set(current.map(row => row.id)).size).toBe(3);
  for (const row of current) {
    const seen = new Set<string>(); let id: string | null = row.id;
    while (id) { expect(seen.has(id)).toBe(false); seen.add(id); id = current.find(deck => deck.id === id)?.parentId ?? null; }
  }
});

describe('MCP confirmed management', () => {
  test('preview does not write; explicit confirmation applies once under concurrent replay', async () => {
    const { cookie, token } = await fixture();
    const preview = data(await invoke(token, 'create_deck', { name: 'Proposed deck' }));
    expect(preview.status).toBe('awaiting_confirmation');
    expect(await (await callApp(app, 'GET', '/decks', { cookie })).json()).toEqual([]);
    const denied = await invoke(token, 'confirm_action', { actionId: preview.actionId, decision: 'apply', confirmed: false });
    expect(denied.isError).toBe(true);
    const outcomes = await Promise.all([apply(token, preview.actionId), apply(token, preview.actionId)]);
    expect(outcomes.filter(r => r.isError).length).toBe(1);
    expect(outcomes.filter(r => data(r)?.status === 'applied').length).toBe(1);
    expect((await (await callApp(app, 'GET', '/decks', { cookie })).json<any[]>()).length).toBe(1);
  });

  test('rejects stale previews, forbidden fields, other tokens and other users', async () => {
    const { cookie, token } = await fixture();
    const other = await issue(cookie, 'write');
    const { cookie: foreignCookie } = await signUpAndCookie(app, 'foreign-mcp@example.com');
    const foreign = await issue(foreignCookie, 'write');
    const deck = await (await callApp(app, 'POST', '/decks', { cookie, body: { name: 'Original' } })).json<{ id: string }>();
    const p = data(await invoke(token, 'update_deck', { id: deck.id, name: 'Approved name' }));
    expect((await apply(other.token, p.actionId)).isError).toBe(true);
    expect((await apply(foreign.token, p.actionId)).isError).toBe(true);
    expect((await invoke(token, 'confirm_action', { actionId: p.actionId, decision: 'apply', confirmed: true, name: 'Injected' })).isError).toBe(true);
    await callApp(app, 'PATCH', `/decks/${deck.id}`, { cookie, body: { name: 'Changed by user' } });
    const stale = await apply(token, p.actionId);
    expect(stale.isError).toBe(true);
    expect(stale.content[0].text).toContain('stale_preview');
    expect((await invoke(foreign.token, 'update_deck', { id: deck.id, name: 'Stolen' })).isError).toBe(true);
    expect((await invoke(token, 'create_deck', { name: 'bad', userId: 'someone' })).isError).toBe(true);
  });

  test('supports rejection, expiration and revocation after preview', async () => {
    const { db, mcpActions, personalAccessTokens } = await import('@reomi/db');
    const { eq } = await import('drizzle-orm');
    const { cookie, token, item } = await fixture();
    const p = data(await invoke(token, 'create_notebook', { title: 'Rejected' }));
    expect(data(await invoke(token, 'confirm_action', { actionId: p.actionId, decision: 'reject', confirmed: false })).status).toBe('rejected');
    expect((await apply(token, p.actionId)).isError).toBe(true);
    const p2 = data(await invoke(token, 'create_notebook', { title: 'Expired' }));
    await db.update(mcpActions).set({ expiresAt: new Date(0) }).where(eq(mcpActions.id, p2.actionId));
    expect((await apply(token, p2.actionId)).isError).toBe(true);
    await db.update(personalAccessTokens).set({ expiresAt: new Date(0) }).where(eq(personalAccessTokens.id, item.id));
    expect((await rpc(token, 'tools/list')).status).toBe(401);
    const second = await issue(cookie, 'write');
    const p3 = data(await invoke(second.token, 'create_notebook', { title: 'Revoked' }));
    await callApp(app, 'DELETE', `/profile/tokens/${second.item.id}`, { cookie });
    expect((await rpc(second.token, 'tools/call', { name: 'confirm_action', arguments: { actionId: p3.actionId, decision: 'apply', confirmed: true } })).status).toBe(401);
  });

  test('read-only cannot propose, apply, or bypass MCP through REST', async () => {
    const { token } = await fixture('read');
    expect((await invoke(token, 'create_deck', { name: 'Forbidden' })).isError).toBe(true);
    expect((await invoke(token, 'confirm_action', { actionId: crypto.randomUUID(), decision: 'apply', confirmed: true })).isError).toBe(true);
    expect((await callApp(app, 'POST', '/decks', { headers: { authorization: `Bearer ${token}`, 'x-mcp-user-id': 'spoof' }, body: { name: 'Bypass' } })).status).toBe(401);
  });

  test('card creation, editing, scheduling and deletion reuse confirmed domain semantics', async () => {
    const { ensureBuiltins, db } = await import('@reomi/db');
    await ensureBuiltins(db);
    const { cookie, token } = await fixture();
    const deck = data(await apply(token, data(await invoke(token, 'create_deck', { name: 'Cards' })).actionId)).result;
    const proposal = await invoke(token, 'create_card', { deckId: deck.id, fieldValues: { Front: 'Question', Back: 'Answer' } });
    expect(proposal.isError).not.toBe(true);
    const applied = await apply(token, data(proposal).actionId);
    expect(applied).toMatchObject({ structuredContent: { data: { status: 'applied' } } });
    const created = data(applied);
    expect(created.status).toBe('applied');
    const cardId = created.result.cardIds[0];
    expect(data(await invoke(token, 'get_card', { cardId })).text).toContain('Question');
    const edit = data(await invoke(token, 'edit_card', { cardId, fieldValues: { Back: 'Updated answer' } }));
    expect(data(await apply(token, edit.actionId)).status).toBe('applied');
    expect(data(await invoke(token, 'get_card', { cardId })).text).toContain('Updated answer');
    for (const [name, args] of [
      ['suspend', { cardId, suspended: true }],
      ['set_due', { cardId, due: '2030-01-01T00:00:00.000Z' }],
      ['forget', { cardId }],
      ['edit_card', { cardId, suspended: true }],
    ] as const) {
      const preview = data(await invoke(token, name, args));
      expect(data(await apply(token, preview.actionId)).status).toBe('applied');
    }
    const controlled = await (await callApp(app, 'GET', `/cards/${cardId}`, { cookie })).json<any>();
    expect(controlled.suspended).toBe(true);
    expect(controlled.state).toBe('new');
    const deleted = data(await invoke(token, 'delete_card', { id: cardId }));
    expect(data(await apply(token, deleted.actionId)).status).toBe('applied');
    expect((await callApp(app, 'GET', `/cards/${cardId}`, { cookie })).status).toBe(404);
  });

  test('note edits reject changed review state and apply a fresh preview atomically', async () => {
    const { ensureBuiltins, db, cards, mcpActions } = await import('@reomi/db');
    const { eq } = await import('drizzle-orm');
    await ensureBuiltins(db);
    const { token } = await fixture();
    const deck = data(await apply(token, data(await invoke(token, 'create_deck', { name: 'Note edits' })).actionId)).result;
    const created = data(await apply(token, data(await invoke(token, 'create_card', {
      deckId: deck.id, fieldValues: { Front: 'Question', Back: 'Original' },
    })).actionId));
    const cardId = created.result.cardIds[0];
    const [before] = await db.select().from(cards).where(eq(cards.id, cardId));
    const args = { noteId: before!.noteId, fieldValues: { Back: 'Confirmed' }, tags: ['mcp'] };
    const stale = data(await invoke(token, 'edit_card', args));
    // A review after preview changes the protected regeneration state even
    // though the fields and question identity did not change.
    await db.update(cards).set({ reps: 1 }).where(eq(cards.id, cardId));
    expect((await apply(token, stale.actionId)).isError).toBe(true);
    expect(data(await invoke(token, 'get_card', { cardId })).text).toContain('Original');
    const [pending] = await db.select().from(mcpActions).where(eq(mcpActions.id, stale.actionId));
    expect(pending!.consumedAt).toBeNull();
    const fresh = data(await invoke(token, 'edit_card', args));
    expect(data(await apply(token, fresh.actionId)).status).toBe('applied');
    expect(data(await invoke(token, 'get_card', { cardId })).text).toContain('Confirmed');
    const [after] = await db.select().from(cards).where(eq(cards.id, cardId));
    expect(after!.reps).toBe(1);
    expect(after!.id).toBe(before!.id);
  });

  test('card-control writes participate in the caller transaction and roll back on failure', async () => {
    const { db, cards, ensureBuiltins } = await import('@reomi/db');
    const { eq } = await import('drizzle-orm');
    const { buildToolRegistry } = await import('../src/ai/tools.ts');
    const { rootLogger } = await import('../src/logger.ts');
    await ensureBuiltins(db);
    const { token, userId } = await fixture();
    const deck = data(await apply(token, data(await invoke(token, 'create_deck', { name: 'Rollback' })).actionId)).result;
    const created = data(await apply(token, data(await invoke(token, 'create_card', { deckId: deck.id, fieldValues: { Front: 'F', Back: 'B' } })).actionId));
    const cardId = created.result.cardIds[0];
    const suspend = buildToolRegistry().find(t => t.name === 'suspend')!;
    await expect(db.transaction(async tx => {
      await suspend.execute({ userId, log: rootLogger, tx }, { cardId, suspended: true });
      throw new Error('rollback_fixture');
    })).rejects.toThrow('rollback_fixture');
    expect((await db.select().from(cards).where(eq(cards.id, cardId)))[0]!.suspended).toBe(false);
  });

  test('notebooks, notes, source imports and attachments are managed without AI keys', async () => {
    const { db, sources } = await import('@reomi/db');
    const { eq } = await import('drizzle-orm');
    const { token, userId } = await fixture();
    const nb = data(await apply(token, data(await invoke(token, 'create_notebook', { title: 'Research' })).actionId)).result;
    const saved = await invoke(token, 'save_note', { notebookId: nb.id, title: 'Findings', content: 'Evidence' });
    expect(data(await apply(token, data(saved).actionId)).status).toBe('applied');
    const listed = data(await invoke(token, 'list_notebook_notes', { id: nb.id }));
    expect(listed.items).toHaveLength(1);
    const noteId = listed.items[0].id;
    const edit = data(await invoke(token, 'update_note', { id: noteId, content: 'Revised evidence' }));
    expect(data(await apply(token, edit.actionId)).status).toBe('applied');
    expect(data(await invoke(token, 'read_note', { notebookId: nb.id, noteId })).text).toContain('Revised evidence');
    const source = data(await apply(token, data(await invoke(token, 'create_text_source', { title: 'Source', text: 'Reference text' })).actionId)).result;
    expect(source.userId).toBe(userId);
    const attach = data(await invoke(token, 'attach_source', { notebookId: nb.id, sourceId: source.id }));
    expect(data(await apply(token, attach.actionId)).status).toBe('applied');
    expect(data(await invoke(token, 'list_notebook_sources', { id: nb.id })).items).toHaveLength(1);
    expect(data(await apply(token, data(await invoke(token, 'delete_notebook', { id: nb.id })).actionId)).status).toBe('applied');
    expect(await db.select().from(sources).where(eq(sources.id, source.id))).toHaveLength(1);
  });
});

describe('MCP catalog and isolation', () => {
  test('all argument-free REST read adapters resolve and resources/prompts work', async () => {
    const { token } = await fixture('read');
    for (const name of ['get_capabilities', 'list_cards', 'list_tags', 'get_review_queue', 'get_semantic_graph', 'list_note_types', 'list_deck_options', 'list_filtered_decks', 'get_retention', 'list_library', 'list_notebooks']) {
      const result = await invoke(token, name);
      expect({ name, isError: result.isError ?? false }).toEqual({ name, isError: false });
    }
    const resource = await (await rpc(token, 'resources/read', { uri: 'neuronexus://connection' })).json<any>();
    expect(JSON.parse(resource.result.contents[0].text).scope).toBe('read');
    expect((await (await rpc(token, 'prompts/list')).json<any>()).result.prompts).toHaveLength(2);
    expect((await invoke(token, 'search_cards', { query: 'anything' })).isError).toBe(true);
  });

  test('private GET bridge preserves source/notebook/card isolation and UUID validation', async () => {
    const { db, sources, notebooks } = await import('@reomi/db');
    const { token } = await fixture();
    const { userId } = await signUpAndCookie(app, 'owner-mcp@example.com');
    const [source] = await db.insert(sources).values({ userId, title: 'Private source', kind: 'text', status: 'ready' }).returning();
    const [nb] = await db.insert(notebooks).values({ userId, title: 'Private notebook' }).returning();
    for (const [name, args] of [
      ['get_library_item', { id: source!.id }], ['read_source_chunks', { id: source!.id }],
      ['get_notebook', { id: nb!.id }], ['list_notebook_notes', { id: nb!.id }],
      ['save_note', { notebookId: nb!.id, title: 'Attack', content: 'x' }],
      ['attach_source', { notebookId: nb!.id, sourceId: source!.id }],
      ['get_notebook', { id: '../../profile/tokens' }],
    ] as const) expect((await invoke(token, name, args)).isError).toBe(true);
    expect(JSON.stringify(data(await invoke(token, 'list_library')))).not.toContain('Private source');
  });

  test('handles malformed JSON, unsupported method and request-size limits', async () => {
    const { token } = await fixture();
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream', 'content-type': 'application/json' };
    const malformed = await app.handle(new Request('http://localhost/mcp', { method: 'POST', headers, body: '{' }));
    expect(malformed.status).toBe(400);
    expect((await app.handle(new Request('http://localhost/mcp', { headers }))).status).toBe(405);
    const huge = await app.handle(new Request('http://localhost/mcp', { method: 'POST', headers, body: JSON.stringify({ text: 'x'.repeat(513 * 1024) }) }));
    expect(huge.status).toBe(413);
  });
});
