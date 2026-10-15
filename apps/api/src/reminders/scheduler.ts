import { rootLogger, safeError } from '../logger.ts';
import { isRuntimeShuttingDown, reminderWorkerState } from '../runtime-state.ts';
import { runReminderTick } from './tick.ts';

const INTERVAL_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;

export function startReminderScheduler(): void {
  if (process.env.NODE_ENV === 'test') return;
  if (timer) return;
  timer = setInterval(() => {
    if (isRuntimeShuttingDown() || inflight) return;
    inflight = runReminderTick()
      .catch((err) => {
        reminderWorkerState.recordFailure('reminder_tick_failed');
        rootLogger.warn({ err: safeError(err), event: 'reminder.tick_failed' }, 'reminder.tick_failed');
      })
      .finally(() => {
        inflight = null;
      });
  }, INTERVAL_MS);
  timer.unref?.();
}

export function reminderSchedulerActive(): boolean {
  return timer != null;
}

export async function drainReminders(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (inflight) await inflight;
}
