import { readFileSync } from 'node:fs';
import { applyStudySnapshot, assertRehearsalDatabase } from '../src/profile/restore-rehearsal.ts';
import {
  EXPORT_MAX_BYTES,
  type StudySnapshot,
  rehearsalReport,
  snapshotCoherent,
} from '../src/profile/study-snapshot.ts';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const file = args.find((arg) => !arg.startsWith('--'));

if (!file) {
  console.error('usage: restore-rehearsal.ts <snapshot.json> [--apply]');
  process.exit(1);
}

const databaseUrl = process.env.NODE_ENV === 'test' ? process.env.TEST_DATABASE_URL : process.env.DATABASE_URL;
try {
  assertRehearsalDatabase(databaseUrl ?? '');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'refusing restore rehearsal');
  process.exit(1);
}

const raw = readFileSync(file);
if (raw.byteLength > EXPORT_MAX_BYTES) {
  console.error(JSON.stringify({ ok: false, error: 'export_too_large', maxBytes: EXPORT_MAX_BYTES }));
  process.exit(1);
}

const parsed = JSON.parse(raw.toString('utf8')) as StudySnapshot;
if (!parsed || typeof parsed !== 'object' || !snapshotCoherent(parsed)) {
  console.error(JSON.stringify({ ok: false, error: 'incoherent_snapshot' }));
  process.exit(1);
}

if (!apply) {
  console.log(JSON.stringify(rehearsalReport(parsed, Date.now())));
  process.exit(0);
}

try {
  const result = await applyStudySnapshot(parsed);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exit(1);
} catch (error) {
  if (error instanceof Error && error.message.startsWith('refusing restore rehearsal')) {
    console.error(error.message);
  } else {
    console.error(JSON.stringify({ ok: false, error: 'apply_failed' }));
  }
  process.exit(1);
}
