'use client';

import { PageSurface, Checkbox } from '@/components/design-system/primitives';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { NNAppPage } from '@/components/app-page';
import { SourceStudioPanel } from '@/components/notebook/source-studio-panel';
import { NNBtn, NNIcon } from '@/components/ui';
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
  if (draftSlot) return <NNAppPage title={t('editor.draft.libraryTitle')}><PageSurface><StudyDraftRecovery slot={draftSlot} /></PageSurface></NNAppPage>;
  return <NNAppPage title={t('assistant.savedStudy')}>
    <PageSurface className="reomi-saved-study">
      <header className="reomi-saved-study-intro">
        <AppLink href="/library" className="reomi-saved-study-back"><NNIcon name="chevl" size={15} />{t('library.saved.back')}</AppLink>
        <h1>{t('assistant.savedStudy')}</h1>
        <p>{t('library.saved.description')}</p>
      </header>
      <div className="reomi-saved-study-toolbar">
        <div className="reomi-saved-study-tabs" role="group" aria-label={t('assistant.savedStudy')}>
          <NNBtn icon="note" active={tab === 'notes'} onClick={() => setTab('notes')}>{t('notebooks.notes.heading')}</NNBtn>
          <NNBtn icon="doc" active={tab === 'artifacts'} onClick={() => setTab('artifacts')}>{t('notebooks.studio.listHeading')}</NNBtn>
        </div>
        <Checkbox checked={unavailable} onChange={setUnavailable} title={t('library.saved.unavailableHint')}>
          {t('library.saved.unavailableFilter')}
        </Checkbox>
      </div>
      <section className="reomi-saved-study-content" aria-label={t(tab === 'notes' ? 'notebooks.notes.heading' : 'notebooks.studio.listHeading')}>
        {tab === 'notes' ? <SourceNotesPanel key={`${noteId ?? ''}:${unavailable}`} initialNoteId={noteId} unavailable={unavailable} />
          : <SourceStudioPanel key={`${artifactId ?? ''}:${unavailable}`} initialArtifactId={artifactId} unavailable={unavailable} chatEnabled={Boolean(status?.chatEnabled)} />}
      </section>
    </PageSurface>
  </NNAppPage>;
}
export default function Page() { return <Suspense fallback={<RouteContentFallback />}><SavedStudy /></Suspense>; }
