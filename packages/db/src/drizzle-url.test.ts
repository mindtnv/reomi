import { describe, expect, test } from 'bun:test';
import { resolveDrizzleDatabaseUrl } from './drizzle-url.ts';

const APP = 'postgres://neuronexus:neuronexus@localhost:5432/neuronexus';
const TEST = 'postgres://neuronexus:neuronexus@localhost:5432/neuronexus_test';

describe('resolveDrizzleDatabaseUrl', () => {
  test('schema push uses TEST_DATABASE_URL even when NODE_ENV is not test', () => {
    const url = resolveDrizzleDatabaseUrl(
      { NODE_ENV: 'development', DATABASE_URL: APP, TEST_DATABASE_URL: TEST, DRIZZLE_COMMAND: 'push' },
      ['node', 'drizzle-kit', 'push', '--force'],
    );
    expect(url).toBe(TEST);
    expect(url).not.toBe(APP);
  });

  test('schema push follows an argv push flag without DRIZZLE_COMMAND', () => {
    expect(
      resolveDrizzleDatabaseUrl(
        { DATABASE_URL: APP, TEST_DATABASE_URL: TEST },
        ['push'],
      ),
    ).toBe(TEST);
  });

  test('schema push refuses to open DATABASE_URL when the test URL is missing or identical', () => {
    expect(() =>
      resolveDrizzleDatabaseUrl({ DATABASE_URL: APP, DRIZZLE_COMMAND: 'push' }, []),
    ).toThrow(/refuses DATABASE_URL/);
    expect(() =>
      resolveDrizzleDatabaseUrl(
        { DATABASE_URL: APP, TEST_DATABASE_URL: APP, DRIZZLE_COMMAND: 'push' },
        ['push'],
      ),
    ).toThrow(/refuses DATABASE_URL/);
  });

  test('non-push commands still select the application database outside tests', () => {
    expect(
      resolveDrizzleDatabaseUrl(
        { NODE_ENV: 'development', DATABASE_URL: APP, TEST_DATABASE_URL: TEST },
        ['generate'],
      ),
    ).toBe(APP);
  });

  test('non-push test commands use TEST_DATABASE_URL', () => {
    expect(
      resolveDrizzleDatabaseUrl(
        { NODE_ENV: 'test', DATABASE_URL: APP, TEST_DATABASE_URL: TEST },
        ['studio'],
      ),
    ).toBe(TEST);
  });
});
