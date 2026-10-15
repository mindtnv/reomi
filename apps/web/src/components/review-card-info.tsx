'use client';
import { useMemo, type ReactNode } from 'react';
import { stateLabel } from '@reomi/shared';
import { useLocale, useT } from '@/lib/i18n';
import type { Card } from '@/lib/types';

export function ReviewCardInfo({ card, deckName, actions }: { card: Card; deckName: string; actions?: ReactNode }) {
  const t = useT();
  const { locale } = useLocale();
  const formatter = useMemo(() => new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }), [locale]);
  const date = (value: Date | string | number | undefined) => value && Number.isFinite(new Date(value).getTime()) ? formatter.format(new Date(value)) : '—';
  const number = (value: number) => value.toLocaleString(locale, { maximumFractionDigits: 1 });
  const state = stateLabel(card.fsrs.state);
  const studied = card.fsrs.reps > 0;
  const rows = [
    ['deck', deckName],
    ['type', card.noteType?.name ?? card.renderKind],
    ['state', t(`cards.states.${state === 'relearning' ? 'learning' : state}`)],
    ['reviews', String(card.fsrs.reps)],
    ['lapses', String(card.fsrs.lapses)],
    ['lastReview', date(card.fsrs.last_review)],
    ['nextReview', state === 'new' ? '—' : date(card.fsrs.due)],
    ['interval', studied ? t('review.info.days', { n: number(card.fsrs.scheduled_days) }) : '—'],
    ['stability', studied ? t('review.info.days', { n: number(card.fsrs.stability) }) : '—'],
    ['difficulty', studied ? number(card.fsrs.difficulty) : '—'],
    ['created', date(card.createdAt)],
    ['updated', date(card.updatedAt)],
  ];
  return <section className="reomi-card-info"><header className="reomi-card-info-heading"><h2>{t('review.info.title')}</h2>{actions}</header><dl>
    {rows.map(([label, value]) => <div key={label}><dt>{t(`review.info.${label}`)}</dt><dd>{value}</dd></div>)}
  </dl>{card.tags.length > 0 && <div className="reomi-card-info-tags">{card.tags.map(tag => <span key={tag}>#{tag}</span>)}</div>}</section>;
}
