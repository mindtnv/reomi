'use client';

// useArtifactStatus — lightweight studio-artifact polling (N2). The studio panel
// refetches the artifact LIST every `intervalMs` while any artifact is in a
// non-terminal job status (pending|generating) and stops once the whole set is
// terminal (ready|error).
//
// This is DELIBERATELY a separate hook from `use-source-status`: artifact
// statuses (pending|generating|ready|error) are a DIFFERENT enum from source
// ingest statuses (pending|parsing|indexing|ready|error|deleting). The plan (§5)
// says not to mix the enums — `isNonTerminal(SourceStatus)` would not type-check
// against an ArtifactStatus and the terminal sets differ. So this hook owns its
// own tiny terminal-set check; the pure helper is exported for unit tests.

import { useEffect, useRef, useState } from 'react';
import { ARTIFACT_STATUSES, type ArtifactStatus } from '@reomi/shared';
import { followOperationRefresh } from './operation-observer';
import { useOperations } from '@/components/operations-provider';

const NONTERMINAL = new Set<ArtifactStatus>(['pending', 'generating']);

// Compile-time guard: the non-terminal set is a subset of the shared status enum.
// (Referenced so an accidental drift of ARTIFACT_STATUSES surfaces in review.)
void ARTIFACT_STATUSES;

/** Whether an artifact job is still running (and thus needs polling). */
export function isArtifactNonTerminal(status: ArtifactStatus): boolean {
  return NONTERMINAL.has(status);
}

/** Whether ANY artifact in the set is still running. Pure (exported for tests). */
export function anyArtifactNonTerminal(items: { status: ArtifactStatus }[]): boolean {
  return items.some((a) => NONTERMINAL.has(a.status));
}

export interface UseArtifactStatusOptions {
  /** The current artifact list to watch (LIGHT list rows are enough). */
  items: { status: ArtifactStatus }[];
  /** Refetch the artifact list (the studio panel's list refresher). */
  refresh: () => void | Promise<void>;
  /** Poll cadence in ms (default 2500). */
  intervalMs?: number;
  /** Disable polling entirely (e.g. while chat is unconfigured). */
  enabled?: boolean;
}

/**
 * Poll the artifact list while any job is non-terminal; stop when all are
 * terminal. Returns whether any artifact is currently running (handy for a
 * "generating…" affordance). The interval re-subscribes only when the
 * has-pending flag flips, reading `refresh` from a ref so a fresh closure each
 * render doesn't churn the timer.
 */
export function useArtifactStatus({
  items,
  refresh,
  intervalMs = 2500,
  enabled = true,
}: UseArtifactStatusOptions): boolean {
  const operations = useOperations();
  const hasPending = anyArtifactNonTerminal(items);
  const signature = items.map(item => item.status).join('|');

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (enabled && hasPending && operations) void operations.observer.refresh();
  }, [enabled, signature, operations?.observer]);
  useEffect(() => {
    if (enabled && hasPending && operations) return followOperationRefresh(operations.observer, async () => { await refreshRef.current(); });
  }, [operations?.observer, enabled, hasPending]);

  useEffect(() => {
    if (operations || !enabled || !hasPending) return;
    let cancelled = false;
    const interval = setInterval(() => {
      if (cancelled) return;
      void refreshRef.current();
    }, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [operations?.observer, enabled, hasPending, intervalMs]);

  return hasPending;
}

// ── Per-artifact «started at» tracking (live elapsed timer) ───────────────────
// The elapsed timer is anchored on the moment an artifact was FIRST observed
// non-terminal in THIS session — NOT createdAt (a regenerate keeps the old
// createdAt). A Map<id, startedAtMs> records first sighting and forgets ids that
// reach a terminal status (so a later regenerate restarts the clock).

/**
 * Track when each artifact first appeared non-terminal. Returns a stable getter
 * `startedAt(id)` (the recorded ms, or undefined if not currently running) and a
 * `now` value that ticks every second WHILE any job runs — components read both
 * to render «N сек since startedAt». Pure-ish: the Map lives in a ref; only the
 * `now` ticker drives re-renders.
 */
export function useArtifactTimers(items: { id: string; status: ArtifactStatus }[]): {
  startedAt: (id: string) => number | undefined;
  now: number;
} {
  const startedRef = useRef<Map<string, number>>(new Map());
  const hasPending = anyArtifactNonTerminal(items);
  const [now, setNow] = useState(() => Date.now());

  // Record first non-terminal sighting; drop terminal/vanished ids.
  const nowMs = Date.now();
  const liveIds = new Set<string>();
  for (const a of items) {
    if (NONTERMINAL.has(a.status)) {
      liveIds.add(a.id);
      if (!startedRef.current.has(a.id)) startedRef.current.set(a.id, nowMs);
    }
  }
  for (const id of [...startedRef.current.keys()]) {
    if (!liveIds.has(id)) startedRef.current.delete(id);
  }

  // Tick `now` every second while anything is running so the timer advances.
  useEffect(() => {
    if (!hasPending) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [hasPending]);

  return {
    startedAt: (id: string) => startedRef.current.get(id),
    now,
  };
}
