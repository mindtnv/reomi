'use client';
import { InlineDeckCreate } from '../inline-deck-create';

// Feature #2 — «Урожай выделений → карточки» wizard. Opened from the «Разметка»
// panel's «Собрать карточки из разметки» button. Lifecycle:
//
//   1. on open → store.harvestCards(sourceId, locale): one AI pass over the
//      source's un-harvested markup → HarvestCandidate[]. Loading spinner.
//      • empty            → info toast «нечего собирать» + close (no wizard).
//      • 429 cooldown     → info toast + close.
//      • 502 harvest_failed → error toast + close.
//      • 503 ai_disabled  → shouldn't happen (the button is gated) but handled.
//   2. a one-card-at-a-time WIZARD (mirrors the chat confirm-wizard): «Карточка N
//      из M» with Include/Exclude + inline front/back textareas (full values from
//      the candidate) + the source quote as collapsed context. A deck picker with
//      the shared nn:nb:quickdeck memory.
//   3. a REVIEW step (clickable per-card summary → jump back) then «Применить (N)»
//      → store.applyHarvest(sourceId, { deckId, cards }) → success toast.
//
// Excluded/edited logic lives in the PURE lib/harvest.ts helpers (unit-tested);
// this component is the imperative shell.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError } from '@/lib/api';
import { isCooldownError, useNN } from '@/lib/store';
import { buildDeckTree, deckPathLabel, flattenTree } from '@/lib/decks';
import { NNSelect, type NNSelectOption } from '@/components/nn-select';
import { NNBtn } from '@/components/ui';
import { raiseToast } from '@/components/toasts';
import {
  buildHarvestSelection,
  harvestSelectionCount,
  initialDecisions,
  type HarvestDecision,
} from '@/lib/harvest';
import type { Deck, HarvestCandidate } from '@/lib/types';
import { readBrowserValue, writeBrowserValue } from '@/lib/storage-migration';

const DECK_KEY = 'nn:nb:quickdeck';

type T = (key: string, params?: Record<string, string | number>) => string;

export interface HarvestWizardProps {
  open: boolean;
  onClose: () => void;
  sourceId: string;
  locale?: 'en' | 'ru';
  /** Fired after a successful apply with the created card count — the parent
   *  refreshes marks (for the «✓ в карточке» badge) and may toast/navigate. */
  onApplied: (created: number, cardIds: string[]) => void;
  t: T;
}

type Phase = 'loading' | 'wizard' | 'review';

export function HarvestWizard({ open, onClose, sourceId, locale, onApplied, t }: HarvestWizardProps) {
  const decks = useNN((s) => s.decks);
  const harvestCards = useNN((s) => s.harvestCards);
  const applyHarvest = useNN((s) => s.applyHarvest);

  const [phase, setPhase] = useState<Phase>('loading');
  const [candidates, setCandidates] = useState<HarvestCandidate[]>([]);
  const [decisions, setDecisions] = useState<HarvestDecision[]>([]);
  const [cursor, setCursor] = useState(0);
  const [deckId, setDeckId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [applyError, setApplyError] = useState<boolean | 'stale'>(false);

  const deckOptions = useMemo<NNSelectOption<string>[]>(
    () =>
      flattenTree(buildDeckTree(decks), new Set(decks.map((d: Deck) => d.id))).map((node) => ({
        value: node.deck.id,
        label: node.deck.name,
        depth: node.depth,
        searchText: deckPathLabel(decks, node.deck.id),
      })),
    [decks],
  );

  // ── Lifecycle: fetch candidates on open ──────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPhase('loading');
    setCandidates([]);
    setDecisions([]);
    setCursor(0);
    setApplyError(false);
    // Seed the deck from the shared quick-card memory.
    try {
      const saved = readBrowserValue(localStorage, DECK_KEY);
      if (saved && decks.some((d: Deck) => d.id === saved)) setDeckId(saved);
      else if (decks.length > 0) setDeckId(decks[0]!.id);
      else setDeckId('');
    } catch {
      if (decks.length > 0) setDeckId(decks[0]!.id);
    }
    void (async () => {
      try {
        const cands = await harvestCards(sourceId, locale);
        if (cancelled) return;
        if (cands.length === 0) {
          raiseToast({ kind: 'info', title: t('notebooks.harvest.nothing') });
          onClose();
          return;
        }
        setCandidates(cands);
        setDecisions(initialDecisions(cands));
        setCursor(0);
        setPhase('wizard');
      } catch (err) {
        if (cancelled) return;
        if (isCooldownError(err)) {
          raiseToast({ kind: 'info', title: t('notebooks.harvest.cooldown') });
        } else {
          // 502 harvest_failed / 503 ai_disabled / anything else.
          raiseToast({ kind: 'error', title: t('notebooks.harvest.failed') });
        }
        onClose();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sourceId]);

  const handleDeckChange = useCallback((id: string) => {
    setDeckId(id);
    try { writeBrowserValue(localStorage, DECK_KEY, id); } catch { /* ignore */ }
  }, []);

  const setDecision = useCallback((index: number, patch: Partial<HarvestDecision>) => {
    setDecisions((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  }, []);

  const selectionCount = harvestSelectionCount(candidates, decisions);

  const handleApply = useCallback(async () => {
    if (submitting || !deckId) return;
    const cards = buildHarvestSelection(candidates, decisions);
    if (cards.length === 0) return;
    setSubmitting(true);
    setApplyError(false);
    try {
      const res = await applyHarvest(sourceId, { deckId, cards });
      raiseToast({ kind: 'success', title: t('notebooks.harvest.created', { n: res.created }) });
      onApplied(res.created, res.cardIds);
      onClose();
    } catch (error) {
      setApplyError(error instanceof ApiError && error.safeMessage === 'harvest_evidence_stale' ? 'stale' : true);
    } finally {
      setSubmitting(false);
    }
  }, [submitting, deckId, candidates, decisions, applyHarvest, sourceId, onApplied, onClose, t]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('notebooks.harvest.title')}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      className="nn-dialog-backdrop"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        background: 'var(--scrim)',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 520,
          maxHeight: '88vh',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-xl)',
          boxShadow: 'var(--shadow-lg)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 18px 12px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--font-sans)', letterSpacing: '-0.01em' }}>
            {t('notebooks.harvest.title')}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('notebooks.harvest.cancel')}
            style={{
              width: 30, height: 30, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: 'var(--r-md)', border: 'none', background: 'transparent',
              color: 'var(--text-muted)', cursor: 'pointer', fontSize: 16, lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        {phase === 'loading' ? (
          <div style={{ padding: '40px 18px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <span className="nn-spin" style={{
              width: 26, height: 26, borderRadius: '50%',
              border: '2.5px solid var(--surface-3)', borderTopColor: 'var(--lime-500)',
            }} />
            <span style={{ fontSize: 13, color: 'var(--text-muted)', fontFamily: 'var(--font-sans)' }}>
              {t('notebooks.harvest.loading')}
            </span>
            <style>{`@keyframes nn-spin{to{transform:rotate(360deg)}}.nn-spin{animation:nn-spin .8s linear infinite}@media (prefers-reduced-motion:reduce){.nn-spin{animation-duration:1.6s}}`}</style>
          </div>
        ) : phase === 'wizard' ? (
          <WizardStep
            candidate={candidates[cursor]!}
            decision={decisions[cursor]!}
            index={cursor}
            total={candidates.length}
            deckOptions={deckOptions}
            deckId={deckId}
            onDeckChange={handleDeckChange}
            onChange={(patch) => setDecision(cursor, patch)}
            onBack={cursor > 0 ? () => setCursor((c) => c - 1) : undefined}
            onNext={
              cursor < candidates.length - 1
                ? () => setCursor((c) => c + 1)
                : () => setPhase('review')
            }
            nextIsReview={cursor >= candidates.length - 1}
            t={t}
          />
        ) : (
          <ReviewStep
            candidates={candidates}
            decisions={decisions}
            selectionCount={selectionCount}
            deckId={deckId}
            submitting={submitting}
            applyError={applyError}
            onJump={(i) => { setCursor(i); setPhase('wizard'); }}
            onBack={() => setPhase('wizard')}
            onApply={() => void handleApply()}
            t={t}
          />
        )}
      </div>
    </div>
  );
}

// ── One-card-at-a-time step ─────────────────────────────────────────────────────

function WizardStep({
  candidate,
  decision,
  index,
  total,
  deckOptions,
  deckId,
  onDeckChange,
  onChange,
  onBack,
  onNext,
  nextIsReview,
  t,
}: {
  candidate: HarvestCandidate;
  decision: HarvestDecision;
  index: number;
  total: number;
  deckOptions: NNSelectOption<string>[];
  deckId: string;
  onDeckChange: (id: string) => void;
  onChange: (patch: Partial<HarvestDecision>) => void;
  onBack?: () => void;
  onNext: () => void;
  nextIsReview: boolean;
  t: T;
}) {
  const included = decision.include;
  return (
    <>
      <div className="nn-scroll" style={{ padding: '14px 18px', display: 'flex', flexDirection: 'column', gap: 14, overflowY: 'auto' }}>
        {/* Progress + include/exclude toggle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', fontFamily: 'var(--font-sans)' }}>
            {t('notebooks.harvest.cardOf', { n: index + 1, m: total })}
          </span>
          <div style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => onChange({ include: !included })}
            style={{
              height: 26, padding: '0 10px', borderRadius: 'var(--r-sm)',
              border: `1px solid ${included ? 'var(--rose-400)' : 'var(--lime-500)'}`,
              background: 'transparent',
              color: included ? 'var(--rose-400)' : 'var(--lime-400)',
              cursor: 'pointer', fontSize: 12, fontWeight: 600, fontFamily: 'var(--font-sans)',
            }}
          >
            {included ? t('notebooks.harvest.exclude') : t('notebooks.harvest.include')}
          </button>
        </div>

        {/* Deck picker */}
        <div>
          <label style={labelStyle}>{t('notebooks.harvest.deckLabel')}</label>
          <NNSelect<string>
            value={deckId}
            onChange={onDeckChange}
            options={deckOptions}
            placeholder={t('notebooks.harvest.deckPlaceholder')}
          />
          <InlineDeckCreate onCreated={onDeckChange} />
        </div>

        {/* Front / Back editors (disabled visual when excluded) */}
        <div style={{ opacity: included ? 1 : 0.5, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={labelStyle}>{t('notebooks.harvest.frontLabel')}</label>
            <textarea
              value={decision.front}
              disabled={!included}
              onChange={(e) => onChange({ front: e.target.value })}
              placeholder={t('notebooks.harvest.frontPlaceholder')}
              rows={2}
              style={textareaStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>{t('notebooks.harvest.backLabel')}</label>
            <textarea
              value={decision.back}
              disabled={!included}
              onChange={(e) => onChange({ back: e.target.value })}
              placeholder={t('notebooks.harvest.backPlaceholder')}
              rows={3}
              style={textareaStyle}
            />
          </div>
        </div>

        {/* Source quote context (collapsed/small) */}
        {candidate.quote.trim() && (
          <details style={{ fontSize: 11.5 }}>
            <summary style={{ cursor: 'pointer', color: 'var(--text-dim)', fontFamily: 'var(--font-sans)' }}>
              {t('notebooks.harvest.quoteLabel')}
              {candidate.page != null ? ` · ${t('notebooks.harvest.page', { n: candidate.page })}` : ''}
            </summary>
            <p
              style={{
                margin: '6px 0 0',
                padding: '7px 9px',
                borderLeft: '2px solid var(--border-2)',
                color: 'var(--text-muted)',
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: 140,
                overflowY: 'auto',
              }}
              className="nn-scroll"
            >
              {candidate.quote}
            </p>
          </details>
        )}
      </div>

      {/* Footer nav */}
      <div style={footerStyle}>
        <NNBtn size="sm" variant="ghost" icon="chevl" onClick={onBack} disabled={!onBack}>
          {t('notebooks.harvest.back')}
        </NNBtn>
        <div style={{ flex: 1 }} />
        <NNBtn size="md" variant="primary" icon={nextIsReview ? 'check' : 'chevr'} onClick={onNext}>
          {nextIsReview ? t('notebooks.harvest.review') : t('notebooks.harvest.next')}
        </NNBtn>
      </div>
    </>
  );
}

// ── Review step ─────────────────────────────────────────────────────────────────

function ReviewStep({
  candidates,
  decisions,
  selectionCount,
  deckId,
  submitting,
  applyError,
  onJump,
  onBack,
  onApply,
  t,
}: {
  candidates: HarvestCandidate[];
  decisions: HarvestDecision[];
  selectionCount: number;
  deckId: string;
  submitting: boolean;
  applyError: boolean | 'stale';
  onJump: (index: number) => void;
  onBack: () => void;
  onApply: () => void;
  t: T;
}) {
  const canApply = selectionCount > 0 && !!deckId && !submitting;
  return (
    <>
      <div className="nn-scroll" style={{ padding: '12px 18px', display: 'flex', flexDirection: 'column', gap: 3, overflowY: 'auto' }}>
        <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--text-dim)', fontFamily: 'var(--font-sans)' }}>
          {t('notebooks.harvest.reviewHint')}
        </p>
        {candidates.map((c, i) => {
          const d = decisions[i]!;
          const excluded = !d.include || d.front.trim().length === 0;
          return (
            <button
              key={i}
              type="button"
              onClick={() => onJump(i)}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                padding: '8px 10px',
                borderRadius: 'var(--r-md)',
                border: '1px solid var(--border)',
                background: 'var(--surface-2)',
                cursor: 'pointer',
                textAlign: 'left',
                width: '100%',
                opacity: excluded ? 0.5 : 1,
              }}
            >
              <span style={{ fontSize: 12, lineHeight: 1.4, flex: 1, minWidth: 0, color: 'var(--text)', overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                {d.front.trim() || candidates[i]!.front}
              </span>
              {excluded && (
                <span style={{ fontSize: 10.5, color: 'var(--rose-400)', fontFamily: 'var(--font-sans)', flexShrink: 0, marginTop: 1 }}>
                  {t('notebooks.harvest.excluded')}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div style={footerStyle}>
        <NNBtn size="sm" variant="ghost" icon="chevl" onClick={onBack}>
          {t('notebooks.harvest.back')}
        </NNBtn>
        {applyError && (
          <span role="alert" style={{ fontSize: 11.5, color: 'var(--rose-400)', flex: 1, minWidth: 0 }}>
            {t(applyError === 'stale' ? 'notebooks.harvest.stale' : 'notebooks.harvest.failed')}
          </span>
        )}
        <div style={{ flex: 1 }} />
        <NNBtn size="md" variant="primary" icon="plus" onClick={onApply} disabled={!canApply}>
          {submitting ? t('notebooks.harvest.applying') : t('notebooks.harvest.apply', { n: selectionCount })}
        </NNBtn>
      </div>
    </>
  );
}

// ── Shared styles ───────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 10.5,
  fontWeight: 700,
  color: 'var(--text-dim)',
  marginBottom: 5,
  textTransform: 'uppercase',
  letterSpacing: '0.07em',
};

const textareaStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  borderRadius: 'var(--r-md)',
  border: '1px solid var(--border)',
  background: 'var(--surface-2)',
  color: 'var(--text)',
  fontSize: 13,
  fontFamily: 'var(--font-sans)',
  resize: 'vertical',
  lineHeight: 1.5,
  boxSizing: 'border-box',
  outline: 'none',
};

const footerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 18px 12px',
  borderTop: '1px solid var(--border)',
  background: 'var(--surface-2)',
};
