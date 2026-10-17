import { expect, test } from 'bun:test';
import { holdIsActive, State } from '@reomi/shared';
import { cardFromApi } from './mappers';
import { mergeStudyQueue, type StudyMode, type StudySession } from './review-session';
import * as reviewSession from './review-session';
import { reconcileStudyCheckpoint } from './study-recovery';
import type { StudyCheckpoint } from './study-checkpoint';
import type { Card } from './types';

const now = Date.parse('2026-10-16T12:00:00Z');
const card = (id: string, due: number, state: 'new' | 'learning' = 'new') => cardFromApi({
  id, deckId: 'deck', noteId: `note-${id}`, state, due: new Date(due).toISOString(),
  updatedAt: new Date(now).toISOString(), createdAt: new Date(now).toISOString(),
});

test('mergeStudyQueue drops a future learning step whose id is held and keeps the others', () => {
  const later = card('later', now + 60_000, 'learning');
  const kept = card('kept', now + 90_000, 'learning');
  const saved: StudySession = { pending: [later, kept], activeId: null, history: [] };
  const merged = mergeStudyQueue(saved, [], 'regular', now + 30_000, ['later']);
  expect(merged.pending.map((row) => row.id)).toEqual(['kept']);
  expect(merged.history).toEqual([]);
  expect(later.fsrs.state).toBe(State.Learning);
});

test('dropHeldCards removes the card and chooses the next ready card without a history entry', () => {
  const dropHeldCards = (reviewSession as {
    dropHeldCards?: (session: StudySession, ids: readonly string[], mode: StudyMode, now: number) => StudySession;
  }).dropHeldCards;
  expect(dropHeldCards).toBeDefined();
  const current = card('current', now);
  const next = card('next', now);
  const session: StudySession = { pending: [current, next], activeId: 'current', history: [] };
  const dropped = dropHeldCards!(session, ['current'], 'regular', now);
  expect(dropped.pending.map((row) => row.id)).toEqual(['next']);
  expect(dropped.activeId).toBe('next');
  expect(dropped.history).toEqual([]);
  expect(dropped.pending.at(-1)?.id).not.toBe('current');
});

test('reloading a live card with an active hold removes it before treating the question as changed', async () => {
  const learning = card('later', now + 60_000, 'learning');
  const live = {
    ...learning,
    hold: { until: new Date(now + 3_600_000).toISOString(), reason: 'user' as const },
  };
  expect(holdIsActive(live.hold, now)).toBe(true);
  const checkpoint: StudyCheckpoint = {
    id: 'session', owner: 'alice', href: '/review',
    session: { pending: [learning], activeId: 'later', history: [] },
    view: { revealed: true, submitted: false, typedAnswer: '', elapsedMs: 400, finished: false, infoOpen: false, pendingPeek: null },
    pending: null,
  };
  const reads = {
    reviews: async () => [],
    card: async () => live as Card,
    operation: async () => ({ status: 'missing' as const }),
  };
  const recovered = await reconcileStudyCheckpoint(checkpoint, [], 'regular', now, [], reads, true);
  expect(recovered.session.pending.map((row) => row.id)).toEqual([]);
  expect(recovered.session.activeId).toBeNull();
  expect(recovered.stale).toBeNull();
  expect(recovered.view.typedAnswer).toBe('');
});

test('a revived hold deadline stays an active ISO instant on the card', () => {
  const until = new Date('2026-10-17T00:00:00.000Z');
  const revived = cardFromApi({
    id: 'held', deckId: 'deck', noteId: 'note-held', state: 'new',
    due: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(), createdAt: new Date(now).toISOString(),
    hold: { until, reason: 'user' },
  });
  expect(revived.hold).toEqual({ until: until.toISOString(), reason: 'user' });
  expect(holdIsActive(revived.hold, until.getTime() - 1)).toBe(true);
});
