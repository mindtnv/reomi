'use client';

import { useCallback, useEffect, useState } from 'react';
import { parseNotebookPlan, type NotebookPlan } from '@reomi/shared';
import { Button } from '@/components/design-system/primitives';
import { useOperations } from '@/components/operations-provider';
import { followOperationRefresh } from '@/lib/operation-observer';
import { useT } from '@/lib/i18n';
import { useNN } from '@/lib/store';

type ReadState =
  | { load: 'pending' | 'absent' | 'error'; plan: null }
  | { load: 'present'; plan: NotebookPlan };

export type PlanRead = ReadState & { retry: () => void };

export function useNotebookPlan(notebookId: string): PlanRead {
  const getNotebookPlan = useNN((s) => s.getNotebookPlan);
  const operations = useOperations();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ReadState>({ load: 'pending', plan: null });
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    setState({ load: 'pending', plan: null });
    void (async () => {
      try {
        const body = await getNotebookPlan(notebookId);
        if (cancelled) return;
        if (body == null) {
          setState({ load: 'absent', plan: null });
          return;
        }
        setState({ load: 'present', plan: parseNotebookPlan(body) });
      } catch {
        if (!cancelled) setState({ load: 'error', plan: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [notebookId, attempt, getNotebookPlan]);

  const ingesting = state.load === 'present' && state.plan.plan.modules.some((module) => module.status === 'ingesting');
  useEffect(() => {
    if (!ingesting) return;
    let cancelled = false;
    const refresh = async (current: () => boolean) => {
      try {
        const body = await getNotebookPlan(notebookId);
        if (!current() || body == null) return;
        setState({ load: 'present', plan: parseNotebookPlan(body) });
      } catch {
        // A failed refresh leaves the plan already on screen.
      }
    };
    if (operations) return followOperationRefresh(operations.observer, refresh);
    const timer = setInterval(() => void refresh(() => !cancelled), 2000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [ingesting, notebookId, getNotebookPlan, operations]);

  return { ...state, retry };
}

export function PlanPanel({
  plan,
  onOpenSource,
}: {
  plan: NotebookPlan;
  onOpenSource: (sourceId: string) => void;
}) {
  const t = useT();
  return (
    <div className="reomi-notebook-plan nn-scroll" style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '12px 12px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p style={{ margin: 0, color: 'var(--text)', fontSize: 14 }}>{plan.plan.goal}</p>
      {plan.plan.level ? <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: 12.5 }}>{plan.plan.level}</p> : null}
      {plan.plan.modules.map((module) => (
        <section key={module.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{module.title}</h3>
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 12.5 }}>{module.outcome}</p>
          <p style={{ margin: 0, color: 'var(--text-dim)', fontSize: 12 }}>{t(`notebooks.plan.${module.status}`)}</p>
          {module.sources.map((source) => (
            <div key={source.sourceId} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ color: 'var(--text)', fontSize: 13 }}>{source.title}</span>
              {source.openable ? (
                <Button type="button" size="sm" variant="soft" onClick={() => onOpenSource(source.sourceId)}>
                  {t('notebooks.plan.open')}
                </Button>
              ) : null}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
