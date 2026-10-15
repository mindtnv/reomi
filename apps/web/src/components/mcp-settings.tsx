'use client';

import React, { useCallback, useEffect, useState, useRef } from 'react';
import { NNBtn, NNSkeleton } from './ui';
import { useT } from '@/lib/i18n';
import { apiErrorFromResponse } from '@/lib/api';
import { copyCodeText } from './chat/code-copy';
import { useDialog } from './dialog';

const apiBase = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
type TokenItem = { id: string; name: string; prefix: string; scope: 'read' | 'write'; expiresAt: string; lastUsedAt: string | null; revokedAt: string | null };
async function request<T>(path = '', options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase}/profile/tokens${path}`, { ...options, credentials: 'include', headers: { 'content-type': 'application/json' }, cache: 'no-store' });
  if (!response.ok) throw await apiErrorFromResponse(response);
  return response.json() as Promise<T>;
}
const fieldStyle: React.CSSProperties = { background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text)', padding: '9px 11px', fontSize: 13, width: '100%' };

/** Parent keys this component by session user so secrets never cross accounts. */
export function McpSettings() {
  const t = useT();
  const { confirm } = useDialog();
  const [items, setItems] = useState<TokenItem[] | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const mutationLock = useRef(false);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'read' | 'write'>('read');
  const [days, setDays] = useState(90);
  const [created, setCreated] = useState<{ token: string; item: TokenItem } | null>(null);
  const [copied, setCopied] = useState('');
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(v => v + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    setError(false);
    void request<TokenItem[]>('', { signal: controller.signal }).then(setItems).catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [revision]);
  const copy = async (value: string, kind: string) => {
    try { await copyCodeText(value); setCopied(kind); }
    catch { setError(true); }
  };
  const create = async (event: React.FormEvent) => {
    event.preventDefault(); if (mutationLock.current || created || !name.trim()) return;
    mutationLock.current = true;
    setBusy(true); setError(false); setCopied('');
    try {
      const result = await request<{ token: string; item: TokenItem }>('', { method: 'POST', body: JSON.stringify({ name: name.trim(), scope, expiresInDays: days }) });
      setCreated(result); setName(''); refresh();
    } catch { setError(true); }
    finally { mutationLock.current = false; setBusy(false); }
  };
  const revoke = async (item: TokenItem) => {
    if (mutationLock.current) return;
    mutationLock.current = true;
    if (!(await confirm({ title: t('settings.mcp.revokeConfirm', { name: item.name }), danger: true }))) { mutationLock.current = false; return; }
    setBusy(true); setError(false);
    try {
      await request(`/${item.id}`, { method: 'DELETE' });
      if (created?.item.id === item.id) setCreated(null);
      refresh();
    } catch { setError(true); }
    finally { mutationLock.current = false; setBusy(false); }
  };
  const endpoint = `${apiBase}/mcp`;
  const command = `codex mcp add reomi --url ${JSON.stringify(endpoint)} --bearer-token-env-var REOMI_MCP_TOKEN`;
  return <section className="reomi-mcp-settings" aria-label={t('settings.mcp.title')} style={{ display: 'grid', gap: 16 }}>
    <p style={{ margin: 0, fontSize: 13, color: 'var(--text-dim)' }}>{t('settings.mcp.hint')}</p>
    {error && <div role="alert" style={{ color: 'var(--rose-400)', fontSize: 13 }}>{t('settings.mcp.error')} <NNBtn size="sm" onClick={refresh}>{t('settings.mcp.retry')}</NNBtn></div>}
    <form className="reomi-mcp-create" onSubmit={create} style={{ display: 'grid', gap: 10 }}>
      <label style={{ fontSize: 12 }}>{t('settings.mcp.name')}<input value={name} onChange={e => setName(e.target.value)} maxLength={80} required placeholder="Codex / Claude" style={{ ...fieldStyle, marginTop: 5 }} /></label>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <label style={{ flex: '1 1 200px', fontSize: 12 }}>{t('settings.mcp.permissions')}<select value={scope} onChange={e => setScope(e.target.value as 'read' | 'write')} style={{ ...fieldStyle, marginTop: 5 }}><option value="read">{t('settings.mcp.read')}</option><option value="write">{t('settings.mcp.write')}</option></select></label>
        <label style={{ flex: '1 1 140px', fontSize: 12 }}>{t('settings.mcp.expires')}<select value={days} onChange={e => setDays(Number(e.target.value))} style={{ ...fieldStyle, marginTop: 5 }}>{[7, 30, 90, 365].map(n => <option key={n} value={n}>{t('settings.mcp.days', { n })}</option>)}</select></label>
      </div>
      <div><NNBtn type="submit" size="sm" disabled={busy || Boolean(created) || !name.trim()}>{busy ? t('settings.mcp.working') : t('settings.mcp.create')}</NNBtn></div>
    </form>
    {created && <div role="status" style={{ border: '1px solid var(--lime-400)', borderRadius: 10, padding: 14, display: 'grid', gap: 10 }}>
      <strong style={{ fontSize: 13 }}>{t('settings.mcp.oneTime')}</strong>
      <code style={{ overflowWrap: 'anywhere', fontSize: 12, userSelect: 'all' }}>{created.token}</code>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}><NNBtn size="sm" onClick={() => void copy(created.token, 'token')}>{t(copied === 'token' ? 'settings.mcp.copied' : 'settings.mcp.copyToken')}</NNBtn><NNBtn size="sm" onClick={() => setCreated(null)}>{t('settings.mcp.saved')}</NNBtn></div>
    </div>}
    <div style={{ display: 'grid', gap: 8 }}>
      {items === null && !error && <NNSkeleton width="100%" height={60} />}
      {items?.length === 0 && <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>{t('settings.mcp.empty')}</p>}
      {items?.map(item => {
        const inactive = Boolean(item.revokedAt) || new Date(item.expiresAt) <= new Date();
        return <div className="reomi-mcp-token" key={item.id} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--border)' }}>
          <div style={{ flex: '1 1 220px', minWidth: 0 }}><div style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{item.name} · {t(item.scope === 'read' ? 'settings.mcp.read' : 'settings.mcp.write')}</div><div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>{item.prefix}… · {t('settings.mcp.validUntil')} {new Date(item.expiresAt).toLocaleDateString()} · {t('settings.mcp.lastUsed')} {item.lastUsedAt ? new Date(item.lastUsedAt).toLocaleString() : t('settings.mcp.never')}</div></div>
          {inactive ? <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{t(item.revokedAt ? 'settings.mcp.revoked' : 'settings.mcp.expired')}</span> : <NNBtn size="sm" disabled={busy} onClick={() => void revoke(item)}>{t('settings.mcp.revoke')}</NNBtn>}
        </div>;
      })}
    </div>
    <details><summary style={{ cursor: 'pointer', fontSize: 13 }}>{t('settings.mcp.connect')}</summary><div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
      <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: 0 }}>{t('settings.mcp.environment')}</p>
      <code style={{ overflowWrap: 'anywhere', fontSize: 12 }}>{endpoint}</code>
      <div><NNBtn size="sm" onClick={() => void copy(endpoint, 'url')}>{t(copied === 'url' ? 'settings.mcp.copied' : 'settings.mcp.copyUrl')}</NNBtn></div>
      <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: 0 }}>{t('settings.mcp.codexHelp')}</p>
      <pre style={{ margin: 0, padding: 12, fontSize: 11, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', background: 'var(--surface-2)', borderRadius: 8 }}>{command}</pre>
      <NNBtn size="sm" onClick={() => void copy(command, 'command')}>{t(copied === 'command' ? 'settings.mcp.copied' : 'settings.mcp.copyCommand')}</NNBtn>
      <p style={{ fontSize: 12, color: 'var(--text-dim)', margin: 0 }}>{t('settings.mcp.otherClients')}</p>
    </div></details>
  </section>;
}
