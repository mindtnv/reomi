import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { db } from '@reomi/db';

const migration = readFileSync(new URL('../../../packages/db/src/migrations/0027_dazzling_madame_masque.sql', import.meta.url), 'utf8')
  .split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean);

describe('cloze migration preserves existing data', () => {
  for (const duplicate of [false, true]) {
    test(duplicate ? 'refuses duplicates without silently deleting history' : 'marks aggregates without changing their cards or history', async () => {
      await db.transaction(async (tx) => {
        // Connection-local fixtures shadow unqualified migration table names.
        // ON COMMIT DROP and the transaction prevent leaking them into the pool.
        await tx.execute(sql`CREATE TEMP TABLE cards (LIKE public.cards INCLUDING DEFAULTS) ON COMMIT DROP`);
        await tx.execute(sql`ALTER TABLE pg_temp.cards DROP COLUMN cloze_number`);
        await tx.execute(sql`CREATE TEMP TABLE reviews (LIKE public.reviews INCLUDING DEFAULTS) ON COMMIT DROP`);
        const [card] = await tx.execute<{ id: string }>(sql`INSERT INTO pg_temp.cards
          (user_id, deck_id, note_id, render_kind, render_front_text, reps, stability, due)
          VALUES ('fixture', uuidv7(), uuidv7(), 'cloze', '[…] […]', 7, 12.5, '2026-10-05T00:00:00Z') RETURNING id`);
        await tx.execute(sql`INSERT INTO pg_temp.reviews (user_id,card_id,deck_id,rating,next_due,next_stability,next_difficulty)
          VALUES ('fixture',${card.id},uuidv7(),3,'2026-10-05T00:00:00Z',12.5,4)`);
        const [before] = await tx.execute<{ value: Record<string, unknown> }>(sql`SELECT to_jsonb(c) AS value FROM pg_temp.cards c`);
        const [history] = await tx.execute<{ value: unknown }>(sql`SELECT jsonb_agg(to_jsonb(r)) AS value FROM pg_temp.reviews r`);
        if (duplicate) await tx.execute(sql`INSERT INTO pg_temp.cards (user_id,deck_id,note_id,render_kind)
          SELECT user_id,deck_id,note_id,render_kind FROM pg_temp.cards`);
        let code: string | undefined;
        try {
          await tx.transaction(async (nested) => {
            for (const statement of migration) await nested.execute(sql.raw(statement));
          });
        } catch (error: any) { code = error.cause?.code ?? error.code; }
        expect(code).toBe(duplicate ? '23505' : undefined);
        const rows = await tx.execute<{ value: Record<string, unknown> }>(sql`SELECT to_jsonb(c) AS value FROM pg_temp.cards c`);
        expect(rows).toHaveLength(duplicate ? 2 : 1);
        const original = rows.find((row) => row.value.id === card.id)!.value;
        if (duplicate) expect(original).toEqual(before.value);
        else {
          const { cloze_number, ...rest } = original;
          expect(cloze_number).toBe(0); expect(rest).toEqual(before.value);
        }
        const [afterHistory] = await tx.execute<{ value: unknown }>(sql`SELECT jsonb_agg(to_jsonb(r)) AS value FROM pg_temp.reviews r`);
        expect(afterHistory.value).toEqual(history.value);
      });
    });
  }
});
