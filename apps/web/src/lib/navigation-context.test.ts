import { describe, expect, test } from 'bun:test';
import { NavigationJournal, NAVIGATION_LIMITS, NAVIGATION_RELOAD_KEY, readNavigationReloadMarker, navigationStorageKey, safeNavigationHref } from './navigation-context';
import { currentStorageKey } from './storage-migration';

function storage() {
  const values = new Map<string, string>();
  return { values, getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); }, removeItem: (k: string) => { values.delete(k); } };
}
function setup(href = '/library') {
  const disk = storage();
  const journal = new NavigationJournal('alice', href, null, disk);
  const visit = (href: string, intent: 'object' | 'section' = 'object', replace = false) => {
    const entry = journal.plan(href, intent, replace); journal.commit(entry); return entry;
  };
  return { disk, journal, visit };
}

describe('tab navigation context', () => {
  test('history keeps separate views of the same route; section restores the latest collection', () => {
    const { journal, visit } = setup('/cards?q=A');
    journal.field('cards', 'query', 'A'); journal.field('cards', 'focusedId', 'card-a');
    const a = journal.current;
    visit('/library/book');
    const b = visit('/cards?q=B'); journal.field('cards', 'query', 'B');
    expect(journal.traverse(a.id, a.href)).toBe(true);
    expect(journal.view('cards').fields.query).toBe('A');
    expect(journal.traverse(b.id, b.href)).toBe(true);
    expect(journal.view('cards').fields.query).toBe('B');
    visit('/library/book'); visit('/cards', 'section');
    expect(journal.current.href).toBe('/cards?q=B');
    expect(journal.view('cards').fields.query).toBe('B');
  });

  test('explicit object entry never inherits unrelated filters and returns to its exact origin', () => {
    const { journal, visit } = setup('/cards?q=deck:A');
    journal.field('cards', 'query', 'deck:A'); const original = journal.current;
    visit('/library/book'); const reader = journal.current;
    visit('/cards?focus=outside');
    expect(journal.view('cards').fields.query).toBeUndefined();
    expect(journal.parent()?.id).toBe(reader.id);
    journal.traverse(reader.id, reader.href);
    expect(journal.parent()?.id).toBe(original.id);
  });

  test('query replacement preserves entry identity and consumed object state on reload', () => {
    const { journal, visit, disk } = setup('/cards?focus=card-a');
    journal.field('cards', 'focusedId', 'card-a'); const id = journal.current.id;
    visit('/cards', 'object', true);
    expect(journal.current.id).toBe(id);
    journal.flush();
    const reload = new NavigationJournal('alice', '/cards', journal.marker(), disk);
    expect(reload.view('cards').fields.focusedId).toBe('card-a');
    expect(reload.current.id).toBe(id);
  });

  test('section reset cannot resurrect cleared settings', () => {
    const { journal, visit } = setup();
    journal.field('library', 'search', 'secret query');
    journal.resetView('library'); visit('/library/book'); visit('/library', 'section');
    expect(journal.view('library').fields).toEqual({});
  });

  test('reload restores a nested chain, but a fresh tab and different owner do not', () => {
    const { journal, visit, disk } = setup();
    visit('/notebooks/n'); const notebook = journal.current;
    visit('/notebooks/n?source=book'); journal.field('source:book', 'page', 42);
    const reader = journal.current;
    visit('/cards?focus=c'); journal.flush();
    const reload = new NavigationJournal('alice', journal.current.href, journal.marker(), disk);
    expect(reload.parent()?.id).toBe(reader.id);
    reload.traverse(reader.id, reader.href);
    expect(reload.view('source:book').fields.page).toBe(42);
    expect(reload.parent()?.id).toBe(notebook.id);
    const other = new NavigationJournal('bob', '/cards', journal.marker(), disk);
    expect(other.parent()).toBeNull();
    const independent = new NavigationJournal('alice', '/library', null, disk);
    expect(independent.parent()).toBeNull();
    expect(independent.view('library').fields).toEqual({});
  });

  test('old branches are not traversable after navigating from Back', () => {
    const { journal, visit } = setup(); const root = journal.current;
    const abandoned = visit('/cards');
    journal.traverse(root.id, root.href); visit('/decks');
    expect(journal.distanceTo(abandoned.id)).toBeNull();
    expect(journal.distanceTo(root.id)).toBe(-1);
  });

  test('only typed metadata is accepted; unsafe URLs never become origins', () => {
    const { journal } = setup();
    journal.field('library', 'search', 'ok');
    journal.field('library', 'body', 'private content');
    journal.field('library', 'search', 'x'.repeat(20_000));
    journal.field('library', 'page', NaN);
    expect(journal.view('library').fields).toEqual({ search: 'ok' });
    for (const href of ['https://evil.test', '//evil.test', '/\\evil.test', 'javascript:alert(1)', '/api/token']) expect(safeNavigationHref(href)).toBeNull();
    expect(safeNavigationHref('/library/book?page=8')).toBe('/library/book?page=8');
  });

  test('storage errors preserve memory; account clearing invalidates late writes', () => {
    const broken = { getItem() { throw Error(); }, setItem() { throw Error(); }, removeItem() { throw Error(); } };
    const journal = new NavigationJournal('alice', '/library', null, broken);
    const entryId = journal.current.id;
    journal.field('library', 'search', 'value', entryId); journal.flush();
    expect(journal.degraded).toBe(true);
    expect(journal.view('library').fields.search).toBe('value');
    journal.clear(); journal.field('library', 'search', 'late', entryId);
    expect(journal.view('library').fields.search).toBeUndefined();
  });

  test('corrupt/foreign/incompatible snapshots are discarded without touching other storage', () => {
    const disk = storage(); disk.setItem('draft', 'keep');
    disk.setItem(navigationStorageKey('alice'), '{broken');
    const journal = new NavigationJournal('alice', '/library', { owner: 'alice', id: 'bad', position: 0 }, disk);
    expect(journal.parent()).toBeNull(); expect(disk.getItem('draft')).toBe('keep');
    journal.clear(); expect(disk.getItem('draft')).toBe('keep');
  });

  test('bounded history preserves current entry and keeps serialized storage bounded', () => {
    const { journal, visit, disk } = setup();
    for (let i = 0; i < 100; i++) { visit(`/library/b${i}`); journal.field(`source:b${i}`, 'page', i + 1); }
    journal.flush();
    const raw = disk.getItem(currentStorageKey(navigationStorageKey('alice')))!;
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(NAVIGATION_LIMITS.bytes);
    expect(JSON.parse(raw).entries.length).toBeLessThanOrEqual(NAVIGATION_LIMITS.entries);
    expect(journal.view('source:b99').fields.page).toBe(100);
  });

  test('oversized view writes are rejected without truncating the old value or evicting drafts', () => {
    const { journal, disk } = setup('/decks'); disk.setItem('draft', 'keep');
    journal.field('decks', 'collapsed', ['one']);
    journal.field('decks', 'collapsed', Array.from({length: 2000}, (_, i) => `${i}-${'x'.repeat(190)}`));
    journal.flush();
    expect(journal.view('decks').fields.collapsed).toEqual(['one']);
    expect(journal.degraded).toBe(true); expect(disk.getItem('draft')).toBe('keep');
    expect(new TextEncoder().encode(disk.getItem(currentStorageKey(navigationStorageKey('alice')))!).byteLength).toBeLessThan(NAVIGATION_LIMITS.bytes);
  });

  test('cyclic origins terminate safely and suspended owners reject delayed updates', () => {
    const { journal, visit } = setup(); const original = journal.current;
    visit('/cards'); original.parent = journal.current.id;
    expect(journal.parent()).toBeNull();
    const generation = journal.generation;
    journal.suspend(); journal.field('cards', 'query', 'late');
    expect(journal.generation).toBeGreaterThan(generation);
    expect(journal.view('cards').fields.query).toBeUndefined();
    journal.activate(); journal.field('cards', 'query', 'new');
    expect(journal.view('cards').fields.query).toBe('new');
  });
  test('a nested notebook reader carries its notebook view without copying unrelated views', () => {
    const {journal,visit}=setup('/notebooks/n');
    journal.field('notebook:n','dockTab','notes');
    journal.scroll('notebook:n','sources',{id:'s',offset:12,x:0,y:80});
    visit('/notebooks/n?source=s');
    expect(journal.view('notebook:n').fields.dockTab).toBe('notes');
    expect(journal.view('notebook:n').scrolls.sources?.y).toBe(80);
    visit('/notebooks/other');
    expect(journal.view('notebook:n').fields).toEqual({});
  });
});

test('equivalent URL encoding preserves the same history entry and reload snapshot',()=>{
  const disk=storage();const journal=new NavigationJournal('alice','/cards?q=deck%3A%22My%20Deck%22',null,disk);
  journal.field('cards','focusedId','card');journal.flush();const marker=journal.marker();
  expect(journal.traverse(marker.id,'/cards?q=deck%3A%22My+Deck%22')).toBe(true);
  expect(new NavigationJournal('alice','/cards?q=deck%3A%22My+Deck%22',marker,disk).view('cards').fields.focusedId).toBe('card');
});

test('scroll metadata obeys the same per-entry budget as fields',()=>{
  const {journal}=setup();
  journal.field('library','search','retained');
  for(let i=0;i<12;i++)journal.scroll('library',`position-${String.fromCharCode(97+i)}`,{x:0,y:i,queryKey:'q'.repeat(8192)});
  expect(new TextEncoder().encode(JSON.stringify(journal.current)).byteLength).toBeLessThanOrEqual(NAVIGATION_LIMITS.entryBytes);
  expect(journal.view('library').fields.search).toBe('retained');expect(journal.degraded).toBe(true);
});
test('an origin chain beyond the supported depth degrades without following it',()=>{
  const {journal,visit}=setup();
  for(let i=0;i<18;i++)visit(`/cards?q=${i}`);
  expect(journal.parent()).toBeNull();
});

test('reload racing a consumed query preserves its marked origin but rejects another query',()=>{
  const {journal,disk,visit}=setup('/library/book');
  const parent=journal.current.id;visit('/cards?focus=card-a');journal.field('cards','focusedId','card-a');
  visit('/cards','object',true);journal.flush();const marker=journal.marker();
  const reloaded=new NavigationJournal('alice','/cards?focus=card-a',marker,disk);
  expect(reloaded.current.id).toBe(marker.id);expect(reloaded.parent()?.id).toBe(parent);
  expect(reloaded.view('cards').fields.focusedId).toBe('card-a');
  const other=new NavigationJournal('alice','/cards?focus=card-b',marker,disk);
  expect(other.current.id).not.toBe(marker.id);expect(other.parent()).toBeNull();
});


test('a pagehide marker recovers only a real same-owner reload, not copied new-tab storage',()=>{
 const {journal,disk}=setup();disk.setItem(NAVIGATION_RELOAD_KEY,JSON.stringify(journal.marker()));
 expect(readNavigationReloadMarker('alice','reload',disk)).toEqual(journal.marker());
 expect(readNavigationReloadMarker('alice','navigate',disk)).toBeNull();
 expect(readNavigationReloadMarker('alice','back_forward',disk)).toBeNull();
 expect(readNavigationReloadMarker('bob','reload',disk)).toBeNull();
});
