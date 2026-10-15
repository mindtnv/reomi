'use client';

/* eslint-disable react/forbid-elements -- TODO: replace raw input, select, and button with TextInput, Button, or NNSelect. */

// OverviewPanel («Блокноты 2.0» N2, Р6/Р12 «Обзор» tab — the FIRST/default dock
// tab) — the notebook briefing + suggested questions.
//
//  • Overview block: the cached markdown overview (GET /notebooks/:id). If it's
//    NULL and the notebook has ready sources and chat is enabled, auto-kick
//    generateOverview ONCE per mount (a ref-guard — anti-loop of paid calls),
//    showing a skeleton while it runs. A generation failure surfaces an inline
//    message + a manual «Retry» (NO auto-retry).
//  • Staleness: the GET returns the cached `overviewFingerprint` and the live
//    `currentFingerprint`; a mismatch ⇒ a soft «sources changed» plaque + an
//    «Refresh overview» button.
//  • Suggested questions: pills under the overview — a click prefills/sends the
//    chat composer via `onAskQuestion` (the workspace routes it to the chat
//    panel, same mechanism as the «Спросить» handoff).
//  • No ready sources ⇒ an empty state. Chat off ⇒ a setup hint.
//  • Card-coverage bars (N3) + the concept map (N4) render below the overview.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReadingText } from '@/components/design-system/primitives';
import { NNBtn, NNIcon, NNSkeleton } from '@/components/ui';
import { renderCardHtml, SafeHtml } from '@/lib/render-card';
import { CoverageBars } from '@/components/notebook/coverage-bars';
import { ConceptMap } from '@/components/notebook/concept-map';
import { raiseToast } from '@/components/toasts';
import { isCooldownError } from '@/lib/store';
import type { ConceptMapResult, Notebook, NotebookCoverage, Source } from '@/lib/types';

type Tfn = (key: string, params?: Record<string, string | number>) => string;

const OVERVIEW_MD_NOTE_TYPE = {
  kind: 'basic' as const,
  templates: [{ name: 'ov', ord: 0, frontTemplate: '{{Body}}', backTemplate: '{{Body}}' }],
};

export interface OverviewPanelProps {
  notebookId: string;
  /** The notebook detail (overview cache + fingerprints), owned by the workspace
   *  so the ChatPanel empty-state shares the same `suggestedQuestions`. Null
   *  until the detail loads. */
  detail: Notebook | null;
  /** Detail loaded flag (workspace-owned). */
  detailLoaded: boolean;
  /** The workspace's source list — drives the «no ready sources» empty state. */
  sources: Source[];
  /** /ai/status.chatEnabled — gates the auto-kick + the generate buttons. */
  chatEnabled: boolean;
  generateOverview: (
    id: string,
  ) => Promise<{ overview: string; questions: string[]; fingerprint: string }>;
  /** Card-coverage of the notebook (N3, Р9). SQL-only — fetched lazily on mount. */
  getCoverage: (id: string) => Promise<NotebookCoverage>;
  /** Sectional concept-map of the notebook (N4, Р10). Vectors-only — fetched
   *  lazily by the ConceptMap child when the Overview tab is open. */
  conceptMap: (id: string) => Promise<ConceptMapResult>;
  /** A concept-map node was clicked — open the citation viewer on its first
   *  chunk (the workspace resolves sourceId+chunkId → viewer). */
  onOpenCitation: (sourceId: string, chunkId: string) => void;
  /** Merge a freshly-generated overview into the workspace's detail state. */
  onDetailChange: (patch: Partial<Notebook>) => void;
  /** A suggested-question pill / coverage-gap arrow was clicked — send it into
   *  the chat (prefill). */
  onAskQuestion: (question: string) => void;
  t: Tfn;
}

export const OverviewPanel = ({
  notebookId,
  detail,
  detailLoaded,
  sources,
  chatEnabled,
  generateOverview,
  getCoverage,
  conceptMap,
  onOpenCitation,
  onDetailChange,
  onAskQuestion,
  t,
}: OverviewPanelProps) => {
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(false);

  const loaded = detailLoaded;
  const readyCount = useMemo(() => sources.filter((s) => s.status === 'ready').length, [sources]);
  const hasReady = readyCount > 0;

  // ── Coverage (N3, Р9): lazy fetch ONCE per mount; SQL-only (no chat key) ──────
  const [coverage, setCoverage] = useState<NotebookCoverage | null>(null);
  const [coverageLoading, setCoverageLoading] = useState(false);
  const coverageFetchedRef = useRef(false);
  useEffect(() => {
    if (coverageFetchedRef.current) return;
    if (!hasReady) return; // nothing to cover yet
    coverageFetchedRef.current = true;
    setCoverageLoading(true);
    let cancelled = false;
    (async () => {
      try {
        const cov = await getCoverage(notebookId);
        if (!cancelled) setCoverage(cov);
      } catch {
        if (!cancelled) setCoverage(null);
      } finally {
        if (!cancelled) setCoverageLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hasReady, getCoverage, notebookId]);

  // ── Generate (manual + the auto-kick share this) ────────────────────────────────
  const generate = useCallback(async () => {
    if (generating) return;
    setGenerating(true);
    setError(false);
    try {
      const res = await generateOverview(notebookId);
      onDetailChange({
        overview: res.overview,
        suggestedQuestions: res.questions,
        overviewFingerprint: res.fingerprint,
        currentFingerprint: res.fingerprint,
      });
    } catch (err) {
      // 429 cooldown → an info toast, not the inline error plaque.
      if (isCooldownError(err)) {
        raiseToast({ kind: 'info', title: t('notebooks.overview.cooldown') });
      } else {
        setError(true);
      }
    } finally {
      setGenerating(false);
    }
  }, [generating, generateOverview, notebookId, onDetailChange, t]);

  // ── Auto-kick ONCE per mount (Р6): overview is null + ready sources + chat on ──
  const autoKickedRef = useRef(false);
  useEffect(() => {
    if (autoKickedRef.current) return;
    if (!loaded || !detail) return;
    if (!chatEnabled || !hasReady) return;
    if (detail.overview) return;
    autoKickedRef.current = true;
    void generate();
  }, [loaded, detail, chatEnabled, hasReady, generate]);

  const overview = detail?.overview ?? null;
  const questions = detail?.suggestedQuestions ?? [];
  const isStale =
    !!detail?.overview &&
    !!detail?.overviewFingerprint &&
    !!detail?.currentFingerprint &&
    detail.overviewFingerprint !== detail.currentFingerprint;

  const overviewHtml = useMemo(
    () => (overview ? renderCardHtml(OVERVIEW_MD_NOTE_TYPE, { Body: overview }, 'front') : ''),
    [overview],
  );

  // ── Render ───────────────────────────────────────────────────────────────────────
  return (
    <div className="nn-scroll" style={{ flex: 1, overflowY: 'auto', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '12px 12px 18px' }}>
        {/* ── Overview section ── */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <SectionHeading icon="sparkle" label={t('notebooks.overview.heading')} />

          {!loaded ? (
            <NNSkeleton style={{ height: 100 }} />
          ) : !hasReady ? (
            <div className="nn-empty-state" style={{ paddingTop: 22, paddingBottom: 22 }}>
              <span className="nn-empty-state-icon">
                <NNIcon name="stack" size={24} color="var(--text-dim)" />
              </span>
              <p className="nn-empty-state-hint">{t('notebooks.overview.empty')}</p>
            </div>
          ) : !chatEnabled ? (
            <div className="nn-empty-state" style={{ paddingTop: 22, paddingBottom: 22 }}>
              <span className="nn-empty-state-icon">
                <NNIcon name="sparkle" size={24} color="var(--text-dim)" />
              </span>
              <p className="nn-empty-state-hint">{t('notebooks.overview.setupHint')}</p>
            </div>
          ) : generating ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  color: 'var(--text-dim)',
                }}
              >
                <span className="nn-spin" style={{ display: 'flex' }}>
                  <NNIcon name="sync" size={13} color="var(--lime-400)" />
                </span>
                {t('notebooks.overview.generating')}
              </div>
              <NNSkeleton style={{ height: 90 }} />
            </div>
          ) : overview ? (
            <>
              {isStale && (
                <div className="nn-stale-plaque">
                  <span style={{ flex: 1, minWidth: 0 }}>{t('notebooks.overview.stale')}</span>
                  <NNBtn variant="soft" size="sm" icon="sync" onClick={() => void generate()}>
                    {t('notebooks.overview.refresh')}
                  </NNBtn>
                </div>
              )}
              <ReadingText><SafeHtml
                html={overviewHtml}
                style={{
                  fontFamily: 'inherit',
                  fontSize: 'inherit',
                  lineHeight: 'inherit',
                  color: 'var(--text)',
                  wordBreak: 'break-word',
                }}
              /></ReadingText>
            </>
          ) : error ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
              <p style={{ fontSize: 12.5, color: 'var(--rose-400)', margin: 0 }}>
                {t('notebooks.overview.failed')}
              </p>
              <NNBtn variant="soft" size="sm" icon="sync" onClick={() => void generate()}>
                {t('notebooks.overview.retry')}
              </NNBtn>
            </div>
          ) : (
            // Loaded, ready, chat on, no overview yet, not generating (auto-kick is
            // about to run on the next tick) — show a manual generate affordance.
            <NNBtn variant="primary" size="sm" icon="sparkle" onClick={() => void generate()}>
              {t('notebooks.overview.generate')}
            </NNBtn>
          )}
        </section>

        {/* ── Suggested questions ── */}
        {questions.length > 0 && (
          <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <SectionHeading icon="bulb" label={t('notebooks.overview.suggestedHeading')} />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {questions.map((q) => (
                <button
                  key={q}
                  type="button"
                  className="nn-suggest-pill"
                  onClick={() => onAskQuestion(q)}
                >
                  {q}
                </button>
              ))}
            </div>
          </section>
        )}

        {/* ── Coverage (N3, Р9) — SQL-only, renders without a chat key ── */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <SectionHeading icon="target" label={t('notebooks.overview.coverageHeading')} />
          {!hasReady ? (
            <p style={{ fontSize: 11.5, color: 'var(--text-dim)', margin: 0 }}>
              {t('notebooks.coverage.noSources')}
            </p>
          ) : coverageLoading || coverage === null ? (
            <NNSkeleton style={{ height: 70 }} />
          ) : (
            <CoverageBars
              coverage={coverage}
              chatEnabled={chatEnabled}
              onAskGap={onAskQuestion}
              t={t}
            />
          )}
        </section>

        {/* ── Concept map (N4, Р10) — vectors-only, renders without a chat key ── */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <SectionHeading icon="graph" label={t('notebooks.overview.mapHeading')} />
          <ConceptMap
            notebookId={notebookId}
            hasReady={hasReady}
            conceptMap={conceptMap}
            onOpenCitation={(chunkId, sourceId) => onOpenCitation(sourceId, chunkId)}
            t={t}
          />
        </section>
      </div>
    </div>
  );
};

const SectionHeading = ({ icon, label }: { icon: string; label: string }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
    <NNIcon name={icon} size={13} color="var(--text-dim)" />
    <span
      className="nn-chrome"
      style={{
        fontSize: 11,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.07em',
        color: 'var(--text-dim)',
      }}
    >
      {label}
    </span>
  </div>
);
