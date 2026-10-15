'use client';

import { useCallback, useEffect } from 'react';
import type { StudyOverview } from '@reomi/shared';
import { api, ok } from './api';
import { useSessionResource } from './session-resource';
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
    return () => {
      window.removeEventListener('focus', refreshVisible);
      document.removeEventListener('visibilitychange', refreshVisible);
    };
  }, [bootstrapped, reload]);

  useEffect(() => {
    if (state.status !== 'ready' || !state.data) return;
    const now = Date.parse(state.data.overall.serverNow);
    const nextDay = Math.floor(now / 86_400_000) * 86_400_000 + 86_400_000;
    const due = state.data.overall.nextDueAt ? Date.parse(state.data.overall.nextDueAt) : nextDay;
    const timer = setTimeout(() => { if (!document.hidden) reload(); }, Math.max(250, Math.min(due, nextDay) - now + 50));
    return () => clearTimeout(timer);
  }, [state.data, state.status, reload]);

  return { ...state, reload };
}

export interface StudyForecast { days: number; overdueCount: number; total: number; buckets: { day: string; count: number }[] }

export function useStudyForecast(days: number, refreshKey?: string, deckId?: string) {
  const bootstrapped = useNN((s) => s.bootstrapped);
  const userId = useNN((s) => s.profile?.userId);
  const fetcher = useCallback(async () => {
    const result = await ok(await api.stats.forecast.get({ query: { days: String(days), ...(deckId ? { deckId } : {}) } }));
    // Eden revives date-looking strings, including YYYY-MM-DD, into Date objects.
    // Keep the public hook contract as UTC day keys for charts on every screen.
    return { ...result, buckets: result.buckets.map(bucket => ({ ...bucket, day: new Date(bucket.day).toISOString().slice(0, 10) })) };
  }, [days, deckId, refreshKey]);
  const state = useSessionResource<StudyForecast>({ key: `study:forecast:${userId ?? 'current'}:${days}:${deckId ?? 'all'}`, enabled: bootstrapped, keepPreviousData: false, fetcher });
  return { ...state, reload: state.refresh };
}
