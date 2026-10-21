import { expect, test } from 'bun:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { newUuidV7 } from '@reomi/shared';

function instant(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return date.toISOString();
}

test('0044 backfills UTC dates and does not insert a study-day policy', async () => {
  const folder = join(import.meta.dir, 'migrations');
  const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; tag: string; when: number }>;
  };
  const studyDay = journal.entries.find((row) => row.tag === '0044_study_day');
  expect(studyDay?.idx).toBe(44);
  expect(studyDay?.when).toBeGreaterThan(1792079543018);
  expect(journal.entries.at(-1)?.idx).toBeGreaterThan(44);
  expect(journal.entries.some(row => row.tag === '0049_library_folder_metadata_revision')).toBe(true);
  expect(journal.entries.at(-1)?.tag).toBe('0052_high_darkhawk');

  const prior = journal.entries.filter((row) => row.idx < 44);
  expect(prior.at(-1)?.tag).toBe('0043_topic_plan');

  const originalUrl = new URL(process.env.TEST_DATABASE_URL!);
  if (!originalUrl.pathname.includes('test')) {
    throw new Error('Migration fixtures require a test database URL');
  }
  const name = `study_day_backfill_${newUuidV7().replaceAll('-', '')}_test`;
  const admin = postgres(originalUrl.toString(), { max: 1, onnotice: () => {} });
  let fixture: ReturnType<typeof postgres> | undefined;
  const beforeFolder = await mkdtemp(join(tmpdir(), 'reomi-study-day-before-'));
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    const fixtureUrl = new URL(originalUrl);
    fixtureUrl.pathname = `/${name}`;
    fixture = postgres(fixtureUrl.toString(), { max: 1, onnotice: () => {} });
    await mkdir(join(beforeFolder, 'meta'));
    await writeFile(
      join(beforeFolder, 'meta/_journal.json'),
      JSON.stringify({ ...journal, entries: prior }),
    );
    for (const row of prior) {
      await copyFile(join(folder, `${row.tag}.sql`), join(beforeFolder, `${row.tag}.sql`));
    }
    const database = drizzle(fixture);
    await migrate(database, { migrationsFolder: beforeFolder });

    const stale = newUuidV7();
    const aligned = newUuidV7();
    const countsOnly = newUuidV7();
    const anchorOnly = newUuidV7();
    const empty = newUuidV7();
    await fixture`
      INSERT INTO "user" (id, name, email) VALUES
        (${stale}, 'Stale', ${`${stale}@test.dev`}),
        (${aligned}, 'Aligned', ${`${aligned}@test.dev`}),
        (${countsOnly}, 'Counts', ${`${countsOnly}@test.dev`}),
        (${anchorOnly}, 'Anchor', ${`${anchorOnly}@test.dev`}),
        (${empty}, 'Empty', ${`${empty}@test.dev`})
    `;
    await fixture`
      INSERT INTO profile (
        user_id, name, daily_counts_date, today_minutes_date,
        new_introduced_today, reviews_done_today, today_minutes,
        last_review_date, daily_goal_met_date, streak_days, daily_goal_met_count
      ) VALUES
        (${stale}, 'Stale', '2026-10-14', '2026-10-15', 3, 4, 40, '2026-10-13', '2026-10-15', 9, 2),
        (${aligned}, 'Aligned', '2026-10-15', '2026-10-15', 2, 5, 12, '2026-10-15', NULL, 4, 0),
        (${countsOnly}, 'Counts', '2026-10-10', NULL, 7, 8, 3, NULL, NULL, 1, 0),
        (${anchorOnly}, 'Anchor', NULL, NULL, 6, 6, 9, '2026-10-01', NULL, 3, 1),
        (${empty}, 'Empty', NULL, NULL, 0, 0, 0, NULL, NULL, 0, 0)
    `;

    const deck = newUuidV7();
    const noteType = newUuidV7();
    const note = newUuidV7();
    const card = newUuidV7();
    const late = newUuidV7();
    const midnight = newUuidV7();
    await fixture`
      INSERT INTO decks (id, user_id, name) VALUES (${deck}, ${stale}, 'Backfill')
    `;
    await fixture`
      INSERT INTO note_types (id, user_id, name, fields, templates)
      VALUES (${noteType}, ${stale}, 'Backfill', '[]'::jsonb, '[]'::jsonb)
    `;
    await fixture`
      INSERT INTO notes (id, user_id, note_type_id, field_values)
      VALUES (${note}, ${stale}, ${noteType}, '{}'::jsonb)
    `;
    await fixture`
      INSERT INTO cards (id, user_id, deck_id, note_id) VALUES (${card}, ${stale}, ${deck}, ${note})
    `;
    await fixture`
      INSERT INTO reviews (
        id, user_id, card_id, rating, reviewed_at, next_due, next_stability, next_difficulty
      ) VALUES
        (${late}, ${stale}, ${card}, 3, ${'2026-10-15T23:30:00.000Z'}, ${'2026-10-20T00:00:00.000Z'}, 1, 5),
        (${midnight}, ${stale}, ${card}, 3, ${'2026-10-16T00:00:00.000Z'}, ${'2026-10-20T00:00:00.000Z'}, 1, 5)
    `;

    await migrate(database, { migrationsFolder: folder });

    const policies = await fixture`SELECT count(*)::int AS n FROM study_day_policy`;
    expect(policies[0]!.n).toBe(0);

    const staleRow = await fixture`
      SELECT study_epoch_start, study_epoch_end, daily_counts_date, today_minutes_date,
             new_introduced_today, reviews_done_today, today_minutes,
             last_review_epoch_end, goal_met_epoch_start, streak_days, daily_goal_met_count
      FROM profile WHERE user_id = ${stale}
    `;
    expect(instant(staleRow[0]!.study_epoch_start)).toBe('2026-10-15T00:00:00.000Z');
    expect(instant(staleRow[0]!.study_epoch_end)).toBe('2026-10-16T00:00:00.000Z');
    expect(staleRow[0]!.daily_counts_date).toBe('2026-10-15');
    expect(staleRow[0]!.today_minutes_date).toBe('2026-10-15');
    expect(staleRow[0]!.new_introduced_today).toBe(0);
    expect(staleRow[0]!.reviews_done_today).toBe(0);
    expect(staleRow[0]!.today_minutes).toBe(40);
    expect(instant(staleRow[0]!.last_review_epoch_end)).toBe('2026-10-14T00:00:00.000Z');
    expect(instant(staleRow[0]!.goal_met_epoch_start)).toBe('2026-10-15T00:00:00.000Z');
    expect(staleRow[0]!.streak_days).toBe(9);
    expect(staleRow[0]!.daily_goal_met_count).toBe(2);

    const alignedRow = await fixture`
      SELECT study_epoch_start, study_epoch_end, new_introduced_today, reviews_done_today,
             today_minutes, daily_counts_date, last_review_epoch_end, goal_met_epoch_start
      FROM profile WHERE user_id = ${aligned}
    `;
    expect(instant(alignedRow[0]!.study_epoch_start)).toBe('2026-10-15T00:00:00.000Z');
    expect(instant(alignedRow[0]!.study_epoch_end)).toBe('2026-10-16T00:00:00.000Z');
    expect(alignedRow[0]!.new_introduced_today).toBe(2);
    expect(alignedRow[0]!.reviews_done_today).toBe(5);
    expect(alignedRow[0]!.today_minutes).toBe(12);
    expect(alignedRow[0]!.daily_counts_date).toBe('2026-10-15');
    expect(instant(alignedRow[0]!.last_review_epoch_end)).toBe('2026-10-16T00:00:00.000Z');
    expect(alignedRow[0]!.goal_met_epoch_start).toBeNull();

    const countsRow = await fixture`
      SELECT study_epoch_start, study_epoch_end, daily_counts_date, today_minutes_date,
             new_introduced_today, reviews_done_today, today_minutes, last_review_epoch_end
      FROM profile WHERE user_id = ${countsOnly}
    `;
    expect(instant(countsRow[0]!.study_epoch_start)).toBe('2026-10-10T00:00:00.000Z');
    expect(instant(countsRow[0]!.study_epoch_end)).toBe('2026-10-11T00:00:00.000Z');
    expect(countsRow[0]!.daily_counts_date).toBe('2026-10-10');
    expect(countsRow[0]!.today_minutes_date).toBeNull();
    expect(countsRow[0]!.new_introduced_today).toBe(7);
    expect(countsRow[0]!.reviews_done_today).toBe(8);
    expect(countsRow[0]!.today_minutes).toBe(0);
    expect(countsRow[0]!.last_review_epoch_end).toBeNull();

    const anchorRow = await fixture`
      SELECT study_epoch_start, study_epoch_end, new_introduced_today, reviews_done_today,
             today_minutes, last_review_epoch_end, goal_met_epoch_start, streak_days, daily_goal_met_count
      FROM profile WHERE user_id = ${anchorOnly}
    `;
    expect(anchorRow[0]!.study_epoch_start).toBeNull();
    expect(anchorRow[0]!.study_epoch_end).toBeNull();
    expect(anchorRow[0]!.new_introduced_today).toBe(6);
    expect(anchorRow[0]!.reviews_done_today).toBe(6);
    expect(anchorRow[0]!.today_minutes).toBe(9);
    expect(instant(anchorRow[0]!.last_review_epoch_end)).toBe('2026-10-02T00:00:00.000Z');
    expect(anchorRow[0]!.goal_met_epoch_start).toBeNull();
    expect(anchorRow[0]!.streak_days).toBe(3);
    expect(anchorRow[0]!.daily_goal_met_count).toBe(1);

    const emptyRow = await fixture`
      SELECT study_epoch_start, study_epoch_end, last_review_epoch_end, goal_met_epoch_start
      FROM profile WHERE user_id = ${empty}
    `;
    expect(emptyRow[0]!.study_epoch_start).toBeNull();
    expect(emptyRow[0]!.study_epoch_end).toBeNull();
    expect(emptyRow[0]!.last_review_epoch_end).toBeNull();
    expect(emptyRow[0]!.goal_met_epoch_start).toBeNull();

    const lateRow = await fixture`
      SELECT study_day, study_epoch_start FROM reviews WHERE id = ${late}
    `;
    expect(lateRow[0]!.study_day).toBe('2026-10-15');
    expect(instant(lateRow[0]!.study_epoch_start)).toBe('2026-10-15T00:00:00.000Z');
    const midnightRow = await fixture`
      SELECT study_day, study_epoch_start FROM reviews WHERE id = ${midnight}
    `;
    expect(midnightRow[0]!.study_day).toBe('2026-10-16');
    expect(instant(midnightRow[0]!.study_epoch_start)).toBe('2026-10-16T00:00:00.000Z');
  } finally {
    await fixture?.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}"`);
    await admin.end();
    await rm(beforeFolder, { recursive: true, force: true });
  }
});
