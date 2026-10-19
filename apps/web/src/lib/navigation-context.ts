import { DOCK_TABS } from './plan-dock';
import { readBrowserValue, removeBrowserValue, writeBrowserValue } from './storage-migration';
/** Tab-local navigation metadata. Domain records and mutable work have other owners. */
export const NAVIGATION_LIMITS = { entries: 64, entryBytes: 64 * 1024, bytes: 512 * 1024, depth: 16, pages: 20, rows: 10_000, restoreMs: 5000 } as const;
export const NAVIGATION_HISTORY_KEY = 'nnNavigation';
export const NAVIGATION_AUTH_RETURN_KEY = 'nn:navigation:auth-return:v1';
export const NAVIGATION_RELOAD_KEY = 'nn:navigation:reload:v1';
export const navigationStorageKey = (owner: string) => `nn:navigation:v1:${owner}`;
export type NavigationField = string | number | boolean | string[] | null;
export type ScrollAnchor = { id?: string; endId?: string; nearby?: string[]; offset?: number; fraction?: number; queryKey?: string; x: number; y: number };
export type NavigationView = { fields: Record<string, NavigationField>; scrolls: Record<string, ScrollAnchor>; focus?: string };
export type NavigationEntry = { id: string; href: string; previousHref?: string; position: number; parent?: string; views: Record<string, NavigationView> };
export type NavigationMarker = { owner: string; id: string; position: number };
export type NavigationIntent = 'object' | 'section';
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type FieldRule = 'text' | 'id' | 'bool' | 'number' | 'ids' | readonly string[];

const rules: Record<string, Record<string, FieldRule>> = {
  card: { mode: ['view','edit'] },
  library: { folderId: 'id', search: 'text', kind: ['all', 'pdf', 'epub', 'web', 'text', 'url'], reading: ['all', 'unread', 'reading', 'finished'], tag: 'id', unattached: 'bool', sort: ['added', 'title', 'lastRead', 'progress'], searchMode: ['title', 'content'], detailId: 'id' },
  cards: { query: 'text', sortField: ['created', 'updated', 'due', 'lapses', 'reps', 'front'], sortDir: ['asc', 'desc'], focusedId: 'id', filtersVisible: 'bool' },
  decks: { deckSearch: 'text', selectedId: 'id', collapsed: 'ids', filterCollapsed: 'ids' },
  notebooks: { search: 'text', archived: 'bool' },
  notebook: { tab: ['chat', 'sources', 'dock'], dockTab: DOCK_TABS, dockCollapsed:'bool', dockSheetOpen:'bool', noteId: 'id', artifactId: 'id', conversationId: 'id' },
  source: { mode: ['pdf', 'text'], page: 'number', fraction: 'number', chunkId: 'id', chunkPos: 'number', tocOpen: 'bool', marksOpen: 'bool', cardsDrawerOpen:'bool', notesOpen: 'bool', studioOpen: 'bool', studyTab: ['notes', 'annotations', 'artifacts'], noteId: 'id', artifactId: 'id' },
  review: { sessionId: 'id', infoOpen: 'bool' },
};
const idValue = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\u0000-\u001f]/.test(v);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= 100_000_000;
const emptyView = (): NavigationView => ({ fields: {}, scrolls: {} });
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function validField(rule: FieldRule | undefined, value: unknown): value is NavigationField {
  if (!rule) return false;
  if (value === null) return rule === 'id';
  if (Array.isArray(rule)) return typeof value === 'string' && rule.includes(value);
  if (rule === 'text') return typeof value === 'string' && value.length <= 4000 && !value.includes('\0');
  if (rule === 'id') return idValue(value);
  if (rule === 'bool') return typeof value === 'boolean';
  if (rule === 'number') return finite(value) && value >= 0;
  return rule === 'ids' && Array.isArray(value) && value.length <= 2000 && value.every(idValue);
}
function scopeRules(scope: string) {
  const [kind, id, extra] = scope.split(':');
  if (['source', 'notebook', 'card'].includes(kind!)) return idValue(id) && !extra ? rules[kind!] : undefined;
  return !id ? rules[scope] : undefined;
}
export function safeNavigationHref(href: unknown): string | null {
  if (typeof href !== 'string' || href.length > 8192 || !href.startsWith('/') || href.startsWith('//') || /[\\\u0000-\u001f]/.test(href)) return null;
  try {
    const url = new URL(href, 'https://navigation.invalid');
    if (!/^\/(?:$|(?:library|cards|decks|notebooks|editor|review|chat|graph|stats|settings|garden|note-types|empty|session)(?:\/[^?#]*)?$)/.test(url.pathname)) return null;
    const query=url.searchParams.toString();
    return `${url.pathname}${query?`?${query}`:''}${url.hash}`;
  } catch { return null; }
}
export function readNavigationMarker(value: unknown): NavigationMarker | null {
  if (!record(value) || !idValue(value.owner) || !idValue(value.id) || !Number.isSafeInteger(value.position) || (value.position as number) < 0) return null;
  return { owner: value.owner, id: value.id, position: value.position as number };
}
/** Some engines lose custom history state when reload interrupts a router
 * replacement. A pagehide marker is admissible only for a real reload, never a
 * new tab (whose sessionStorage may have been copied from its opener). */
export function readNavigationReloadMarker(owner:string,navigationType:string|undefined,storage?:StoragePort):NavigationMarker|null {
  if(navigationType!=='reload'||!storage)return null;
  try { const raw=readBrowserValue(storage,NAVIGATION_RELOAD_KEY);if(!raw||raw.length>1000)return null;
    const marker=readNavigationMarker(JSON.parse(raw));return marker?.owner===owner?marker:null;
  } catch{return null;}
}
function readAnchor(raw: unknown): ScrollAnchor | null {
  if (!record(raw) || !finite(raw.x) || !finite(raw.y) || raw.x < 0 || raw.y < 0) return null;
  return { x: raw.x, y: raw.y, ...(idValue(raw.id) ? { id: raw.id } : {}),
    ...(idValue(raw.endId)?{endId:raw.endId}:{}),
    ...(typeof raw.queryKey==='string'&&raw.queryKey.length<=8192?{queryKey:raw.queryKey}:{}),
    ...(Array.isArray(raw.nearby) && raw.nearby.length <= 2 && raw.nearby.every(idValue) ? { nearby: raw.nearby as string[] } : {}),
    ...(finite(raw.offset) ? { offset: raw.offset } : {}), ...(finite(raw.fraction) && raw.fraction >= 0 && raw.fraction <= 1 ? { fraction: raw.fraction } : {}) };
}
function readView(scope: string, raw: unknown): NavigationView | null {
  const allowed = scopeRules(scope);
  if (!allowed || !record(raw) || !record(raw.fields) || !record(raw.scrolls)) return null;
  const view = emptyView();
  for (const [key, value] of Object.entries(raw.fields)) if (validField(allowed[key], value)) view.fields[key] = value;
  for (const [key, value] of Object.entries(raw.scrolls).slice(0, 12)) {
    const anchor = readAnchor(value); if (/^[a-z][a-z0-9-]{0,39}$/.test(key) && anchor) view.scrolls[key] = anchor;
  }
  if (idValue(raw.focus)) view.focus = raw.focus;
  return view;
}
function readEntry(raw: unknown): NavigationEntry | null {
  if (!record(raw) || !idValue(raw.id) || !Number.isSafeInteger(raw.position) || (raw.position as number) < 0 || !safeNavigationHref(raw.href) || !record(raw.views)) return null;
  if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > NAVIGATION_LIMITS.entryBytes) return null;
  const views: Record<string, NavigationView> = {};
  for (const [scope, value] of Object.entries(raw.views).slice(0, 8)) { const view = readView(scope, value); if (view) views[scope] = view; }
  const href = safeNavigationHref(raw.href)!;
  const previousHref = safeNavigationHref(raw.previousHref);
  return { id: raw.id, href, ...(previousHref && previousHref.split(/[?#]/)[0] === href.split(/[?#]/)[0] ? { previousHref } : {}), position: raw.position as number, ...(idValue(raw.parent) ? { parent: raw.parent } : {}), views };
}
/** Only call after authentication; no prior owner's query/title is read for a different account. */
export function navigationResumeHref(owner:string,marker:NavigationMarker|null,storage?:StoragePort):string|null {
  if(!storage||marker?.owner!==owner)return null;
  try {
    const raw=readBrowserValue(storage,navigationStorageKey(owner));if(!raw||new TextEncoder().encode(raw).byteLength>NAVIGATION_LIMITS.bytes)return null;
    const data:unknown=JSON.parse(raw);
    if(!record(data)||data.version!==1||data.owner!==owner||!Array.isArray(data.entries)||data.entries.length>NAVIGATION_LIMITS.entries)return null;
    const entry=data.entries.map(readEntry).find(entry=>entry?.id===marker.id&&entry.position===marker.position);
    return entry?.href??null;
  }catch{return null;}
}
const sectionOf = (href: string) => {
  const path = href.split(/[?#]/)[0]!;
  return ['/library', '/cards', '/decks', '/notebooks'].includes(path) ? path : null;
};
function viewsFromHref(href: string): Record<string, NavigationView> {
  const url = new URL(href, 'https://navigation.invalid');
  const scope = url.pathname.slice(1);
  const fields: Record<string, NavigationField> = {};
  const mapping: Record<string, Record<string, string>> = {
    library: { folderId:'folderId', q:'search', kind:'kind', reading:'reading', tag:'tag', sort:'sort', searchMode:'searchMode', focus:'detailId', unattached:'unattached' },
    cards: { q:'query', focus:'focusedId' }, decks: { q:'deckSearch', focus:'selectedId' }, notebooks: { q:'search', archived:'archived' },
  };
  for (const [param, key] of Object.entries(mapping[scope] ?? {})) {
    const raw=url.searchParams.get(param); if(raw===null)continue;
    const rule=scopeRules(scope)?.[key];
    const value=rule==='bool' ? raw==='1'||raw==='true' : raw;
    if(validField(rule,value))fields[key]=value;
  }
  return Object.keys(fields).length ? {[scope]:{fields,scrolls:{}}} : {};
}

export class NavigationJournal {
  private entries = new Map<string, NavigationEntry>();
  private sections = new Map<string, NavigationEntry>();
  private branch: string[] = [];
  private alive = true;
  private sequence = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  current: NavigationEntry;
  private persistenceDegraded = false;
  onDegraded?: () => void;
  get degraded() { return this.persistenceDegraded; }
  set degraded(value: boolean) { const changed = this.persistenceDegraded !== value; this.persistenceDegraded = value; if (value && changed) this.onDegraded?.(); }
  generation = 0;

  constructor(readonly owner: string, href: string, marker: NavigationMarker | null, private storage?: StoragePort) {
    const safe = safeNavigationHref(href) ?? '/';
    this.degraded = !storage;
    let restored: NavigationEntry | undefined;
    if (marker?.owner === owner && storage) {
      try {
        const raw = readBrowserValue(storage, navigationStorageKey(owner));
        if (raw && new TextEncoder().encode(raw).byteLength <= NAVIGATION_LIMITS.bytes) {
          const data: unknown = JSON.parse(raw);
          if (record(data) && data.version === 1 && data.owner === owner && Array.isArray(data.entries) && data.entries.length <= NAVIGATION_LIMITS.entries) {
            for (const item of data.entries) { const entry = readEntry(item); if (entry) this.entries.set(entry.id, entry); }
            restored = this.entries.get(marker.id);
            if (!restored || (restored.href !== safe && restored.previousHref !== safe) || restored.position !== marker.position) restored = undefined;
            // Reload may capture the old URL while an in-flight query cleanup
            // commits before pagehide. Both URLs belong to the same marked
            // entry; retain its origin instead of turning it into a fresh tab.
            if (restored && restored.href !== safe) restored = { ...restored, previousHref: restored.href, href: safe };
            if (restored) {
              if (record(data.sections)) for (const [key, value] of Object.entries(data.sections)) {
                const entry = readEntry(value); if (entry && sectionOf(entry.href) === key) this.sections.set(key, entry);
              }
              if (Array.isArray(data.branch) && data.branch.length <= NAVIGATION_LIMITS.entries && data.branch.every(idValue)) this.branch = data.branch as string[];
            }
          }
        }
      } catch { this.degraded = true; }
    }
    if (!restored) { this.entries.clear(); this.sections.clear(); this.branch = []; }
    this.current = restored ?? { id: this.newId(), href: safe, position: 0, views: viewsFromHref(safe) };
    this.entries.set(this.current.id, this.current);
    if (!this.branch.includes(this.current.id)) this.branch = [this.current.id];
  }

  private newId() { return `nav-${Date.now().toString(36)}-${(++this.sequence).toString(36)}-${Math.random().toString(36).slice(2, 10)}`; }
  marker(): NavigationMarker { return { owner: this.owner, id: this.current.id, position: this.current.position }; }
  view(scope: string): NavigationView { return this.current.views[scope] ?? emptyView(); }
  entry(id: string) { return this.entries.get(id); }

  field(scope: string, key: string, value: unknown, entryId = this.current.id) {
    if (!this.alive || entryId !== this.current.id || !validField(scopeRules(scope)?.[key], value)) return;
    if (!this.current.views[scope] && Object.keys(this.current.views).length >= 8) return;
    const view = this.current.views[scope] ??= emptyView();
    const previous = view.fields[key];
    view.fields[key] = copy(value);
    if (new TextEncoder().encode(JSON.stringify(this.current)).byteLength > NAVIGATION_LIMITS.entryBytes) {
      if (previous === undefined) delete view.fields[key]; else view.fields[key] = previous;
      this.degraded = true; return;
    }
    this.remember();
  }
  scroll(scope: string, key: string, anchor: ScrollAnchor, entryId = this.current.id) {
    if (!this.alive || entryId !== this.current.id || !scopeRules(scope) || !/^[a-z][a-z0-9-]{0,39}$/.test(key)) return;
    const parsed = readAnchor(anchor); if (!parsed) return;
    if (!this.current.views[scope] && Object.keys(this.current.views).length >= 8) return;
    const view = this.current.views[scope] ??= emptyView();
    if (!view.scrolls[key] && Object.keys(view.scrolls).length >= 12) return;
    const previous = view.scrolls[key];
    view.scrolls[key] = parsed;
    if (new TextEncoder().encode(JSON.stringify(this.current)).byteLength > NAVIGATION_LIMITS.entryBytes) {
      if (previous === undefined) delete view.scrolls[key]; else view.scrolls[key] = previous;
      this.degraded = true; return;
    }
    this.remember();
  }
  focus(scope: string, id: string, entryId = this.current.id) {
    if (!this.alive || entryId !== this.current.id || !scopeRules(scope) || !idValue(id)) return;
    if (!this.current.views[scope] && Object.keys(this.current.views).length >= 8) return;
    const view = this.current.views[scope] ??= emptyView();
    const previous = view.focus;
    view.focus = id;
    if (new TextEncoder().encode(JSON.stringify(this.current)).byteLength > NAVIGATION_LIMITS.entryBytes) {
      if (previous === undefined) delete view.focus; else view.focus = previous;
      this.degraded = true; return;
    }
    this.remember();
  }
  resetView(scope: string) { if (this.alive) { delete this.current.views[scope]; this.remember(); } }
  private remember() {
    const section = sectionOf(this.current.href);
    if (section) this.sections.set(section, copy(this.current));
    if (this.timer === undefined) this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, 120);
  }
  /** Planning does not consume the current entry; the router must actually commit. */
  plan(href: string, intent: NavigationIntent = 'object', replace = false): NavigationEntry {
    const safe = safeNavigationHref(href);
    if (!safe) throw new Error('Invalid navigation destination');
    const section = intent === 'section' ? this.sections.get(safe) : undefined;
    const samePath = safe.split(/[?#]/)[0] === this.current.href.split(/[?#]/)[0];
    if (replace && samePath) return { ...copy(this.current), href: safe,
      ...(safe !== this.current.href ? { previousHref: this.current.href } : {}) };
    const notebookId = samePath ? /^\/notebooks\/([^/?#]+)(?:[?#]|$)/.exec(safe)?.[1] : undefined;
    const notebookScope = notebookId ? `notebook:${notebookId}` : undefined;
    const views = viewsFromHref(safe);
    if (notebookScope && this.current.views[notebookScope]) views[notebookScope] = copy(this.current.views[notebookScope]);
    return { id: this.newId(), href: section?.href ?? safe, position: replace ? this.current.position : this.current.position + 1,
      ...(!replace && intent === 'object' ? { parent: this.current.id } : {}), views: section ? copy(section.views) : views };
  }
  commit(entry: NavigationEntry) {
    if (!this.alive) return;
    this.remember();
    if (entry.id === this.current.id) entry.views = this.current.views;
    if (entry.id !== this.current.id) {
      const index = this.branch.indexOf(this.current.id);
      this.branch = this.branch.slice(0, Math.max(0, index + (entry.position > this.current.position ? 1 : 0)));
      this.branch.push(entry.id);
    }
    this.current = entry; this.entries.set(entry.id, entry); this.remember(); this.flush();
  }
  traverse(id: string, href: string) {
    const entry = this.entries.get(id);
    if (!this.alive || !entry || entry.href !== safeNavigationHref(href)) return false;
    this.remember(); this.current = entry; this.remember(); this.flush(); return true;
  }
  distanceTo(id: string): number | null {
    const from = this.branch.indexOf(this.current.id); const to = this.branch.indexOf(id);
    const entry = this.entries.get(id);
    return from >= 0 && to >= 0 && entry ? entry.position - this.current.position : null;
  }
  parent(): NavigationEntry | null {
    const seen = new Set([this.current.id]);
    let id = this.current.parent;
    let parent: NavigationEntry | null = null;
    for (let depth = 0; id && depth < NAVIGATION_LIMITS.depth; depth++) {
      if (seen.has(id)) return null; seen.add(id);
      const entry = this.entries.get(id);
      if (!entry) { id = undefined; break; }
      if (!parent && safeNavigationHref(entry.href)) parent = entry;
      id = entry.parent;
    }
    return id ? null : parent;
  }
  flush() {
    if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined;
    if (!this.alive) return;
    const pinned = new Set([this.current.id]);
    let ancestor = this.current.parent;
    for (let i = 0; ancestor && i < NAVIGATION_LIMITS.depth && !pinned.has(ancestor); i++) { pinned.add(ancestor); ancestor = this.entries.get(ancestor)?.parent; }
    const encode = () => JSON.stringify({ version: 1, owner: this.owner, entries: [...this.entries.values()], sections: Object.fromEntries(this.sections), branch: this.branch });
    let raw = encode();
    while (this.entries.size > NAVIGATION_LIMITS.entries || new TextEncoder().encode(raw).byteLength > NAVIGATION_LIMITS.bytes) {
      const victim = [...this.entries.keys()].find(id => !pinned.has(id)) ?? [...this.entries.keys()].find(id => id !== this.current.id);
      if (!victim) { this.degraded = true; return; }
      this.entries.delete(victim); this.branch = this.branch.filter(id => id !== victim); raw = encode();
    }
    try { if (this.storage) writeBrowserValue(this.storage, navigationStorageKey(this.owner), raw); } catch { this.degraded = true; }
  }
  clear() {
    if (this.timer !== undefined) clearTimeout(this.timer); this.timer = undefined;
    this.alive = false; this.generation++; this.entries.clear(); this.sections.clear(); this.branch = [];
    this.current = { id: this.newId(), href: '/', position: 0, views: {} };
    try { if (this.storage) removeBrowserValue(this.storage, navigationStorageKey(this.owner)); } catch { /* Memory boundary still applies. */ }
  }
  suspend() { if (this.alive) { this.flush(); this.alive = false; this.generation++; } }
  activate() { this.alive = true; }
  dispose() { this.flush(); }
}
