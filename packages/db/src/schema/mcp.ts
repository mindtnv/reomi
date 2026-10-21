import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, jsonb, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { user } from './auth.ts';

export const personalAccessTokens = pgTable('personal_access_tokens', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  tokenHash: text('token_hash').notNull(),
  prefix: text('prefix').notNull(),
  scope: text('scope', { enum: ['read', 'write', 'capture'] }).notNull().default('read'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('personal_access_tokens_hash_uq').on(t.tokenHash),
  index('personal_access_tokens_user_created_idx').on(t.userId, t.createdAt),
  check('personal_access_tokens_scope_check', sql`${t.scope} in ('read', 'write', 'capture')`),
]);

export const mcpActions = pgTable('mcp_actions', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  tokenId: uuid('token_id').notNull().references(() => personalAccessTokens.id, { onDelete: 'cascade' }),
  tool: text('tool').notNull(),
  args: jsonb('args').$type<Record<string, unknown>>().notNull(),
  preview: jsonb('preview').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
}, (t) => [index('mcp_actions_token_expiry_idx').on(t.tokenId, t.expiresAt)]);
