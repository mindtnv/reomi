import { beforeEach, describe, expect, test } from 'bun:test';
import { db } from '@reomi/db/client';
import { sql } from 'drizzle-orm';
import { buildApp } from '../src/app.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('UUIDv7 identifiers', () => {
  beforeEach(resetTestDb);

  test('Better Auth emits UUIDv7 user identifiers', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail('uuidv7'));
    expect(userId).toMatch(UUID_V7_RE);
  });

  test('domain entities emitted by PostgreSQL use UUIDv7', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail('uuidv7-db'));
    const response = await callApp(app, 'POST', '/decks', {
      cookie,
      body: { name: 'UUIDv7 deck', color: 'lime' },
    });
    expect(response.status).toBe(200);
    const deck = await response.json<{ id: string }>();
    expect(deck.id).toMatch(UUID_V7_RE);
  });

  test('every UUID primary-key default uses PostgreSQL uuidv7()', async () => {
    const result = await db.execute(sql<{
      tableName: string;
      defaultExpression: string | null;
    }>`
      SELECT
        table_name AS "tableName",
        column_default AS "defaultExpression"
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name = 'id'
        AND data_type = 'uuid'
      ORDER BY table_name
    `);

    expect(result.length).toBeGreaterThan(0);
    expect(result.map((row) => [row.tableName, row.defaultExpression])).toEqual(
      result.map((row) => [row.tableName, 'uuidv7()']),
    );
  });
});
