import { newUuidV7 } from '@reomi/shared';

/** Run identity changes only when new work is accepted, never on a metadata edit. */
export function newOperationRun(now = new Date()) {
  return { operationRunId: newUuidV7(), operationStartedAt: now, operationFinishedAt: null };
}
