import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth';
import { sources } from './app';

export const browserCaptures = pgTable('browser_captures', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  requestKey: uuid('request_key').notNull(),
  requestHash: text('request_hash').notNull(),
  contentKey: text('content_key').notNull(),
  sourceId: uuid('source_id').references(() => sources.id, { onDelete: 'set null' }),
  sourceFingerprint: text('source_fingerprint').notNull(),
  mode: text('mode').notNull().$type<'page' | 'selection'>(),
  quote: text('quote'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex('browser_captures_request_uq').on(t.userId, t.requestKey),
  index('browser_captures_content_idx').on(t.userId, t.contentKey),
]);
