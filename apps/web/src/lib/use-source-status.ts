'use client';

// useSourceStatus — reusable ingest-status polling (L1). Both the /library screen
// and the notebook workspace need to poll GET /sources|/library/items while any
// item is in a non-terminal ingest status (pending|parsing|indexing) and stop
// once everything is ready/error. This used to live inline in the /notebooks
// screen; it's extracted here so the two callers share one implementation
// instead of copy-pasting the interval loop (plan §11.6 / task п.4).
//
// The hook is generic over the item shape: it only needs `{ id, status }`. The
// caller supplies a `fetchOne(id)` that returns the fresh item (or null on a
// transient error) and an `onUpdate(items)` that merges the fresh rows back into
// the caller's state. Polling auto-(re)starts whenever any item is non-terminal
// and tears down its interval on unmount / when nothing is pending.

import { useEffect, useMemo, useRef } from 'react';
import { SOURCE_NONTERMINAL_STATUSES, type SourceStatus } from '@reomi/shared';
import { followOperationRefresh } from './operation-observer';
import { useOperations } from '@/components/operations-provider';

const NONTERMINAL = new Set<SourceStatus>(SOURCE_NONTERMINAL_STATUSES);

/** Whether an ingest status still needs polling. */
export function isNonTerminal(status: SourceStatus): boolean {
  return NONTERMINAL.has(status);
}

export interface PollableSource {
  id: string;
  status: SourceStatus;
}

export interface UseSourceStatusOptions<T extends PollableSource> {
  /** The current list of items to watch. */
  items: T[];
  /** Fetch one item's fresh status; return null to skip it this tick. */
  fetchOne: (id: string) => Promise<T | null>;
  /** Apply the freshly-fetched rows (keyed by id) back into caller state. */
  onUpdate: (fresh: T[]) => void;
  /** Poll cadence in ms (default 2000). */
  intervalMs?: number;
  /** Disable polling entirely (e.g. while a feature is unconfigured). */
  enabled?: boolean;
}

/**
 * Poll non-terminal items until they all reach a terminal status. Returns
 * whether any item is currently pending (handy for a "indexing…" affordance).
 */
export function useSourceStatus<T extends PollableSource>({
  items,
  fetchOne,
  onUpdate,
  intervalMs = 2000,
  enabled = true,
}: UseSourceStatusOptions<T>): boolean {
  const operations = useOperations();
  const ids = items.map(item => item.id).join('|');
  const signature = items.map(item => `${item.id}:${item.status}`).join('|');
  const hasPending = useMemo(
    () => items.some((s) => NONTERMINAL.has(s.status)),
    [items],
  );

  // Keep the latest items/callbacks in refs so the interval reads fresh values
  // without re-subscribing every render (the interval depends only on whether
  // polling should run at all).
  const itemsRef = useRef(items);
  const fetchRef = useRef(fetchOne);
  const updateRef = useRef(onUpdate);
  itemsRef.current = items;
  fetchRef.current = fetchOne;
  updateRef.current = onUpdate;

  useEffect(() => {
    if (enabled && hasPending && operations) void operations.observer.refresh();
  }, [enabled, signature, operations?.observer]);

  useEffect(() => {
    if (!operations || !enabled || !hasPending) return;
    return followOperationRefresh(operations.observer, async current => {
      const pending = itemsRef.current.filter(item => NONTERMINAL.has(item.status));
      const rows = await Promise.all(pending.map(item => fetchRef.current(item.id).catch(() => null)));
      if (current()) { const fresh: T[] = []; for (const row of rows) if (row !== null) fresh.push(row); updateRef.current(fresh); }
    });
  }, [operations?.observer, enabled, hasPending, ids]);

  useEffect(() => {
    if (operations || !enabled || !hasPending) return;
    let cancelled = false;
    const interval = setInterval(async () => {
      const pending = itemsRef.current.filter((s) => NONTERMINAL.has(s.status));
      if (pending.length === 0) return;
      try {
        const updated = await Promise.all(
          pending.map((s) => fetchRef.current(s.id).catch((): T | null => null)),
        );
        if (cancelled) return;
        const fresh: T[] = [];
        for (const row of updated) if (row !== null) fresh.push(row);
        if (fresh.length > 0) updateRef.current(fresh);
      } catch {
        /* transient; the next tick retries */
      }
    }, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [operations?.observer, enabled, hasPending, intervalMs]);

  return hasPending;
}
