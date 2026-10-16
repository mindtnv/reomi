import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test } from 'bun:test';
import { assertRehearsalDatabase } from '../src/profile/restore-rehearsal.ts';
import { migrationJournalCandidates, readMigrationHead } from '../src/profile/study-snapshot.ts';

describe('study export guards', () => {
  test('the API image journal sits beside dist/index.js', () => {
    const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
    expect(dockerfile).toContain('COPY --from=build /repo/packages/db/src/migrations ./dist/migrations');
    expect(dockerfile).toContain('exec bun dist/index.js');
    expect(migrationJournalCandidates('file:///app/dist/index.js')[0]).toBe(
      '/app/dist/migrations/meta/_journal.json',
    );
  });

  test('readMigrationHead uses the image layout before the source tree', () => {
    const root = mkdtempSync(join(tmpdir(), 'reomi-journal-'));
    const indexPath = join(root, 'index.js');
    writeFileSync(indexPath, '');
    mkdirSync(join(root, 'migrations', 'meta'), { recursive: true });
    writeFileSync(
      join(root, 'migrations', 'meta', '_journal.json'),
      JSON.stringify({ entries: [{ tag: '0099_image_layout' }] }),
    );
    try {
      expect(readMigrationHead(pathToFileURL(indexPath).href)).toBe('0099_image_layout');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('readMigrationHead still reads the source journal', () => {
    const journal = JSON.parse(
      readFileSync(new URL('../../../packages/db/src/migrations/meta/_journal.json', import.meta.url), 'utf8'),
    ) as { entries: { tag: string }[] };
    expect(readMigrationHead()).toBe(journal.entries.at(-1)?.tag);
  });

  test('rehearsal accepts a test database and refuses ambiguous names', () => {
    expect(assertRehearsalDatabase('postgres://u:p@localhost:5432/neuronexus_test')).toBe('neuronexus_test');
    expect(assertRehearsalDatabase('postgres://u:p@localhost:5432/study_rehearsal')).toBe('study_rehearsal');
    expect(assertRehearsalDatabase('postgres://u:p@localhost:5432/test')).toBe('test');
    for (const name of [
      'latest',
      'contest',
      'protest',
      'greatest',
      'neuronexus_latest',
      'neuronexus',
      'neuronexus_test_extra',
      'test_prod',
    ]) {
      expect(() => assertRehearsalDatabase(`postgres://u:secret@localhost:5432/${name}`)).toThrow(
        `refusing restore rehearsal against database "${name}"`,
      );
    }
  });
});
