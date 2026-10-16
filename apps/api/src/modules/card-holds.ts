import { Elysia, status, t } from 'elysia';
import { and, asc, eq, inArray, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { cards, db, notes, profile } from '@reomi/db';
import { StudyDayError, type CardHoldView, type HoldReason } from '@reomi/shared';
import { authPlugin } from '../auth-plugin.ts';
import { readAccountStudyDay, readDatabaseNow, type SqlExecutor } from './study-day.ts';

export const MAX_HOLD_CARDS = 1000;

export type UserHoldCommand =
  | { action: 'bury' | 'unbury'; cardIds: readonly string[] }
  | { action: 'bury' | 'unbury'; noteId: string };

export type HoldReceipt =
  | { action: 'bury'; until: string; cardIds: string[]; changed: number }
  | { action: 'unbury'; until: null; cardIds: string[]; changed: number };

export type UserHoldResult =
  | ({ ok: true } & HoldReceipt)
  | { ok: false; code: 400 | 404 | 409; error: 'invalid_hold' | 'not_found' | 'epoch_mismatch' };

type HoldWriter = Pick<typeof db, 'transaction' | 'select' | 'execute'>;

function asRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function idList(ids: readonly string[]): SQL {
  return sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
}

function isHoldReason(value: string): value is HoldReason {
  return value === 'user' || value === 'sibling';
}

/** `buried_until > instant`. Callers pass the database instant, or a forecast span's start. */
export function excludeActiveHolds(cardId: SQLWrapper, instant: Date | SQL): SQL {
  const at = instant instanceof Date ? sql`${instant.toISOString()}::timestamptz` : instant;
  return sql`not exists (select 1 from card_holds h where h.card_id = ${cardId} and h.buried_until > ${at})`;
}

export async function loadActiveHolds(
  cardIds: readonly string[],
  now: Date,
  executor: SqlExecutor = db,
): Promise<Map<string, CardHoldView>> {
  const found = new Map<string, CardHoldView>();
  if (cardIds.length === 0) return found;
  const rows = asRows<{ cardId: string; until: Date | string; reason: string }>(await executor.execute(sql`
    SELECT card_id AS "cardId", buried_until AS "until", reason
    FROM card_holds
    WHERE card_id IN (${idList(cardIds)})
      AND buried_until > ${now.toISOString()}::timestamptz
  `));
  for (const row of rows) {
    if (!isHoldReason(row.reason)) continue;
    const until = row.until instanceof Date ? row.until : new Date(row.until);
    if (!Number.isFinite(until.getTime())) continue;
    found.set(row.cardId, { until: until.toISOString(), reason: row.reason });
  }
  return found;
}

export async function activeHoldCardIds(
  userId: string,
  now: Date,
  membership: SQL,
  executor: SqlExecutor = db,
): Promise<string[]> {
  const rows = asRows<{ cardId: string }>(await executor.execute(sql`
    SELECT h.card_id AS "cardId"
    FROM card_holds h
    JOIN cards ON cards.id = h.card_id
    WHERE h.user_id = ${userId}
      AND h.buried_until > ${now.toISOString()}::timestamptz
      AND ${membership}
  `));
  return rows.map((row) => row.cardId);
}

function emptyReceipt(action: 'bury' | 'unbury'): UserHoldResult {
  if (action === 'unbury') return { ok: true, action, until: null, cardIds: [], changed: 0 };
  // The study-day read sits inside the transaction this empty set skips, so there is no instant to report.
  return { ok: true, action, until: '', cardIds: [], changed: 0 };
}

async function ownedCardIds(userId: string, command: UserHoldCommand): Promise<
  { ok: true; ids: string[] } | { ok: false; code: 400 | 404; error: 'invalid_hold' | 'not_found' }
> {
  if ('cardIds' in command) {
    if (command.cardIds.length === 0 || command.cardIds.length > MAX_HOLD_CARDS) {
      return { ok: false, code: 400, error: 'invalid_hold' };
    }
    const rows = await db
      .select({ id: cards.id })
      .from(cards)
      .where(and(eq(cards.userId, userId), inArray(cards.id, [...command.cardIds])));
    return { ok: true, ids: rows.map((row) => row.id).sort() };
  }
  const [note] = await db
    .select({ id: notes.id })
    .from(notes)
    .where(and(eq(notes.id, command.noteId), eq(notes.userId, userId)))
    .limit(1);
  if (!note) return { ok: false, code: 404, error: 'not_found' };
  const rows = await db
    .select({ id: cards.id })
    .from(cards)
    .where(and(eq(cards.userId, userId), eq(cards.noteId, note.id)));
  if (rows.length > MAX_HOLD_CARDS) return { ok: false, code: 400, error: 'invalid_hold' };
  return { ok: true, ids: rows.map((row) => row.id).sort() };
}

function changedFlag(value: unknown): boolean {
  return value === true || value === 't' || value === 'true';
}

export async function applyUserHold(
  userId: string,
  command: UserHoldCommand,
  now: Date,
  executor: HoldWriter = db,
): Promise<UserHoldResult> {
  const owned = await ownedCardIds(userId, command);
  if (!owned.ok) return owned;
  if (owned.ids.length === 0) return emptyReceipt(command.action);
  const ids = owned.ids;

  return executor.transaction(async (tx) => {
    const [profileRow] = await tx
      .select()
      .from(profile)
      .where(eq(profile.userId, userId))
      .limit(1)
      .for('share');
    await tx
      .select({ id: cards.id })
      .from(cards)
      .where(and(eq(cards.userId, userId), inArray(cards.id, ids)))
      .orderBy(asc(cards.id))
      .for('share');

    if (command.action === 'unbury') {
      const deleted = asRows<{ cardId: string }>(await tx.execute(sql`
        DELETE FROM card_holds h
        USING cards c
        WHERE h.card_id = c.id
          AND c.user_id = ${userId}
          AND c.id IN (${idList(ids)})
          AND h.reason = 'user'
        RETURNING h.card_id AS "cardId"
      `));
      const cardIds = deleted.map((row) => row.cardId);
      return { ok: true, action: 'unbury', until: null, cardIds, changed: cardIds.length };
    }

    let until: Date;
    try {
      const { read } = await readAccountStudyDay(userId, profileRow ?? null, now, tx);
      until = read.endsAt;
    } catch (err) {
      if (err instanceof StudyDayError) return { ok: false, code: 409, error: 'epoch_mismatch' };
      throw err;
    }
    if (until.getTime() <= now.getTime()) return { ok: false, code: 409, error: 'epoch_mismatch' };

    const written = asRows<{ id: string; changed: unknown }>(await tx.execute(sql`
      WITH chosen AS (
        SELECT id, user_id FROM cards
        WHERE user_id = ${userId} AND id IN (${idList(ids)})
      ),
      written AS (
        INSERT INTO card_holds (card_id, user_id, buried_until, reason)
        SELECT id, user_id, ${until.toISOString()}::timestamptz, 'user' FROM chosen
        ON CONFLICT (card_id) DO UPDATE
          SET buried_until = EXCLUDED.buried_until,
              reason = 'user',
              updated_at = now()
          WHERE card_holds.buried_until IS DISTINCT FROM EXCLUDED.buried_until
             OR card_holds.reason IS DISTINCT FROM 'user'
        RETURNING card_id
      )
      SELECT chosen.id AS id,
             EXISTS (SELECT 1 FROM written w WHERE w.card_id = chosen.id) AS changed
      FROM chosen
    `));
    return {
      ok: true,
      action: 'bury',
      until: until.toISOString(),
      cardIds: written.map((row) => row.id),
      changed: written.filter((row) => changedFlag(row.changed)).length,
    };
  });
}

function commandFrom(body: {
  action: 'bury' | 'unbury';
  cardIds?: string[];
  noteId?: string;
}): UserHoldCommand | null {
  const hasCards = body.cardIds !== undefined;
  const hasNote = body.noteId !== undefined;
  if (hasCards === hasNote) return null;
  if (hasNote) return { action: body.action, noteId: body.noteId! };
  return { action: body.action, cardIds: body.cardIds! };
}

export const cardHoldsModule = new Elysia()
  .use(authPlugin)
  .post(
    '/holds',
    async ({ user, body }) => {
      const command = commandFrom(body);
      if (!command) return status(400, { error: 'invalid_hold' });
      const result = await applyUserHold(user.id, command, await readDatabaseNow());
      if (!result.ok) return status(result.code, { error: result.error });
      return {
        action: result.action,
        until: result.until,
        cardIds: result.cardIds,
        changed: result.changed,
      };
    },
    {
      auth: true,
      body: t.Object({
        action: t.Union([t.Literal('bury'), t.Literal('unbury')]),
        cardIds: t.Optional(t.Array(t.String({ format: 'uuid' }))),
        noteId: t.Optional(t.String({ format: 'uuid' })),
      }),
    },
  );
