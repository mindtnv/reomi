'use client';

import React, { useCallback, useMemo } from 'react';
import { AppLink } from '@/components/navigation';
import { format } from 'date-fns';
import { PageSurface } from '@/components/design-system/primitives';
import { NNCard, NNIcon, NNInlineRefresh, NNLoadError, NNSkeleton } from '@/components/ui';
import { useNN } from '@/lib/store';
import { api, ok } from '@/lib/api';
import { useBreakpoint } from '@/lib/use-breakpoint';
import { useT } from '@/lib/i18n';
import { useSessionResource } from '@/lib/session-resource';
import { retentionStroke, retentionY, type RetentionPoint } from '@/lib/retention-chart';

// Server payloads of the /stats endpoints (see apps/api/src/modules/stats.ts).
// Forecast buckets are SPARSE (only non-empty days) — the chart zero-fills.
interface ForecastData {
  days: number;
  overdueCount: number;
  total: number;
  buckets: { day: string; count: number }[];
}
interface IntervalRetentionData {
  days: number;
  buckets: { bucket: string; count: number; retentionPct: number | null }[];
}
interface LearningSeriesPoint {
  day: string;
  answerCount: number;
  answerSuccessCount: number;
  answerSuccessPct: number | null;
  trueRetentionCount: number;
  trueRetentionSuccessCount: number;
  trueRetentionPct: number | null;
  averageGrade: number | null;
  durationMs: number;
}
interface LearningOverview {
  days: number;
  answerCount: number;
  answerSuccessCount: number;
  answerSuccessPct: number | null;
  trueRetentionCount: number;
  trueRetentionSuccessCount: number;
  trueRetentionPct: number | null;
  averageGrade: number | null;
  grades: { again: number; hard: number; good: number; easy: number };
  series: LearningSeriesPoint[];
  hours: { count: number; success: number }[];
  target: { status: 'uniform' | 'mixed'; retentionPct: number | null };
}
interface DeckLearningRow {
  id: string;
  name: string;
  color: string;
  ownCards: number;
  subtreeCards: number;
  ownAnswerSuccessPct: number | null;
  ownMinutes: number;
  targetRetentionPct: number;
}
interface StatsData {
  overview: LearningOverview;
  decks: DeckLearningRow[];
  forecast: ForecastData;
  intervalRetention: IntervalRetentionData;
}

function utcDayLabel(day: string): string {
  const [year, month, date] = day.split('-').map(Number);
  return format(new Date(year!, (month ?? 1) - 1, date ?? 1), 'MMM d');
}

const FORECAST_DAYS = 30;
/** Hide interval buckets with fewer data points than this (too noisy to plot). */
const MIN_BUCKET_N = 5;

// ─────────────────────────────────────────────
// STATS / ANALYTICS
// ─────────────────────────────────────────────
export const NNStats = () => {
  const t = useT();
  const bp = useBreakpoint();
  const isMobile = bp === 'mobile';
  const isDesktop = bp === 'desktop';
  const bootstrapped = useNN((s) => s.bootstrapped);
  const profile = useNN((s) => s.profile);

  const fetchStats = useCallback(async (): Promise<StatsData> => {
    const [overviewRaw, decksRaw, forecastRaw, retentionRaw] = await Promise.all([
      ok(await (api as any).stats.overview.get({ query: { days: '30' } })),
      ok(await (api as any).stats.decks.get({ query: { days: '30' } })),
      ok(await (api as any).stats.forecast.get({ query: { days: String(FORECAST_DAYS) } })),
      ok(await (api as any).stats.retention.get({ query: {} })),
    ]);
    return {
      overview: overviewRaw as LearningOverview,
      decks: ((decksRaw as { decks: DeckLearningRow[] }).decks ?? []),
      forecast: forecastRaw as ForecastData,
      intervalRetention: retentionRaw as IntervalRetentionData,
    };
  }, []);
  const statsResource = useSessionResource({
    key: 'stats:overview',
    enabled: bootstrapped,
    fetcher: fetchStats,
    keepPreviousData: true,
  });
  const overview = statsResource.data?.overview ?? null;
  const deckRows = statsResource.data?.decks ?? [];
  const forecast = statsResource.data?.forecast ?? null;
  const intervalRetention = statsResource.data?.intervalRetention ?? null;

  const line = (vals: (number | null)[] | null, w = 100, h = 30, color = 'var(--lime-400)') => {
    if (!vals || vals.every((value) => value == null)) return null;
    const present = vals.filter((value): value is number => value != null);
    const max = Math.max(...present);
    const min = Math.min(...present);
    let path = '';
    let penDown = false;
    vals.forEach((value, index) => {
      if (value == null) {
        penDown = false;
        return;
      }
      const x = (index / Math.max(1, vals.length - 1)) * w;
      const y = h - ((value - min) / (max - min || 1)) * h;
      path += `${penDown ? 'L' : 'M'} ${x.toFixed(1)} ${y.toFixed(1)} `;
      penDown = true;
    });
    return (
      <svg width={w} height={h}>
        <path d={path.trim()} fill="none" stroke={color} strokeWidth="1.5" />
      </svg>
    );
  };

  const reviewedCount30 = overview?.answerCount ?? 0;
  const retentionPct = overview?.trueRetentionPct ?? null;
  const avgGrade = overview?.averageGrade ?? null;
  const minutesThisWeek = useMemo(() => {
    const ms = (overview?.series ?? []).slice(-7).reduce((sum, point) => sum + point.durationMs, 0);
    return Math.floor(ms / 60000);
  }, [overview]);

  const weekTimeLabel = useMemo(() => {
    const h = Math.floor(minutesThisWeek / 60);
    const m = minutesThisWeek % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }, [minutesThisWeek]);

  const avgDaily = Math.round(minutesThisWeek / 7);

  // Per-day buckets for last 30 days.
  const series = overview?.series ?? [];

  const retentionCurve = useMemo(() => {
    const width = 600;
    if (series.length === 0) return { path: '', fillLabels: [] as string[] };
    const points: RetentionPoint[] = series.map((point, index) => ({
      x: (index / Math.max(1, series.length - 1)) * width,
      y: retentionY(point.trueRetentionPct == null ? 0 : point.trueRetentionPct / 100),
      missing: point.trueRetentionPct == null,
    }));
    const labelIdxs = [0, 7, 14, 21, series.length - 1];
    return {
      path: retentionStroke(points),
      fillLabels: labelIdxs.filter((index, position, all) => index >= 0 && index < series.length && all.indexOf(index) === position).map((index) => utcDayLabel(series[index]!.day)),
    };
  }, [series]);

  const gradeDist = useMemo(() => {
    const grades = overview?.grades ?? { again: 0, hard: 0, good: 0, easy: 0 };
    const total = overview?.answerCount ?? 0;
    return [
      { l: t('stats.grades.again'), n: grades.again, total, c: 'rose' as const },
      { l: t('stats.grades.hard'), n: grades.hard, total, c: 'amber' as const },
      { l: t('stats.grades.good'), n: grades.good, total, c: 'lime' as const },
      { l: t('stats.grades.easy'), n: grades.easy, total, c: 'sky' as const },
    ];
  }, [overview, t]);

  const hourBuckets = useMemo(() => {
    const counts = (overview?.hours ?? Array.from({ length: 24 }, () => ({ count: 0, success: 0 }))).map((hour) => hour.count);
    return { counts, max: Math.max(1, ...counts) };
  }, [overview]);

  const peakHour = useMemo(() => {
    const counts = hourBuckets.counts;
    if (!counts.some((value) => value > 0)) return null;
    const index = counts.indexOf(Math.max(...counts));
    const fmt = (hour: number) => `${((hour + 11) % 12) + 1}${hour < 12 ? 'am' : 'pm'}`;
    return { label: `${fmt(index)}–${fmt((index + 2) % 24)}`, index };
  }, [hourBuckets]);

  const peakRetention = useMemo(() => {
    if (!peakHour || !overview) return null;
    const hour = overview.hours[peakHour.index];
    if (!hour || hour.count === 0) return null;
    return Math.round((hour.success / hour.count) * 100);
  }, [peakHour, overview]);

  // Due-forecast bars: zero-fill the full window. Server buckets are UTC dates.
  const forecastBars = useMemo(() => {
    if (!forecast) return [];
    const byDay = new Map(forecast.buckets.map((b) => [b.day, b.count]));
    const out: { day: string; count: number }[] = [];
    const startMs = Date.now();
    for (let i = 0; i < forecast.days; i++) {
      const day = new Date(startMs + i * 86400000).toISOString().slice(0, 10);
      out.push({ day, count: byDay.get(day) ?? 0 });
    }
    return out;
  }, [forecast]);
  const forecastMax = useMemo(
    () => Math.max(1, ...forecastBars.map((b) => b.count)),
    [forecastBars],
  );

  // Interval-retention buckets with enough data to be meaningful.
  const retentionBars = useMemo(
    () => (intervalRetention?.buckets ?? []).filter((b) => b.count >= MIN_BUCKET_N),
    [intervalRetention],
  );

  const last7 = series.slice(-7);
  const kpis: { l: string; v: string; sub: string; c: 'lime' | 'sky' | 'amber'; trend: (number | null)[] | null }[] = [
    {
      l: t('stats.kpis.retention'),
      v: retentionPct != null ? `${retentionPct}%` : '—',
      sub: t('stats.kpis.retentionSub', {
        success: overview?.trueRetentionSuccessCount ?? 0,
        total: overview?.trueRetentionCount ?? 0,
      }),
      c: 'lime',
      trend: last7.map((point) => point.trueRetentionPct),
    },
    {
      l: t('stats.kpis.reviewed'),
      v: reviewedCount30.toLocaleString(),
      sub: t('stats.kpis.reviewedSub', { n: Math.round(reviewedCount30 / 30) }),
      c: 'lime',
      trend: last7.map((point) => point.answerCount),
    },
    {
      l: t('stats.kpis.avgGrade'),
      v: avgGrade != null ? avgGrade.toFixed(2) : '—',
      sub: avgGrade != null ? (avgGrade >= 3 ? t('stats.kpis.avgGradeGood') : t('stats.kpis.avgGradeNeeds')) : t('stats.kpis.noData'),
      c: 'sky',
      trend: last7.map((point) => point.averageGrade),
    },
    {
      l: t('stats.kpis.totalXp'),
      v: (profile?.xp ?? 0).toLocaleString(),
      sub: t('stats.kpis.levelLabel', { n: profile?.level ?? 1 }),
      c: 'amber',
      trend: null,
    },
  ];

  if (!bootstrapped || (!statsResource.data && statsResource.status !== 'error')) {
    return <StatsSkeleton isMobile={isMobile} />;
  }

  if (!statsResource.data) {
    return (
      <div style={{ flex: 1, display: 'grid', placeItems: 'center', padding: 24 }}>
        <div style={{ width: 'min(520px, 100%)' }}>
          <NNLoadError
            title={t('toasts.error')}
            description={statsResource.error?.safeMessage}
            retryLabel={t('notebooks.overview.retry')}
            requestId={statsResource.error?.requestId}
            onRetry={statsResource.refresh}
          />
        </div>
      </div>
    );
  }

  return (
    <PageSurface className="reomi-stats"
      aria-busy={statsResource.status === 'refreshing'}
    >
      {statsResource.status === 'refreshing' && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
          <NNInlineRefresh label={t('states.loading')} />
        </div>
      )}
      {statsResource.status === 'error' && (
        <div style={{ marginBottom: 12 }}>
          <NNLoadError
            title={t('toasts.error')}
            description={statsResource.error?.safeMessage}
            retryLabel={t('notebooks.overview.retry')}
            requestId={statsResource.error?.requestId}
            onRetry={statsResource.refresh}
          />
        </div>
      )}
      {/* Streak strip — the gamification entry point now that the sidebar has none. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 14px',
          borderRadius: 12,
          background: 'var(--surface-2)',
          border: '1px solid transparent',
          marginBottom: isMobile ? 12 : 16,
          flexWrap: 'wrap',
        }}
      >
        <NNIcon name="flame" size={18} color="var(--amber-500)" />
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
          {t('stats.streak.days', { days: profile?.streakDays ?? 0 })}
        </span>
        {(profile?.streakFreezes ?? 0) > 0 && (
          <span style={{ fontSize: 12, color: 'var(--sky-400)' }}>🛡 × {profile?.streakFreezes}</span>
        )}
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
          {t('stats.streak.level', { n: profile?.level ?? 1 })}
        </span>
        <div style={{ flex: 1 }} />
        <AppLink
          href="/garden"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 12px',
            borderRadius: 8,
            border: '1px solid var(--border)',
            color: 'var(--text)',
            fontSize: 12,
            fontWeight: 500,
            textDecoration: 'none',
            background: 'var(--surface)',
          }}
        >
          <NNIcon name="garden" size={14} />
          {t('stats.streak.openGarden')}
        </AppLink>
      </div>

      {/* Top stats */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(4, 1fr)', gap: isMobile ? 10 : 12, marginBottom: isMobile ? 12 : 16 }}>
        {kpis.map((s) => (
          <NNCard key={s.l} padding={16}>
            <div className="nn-section-label" style={{ marginBottom: 0 }}>{s.l}</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 6 }}>
              <div style={{ fontSize: 28, fontWeight: 600, color: 'var(--text)' }} className="mono">{s.v}</div>
              <div style={{ flex: 1 }} />
              {s.trend ? line(s.trend, 80, 30, `var(--${s.c}-400)`) : null}
            </div>
            <div style={{ fontSize: 11, color: `var(--${s.c}-400)`, marginTop: 4 }}>{s.sub}</div>
          </NNCard>
        ))}
      </div>

      {/* Retention curve + distribution */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '2fr 1fr', gap: isMobile ? 10 : 12, marginBottom: isMobile ? 12 : 16 }}>
        <NNCard padding={20}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{t('stats.retentionOverTime')}</div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>
                {overview?.target.status === 'uniform' && overview.target.retentionPct != null
                  ? <>{t('stats.target')} <span className="mono" style={{ color: 'var(--lime-400)' }}>{overview.target.retentionPct}%</span></>
                  : t('stats.targetMixed')}
                {' · '}{t('stats.actual')}{' '}
                <span className="mono" style={{ color: 'var(--lime-400)' }}>
                  {retentionPct != null ? `${retentionPct}%` : '—'}
                </span>
                {overview && overview.answerCount > 0 && (
                  <>
                    {' · '}
                    {t('stats.answerSuccess', {
                      pct: overview.answerSuccessPct ?? 0,
                      success: overview.answerSuccessCount,
                      total: overview.answerCount,
                    })}
                  </>
                )}
              </div>
            </div>
            <div style={{ flex: 1 }} />
          </div>
          {/* chart */}
          <svg viewBox="0 0 600 200" style={{ width: '100%', height: 200 }}>
            {/* grid */}
            {[0, 1, 2, 3, 4].map((i) => (
              <line key={i} x1="0" y1={i * 40 + 20} x2="600" y2={i * 40 + 20} stroke="var(--border)" strokeWidth="0.5" />
            ))}
            {overview?.target.status === 'uniform' && overview.target.retentionPct != null && (
              <>
                <line
                  x1="0"
                  y1={retentionY(overview.target.retentionPct / 100)}
                  x2="600"
                  y2={retentionY(overview.target.retentionPct / 100)}
                  stroke="var(--lime-600)"
                  strokeDasharray="4 4"
                  strokeWidth="1"
                />
                <text
                  x="595"
                  y={retentionY(overview.target.retentionPct / 100) - 4}
                  fontSize="10"
                  fill="var(--lime-400)"
                  textAnchor="end"
                  fontFamily="var(--font-mono)"
                >
                  {t('stats.targetLegend', { pct: overview.target.retentionPct })}
                </text>
              </>
            )}
            {retentionCurve.path && (
              <path d={retentionCurve.path} fill="none" stroke="var(--lime-500)" strokeWidth="2.5" />
            )}
            {/* labels */}
            {retentionCurve.fillLabels.map((t, i) => (
              <text
                key={t + i}
                x={i * 150 + 10}
                y="195"
                fontSize="10"
                fill="var(--text-dim)"
                fontFamily="var(--font-mono)"
              >
                {t}
              </text>
            ))}
          </svg>
        </NNCard>

        <NNCard padding={20}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 14 }}>{t('stats.gradeDist')}</div>
          {gradeDist.map((g) => (
            <div key={g.l} style={{ marginBottom: 10 }}>
              <div style={{ display: 'flex', fontSize: 12, marginBottom: 4 }}>
                <span style={{ color: 'var(--text)', flex: 1 }}>{g.l}</span>
                <span className="mono" style={{ color: `var(--${g.c}-400)` }}>
                  {g.total ? Math.round((g.n / g.total) * 100) : 0}%
                </span>
                <span style={{ width: 48, textAlign: 'right', color: 'var(--text-dim)' }} className="mono">
                  {g.n}
                </span>
              </div>
              <div style={{ height: 5, background: 'var(--surface-3)', borderRadius: 3, overflow: 'hidden' }}>
                <div
                  style={{
                    width: `${g.total ? (g.n / g.total) * 100 : 0}%`,
                    height: '100%',
                    background: `var(--${g.c}-500)`,
                  }}
                />
              </div>
            </div>
          ))}
        </NNCard>
      </div>

      {/* Due forecast + retention by interval */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '2fr 1fr', gap: isMobile ? 10 : 12, marginBottom: isMobile ? 12 : 16 }}>
        <NNCard padding={20}>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{t('stats.forecast.title')}</div>
              <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>
                {t('stats.forecast.subtitle', { days: forecast?.days ?? FORECAST_DAYS })} ·{' '}
                <span className="mono" style={{ color: 'var(--lime-400)' }}>
                  {t('stats.forecast.total', { n: forecast?.total ?? 0 })}
                </span>
              </div>
            </div>
            <div style={{ flex: 1 }} />
            {forecast != null && forecast.overdueCount > 0 && (
              <span
                className="mono"
                style={{
                  fontSize: 11,
                  color: 'var(--rose-400)',
                  border: '1px solid var(--rose-500)',
                  borderRadius: 999,
                  padding: '3px 10px',
                }}
              >
                {t('stats.forecast.overdue', { n: forecast.overdueCount })}
              </span>
            )}
          </div>
          {forecast == null || forecast.total === 0 ? (
            <div className="nn-empty-state" style={{ paddingTop: 24, paddingBottom: 24 }}>
              <span className="nn-empty-state-icon"><NNIcon name="clock" size={24} color="var(--text-dim)" /></span>
              <p className="nn-empty-state-hint">{t('stats.forecast.empty')}</p>
            </div>
          ) : (
            <svg viewBox="0 0 600 200" style={{ width: '100%', height: 200 }}>
              {[0, 1, 2, 3].map((i) => (
                <line key={i} x1="0" y1={i * 50 + 15} x2="600" y2={i * 50 + 15} stroke="var(--border)" strokeWidth="0.5" />
              ))}
              {forecastBars.map((b, i) => {
                const slot = 600 / forecastBars.length;
                const barW = Math.max(4, slot - 4);
                const h = (b.count / forecastMax) * 150;
                return (
                  <rect
                    key={b.day}
                    x={i * slot + (slot - barW) / 2}
                    y={165 - h}
                    width={barW}
                    height={Math.max(b.count > 0 ? 2 : 0, h)}
                    rx={2}
                    fill={i === 0 ? 'var(--lime-400)' : 'var(--lime-600)'}
                  >
                    <title>{`${b.day}: ${b.count}`}</title>
                  </rect>
                );
              })}
              {forecastBars.map((b, i) =>
                i % 7 === 0 ? (
                  <text
                    key={`l-${b.day}`}
                    x={i * (600 / forecastBars.length) + 2}
                    y="195"
                    fontSize="10"
                    fill="var(--text-dim)"
                    fontFamily="var(--font-mono)"
                  >
                    {b.day.slice(5)}
                  </text>
                ) : null,
              )}
            </svg>
          )}
        </NNCard>

        <NNCard padding={20}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{t('stats.intervalRetention.title')}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)', margin: '2px 0 14px' }}>
            {t('stats.intervalRetention.subtitle')}
          </div>
          {retentionBars.length === 0 ? (
            <div className="nn-empty-state" style={{ paddingTop: 16, paddingBottom: 16 }}>
              <span className="nn-empty-state-icon"><NNIcon name="target" size={24} color="var(--text-dim)" /></span>
              <p className="nn-empty-state-hint">{t('stats.intervalRetention.notEnough')}</p>
            </div>
          ) : (
            retentionBars.map((b) => {
              const pct = b.retentionPct ?? 0;
              const color = pct > 80 ? 'lime' : pct > 50 ? 'amber' : 'rose';
              return (
                <div key={b.bucket} style={{ marginBottom: 10 }}>
                  <div style={{ display: 'flex', fontSize: 12, marginBottom: 4 }}>
                    <span className="mono" style={{ color: 'var(--text)', flex: 1 }}>{b.bucket}</span>
                    <span className="mono" style={{ color: `var(--${color}-400)` }}>{pct}%</span>
                    <span style={{ width: 52, textAlign: 'right', color: 'var(--text-dim)' }} className="mono">
                      {t('stats.intervalRetention.bucketCount', { n: b.count })}
                    </span>
                  </div>
                  <div style={{ height: 5, background: 'var(--surface-3)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: `var(--${color}-500)` }} />
                  </div>
                </div>
              );
            })
          )}
        </NNCard>
      </div>

      {/* Per-deck breakdown */}
      <NNCard padding={0}>
        <div style={{ padding: '14px 20px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center' }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{t('stats.perDeck')}</div>
        </div>
        <div>
          {deckRows.length === 0 ? (
            <div className="nn-empty-state" style={{ paddingTop: 24, paddingBottom: 24 }}>
              <span className="nn-empty-state-icon"><NNIcon name="stack" size={24} color="var(--text-dim)" /></span>
              <p className="nn-empty-state-hint">{t('stats.noDecks')}</p>
            </div>
          ) : (
            deckRows.map((d, i) => {
              const recall = d.ownAnswerSuccessPct;
              const tone = recall == null ? 'var(--text-dim)' : recall > 80 ? 'var(--lime-400)' : recall > 50 ? 'var(--amber-400)' : 'var(--rose-400)';
              return (
              <div
                key={d.id}
                style={{
                  padding: isMobile ? '12px 14px' : '12px 20px',
                  display: 'grid',
                  gridTemplateColumns: isMobile ? '1fr' : '1fr 90px 110px 140px 70px 60px',
                  gap: isMobile ? 8 : 16,
                  alignItems: 'center',
                  borderTop: i ? '1px solid var(--border)' : 'none',
                  fontSize: 12.5,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 6, height: 24, borderRadius: 2, background: `var(--${d.color}-500)` }} />
                  <span style={{ color: 'var(--text)', fontWeight: 500 }}>{d.name}</span>
                </div>
                <span className="mono" style={{ color: 'var(--text-muted)', textAlign: 'right' }}>{t('stats.ownCards', { n: d.ownCards })}</span>
                <span className="mono" style={{ color: 'var(--text-muted)', textAlign: 'right' }}>{t('stats.subtreeCards', { n: d.subtreeCards })}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, height: 5, background: 'var(--surface-3)', borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ width: `${recall ?? 0}%`, height: '100%', background: recall == null ? 'transparent' : tone }} />
                  </div>
                  <span className="mono" style={{ fontSize: 11, color: tone, width: 36, textAlign: 'right' }}>
                    {recall == null ? '—' : `${recall}%`}
                  </span>
                </div>
                <span className="mono" style={{ color: 'var(--text-muted)', textAlign: 'right' }}>{d.ownMinutes}m</span>
                <span className="mono" style={{ color: 'var(--text-muted)', textAlign: 'right' }}>{d.targetRetentionPct}%</span>
              </div>
              );
            })
          )}
        </div>
      </NNCard>

      {/* Hour heatmap */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: isMobile ? 10 : 12, marginTop: isMobile ? 12 : 16 }}>
        <NNCard padding={20}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{t('stats.bestTime')}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginBottom: 14 }}>{t('stats.bestTimeSub')}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(24, 1fr)', gap: 2 }}>
            {hourBuckets.counts.map((v, h) => {
              const intensity = v / hourBuckets.max;
              return (
                <div
                  key={h}
                  style={{
                    height: 32,
                    background: `color-mix(in srgb, var(--lime-400) ${Math.round((0.1 + intensity * 0.7) * 100)}%, transparent)`,
                    borderRadius: 2,
                  }}
                />
              );
            })}
          </div>
          <div
            style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 10, color: 'var(--text-dim)' }}
            className="mono"
          >
            <span>0h</span>
            <span>6h</span>
            <span>12h</span>
            <span>18h</span>
            <span>24h</span>
          </div>
          <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)' }}>
            {t('stats.peak')}{' '}
            <span style={{ color: 'var(--lime-400)' }} className="mono">
              {peakHour?.label ?? '—'}
            </span>{' '}
            · {t('stats.retentionInline')}{' '}
            <span className="mono" style={{ color: 'var(--text)' }}>
              {peakRetention != null ? `${peakRetention}%` : '—'}
            </span>
          </div>
        </NNCard>
      </div>

      {minutesThisWeek > 0 && (
        <div style={{ marginTop: 12, fontSize: 11, color: 'var(--text-dim)' }} className="mono">
          {t('stats.weekLine', { time: weekTimeLabel, avg: avgDaily })}
        </div>
      )}
    </PageSurface>
  );
};

// Layout-matching skeleton shown until the store is bootstrapped — replaces the
// old opacity dimmer (P2.4), mirroring the home.tsx pattern.
function StatsSkeleton({ isMobile }: { isMobile: boolean }) {
  const panel = (children: React.ReactNode): React.ReactNode => (
    <NNCard padding={20}>{children}</NNCard>
  );
  return (
    <PageSurface className="reomi-stats" aria-busy="true">
      {/* streak strip */}
      <NNSkeleton width="100%" height={44} radius={12} style={{ marginBottom: isMobile ? 12 : 16 }} />
      {/* KPI grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : 'repeat(4, 1fr)',
          gap: isMobile ? 10 : 12,
          marginBottom: isMobile ? 12 : 16,
        }}
      >
        {Array.from({ length: 4 }).map((_, i) => (
          <NNCard key={i} padding={16}>
            <NNSkeleton width={80} height={10} />
            <NNSkeleton width={100} height={28} style={{ marginTop: 8 }} />
            <NNSkeleton width={60} height={10} style={{ marginTop: 8 }} />
          </NNCard>
        ))}
      </div>
      {/* two 2fr/1fr panel rows */}
      {Array.from({ length: 2 }).map((_, row) => (
        <div
          key={row}
          style={{
            display: 'grid',
            gridTemplateColumns: isMobile ? '1fr' : '2fr 1fr',
            gap: isMobile ? 10 : 12,
            marginBottom: isMobile ? 12 : 16,
          }}
        >
          {panel(
            <>
              <NNSkeleton width={160} height={14} />
              <NNSkeleton width="100%" height={200} radius={10} style={{ marginTop: 16 }} />
            </>,
          )}
          {panel(
            <>
              <NNSkeleton width={120} height={14} />
              {Array.from({ length: 4 }).map((_, i) => (
                <NNSkeleton key={i} width="100%" height={12} style={{ marginTop: 14 }} />
              ))}
            </>,
          )}
        </div>
      ))}
      {/* full-width card */}
      {panel(
        <>
          <NNSkeleton width={140} height={14} />
          <NNSkeleton width="100%" height={120} radius={10} style={{ marginTop: 16 }} />
        </>,
      )}
    </PageSurface>
  );
}
