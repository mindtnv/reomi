import { expect, test } from 'bun:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { newUuidV7 } from '@reomi/shared';

test('context migration preserves old transcripts and approvals, backfills notebooks, and detaches deleted context', async () => {
  const folder = join(import.meta.dir, 'migrations');
  const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8'));
  const entry = journal.entries.find((e: { tag: string }) => e.tag.endsWith('_assistant_context'));
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
    const owner = newUuidV7(), notebook = newUuidV7(), thread = newUuidV7(), message = newUuidV7(), global = newUuidV7();
    await fixture`INSERT INTO "user" (id,name,email) VALUES (${owner}, 'Migration fixture', ${`${owner}@test.dev`})`;
    await fixture`INSERT INTO notebooks (id,user_id,title) VALUES (${notebook},${owner},'Legacy book')`;
    await fixture`INSERT INTO conversations (id,user_id,notebook_id,title) VALUES (${thread},${owner},${notebook},'Legacy thread'), (${global},${owner},NULL,'Global')`;
    const pending = [{ id: 'call_legacy', name: 'create_card', arguments: '{"front":"Question"}', status: 'pending' }];
    await fixture`INSERT INTO messages (id,conversation_id,user_id,role,content,tool_calls) VALUES (${message},${thread},${owner},'assistant','',${JSON.stringify(pending)}::jsonb)`;
    const type = newUuidV7(), note = newUuidV7(), deck = newUuidV7(), card = newUuidV7(), review = newUuidV7();
    await fixture`INSERT INTO note_types (id,user_id,name,fields,templates,kind) VALUES (${type},${owner},'Legacy type',
      '[{"name":"Front","ord":0},{"name":"Back","ord":1}]'::jsonb,
      '[{"ord":0,"name":"Card 1","qfmt":"{{Front}}","afmt":"{{Back}}"}]'::jsonb,'basic')`;
    await fixture`INSERT INTO notes (id,user_id,note_type_id,field_values,tags) VALUES (${note},${owner},${type},'{"Front":"Legacy question","Back":"Legacy answer"}'::jsonb,ARRAY['retained'])`;
    await fixture`INSERT INTO decks (id,user_id,name) VALUES (${deck},${owner},'Legacy deck')`;
    await fixture`INSERT INTO cards (id,user_id,deck_id,note_id,render_text,state,due,stability,difficulty,elapsed_days,scheduled_days,reps,lapses,last_review,suspended)
      VALUES (${card},${owner},${deck},${note},'Legacy question Legacy answer','review','2027-04-01T00:00:00Z',12.5,4.2,3,12,7,2,'2026-03-20T12:00:00Z',true)`;
    await fixture`INSERT INTO reviews (id,user_id,card_id,deck_id,rating,duration_ms,reviewed_at,next_due,next_stability,next_difficulty)
      VALUES (${review},${owner},${card},${deck},3,1234,'2026-03-20T12:00:00Z','2027-04-01T00:00:00Z',12.5,4.2)`;
    const beforeCard = [...await fixture`SELECT * FROM cards WHERE id=${card}`];
    const beforeNote = [...await fixture`SELECT * FROM notes WHERE id=${note}`];
    const beforeReview = [...await fixture`SELECT * FROM reviews WHERE id=${review}`];
    await migrate(database, { migrationsFolder: folder });
    await migrate(database, { migrationsFolder: folder });
    expect([...await fixture`SELECT * FROM cards WHERE id=${card}`]).toEqual(beforeCard);
    expect([...await fixture`SELECT * FROM notes WHERE id=${note}`]).toEqual(beforeNote);
    expect([...await fixture`SELECT * FROM reviews WHERE id=${review}`]).toEqual(beforeReview);
    const contexts = await fixture`SELECT * FROM conversation_contexts WHERE conversation_id=${thread}`;
    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.object_id).toBe(notebook);
    expect(contexts[0]!.snapshot.label).toBe('Legacy book');
    expect((await fixture`SELECT context_policy FROM conversations WHERE id=${thread}`)[0]!.context_policy).toBe('strict');
    expect((await fixture`SELECT context_policy FROM conversations WHERE id=${global}`)[0]!.context_policy).toBe('focus');
    await fixture`DELETE FROM notebooks WHERE id=${notebook}`;
    const remaining = await fixture`SELECT notebook_id FROM conversations WHERE id=${thread}`;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.notebook_id).toBeNull();
    expect((await fixture`SELECT tool_calls FROM messages WHERE id=${message}`)[0]!.tool_calls).toEqual(pending);
    expect(await fixture`SELECT id FROM conversation_contexts WHERE conversation_id=${thread}`).toHaveLength(1);
    expect([...await fixture`SELECT * FROM cards WHERE id=${card}`]).toEqual(beforeCard);
    expect([...await fixture`SELECT * FROM reviews WHERE id=${review}`]).toEqual(beforeReview);
    await fixture`DELETE FROM conversations WHERE id=${thread}`;
    expect(await fixture`SELECT id FROM messages WHERE id=${message}`).toHaveLength(0);
    expect(await fixture`SELECT id FROM conversation_contexts WHERE conversation_id=${thread}`).toHaveLength(0);
  } finally {
    await fixture?.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
    await rm(beforeFolder, { recursive: true, force: true });
  }
}, 30_000);
