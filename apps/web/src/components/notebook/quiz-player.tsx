'use client';

// QuizPlayer («Блокноты 2.0» N3, Р8) — the in-studio quiz runner. Opened from the
// studio when a ready artifact is `type='quiz'` (instead of the markdown viewer).
//
//  Phases:
//   • intro   — a start screen (question count + «Начать» / «История попыток»)
//   • playing — one question at a time (progress dots): mcq radios, tf two
//     big buttons, open textarea → «Показать эталон» → self-grade. Forward nav
//     (back optional). State is LOCAL; an unfinished quiz on close is lost (V1).
//   • result  — POST attempt → server-scored X/M + a per-question breakdown
//     (verdict, model answer, explanation, «в источнике» when sourceChunkId) +
//     «Пройти ещё раз» / «Слабые места → карточки» / «История попыток».
//   • history — the last 10 attempts (date + score).
//
//  Server scoring is authoritative: mcq/tf recomputed from content_json, `open`
//  trusts the user's self-grade. The player only collects + renders the verdict.
//  Big touch targets (this is also an iPad surface); lime/rose verdicts.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { QuizContent, QuizQuestion } from '@reomi/shared';
import { NNBtn, NNIcon, NNSkeleton } from '@/components/ui';
import { raiseToast } from '@/components/toasts';
import { useLocale } from '@/lib/i18n';
import {
  allAnswered,
  buildAttemptAnswers,
  buildWeakSpotsPrompt,
  modelAnswerText,
  type QuizResponse,
} from '@/lib/quiz-player';
import type { NotebookArtifact, QuizAttempt } from '@/lib/types';

type Tfn = (key: string, params?: Record<string, string | number>) => string;

type Phase = 'intro' | 'playing' | 'result' | 'history';

export interface QuizPlayerProps {
  notebookId: string;
  /** The full quiz artifact (status=ready, contentJson present). */
  artifact: NotebookArtifact;
  /** The source ids the artifact was generated over (for the citation jump). */
  sourceIds: string[];
  submitQuizAttempt: (
    notebookId: string,
    artifactId: string,
    answers: ReturnType<typeof buildAttemptAnswers>,
  ) => Promise<QuizAttempt>;
  listQuizAttempts: (notebookId: string, artifactId: string) => Promise<QuizAttempt[]>;
  /** A `[src:]` chunk chip was clicked — the workspace resolves + opens it. */
  onOpenCitation: (chunkId: string, sourceIds: string[]) => void;
  /** «Слабые места → карточки» — prefill the chat composer with the wrong qs. */
  onPrefillChat: (text: string) => void;
  /** Back to the studio list. */
  onBack: () => void;
  t: Tfn;
}

export const QuizPlayer = ({
  notebookId,
  artifact,
  sourceIds,
  submitQuizAttempt,
  listQuizAttempts,
  onOpenCitation,
  onPrefillChat,
  onBack,
  t,
}: QuizPlayerProps) => {
  const { locale } = useLocale();
  const questions = useMemo<QuizQuestion[]>(
    () => artifact.contentJson?.questions ?? [],
    [artifact.contentJson],
  );

  const [phase, setPhase] = useState<Phase>('intro');
  const [step, setStep] = useState(0);
  const [responses, setResponses] = useState<Map<string, QuizResponse>>(new Map());
  // open-question reveal set (which questions have «Показать эталон» tapped).
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  const [attempt, setAttempt] = useState<QuizAttempt | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [history, setHistory] = useState<QuizAttempt[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const reset = useCallback(() => {
    setStep(0);
    setResponses(new Map());
    setRevealed(new Set());
    setAttempt(null);
    setPhase('playing');
  }, []);

  const setResponse = useCallback((id: string, r: QuizResponse) => {
    setResponses((prev) => {
      const next = new Map(prev);
      next.set(id, r);
      return next;
    });
  }, []);

  const reveal = useCallback((id: string) => {
    setRevealed((prev) => new Set(prev).add(id));
  }, []);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      setHistory(await listQuizAttempts(notebookId, artifact.id));
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [listQuizAttempts, notebookId, artifact.id]);

  const openHistory = useCallback(() => {
    setPhase('history');
    void loadHistory();
  }, [loadHistory]);

  const finish = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    try {
      const answers = buildAttemptAnswers(questions, responses);
      const result = await submitQuizAttempt(notebookId, artifact.id, answers);
      setAttempt(result);
      setPhase('result');
    } catch {
      raiseToast({ kind: 'info', title: t('notebooks.quiz.submitFailed') });
    } finally {
      setSubmitting(false);
    }
  }, [submitting, questions, responses, submitQuizAttempt, notebookId, artifact.id, t]);

  // ── The set of wrong question ids from the server's verdict ──────────────────────
  const wrongIds = useMemo(() => {
    const s = new Set<string>();
    if (!attempt) return s;
    for (const a of attempt.answers) if (!a.correct) s.add(a.questionId);
    // Unanswered questions (omitted from the attempt) also count as wrong.
    const answered = new Set(attempt.answers.map((a) => a.questionId));
    for (const q of questions) if (!answered.has(q.id)) s.add(q.id);
    return s;
  }, [attempt, questions]);

  const onWeakSpots = useCallback(() => {
    if (!artifact.contentJson) return;
    const prompt = buildWeakSpotsPrompt(artifact.contentJson, wrongIds, {
      header: t('notebooks.quiz.weakSpotsPrompt'),
      answerLabel: t('notebooks.quiz.weakSpotsAnswer'),
      tfYes: t('notebooks.quiz.tfTrue'),
      tfNo: t('notebooks.quiz.tfFalse'),
    });
    if (prompt) onPrefillChat(prompt);
  }, [artifact.contentJson, wrongIds, onPrefillChat, t]);

  // ── Header (shared across phases) ────────────────────────────────────────────────
  const header = (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '8px 10px',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}
    >
      <NNBtn variant="ghost" size="sm" icon="chevl" onClick={onBack}>
        {t('notebooks.studio.back')}
      </NNBtn>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 13,
          fontWeight: 700,
          color: 'var(--text)',
          fontFamily: 'var(--font-sans)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={artifact.title}
      >
        {artifact.title}
      </span>
    </div>
  );

  // ── Render ───────────────────────────────────────────────────────────────────────
  if (questions.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        {header}
        <div className="nn-empty-state" style={{ paddingTop: 32 }}>
          <span className="nn-empty-state-icon">
            <NNIcon name="target" size={24} color="var(--text-dim)" />
          </span>
          <p className="nn-empty-state-hint">{t('notebooks.quiz.empty')}</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {header}
      <div className="nn-scroll" style={{ flex: 1, overflowY: 'auto', padding: 14 }}>
        {phase === 'intro' && (
          <QuizIntro
            count={questions.length}
            onStart={reset}
            onHistory={openHistory}
            t={t}
          />
        )}

        {phase === 'playing' && (
          <QuizQuestionView
            key={questions[step]!.id}
            questions={questions}
            step={step}
            response={responses.get(questions[step]!.id)}
            answeredIds={new Set(responses.keys())}
            revealed={revealed.has(questions[step]!.id)}
            onAnswer={(r) => setResponse(questions[step]!.id, r)}
            onReveal={() => reveal(questions[step]!.id)}
            onPrev={step > 0 ? () => setStep((s) => s - 1) : undefined}
            onNext={
              step < questions.length - 1 ? () => setStep((s) => s + 1) : undefined
            }
            onFinish={allAnswered(questions, responses) ? () => void finish() : undefined}
            submitting={submitting}
            t={t}
          />
        )}

        {phase === 'result' && attempt && (
          <QuizResult
            artifact={artifact}
            attempt={attempt}
            wrongIds={wrongIds}
            sourceIds={sourceIds}
            onRetry={reset}
            onWeakSpots={wrongIds.size > 0 ? onWeakSpots : undefined}
            onHistory={openHistory}
            onOpenCitation={onOpenCitation}
            t={t}
          />
        )}

        {phase === 'history' && (
          <QuizHistory
            attempts={history}
            loading={historyLoading}
            locale={locale}
            onBack={() => setPhase(attempt ? 'result' : 'intro')}
            t={t}
          />
        )}
      </div>
    </div>
  );
};

// ── Intro ─────────────────────────────────────────────────────────────────────

const QuizIntro = ({
  count,
  onStart,
  onHistory,
  t,
}: {
  count: number;
  onStart: () => void;
  onHistory: () => void;
  t: Tfn;
}) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center', paddingTop: 24 }}>
    <span className="nn-quiz-intro-icon">
      <NNIcon name="target" size={28} color="var(--lime-400)" />
    </span>
    <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--font-sans)' }}>
        {t('notebooks.quiz.introTitle')}
      </span>
      <span style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
        {t('notebooks.quiz.questionCount', { count })}
      </span>
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', maxWidth: 280 }}>
      <NNBtn variant="primary" size="lg" icon="play" block onClick={onStart}>
        {t('notebooks.quiz.start')}
      </NNBtn>
      <NNBtn variant="ghost" size="sm" icon="clock" block onClick={onHistory}>
        {t('notebooks.quiz.history')}
      </NNBtn>
    </div>
  </div>
);

// ── Progress dots ─────────────────────────────────────────────────────────────

const ProgressDots = ({
  total,
  step,
  answered,
}: {
  total: number;
  step: number;
  answered: boolean[];
}) => (
  <div className="nn-quiz-dots" role="presentation">
    {Array.from({ length: total }).map((_, i) => (
      <span
        key={i}
        className={`nn-quiz-dot${i === step ? ' current' : ''}${answered[i] ? ' done' : ''}`}
      />
    ))}
  </div>
);

// ── One question ──────────────────────────────────────────────────────────────

const QuizQuestionView = ({
  questions,
  step,
  response,
  answeredIds,
  revealed,
  onAnswer,
  onReveal,
  onPrev,
  onNext,
  onFinish,
  submitting,
  t,
}: {
  questions: QuizQuestion[];
  step: number;
  response: QuizResponse | undefined;
  /** The ids of every question already answered (drives the progress dots). */
  answeredIds: Set<string>;
  revealed: boolean;
  onAnswer: (r: QuizResponse) => void;
  onReveal: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onFinish?: () => void;
  submitting: boolean;
  t: Tfn;
}) => {
  const q = questions[step]!;
  const total = questions.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <ProgressDots
        total={total}
        step={step}
        answered={questions.map((qq) => answeredIds.has(qq.id))}
      />
      <span style={{ fontSize: 11.5, color: 'var(--text-dim)', fontFamily: 'var(--font-sans)' }}>
        {t('notebooks.quiz.questionOf', { n: step + 1, total })}
      </span>

      <p
        style={{
          fontSize: 15,
          fontWeight: 600,
          lineHeight: 1.45,
          color: 'var(--text)',
          fontFamily: 'var(--font-sans)',
          margin: 0,
          wordBreak: 'break-word',
        }}
      >
        {q.prompt}
      </p>

      {q.kind === 'mcq' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(q.options ?? []).map((opt, i) => {
            const selected = response?.kind === 'mcq' && response.value === i;
            return (
              <button
                key={i}
                type="button"
                className={`nn-quiz-option${selected ? ' selected' : ''}`}
                onClick={() => onAnswer({ kind: 'mcq', value: i })}
              >
                <span className={`nn-quiz-radio${selected ? ' on' : ''}`} />
                <span style={{ flex: 1, textAlign: 'left' }}>{opt}</span>
              </button>
            );
          })}
        </div>
      )}

      {q.kind === 'tf' && (
        <div style={{ display: 'flex', gap: 10 }}>
          {[true, false].map((val) => {
            const selected = response?.kind === 'tf' && response.value === val;
            return (
              <button
                key={String(val)}
                type="button"
                className={`nn-quiz-tf${selected ? ' selected' : ''}`}
                onClick={() => onAnswer({ kind: 'tf', value: val })}
              >
                <NNIcon name={val ? 'check' : 'x'} size={18} color={selected ? 'var(--lime-400)' : 'var(--text-muted)'} />
                {val ? t('notebooks.quiz.tfTrue') : t('notebooks.quiz.tfFalse')}
              </button>
            );
          })}
        </div>
      )}

      {q.kind === 'open' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <textarea
            placeholder={t('notebooks.quiz.openPlaceholder')}
            className="nn-quiz-textarea"
            rows={4}
          />
          {!revealed ? (
            <NNBtn variant="soft" size="sm" icon="bulb" onClick={onReveal}>
              {t('notebooks.quiz.showAnswer')}
            </NNBtn>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div className="nn-quiz-model-answer">
                <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: 0.6, textTransform: 'uppercase', color: 'var(--text-dim)' }}>
                  {t('notebooks.quiz.modelAnswer')}
                </span>
                <span style={{ fontSize: 13.5, color: 'var(--text)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                  {modelAnswerText(q, { yes: t('notebooks.quiz.tfTrue'), no: t('notebooks.quiz.tfFalse') })}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  type="button"
                  className={`nn-quiz-selfgrade ok${response?.kind === 'open' && response.selfCorrect ? ' selected' : ''}`}
                  onClick={() => onAnswer({ kind: 'open', selfCorrect: true })}
                >
                  <NNIcon name="check" size={16} color="var(--lime-400)" />
                  {t('notebooks.quiz.selfCorrect')}
                </button>
                <button
                  type="button"
                  className={`nn-quiz-selfgrade bad${response?.kind === 'open' && !response.selfCorrect ? ' selected' : ''}`}
                  onClick={() => onAnswer({ kind: 'open', selfCorrect: false })}
                >
                  <NNIcon name="x" size={16} color="var(--rose-400)" />
                  {t('notebooks.quiz.selfIncorrect')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Nav */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
        {onPrev && (
          <NNBtn variant="ghost" size="sm" icon="chevl" onClick={onPrev}>
            {t('notebooks.quiz.prev')}
          </NNBtn>
        )}
        <span style={{ flex: 1 }} />
        {onNext && (
          <NNBtn variant="soft" size="sm" onClick={onNext}>
            {t('notebooks.quiz.next')}
          </NNBtn>
        )}
        {onFinish && (
          <NNBtn variant="primary" size="sm" icon="check" disabled={submitting} onClick={onFinish}>
            {submitting ? t('notebooks.quiz.submitting') : t('notebooks.quiz.finish')}
          </NNBtn>
        )}
      </div>
    </div>
  );
};

// ── Result ────────────────────────────────────────────────────────────────────

const QuizResult = ({
  artifact,
  attempt,
  wrongIds,
  sourceIds,
  onRetry,
  onWeakSpots,
  onHistory,
  onOpenCitation,
  t,
}: {
  artifact: NotebookArtifact;
  attempt: QuizAttempt;
  wrongIds: Set<string>;
  sourceIds: string[];
  onRetry: () => void;
  onWeakSpots?: () => void;
  onHistory: () => void;
  onOpenCitation: (chunkId: string, sourceIds: string[]) => void;
  t: Tfn;
}) => {
  const questions = artifact.contentJson?.questions ?? [];
  const pct = scorePct(attempt.correct, attempt.total);
  const tone = pct >= 80 ? 'lime' : pct >= 50 ? 'amber' : 'rose';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Score */}
      <div className={`nn-quiz-score ${tone}`}>
        <span className="nn-quiz-score-num">
          {attempt.correct}
          <span className="nn-quiz-score-total">/{attempt.total}</span>
        </span>
        <span className="nn-quiz-score-pct">{t('notebooks.quiz.scorePct', { pct })}</span>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <NNBtn variant="primary" size="sm" icon="sync" onClick={onRetry}>
          {t('notebooks.quiz.retry')}
        </NNBtn>
        {onWeakSpots && (
          <NNBtn variant="soft" size="sm" icon="plus" onClick={onWeakSpots}>
            {t('notebooks.quiz.weakSpots')}
          </NNBtn>
        )}
        <NNBtn variant="ghost" size="sm" icon="clock" onClick={onHistory}>
          {t('notebooks.quiz.history')}
        </NNBtn>
      </div>

      {/* Per-question breakdown */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <span
          className="nn-chrome"
          style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-dim)' }}
        >
          {t('notebooks.quiz.breakdownHeading')}
        </span>
        {questions.map((q, i) => {
          const wrong = wrongIds.has(q.id);
          return (
            <div key={`${q.id}-${i}`} className={`nn-quiz-review-row ${wrong ? 'wrong' : 'right'}`}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <span className={`nn-quiz-verdict ${wrong ? 'wrong' : 'right'}`}>
                  <NNIcon name={wrong ? 'x' : 'check'} size={13} color={wrong ? 'var(--rose-400)' : 'var(--lime-400)'} />
                </span>
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', lineHeight: 1.4 }}>
                    {i + 1}. {q.prompt}
                  </span>
                  <span style={{ fontSize: 12.5, color: 'var(--text-muted)', lineHeight: 1.45 }}>
                    <span style={{ color: 'var(--text-dim)' }}>{t('notebooks.quiz.modelAnswer')}: </span>
                    {modelAnswerText(q, { yes: t('notebooks.quiz.tfTrue'), no: t('notebooks.quiz.tfFalse') }) || '—'}
                  </span>
                  {q.explanation && (
                    <span style={{ fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.45, fontStyle: 'italic' }}>
                      {q.explanation}
                    </span>
                  )}
                  {q.sourceChunkId && (
                    <button
                      type="button"
                      className="nn-quiz-source-link"
                      onClick={() => onOpenCitation(q.sourceChunkId!, sourceIds)}
                    >
                      <NNIcon name="doc" size={11} color="var(--sky-400)" />
                      {t('notebooks.quiz.inSource')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

// ── History ───────────────────────────────────────────────────────────────────

const QuizHistory = ({
  attempts,
  loading,
  locale,
  onBack,
  t,
}: {
  attempts: QuizAttempt[] | null;
  loading: boolean;
  locale: string;
  onBack: () => void;
  t: Tfn;
}) => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <NNBtn variant="ghost" size="sm" icon="chevl" onClick={onBack}>
        {t('notebooks.quiz.back')}
      </NNBtn>
      <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: 'var(--text)', fontFamily: 'var(--font-sans)' }}>
        {t('notebooks.quiz.historyHeading')}
      </span>
    </div>
    {loading || attempts === null ? (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <NNSkeleton style={{ height: 40 }} />
        <NNSkeleton style={{ height: 40 }} />
      </div>
    ) : attempts.length === 0 ? (
      <div className="nn-empty-state" style={{ paddingTop: 18, paddingBottom: 18 }}>
        <span className="nn-empty-state-icon">
          <NNIcon name="clock" size={22} color="var(--text-dim)" />
        </span>
        <p className="nn-empty-state-hint">{t('notebooks.quiz.historyEmpty')}</p>
      </div>
    ) : (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {attempts.map((a) => {
          const pct = scorePct(a.correct, a.total);
          const tone = pct >= 80 ? 'lime' : pct >= 50 ? 'amber' : 'rose';
          return (
            <div key={a.id} className="nn-quiz-history-row">
              <span className={`nn-quiz-history-badge ${tone}`}>
                {a.correct}/{a.total}
              </span>
              <span style={{ flex: 1, fontSize: 12.5, color: 'var(--text-muted)' }}>
                {t('notebooks.quiz.scorePct', { pct })}
              </span>
              <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>
                {formatAttemptDate(a.createdAt, locale)}
              </span>
            </div>
          );
        })}
      </div>
    )}
  </div>
);

/** Score as a 0..100 percentage; a zero/garbage total maps to 0 (no NaN render). */
function scorePct(correct: number, total: number): number {
  if (!Number.isFinite(correct) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((correct / total) * 100)));
}

/** Compact locale-formatted date for an attempt row (Intl, app locale; matches the
 *  chat-panel timestamp pattern). Falls back to '' if the ISO can't be parsed. */
function formatAttemptDate(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleString(locale, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}
