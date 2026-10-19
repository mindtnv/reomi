'use client';

import { useCallback, useId, useRef, useState } from 'react';
import { folderAncestors, folderSubtree } from '@reomi/shared';
import { libraryFoldersApi, type LibraryFolder } from '@/lib/library-folders';
import { useSessionResource, invalidateSessionResourceScope } from '@/lib/session-resource';
import { useT } from '@/lib/i18n';
import { useNN } from '@/lib/store';
import { ApiError } from '@/lib/api';
import { useBreakpoint } from '@/lib/use-breakpoint';
import { useDialog } from './dialog';
import { raiseToast } from './toasts';
import { Button } from './design-system/primitives';
import { NNIcon, NNLoadError, NNSkeleton } from './ui';

export function useLibraryFolders(scope: string, onScopeChange: (value: string) => void, onChanged: () => void) {
  const t = useT(), dialog = useDialog();
  const [busy, setBusy] = useState(false), running = useRef(false);
  const fetcher = useCallback(() => libraryFoldersApi.list(), []);
  const resource = useSessionResource({ key: 'library:folders', scope: 'library:folders', fetcher });
  const folders = resource.data?.items ?? [];
  const currentFolder = folders.find(folder => folder.id === scope);

  const run = async (operation: (current: () => boolean) => Promise<boolean>) => {
    if (running.current) return false;
    const owner = useNN.getState().profile?.userId;
    const current = () => Boolean(owner && useNN.getState().profile?.userId === owner);
    if (!current()) return false;
    running.current = true; setBusy(true);
    try {
      if (!await operation(current) || !current()) return false;
      invalidateSessionResourceScope('library:list');
      invalidateSessionResourceScope('library:content');
      resource.refresh(); onChanged();
      return true;
    } catch (error) {
      if (current()) {
        const code = error instanceof ApiError ? error.safeMessage : '';
        const known = ['folder_changed', 'folder_name_exists', 'folder_cycle', 'folder_limit', 'folder_not_found', 'source_not_found', 'invalid_folder_name'];
        raiseToast({ kind: 'error', title: t(known.includes(code) ? `library.folders.errors.${code}` : 'library.folders.failed') });
        resource.refresh(); onChanged();
      }
      return false;
    } finally { running.current = false; setBusy(false); }
  };
  const destinations = (excluded: string[] = []) => [
    { value: 'unfiled', label: t('library.folders.unfiled') },
    ...folders.filter(folder => !excluded.includes(folder.id)).map(folder => ({
      value: folder.id, label: folderAncestors(folders, folder.id).map(item => item.name).join(' / '),
    })),
  ];
  const chooseDestination = (title: string, excluded: string[] = [], value = 'unfiled', message?: string) => dialog.select({
    title, message, options: destinations(excluded), value, searchable: true,
    confirmLabel: t('library.folders.move'),
  });
  return {
    resource, folders, currentFolder, busy,
    refresh: resource.refresh,
    create: () => run(async current => {
      const name = await dialog.prompt({ title: t('library.folders.create'), label: t('library.folders.name'), confirmLabel: t('library.folders.create'),
        validate: value => !value.trim() || Array.from(value.trim()).length > 100 ? t('library.folders.errors.invalid_folder_name') : null });
      if (name === null || !current()) return false;
      const folder = await libraryFoldersApi.create(name, currentFolder?.id ?? null);
      if (current()) onScopeChange(folder.id);
      return true;
    }),
    rename: () => run(async current => {
      if (!currentFolder) return false;
      const name = await dialog.prompt({ title: t('library.folders.rename'), label: t('library.folders.name'), defaultValue: currentFolder.name,
        validate: value => !value.trim() || Array.from(value.trim()).length > 100 ? t('library.folders.errors.invalid_folder_name') : null });
      if (name === null || !current()) return false;
      await libraryFoldersApi.update(currentFolder.id, { revision: currentFolder.revision, name });
      return true;
    }),
    moveFolder: () => run(async current => {
      if (!currentFolder) return false;
      const destination = await chooseDestination(t('library.folders.moveFolder'), folderSubtree(folders, currentFolder.id).map(folder => folder.id), currentFolder.parentId ?? 'unfiled');
      if (destination === null || !current()) return false;
      await libraryFoldersApi.update(currentFolder.id, { revision: currentFolder.revision, parentId: destination === 'unfiled' ? null : destination });
      return true;
    }),
    remove: () => run(async current => {
      if (!currentFolder) return false;
      const preview = await libraryFoldersApi.preview(currentFolder.id);
      if (!current()) return false;
      const destination = await chooseDestination(t('library.folders.deleteDestination'), folderSubtree(folders, currentFolder.id).map(folder => folder.id), 'unfiled', t('library.folders.deletePreview', { folders: preview.folderCount, materials: preview.materialCount }));
      if (destination === null || !current()) return false;
      const label = destinations().find(option => option.value === destination)?.label ?? '';
      const confirmed = await dialog.confirm({ title: t('library.folders.delete'), message: t('library.folders.deleteConfirm', { name: currentFolder.name, folders: preview.folderCount, materials: preview.materialCount, destination: label }), confirmLabel: t('library.folders.delete'), danger: true });
      if (!confirmed || !current()) return false;
      await libraryFoldersApi.remove(currentFolder.id, preview.confirmationToken, destination === 'unfiled' ? null : destination);
      if (current()) onScopeChange('');
      return true;
    }),
    moveItems: (ids: string[]) => run(async current => {
      const destination = await chooseDestination(t('library.folders.moveMaterials', { count: ids.length }));
      if (destination === null || !current()) return false;
      await libraryFoldersApi.moveItems(ids, destination === 'unfiled' ? null : destination);
      return true;
    }),
    browserDefault: () => run(async current => {
      const folder = await libraryFoldersApi.browserDefault(t('library.folders.browser'));
      if (current()) onScopeChange(folder.id);
      return true;
    }),
  };
}

type Controls = ReturnType<typeof useLibraryFolders>;
export function LibraryFolderNavigation({ controls, scope, onScopeChange }: { controls: Controls; scope: string; onScopeChange: (value: string) => void }) {
  const t = useT();
  const compact = useBreakpoint() === 'mobile';
  const [mobileOpen, setMobileOpen] = useState(false);
  const panelId = useId();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const { resource, folders, busy, currentFolder } = controls;
  function branch(parentId: string | null, depth = 0): React.ReactNode {
    if (depth > 20) return null;
    return <ul className="reomi-folder-branch">{folders.filter(folder => folder.parentId === parentId).sort((a, b) => a.name.localeCompare(b.name)).map(folder => {
      const hasChildren = folders.some(child => child.parentId === folder.id), open = !collapsed.has(folder.id);
      return <li key={folder.id}><div className="reomi-folder-row">
        {hasChildren ? <Button size="sm" variant="bare" className="reomi-folder-toggle" aria-label={t(open ? 'library.folders.collapse' : 'library.folders.expand', { name: folder.name })} aria-expanded={open}
          onClick={() => setCollapsed(previous => { const next = new Set(previous); if (open) next.add(folder.id); else next.delete(folder.id); return next; })}><NNIcon name={open ? 'chevd' : 'chevr'} size={13} /></Button> : <span className="reomi-folder-toggle" />}
        <Button size="sm" variant="bare" className="reomi-folder-link" aria-current={scope === folder.id ? 'page' : undefined} onClick={() => onScopeChange(folder.id)}>
          <NNIcon name="folder" size={15} /><span className="reomi-folder-name">{folder.name}</span><span className="reomi-folder-count">{folder.count}</span>
        </Button>
      </div>{hasChildren && open && branch(folder.id, depth + 1)}</li>;
    })}</ul>;
  }
  return <aside className="reomi-library-folders">
    <div className="reomi-folder-heading">
      {compact ? <Button size="sm" variant="bare" className="reomi-folder-mobile-toggle" aria-label={t('library.folders.title')} aria-expanded={mobileOpen} aria-controls={panelId} onClick={() => setMobileOpen(value => !value)}><NNIcon name="folder" size={16} /><span className="reomi-folder-name">{currentFolder?.name ?? t(scope === 'unfiled' ? 'library.folders.unfiled' : 'library.folders.title')}</span><NNIcon name={mobileOpen ? 'chevd' : 'chevr'} size={14} /></Button> : <span>{t('library.folders.title')}</span>}
      <Button size="sm" variant="ghost" disabled={busy || !resource.data} aria-label={t('library.folders.create')} onClick={() => { setMobileOpen(true); void controls.create(); }}><NNIcon name="plus" size={16} /></Button>
    </div>
    <div id={panelId} hidden={compact && !mobileOpen}>
    <nav aria-label={t('library.folders.navigation')}>
      <Button variant="bare" className="reomi-folder-link" aria-current={!scope ? 'page' : undefined} onClick={() => onScopeChange('')}><NNIcon name="library" size={16} /><span className="reomi-folder-name">{t('library.folders.all')}</span><span className="reomi-folder-count">{resource.data?.totalCount ?? '—'}</span></Button>
      <Button variant="bare" className="reomi-folder-link" aria-current={scope === 'unfiled' ? 'page' : undefined} onClick={() => onScopeChange('unfiled')}><NNIcon name="folder" size={16} /><span className="reomi-folder-name">{t('library.folders.unfiled')}</span><span className="reomi-folder-count">{resource.data?.unfiledCount ?? '—'}</span></Button>
      {resource.status === 'loading' && <NNSkeleton style={{ height: 50, marginTop: 12 }} />}
      {resource.status === 'error' && <NNLoadError title={t('library.folders.failed')} retryLabel={t('library.folders.retry')} onRetry={resource.refresh} />}
      {resource.data && branch(null)}
    </nav>
    {currentFolder && <div className="reomi-folder-actions">
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void controls.rename()}>{t('library.folders.rename')}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void controls.moveFolder()}>{t('library.folders.move')}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void controls.remove()}>{t('library.folders.delete')}</Button>
    </div>}
    {!folders.some(folder => folder.purpose === 'browser') && resource.data && <Button className="reomi-browser-folder" size="sm" variant="ghost" disabled={busy} onClick={() => void controls.browserDefault()}><NNIcon name="globe" size={14} />{t('library.folders.browser')}</Button>}
    </div>
  </aside>;
}

export function LibraryFolderBreadcrumbs({ controls, scope, onScopeChange }: { controls: Controls; scope: string; onScopeChange: (value: string) => void }) {
  const t = useT();
  const path = scope && scope !== 'unfiled' ? folderAncestors(controls.folders, scope) : [];
  return <nav className="reomi-folder-breadcrumbs" aria-label={t('library.folders.breadcrumbs')}>
    <Button size="sm" variant="ghost" onClick={() => onScopeChange('')}>{t('library.folders.all')}</Button>
    {scope === 'unfiled' && <span aria-current="page">/ {t('library.folders.unfiled')}</span>}
    {path.map(folder => <span key={folder.id}>/ <Button size="sm" variant="ghost" aria-current={folder.id === scope ? 'page' : undefined} onClick={() => onScopeChange(folder.id)}>{folder.name}</Button></span>)}
    {controls.currentFolder && <span className="reomi-folder-scope-hint">{t('library.folders.subtreeCount', { count: controls.currentFolder.count })}</span>}
  </nav>;
}
