'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useAppNavigation } from '@/components/navigation';
import { format } from 'date-fns';
import { PageSurface } from '@/components/design-system/primitives';

import { NNBadge, NNBtn, NNCard, NNIcon, NNSkeleton } from '@/components/ui';
import { useStudyForecast, useStudyOverview } from '@/lib/use-study-overview';
import { useNN } from '@/lib/store';
import { api, ok } from '@/lib/api';
import type { LibraryItem, Notebook } from '@/lib/types';
import { sourceKindToneVar } from '@/lib/source-kind';
import { resolveMediaSrc } from '@/lib/media-url';
import { useEmptyRedirect } from '@/lib/use-empty-redirect';
import { useBreakpoint } from '@/lib/use-breakpoint';
import { useT, useDateLocale } from '@/lib/i18n';
import { civilDate } from '@/lib/study-date';

export const NNHome = () => {
  const t = useT();
  const router = useAppNavigation();
  const dateLocale = useDateLocale();
  useEmptyRedirect('first-run');
  const bp = useBreakpoint();
  const isMobile = bp === 'mobile';
  const bootstrapped = useNN((s) => s.bootstrapped);
  const profile = useNN((s) => s.profile);
  const study = useStudyOverview();
  const serverForecast = useStudyForecast(7, study.data?.overall.serverNow);
  const listLibrary = useNN((s) => s.listLibrary);
  const listNotebooks = useNN((s) => s.listNotebooks);

  const [recallPct, setRecallPct] = useState<number | null>(null);
  const [lastReviewAt, setLastReviewAt] = useState<number | null>(null);

  // ── Knowledge domains (P3.1) — lazy, post-bootstrap, graceful-hide on empty ──
  const [reading, setReading] = useState<LibraryItem[]>([]);
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [chatEnabled, setChatEnabled] = useState(false);

  useEffect(() => {
    if (!bootstrapped) return;
    let cancelled = false;
    (async () => {
      try {
        const overview = (await ok(await (api as any).stats.overview.get({ query: { days: '30' } }))) as {
          answerSuccessPct: number | null;
          lastReviewedAt: string | null;
        };
        if (cancelled) return;
        setRecallPct(overview.answerSuccessPct);
        setLastReviewAt(overview.lastReviewedAt ? new Date(overview.lastReviewedAt).getTime() : null);
      } catch {
        if (cancelled) return;
        setRecallPct(null);
        setLastReviewAt(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bootstrapped]);

  // Knowledge domains — lazy after bootstrap, in parallel. Each branch degrades
  // independently: a failed/empty fetch just leaves its section hidden. The AI
  // tile gates on /ai/status.chatEnabled (same source the chat screen reads).
  useEffect(() => {
    if (!bootstrapped) return;
    let cancelled = false;
    void (async () => {
      const [readingRes, nbRes, statusRes] = await Promise.all([
        listLibrary({ reading: 'reading', sort: 'lastRead', limit: 3 }).catch(() => null),
        listNotebooks().catch(() => null),
        (async () => {
          try {
            return (await ok(await (api as any).ai.status.get())) as { chatEnabled?: boolean };
          } catch {
            return null;
          }
        })(),
      ]);
      if (cancelled) return;
      setReading(readingRes?.items ?? []);
      setNotebooks(nbRes ?? []);
      setChatEnabled(Boolean(statusRes?.chatEnabled));
    })();
    return () => {
      cancelled = true;
    };
  }, [bootstrapped, listLibrary, listNotebooks]);

  const now = useMemo(() => new Date(study.data?.overall.serverNow ?? Date.now()), [study.data?.overall.serverNow]);

  const counts = study.data?.overall;
  const dueCount = counts?.totalAvailable ?? 0;
  const newCount = counts?.availableNew ?? 0;
  const learningCount = counts?.dueLearning ?? 0;
  const reviewCount = counts?.availableReview ?? 0;
  const estMinutes = dueCount > 0 ? Math.max(1, Math.round(dueCount * 0.25)) : 0;

  const dailyGoalMinutes = profile?.dailyGoalMinutes ?? 30;
  const studyDay = study.data?.studyDay;
  const todayMinutes = studyDay?.todayMinutes ?? 0;
  const goalPct = Math.min(100, Math.round((todayMinutes / Math.max(1, dailyGoalMinutes)) * 100));

  const forecast = useMemo(() => {
    if (!serverForecast.data) return [];
    const counts = new Map(serverForecast.data.buckets.map((bucket) => [bucket.day, bucket.count]));
    return serverForecast.data.labels.map((day) => {
      const labelDate = civilDate(day);
      const n = counts.get(day) ?? 0;
      return {
        key: day,
        day: labelDate ? format(labelDate, 'EEEE', { locale: dateLocale }) : day,
        date: labelDate ? format(labelDate, 'MMM d', { locale: dateLocale }) : day,
        n,
        clr: n > 50 ? 'amber' as const : 'lime' as const,
      };
    });
  }, [serverForecast.data, dateLocale]);

  const forecastMax = Math.max(80, ...forecast.map((b) => b.n));

  const lastSessionLabel = useMemo(() => {
    if (!lastReviewAt) return t('time.noSessions');
    const diffMs = Date.now() - lastReviewAt;
    const h = Math.floor(diffMs / 3600000);
    const m = Math.floor((diffMs % 3600000) / 60000);
    if (h >= 24) return t('home.daysAgo', { n: Math.floor(h / 24) });
    if (h >= 1) return t('home.hoursAgo', { n: h });
    if (m >= 1) return t('home.minutesAgo', { n: m });
    return t('time.justNow');
  }, [lastReviewAt, t]);

  const todayCivil = studyDay ? civilDate(studyDay.label) : null;
  const todayLabel = format(todayCivil ?? now, 'MMM d', { locale: dateLocale });
  const forecastSub = studyDay && !studyDay.legacy
    ? t('home.forecastSubZone', { zone: studyDay.zone })
    : t('home.forecastSub');

  // Flex ratios for the todo/learn/critical bar — avoid 0 widths.
  const barReview = Math.max(0, reviewCount);
  const barLearn = Math.max(0, learningCount);
  const barNew = Math.max(0, newCount);
  const barTotal = barReview + barLearn + barNew;

  // While the initial snapshot is loading we swap the whole page for a real
  // skeleton layout — shape matches the post-bootstrap grid so there's no
  // jarring reflow when data arrives.
  if (!bootstrapped) {
    return <HomeSkeleton isMobile={isMobile} />;
  }

  return (
    <PageSurface className="reomi-home">
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1.6fr 1fr', gap: isMobile ? 10 : 16, marginBottom: isMobile ? 14 : 20 }}>
        <div
          style={{
            padding: isMobile ? 16 : 24,
            borderRadius: 16,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: 0.8,
              color: 'var(--lime-400)',
              textTransform: 'uppercase',
              marginBottom: 12,
            }}
          >
            {t('home.todayBadge', { date: todayLabel })}
          </div>

          <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginBottom: 8 }}>
            <div
              style={{
                fontFamily: 'var(--font-serif)',
                fontSize: isMobile ? 40 : 72,
                lineHeight: 1,
                color: 'var(--text)',
                fontWeight: 400,
                letterSpacing: -2,
              }}
            >
              {counts ? dueCount : '—'}
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: 15 }}>{t('home.cardsDue')}</div>
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 14, marginBottom: 20, maxWidth: 420 }}>
            {counts ? <>{t('home.estPrefix')}
            <span className="mono" style={{ color: 'var(--text)' }}>{t('home.min', { n: estMinutes })}</span>
            {t('home.estMid', { review: reviewCount, learning: learningCount })}
            <span style={{ color: 'var(--amber-400)' }}>{t('home.estNew', { n: newCount })}</span>
            </> : !study.error ? t('home.countsLoading') : null}
            {study.error && <span role="alert">{t('home.countsError')} <NNBtn size="sm" variant="ghost" onClick={study.reload}>{t('review.retry')}</NNBtn></span>}
          </div>

          <div style={{ display: 'flex', gap: 2, marginBottom: 20, height: 6, borderRadius: 3, overflow: 'hidden' }}>
            {barTotal > 0 ? (
              <>
                <div style={{ flex: barReview, background: 'var(--lime-500)' }} />
                <div style={{ flex: barLearn, background: 'var(--violet-500)' }} />
                <div style={{ flex: barNew, background: 'var(--amber-500)' }} />
              </>
            ) : (
              <div style={{ flex: 1, background: 'var(--surface-3)' }} />
            )}
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: isMobile ? 'wrap' : 'nowrap' }}>
            <NNBtn size="lg" variant="primary" icon="bolt" onClick={() => router.push('/review')}>{t('home.startReview')}</NNBtn>
            <NNBtn size="lg" variant="soft" icon="plus" ariaLabel={t('home.addCard')} title={t('home.addCard')} onClick={() => router.push('/editor')} />
            <div style={{ flex: 1 }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-dim)', fontSize: 12 }}>
              <NNIcon name="clock" size={13} /> {t('home.lastSession', { label: lastSessionLabel })}
            </div>
          </div>
        </div>

        <div
          style={{
            padding: isMobile ? 16 : 20,
            borderRadius: 16,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          <div className="reomi-home-progress-heading"><span>{t('home.dailyGoal')}</span><NNBadge tone="neutral" size="sm" icon="flame">{t('home.streakDays', { days: profile?.streakDays ?? 0 })}</NNBadge></div>
          <div className="reomi-home-progress-value">{todayMinutes}<span>{t('home.minOfGoal', { n: dailyGoalMinutes })}</span></div>
          <div className="reomi-home-progress-track" role="progressbar" aria-label={t('home.dailyGoal')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={goalPct}><div style={{ width: `${goalPct}%` }} /></div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: 8,
              padding: '12px 0 4px',
              borderTop: '1px solid var(--border)',
            }}
          >
            {[
              { v: counts ? String(counts.total) : '—', l: t('home.stats.cards') },
              { v: recallPct != null ? `${recallPct}%` : '—', l: t('home.stats.recall') },
            ].map((s) => (
              <div key={s.l}>
                <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text)' }} className="mono">
                  {s.v}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 0.6 }}>
                  {s.l}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: isMobile ? 10 : 16 }}>
        <NNCard padding={0}>
          <div
            style={{
              padding: '16px 20px 12px',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div style={{ fontSize: 14, fontWeight: 600 }}>{t('home.forecast')}</div>
            <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>{forecastSub}</span>
          </div>
          <div style={{ padding: '8px 8px' }}>
            {serverForecast.error && <div role="alert" style={{ padding: 12, fontSize: 13 }}>{t('home.forecastError')} <NNBtn size="sm" variant="ghost" onClick={serverForecast.reload}>{t('review.retry')}</NNBtn></div>}
            {!serverForecast.data && !serverForecast.error && <NNSkeleton width="100%" height={200} />}
            {forecast.map((r) => (
              <div
                key={r.key}
                style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderRadius: 8 }}
              >
                <div style={{ width: 90, fontSize: 12.5, color: 'var(--text)', fontWeight: 500 }}>{r.day}</div>
                <div style={{ width: 60, fontSize: 11.5, color: 'var(--text-dim)' }} className="mono">
                  {r.date}
                </div>
                <div style={{ flex: 1, height: 6, background: 'var(--surface-3)', borderRadius: 3, overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${(r.n / forecastMax) * 100}%`,
                      height: '100%',
                      background: r.clr === 'amber' ? 'var(--amber-500)' : 'var(--lime-500)',
                    }}
                  />
                </div>
                <div
                  style={{ width: 32, textAlign: 'right', fontSize: 12.5, color: 'var(--text)', fontWeight: 500 }}
                  className="mono"
                >
                  {r.n}
                </div>
              </div>
            ))}
          </div>
        </NNCard>
      </div>

      {(reading.length > 0 || notebooks.length > 0 || chatEnabled) && (
        <HomeKnowledge
          reading={reading}
          notebooks={notebooks}
          chatEnabled={chatEnabled}
          isMobile={isMobile}
          onOpen={(href) => router.push(href)}
          t={t}
        />
      )}
    </PageSurface>
  );
};

// ── Knowledge domains block (P3.1) ───────────────────────────────────────────
// Reuses the notebooks visual language (.nn-section-label eyebrows, tone tiles,
// letter-tile covers) — no new CSS. Only renders the sub-blocks that have data.
function HomeKnowledge({
  reading,
  notebooks,
  chatEnabled,
  isMobile,
  onOpen,
  t,
}: {
  reading: LibraryItem[];
  notebooks: Notebook[];
  chatEnabled: boolean;
  isMobile: boolean;
  onOpen: (href: string) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  return (
    <div style={{ marginTop: isMobile ? 14 : 24, display: 'grid', gap: isMobile ? 14 : 20 }}>
      {reading.length > 0 && (
        <section>
          <div className="nn-section-label">{t('home.knowledge.continueReading')}</div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: isMobile ? 10 : 14,
            }}
          >
            {reading.slice(0, 3).map((item) => {
              const tone = sourceKindToneVar(item.kind);
              const letter = item.title.trim().charAt(0).toUpperCase() || '?';
              const pct = item.percent != null ? Math.round(item.percent * 100) : null;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onOpen(`/library/${item.id}`)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    padding: 14,
                    borderRadius: 14,
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: 'inherit',
                  }}
                >
                  <span
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      width: 40,
                      height: 52,
                      flexShrink: 0,
                      borderRadius: 6,
                      overflow: 'hidden',
                      background: item.coverUrl
                        ? 'var(--surface-3)'
                        : `linear-gradient(135deg, color-mix(in srgb, ${tone} 30%, var(--surface-3)), var(--surface-3))`,
                      border: '1px solid var(--border)',
                    }}
                  >
                    {item.coverUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={resolveMediaSrc(item.coverUrl)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                      <span style={{ fontFamily: 'var(--font-serif)', fontSize: 22, color: tone, lineHeight: 1 }}>
                        {letter}
                      </span>
                    )}
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        display: 'block',
                        fontSize: 13.5,
                        fontWeight: 600,
                        color: 'var(--text)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {item.title}
                    </span>
                    {pct != null && (
                      <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-dim)', marginTop: 3 }}>
                        {t('home.knowledge.readPercent', { n: pct })}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {notebooks.length > 0 && (
        <section>
          <div className="nn-section-label">{t('home.knowledge.notebooks')}</div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: isMobile ? 10 : 14,
            }}
          >
            {notebooks.slice(0, 3).map((nb) => (
              <button
                key={nb.id}
                type="button"
                onClick={() => onOpen(`/notebooks/${nb.id}`)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: 14,
                  borderRadius: 14,
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: 'inherit',
                }}
              >
                <span
                  className="nn-nb-tile"
                  style={{ background: 'color-mix(in srgb, var(--violet-400) 16%, var(--surface-2))', color: 'var(--violet-400)' }}
                  aria-hidden
                >
                  {nb.emoji || nb.title.trim().charAt(0).toUpperCase() || '?'}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span
                    style={{
                      display: 'block',
                      fontSize: 13.5,
                      fontWeight: 600,
                      color: 'var(--text)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {nb.title}
                  </span>
                  {nb.sourceCount != null && (
                    <span style={{ display: 'block', fontSize: 11.5, color: 'var(--text-dim)', marginTop: 3 }}>
                      {t('home.knowledge.sourceCount', { n: nb.sourceCount })}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {chatEnabled && (
        <button
          type="button"
          onClick={() => onOpen('/chat')}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: 16,
            borderRadius: 14,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            cursor: 'pointer',
            textAlign: 'left',
            fontFamily: 'inherit',
          }}
        >
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 40,
              height: 40,
              flexShrink: 0,
              borderRadius: 12,
              background: 'color-mix(in srgb, var(--violet-400) 16%, transparent)',
            }}
          >
            <NNIcon name="sparkle" size={19} color="var(--violet-400)" />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
              {t('home.knowledge.askAi')}
            </span>
            <span style={{ display: 'block', fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>
              {t('home.knowledge.askAiDesc')}
            </span>
          </span>
          <NNIcon name="chevr" size={16} color="var(--text-dim)" />
        </button>
      )}
    </div>
  );
}

function HomeSkeleton({ isMobile }: { isMobile: boolean }) {
  return (
    <div
      className="reomi-page-surface nn-scroll reomi-home" aria-busy="true"
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: isMobile ? '1fr' : '1.6fr 1fr',
          gap: isMobile ? 10 : 16,
          marginBottom: isMobile ? 14 : 20,
        }}
      >
        {/* Hero card — today's queue */}
        <div
          style={{
            padding: isMobile ? 16 : 24,
            borderRadius: 16,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
          }}
        >
          <NNSkeleton width={100} height={10} />
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, marginTop: 14 }}>
            <NNSkeleton width={isMobile ? 80 : 120} height={isMobile ? 44 : 72} radius={10} />
            <NNSkeleton width={100} height={14} />
          </div>
          <NNSkeleton width="70%" height={12} style={{ marginTop: 14 }} />
          <NNSkeleton width={isMobile ? '100%' : '55%'} height={6} style={{ marginTop: 18 }} />
          <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
            <NNSkeleton width={160} height={40} radius={10} />
            <NNSkeleton width={42} height={40} radius={10} />
          </div>
        </div>

        {/* Streak card */}
        <div
          style={{
            padding: isMobile ? 16 : 20,
            borderRadius: 16,
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <NNSkeleton width={130} height={12} />
            <NNSkeleton width={72} height={20} radius={999} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <NNSkeleton width={80} height={80} radius={12} />
            <div style={{ flex: 1 }}>
              <NNSkeleton width={80} height={10} />
              <NNSkeleton width={140} height={22} style={{ marginTop: 8 }} />
              <NNSkeleton width="100%" height={6} style={{ marginTop: 10 }} />
            </div>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
              gap: 8,
              paddingTop: 12,
              borderTop: '1px solid var(--border)',
            }}
          >
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i}>
                <NNSkeleton width={40} height={16} />
                <NNSkeleton width={60} height={10} style={{ marginTop: 6 }} />
              </div>
            ))}
          </div>
        </div>
      </div>

      <NNCard padding={20}>
        <NNSkeleton width={100} height={16} style={{ marginBottom: 20 }} />
        {Array.from({ length: 7 }, (_, index) => <div key={index} style={{ display: 'flex', gap: 20, alignItems: 'center', height: 32 }}>
          <NNSkeleton width={90} height={12} /><NNSkeleton height={6} style={{ flex: 1 }} /><NNSkeleton width={24} height={12} />
        </div>)}
      </NNCard>
    </div>
  );
}
