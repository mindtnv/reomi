'use client';

/* eslint-disable react/forbid-elements -- TODO: replace raw input, select, and button with TextInput, Button, or NNSelect. */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAssistantPageContext } from '@/components/chat/assistant-provider';
import { ResizeHandle } from '@/components/design-system/resize-handle';
import { REVIEW_INSPECTOR, boundedPanelWidth, readReviewInspectorWidth } from '@/lib/panel-width';
import { currentStorageKey, writeBrowserValue } from '@/lib/storage-migration';
import { ReviewCardInfo } from '@/components/review-card-info';
import { deckPathLabel } from '@/lib/decks';
import { AppLink, useAppNavigation, useNavigationWorkspace } from '@/components/navigation';
import { useSearchParams } from 'next/navigation';
import { NNBadge, NNBtn, NNCard, NNIcon, NNKbd, NNSkeleton, NNTag } from '@/components/ui';
import { newUuidV7, fieldPlainText, typedAnswerField, typedAnswerTarget, previewGrades, type StudySummary } from '@reomi/shared';
import { humanInterval } from '@/lib/fsrs';
import { api, ApiError, ok } from '@/lib/api';
import { cardFromApi, profileFromApi, reviewFromApi, mergeReviewedCard } from '@/lib/mappers';
import { RichCard } from '@/components/rich-card';
import { SimilarCardsList, useSimilarCards } from '@/components/similar-cards';
import { SourcePeekChip, SourcePeekPanel, useFirstCardSource } from '@/components/source-peek';
import { followCardSourceHref } from '@/lib/card-source-link';
import { Modal } from '@/components/design-system/modal';
import { ReviewSessionDone } from '@/components/review-session-done';
import { raiseToast } from '@/components/toasts';
import { useT, useLocale } from '@/lib/i18n';
import { mirrorAccountGeneration, useNN } from '@/lib/store';
import { useBreakpoint } from '@/lib/use-breakpoint';
import { useEmptyRedirect } from '@/lib/use-empty-redirect';
import { resolveDeckConfigClient } from '@/lib/deck-config';
import { toApiError } from '@/lib/resource-state';
import { clearStudyHandoff, createAnswerTimer, createStudyClock, readStudyCheckpoint, writeStudyCheckpoint, type StudyCheckpoint, type PendingStudyGrade, emptyStudySession, mergeStudyQueue, readStudyHandoff, recordStudyAnswer, saveStudyHandoff, undoStudyAnswer, skipStudyCard, studyTotals } from '@/lib/review-session';
import { reconcileStudyCheckpoint } from '@/lib/study-recovery';
import { diffAnswer } from '@/lib/review-answer';
import { clearStudyResult, saveStudyResult } from '@/lib/study-result';
import { hasBlockingReviewOverlay, isReviewEditingTarget, isReviewInteractiveTarget } from '@/lib/review-interactions';
import type { Card, CardSourceLink, Rating } from '@/lib/types';

type RatingMeta = {
  k: Rating;
  labelKey: string;
  tone: 'rose' | 'amber' | 'lime' | 'sky';
  hue: string;
  bg: string;
  bgHover: string;
};

// Subtle tonal градация — each rating carries its semantic hue only on the
// keycap chip + the interval, with a near-invisible tinted surface that lifts on
// hover. No acid fills; the row reads as one calm control strip, not four loud
// buttons.
const RATINGS: RatingMeta[] = [
  { k: 1, labelKey: 'review.ratings.again', tone: 'rose', hue: 'var(--rose-400)', bg: 'color-mix(in srgb, var(--rose-400) 5%, transparent)', bgHover: 'color-mix(in srgb, var(--rose-400) 12%, transparent)' },
  { k: 2, labelKey: 'review.ratings.hard', tone: 'amber', hue: 'var(--amber-400)', bg: 'color-mix(in srgb, var(--amber-400) 5%, transparent)', bgHover: 'color-mix(in srgb, var(--amber-400) 12%, transparent)' },
  { k: 3, labelKey: 'review.ratings.good', tone: 'lime', hue: 'var(--lime-400)', bg: 'color-mix(in srgb, var(--lime-400) 5%, transparent)', bgHover: 'color-mix(in srgb, var(--lime-400) 12%, transparent)' },
  { k: 4, labelKey: 'review.ratings.easy', tone: 'sky', hue: 'var(--sky-400)', bg: 'color-mix(in srgb, var(--sky-400) 5%, transparent)', bgHover: 'color-mix(in srgb, var(--sky-400) 12%, transparent)' },
];

// Friendly label for the render-kind eyebrow (was a raw English token like
// "typein" sitting next to the tags — looked like a debug badge). Falls back to
// the kind string for any future render kinds.
const renderKindLabel = (kind: string, t: (k: string) => string): string => {
  switch (kind) {
    case 'cloze':
      return t('editor.variants.cloze');
    case 'typein':
      return t('editor.variants.type');
    default:
      return t('editor.variants.basic');
  }
};

export const NNReview = ({ variant: _variant = 'classic' }: { variant?: 'classic' }) => {
  const params = useSearchParams();
  const owner = useNN((s) => s.bootstrapped ? s.profile?.userId ?? 'ready' : 'loading');
  const navigation=useNavigationWorkspace();
  return <NNReviewClassic key={`${owner}:${navigation?.entry?.id??''}:${params.get('deck') ?? ''}:${params.get('filteredDeckId') ?? ''}`} />;
};

// ─────────────────────────────────────────────
// Variant A: Classic — functional flip card backed by store + FSRS
// ─────────────────────────────────────────────
export const NNReviewClassic = () => {
  const [inspectorWidth, setInspectorWidth] = useState<number>(REVIEW_INSPECTOR.default);
  useLayoutEffect(() => setInspectorWidth(readReviewInspectorWidth()), []);
  const resizeInspector = useCallback((value: number) => {
    const width = boundedPanelWidth(value, REVIEW_INSPECTOR.min, REVIEW_INSPECTOR.max, REVIEW_INSPECTOR.default);
    setInspectorWidth(width);
    try { writeBrowserValue(localStorage, REVIEW_INSPECTOR.key, String(width)); } catch {}
  }, []);
  const inspectorStyle = { '--review-inspector-width': `${inspectorWidth}px` } as React.CSSProperties;
  const t = useT();
  const { locale } = useLocale();
  useEmptyRedirect('first-run');
  const router = useAppNavigation();
  const navigation=useNavigationWorkspace();
  const searchParams = useSearchParams();
  const filteredDeckId = searchParams.get('filteredDeckId') ?? undefined;
  // deck= param from the decks screen "Review" button (per-deck scoped queue).
  const deckId = searchParams.get('deck') ?? undefined;
  const resumeCardId = searchParams.get('resume');
  const reviewHref = filteredDeckId ? `/review?filteredDeckId=${encodeURIComponent(filteredDeckId)}` : deckId ? `/review?deck=${encodeURIComponent(deckId)}` : '/review';
  const bp = useBreakpoint();
  const isMobile = bp === 'mobile';
  const bootstrapped = useNN((s) => s.bootstrapped);
  const decks = useNN((s) => s.decks);
  const noteTypes = useNN((s) => s.noteTypes);
  const catalogAtLoad = useRef(noteTypes);
  const filteredDecks = useNN((s) => s.filteredDecks);
  const presets = useNN((s) => s.presets);
  const profile = useNN((s) => s.profile);
  const grade = useNN((s) => s.gradeCard);
  const undoLastReview = useNN((s) => s.undoLastReview);

  const [seed]=useState(()=>({current:readStudyCheckpoint(profile?.userId,reviewHref,navigation?.entry?.views.review?.fields.sessionId as string|undefined)}));
  const [sessionId]=useState(()=>({current:(navigation?.entry?.views.review?.fields.sessionId as string|undefined)??newUuidV7()}));
  const checkpointReady=useRef(Boolean(seed.current));
  const needsReconciliation=useRef(Boolean(seed.current));
  const acceptUpdated=useRef(false);
  const editingCardId=useRef(seed.current?.view.editingCardId??null);
  const [pendingOperation,setPendingOperation]=useState<PendingStudyGrade|null>(seed.current?.pending??null);
  const pendingOperationRef=useRef(pendingOperation);pendingOperationRef.current=pendingOperation;
  const [session, setSession] = useState(() => seed.current?.session ?? readStudyHandoff(profile?.userId, reviewHref, resumeCardId) ?? emptyStudySession());
  const [finished, setFinished] = useState(seed.current?.view.finished??false);
  const [queueLoading, setQueueLoading] = useState(true);
  const [queueError, setQueueError] = useState<ApiError | null>(null);
  const [queueAttempt, setQueueAttempt] = useState(0);
  const [summary, setSummary] = useState<StudySummary | null>(null);
  const clock=useRef(createStudyClock());
  const queueRequestActive = useRef(false);
  const [clockRevision,setClockRevision]=useState(0);
  const [revealed, setRevealed] = useState(seed.current?.view.revealed??false);
  const [infoOpen, setInfoOpen] = useState(seed.current?.view.infoOpen??false);
  // Feature #1 — «провал → источник». On a lapse (Again) for a card WITH
  // provenance we HOLD the queue advance and surface the cited passage right in
  // the reviewer (an overlay popover). The grade already committed server-side;
  // only the visual advance waits for «понятно, дальше» / Esc. null = no peek.
  const [pendingPeek, setPendingPeek] = useState<CardSourceLink | null>(seed.current?.view.pendingPeek??null);
  const totals = useMemo(() => studyTotals(session.history), [session.history]);
  const completed = totals.answers;
  const xpGained = totals.xp;
  const gradeCounts = totals.grades;
  const queue = session.pending;
  const [answerTimer]=useState(()=>{const current=createAnswerTimer();current.restore(seed.current?.view.elapsedMs??0);return {current};});
  // 'regular' | 'filtered' — populated from the queue envelope's `mode` field
  const [sessionMode, setSessionMode] = useState<'regular' | 'filtered'>('regular');

  // Type variant state
  const [typedAnswer, setTypedAnswer] = useState(seed.current?.view.typedAnswer??'');
  const [submitted, setSubmitted] = useState(seed.current?.view.submitted??false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);


  const lockRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const [busy, setBusy] = useState(false);
  const [mutationError, setMutationError] = useState<ApiError | null>(null);
  const cardUnavailable = mutationError?.status === 404 || mutationError?.status === 409;
  const sessionSavedRef = useRef(false);
  const [undoBlocked, setUndoBlocked] = useState(false);
  const canUndo = session.history.length > 0 && !undoBlocked && !pendingOperation && !queueLoading;

  const recoveryState=useRef<StudyCheckpoint>(null!);
  recoveryState.current={id:sessionId.current,owner:profile?.userId??'',href:reviewHref,session,
    view:{revealed,submitted,typedAnswer,elapsedMs:answerTimer.current.elapsed(),finished,infoOpen,pendingPeek,editingCardId:editingCardId.current},pending:pendingOperation};
  const storageWarned=useRef(false);
  const persist=useCallback((override?:Partial<StudyCheckpoint>)=>{
    if(!checkpointReady.current||!profile?.userId||useNN.getState().profile?.userId!==profile.userId)return;
    answerTimer.current.heartbeat();
    const value={...recoveryState.current,...override};value.view={...value.view,elapsedMs:override?.view?.elapsedMs??answerTimer.current.elapsed()};recoveryState.current=value;
    if(!writeStudyCheckpoint(value)&&!storageWarned.current){storageWarned.current=true;raiseToast({kind:'info',title:t('review.recovery.storageUnavailable')});}
  },[profile?.userId,t]);
  useEffect(()=>{navigation?.journal?.field('review','sessionId',sessionId.current,navigation.entry?.id);},[navigation?.journal,navigation?.entry?.id]);
  useEffect(()=>navigation?.capture(()=>persist()),[navigation?.capture,persist]);
  useEffect(()=>{const timer=setTimeout(()=>persist(),150);return()=>clearTimeout(timer);},[session,revealed,submitted,typedAnswer,finished,infoOpen,pendingPeek,pendingOperation,persist]);
  useEffect(()=>{const save=()=>persist();window.addEventListener('pagehide',save);let ticks=0;const timer=setInterval(()=>{answerTimer.current.heartbeat();if(++ticks%5===0)persist();},1000);
    return()=>{clearInterval(timer);window.removeEventListener('pagehide',save);answerTimer.current.heartbeat();answerTimer.current.pause();persist();};},[persist]);
  const timerCard=useRef(seed.current?.session.activeId??null);
  const inspectorCard=useRef(seed.current?.session.activeId??null);

  const refreshQueue = useCallback(() => {
    setQueueLoading(true);
    setQueueAttempt((n) => n + 1);
  }, []);

  // Refetch at entry, after an exhausted batch, or when a learning step is due.
  useEffect(() => {
    if (!bootstrapped) return;
    let cancelled = false;
    queueRequestActive.current = true;
    setQueueLoading(true);
    setQueueError(null);
    (async () => {
      const account = mirrorAccountGeneration();
      try {
        const query: Record<string, string> = {};
        if (filteredDeckId) query.filteredDeckId = filteredDeckId;
        if (deckId) query.deckId = deckId;
        const started = performance.now();
        let res: any = await ok(await (api as any).cards.queue.get({ query }));
        // A slow empty response may already have crossed its learning deadline.
        // Recheck once instead of starting a fresh full wait from stale serverNow.
        const snapshotAt = Date.parse(res?.summary?.serverNow ?? '');
        const nextDue = Date.parse(res?.summary?.nextLearningAt ?? '');
        if (!cancelled && !res?.due?.length && !res?.new?.length && Number.isFinite(snapshotAt)
          && Number.isFinite(nextDue) && nextDue <= snapshotAt + performance.now() - started) {
          res = await ok(await (api as any).cards.queue.get({ query }));
        }
        if (mutationError && !cancelled) {
          // A lost response may have committed, or another tab may have graded.
          // Reconcile account totals as well as the queue during recovery.
          const latest = await ok(await api.profile.get()).catch(() => null);
          if (!cancelled && account === mirrorAccountGeneration() && latest?.userId === profile?.userId && latest?.userId) {
            useNN.setState({ profile: profileFromApi(latest) });
          }
        }
        if (cancelled) return;
        catalogAtLoad.current = useNN.getState().noteTypes;
        const due = ((res?.due ?? []) as any[]).map(cardFromApi);
        const fresh = ((res?.new ?? []) as any[]).map(cardFromApi);
        const q = [...due, ...fresh];
        const mode=res?.mode==='filtered'?'filtered':'regular';
        setSessionMode(mode);setSummary(res?.summary??null);
        const serverNow=res?.summary?.serverNow?new Date(res.summary.serverNow).getTime():Date.now();
        clock.current.sync(serverNow);setClockRevision(n=>n+1);
        const base=recoveryState.current;
        const editorReturn=readStudyHandoff(profile?.userId,reviewHref,resumeCardId);
        const fromEditor=Boolean(base.session.activeId&&(editingCardId.current===base.session.activeId||editorReturn?.activeId===base.session.activeId));
        if(checkpointReady.current && (needsReconciliation.current||base.pending)) {
          const recovered=await reconcileStudyCheckpoint(base,q,mode,serverNow,{
            card:async id=>{const queued=q.find(card=>card.id===id);if(queued)return queued;try{return cardFromApi(await ok(await (api as any).cards({id}).get()));}catch(error){if((error as ApiError).status===404)return null;throw error;}},
            reviews:async ids=>((await ok(await (api as any).reviews.records.get({query:{ids:ids.join(',')}}))) as any).items.map(reviewFromApi),
            operation:async operation=>{try{const receipt:any=await ok(await (api as any).reviews.operations({operationId:operation.id}).get());
              return receipt.status==='committed'?{status:'committed',result:{...reviewFromApi(receipt.result.review),card:mergeReviewedCard(receipt.result.card,operation.before)}}:{status:'reverted'};
            }catch(error){if((error as ApiError).status===404)return {status:'missing'};throw error;}},
          },acceptUpdated.current||fromEditor);
          if(cancelled)return;needsReconciliation.current=false;
          const accepted=recovered.acceptedUpdate;acceptUpdated.current=false;editingCardId.current=null;recovered.view.editingCardId=null;
          if(editorReturn)clearStudyHandoff();
          if(recovered.session.activeId===base.session.activeId&&recoveryState.current.session.activeId===base.session.activeId){
            recovered.view={...recovered.view,typedAnswer:recoveryState.current.view.typedAnswer,...(!accepted?{revealed:recoveryState.current.view.revealed,submitted:recoveryState.current.view.submitted}:{})};
          }
          setSession(recovered.session);setRevealed(recovered.view.revealed);setSubmitted(recovered.view.submitted);setTypedAnswer(recovered.view.typedAnswer);
          setFinished(recovered.view.finished);setInfoOpen(recovered.view.infoOpen);setPendingPeek(recovered.view.pendingPeek);
          pendingOperationRef.current=recovered.pending;setPendingOperation(recovered.pending);
          timerCard.current=recovered.session.activeId;answerTimer.current.restore(recovered.view.elapsedMs);
          setMutationError(recovered.stale?new ApiError('card_changed',{status:recovered.stale==='missing'?404:409}):recovered.pending?new ApiError('grade_unconfirmed',{status:0}):null);
          persist({session:recovered.session,view:recovered.view,pending:recovered.pending});
        } else {
          const handoff=readStudyHandoff(profile?.userId,reviewHref,resumeCardId);
          const resumeId=resumeCardId??handoff?.activeId??null;
          const merged=mergeStudyQueue(handoff??base.session,q,mode,serverNow);
          if(handoff&&q.some(card=>card.id===resumeId))merged.activeId=resumeId;
          setSession(merged);if(handoff)clearStudyHandoff();
          setRevealed(false);setSubmitted(false);setTypedAnswer('');setMutationError(null);
          timerCard.current=merged.activeId;answerTimer.current.reset(false);checkpointReady.current=true;
          persist({session:merged,view:{...base.view,revealed:false,submitted:false,typedAnswer:'',elapsedMs:0},pending:null});
        }
      } catch (error) {
        if (!cancelled) {setQueueError(toApiError(error));if((error as ApiError).status===401){persist();router.replace(`/auth/sign-in?next=${encodeURIComponent(reviewHref)}`);}}
      } finally {
        if (!cancelled) { queueRequestActive.current = false; setQueueLoading(false); }
      }
    })();
    return () => { cancelled = true; queueRequestActive.current = false; };
  }, [bootstrapped, queueAttempt]);

  const current = finished ? undefined : pendingPeek ? session.history.at(-1)?.before : queue.find((c) => c.id === session.activeId);
  useAssistantPageContext(current ? { kind: 'card', id: current.id } : null);
  const related = useSimilarCards(revealed ? current?.id ?? null : null);
  useEffect(()=>{if(inspectorCard.current!==current?.id)setInfoOpen(false);inspectorCard.current=current?.id??null;},[current?.id]);
  useEffect(() => {
    if (!current?.noteType || queueLoading || noteTypes === catalogAtLoad.current) return;
    const latest = noteTypes.find((type) => type.id === current.noteType!.id);
    const renderKey = (type: { kind: string; templates: { ord: number; frontTemplate: string; backTemplate: string }[] }) =>
      JSON.stringify([type.kind, type.templates.map((template) => [template.ord, template.frontTemplate, template.backTemplate])]);
    if (!latest || (latest.updatedAt && current.noteType.updatedAt && latest.updatedAt > current.noteType.updatedAt) ||
      renderKey(latest) !== renderKey(current.noteType)) {
      setMutationError(new ApiError('card_changed', { status: 409 }));
    }
  }, [current, noteTypes, queueLoading]);
  useEffect(() => {
    if (!queueLoading && current && current.renderKind !== 'typein' && !document.querySelector('[aria-modal="true"]')) {
      cardRef.current?.focus({ preventScroll: true });
    }
  }, [current?.id, current?.updatedAt, current?.renderKind, queueLoading]);
  useEffect(()=>{if(timerCard.current!==current?.id){timerCard.current=current?.id??null;answerTimer.current.reset(Boolean(current)&&!document.hidden&&!queueLoading);}},[current?.id,queueLoading]);
  useEffect(() => {
    const update = () => {
      if (document.hidden || !current || busy || pendingPeek || queueLoading) answerTimer.current.pause();
      else answerTimer.current.resume();
    };
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, [current?.id, busy, pendingPeek, queueLoading]);
  useEffect(()=>{
    let scheduled:ReturnType<typeof setTimeout>|undefined;
    const wake=()=>{if(document.hidden){answerTimer.current.heartbeat();answerTimer.current.pause();persist();return;}
      if(lockRef.current||queueRequestActive.current||scheduled!==undefined)return;
      answerTimer.current.heartbeat();needsReconciliation.current=true;scheduled=setTimeout(()=>{scheduled=undefined;refreshQueue();},0);};
    const changed=(event:StorageEvent)=>{const legacy=`nn:study:changed:${profile?.userId}`;if(event.key===legacy||event.key===currentStorageKey(legacy))wake();};
    window.addEventListener('focus',wake);document.addEventListener('visibilitychange',wake);window.addEventListener('storage',changed);
    return()=>{if(scheduled!==undefined)clearTimeout(scheduled);window.removeEventListener('focus',wake);document.removeEventListener('visibilitychange',wake);window.removeEventListener('storage',changed);};
  },[refreshQueue,persist]);
  const editHref = current ? `/editor?${new URLSearchParams({ card: current.id, returnTo: `${reviewHref}${reviewHref.includes('?') ? '&' : '?'}resume=${current.id}` })}` : '/editor';
  const handleEdit = useCallback(() => {
    if (!current || lockRef.current || pendingPeek) return;
    if (profile?.userId) saveStudyHandoff(profile.userId, reviewHref, current.id, session);
    editingCardId.current=current.id;persist({view:{...recoveryState.current.view,editingCardId:current.id}});
    router.push(editHref);
  }, [current, pendingPeek, profile?.userId, reviewHref, session, router, editHref, persist]);
  const deck = useMemo(() => (current ? decks.find((d) => d.id === current.deckId) : undefined), [current, decks]);

  // Feature #1 — the current card's first cited source (null when hand-authored).
  // Drives the post-reveal provenance chip AND the lapse peek. The hook is a
  // no-op without provenance, so manual cards stay clean.
  const firstSource = useFirstCardSource(current?.id ?? null);

  // Resolve per-deck FSRS config so preview intervals match what the server
  // will actually schedule (mirrors server deck-config.ts resolveDeckConfig).
  const currentDeckConfig = useMemo(
    () => resolveDeckConfigClient(current?.deckId, decks, presets, profile),
    [current?.deckId, decks, presets, profile],
  );

  const previews = useMemo(() => {
    if (!current) return null;
    const at = new Date(clock.current.now());
    return { at, cards: previewGrades(current.fsrs, at, {
      requestRetention: currentDeckConfig.desiredRetention,
      learningSteps: currentDeckConfig.learningSteps,
      relearningSteps: currentDeckConfig.relearningSteps,
      maximumInterval: currentDeckConfig.maximumInterval,
    }) };
  }, [current, currentDeckConfig, clockRevision, revealed]);



  // An initial recovered card already owns its answer state.
  const answerCard=useRef(seed.current?.view.pendingPeek?seed.current.session.history.at(-1)?.before.id:seed.current?.session.activeId);
  useEffect(() => {
    if(answerCard.current===current?.id)return;answerCard.current=current?.id;
    setTypedAnswer('');
    setSubmitted(false);
    setRevealed(false);
  }, [current?.id]);

  // A restored question must not summon the mobile keyboard.
  const firstInputCard=useRef<string|null>(null);
  useEffect(() => {
    if(current?.id&&!firstInputCard.current)firstInputCard.current=current.id;
    if((seed.current||navigation?.restored)&&firstInputCard.current===current?.id)return;
    if (current?.renderKind === 'typein' && !submitted) {
      const t = setTimeout(() => inputRef.current?.focus({preventScroll:true}), 0);
      return () => clearTimeout(t);
    }
  }, [current?.id, current?.renderKind, submitted]);

  const resetAnswer = useCallback(() => {
    setRevealed(false);
    setSubmitted(false);
    setTypedAnswer('');
    answerTimer.current.reset(!document.hidden);
  }, []);

  const advanceQueue = useCallback(() => {
    setPendingPeek(null);
    resetAnswer();
    if (!session.activeId && sessionMode === 'regular') refreshQueue();
  }, [session.activeId, sessionMode, refreshQueue, resetAnswer]);

  const handleGrade = useCallback(async (rating: Rating) => {
    if (!current || lockRef.current || queueLoading || !revealed || pendingPeek || (cardUnavailable&&!pendingOperationRef.current)) return;
    if(pendingOperationRef.current&&pendingOperationRef.current.rating!==rating)return;
    if (current.renderKind === 'typein' && !submitted) return;
    lockRef.current = true;
    answerTimer.current.pause();
    setBusy(true);
    setMutationError(null);
    try {
      const operation=pendingOperationRef.current??{id:newUuidV7(),cardId:current.id,rating,durationMs:answerTimer.current.elapsed(),mode:sessionMode,before:current};
      pendingOperationRef.current=operation;setPendingOperation(operation);checkpointReady.current=true;persist({pending:operation});
      const saved = await grade(operation.cardId, operation.rating, operation.durationMs, operation.mode, operation.before, operation.id);
      if (!mountedRef.current) return;
      pendingOperationRef.current=null;setPendingOperation(null);
      const next = recordStudyAnswer(session, operation.before, saved.card, saved, sessionMode, clock.current.now());
      persist({session:next,pending:null,view:{...recoveryState.current.view,revealed:false,submitted:false,typedAnswer:'',elapsedMs:0,pendingPeek:null}});
      setSession(next);
      setUndoBlocked(false);
      if (rating === 1 && firstSource?.sourceId) {
        setPendingPeek(firstSource);
      } else {
        resetAnswer();
        if (!next.activeId && sessionMode === 'regular') refreshQueue();
      }
    } catch (err) {
      if (mountedRef.current) {
        const error=toApiError(err);setMutationError(error);needsReconciliation.current=true;
        if([400,404,409].includes(error.status)){pendingOperationRef.current=null;setPendingOperation(null);persist({pending:null});}
        if(error.status===401){persist();router.replace(`/auth/sign-in?next=${encodeURIComponent(reviewHref)}`);}
      }
    } finally {
      lockRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [current, grade, session, sessionMode, clockRevision, submitted, revealed, pendingPeek, cardUnavailable, firstSource, refreshQueue, resetAnswer, queueLoading, persist, router]);

  const handleUndo = useCallback(async () => {
    const last = session.history.at(-1);
    if (!last || lockRef.current || !canUndo || queueLoading) return;
    lockRef.current = true;
    setBusy(true);
    try {
      const restored = await undoLastReview(last.review.id, last.before);
      if (!mountedRef.current) return;
      setSession((previous) => undoStudyAnswer(previous, restored.card, restored.reviewId));
      setFinished(false);
      setPendingPeek(null);
      setMutationError(null);
      resetAnswer();
      raiseToast({ kind: 'info', description: t('editor.review.undo.toast') });
    } catch (error) {
      if (!mountedRef.current) return;
      const code = (error as { code?: string }).code;
      if (code === 'review_changed' || code === 'card_modified_since_review' || code === 'nothing_to_undo') setUndoBlocked(true);
      raiseToast({ kind: 'error', description: t(code === 'review_changed' ? 'review.undoChanged'
        : code === 'card_modified_since_review' ? 'editor.review.undo.modified'
        : code === 'nothing_to_undo' ? 'editor.review.undo.empty' : 'review.undoFailed') });
    } finally {
      lockRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }, [session.history, canUndo, queueLoading, undoLastReview, resetAnswer, t]);

  const handleSkip = useCallback(() => {
    if (lockRef.current || pendingPeek || pendingOperationRef.current || !current) return;
    const next = skipStudyCard(session, sessionMode, clock.current.now());
    if (next.activeId === session.activeId) return;
    setSession(next);
    resetAnswer();
  }, [current, pendingPeek, session, sessionMode, clockRevision, resetAnswer]);

  const handleTypeSubmit = useCallback(() => {
    if (!current || current.renderKind !== 'typein' || submitted || lockRef.current) return;
    inputRef.current?.blur();
    setSubmitted(true);
    setRevealed(true);
  }, [current, submitted]);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (lockRef.current || e.defaultPrevented || e.repeat || e.isComposing) return;
      if ((e.metaKey || e.ctrlKey || e.altKey) && !((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey && !e.altKey)) return;
      const inInput = isReviewEditingTarget(e.target);
      if (inInput) return;
      if (hasBlockingReviewOverlay(document, Boolean(pendingPeek))) return;

      // Escape: a held lapse-peek closes FIRST and advances (the grade already
      // committed); otherwise exit the reviewer to home.
      if (e.key === 'Escape') {
        if (pendingPeek) {
          e.preventDefault();
          advanceQueue();
          return;
        }
        e.preventDefault();
        router.push('/');
        return;
      }

      // Undo last grade — ⌘Z / Ctrl+Z. Works outside inputs only (don't steal
      // the native undo while typing). Available even on the done screen so the
      // user can still revert the final grade.
      if ((e.key === 'z' || e.key === 'Z') && (e.metaKey || e.ctrlKey) && !e.shiftKey && !inInput) {
        e.preventDefault();
        handleUndo();
        return;
      }

      // Let native button/link activation handle Space and Enter exactly once.
      if (isReviewInteractiveTarget(e.target)) return;

      if (!current) return;

      // While a lapse-peek is held, the card is already graded — swallow
      // navigation/flip/grade keys (Esc above is the way out). Edit/undo still
      // worked above; everything below is queue-movement that the peek defers.
      if (pendingPeek) return;

      // Edit shortcut — only outside inputs
      if ((e.key === 'e' || e.key === 'E') && !inInput) {
        e.preventDefault();
        handleEdit();
        return;
      }

      // Skip keeps the unanswered card in this session. Undo is the only
      // way back to a previously saved answer.
      if (e.key.toLowerCase() === 'k' && !inInput) {
        e.preventDefault();
        handleSkip();
        return;
      }

      // Space — flip / submit
      if (e.code === 'Space') {
        if (current.renderKind === 'typein') {
          if (submitted) return; // noop — answer already visible
          if (inInput) return; // let user type spaces in the input
          e.preventDefault();
          handleTypeSubmit();
          return;
        }
        if (inInput) return;
        e.preventDefault();
        setRevealed((v) => !v);
        return;
      }

      // Grade keys
      if (!revealed) return;
      if (current.renderKind === 'typein' && !submitted) return;
      if (inInput) return;
      if (e.key === '1') handleGrade(1);
      else if (e.key === '2') handleGrade(2);
      else if (e.key === '3') handleGrade(3);
      else if (e.key === '4') handleGrade(4);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [revealed, current, handleGrade, handleUndo, router, handleEdit, handleSkip, submitted, handleTypeSubmit, pendingPeek, advanceQueue]);

  const sessionDone = completed > 0 && !pendingPeek && (finished || (!current && queue.length === 0)) && !queueLoading && !queueError;
  const nextLearningAt = queue.length > 0 && !current
    ? new Date(Math.min(...queue.map((card) => new Date(card.fsrs.due).getTime()))).toISOString()
    : summary?.nextLearningAt ?? null;

  useEffect(() => {
    if (current || finished || busy || pendingPeek || queueLoading || queueError || !nextLearningAt) return;
    const dueAt = Date.parse(nextLearningAt);
    let fired = false;
    const resume = () => {
      if (!fired && !document.hidden && clock.current.now() >= dueAt) {
        fired = true;
        refreshQueue();
      }
    };
    const timer = setTimeout(resume, Math.min(2_147_483_647, Math.max(250, dueAt - clock.current.now() + 50)));

    return () => {
      clearTimeout(timer);

    };
  }, [current, finished, busy, pendingPeek, queueLoading, queueError, nextLearningAt, clockRevision, refreshQueue]);

  // Only successful server answers enter this snapshot. Undo invalidates a
  // previously saved result; a later completion writes the revised totals.
  useEffect(() => {
    if (!sessionDone) {
      if (sessionSavedRef.current) {
        sessionSavedRef.current = false;
        if (profile?.userId) clearStudyResult(profile.userId);
      }
      return;
    }
    const deckIds = new Set(session.history.map((entry) => entry.before.deckId));
    const deckName = filteredDeckId ? filteredDecks.find((deck) => deck.id === filteredDeckId)?.name ?? t('review.customStudy.title')
      : deckId ? decks.find((deck) => deck.id === deckId)?.name ?? t('review.queueFallback')
      : deckIds.size > 1 ? t('review.mixedQueue') : decks.find((d) => deckIds.has(d.id))?.name ?? t('review.queueFallback');
    if (!profile?.userId) return;
    saveStudyResult({ version: 1, userId: profile.userId, completedAt: Date.now(), deckName,
      answers: completed, cards: totals.uniqueCards, xpGained, durationMs: totals.durationMs,
      grades: gradeCounts, mode: sessionMode, reviewHref });
    sessionSavedRef.current = true;
  }, [sessionDone, session.history, completed, xpGained, totals, gradeCounts, decks, deckId, filteredDecks, filteredDeckId, sessionMode, reviewHref, profile?.userId, t]);

  if (!bootstrapped || queueLoading) {
    return <ReviewSkeleton isMobile={isMobile} inspectorWidth={inspectorWidth} />;
  }

  if (queueError) {
    return <ReviewEmpty role="alert" title={t('review.loadFailed')}
      subtitle={t(queueError.status === 400 || queueError.status === 404 ? 'review.queueMissing' : 'review.loadFailedBody')}
      cta={t('review.retry')} onAction={() => setQueueAttempt((n) => n + 1)}
      customStudyHref="/decks" customStudyLabel={t('nav.decks')} />;
  }

  if (sessionDone) return <ReviewSessionDone completed={completed} xp={xpGained} stats={{ cards: totals.uniqueCards, durationMs: totals.durationMs, grades: gradeCounts, answers: session.history.map(({ review }) => ({ durationMs: review.durationMs, rating: review.rating })) }} onUndo={canUndo ? handleUndo : undefined} busy={busy} />;

  if (!current) {
    const reason = sessionMode === 'filtered' ? 'filtered'
      : summary?.total === 0 ? 'empty'
      : summary && summary.total === summary.suspendedCount ? 'paused'
      : nextLearningAt ? 'waiting'
      : summary && (summary.limitedNew > 0 || summary.limitedReview > 0) ? 'limited'
      : null;
    if (reason) {
      const next = nextLearningAt;
      const time = next ? new Date(next).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      return <ReviewEmpty role="status" title={t(`review.emptyStates.${reason}.title`)}
        subtitle={`${t(`review.emptyStates.${reason}.body`, { time })}${reason === 'waiting' ? ` ${t('review.waitingAuto')}` : ''}`}
        cta={reason === 'waiting' ? undefined : t(reason === 'empty' ? 'review.allCaught.cta' : reason === 'paused' ? 'nav.cards' : 'review.refreshQueue')}
        actionVariant="soft"
        href={reason === 'empty' ? `/editor${deckId ? `?deck=${deckId}` : ''}` : reason === 'paused' ? '/cards?q=is%3Asuspended' : undefined}
        onAction={reason === 'empty' || reason === 'paused' || reason === 'waiting' ? undefined : () => setQueueAttempt((n) => n + 1)}
        customStudyHref={sessionMode === 'filtered' ? '/review/custom-study' : '/decks'}
        customStudyLabel={t(sessionMode === 'filtered' ? 'review.customStudy.manage' : 'nav.decks')}
        actions={<>
          {canUndo && <NNBtn variant="soft" onClick={handleUndo} loading={busy}>{t('editor.review.undo.button')}</NNBtn>}
          {completed > 0 && reason !== 'waiting' && <NNBtn variant="primary" disabled={busy} onClick={() => setFinished(true)}>{t('review.finish')}</NNBtn>}
        </>} />;
    }
    return (
      <ReviewEmpty
        title={t('review.allCaught.title')}
        subtitle={t('review.allCaught.subtitle')}
        cta={t('review.allCaught.cta')}
        href="/editor"
        customStudyHref="/decks"
        customStudyLabel={t('nav.decks')}
      />
    );
  }

  const total = completed + queue.length;
  const progress = total > 0 ? (completed / total) * 100 : 0;
  const fsrsState = current.fsrs;
  const elapsed = fsrsState.last_review
    ? Math.max(0, Math.floor((Date.now() - new Date(fsrsState.last_review).getTime()) / (1000 * 60 * 60 * 24)))
    : null;

  const renderKind = current.renderKind;
  const isCloze = renderKind === 'cloze';
  const isTypein = renderKind === 'typein';

  // Lazy HTML render from the note-type template + the note's sanitized field
  // values, via <RichCard> (markdown + math + code + async mermaid → DOMPurified
  // at the single SafeHtml edge it wraps). cloze front = prompt (blanks), back =
  // revealed. The queue payload embeds note + noteType (C-5), so render mode +
  // content come from the payload with no extra fetch.
  const renderNoteType = current.noteType ?? null;
  const renderFieldValues = current.note?.fieldValues ?? {};
  // For cloze, the FRONT card area flips between the prompt (front) and the
  // revealed answer (back) by switching the rendered SIDE.
  const promptSide: 'front' | 'back' = isCloze ? (revealed ? 'back' : 'front') : 'front';
  // The embedded role travels with the exact type version displayed by this card.
  const typeinFields = renderNoteType?.fields ?? noteTypes.find((nt) => nt.id === renderNoteType?.id)?.fields ?? [];
  const typeinTargetField = typedAnswerField(typeinFields)?.name;
  const canonicalAnswer = fieldPlainText((typeinTargetField ? renderFieldValues[typeinTargetField] : undefined) ?? renderFieldValues['Back'] ?? current.renderBackText);
  const typeinTarget = typedAnswerTarget(typedAnswer, canonicalAnswer, current.note?.acceptedAnswers);

  // Sans (not display-serif) at a sane scale — the old 48px serif both read as
  // "местами очень большой шрифт" and, being the em-base for the whole rendered
  // subtree, ballooned inline code / tables. Question stays the largest element
  // but no longer dominates; cloze a touch smaller (the prompt carries blanks).
  const frontFontSize = isMobile
    ? (isCloze ? 21 : 23)
    : (isCloze ? 24 : 26);

  // Which section controls reveal/ratings visibility per render kind.
  const showAnswerSection = isTypein ? submitted : revealed;
  const showRatings = showAnswerSection;

  const cardInfo = <>
    <ReviewCardInfo card={current} deckName={deckPathLabel(decks, current.deckId) || t('review.queueFallback')} />
    {revealed && related.items.length > 0 && <section className="reomi-review-related"><h3>{t('review.similar.title')}</h3><SimilarCardsList items={related.items} onOpen={id => router.push(`/cards?focus=${id}`)} /></section>}
  </>;

  return (
    <div className="reomi-review-layout nn-review-layout" style={inspectorStyle} aria-busy={busy || undefined}><div className="reomi-review-panels">
    <div className="reomi-review-workspace">
      <div className="reomi-review-scroll nn-review-scroll nn-scroll">
      <div className="reomi-review-tools">
        <div className="reomi-review-context">
          <span className="mono" style={{ color: 'var(--text-muted)', fontSize: 12 }}>+{xpGained} XP</span>
          {sessionMode === 'filtered' && <NNBadge size="sm" tone="violet">{t('review.customStudy.filterBadge')}</NNBadge>}
          <NNBadge size="xs" tone="neutral">
            {renderKindLabel(renderKind, t)}
          </NNBadge>
          {current.tags.map((t) => (
            <NNTag key={t} color={deck?.color === 'neutral' ? 'sky' : deck?.color ?? 'sky'}>
              {t}
            </NNTag>
          ))}
        </div>

      </div>
        <div style={{ width: '100%', maxWidth: 760, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
          <div role="progressbar" aria-label={t('review.progress', { answers: completed, remaining: queue.length })}
            aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)}
            style={{ flex: 1, minWidth: 30, height: 5, background: 'var(--surface-3)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ width: `${progress}%`, height: '100%', background: 'var(--accent-400)', transition: 'width 200ms ease' }} />
          </div>
          <span className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{t('review.progress', { answers: completed, remaining: queue.length })}</span>


      </div>


      {/* Card */}
      {sessionMode === 'filtered' && <p style={{ width: '100%', maxWidth: 760, fontSize: 12, color: 'var(--text-muted)', margin: '0 0 12px' }}>{t('review.customStudy.scheduleNotice')}</p>}
      {mutationError && <div role="alert" style={{ width: '100%', maxWidth: 760, marginBottom: 12, color: 'var(--rose-400)', fontSize: 13 }}>
        {t(cardUnavailable ? 'review.cardChanged' : 'review.gradeFailed')}
        {pendingOperation && <NNBtn size="sm" variant="soft" disabled={busy||queueLoading} onClick={()=>void handleGrade(pendingOperation.rating)}>{t('review.recovery.retryGrade')}</NNBtn>}
        {cardUnavailable&&!pendingOperation&&typedAnswer&&<NNBtn size="sm" variant="ghost" onClick={()=>{setSession(previous=>({...previous,activeId:null,pending:previous.pending.filter(card=>card.id!==current.id)}));resetAnswer();setMutationError(null);needsReconciliation.current=false;refreshQueue();}}>{t('review.recovery.skipUnavailable')}</NNBtn>}
        {cardUnavailable && <NNBtn size="sm" variant="soft" onClick={() => {acceptUpdated.current=true;needsReconciliation.current=true;setQueueAttempt((n) => n + 1);}}>{t('review.refreshQueue')}</NNBtn>}
      </div>}
      {busy && <div role="status" style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 8 }}>{t('review.saving')}</div>}
      <div
        ref={cardRef}
        className="reomi-review-card nn-review-card"
        role="article"
        aria-label={t('review.cardLabel')}
        tabIndex={-1}
        onClick={(e) => {
          if (lockRef.current || pendingPeek) return;
          if (isReviewInteractiveTarget(e.target)) return;
          const selection = window.getSelection();
          if (selection?.toString() && selection.anchorNode && e.currentTarget.contains(selection.anchorNode)) return;
          if (isTypein && !submitted) return;
          setRevealed((v) => !v);

        }}
        data-revealed={showAnswerSection || undefined}
        style={{ cursor: !revealed && !isTypein ? 'pointer' : 'auto' }}
      >
        {/* Question eyebrow — explicit hierarchy label */}
        <div
          style={{
            fontSize: 10.5,
            fontWeight: 600,
            letterSpacing: 0,
            textTransform: 'none',
            color: 'var(--text-dim)',
            fontFamily: 'var(--font-sans)',
            marginBottom: 12,
          }}
        >
          {isCloze && revealed ? t('review.answerLabel') : t('review.questionLabel')}
        </div>

        {/* Front / prompt — rendered from the note-type template + field values
            via RichCard (single SafeHtml sink + async mermaid). Cloze shows
            blanks on the front; once revealed it switches to the answer side. */}
        {renderNoteType && (
          <RichCard
            className="reomi-review-question"
            noteType={renderNoteType}
            fieldValues={renderFieldValues}
            side={promptSide}
            templateOrd={current.templateOrd}
            clozeNumber={current.clozeNumber}
            style={{
              fontFamily: 'var(--font-sans)',
              fontSize: frontFontSize,
              lineHeight: 1.3,
              letterSpacing: -0.3,
              color: 'var(--text)',
              fontWeight: 600,
              wordBreak: 'break-word',
            }}
          />
        )}

        {/* Type input */}
        {isTypein && (
          <div style={{ marginTop: 28, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {!submitted && <input
              ref={inputRef}
              type="text"
              aria-label={t('review.type.label')}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="done"
              maxLength={2000}
              disabled={submitted||Boolean(pendingOperation)}
              value={typedAnswer}
              onChange={(e) => setTypedAnswer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !submitted && !e.nativeEvent.isComposing && !e.repeat) {
                  e.preventDefault();
                  handleTypeSubmit();
                }
              }}
              placeholder={t('review.type.placeholder')}
              style={{
                width: '100%',
                padding: '14px 16px',
                fontSize: 18,
                fontFamily: 'var(--font-sans)',
                borderRadius: 'var(--r-md)',
                border: '1px solid var(--border-2)',
                background: 'var(--surface-2)',
                color: 'var(--text)',
                outline: 'none',
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = 'var(--lime-500)';
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = 'var(--border-2)';
              }}
            />}
            {!submitted && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <NNBtn size="md" variant="primary" onClick={handleTypeSubmit}>
                  {t('review.type.checkBtn')}
                </NNBtn>
                <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                  {t('review.type.pressPrefix')} <NNKbd>Enter</NNKbd> {t('review.type.pressSuffix')}
                </span>
              </div>
            )}
            {submitted && (
              <div
                role="status"
                aria-label={t('review.type.checked')}
                style={{
                  padding: '12px 14px',
                  borderRadius: 'var(--r-md)',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  fontSize: 16,
                  lineHeight: 1.5,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
                className="mono"
              >
                <span style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' }}>{t('review.type.comparison', { typed: typedAnswer, answer: typeinTarget })}</span>
                <span aria-hidden="true">{diffAnswer(typedAnswer, typeinTarget).map((tok, i) => {
                  if (tok.kind === 'match') {
                    return (
                      <span key={i} style={{ color: 'var(--text)' }}>
                        {tok.ch}
                      </span>
                    );
                  }
                  if (tok.kind === 'extra') {
                    return (
                      <span
                        key={i}
                        style={{
                          color: 'var(--rose-500)',
                          textDecoration: 'line-through',
                        }}
                      >
                        {tok.ch}
                      </span>
                    );
                  }
                  return (
                    <span
                      key={i}
                      style={{
                        color: 'var(--rose-500)',
                        textDecoration: 'underline',
                        textDecorationStyle: 'dotted',
                      }}
                    >
                      {tok.ch}
                    </span>
                  );
                })}</span>
              </div>
            )}
          </div>
        )}

        {/* Divider + answer block — hidden for cloze (the prompt area itself
            flips to the answer side; rendering it here too would duplicate).
            For non-cloze, the answer is a quiet reveal: an "Answer" eyebrow, a
            thin accent rule on the left, and calm --text serif (NOT lime). */}
        {!isCloze && showAnswerSection && (
          <>
            <div className="reomi-review-answer">
              {showAnswerSection && renderNoteType && (
                <>
                  <div
                    style={{
                      fontSize: 10.5,
                      fontWeight: 600,
                      letterSpacing: 0,
                      textTransform: 'none',
                      color: 'var(--text-muted)',
                      fontFamily: 'var(--font-sans)',
                      marginBottom: 12,
                    }}
                  >
                    {t('review.answerLabel')}
                  </div>
                  <div
                    style={{
                      paddingLeft: 0,
                    }}
                  >
                    <RichCard
                      noteType={renderNoteType}
                      fieldValues={renderFieldValues}
                      side="back"
                      templateOrd={current.templateOrd}
            clozeNumber={current.clozeNumber}
                      className="reomi-review-answer-content"

                      style={{
                        fontSize: isMobile ? 16 : 17,
                        fontWeight: 400,
                        color: 'var(--text)',
                        letterSpacing: 0,
                        fontFamily: 'var(--font-sans)',
                        lineHeight: 1.6,
                        wordBreak: 'break-word',
                      }}
                    />
                  </div>
                </>
              )}
            </div>
          </>
        )}


      </div>

      {/* Feature #1 — post-reveal provenance chip. Shown after the answer is
          revealed for ANY grade, ONLY when the card has a usable cited source.
          Non-intrusive; an explicit click opens the library reader at the chunk. */}
      {showAnswerSection && firstSource && (
        <div
          style={{
            width: '100%',
            maxWidth: 760,
            marginTop: 12,
            display: 'flex',
            justifyContent: 'flex-start',
            flexShrink: 0,
          }}
        >
          <SourcePeekChip item={firstSource} onOpen={(href) => followCardSourceHref(href, (path) => router.push(path))} />
        </div>
      )}

      {/* Quiet meta + hotkey strip — moved OUT of the card so the card holds only
          the question/answer. FSRS stats left, navigation hints right, edit at
          the far end. Mono + dim, never competes with the content. */}
      <div
        style={{
          width: '100%',
          maxWidth: 760,
          marginTop: 14,
          display: 'flex',
          alignItems: 'center',
          gap: isMobile ? 10 : 16,
          fontSize: 11.5,
          color: 'var(--text-dim)',
          flexWrap: 'wrap',
          flexShrink: 0,
        }}
      >
        <span className="mono">
          {elapsed === 0 ? t('review.meta.today') : elapsed != null ? t('review.meta.lastAgo', { n: elapsed }) : t('review.meta.newCard')}
          {' · '}
          {t('review.meta.repetitions', { reps: fsrsState.reps, lapses: fsrsState.lapses })}
        </span>
        <div className="reomi-review-utilities">
          <span className="reomi-review-info-mobile"><NNBtn size="sm" variant="ghost" icon="info" onClick={() => setInfoOpen(true)}>{t('review.info.title')}</NNBtn></span>
          <NNBtn size="sm" variant="ghost" disabled={busy || Boolean(pendingOperation) || Boolean(pendingPeek) || skipStudyCard(session, sessionMode, clock.current.now()).activeId === session.activeId} onClick={handleSkip}><NNKbd>K</NNKbd>{t('review.hints.skip')}</NNBtn>
          <NNBtn size="sm" variant="ghost" disabled={busy || Boolean(pendingPeek)} onClick={handleEdit}><NNKbd>E</NNKbd>{t('review.hints.edit')}</NNBtn>
          {completed > 0 && <NNBtn size="sm" variant="ghost" icon="pause" disabled={busy||Boolean(pendingOperation)} onClick={() => { setPendingPeek(null); setFinished(true); }}>{t('review.finish')}</NNBtn>}
          <NNBtn size="sm" variant="ghost" disabled={busy} onClick={() => router.push('/')}><NNKbd>Esc</NNKbd>{t('review.hints.home')}</NNBtn>
        </div>
      </div>

    </div>

      {/* Feature #1 — held lapse-peek overlay. On Again for a provenance card we
          pause the queue and float the cited passage here (replacing the rating
          bar, which is moot — the grade already committed). «Понятно, дальше» /
          Esc advances. Non-blocking: the card stays visible above. */}
      {pendingPeek && (
        <div
          role="dialog"
          aria-label={t('review.peek.title')}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            padding: isMobile ? '10px 14px calc(12px + env(safe-area-inset-bottom, 0px))' : '14px 24px 18px',

            display: 'flex',
            justifyContent: 'center',
            zIndex: 25,
            pointerEvents: 'none',
          }}
        >
          <div
            style={{
              width: '100%',
              maxWidth: 760,
              pointerEvents: 'auto',
              background: 'var(--surface)',
              border: '1px solid var(--rose-400)',
              borderRadius: 'var(--r-xl)',
              boxShadow: 'var(--shadow-lg)',
              padding: isMobile ? '12px 14px calc(12px + env(safe-area-inset-bottom, 0px))' : '14px 16px',
            }}
          >
            <SourcePeekPanel
              item={pendingPeek}
              onOpenLibrary={(href) => followCardSourceHref(href, (path) => router.push(path))}
              onDismiss={advanceQueue}
            />
            {canUndo && <NNBtn size="sm" variant="ghost" icon="sync" disabled={busy} onClick={handleUndo}>{t('editor.review.undo.button')}</NNBtn>}
          </div>
        </div>
      )}

      <div className="reomi-review-actions" style={{ display: pendingPeek || (isTypein && !submitted && !canUndo) ? 'none' : 'flex' }}>
        <div className="reomi-review-action-content">
          <div className="reomi-review-action-caption">
            <span>{showRatings ? t('review.ratePrompt') : t('review.recallPrompt')}</span>
            {canUndo && <NNBtn size="sm" variant="ghost" icon="sync" onClick={handleUndo} disabled={busy} title={`${t('editor.review.undo.button')} (⌘Z)`}>{t('editor.review.undo.button')}</NNBtn>}
          </div>

          {showRatings && previews ? (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: isMobile ? 6 : 10,
                width: '100%',
              }}
            >
              {RATINGS.map((r) => {
                const preview = previews.cards[r.k];
                return (
                  <button
                    key={r.k}
                    type="button" disabled={busy || queueLoading || cardUnavailable || Boolean(pendingOperation&&pendingOperation.rating!==r.k)}
                    className="reomi-rating"
                    onClick={() => handleGrade(r.k)}
                    title={`${t(r.labelKey)} — ${t(`${r.labelKey}Hint`)} · ${r.k}`}
                    style={{ '--rating-color': r.hue } as React.CSSProperties}

                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 5 : 8, width: '100%' }}>
                      <span
                        className="mono"
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          width: 18,
                          height: 18,
                          borderRadius: 5,
                          fontSize: 10.5,
                          fontWeight: 600,
                          color: 'var(--text)',
                          background: r.bgHover,
                          flexShrink: 0,
                        }}
                      >
                        {r.k}
                      </span>
                      <span style={{ fontSize: isMobile ? 12 : 14, fontWeight: 600, letterSpacing: -0.2 }}>
                        {t(r.labelKey)}
                      </span>
                    </div>
                    <span style={{ fontSize: 11, lineHeight: 1.25, minHeight: isMobile ? 28 : undefined, color: 'var(--text-muted)' }}>
                      {t(`${r.labelKey}Hint`)}
                    </span>
                    <div
                      style={{ fontSize: isMobile ? 10 : 11.5, color: 'var(--text-muted)', paddingLeft: isMobile ? 0 : 26 }}
                      className="mono"
                    >
                      ≈ {humanInterval(preview, previews.at, locale)}
                    </div>
                  </button>
                );
              })}
            </div>
          ) : !isTypein ? (
            <NNBtn size="lg" variant="soft" disabled={busy} onClick={() => setRevealed(true)} block>
              {t('review.showAnswer')}
            </NNBtn>
          ) : null}
        </div>
      </div>
    </div>
    <aside className="reomi-review-inspector" data-resizable aria-label={t('review.info.title')}>
      <ResizeHandle edge="left" width={inspectorWidth} min={REVIEW_INSPECTOR.min} max={REVIEW_INSPECTOR.max} defaultWidth={REVIEW_INSPECTOR.default} label={t('review.info.resize')} onChange={resizeInspector} />
      <div className="reomi-review-inspector-content nn-scroll">{cardInfo}</div>
    </aside>
    </div>
    <Modal open={infoOpen} title={t('review.info.title')} closeLabel={t('actions.close')} onClose={() => setInfoOpen(false)}><div className="reomi-review-info-dialog">{cardInfo}</div></Modal>
    </div>
  );
};

// ─────────────────────────────────────────────
// Empty/loading/done states
// ─────────────────────────────────────────────

function ReviewSkeleton({ isMobile, inspectorWidth }: { isMobile: boolean; inspectorWidth: number }) {
  return (
    <div className="reomi-review-layout nn-review-loading" style={{ '--review-inspector-width': `${inspectorWidth}px` } as React.CSSProperties} role="status" aria-busy="true"><div className="reomi-review-panels">
      <div className="reomi-review-workspace">
        <div className="reomi-review-scroll nn-scroll">
          <div className="reomi-review-tools"><NNSkeleton width={150} height={20} /><span style={{ flex: 1 }} /><NNSkeleton width={68} height={28} /></div>
          <div className="reomi-review-card" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            <NNSkeleton width={64} height={12} />
            <NNSkeleton width="85%" height={isMobile ? 28 : 38} />
            <NNSkeleton width="55%" height={isMobile ? 24 : 32} />
          </div>
        </div>
        <div className="reomi-review-actions"><NNSkeleton width="100%" height={64} radius={14} style={{ maxWidth: 760 }} /></div>

      </div>
      <aside className="reomi-review-inspector" aria-hidden><NNSkeleton width="60%" height={16} />{Array.from({ length: 10 }, (_, index) => <NNSkeleton key={index} height={12} style={{ marginTop: 22 }} />)}</aside>
    </div></div>
  );
}

const ReviewEmpty = ({
  title,
  subtitle,
  cta,
  href,
  customStudyHref,
  customStudyLabel,
  onAction,
  role,
  actions,
  actionVariant = 'primary',
}: {
  title: string;
  subtitle: string;
  cta?: string;
  href?: string;
  customStudyHref?: string;
  customStudyLabel?: string;
  onAction?: () => void;
  role?: 'alert' | 'status';
  actions?: React.ReactNode;
  actionVariant?: 'primary' | 'soft';
}) => {
  const bp = useBreakpoint();
  const isMobile = bp === 'mobile';
  return (
    <div
      className="reomi-page-surface reomi-review-empty"
      role={role}
      style={{
        gap: 14,
        padding: isMobile ? '0 14px 32px' : '0 32px 48px',
      }}
    >
      <span className="reomi-session-done-icon" aria-hidden><NNIcon name={role === 'alert' ? 'warning' : 'cards'} size={28} /></span>
      <h1 className="reomi-empty-heading">{title}</h1>
      <div style={{ fontSize: 14, color: 'var(--text-muted)', maxWidth: 460, lineHeight: 1.5 }}>{subtitle}</div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center', marginTop: 8 }}>
        {actions}
        {cta && onAction && <NNBtn size="lg" variant={actionVariant} onClick={onAction}>{cta}</NNBtn>}
        {cta && href && (
          <AppLink href={href}>
            <NNBtn size="lg" variant="primary" icon="plus">
              {cta}
            </NNBtn>
          </AppLink>
        )}
        {customStudyHref && customStudyLabel && (
          <AppLink href={customStudyHref}>
            <NNBtn size="lg" variant="soft" icon={customStudyHref === '/decks' ? 'decks' : 'filter'}>
              {customStudyLabel}
            </NNBtn>
          </AppLink>
        )}
      </div>
    </div>
  );
};
