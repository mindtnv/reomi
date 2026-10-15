import { expect, test } from 'bun:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { newUuidV7 } from '@reomi/shared';

test('source study migration retains source work and quiz attempts while preserving notebook cascades', async () => {
  const folder = join(import.meta.dir, 'migrations');
  const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8'));
  const entry = journal.entries.find((e: { tag: string }) => e.tag.endsWith('_source_study_ownership'));
  expect(entry).toBeDefined();
  const originalUrl = new URL(process.env.TEST_DATABASE_URL!);
  if (!originalUrl.pathname.includes('test')) throw new Error('Migration fixtures require a test database URL');
  const name = `assistant_migration_${newUuidV7().replaceAll('-', '')}_test`;
  const admin = postgres(originalUrl.toString(), { max: 1, onnotice: () => {} });
  let fixture: ReturnType<typeof postgres> | undefined;
  const beforeFolder = await mkdtemp(join(tmpdir(), 'reomi-context-migrations-'));
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    const fixtureUrl = new URL(originalUrl); fixtureUrl.pathname = `/${name}`;
    fixture = postgres(fixtureUrl.toString(), { max: 1, onnotice: () => {} });
    const prior = journal.entries.filter((e: { idx: number }) => e.idx < entry.idx);
    await mkdir(join(beforeFolder, 'meta'));
    await writeFile(join(beforeFolder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: prior }));
    for (const e of prior) await copyFile(join(folder, `${e.tag}.sql`), join(beforeFolder, `${e.tag}.sql`));
    const database = drizzle(fixture);
    await migrate(database, { migrationsFolder: beforeFolder });
    const owner = newUuidV7(), notebook = newUuidV7(), legacyNote = newUuidV7(), source = newUuidV7();
    await fixture`INSERT INTO "user" (id,name,email) VALUES (${owner}, 'Migration fixture', ${`${owner}@test.dev`})`;
    await fixture`INSERT INTO notebooks (id,user_id,title) VALUES (${notebook},${owner},'Legacy notebook')`;
    await fixture`INSERT INTO notebook_notes (id,user_id,notebook_id,title,content) VALUES (${legacyNote},${owner},${notebook},'Legacy note','Keep existing content')`;
    // Prove the old ownership constraint rejects standalone study rows before
    // applying the migration that introduces their discriminated owner.
    await expect(Promise.resolve(fixture`INSERT INTO notebook_notes (user_id,notebook_id,title,content)
      VALUES (${owner},NULL,'Standalone before migration','Not yet supported')`)).rejects.toMatchObject({ code: '23502' });
    await expect(Promise.resolve(fixture`INSERT INTO notebook_artifacts (user_id,notebook_id,type,status,title,source_ids)
      VALUES (${owner},NULL,'quiz','ready','Standalone before migration','[]'::jsonb)`)).rejects.toMatchObject({ code: '23502' });
    const legacyArtifact = newUuidV7(), legacyAttempt = newUuidV7();
    const legacyQuiz = { questions: [{ id: newUuidV7(), kind: 'tf', prompt: 'Legacy question', answer: true }] };
    await fixture`INSERT INTO notebook_artifacts (id,user_id,notebook_id,type,status,title,source_ids,content_json)
      VALUES (${legacyArtifact},${owner},${notebook},'quiz','ready','Legacy quiz','[]'::jsonb,${JSON.stringify(legacyQuiz)}::jsonb)`;
    await fixture`INSERT INTO quiz_attempts (id,user_id,artifact_id,answers,correct,total)
      VALUES (${legacyAttempt},${owner},${legacyArtifact},'[]'::jsonb,1,1)`;
    await migrate(database, { migrationsFolder: folder });
    await migrate(database, { migrationsFolder: folder });
    const [migratedArtifact] = await fixture`SELECT * FROM notebook_artifacts WHERE id=${legacyArtifact}`;
    expect(migratedArtifact!.owner_kind).toBe('notebook');
    expect(migratedArtifact!.notebook_id).toBe(notebook);
    expect(migratedArtifact!.content_json).toEqual(legacyQuiz);
    expect(await fixture`SELECT id FROM quiz_attempts WHERE id=${legacyAttempt}`).toHaveLength(1);
    const [legacy] = await fixture`SELECT * FROM notebook_notes WHERE id=${legacyNote}`;
    expect(legacy!.owner_kind).toBe('notebook');
    expect(legacy!.notebook_id).toBe(notebook);
    expect(legacy!.content).toBe('Keep existing content');
    await fixture`INSERT INTO sources (id,user_id,kind,title) VALUES (${source},${owner},'text','Original book')`;
    const note = newUuidV7(), artifact = newUuidV7(), attempt = newUuidV7();
    await fixture`INSERT INTO notebook_notes (id,user_id,owner_kind,source_id,source_origin_id,source_origin_title,title,content)
      VALUES (${note},${owner},'source',${source},${source},'Original book','Retained note','My conclusions')`;
    await fixture`INSERT INTO notebook_artifacts (id,user_id,owner_kind,source_id,source_origin_id,source_origin_title,type,status,title,source_ids,content_json)
      VALUES (${artifact},${owner},'source',${source},${source},'Original book','quiz','ready','Retained quiz',${JSON.stringify([source])}::jsonb,'{}'::jsonb)`;
    await fixture`INSERT INTO quiz_attempts (id,user_id,artifact_id,answers,correct,total) VALUES (${attempt},${owner},${artifact},'[]'::jsonb,1,1)`;
    await fixture`DELETE FROM notebooks WHERE id=${notebook}`;
    expect(await fixture`SELECT id FROM notebook_notes WHERE id=${legacyNote}`).toHaveLength(0);
    expect(await fixture`SELECT id FROM notebook_artifacts WHERE id=${legacyArtifact}`).toHaveLength(0);
    expect(await fixture`SELECT id FROM quiz_attempts WHERE id=${legacyAttempt}`).toHaveLength(0);
    expect(await fixture`SELECT id FROM notebook_notes WHERE id=${note}`).toHaveLength(1);
    await fixture`DELETE FROM sources WHERE id=${source}`;
    for (const table of ['notebook_notes', 'notebook_artifacts']) {
      const [retained] = await fixture.unsafe(`SELECT * FROM ${table} WHERE source_origin_id=$1`, [source]);
      expect(retained!.source_id).toBeNull();
      expect(retained!.source_origin_id).toBe(source);
      expect(retained!.source_origin_title).toBe('Original book');
      expect(retained!.notebook_id).toBeNull();
    }
    expect(await fixture`SELECT id FROM quiz_attempts WHERE id=${attempt}`).toHaveLength(1);
    await expect(Promise.resolve(fixture`INSERT INTO notebook_notes (user_id,owner_kind,title,content) VALUES (${owner},'source','Invalid','Missing origin')`)).rejects.toThrow();
    await expect(Promise.resolve(fixture`INSERT INTO notebook_notes (user_id,owner_kind,source_origin_id,source_origin_title,title,content) VALUES (${owner},'notebook',${source},'Book','Invalid','Wrong owner')`)).rejects.toThrow();
    await fixture`DELETE FROM notebook_artifacts WHERE id=${artifact}`;
    expect(await fixture`SELECT id FROM quiz_attempts WHERE id=${attempt}`).toHaveLength(0);
  } finally {
    await fixture?.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
    await rm(beforeFolder, { recursive: true, force: true });
  }
}, 30_000);
