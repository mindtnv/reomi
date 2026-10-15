'use client';
import { useCallback, useState } from 'react';
import { useAppNavigation } from '@/components/navigation';
import { useNN } from '@/lib/store';
import type { NotebookArtifactType } from '@reomi/shared';
import { assistantApi, ok } from '@/lib/api';
import { notebookArtifactFromApi, quizAttemptFromApi } from '@/lib/mappers';
import { useT } from '@/lib/i18n';
import type { NotebookArtifact } from '@/lib/types';
import type { buildAttemptAnswers } from '@/lib/quiz-player';
import { StudioPanel } from './studio-panel';
import { askAssistant } from '../chat/assistant-provider';
import { raiseToast } from '../toasts';
import { NNBtn } from '../ui';

export function SourceStudioPanel({ sourceId, initialArtifactId, unavailable = false, chatEnabled }: {
  sourceId?: string; initialArtifactId?: string; unavailable?: boolean; chatEnabled: boolean;
}) {
  const t = useT(), router = useAppNavigation();
  const [pages, setPages] = useState(1), [hasMore, setHasMore] = useState(false);
  const listArtifacts = useCallback(async () => {
    const items: NotebookArtifact[] = []; let offset: number | null = 0;
    for (let page = 0; page < pages && offset !== null; page++) {
      const data: { items: unknown[]; nextOffset: number | null } = sourceId ? await ok(await assistantApi.sources({ id: sourceId }).artifacts.get({ query: { offset } }))
        : await ok(await assistantApi.study.artifacts.get({ query: { offset, unavailable: unavailable ? 'true' : 'false' } }));
      items.push(...data.items.map(notebookArtifactFromApi)); offset = data.nextOffset;
    }
    if (initialArtifactId && !items.some(item => item.id === initialArtifactId)) items.unshift(notebookArtifactFromApi(await ok(await assistantApi.study.artifacts({ artifactId: initialArtifactId }).get())));
    setHasMore(offset !== null); return items;
  }, [sourceId, unavailable, pages, initialArtifactId]);
  const createArtifact = useCallback(async (_id: string, type: NotebookArtifactType, _sources?: string[], questionCount?: number) => {
    if (!sourceId) throw new Error('source_required');
    return notebookArtifactFromApi(await ok(await assistantApi.sources({ id: sourceId }).artifacts.post({ type, questionCount })));
  }, [sourceId]);
  const getArtifact = useCallback(async (_id: string, artifactId: string) => notebookArtifactFromApi(await ok(await assistantApi.study.artifacts({ artifactId }).get())), []);
  const deleteArtifact = useCallback(async (_id: string, artifactId: string) => { await ok(await assistantApi.study.artifacts({ artifactId }).delete()); }, []);
  const regenerateArtifact = useCallback(async (_id: string, artifactId: string) => notebookArtifactFromApi(await ok(await assistantApi.study.artifacts({ artifactId }).regenerate.post())), []);
  const submitQuizAttempt = useCallback(async (_id: string, artifactId: string, answers: ReturnType<typeof buildAttemptAnswers>) =>
    quizAttemptFromApi(await ok(await assistantApi.study.artifacts({ artifactId }).attempts.post({ answers }))), []);
  const listQuizAttempts = useCallback(async (_id: string, artifactId: string) =>
    (await ok(await assistantApi.study.artifacts({ artifactId }).attempts.get())).items.map(quizAttemptFromApi), []);
  const openCitation = useCallback(async (chunkId: string, sourceIds: string[]) => {
    if (!sourceIds[0]) { raiseToast({ kind: 'info', titleKey: 'assistant.sourceUnavailable' }); return; }
    const ownerId = useNN.getState().profile?.userId, location = window.location.href;
    try {
      const resolved = await ok(await assistantApi.chat.context.resolve.post({ refs: [{ kind: 'source_passage', id: sourceIds[0], locator: { chunkId } }] }));
      const href = resolved.items[0]?.href; if (href && useNN.getState().profile?.userId === ownerId && window.location.href === location) router.push(href);
    } catch { raiseToast({ kind: 'info', titleKey: 'assistant.sourceUnavailable' }); }
  }, [router]);
  const saveToNote = useCallback(async (title: string, content: string, artifact?: NotebookArtifact) => {
    const id = artifact?.sourceId ?? sourceId;
    if (!id) { raiseToast({ kind: 'info', titleKey: 'assistant.sourceUnavailable' }); return; }
    try {
      await ok(await assistantApi.sources({ id }).notes.post({ title, content }));
      window.dispatchEvent(new Event('nn:knowledge-changed'));
      raiseToast({ kind: 'success', titleKey: 'assistant.savedAnswer' });
    } catch { raiseToast({ kind: 'error', titleKey: 'assistant.contextFailed' }); }
  }, [sourceId]);
  return <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
    <StudioPanel studyScope={sourceId ? { kind: 'source', id: sourceId } : { kind: 'saved' }} allowGenerate={Boolean(sourceId)}
      initialArtifactId={initialArtifactId} scopeIds={sourceId ? [sourceId] : []} chatEnabled={chatEnabled}
      listArtifacts={listArtifacts} createArtifact={createArtifact} getArtifact={getArtifact} deleteArtifact={deleteArtifact} regenerateArtifact={regenerateArtifact}
      submitQuizAttempt={submitQuizAttempt} listQuizAttempts={listQuizAttempts} onOpenCitation={(chunk, ids) => void openCitation(chunk, ids)} onSaveToNote={saveToNote}
      onPrefillChat={(prefill, artifactId) => { if (artifactId) askAssistant({ ref: { kind: 'artifact', id: artifactId }, prefill });
        else if (sourceId) askAssistant({ ref: { kind: 'source', id: sourceId }, prefill }); }} t={t} />
    {hasMore && <NNBtn size="sm" onClick={() => setPages(value => value + 1)}>{t('assistant.more')}</NNBtn>}
  </div>;
}
