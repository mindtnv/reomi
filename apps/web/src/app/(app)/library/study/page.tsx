'use client';

/* eslint-disable react/forbid-elements -- TODO: replace raw input, select, and button with TextInput, Button, or NNSelect. */
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { NNAppPage } from '@/components/app-page';
import { SourceStudioPanel } from '@/components/notebook/source-studio-panel';
import { NNBtn } from '@/components/ui';
import { useAssistant } from '@/components/chat/assistant-provider';
import { StudyDraftRecovery } from '@/components/notebook/study-draft-recovery';
import { SourceNotesPanel } from '@/components/notebook/source-notes-panel';
import { AppLink } from '@/components/navigation';
import { RouteContentFallback } from '@/components/route-fallbacks';
import { useT } from '@/lib/i18n';
function SavedStudy() {
  const t = useT(), query = useSearchParams();
  const [unavailable, setUnavailable] = useState(false);
  const draftSlot = query.get('draft');
  const noteId = query.get('note') ?? undefined, artifactId = query.get('artifact') ?? undefined;
  const [tab, setTab] = useState<'notes' | 'artifacts'>(artifactId ? 'artifacts' : 'notes');
  const { status } = useAssistant();
  useEffect(() => { if (artifactId) setTab('artifacts'); else if (noteId) setTab('notes'); }, [artifactId, noteId]);
  if (draftSlot) return <NNAppPage title={t('editor.draft.libraryTitle')}><StudyDraftRecovery slot={draftSlot} /></NNAppPage>;
  return <NNAppPage title={t('assistant.savedStudy')}>
    <div style={{ display: 'flex', gap: 16, padding: 12 }}><AppLink href="/library">{t('nav.library')}</AppLink>
      <label><input type="checkbox" checked={unavailable} onChange={event => setUnavailable(event.target.checked)} /> {t('assistant.sourceUnavailable')}</label></div>
    <div style={{ display: 'flex', gap: 8, padding: 8 }}>
      <NNBtn active={tab === 'notes'} onClick={() => setTab('notes')}>{t('notebooks.notes.heading')}</NNBtn>
      <NNBtn active={tab === 'artifacts'} onClick={() => setTab('artifacts')}>{t('notebooks.studio.listHeading')}</NNBtn>
    </div>
    <div style={{ minHeight: 0, flex: 1 }}>
      {tab === 'notes' ? <SourceNotesPanel key={`${noteId ?? ''}:${unavailable}`} initialNoteId={noteId} unavailable={unavailable} />
        : <SourceStudioPanel key={`${artifactId ?? ''}:${unavailable}`} initialArtifactId={artifactId} unavailable={unavailable} chatEnabled={Boolean(status?.chatEnabled)} />}
    </div>
  </NNAppPage>;
}
export default function Page() { return <Suspense fallback={<RouteContentFallback />}><SavedStudy /></Suspense>; }
