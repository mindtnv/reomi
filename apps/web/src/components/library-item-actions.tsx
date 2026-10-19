'use client';

import { CardActionsMenu } from '@/components/card-actions-menu';
import { useDialog } from '@/components/dialog';
import { raiseToast } from '@/components/toasts';
import { useNN } from '@/lib/store';
import { useT } from '@/lib/i18n';
import type { LibraryItem, LibraryItemDetail } from '@/lib/types';

/** The menu only dispatches existing owner-scoped, revision-aware workflows. */
export function LibraryItemActions({ item, x, y, mobile, moving, isCurrent, onClose, onOpen, onMove, onDetails, onPatched, onDeleted }: {
  item: LibraryItem; x: number; y: number; mobile: boolean; moving: boolean;
  isCurrent: () => boolean; onClose: (restoreFocus: boolean) => void;
  onOpen: () => void; onMove: () => void; onDetails: () => void;
  onPatched: (item: Partial<LibraryItem> & Pick<LibraryItem, 'id'>) => void; onDeleted: (id: string) => void;
}) {
  const t = useT(), { edit, confirm } = useDialog();
  const getItem = useNN(state => state.getLibraryItem);
  const deleteItem = useNN(state => state.deleteLibraryItem);
  const fail = () => { if (isCurrent()) raiseToast({ kind: 'error', title: t('library.details.saveFailed') }); };
  const rename = async () => {
    try {
      const current = await getItem(item.id);
      if (!isCurrent()) return;
      await edit({ title: t('library.details.renameTitle'), defaultValue: current.title, path: `/sources/${item.id}`,
        revision: current.metadataRevision ?? 0, maxLength: 300, trim: true, validate: value => !value.trim() ? ' ' : null,
        patch: value => ({ title: value }),
        readCurrent: async () => { const fresh = await getItem(item.id); return { revision: fresh.metadataRevision ?? 0, value: fresh.title }; },
        onSaved: async result => {
          if (!isCurrent()) return;
          const row = result.result as LibraryItemDetail;
          onPatched({ id: item.id, title: row.title, metadataRevision: row.metadataRevision });
        },
      });
    } catch { fail(); }
  };
  const remove = async () => {
    try {
      const current = await getItem(item.id);
      if (!isCurrent()) return;
      const accepted = await confirm({ title: t('library.delete.title'), danger: true,
        message: current.notebookCount > 0 ? t('library.delete.messageAttached', { count: current.notebookCount }) : t('library.delete.message'),
        confirmLabel: t('library.delete.confirm'),
      });
      if (!accepted || !isCurrent()) return;
      await deleteItem(item.id);
      if (isCurrent()) onDeleted(item.id);
    } catch { fail(); }
  };
  const run = (action: () => void) => () => { if (isCurrent()) action(); };
  return <CardActionsMenu x={x} y={y} mobile={mobile} label={item.title} closeLabel={t('actions.close')} onClose={onClose} actions={[
    { label: t('library.item.open'), icon: 'book', run: run(onOpen) },
    { label: t('library.item.move'), icon: 'folder-move', disabled: moving || item.status === 'deleting', run: run(onMove) },
    { label: t('actions.rename'), icon: 'edit', disabled: item.status === 'deleting', run: run(() => void rename()) },
    { label: t('library.item.details'), icon: 'info', run: run(onDetails) },
    { label: t('actions.delete'), icon: 'trash', danger: true, disabled: item.status === 'deleting', run: run(() => void remove()) },
  ]} />;
}
