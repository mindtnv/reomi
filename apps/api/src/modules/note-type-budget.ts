import { sql } from 'drizzle-orm';
import type { CardTemplate, FieldValues } from '@reomi/shared';
import type { Db } from '@reomi/db';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export const NOTE_TYPE_BUDGET = { notes: 1000, cards: 2000, sourceBytes: 2 * 1024 * 1024, durationMs: 5000 } as const;
export class NoteTypeBudgetError extends Error {
  constructor(readonly code: 'note_type_operation_too_large' | 'note_type_operation_timeout') { super(code); }
}

/** Request-local guards; SET LOCAL cannot leak into a pooled connection. */
export async function startNoteTypeBudget(tx: Tx) {
  const deadline = performance.now() + NOTE_TYPE_BUDGET.durationMs;
  await tx.execute(sql`set local lock_timeout = '750ms'`);
  await tx.execute(sql`set local statement_timeout = '2000ms'`);
  return () => {
    if (performance.now() > deadline) throw new NoteTypeBudgetError('note_type_operation_timeout');
  };
}
export function noteTypeBudgetFailure(error: unknown): string | undefined {
  if (error instanceof NoteTypeBudgetError) return error.code;
  // Drizzle wraps the driver's SQLSTATE in cause. Do not inspect/log SQL text.
  const outer = error as { code?: string; cause?: { code?: string } } | null;
  const code = outer?.cause?.code ?? outer?.code;
  if (code === '55P03') return 'note_type_operation_busy';
  if (code === '57014') return 'note_type_operation_timeout';
}

/** Bound repeated substitutions before the renderer allocates their expansion.
 * Conditions can only omit content, so counting all references is conservative.
 */
export function noteTypeExpansionBytes(templates: CardTemplate[], fields: FieldValues): number {
  let bytes = 0;
  for (const template of templates) {
    for (const side of [template.frontTemplate, template.backTemplate]) {
      bytes += Buffer.byteLength(side);
      for (const match of side.matchAll(/\{\{\s*([#^/]?)\s*([^{}]*?)\s*\}\}/g)) {
        if (!match[1]) bytes += Buffer.byteLength(fields[match[2]!.trim()] ?? '');
        if (bytes > NOTE_TYPE_BUDGET.sourceBytes) throw new NoteTypeBudgetError('note_type_operation_too_large');
      }
    }
  }
  return bytes;
}
