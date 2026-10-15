import { MAX_REVIEW_DURATION_MS, State, xpForRating } from '@reomi/shared';
import type { Card, Rating, Review } from './types';

export type StudyMode = 'regular' | 'filtered';
export interface StudyAnswer { before: Card; after: Card; review: Review }
export interface StudySession { pending: Card[]; activeId: string | null; history: StudyAnswer[] }

// One in-memory round trip through the editor, scoped to the signed-in owner.
// No persisted/offline session state and no replay of writes.
let editorHandoff: { userId: string; href: string; cardId: string; session: StudySession } | null = null;
export function saveStudyHandoff(userId: string, href: string, cardId: string, session: StudySession) {
  editorHandoff = { userId, href, cardId, session };
}
export function readStudyHandoff(userId: string | undefined, href: string, cardId: string | null): StudySession | null {
  if (!editorHandoff || !userId) return null;
  return editorHandoff.userId === userId && editorHandoff.href === href && (cardId === null || editorHandoff.cardId === cardId) ? editorHandoff.session : null;
}
export function clearStudyHandoff() { editorHandoff = null; }

// Longer steps stay scheduled on the server; users can return another time.
const SHORT_STEP_MS = 20 * 60_000;
const learning = (card: Card) => card.fsrs.state === State.Learning || card.fsrs.state === State.Relearning;
const ready = (card: Card, mode: StudyMode, now: number) => !card.suspended &&
  (mode === 'filtered' || card.fsrs.state === State.New || new Date(card.fsrs.due).getTime() <= now);
const firstReady = (pending: Card[], mode: StudyMode, now: number) =>
  (mode === 'regular' ? pending.find((c) => learning(c) && ready(c, mode, now)) : undefined)?.id ??
  pending.find((c) => ready(c, mode, now))?.id ?? null;

export const emptyStudySession = (): StudySession => ({ pending: [], activeId: null, history: [] });

export function mergeStudyQueue(session: StudySession, incoming: Card[], mode: StudyMode, now: number): StudySession {
  const answered = new Set(mode === 'filtered' ? session.history.map((entry) => entry.before.id) : []);
  const cards = new Map(incoming.filter((c) => !c.suspended && !answered.has(c.id)).map((c) => [c.id, c]));
  if (mode === 'regular') {
    for (const card of session.pending) {
      // Only retain future local steps. Once due, the server decides whether
      // the card is still available (it may have been suspended elsewhere).
      if (!cards.has(card.id) && !card.suspended && learning(card) && new Date(card.fsrs.due).getTime() > now) cards.set(card.id, card);
    }
  }
  const pending = [...cards.values()];
  return { ...session, pending, activeId: firstReady(pending, mode, now) };
}

export function recordStudyAnswer(session: StudySession, before: Card, after: Card, review: Review, mode: StudyMode, now: number): StudySession {
  const pending = session.pending.filter((c) => c.id !== before.id);
  if (mode === 'regular' && !after.suspended && learning(after) && new Date(after.fsrs.due).getTime() <= now + SHORT_STEP_MS) pending.push(after);
  return { pending, activeId: firstReady(pending, mode, now), history: [...session.history, { before, after, review }] };
}

export function undoStudyAnswer(session: StudySession, restored: Card, reviewId: string): StudySession {
  if (session.history.at(-1)?.review.id !== reviewId) return session;
  return {
    pending: [restored, ...session.pending.filter((c) => c.id !== restored.id)],
    activeId: restored.id,
    history: session.history.slice(0, -1),
  };
}

export function skipStudyCard(session: StudySession, mode: StudyMode, now: number): StudySession {
  const current = session.pending.find((c) => c.id === session.activeId);
  if (!current) return session;
  const pending = [...session.pending.filter((c) => c.id !== current.id), current];
  return { ...session, pending, activeId: pending.find((c) => ready(c, mode, now))?.id ?? null };
}

export function studyTotals(history: StudyAnswer[]) {
  const grades: Record<Rating, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  let xp = 0; let durationMs = 0;
  for (const { review } of history) {
    grades[review.rating]++;
    xp += xpForRating(review.rating);
    durationMs += review.durationMs;
  }
  return { answers: history.length, uniqueCards: new Set(history.map((entry) => entry.before.id)).size, xp, durationMs, grades };
}

/** Monotonic active time only; callers pause while hidden or saving. */
export function createAnswerTimer(now: () => number = () => performance.now()) {
  let accumulated = 0;
  let started: number | null = null;
  const elapsed = () => Math.min(MAX_REVIEW_DURATION_MS, Math.round(accumulated + (started === null ? 0 : Math.max(0, now() - started))));
  return {
    elapsed,
    restore(ms: number) { accumulated=Math.max(0,Math.min(MAX_REVIEW_DURATION_MS,Number.isFinite(ms)?ms:0));started=null; },
    heartbeat(maxGapMs=2500) {
      if(started===null)return;
      const tick=now(),delta=Math.max(0,tick-started);
      if(delta<=maxGapMs)accumulated=Math.min(MAX_REVIEW_DURATION_MS,accumulated+delta);
      started=tick;
    },
    pause() { accumulated = elapsed(); started = null; },
    resume() { if (started === null) started = now(); },
    reset(active: boolean) { accumulated = 0; started = active ? now() : null; },
  };
}

/** Due comparisons cannot jump when the local wall clock changes. Wake/focus
 * refresh supplies a new server reading when a platform pauses its monotonic clock. */
export function createStudyClock(monotonic:()=>number=()=>performance.now()) {
  let epoch=Date.now(),anchor=monotonic();
  return {sync(serverNow:number){epoch=serverNow;anchor=monotonic();},now(){return epoch+Math.max(0,monotonic()-anchor);}};
}
export {readStudyCheckpoint,writeStudyCheckpoint,clearStudyCheckpoints} from './study-checkpoint';
export type {StudyCheckpoint,StudyViewCheckpoint,PendingStudyGrade} from './study-checkpoint';
