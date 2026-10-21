import browser from 'webextension-polyfill';
import { API, WEB } from './config';
import { messages } from './messages';
import type { CaptureResult, Captured, Connection, LocalState, Mode, Pending, Receipt } from './types';

const locale = navigator.language.startsWith('ru') ? 'ru' : 'en', copy = messages[locale];
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const text = (key: string) => copy[key as keyof typeof copy] ?? copy.failed;
document.documentElement.lang = locale;
document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(node => { node.textContent = text(node.dataset.i18n!); });
document.querySelectorAll<HTMLElement>('[data-label]').forEach(node => node.setAttribute('aria-label', text(node.dataset.label!)));
el<HTMLAnchorElement>('web-settings').href = `${WEB}/settings`;

let token = '', connection: Connection | null = null, captured: Captured | null = null, mode: Mode = 'page';
let pending: Pending | null = null, receipt: Receipt | null = null, busy = false;
const tokenInput = el<HTMLInputElement>('token'), titleInput = el<HTMLInputElement>('title'), folderInput = el<HTMLSelectElement>('folder');
class ApiFailure extends Error { constructor(readonly status: number, code: string) { super(code); } }
function show(section: 'setup' | 'capture' | 'saved' | 'loading') {
  for (const id of ['setup', 'capture', 'saved', 'loading']) el(id).hidden = id !== section;
}
function error(code = '') { el('error').hidden = !code; el('error').textContent = code ? text(code) : ''; }
function lock(value: boolean) {
  busy = value;
  for (const id of ['retry', 'settings', 'another', 'disconnect', 'connect']) el<HTMLButtonElement>(id).disabled = value;
  for (const id of ['save', 'save-card']) el<HTMLButtonElement>(id).disabled = value || !captured;
  titleInput.disabled = value || Boolean(pending); folderInput.disabled = value || Boolean(pending);
  el<HTMLButtonElement>('page-mode').disabled = value || Boolean(pending) || !captured?.text;
  el<HTMLButtonElement>('selection-mode').disabled = value || Boolean(pending) || !captured?.selection;
}
async function request<T>(path: string, body?: unknown, credential = token): Promise<T> {
  let response: Response;
  try { response = await fetch(`${API}/extension/${path}`, { method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${credential}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(20000) }); }
  catch { throw new ApiFailure(0, 'network'); }
  if (!response.ok) { const data = await response.json().catch(() => null); throw new ApiFailure(response.status, response.status === 401 ? 'invalid_token' : data?.error ?? 'failed'); }
  return response.json() as Promise<T>;
}
function folders() {
  folderInput.replaceChildren();
  const option = (value: string, label: string) => { const node = document.createElement('option'); node.value = value; node.textContent = label; folderInput.append(node); };
  option('browser', copy.browserFolder); option('unfiled', copy.unfiled);
  const byId = new Map(connection!.folders.map(folder => [folder.id, folder]));
  const path = (id: string) => { const names: string[] = [], seen = new Set<string>(); let row = byId.get(id);
    while (row && !seen.has(row.id)) { seen.add(row.id); names.unshift(row.name); row = row.parentId ? byId.get(row.parentId) : undefined; }
    return names.join(' / '); };
  [...connection!.folders].sort((a, b) => path(a.id).localeCompare(path(b.id))).forEach(folder => option(folder.id, path(folder.id)));
}
function renderCapture() {
  if (!captured) return;
  show('capture'); titleInput.value = pending?.payload.title ?? captured.title; el('url').textContent = captured.url;
  const content = mode === 'selection' ? captured.selection : captured.text;
  el('excerpt').textContent = content; el('size').textContent = `${content.length.toLocaleString(locale)} ${copy.chars}`;
  el('page-mode').setAttribute('aria-pressed', String(mode === 'page')); el('selection-mode').setAttribute('aria-pressed', String(mode === 'selection'));
  el('retry').hidden = !pending; lock(false);
}
async function readPage() {
  error(); show('loading'); pending = null; receipt = null; await browser.storage.local.remove('pending');
  try {
    const { entry } = await browser.storage.local.get('entry') as LocalState; await browser.storage.local.remove('entry');
    const supplied = entry && Date.now() - entry.at >= 0 && Date.now() - entry.at < 30000;
    const tab = supplied ? await browser.tabs.get(entry.tabId) : (await browser.tabs.query({ active: true, currentWindow: true }))[0];
    if (tab?.id == null || !tab.url || !/^https?:\/\//.test(tab.url)) throw new Error('unsupported');
    const originalUrl = tab.url;
    await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ['capture.js'] });
    const [result] = await browser.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      const value = (window as Window & { __reomiCapture?: CaptureResult }).__reomiCapture;
      delete (window as Window & { __reomiCapture?: CaptureResult }).__reomiCapture; return value;
    } });
    const value = result?.result as CaptureResult | undefined;
    if (!value?.ok) throw new Error(value?.error ?? 'unreadable');
    if ((await browser.tabs.get(tab.id)).url !== originalUrl || value.capture.url !== originalUrl) throw new Error('changed_page');
    captured = value.capture; mode = supplied && entry.selection || captured.selection ? 'selection' : 'page';
    if (supplied && entry.selection && !captured.selection) throw new Error('no_selection');
    renderCapture();
  } catch (e) { show('capture'); captured = null; titleInput.value = ''; el('excerpt').textContent = ''; error(e instanceof Error ? e.message : 'failed');
    for (const id of ['save','save-card','page-mode','selection-mode']) el<HTMLButtonElement>(id).disabled = true; }
}
async function establish(credential: string) {
  const next = await request<Connection>('connection', undefined, credential);
  if (!next.user?.id || !Array.isArray(next.folders)) throw new Error('invalid_token');
  token = credential; connection = next;
  await browser.storage.local.set({ token });
  const stored = await browser.storage.local.get(['pending', 'preferred']) as LocalState;
  pending = stored.pending?.owner === next.user.id && Date.now() - stored.pending.at < 30 * 60000 ? stored.pending as Pending : null;
  if (!pending) await browser.storage.local.remove('pending');
  folders();
  const preferred = stored.preferred;
  if (preferred?.owner === next.user.id && [...folderInput.options].some(o => o.value === preferred.value)) folderInput.value = preferred.value;
  el('account').textContent = next.user.name; el('disconnect').hidden = false;
  if (pending) {
    const p = pending.payload; mode = p.mode; captured = { url: p.url, title: p.title, text: p.mode === 'page' ? p.text : '', selection: p.mode === 'selection' ? p.text : '' };
    const destination = p.folderId === undefined ? 'browser' : p.folderId === null ? 'unfiled' : p.folderId;
    if (![...folderInput.options].some(o => o.value === destination)) { const option = document.createElement('option'); option.value = destination; option.textContent = copy.folder_not_found; folderInput.append(option); }
    folderInput.value = destination; renderCapture(); error('network');
  } else await readPage();
}
async function save(makeCard = false) {
  if (busy || !captured || !connection) return;
  error(); lock(true);
  try {
    if (!pending) {
      const content = mode === 'selection' ? captured.selection : captured.text, title = titleInput.value.trim();
      if (!title || !content.trim()) throw new ApiFailure(400, 'invalid_capture');
      if (content.length > (mode === 'selection' ? 4000 : 200000)) throw new ApiFailure(400, 'too_large');
      pending = { owner: connection.user.id, at: Date.now(), payload: { requestKey: crypto.randomUUID(), url: captured.url, title, text: content, mode, locale,
        ...(folderInput.value === 'browser' ? {} : { folderId: folderInput.value === 'unfiled' ? null : folderInput.value }) } };
      await browser.storage.local.set({ pending, preferred: { owner: connection.user.id, value: folderInput.value } });
    }
    const savedTitle = pending.payload.title;
    receipt = await request<Receipt>('captures', pending.payload);
    if (!/^[a-f0-9-]{36}$/.test(receipt.sourceId) || !/^[a-f0-9-]{36}$/.test(receipt.receiptId)) throw new ApiFailure(0, 'network');
    pending = null; await browser.storage.local.remove('pending'); el('retry').hidden = true;
    el('saved-title').textContent = savedTitle; show('saved');
    if (makeCard) await openSaved(true);
  } catch (e) {
    if (e instanceof ApiFailure && e.status >= 400 && e.status < 500 && ![408, 429].includes(e.status)) { pending = null; await browser.storage.local.remove('pending'); }
    error(e instanceof Error ? e.message : 'failed'); el('retry').hidden = !pending;
    if (e instanceof ApiFailure && e.status === 401) show('setup');
  } finally { lock(false); }
}
async function openSaved(card: boolean) {
  if (!receipt) return;
  await browser.tabs.create({ url: `${WEB}/library/${receipt.sourceId}${card ? `?capture=${receipt.receiptId}` : ''}` });
}
el('connect-form').addEventListener('submit', event => { event.preventDefault(); const credential = tokenInput.value.trim(); tokenInput.value = '';
  if (busy) return; error(); lock(true);
  void establish(credential).catch(e => { show('setup'); error(e instanceof Error ? e.message : 'failed'); }).finally(() => lock(false)); });
el('settings').onclick = () => { error(); show('setup'); };
el('disconnect').onclick = () => { void browser.storage.local.remove(['token','pending','entry','preferred']).then(() => { token = ''; connection = null; pending = null; el('account').textContent = ''; el('disconnect').hidden = true; show('setup'); error(); }); };
el('page-mode').onclick = () => { mode = 'page'; error(); renderCapture(); };
el('selection-mode').onclick = () => { mode = 'selection'; error(); renderCapture(); };
el('save').onclick = () => void save(); el('save-card').onclick = () => void save(true); el('retry').onclick = () => void save();
el('open-material').onclick = () => void openSaved(false); el('make-card').onclick = () => void openSaved(true); el('another').onclick = () => void readPage();
void browser.storage.local.get('token').then(async (stored: LocalState) => { if (!stored.token) { show('setup'); return; } await establish(stored.token); })
  .catch(e => { show('setup'); error(e instanceof Error ? e.message : 'failed'); });
