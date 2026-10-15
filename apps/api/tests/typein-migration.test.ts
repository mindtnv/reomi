import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { db } from '@reomi/db';

const statements = readFileSync(new URL('../../../packages/db/src/migrations/0028_broad_blizzard.sql', import.meta.url), 'utf8')
  .split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean);

test('typed-answer migration pins the old last field without reordering or changing content', async () => {
  await db.transaction(async (tx) => {
    await tx.execute(sql`CREATE TEMP TABLE notes (LIKE public.notes INCLUDING DEFAULTS) ON COMMIT DROP`);
    await tx.execute(sql`ALTER TABLE pg_temp.notes DROP COLUMN accepted_answers`);
    await tx.execute(sql`CREATE TEMP TABLE note_types (LIKE public.note_types INCLUDING DEFAULTS) ON COMMIT DROP`);
    await tx.execute(sql`INSERT INTO pg_temp.note_types (name,kind,fields,templates,updated_at) VALUES
      ('Legacy','typein','[{"name":"Answer","ord":2,"id":"stable-answer"},{"name":"Prompt","ord":0},{"name":"Extra","ord":1}]','[]','2026-01-01'),
      ('Pinned','typein','[{"name":"Answer","ord":0,"typeinAnswer":true},{"name":"Extra","ord":1}]','[]','2026-01-01'),
      ('Ordinary','basic','[{"name":"Front","ord":0}]','[]','2026-01-01')`);
    await tx.execute(sql`INSERT INTO pg_temp.notes (user_id,note_type_id,field_values,tags)
      SELECT 'fixture',id,'{"Answer":"**Paris**","Prompt":"Capital?"}',ARRAY['preserve'] FROM pg_temp.note_types WHERE name='Legacy'`);
    const [before] = await tx.execute<{ value: Record<string, unknown> }>(sql`SELECT to_jsonb(n) AS value FROM pg_temp.notes n`);
    for (const statement of statements) await tx.execute(sql.raw(statement));
    const rows = await tx.execute<{ name: string; fields: any[]; updated_at: Date }>(sql`SELECT name,fields,updated_at FROM pg_temp.note_types ORDER BY name`);
    expect(rows.find((row) => row.name === 'Legacy')!.fields).toEqual([
      { name: 'Answer', ord: 2, id: 'stable-answer', typeinAnswer: true }, { name: 'Prompt', ord: 0 }, { name: 'Extra', ord: 1 },
    ]);
    expect(rows.find((row) => row.name === 'Pinned')!.fields).toEqual([{ name: 'Answer', ord: 0, typeinAnswer: true }, { name: 'Extra', ord: 1 }]);
    expect(rows.find((row) => row.name === 'Ordinary')!.fields).toEqual([{ name: 'Front', ord: 0 }]);
    const [after] = await tx.execute<{ value: Record<string, unknown> }>(sql`SELECT to_jsonb(n) AS value FROM pg_temp.notes n`);
    const { accepted_answers, ...rest } = after.value;
    expect(accepted_answers).toEqual([]); expect(rest).toEqual(before.value);
    await tx.execute(sql.raw(statements[1]));
    expect(await tx.execute(sql`SELECT name,fields,updated_at FROM pg_temp.note_types ORDER BY name`)).toEqual(rows);
  });
});
