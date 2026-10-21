'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { SourceTextSelection } from '@reomi/shared';
import { apiBaseURL } from '@/lib/api';
import { useLocale, useT } from '@/lib/i18n';
import { useNN } from '@/lib/store';
import { useAppNavigation } from './navigation';
import { Button } from './design-system/primitives';
import { QuickCardDialog } from './pdf-reader/quick-card';

type Handoff = { sourceId: string; sourceVersion: string; quote: string; mode: 'page' | 'selection'; textSelection: SourceTextSelection };
type Props = { sourceId: string; sourceName: string; chatEnabled: boolean; onCreated: () => void };
export function BrowserCaptureHandoff(props: Props) {
  const receiptId = useSearchParams().get('capture'), owner = useNN(s => s.profile?.userId);
  return receiptId && owner ? <CaptureDraft key={`${owner}:${receiptId}`} {...props} receiptId={receiptId} owner={owner} /> : null;
}
function CaptureDraft({ sourceId, sourceName, chatEnabled, onCreated, receiptId, owner }: Props & { receiptId: string; owner: string }) {
  const t = useT(), { locale } = useLocale(), router = useAppNavigation();
  const [data, setData] = useState<Handoff | null>(null), [error, setError] = useState(false), [revision, setRevision] = useState(0), [closed, setClosed] = useState(false);
  const close = useCallback(() => {
    setClosed(true); setData(null);
    const url = new URL(window.location.href); url.searchParams.delete('capture');
    router.replace(`${url.pathname}${url.search}${url.hash}`);
  }, [router]);
  useEffect(() => {
    const controller = new AbortController(); setError(false); setData(null);
    const current = () => !controller.signal.aborted && useNN.getState().profile?.userId === owner;
    void fetch(`${apiBaseURL}/library/captures/${encodeURIComponent(receiptId)}`, { credentials: 'include', cache: 'no-store', signal: controller.signal })
      .then(async response => { if (!response.ok) throw new Error('unavailable'); return response.json() as Promise<Handoff>; })
      .then(result => { if (result.sourceId !== sourceId) throw new Error('unavailable'); if (current()) setData(result); })
      .catch(() => { if (current()) setError(true); });
    return () => controller.abort();
  }, [receiptId, sourceId, owner, revision]);
  if (closed) return null;
  if (error) return <div role="alert" className="reomi-capture-notice"><span>{t('library.capture.unavailable')}</span><Button size="sm" variant="soft" onClick={() => setRevision(v => v + 1)}>{t('library.folders.retry')}</Button><Button size="sm" variant="ghost" onClick={close}>{t('actions.close')}</Button></div>;
  if (!data) return <div role="status" className="reomi-capture-notice">{t('library.capture.loading')}</div>;
  return <QuickCardDialog open onClose={close} sourceId={sourceId} sourceName={sourceName} sourceVersion={data.sourceVersion}
    quote={data.quote} textSelection={data.textSelection} locale={locale} chatEnabled={chatEnabled} t={t}
    contextHint={t(data.mode === 'page' ? 'library.capture.pageHint' : 'library.capture.selectionHint')}
    onCreated={onCreated} />;
}
