import type { LogCorrelation } from './logger.ts';

export interface WorkerFailureSnapshot {
  code: string;
  at: string;
}

export interface WorkerSnapshot {
  queued: number;
  active: number;
  degraded: boolean;
  lastFailure?: WorkerFailureSnapshot;
}

function safeFailureCode(code: string): string {
  return /^[A-Za-z0-9._:-]{1,80}$/.test(code) ? code : 'worker_failed';
}

/** Small aggregate-only tracker: never accepts or exposes job/user/content ids. */
export class WorkerTracker {
  private queued = 0;
  private active = 0;
  private lastFailure: WorkerFailureSnapshot | undefined;

  constructor(readonly name: string) {}

  enqueue(count = 1): void {
    this.queued += Math.max(0, Math.floor(count));
  }

  start(count = 1): void {
    const value = Math.max(0, Math.floor(count));
    this.queued = Math.max(0, this.queued - value);
    this.active += value;
  }

  succeed(count = 1): void {
    this.active = Math.max(0, this.active - Math.max(0, Math.floor(count)));
    this.lastFailure = undefined;
  }

  complete(count = 1): void {
    this.active = Math.max(0, this.active - Math.max(0, Math.floor(count)));
  }

  recover(): void {
    this.lastFailure = undefined;
  }

  fail(code = 'worker_failed', count = 1): void {
    this.active = Math.max(0, this.active - Math.max(0, Math.floor(count)));
    this.recordFailure(code);
  }

  recordFailure(code = 'worker_failed'): void {
    this.lastFailure = { code: safeFailureCode(code), at: new Date().toISOString() };
  }

  removeQueued(count = 1): void {
    this.queued = Math.max(0, this.queued - Math.max(0, Math.floor(count)));
  }

  snapshot(): WorkerSnapshot {
    return {
      queued: this.queued,
      active: this.active,
      degraded: Boolean(this.lastFailure),
      ...(this.lastFailure ? { lastFailure: { ...this.lastFailure } } : {}),
    };
  }

  reset(): void {
    this.queued = 0;
    this.active = 0;
    this.lastFailure = undefined;
  }
}

function correlationKey(correlation: LogCorrelation | undefined): string {
  return correlation?.requestId ?? '';
}

/** Deduplicating FIFO that retains only bounded causal metadata for each id. */
export class CorrelatedPendingQueue {
  private readonly items = new Map<string, LogCorrelation | undefined>();

  get size(): number {
    return this.items.size;
  }

  has(id: string): boolean {
    return this.items.has(id);
  }

  enqueue(id: string, correlation?: LogCorrelation): boolean {
    const isNew = !this.items.has(id);
    // A later causal request is more useful for a still-pending deduplicated job.
    this.items.set(id, correlation);
    return isNew;
  }

  takeOne(): { id: string; correlation?: LogCorrelation } | undefined {
    const first = this.items.entries().next().value as
      | [string, LogCorrelation | undefined]
      | undefined;
    if (!first) return undefined;
    this.items.delete(first[0]);
    return { id: first[0], ...(first[1] ? { correlation: first[1] } : {}) };
  }

  /** Batch only jobs with the same request correlation so worker logs stay causal. */
  takeBatch(limit: number): { ids: string[]; correlation?: LogCorrelation } | undefined {
    const first = this.items.entries().next().value as
      | [string, LogCorrelation | undefined]
      | undefined;
    if (!first) return undefined;
    const key = correlationKey(first[1]);
    const ids: string[] = [];
    for (const [id, correlation] of this.items) {
      if (ids.length >= limit) break;
      if (correlationKey(correlation) !== key) continue;
      ids.push(id);
    }
    for (const id of ids) this.items.delete(id);
    return { ids, ...(first[1] ? { correlation: first[1] } : {}) };
  }
}

export const indexWorkerState = new WorkerTracker('index');
export const sourceIngestWorkerState = new WorkerTracker('source_ingest');
export const artifactWorkerState = new WorkerTracker('artifact');
export const reminderWorkerState = new WorkerTracker('reminder');
export const documentationWorkerState = new WorkerTracker('documentation');

let lifecycle: 'running' | 'shutting_down' = 'running';

export function markRuntimeRunning(): void {
  lifecycle = 'running';
}

export function markRuntimeShuttingDown(_cause?: string): void {
  lifecycle = 'shutting_down';
}

export function lifecycleSnapshot(): { state: 'running' | 'shutting_down' } {
  return { state: lifecycle };
}

export function isRuntimeShuttingDown(): boolean {
  return lifecycle === 'shutting_down';
}
