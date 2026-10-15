import { beforeEach, describe, expect, test } from 'bun:test';
import { buildApp } from '../src/app.ts';
import { callApp, resetTestDb, seedBasicCard, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

describe('decks', () => {
  beforeEach(async () => {
    await resetTestDb();
  });

  test('CRUD roundtrip', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());

    // Create
    const created = await callApp(app, 'POST', '/decks', {
      cookie,
      body: { name: 'Languages', color: 'amber' },
    });
    expect(created.status).toBe(200);
    const d = await created.json<{ id: string; name: string; color: string }>();
    expect(d.name).toBe('Languages');
    expect(d.color).toBe('amber');

    // List
    const list = await callApp(app, 'GET', '/decks', { cookie });
    const all = await list.json<{ id: string }[]>();
    expect(all.map((x) => x.id)).toContain(d.id);

    // Update
    const patched = await callApp(app, 'PATCH', `/decks/${d.id}`, {
      cookie,
      body: { name: 'Langs', color: 'sky' },
    });
    const pd = await patched.json<{ name: string; color: string }>();
    expect(pd.name).toBe('Langs');
    expect(pd.color).toBe('sky');

    // Delete
    const del = await callApp(app, 'DELETE', `/decks/${d.id}`, { cookie });
    expect(del.status).toBe(200);
    const after = await callApp(app, 'GET', '/decks', { cookie });
    const left = await after.json<{ id: string }[]>();
    expect(left.find((x) => x.id === d.id)).toBeUndefined();
  });

  test('parent delete cascades to children and their cards', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const parent = await (
      await callApp(app, 'POST', '/decks', { cookie, body: { name: 'Langs' } })
    ).json<{ id: string }>();
    const child = await (
      await callApp(app, 'POST', '/decks', {
        cookie,
        body: { name: 'German', parentId: parent.id },
      })
    ).json<{ id: string }>();
    // Card content is derived from a note now: seed a Basic note in the child
    // deck. Deleting the root cascades decks → notes' cards (FK ON DELETE CASCADE).
    const card = await seedBasicCard(app, cookie, {
      deckId: child.id,
      front: 'Hund',
      back: 'dog',
    });

    // Sanity
    expect(parent.id).toBeTruthy();
    expect(child.id).toBeTruthy();
    expect(card.id).toBeTruthy();

    // Delete the root → everything goes.
    const del = await callApp(app, 'DELETE', `/decks/${parent.id}`, { cookie });
    expect(del.status).toBe(200);

    const decks = await (await callApp(app, 'GET', '/decks', { cookie })).json<unknown[]>();
    const cards = await (await callApp(app, 'GET', '/cards', { cookie })).json<{ items: unknown[] }>();
    expect(decks).toEqual([]);
    expect(cards.items).toEqual([]);
  });

  test('cannot set parentId to self (cycle guard)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const d = await (
      await callApp(app, 'POST', '/decks', { cookie, body: { name: 'D' } })
    ).json<{ id: string }>();
    const res = await callApp(app, 'PATCH', `/decks/${d.id}`, {
      cookie,
      body: { parentId: d.id },
    });
    expect(res.status).toBe(400);
  });

  test('cannot set parentId to a descendant (cycle guard)', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const a = await (
      await callApp(app, 'POST', '/decks', { cookie, body: { name: 'A' } })
    ).json<{ id: string }>();
    const b = await (
      await callApp(app, 'POST', '/decks', {
        cookie,
        body: { name: 'B', parentId: a.id },
      })
    ).json<{ id: string }>();
    const res = await callApp(app, 'PATCH', `/decks/${a.id}`, {
      cookie,
      body: { parentId: b.id },
    });
    expect(res.status).toBe(400);
  });

  test('users cannot see each others decks', async () => {
    const { cookie: aliceCookie } = await signUpAndCookie(app, uniqueEmail('alice'));
    const { cookie: bobCookie } = await signUpAndCookie(app, uniqueEmail('bob'));
    await callApp(app, 'POST', '/decks', {
      cookie: aliceCookie,
      body: { name: 'Alice private' },
    });
    const bobList = await (await callApp(app, 'GET', '/decks', { cookie: bobCookie })).json<
      unknown[]
    >();
    expect(bobList).toEqual([]);
  });

  test('moving a deck cannot attach it to another user\'s parent', async () => {
    const a = await signUpAndCookie(app, uniqueEmail());
    const b = await signUpAndCookie(app, uniqueEmail());
    const own = await (await callApp(app, 'POST', '/decks', { cookie: a.cookie, body: { name: 'Own' } })).json<{ id: string }>();
    const foreign = await (await callApp(app, 'POST', '/decks', { cookie: b.cookie, body: { name: 'Foreign' } })).json<{ id: string }>();
    const result = await callApp(app, 'PATCH', `/decks/${own.id}`, { cookie: a.cookie, body: { parentId: foreign.id } });
    expect(result.status).toBe(400);
    expect(await result.json()).toMatchObject({ error: 'parent_not_found' });
    const list = await (await callApp(app, 'GET', '/decks', { cookie: a.cookie })).json<any[]>();
    expect(list[0].parentId).toBeNull();
  });

  test('simultaneous opposite moves cannot form a deck cycle', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const a = await (await callApp(app, 'POST', '/decks', { cookie, body: { name: 'A' } })).json<{ id: string }>();
    const b = await (await callApp(app, 'POST', '/decks', { cookie, body: { name: 'B' } })).json<{ id: string }>();
    const results = await Promise.all([
      callApp(app, 'PATCH', `/decks/${a.id}`, { cookie, body: { parentId: b.id } }),
      callApp(app, 'PATCH', `/decks/${b.id}`, { cookie, body: { parentId: a.id } }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  });
});

describe('ordered deck moves', () => {
  beforeEach(resetTestDb);
  test('appearance and subtree order survive moving inside, before, after and back to root', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const create = async (name: string) => (await callApp(app, 'POST', '/decks', { cookie, body: { name, icon: 'book', color: 'sky' } })).json<any>();
    const a = await create('A'), b = await create('B'), c = await create('C');
    const move = async (id: string, targetId: string | null, placement: string) => callApp(app, 'POST', `/decks/${id}/move`, { cookie, body: { targetId, placement } });
    expect((await move(c.id, a.id, 'before')).status).toBe(200);
    let rows = await (await callApp(app, 'GET', '/decks', { cookie })).json<any[]>();
    expect(rows.sort((a,b) => a.position-b.position).map(d => d.name)).toEqual(['C','A','B']);
    expect((await move(a.id, c.id, 'inside')).status).toBe(200);
    expect((await move(c.id, b.id, 'after')).status).toBe(200);
    rows = await (await callApp(app, 'GET', '/decks', { cookie })).json<any[]>();
    expect(rows.find(d => d.id === a.id)).toMatchObject({ parentId: c.id, icon: 'book', color: 'sky' });
    expect(rows.filter(d => !d.parentId).sort((a,b) => a.position-b.position).map(d => d.name)).toEqual(['B','C']);
    expect((await move(a.id, null, 'inside')).status).toBe(200);
    rows = await (await callApp(app, 'GET', '/decks', { cookie })).json<any[]>();
    expect(rows.filter(d => !d.parentId).sort((a,b) => a.position-b.position).map(d => d.name)).toEqual(['B','C','A']);
  });
  test('rejects foreign, stale and cyclic targets without partial writes; opposite moves serialize', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const { cookie: other } = await signUpAndCookie(app, uniqueEmail());
    const create = async (cookie: string, name: string) => (await callApp(app, 'POST', '/decks', { cookie, body: { name } })).json<any>();
    const a = await create(cookie,'A'), b = await create(cookie,'B'), foreign = await create(other,'Private');
    const move = (id: string,targetId: string | null,placement = 'inside') => callApp(app,'POST',`/decks/${id}/move`,{cookie,body:{targetId,placement}});
    const before = await (await callApp(app,'GET','/decks',{cookie})).json();
    expect((await move(a.id,a.id)).status).toBe(400);
    expect((await move(a.id,foreign.id)).status).toBe(404);
    expect((await move(foreign.id,a.id)).status).toBe(404);
    expect((await move(a.id,crypto.randomUUID())).status).toBe(404);
    expect((await move(a.id,null,'before')).status).toBe(400);
    expect(await (await callApp(app,'GET','/decks',{cookie})).json()).toEqual(before);
    const results = await Promise.all([move(a.id,b.id),move(b.id,a.id)]);
    expect(results.map(r=>r.status).sort()).toEqual([200,400]);
    const rows = await (await callApp(app,'GET','/decks',{cookie})).json<any[]>();
    const parent = rows.find(d=>!d.parentId), child = rows.find(d=>d.parentId);
    expect((await move(parent.id,child.id)).status).toBe(400);
  });
});

test('all thirty deck colors persist through authenticated create and edit', async () => {
  const { DECK_COLORS }=await import('@reomi/shared');
  const { cookie }=await signUpAndCookie(app,uniqueEmail());
  const created=await callApp(app,'POST','/decks',{cookie,body:{name:'Color palette',color:'coral',icon:'flask'}});
  expect(created.status).toBe(200);
  const d=await created.json<any>();
  expect(DECK_COLORS).toHaveLength(30);
  for(const color of DECK_COLORS) {
    const response=await callApp(app,'PATCH',`/decks/${d.id}`,{cookie,body:{color}});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({color,icon:'flask'});
  }
  expect((await callApp(app,'PATCH',`/decks/${d.id}`,{cookie,body:{color:'not-a-color'}})).status).toBe(400);
});
