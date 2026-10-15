'use client';

/* eslint-disable react/forbid-elements -- TODO: replace raw input, select, and button with TextInput, Button, or NNSelect. */

import { useEffect, useState, useRef } from 'react';
import { fetchMarks, updateMark } from '@/lib/pdf-annotations';
import type { SourceMark } from '@/lib/types';
import { useT } from '@/lib/i18n';
import { NNBtn } from '@/components/ui';
import { useNavigationGuard } from '@/components/navigation';
import { useDialog } from '@/components/dialog';
import { MARK_NOTE_MAX } from '@reomi/shared';

/** Annotation comments remain owned by the source, unlike retained study notes. */
export function SourceAnnotationNotes({ sourceId, onOpen }: { sourceId: string; onOpen: (mark: SourceMark) => void }) {
  const t = useT();
  const { select } = useDialog();
  const saving = useRef(false);
  const [marks, setMarks] = useState<SourceMark[]>([]);
  const [error, setError] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    fetchMarks(sourceId).then(items => { if (active) setMarks(items.filter(mark => mark.kind === 'note')); }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [sourceId]);
  const save = async (id: string) => {
    if (saving.current) return false;
    saving.current = true; setBusy(true); setError(false);
    try {
      const updated = await updateMark(sourceId, id, { note: text });
      setMarks(items => items.map(mark => mark.id === id ? updated : mark));
      window.dispatchEvent(new CustomEvent('nn:pdf-marks-changed', { detail: sourceId }));
      setEditing(null); return true;
    } catch { setError(true); return false; }
    finally { saving.current = false; setBusy(false); }
  };
  const allowClose = async () => {
    if (saving.current) return false;
    if (!editing || text === (marks.find(mark => mark.id === editing)?.note ?? '')) return true;
    const choice = await select({ title: t('editor.draft.leaveTitle'), value: 'save', options: [
      { value: 'save', label: t('editor.draft.saveAndLeave') }, { value: 'discard', label: t('editor.draft.discardAndLeave') },
    ], cancelLabel: t('editor.draft.stay') });
    return choice === 'discard' || choice === 'save' && await save(editing);
  };
  useNavigationGuard(allowClose);
  return <section className="reomi-source-annotation-notes">
    <h3>{t('notebooks.marks.annotationNotes')}</h3>
    <p>{t('notebooks.marks.annotationNotesHint')}</p>
    {error && <p role="alert">{t('assistant.selectionSaveFailed')}</p>}
    {!marks.length && !error && <p>{t('notebooks.marks.noAnnotationNotes')}</p>}
    {marks.map(mark => <article key={mark.id}>
      <button type="button" className="reomi-annotation-location" onClick={() => onOpen(mark)}>{t('notebooks.marks.pageGroup', { n: mark.page })} ↗</button>
      <blockquote>{mark.quote}</blockquote>
      {editing === mark.id ? <><textarea aria-label={t('notebooks.marks.note')} rows={3} maxLength={MARK_NOTE_MAX} value={text} disabled={busy} onChange={event => setText(event.target.value)}/>
        <NNBtn size="sm" disabled={busy || !text.trim()} onClick={() => void save(mark.id)}>{t('notebooks.marks.noteSave')}</NNBtn></> : <>
        <p>{mark.note}</p><NNBtn size="sm" variant="ghost" icon="edit" onClick={async () => { if (await allowClose()) { setEditing(mark.id); setText(mark.note ?? ''); } }}>{t('actions.edit')}</NNBtn></>}
    </article>)}
  </section>;
}
