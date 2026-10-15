import { describe, expect, test } from 'bun:test';
import { State } from '@reomi/shared';
import { cardFromApi, reviewFromApi } from './mappers';
import { emptyStudySession, mergeStudyQueue, recordStudyAnswer, undoStudyAnswer, skipStudyCard, studyTotals, createAnswerTimer, createStudyClock, saveStudyHandoff, readStudyHandoff, clearStudyHandoff } from './review-session';

const now = Date.parse('2026-09-19T10:00:00Z');
const card = (id: string) => cardFromApi({ id, deckId: 'deck', state: 'new', due: new Date(now).toISOString() });
const review = (id: string, cardId: string, rating = 3) => reviewFromApi({ id, cardId, deckId: 'deck', rating, durationMs: 15_000 });

describe('study session ledger', () => {
  test('an editor handoff preserves history and is isolated by owner, scope and card', () => {
    const session = mergeStudyQueue(emptyStudySession(), [card('a')], 'regular', now);
    expect(readStudyHandoff(undefined, '/review', null)).toBeNull();
    saveStudyHandoff('owner', '/review?deck=deck', 'a', session);
    expect(readStudyHandoff('owner', '/review?deck=deck', 'a')).toBe(session);
    expect(readStudyHandoff('owner', '/review?deck=deck', 'a')).toBe(session); // safe for Strict Mode initialization
    expect(readStudyHandoff('owner', '/review?deck=deck', null)).toBe(session); // browser Back
    expect(readStudyHandoff('other', '/review?deck=deck', 'a')).toBeNull();
    expect(readStudyHandoff('owner', '/review', 'a')).toBeNull();
    clearStudyHandoff();
    expect(readStudyHandoff('owner', '/review?deck=deck', 'a')).toBeNull();
  });
  test('only saved answers contribute to totals, and skips keep every card', () => {
    const a = card('a'); const b = card('b');
    const loaded = mergeStudyQueue(emptyStudySession(), [a, b], 'regular', now);
    const skipped = skipStudyCard(loaded, 'regular', now);
    expect(skipped.activeId).toBe('b');
    expect(skipped.pending.map((c) => c.id)).toEqual(['b', 'a']);
    expect(studyTotals(skipped.history)).toMatchObject({ answers: 0, xp: 0, durationMs: 0 });
    const saved = recordStudyAnswer(skipped, b, { ...b, fsrs: { ...b.fsrs, state: State.Review } }, review('r1', 'b'), 'regular', now);
    expect(saved.activeId).toBe('a');
    expect(studyTotals(saved.history)).toMatchObject({ answers: 1, uniqueCards: 1, xp: 10, durationMs: 15_000 });
  });

  test('regular learning returns only when due, while filtered study stays finite', () => {
    const a = card('a');
    const after = { ...a, fsrs: { ...a.fsrs, state: State.Learning, due: new Date(now + 60_000) } };
    const loaded = mergeStudyQueue(emptyStudySession(), [a], 'regular', now);
    const saved = recordStudyAnswer(loaded, a, after, review('r1', 'a', 1), 'regular', now);
    expect(saved.activeId).toBeNull();
    expect(saved.pending).toEqual([after]);
    expect(mergeStudyQueue(saved, [], 'regular', now + 30_000).pending).toEqual([after]);
    expect(mergeStudyQueue(saved, [after], 'regular', now + 60_000).activeId).toBe('a');
    expect(recordStudyAnswer(loaded, a, after, review('r1', 'a', 1), 'filtered', now).pending).toEqual([]);
  });

  test('multiple undos restore each exact card and remove their own XP and duration', () => {
    const a = card('a'); const b = card('b');
    let session = mergeStudyQueue(emptyStudySession(), [a, b], 'regular', now);
    session = recordStudyAnswer(session, a, { ...a, suspended: true }, review('r1', 'a', 4), 'regular', now);
    session = recordStudyAnswer(session, b, { ...b, suspended: true }, review('r2', 'b', 2), 'regular', now);
    expect(studyTotals(session.history).xp).toBe(20);
    session = undoStudyAnswer(session, b, 'r2');
    expect(session.activeId).toBe('b');
    expect(studyTotals(session.history)).toMatchObject({ answers: 1, xp: 15, durationMs: 15_000 });
    session = undoStudyAnswer(session, a, 'r1');
    expect(session.pending).toEqual([a, b]);
    expect(studyTotals(session.history)).toMatchObject({ answers: 0, xp: 0, durationMs: 0 });
  });

  test('refresh deduplicates cards and drops a due local step absent from the server', () => {
    const a = card('a');
    const loaded = mergeStudyQueue(emptyStudySession(), [a, a], 'regular', now);
    expect(loaded.pending).toHaveLength(1);
    const after = { ...a, fsrs: { ...a.fsrs, state: State.Learning, due: new Date(now + 60_000) } };
    const saved = recordStudyAnswer(loaded, a, after, review('r1', 'a'), 'regular', now);
    expect(mergeStudyQueue(saved, [], 'regular', now + 60_000).pending).toEqual([]);
  });

  test('skipping a due learning card offers another ready card without losing either', () => {
    const a = { ...card('a'), fsrs: { ...card('a').fsrs, state: State.Learning } };
    const b = card('b');
    const session = mergeStudyQueue(emptyStudySession(), [a, b], 'regular', now);
    expect(skipStudyCard(session, 'regular', now).activeId).toBe('b');
    expect(skipStudyCard(session, 'regular', now).pending).toEqual([b, a]);
  });

  test('answer time excludes hidden, saving and waiting periods and resets per card', () => {
    let clock = 0;
    const timer = createAnswerTimer(() => clock);
    timer.reset(true);
    clock += 1200;
    timer.pause();
    clock += 3_600_000;
    expect(timer.elapsed()).toBe(1200);
    timer.resume();
    clock += 2300;
    expect(timer.elapsed()).toBe(3500);
    timer.reset(false);
    clock += 60_000;
    expect(timer.elapsed()).toBe(0);
    timer.resume();
    clock += 3_600_000;
    expect(timer.elapsed()).toBe(600_000);
  });
});

test('answer time restores its accumulated work but excludes an unobserved sleep gap',()=>{
  let monotonic=0;const timer=createAnswerTimer(()=>monotonic);
  timer.restore(1200);timer.resume();monotonic=1000;timer.heartbeat();expect(timer.elapsed()).toBe(2200);
  monotonic+=3600000;timer.heartbeat();expect(timer.elapsed()).toBe(2200);
  timer.pause();monotonic+=10000;timer.resume();monotonic+=300;expect(timer.elapsed()).toBe(2500);
});
test('study due time follows a synchronized monotonic clock until a fresh server reading',()=>{
  let monotonic=50;const clock=createStudyClock(()=>monotonic);
  clock.sync(now);monotonic+=1500;expect(clock.now()).toBe(now+1500);
  clock.sync(now+3600000);expect(clock.now()).toBe(now+3600000);
});
