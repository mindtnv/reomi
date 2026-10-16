'use client';

import { useCallback, useEffect } from 'react';
import type { StudyOverview } from '@reomi/shared';
import { api, ok } from './api';
import { useSessionResource } from './session-resource';
import { utcDayKey } from './study-date';
import { useNN } from './store';

/** Screens share the server contract; a card-cache page is never a count. */
export function useStudyOverview() {
  const bootstrapped = useNN((s) => s.bootstrapped);
  const cards = useNN((s) => s.cards);
  const decks = useNN((s) => s.decks);
  const presets = useNN((s) => s.presets);
  const profile = useNN((s) => s.profile);
  const fetcher = useCallback(async () => ok(await api.cards['study-summary'].get()), [cards, decks, presets, profile]);
  const state = useSessionResource<StudyOverview>({ key: `study:overview:${profile?.userId ?? 'current'}`, enabled: bootstrapped, keepPreviousData: false, fetcher });
  const reload = state.refresh;

  useEffect(() => {
    if (!bootstrapped) return;
    const refreshVisible = () => { if (!document.hidden) reload(); };
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    window.addEventListener('nn:study:changed', refreshVisible);
    return () => {
      window.removeEventListener('focus', refreshVisible);
      document.removeEventListener('visibilitychange', refreshVisible);
      window.removeEventListener('nn:study:changed', refreshVisible);
    };
  }, [bootstrapped, reload]);

  useEffect(() => {
    if (state.status !== 'ready' || !state.data) return;
    const now = Date.parse(state.data.overall.serverNow);
    const boundary = state.data.studyDay?.endsAt ? Date.parse(state.data.studyDay.endsAt) : Number.POSITIVE_INFINITY;
    const due = state.data.overall.nextDueAt ? Date.parse(state.data.overall.nextDueAt) : boundary;
    const wait = Math.min(due, boundary);
    if (!Number.isFinite(wait)) return;
    const timer = setTimeout(() => { if (!document.hidden) reload(); }, Math.max(250, Math.min(wait - now + 50, 2_147_483_647)));
    return () => clearTimeout(timer);
  }, [state.data, state.status, reload]);

  return { ...state, reload };
}

export interface StudyForecast {
  days: number;
  overdueCount: number;
  total: number;
  labels: string[];
  buckets: { day: string; count: number }[];
}

export function useStudyForecast(days: number, refreshKey?: string, deckId?: string) {
  const bootstrapped = useNN((s) => s.bootstrapped);
  const userId = useNN((s) => s.profile?.userId);
  const fetcher = useCallback(async () => {
    const result = await ok(await api.stats.forecast.get({ query: { days: String(days), ...(deckId ? { deckId } : {}) } }));
    // Eden revives YYYY-MM-DD into a Date. utcDayKey restores the server label.
    const labels = Array.isArray(result.labels) ? result.labels : [];
    return {
      ...result,
      labels: labels.map((label) => utcDayKey(label)).filter((label) => label.length > 0),
      buckets: result.buckets.map(bucket => ({ ...bucket, day: utcDayKey(bucket.day) })),
    };
  }, [days, deckId, refreshKey]);
  const state = useSessionResource<StudyForecast>({ key: `study:forecast:${userId ?? 'current'}:${days}:${deckId ?? 'all'}`, enabled: bootstrapped, keepPreviousData: false, fetcher });
  return { ...state, reload: state.refresh };
}
