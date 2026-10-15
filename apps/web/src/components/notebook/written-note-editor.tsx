'use client';

import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { NOTE_CONTENT_MAX, NOTE_TITLE_MAX } from '@reomi/shared';
import { RecoverableSave } from '@/lib/recoverable-save';
import { getUiActionReceipt, saveUiAction } from '@/lib/ui-actions-api';
import { draftFingerprint } from '@/lib/editor-drafts';
import { useEditorDraft } from '@/lib/use-editor-draft';
import { isStudyNoteDraft, type StudyNoteDraft, type StudyNoteSave } from '@/lib/study-note-draft';
import { notebookNoteFromApi } from '@/lib/mappers';
import { useNN } from '@/lib/store';
import { useT } from '@/lib/i18n';
import type { NotebookNote } from '@/lib/types';
import { TextInput, TextArea } from '../design-system/primitives';
import { NNBtn } from '../ui';
import { SaveFeedback } from '../save-feedback';
import { EditorDraftNotice } from '../editor-draft-notice';

/** Key by account + original note/creation slot; never replace a live buffer from refreshed props. */
export function WrittenNoteEditor({ note, studyOwner, onSaved, onClose, getCurrent, closeGuardRef, draftSlot }: {
  draftSlot?: string;
  closeGuardRef?: React.MutableRefObject<(() => Promise<boolean>) | null>;
  note?: NotebookNote;
  studyOwner?: { kind: 'source' | 'notebook'; id: string };
  onSaved: (note: NotebookNote, close: boolean) => void;
  onClose: () => void;
  getCurrent?: (id: string) => Promise<NotebookNote>;
}) {
  const t = useT();
  const account = useNN(state => state.profile?.userId) ?? '';
  const [controller] = useState(() => new RecoverableSave<StudyNoteSave>(account));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [title, setTitle] = useState(note?.title ?? ''), [content, setContent] = useState(note?.content ?? '');
  const [id, setId] = useState(note?.id), [version, setVersion] = useState(note?.metadataRevision ?? 0);
  const [current, setCurrent] = useState<NotebookNote | null>(null), [readingCurrent, setReadingCurrent] = useState(false);
  const fingerprint = draftFingerprint({ title, content });
  const live = useRef({ title, content, fingerprint }); live.current = { title, content, fingerprint };
  useLayoutEffect(() => { controller.edit(fingerprint); }, [controller, fingerprint]);
  useEffect(() => { controller.activate(); return () => controller.dispose(); }, [controller]);
  const value: StudyNoteDraft = { version: 1, id, owner: studyOwner, expectedRevision: version, title, content, pendingSave: state.pending };
  const draft = useEditorDraft({
    scope: { ownerId: account, kind: 'study-note', entityId: draftSlot ?? note?.id ?? `${studyOwner?.kind}:${studyOwner?.id}:new` },
    value, fingerprint, validate: isStudyNoteDraft, busy: state.status === 'saving', unsettled: Boolean(state.pending),
    onRestore: restored => {
      setTitle(restored.title); setContent(restored.content); setId(restored.id); setVersion(restored.expectedRevision);
      if (restored.pendingSave) controller.restorePending(restored.pendingSave);
    },
    onSave: () => submit(),
  });
  const submit = async (explicitVersion?: number): Promise<boolean> => {
    if (!live.current.title.trim() || live.current.content.length > NOTE_CONTENT_MAX || draft.blocked || useNN.getState().profile?.userId !== account) return false;
    const payload: StudyNoteSave = { id, owner: studyOwner, expectedRevision: explicitVersion ?? version, title: live.current.title, content: live.current.content };
    if (explicitVersion !== undefined) controller.resolveConflict();
    const accepted = await controller.run(payload, live.current.fingerprint, request => request.payload.id
      ? saveUiAction(account, `/study-notes/${encodeURIComponent(request.payload.id)}`, 'PATCH', {
        expectedRevision: request.payload.expectedRevision, patch: { title: request.payload.title, content: request.payload.content },
      }, request.requestId)
      : saveUiAction(account, '/study-notes', 'POST', { owner: request.payload.owner,
        input: { title: request.payload.title, content: request.payload.content } }, request.requestId),
    requestId => getUiActionReceipt(account, requestId));
    if (!accepted || useNN.getState().profile?.userId !== account) return false;
    if (accepted.response.outcome !== 'applied' || !accepted.response.result) {
      if (accepted.response.result) setCurrent(notebookNoteFromApi(accepted.response.result));
      return false;
    }
    const saved = notebookNoteFromApi(accepted.response.result);
    setId(saved.id); setVersion(saved.metadataRevision ?? 0);
    draft.markSaved(accepted.submitted.fingerprint, { ...accepted.submitted.payload, version: 1, id: saved.id,
      expectedRevision: saved.metadataRevision ?? 0, pendingSave: null });
    const close = accepted.currentMatches && live.current.fingerprint === accepted.submitted.fingerprint;
    onSaved(saved, close);
    return close;
  };
  useEffect(() => {
    if (closeGuardRef) closeGuardRef.current = draft.confirmLeave;
    return () => { if (closeGuardRef?.current === draft.confirmLeave) closeGuardRef.current = null; };
  }, [closeGuardRef, draft.confirmLeave]);
  const close = async () => { if (await draft.confirmLeave()) onClose(); };
  const loadCurrent = async () => {
    if (!id || !getCurrent) return;
    setReadingCurrent(true);
    try { const row = await getCurrent(id); if (useNN.getState().profile?.userId === account) setCurrent(row); }
    catch { /* The input and conflict remain visible and retryable. */ }
    finally { setReadingCurrent(false); }
  };
  return <form className="nn-written-note-editor" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <EditorDraftNotice draft={draft} stale={Boolean(draft.pending && note && draft.pending.value.expectedRevision !== note.metadataRevision)} />
    <label>{t('notebooks.notes.titlePlaceholder')}<TextInput aria-label={t('notebooks.notes.titlePlaceholder')} maxLength={NOTE_TITLE_MAX}
      value={title} onChange={event => setTitle(event.target.value)} /></label>
    <label>{t('notebooks.notes.contentPlaceholder')}<TextArea aria-label={t('notebooks.notes.contentPlaceholder')} rows={10}
      value={content} onChange={event => setContent(event.target.value)} /></label>
    <small>{content.length} / {NOTE_CONTENT_MAX}</small>
    <SaveFeedback status={state.status} errorCode={state.error} onRetry={() => void submit()} />
    {state.status === 'conflict' && <div className="nn-save-conflict">
      <NNBtn size="sm" variant="ghost" disabled={readingCurrent || !getCurrent || !id} onClick={() => void loadCurrent()}>{t('actionsRecovery.current')}</NNBtn>
      {current && <><details open><summary>{t('actionsRecovery.currentVersion')}</summary><strong>{current.title}</strong><pre>{current.content}</pre></details>
        <NNBtn size="sm" onClick={() => void submit(current.metadataRevision ?? 0)}>{t('actionsRecovery.keepMine')}</NNBtn></>}
    </div>}
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
      <NNBtn variant="ghost" size="sm" disabled={state.status === 'saving'} onClick={() => void close()}>{t('actions.close')}</NNBtn>
      <NNBtn variant="primary" size="sm" onClick={() => void submit()} disabled={draft.blocked || state.status === 'saving' || state.status === 'conflict' || !title.trim() || content.length > NOTE_CONTENT_MAX}>
        {t(state.status === 'saving' ? 'actionsRecovery.saving' : 'notebooks.notes.save')}
      </NNBtn>
    </div>
  </form>;
}
