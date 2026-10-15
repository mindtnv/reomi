import { OPERATION_GROUPS, type OperationGroup, type OperationItem, type OperationsFeed } from '@reomi/shared';

export type OperationCursors = Partial<Record<`${OperationGroup}Cursor`, string>>;
export interface OperationSnapshot {
  feed: OperationsFeed | null;
  status: 'loading' | 'ready' | 'stale' | 'unavailable';
  loadingMore: OperationGroup | null;
  completions: OperationItem[];
  revision: number;
}
const identity = (row: OperationItem) => `${row.kind}:${row.id}:${row.runId}`;
const all = (feed: OperationsFeed) => OPERATION_GROUPS.flatMap(group => feed[group].items);

/** Shell lifetime, independent of route subscribers. A refresh is atomic across loaded pages. */
export class OperationObserver {
  private snapshot: OperationSnapshot = { feed: null, status: 'loading', loadingMore: null, completions: [], revision: 0 };
  private listeners = new Set<() => void>();
  private pending: Promise<void> | null = null;
  private abort: AbortController | null = null;
  private disposed = false;
  private cancelTimer?: () => void;
  private running = false;
  private visible = true;
  private failures = 0;
  private pages: Record<OperationGroup, number> = { active: 1, attention: 1, recent: 1 };
  private observedActive = new Set<string>();
  private announced = new Set<string>();

  constructor(private fetchFeed: (signal: AbortSignal, cursors: OperationCursors) => Promise<OperationsFeed>,
    private delay: (run: () => void, milliseconds: number) => () => void = (run, milliseconds) => {
      const timer = setTimeout(run, milliseconds); return () => clearTimeout(timer);
    }) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<OperationSnapshot>) {
    if (this.disposed) return;
    this.snapshot = { ...this.snapshot, ...update };
    for (const listener of this.listeners) listener();
  }
  private accept(feed: OperationsFeed) {
    const completions = all(feed).filter(row => row.phase === 'ready' && this.observedActive.has(identity(row)) && !this.announced.has(identity(row)));
    for (const row of completions) this.announced.add(identity(row));
    for (const row of feed.active.items) this.observedActive.add(identity(row));
    // Only live/recent server rows matter; bound announcement bookkeeping.
    const live = new Set(all(feed).map(identity));
    this.observedActive = new Set([...this.observedActive].filter(id => live.has(id)));
    this.announced = new Set([...this.announced].filter(id => live.has(id)));
    this.publish({ feed, completions, status: 'ready', revision: this.snapshot.revision + 1 });
  }
  private async readLoaded(signal: AbortSignal) {
    const feed = await this.fetchFeed(signal, {});
    for (let page = 1; page < Math.max(...Object.values(this.pages)); page++) {
      const cursors: OperationCursors = {};
      for (const group of OPERATION_GROUPS) if (page < this.pages[group] && feed[group].nextCursor) cursors[`${group}Cursor`] = feed[group].nextCursor!;
      if (!Object.keys(cursors).length) break;
      const next = await this.fetchFeed(signal, cursors);
      for (const group of OPERATION_GROUPS) if (cursors[`${group}Cursor`]) {
        const rows = new Map([...feed[group].items, ...next[group].items].map(row => [`${row.kind}:${row.id}`, row]));
        feed[group] = { ...next[group], items: [...rows.values()] };
      }
    }
    return feed;
  }
  private request(work: (signal: AbortSignal) => Promise<OperationsFeed>) {
    if (this.disposed) return Promise.resolve();
    if (this.pending) return this.pending;
    this.cancelTimer?.();
    const controller = new AbortController();
    this.abort = controller;
    this.pending = (async () => {
      try {
        const feed = await work(controller.signal);
        if (!controller.signal.aborted && !this.disposed) { this.failures = 0; this.accept(feed); }
      } catch (error) {
        if (!controller.signal.aborted && !this.disposed) {
          this.failures++;
          this.publish({ status: (error as { status?: number })?.status === 404 ? 'unavailable' : 'stale', completions: [] });
        }
      } finally {
        this.pending = null;
        this.publish({ loadingMore: null });
        this.schedule();
      }
    })();
    return this.pending;
  }
  refresh = () => this.request(signal => this.readLoaded(signal));
  loadMore = async (group: OperationGroup) => {
    if (this.pending) await this.pending;
    const current = this.snapshot.feed;
    if (!current?.[group].nextCursor || this.disposed) return;
    this.publish({ loadingMore: group });
    return this.request(async signal => {
      const next = await this.fetchFeed(signal, { [`${group}Cursor`]: current[group].nextCursor! });
      const merged = new Map([...current[group].items, ...next[group].items].map(row => [`${row.kind}:${row.id}`, row]));
      if (!signal.aborted) this.pages[group]++;
      return { ...current, [group]: { ...next[group], items: [...merged.values()] }, serverTime: next.serverTime };
    });
  };
  private schedule() {
    this.cancelTimer?.();
    if (!this.running || !this.visible || this.disposed) return;
    const delay = this.failures ? Math.min(30000, 2500 * 2 ** Math.min(this.failures, 4)) : this.snapshot.feed?.active.total ? 2500 : 30000;
    this.cancelTimer = this.delay(() => void this.refresh(), delay);
  }
  start = () => {
    this.disposed = false; this.running = true;
    if (this.visible) { if (this.pending) void this.pending.then(() => this.running && this.visible ? this.refresh() : undefined); else void this.refresh(); }
  };
  setVisible = (visible: boolean) => {
    this.visible = visible;
    if (visible && this.running) void this.refresh();
    else this.cancelTimer?.();
  };
  dispose = () => { this.disposed = true; this.running = false; this.cancelTimer?.(); this.abort?.abort(); this.listeners.clear(); };
}

/** A single shell clock invalidates details; slow reads finish before one queued
 * refresh. A new feed revision must not cancel every result on a slow link. */
export function followOperationRefresh(observer: OperationObserver, refresh: (current: () => boolean) => Promise<void>) {
  let active = true, running = false, queued = false, revision = -1;
  const run = async () => {
    if (!active) return;
    if (running) { queued = true; return; }
    running = true;
    try { await refresh(() => active); } catch { /* The next observation can retry the read. */ }
    finally { running = false; if (active && queued) { queued = false; void run(); } }
  };
  const pulse = () => {
    const snapshot = observer.getSnapshot();
    if (snapshot.status !== 'ready' || snapshot.revision === revision) return;
    revision = snapshot.revision; void run();
  };
  const remove = observer.subscribe(pulse); pulse();
  return () => { active = false; remove(); };
}
