import { expect, test } from 'bun:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { newUuidV7 } from '@reomi/shared';

const TRIGGER_NAMES = [
  'sources_metadata_revision',
  'notebook_notes_metadata_revision',
  'notebooks_metadata_revision',
  'decks_metadata_revision',
  'decks_hierarchy_revision',
] as const;

test('a migration-built database keeps the 0020 backfill, 0027 cloze constraint, and 0038 triggers across another migrate', async () => {
  const folder = join(import.meta.dir, 'migrations');
  const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8'));
  const entry = journal.entries.find((row: { tag: string }) => row.tag === '0020_known_klaw');
  expect(entry).toBeDefined();
  expect(journal.entries.some((row: { tag: string }) => row.tag === '0039_daily_ken_ellis')).toBe(true);
  expect(journal.entries.some((row: { tag: string }) => row.tag === '0040_note_operations')).toBe(true);
  expect(journal.entries.some((row: { tag: string }) => row.tag === '0042_youtube_source')).toBe(true);
  expect(journal.entries.some((row: { tag: string }) => row.tag === '0043_topic_plan')).toBe(true);
  expect(journal.entries.some((row: { tag: string }) => row.tag === '0044_study_day')).toBe(true);
  expect(journal.entries.some((row: { tag: string }) => row.tag === '0045_card_holds')).toBe(true);
  expect(journal.entries.at(-1).tag).toBe('0046_blushing_professor_monster');

  const originalUrl = new URL(process.env.TEST_DATABASE_URL!);
  if (!originalUrl.pathname.includes('test')) {
    throw new Error('Migration fixtures require a test database URL');
  }
  const name = `chain_preservation_${newUuidV7().replaceAll('-', '')}_test`;
  const admin = postgres(originalUrl.toString(), { max: 1, onnotice: () => {} });
  let fixture: ReturnType<typeof postgres> | undefined;
  const beforeFolder = await mkdtemp(join(tmpdir(), 'reomi-chain-migrations-'));
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    const fixtureUrl = new URL(originalUrl);
    fixtureUrl.pathname = `/${name}`;
    fixture = postgres(fixtureUrl.toString(), { max: 1, onnotice: () => {} });
    const prior = journal.entries.filter((row: { idx: number }) => row.idx < entry.idx);
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

    const owner = newUuidV7();
    const notebook = newUuidV7();
    const source = newUuidV7();
    const chunk = newUuidV7();
    await fixture`INSERT INTO "user" (id, name, email) VALUES (${owner}, 'Chain fixture', ${`${owner}@test.dev`})`;
    await fixture`INSERT INTO notebooks (id, user_id, title) VALUES (${notebook}, ${owner}, 'Legacy notebook')`;
    await fixture`INSERT INTO sources (id, user_id, notebook_id, kind, title) VALUES (${source}, ${owner}, ${notebook}, 'text', 'Legacy source')`;
    await fixture`INSERT INTO kb_chunk (id, user_id, source_type, source_id, parent_id, position, text)
      VALUES (${chunk}, ${owner}, 'document', ${source}, ${notebook}, 0, 'legacy passage')`;

    await migrate(database, { migrationsFolder: folder });

    const edge = await fixture`SELECT notebook_id, source_id FROM notebook_sources WHERE source_id = ${source}`;
    expect(edge).toHaveLength(1);
    expect(edge[0]!.notebook_id).toBe(notebook);
    expect(edge[0]!.source_id).toBe(source);
    const parent = await fixture`SELECT parent_id FROM kb_chunk WHERE id = ${chunk}`;
    expect(parent[0]!.parent_id).toBe(source);
    const notebookColumn = await fixture`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'sources' AND column_name = 'notebook_id'`;
    expect(notebookColumn).toHaveLength(0);

    await fixture`COMMENT ON TABLE notebook_sources IS 'manual-object'`;
    const beforeMigrations = await fixture`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;

    await migrate(database, { migrationsFolder: folder });

    const afterMigrations = await fixture`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
    expect(Number(afterMigrations[0]!.n)).toBe(Number(beforeMigrations[0]!.n));
    expect(Number(afterMigrations[0]!.n)).toBe(journal.entries.length);

    const kept = await fixture`SELECT notebook_id, source_id FROM notebook_sources WHERE source_id = ${source}`;
    expect(kept).toEqual(edge);
    expect((await fixture`SELECT parent_id FROM kb_chunk WHERE id = ${chunk}`)[0]!.parent_id).toBe(source);
    expect((await fixture`SELECT obj_description('notebook_sources'::regclass) AS comment`)[0]!.comment).toBe(
      'manual-object',
    );

    const triggers = await fixture`
      SELECT tgname FROM pg_trigger
      WHERE NOT tgisinternal AND tgname IN ${fixture([...TRIGGER_NAMES])}
      ORDER BY tgname`;
    expect(triggers.map((row) => row.tgname)).toEqual([...TRIGGER_NAMES].sort());

    const constraint = await fixture`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conname = 'cards_note_template_cloze_uq'`;
    expect(constraint).toHaveLength(1);
    expect(constraint[0]!.definition).toContain('UNIQUE NULLS NOT DISTINCT');
    expect(constraint[0]!.definition).toContain('note_id');
    expect(constraint[0]!.definition).toContain('template_ord');
    expect(constraint[0]!.definition).toContain('cloze_number');
  } finally {
    await fixture?.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
    await rm(beforeFolder, { recursive: true, force: true });
  }
}, 90_000);
