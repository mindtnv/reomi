import { and, asc, eq, inArray, isNull, lte, ne, or } from 'drizzle-orm';
import { db, libraryDocumentation as collections } from '@reomi/db';
import { newUuidV7 } from '@reomi/shared';
import { DocumentationError, updateDocumentation } from '../modules/library-documentation-service';

export interface DocumentationClaim { id: string; userId: string; claimId: string }
const CLAIM_MS = 5 * 60_000;

/** Short row lock only; network discovery runs after commit with a fenced lease. */
export async function claimDocumentationCheck(now = new Date()): Promise<DocumentationClaim | null> {
  return db.transaction(async tx => {
    const [row] = await tx.select().from(collections).where(and(
      ne(collections.schedule, 'off'), lte(collections.nextSyncAt, now), inArray(collections.state, ['completed', 'attention']),
      or(isNull(collections.syncClaimUntil), lte(collections.syncClaimUntil, now)),
    )).orderBy(asc(collections.nextSyncAt)).limit(1).for('update', { skipLocked: true });
    if (!row) return null;
    const claimId = newUuidV7();
    await tx.update(collections).set({ syncClaimId: claimId, syncClaimUntil: new Date(now.getTime() + CLAIM_MS) }).where(eq(collections.id, row.id));
    return { id: row.id, userId: row.userId, claimId };
  });
}

export async function runClaimedDocumentationCheck(claim: DocumentationClaim) {
  try { await updateDocumentation(claim.userId, claim.id, claim.claimId); }
  catch (error) {
    // A settings change, disconnect or newer claim owns the result now.
    await db.transaction(async tx => {
      const [row] = await tx.select().from(collections).where(and(eq(collections.id, claim.id),
        eq(collections.userId, claim.userId), eq(collections.syncClaimId, claim.claimId), ne(collections.schedule, 'off'))).for('update');
      if (!row) return;
      const failures = Math.min(row.syncFailures + 1, 6);
      const delay = Math.min(6 * 3_600_000, 15 * 60_000 * 2 ** (failures - 1));
      await tx.update(collections).set({ syncClaimId: null, syncClaimUntil: null, syncFailures: failures,
        syncError: error instanceof DocumentationError ? error.message : 'documentation_unavailable',
        nextSyncAt: new Date(Date.now() + delay), updatedAt: new Date() }).where(eq(collections.id, row.id));
    });
  }
}

/** One bounded discovery per pass; page imports keep priority. */
export async function runDueDocumentationCheck(): Promise<boolean> {
  const claim = await claimDocumentationCheck();
  if (!claim) return false;
  await runClaimedDocumentationCheck(claim);
  return true;
}
