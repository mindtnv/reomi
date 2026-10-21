'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { documentationRuleSelected, type DocumentationSchedule } from '@reomi/shared';
import { ApiError } from '@/lib/api';
import { documentationApi, documentationSelection, type DocumentationPreview } from '@/lib/library-documentation';
import { useLocale, useT } from '@/lib/i18n';
import { useNN } from '@/lib/store';
import { invalidateSessionResourceScope, useSessionResource } from '@/lib/session-resource';
import { useTransientLayer } from '@/lib/use-transient-layer';
import { Button, Checkbox, TextInput } from './design-system/primitives';
import { NNIcon, NNLoadError } from './ui';
import { NNSelect } from './nn-select';
import { useDialog } from './dialog';

const errorCodes = new Set(['documentation_unavailable', 'documentation_empty', 'documentation_preview_expired', 'documentation_already_connected',
  'documentation_busy', 'documentation_folder_missing', 'library_full', 'folder_limit', 'folder_depth_limit', 'invalid_sections', 'source_busy', 'fetch_failed', 'empty_source', 'remote_missing', 'documentation_limit', 'documentation_preview_limit']);
function errorKey(error: unknown) {
  const code = error instanceof ApiError ? error.safeMessage : typeof error === 'string' ? error : '';
  return errorCodes.has(code) ? `library.documentation.errors.${code}` : 'library.documentation.failed';
}

export function LibraryDocumentation(props: Parameters<typeof DocumentationWorkspace>[0]) {
  const owner = useNN(s => s.profile?.userId);
  return <DocumentationWorkspace key={owner} {...props} />;
}

function DocumentationWorkspace({ open, onClose, onChanged, onOpenFolder }: {
  open: boolean; onClose: () => void; onChanged: () => void; onOpenFolder: (id: string) => void;
}) {
  const t = useT(), { locale } = useLocale(), dialog = useDialog(), owner = useNN(s => s.profile?.userId);
  const mounted = useRef(true), busyRef = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const fetcher = useCallback(async () => ({ ...await documentationApi.list(), owner }), [owner]);
  const resource = useSessionResource({ key: `library:documentation:${owner}`, scope: 'library:documentation', enabled: Boolean(owner), fetcher });
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState('');
  const [details, setDetails] = useState<{ id: string; items: { id: string; title: string; url: string; errorCode: string | null }[] } | null>(null);
  const items = resource.data?.owner === owner ? resource.data?.items ?? [] : [];
  const active = items.some(c => c.state === 'queued' || c.state === 'running' || c.checking);
  const scheduled = items.some(c => c.schedule && c.schedule !== 'off');
  const counts = items.map(c => `${c.id}:${c.completed}:${c.failed}:${c.state}:${c.checkedAt}`).join('|');
  const priorCounts = useRef(counts);
  useEffect(() => {
    if (priorCounts.current !== counts) { priorCounts.current = counts; onChanged(); }
  }, [counts, onChanged]);
  useEffect(() => {
    const refresh = () => { if (!document.hidden) resource.refresh(); };
    const timer = active || scheduled ? setInterval(refresh, active ? 2000 : 60_000) : null;
    document.addEventListener('visibilitychange', refresh);
    return () => { if (timer) clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [active, scheduled, resource.refresh]);
  async function run(id: string, action: 'update' | 'cancel' | 'errors' | 'disconnect' | 'schedule', schedule?: DocumentationSchedule) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(id); setError('');
    const current = () => mounted.current && owner === useNN.getState().profile?.userId;
    try {
      if (action === 'errors') {
        const response = await documentationApi.errors(id);
        if (current()) setDetails({ id, items: response.items });
      } else {
        if (action === 'disconnect') {
          if (!await dialog.confirm({ title: t('library.documentation.disconnect'), message: t('library.documentation.disconnectHint'), confirmLabel: t('library.documentation.disconnect') }) || !current()) return;
          await documentationApi.disconnect(id);
        } else if (action === 'schedule' && schedule) await documentationApi.schedule(id, schedule);
        else if (action === 'update') await documentationApi.update(id); else await documentationApi.cancel(id);
        if (current()) { invalidateSessionResourceScope('library:documentation'); resource.refresh(); onChanged(); setDetails(null); }
      }
    } catch (e) {
      if (current()) { setError(t(errorKey(e))); invalidateSessionResourceScope('library:documentation'); resource.refresh(); onChanged(); }
    }
    finally { if (current()) setBusy(null); busyRef.current = false; }
  }
  return <>
    {items.length > 0 && <section className="reomi-doc-connections" aria-label={t('library.documentation.connected')}>
      <div className="reomi-doc-heading"><NNIcon name="link" size={14} /><span>{t('library.documentation.connected')}</span><span className="reomi-doc-muted">{items.length}</span></div>
      {items.map(item => {
        const running = item.state === 'queued' || item.state === 'running';
        return <div className="reomi-doc-connection" key={item.id}>
          <div className="reomi-doc-connection-title"><NNIcon name="book" size={20} /><div><strong>{item.title}</strong><span className="reomi-doc-muted">{new URL(item.rootUrl).hostname} · {item.locale.toUpperCase()}</span></div></div>
          <div className="reomi-doc-progress" aria-live="polite"><span>{t(item.checking ? 'library.documentation.checking' : `library.documentation.states.${item.state}`)} · {t('library.documentation.progress', { done: item.completed, total: item.total })}</span>
            {running && <progress max={Math.max(1, item.total)} value={item.total - item.pending} aria-label={t('library.documentation.importProgress')} />}
            {item.failed > 0 && <Button variant="ghost" size="sm" onClick={() => void run(item.id, 'errors')} disabled={busy !== null}>{t('library.documentation.failures', { count: item.failed })}</Button>}
            {item.errorCode && <span role="status" className="reomi-doc-error">{t(errorKey(item.errorCode))}</span>}
            {item.syncError && <span role="status" className="reomi-doc-error">{t(errorKey(item.syncError))}</span>}
            {item.lastResult && <span className="reomi-doc-muted">{t('library.documentation.changes', { added: item.lastResult.added, updated: item.lastResult.updated, unchanged: item.lastResult.unchanged })}</span>}
            {item.checkedAt && <span className="reomi-doc-muted">{t('library.documentation.lastChecked', { date: new Date(item.checkedAt).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' }) })}</span>}
          </div>
          <div className="reomi-doc-controls"><label className="reomi-doc-schedule"><span>{t('library.documentation.schedule')}</span><NNSelect
            ariaLabel={t('library.documentation.scheduleFor', { title: item.title })} value={item.schedule ?? 'off'} disabled={busy !== null}
            options={(['off', 'daily', 'weekly'] as const).map(value => ({ value, label: t(`library.documentation.schedules.${value}`) }))}
            onChange={value => void run(item.id, 'schedule', value as DocumentationSchedule)} /></label>
          {item.schedule !== 'off' && item.nextSyncAt && <span className="reomi-doc-muted reomi-doc-next">{item.state === 'cancelled' ? t('library.documentation.schedulePaused') : t('library.documentation.nextCheck', { date: new Date(item.nextSyncAt).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' }) })}</span>}
          <div className="reomi-doc-actions"><Button variant="soft" size="sm" disabled={!item.folderId} onClick={() => item.folderId && onOpenFolder(item.folderId)}>{t('library.documentation.openFolder')}</Button>
            <Button variant="ghost" size="sm" disabled={busy !== null || !item.folderId || item.checking} onClick={() => void run(item.id, running ? 'cancel' : 'update')}>
              {busy === item.id ? t('states.loading') : t(running ? 'library.documentation.cancelImport' : item.state === 'cancelled' ? 'library.documentation.resume' : 'library.documentation.checkUpdates')}
            </Button><Button variant="ghost" size="sm" disabled={busy !== null} aria-label={t('library.documentation.disconnect')} onClick={() => void run(item.id, 'disconnect')}><NNIcon name="x" size={14} /></Button></div></div>
        </div>;
      })}
      {details && <div className="reomi-doc-errors"><div className="reomi-doc-heading"><strong>{t('library.documentation.failureDetails')}</strong><Button size="sm" variant="ghost" onClick={() => setDetails(null)}>{t('actions.close')}</Button></div>
        {details.items.map(item => <div key={item.id}><strong>{item.title}</strong><span>{t(errorKey(item.errorCode))}</span></div>)}
      </div>}
    </section>}
    {error && <p role="alert" className="reomi-doc-error">{error}</p>}
    {resource.status === 'error' && <NNLoadError title={t('library.documentation.loadFailed')} retryLabel={t('library.folders.retry')} onRetry={resource.refresh} />}
    {open && <DocumentationImport key={owner} onClose={onClose} onReconcile={() => {
      invalidateSessionResourceScope('library:documentation'); resource.refresh(); onChanged();
    }} onImported={id => {
      invalidateSessionResourceScope('library:documentation'); resource.refresh(); onChanged(); onOpenFolder(id); onClose();
    }} />}
  </>;
}

function DocumentationImport({ onClose, onImported, onReconcile }: { onClose: () => void; onImported: (folderId: string) => void; onReconcile: () => void }) {
  const t = useT(), { locale } = useLocale(), id = useId();
  const [url, setUrl] = useState(''), [language, setLanguage] = useState<'en' | 'ru'>(locale === 'ru' ? 'ru' : 'en');
  const [preview, setPreview] = useState<DocumentationPreview | null>(null), [title, setTitle] = useState('');
  const [selected, setSelected] = useState(new Set<string>()), [expanded, setExpanded] = useState(new Set<string>());
  const [busy, setBusy] = useState(false), [confirming, setConfirming] = useState(false), [error, setError] = useState('');
  const root = useRef<HTMLDivElement>(null), mounted = useRef(true), running = useRef(false);
  const owner = useNN(s => s.profile?.userId);
  const sectionChildren = useMemo(() => {
    const children = new Map<string | null, DocumentationPreview['sections']>();
    for (const section of preview?.sections ?? []) { const siblings = children.get(section.parent) ?? []; siblings.push(section); children.set(section.parent, siblings); }
    return children;
  }, [preview]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useTransientLayer({ root, modal: true, onClose, busy: confirming });
  const totals = preview ? documentationSelection(preview, selected) : { pages: 0, added: 0 };
  const tooLarge = Boolean(preview && totals.added > preview.available);
  async function submit() {
    if (running.current) return;
    running.current = true; setBusy(true); setError('');
    const current = () => mounted.current && owner === useNN.getState().profile?.userId;
    try {
      if (!preview) {
        const result = await documentationApi.preview(url, language);
        if (!current()) return;
        setPreview(result); setTitle(result.title);
        const rootPath = new URL(result.rootUrl).pathname;
        const initial = result.sections.filter(s => s.parent === rootPath && !s.reference).map(s => s.prefix);
        setSelected(new Set(initial.length ? initial : [rootPath]));
        setExpanded(new Set([rootPath]));
      } else {
        setConfirming(true);
        const result = await documentationApi.confirm(preview.id, title, [...selected]);
        if (current() && result.folderId) onImported(result.folderId);
      }
    } catch (e) { if (current()) { setError(t(errorKey(e))); if (preview) onReconcile(); } }
    finally { if (current()) { setBusy(false); setConfirming(false); } running.current = false; }
  }
  function branch(parent: string | null, depth = 0): React.ReactNode {
    if (!preview || depth > 20) return null;
    return (sectionChildren.get(parent) ?? []).map(section => {
      const hasChildren = sectionChildren.has(section.prefix);
      const checked = documentationRuleSelected(section.prefix, [...selected]);
      return <div key={section.prefix} className="reomi-doc-section">
        <div className="reomi-doc-section-row" style={{ paddingLeft: depth * 16 }}>
          {hasChildren ? <Button variant="ghost" size="sm" className="reomi-doc-expand" aria-expanded={expanded.has(section.prefix)} aria-label={t(expanded.has(section.prefix) ? 'library.folders.collapse' : 'library.folders.expand', { name: section.title })} onClick={() => setExpanded(previous => { const next = new Set(previous); if (next.has(section.prefix)) next.delete(section.prefix); else next.add(section.prefix); return next; })}><NNIcon name={expanded.has(section.prefix) ? 'chevd' : 'chevr'} size={13} /></Button> : <span className="reomi-doc-expand" />}
          <Checkbox checked={checked} disabled={busy} onChange={value => setSelected(previous => {
            const next = new Set(previous);
            for (const p of next) if ((p.startsWith('!') ? p.slice(1) : p).startsWith(section.prefix)) next.delete(p);
            next.add(value ? section.prefix : `!${section.prefix}`);
            return next;
          })}>{section.parent === null ? t('library.documentation.allSections') : section.title}</Checkbox>
          <span className="reomi-doc-muted">{section.pageCount}</span>
        </div>
        {hasChildren && expanded.has(section.prefix) && branch(section.prefix, depth + 1)}
      </div>;
    });
  }
  return createPortal(<div className="reomi-doc-overlay"><div ref={root} className="reomi-doc-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-heading`}>
    <div className="reomi-doc-dialog-heading"><span className="reomi-doc-emblem"><NNIcon name="book" size={23} /></span><div><h2 id={`${id}-heading`}>{t('library.documentation.add')}</h2><p>{t('library.documentation.description')}</p></div><Button variant="ghost" size="sm" disabled={confirming} aria-label={t('actions.close')} onClick={onClose}><NNIcon name="x" size={17} /></Button></div>
    <div className="reomi-doc-dialog-body">
      {!preview ? <><label htmlFor={`${id}-url`}>{t('library.documentation.url')}</label><TextInput id={`${id}-url`} type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="https://kubernetes.io/docs/home/" maxLength={2000} disabled={busy} />
        <label>{t('library.documentation.language')}<NNSelect ariaLabel={t('library.documentation.language')} value={language} onChange={value => setLanguage(value as 'en' | 'ru')} options={[{ value: 'en', label: 'English' }, { value: 'ru', label: 'Русский' }]} disabled={busy} /></label><p className="reomi-doc-muted">{t('library.documentation.scopeHint')}</p></>
        : <><div className="reomi-doc-root"><span className="reomi-doc-muted">{t('library.documentation.detectedRoot')} · {preview.locale.toUpperCase()}</span><span>{preview.rootUrl}</span></div>
          <label htmlFor={`${id}-title`}>{t('library.documentation.folderName')}</label><TextInput id={`${id}-title`} value={title} onChange={e => setTitle(e.target.value)} maxLength={100} disabled={busy} />
          <div className="reomi-doc-heading"><strong>{t('library.documentation.sections')}</strong><span className="reomi-doc-muted">{t('library.documentation.discovered', { count: preview.total })}</span></div>
          <div className="reomi-doc-tree" aria-label={t('library.documentation.sections')}>{branch(null)}</div>
          <p className={tooLarge ? 'reomi-doc-error' : 'reomi-doc-muted'} role="status">{t('library.documentation.selection', { count: totals.pages, added: totals.added, available: preview.available })}</p>
          {tooLarge && <p className="reomi-doc-error">{t('library.documentation.chooseSmaller')}</p>}
        </>}
      {error && <p role="alert" className="reomi-doc-error">{error}</p>}
    </div>
    <div className="reomi-doc-dialog-footer"><Button variant="ghost" disabled={busy} onClick={() => { if (preview) { setPreview(null); setError(''); } else onClose(); }}>{t(preview ? 'library.documentation.back' : 'actions.cancel')}</Button>
      <Button variant="primary" disabled={busy || (preview ? !totals.pages || tooLarge || !title.trim() : !url.trim())} onClick={() => void submit()}>{busy ? t(preview ? 'library.documentation.starting' : 'library.documentation.discovering') : t(preview ? 'library.documentation.import' : 'library.documentation.findSections')}</Button></div>
  </div></div>, document.body);
}
