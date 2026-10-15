import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { newUuidV7 } from '@reomi/shared';

for (const storedHash of [null, 'hash \"quoted\" \\ value'] as const) test(`legacy backlink migration preserves evidence with ${storedHash === null ? 'null' : 'string'} source hashes`, async () => {
  const folder = join(import.meta.dir, 'migrations');
  const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8'));
  const entry = journal.entries.find((row: { tag: string }) => row.tag.endsWith('_legacy_card_evidence'));
  expect(entry).toBeDefined();
  const originalUrl = new URL(process.env.TEST_DATABASE_URL!);
  if (!originalUrl.pathname.includes('test')) throw Error('Test database required');
  const name = `evidence_migration_${newUuidV7().replaceAll('-', '')}_test`;
  const admin = postgres(originalUrl.toString(), { max: 1, onnotice: () => {} });
  let fixture: ReturnType<typeof postgres> | undefined;
  const beforeFolder = await mkdtemp(join(tmpdir(), 'reomi-evidence-migrations-'));
  try {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    const url = new URL(originalUrl); url.pathname = `/${name}`;
    fixture = postgres(url.toString(), { max: 1, onnotice: () => {} });
    const prior = journal.entries.filter((row: { idx: number }) => row.idx < entry.idx);
    await mkdir(join(beforeFolder, 'meta'));
    await writeFile(join(beforeFolder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries: prior }));
    for (const row of prior) await copyFile(join(folder, `${row.tag}.sql`), join(beforeFolder, `${row.tag}.sql`));
    const database = drizzle(fixture); await migrate(database, { migrationsFolder: beforeFolder });
    const owner = newUuidV7(), type = newUuidV7(), note = newUuidV7(), deck = newUuidV7(), card = newUuidV7(), source = newUuidV7(), chunk = newUuidV7();
    const legacy = newUuidV7(), fallback = newUuidV7(), modern = newUuidV7(), gone = newUuidV7(), foreignLink = newUuidV7();
    const title = 'T'.repeat(199) + '🧠extra';
    const text = 'A "quoted" path \\ and newline\n' + '🧠'.repeat(170);
    const modernSnapshot = { version: 1, kind: 'user_quote', sourceId: source, sourceTitle: 'Original modern title', sourceVersion: '2026-09-21T00:00:00.123Z', quote: 'Keep the precise quote' };
    await fixture`INSERT INTO "user" (id,name,email) VALUES (${owner},'Fixture',${`${owner}@test.dev`})`;
    await fixture`INSERT INTO note_types (id,user_id,name,fields,templates) VALUES (${type},${owner},'Fixture','[]'::jsonb,'[]'::jsonb)`;
    await fixture`INSERT INTO notes (id,user_id,note_type_id,field_values) VALUES (${note},${owner},${type},'{"Front":"Question","Back":"Answer"}'::jsonb)`;
    await fixture`INSERT INTO decks (id,user_id,name) VALUES (${deck},${owner},'Fixture')`;
    await fixture`INSERT INTO cards (id,user_id,note_id,deck_id) VALUES (${card},${owner},${note},${deck})`;
    await fixture`INSERT INTO sources (id,user_id,kind,title,status,updated_at) VALUES (${source},${owner},'text',${title},'ready','2026-09-21T00:00:00.123456Z')`;
    await fixture`INSERT INTO source_chunks (id,user_id,source_id,position,page,text,source_hash) VALUES (${chunk},${owner},${source},7,2,${text},${storedHash})`;
    await fixture`INSERT INTO card_sources (id,user_id,card_id,source_id,source_chunk_id,source_snapshot) VALUES
      (${legacy},${owner},${card},${source},${chunk},NULL), (${fallback},${owner},${card},${source},NULL,NULL),
      (${modern},${owner},${card},${source},NULL,${JSON.stringify(modernSnapshot)}::jsonb), (${gone},${owner},${card},NULL,NULL,NULL)`;
    const foreignOwner = newUuidV7(), foreignSource = newUuidV7();
    await fixture`INSERT INTO "user" (id,name,email) VALUES (${foreignOwner},'Other fixture',${`${foreignOwner}@test.dev`})`;
    await fixture`INSERT INTO sources (id,user_id,kind,title) VALUES (${foreignSource},${foreignOwner},'text','Foreign private title')`;
    await fixture`INSERT INTO card_sources (id,user_id,card_id,source_id) VALUES (${foreignLink},${owner},${card},${foreignSource})`;
    await migrate(database, { migrationsFolder: folder }); await migrate(database, { migrationsFolder: folder });
    const rows = await fixture`SELECT * FROM card_sources WHERE user_id=${owner}`;
    const snapshot = rows.find(row => row.id === legacy)!.source_snapshot;
    expect(snapshot).toMatchObject({ version: 1, kind: 'chunk', sourceId: source, chunkId: chunk, position: 7, page: 2 });
    expect(snapshot.textHash).toBe(createHash('sha256').update(JSON.stringify([text, storedHash, 7, 2])).digest('hex'));
    expect(snapshot.sourceTitle).toBe('T'.repeat(199));
    expect(snapshot.quote.length).toBeLessThanOrEqual(320); expect(text.startsWith(snapshot.quote)).toBe(true);
    expect(rows.find(row => row.id === fallback)!.source_snapshot).toMatchObject({ kind: 'user_quote', sourceId: source, sourceVersion: '2026-09-21T00:00:00.123Z', quote: '' });
    expect(rows.find(row => row.id === modern)!.source_snapshot).toEqual(modernSnapshot);
    expect(rows.find(row => row.id === gone)!.source_snapshot).toBeNull();
    expect(rows.find(row => row.id === foreignLink)!.source_snapshot).toBeNull();
    await fixture`DELETE FROM source_chunks WHERE id=${chunk}`;
    await fixture`DELETE FROM sources WHERE id=${source}`;
    const [retained] = await fixture`SELECT * FROM card_sources WHERE id=${legacy}`;
    expect(retained!.source_id).toBeNull(); expect(retained!.source_chunk_id).toBeNull();
    expect(retained!.source_snapshot).toEqual(snapshot);
  } finally {
    await fixture?.end(); await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin.end();
    await rm(beforeFolder, { recursive: true, force: true });
  }
}, 30_000);
