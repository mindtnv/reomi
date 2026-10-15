import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { findSecretHits, redactSecrets } from './secret-scan';

const password = 'plain-text-password';

function fixture() {
  return mkdtempSync(join(tmpdir(), 'reomi-secret-scan-'));
}

test('a password in error-context.md fails the artifact scan', () => {
  const root = fixture();
  writeFileSync(
    join(root, 'error-context.md'),
    ['- textbox "Пароль":', `  - ${password}`, ''].join('\n'),
  );
  const hits = findSecretHits([root], [password]);
  expect(hits).toEqual([{ path: join(root, 'error-context.md'), reason: 'password' }]);
});

test('an empty password field and a screenshot do not fail the scan', () => {
  const root = fixture();
  writeFileSync(join(root, 'error-context.md'), '- textbox "Пароль":\n');
  writeFileSync(join(root, 'shot.png'), password);
  expect(findSecretHits([root], [password])).toEqual([]);
});

test('a trace archive and a session cookie fail the scan', () => {
  const root = fixture();
  const nested = join(root, 'case');
  mkdirSync(nested);
  writeFileSync(join(nested, 'trace.zip'), 'not-a-real-zip');
  writeFileSync(join(root, 'log.txt'), 'set-cookie better-auth.session_token=abc');
  const hits = findSecretHits([root], [password]);
  expect(hits.map((hit) => hit.reason).sort()).toEqual(['archive', 'cookie']);
});

test('an empty secret is refused', () => {
  expect(() => findSecretHits([fixture()], ['  '])).toThrow('refusing to scan with an empty secret');
});

test('redaction removes the password and the session cookie after the scan', () => {
  const root = fixture();
  const leaked = join(root, 'error-context.md');
  writeFileSync(leaked, `- textbox "Пароль":\n  - ${password}\nset-cookie better-auth.session_token=abc.def\n`);
  writeFileSync(join(root, 'trace.zip'), 'cookie-bytes');
  expect(findSecretHits([root], [password]).map((hit) => hit.reason).sort()).toEqual(['archive', 'password']);
  redactSecrets([root], [password]);
  expect(readFileSync(leaked, 'utf8')).toBe('- textbox "Пароль":\n  - [redacted]\nset-cookie better-auth.session_token=[redacted]\n');
  expect(existsSync(join(root, 'trace.zip'))).toBe(false);
  expect(findSecretHits([root], [password])).toEqual([]);
});
