import { createHash } from 'node:crypto';
import { db, notebookArtifacts, operationRetryReceipts } from '@reomi/db';
import { and, eq, sql } from 'drizzle-orm';
import type { OperationRetryInput, OperationRetryResult } from '@reomi/shared';
import { cooldownCheck } from '../ai-cooldown';
import { scheduleArtifactGeneration } from '../ai/artifacts';
import { enqueueSource } from '../ai/source-ingest';
import { logCorrelation, rootLogger } from '../logger';
import type { Logger } from 'pino';
import { regenerateStudyArtifactInTransaction } from './study-artifacts';
import { reingestSourceInTransaction } from './sources-shared';
import { StudyError } from './study-notes';

export class OperationCooldownError extends Error {
  constructor(readonly retryAfterMs: number) { super('cooldown'); }
}

export async function retryOperation(userId: string, input: OperationRetryInput, log: Logger = rootLogger,
  checkCooldown = () => cooldownCheck(`operation:${userId}:${input.kind}:${input.id}`, 5000),
  dispatch: (accepted: OperationRetryResult) => void = accepted => {
    if (accepted.kind === 'source') enqueueSource(accepted.id, logCorrelation(log));
    else scheduleArtifactGeneration(accepted.id, { runId: accepted.runId, requestLog: log });
  },
): Promise<OperationRetryResult> {
  const hash = createHash('sha256').update(JSON.stringify([input.kind, input.id, input.runId, input.acceptDefaults === true])).digest('hex');
  const result = await db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${input.requestId}`}, 941))`);
    const [receipt] = await tx.select().from(operationRetryReceipts)
      .where(and(eq(operationRetryReceipts.userId, userId), eq(operationRetryReceipts.requestId, input.requestId))).limit(1);
    if (receipt) {
      if (receipt.requestHash !== hash) throw new StudyError(409, 'request_changed');
      return { kind: input.kind, id: input.id, runId: receipt.resultRunId, replayed: true, stale: false };
    }
    const beforeStart = () => {
      const cooldown = checkCooldown();
      if (!cooldown.ok) throw new OperationCooldownError(cooldown.retryAfterMs);
    };
    let updated: { row: { operationRunId: string | null }; stale: boolean };
    if (input.kind === 'source') {
      updated = await reingestSourceInTransaction(tx, userId, input.id, { runId: input.runId, beforeStart });
    } else {
      const [artifact] = await tx.select({ ownerKind: notebookArtifacts.ownerKind, notebookId: notebookArtifacts.notebookId })
        .from(notebookArtifacts).where(and(eq(notebookArtifacts.userId, userId), eq(notebookArtifacts.id, input.id))).limit(1);
      if (!artifact) throw new StudyError(404, 'not_found');
      const owner = artifact.ownerKind === 'notebook' ? { kind: 'notebook' as const, id: artifact.notebookId! } : undefined;
      updated = await regenerateStudyArtifactInTransaction(tx, userId, input.id, owner,
        { runId: input.runId, acceptDefaults: input.acceptDefaults, beforeStart });
    }
    if (!updated.row.operationRunId) throw new StudyError(409, 'run_unavailable');
    if (updated.stale) return { kind: input.kind, id: input.id, runId: updated.row.operationRunId, stale: true, replayed: false };
    await tx.insert(operationRetryReceipts).values({ userId, requestId: input.requestId, kind: input.kind,
      entityId: input.id, observedRunId: input.runId, resultRunId: updated.row.operationRunId, requestHash: hash });
    return { kind: input.kind, id: input.id, runId: updated.row.operationRunId, replayed: false, stale: false };
  });
  // Matching replays do not schedule twice. Durable rows survive commit/enqueue crashes.
  if (!result.replayed && !result.stale) dispatch(result);
  return result;
}

/** Bounded maintenance; an expired receipt cannot make an old run current again. */
export async function cleanupOperationRetryReceipts() {
  await db.execute(sql`DELETE FROM operation_retry_receipts WHERE id IN
    (SELECT id FROM operation_retry_receipts WHERE created_at < now() - interval '7 days' ORDER BY created_at LIMIT 500)`);
}
