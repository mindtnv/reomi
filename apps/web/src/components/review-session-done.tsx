'use client';
import { AppLink } from './navigation';
import { NNBtn, NNIcon } from './ui';
import { SessionCharts } from './session-charts';
import type { SessionAnswerSample } from '@/lib/session-charts';
import { useT } from '@/lib/i18n';
import { recallSuccessPercent } from '@reomi/shared';

export const ReviewSessionDone = ({ completed, xp, stats, onUndo, busy }: { completed: number; xp: number; stats?: { cards: number; durationMs: number; grades: Record<1 | 2 | 3 | 4, number>; answers?: SessionAnswerSample[] }; onUndo?: () => void; busy?: boolean }) => {
  const t = useT();
  const seconds = Math.floor((stats?.durationMs ?? 0) / 1000);
  const duration = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  const recall = stats ? recallSuccessPercent(stats.grades) : null;
  const metrics = [
    { label: t('session.kpi.answers'), value: completed, hint: '' },
    ...(stats ? [
      { label: t('session.kpi.cardsReviewed'), value: stats.cards, hint: '' },
      { label: t('session.kpi.duration'), value: duration, hint: '' },
      { label: t('session.kpi.retention'), value: recall != null ? `${recall}%` : '—', hint: t('session.kpi.retentionSub') },
    ] : []),
    { label: t('session.kpi.xpEarned'), value: `+${xp}`, hint: '' },
  ];

  return <section className="reomi-page-surface reomi-session-done">
    <div className="reomi-session-done-content">
      <span className="reomi-session-done-icon" aria-hidden><NNIcon name="check" size={28} /></span>
      <h1>{t('review.sessionComplete.title')}</h1>
      <div className="reomi-session-metrics">
        {metrics.map(item => <div key={item.label}><strong>{item.value}</strong><span>{item.hint ? `${item.label} · ${item.hint}` : item.label}</span></div>)}
      </div>
      {stats && <><SessionCharts grades={stats.grades} answers={stats.answers} /><p className="reomi-session-saved">{t('session.scheduleSaved')}</p></>}
      <div className="reomi-session-done-actions">
        <AppLink href="/decks"><NNBtn size="lg" variant="soft" icon="decks">{t('nav.decks')}</NNBtn></AppLink>
        <AppLink href="/"><NNBtn size="lg" variant="primary">{t('review.sessionComplete.backHome')}</NNBtn></AppLink>
      </div>
      {onUndo && <NNBtn variant="ghost" size="sm" icon="sync" onClick={onUndo} loading={busy}>{t('editor.review.undo.button')}</NNBtn>}
    </div>
  </section>;
};
