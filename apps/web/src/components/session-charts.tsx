'use client';

/* eslint-disable react/forbid-elements -- TODO: replace raw input, select, and button with TextInput, Button, or NNSelect. */
import { useMemo, useState } from 'react';
import { useLocale, useT } from '@/lib/i18n';
import { answerDurationGroups, type SessionAnswerSample } from '@/lib/session-charts';
import type { Rating } from '@/lib/types';

const ratings = [
  { id: 1 as const, name: 'again', color: 'var(--rose-400)' },
  { id: 2 as const, name: 'hard', color: 'var(--amber-400)' },
  { id: 3 as const, name: 'good', color: 'var(--lime-400)' },
  { id: 4 as const, name: 'easy', color: 'var(--sky-400)' },
];
export function SessionCharts({ grades, answers = [] }: { grades: Record<Rating, number>; answers?: SessionAnswerSample[] }) {
  const t = useT();
  const { locale } = useLocale();
  const total = ratings.reduce((sum, item) => sum + grades[item.id], 0);
  const groups = useMemo(() => answerDurationGroups(answers), [answers]);
  const [active, setActive] = useState(0);
  const selected = groups[Math.min(active, groups.length - 1)];
  const maxMs = Math.max(1000, ...groups.map(item => item.meanMs));
  const meanMs = answers.length ? groups.reduce((sum, item) => sum + item.totalMs, 0) / answers.length : 0;
  const seconds = (ms: number) => (ms / 1000).toLocaleString(locale, { maximumFractionDigits: 1 });
  const label = (item: (typeof groups)[number]) => t(item.count === 1 ? 'session.charts.answerTime' : 'session.charts.groupTime', { first: item.first, last: item.last, seconds: seconds(item.meanMs) });
  let offset = 0;
  return <div className="reomi-session-charts" data-timing={groups.length > 0 || undefined}>
    <section className="reomi-session-chart"><h2>{t('session.charts.distribution')}</h2>
      <div className="reomi-session-distribution">
        <svg viewBox="0 0 140 140" role="img" aria-label={`${t('session.charts.distribution')}: ${ratings.map(item => `${t(`review.ratings.${item.name}`)} ${grades[item.id]}`).join(', ')}`}>
          <circle cx="70" cy="70" r="52" fill="none" stroke="var(--surface-3)" strokeWidth="14" />
          {ratings.filter(item => grades[item.id] > 0).map(item => {
            const percent = grades[item.id] / Math.max(1, total) * 100;
            const start = offset; offset += percent;
            return <circle key={item.id} cx="70" cy="70" r="52" pathLength="100" fill="none" stroke={item.color} strokeWidth="14" strokeDasharray={`${percent} ${100 - percent}`} strokeDashoffset={-start} transform="rotate(-90 70 70)"><title>{t(`review.ratings.${item.name}`)}: {grades[item.id]}</title></circle>;
          })}
          <text x="70" y="70" textAnchor="middle" dominantBaseline="middle" className="reomi-donut-total">{total}</text>
          <text x="70" y="89" textAnchor="middle" className="reomi-donut-caption">{t('session.charts.total')}</text>
        </svg>
        <div className="reomi-session-chart-legend">{ratings.map(item => <div key={item.id}><i aria-hidden style={{ background: item.color }} /><span>{t(`review.ratings.${item.name}`)}</span><strong>{grades[item.id]}</strong><small>{total ? Math.round(grades[item.id] / total * 100) : 0}%</small></div>)}</div>
      </div>
    </section>
    {groups.length > 0 && <section className="reomi-session-chart"><h2>{t('session.charts.timing')}</h2>
      <p className="reomi-session-chart-subtitle">{t('session.charts.average', { seconds: seconds(meanMs) })}</p>
      <div className="reomi-duration-plot"><div className="reomi-duration-axis" aria-hidden><span>{seconds(maxMs)} {t('session.charts.seconds')}</span><span>0</span></div>
        <div className="reomi-duration-bars" aria-label={t('session.charts.order')}>
          {groups.map((item, index) => <button key={item.first} type="button" aria-label={label(item)} title={label(item)} tabIndex={index === Math.min(active, groups.length - 1) ? 0 : -1}
            data-active={selected === item || undefined} onPointerEnter={() => setActive(index)} onFocus={() => setActive(index)} onClick={() => setActive(index)}
            onKeyDown={event => {
              const next = event.key === 'ArrowRight' ? Math.min(groups.length - 1, index + 1) : event.key === 'ArrowLeft' ? Math.max(0, index - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? groups.length - 1 : null;
              if (next === null) return;
              event.preventDefault(); setActive(next);
              (event.currentTarget.parentElement?.children[next] as HTMLButtonElement | undefined)?.focus();
            }}><span style={{ height: `${item.meanMs / maxMs * 100}%` }} /></button>)}
        </div>
      </div>
      <div className="reomi-duration-range" aria-hidden style={{ paddingInline: groups.length > 1 ? `calc((100% - 46px) / ${2 * groups.length})` : 0, justifyContent: groups.length === 1 ? 'center' : 'space-between' }}><span>1</span>{groups.length > 1 && <span>{answers.length}</span>}</div>
      <p className="reomi-duration-detail">{selected && label(selected)}</p>
      <small className="reomi-session-chart-footnote">{t(groups.some(item => item.count > 1) ? 'session.charts.grouped' : 'session.charts.order')}</small>
    </section>}
  </div>;
}
