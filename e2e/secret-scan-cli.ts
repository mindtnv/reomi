import { readFileSync } from 'node:fs';
import { findSecretHits, redactSecrets } from './secret-scan';

const file = process.env.E2E_SECRET_FILE;
if (!file) {
  console.error('E2E_SECRET_FILE is unset');
  process.exit(1);
}
const secrets = readFileSync(file, 'utf8').split('\n');
const roots = (process.env.E2E_SCAN_ROOTS ?? 'e2e/artifacts,test-results,playwright-report')
  .split(',')
  .map((root) => root.trim())
  .filter((root) => root !== '');
const hits = findSecretHits(roots, secrets);
for (const hit of hits) console.error(`secret artifact: ${hit.reason} in ${hit.path}`);
redactSecrets(roots, secrets);
if (hits.length > 0) process.exit(1);
