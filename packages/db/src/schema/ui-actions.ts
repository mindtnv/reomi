import { sql } from 'drizzle-orm';
import { bigint, index, jsonb, pgTable, text, timestamp, uuid, uniqueIndex } from 'drizzle-orm/pg-core';
import type { UiActionInverse, UiActionKind, UiActionTarget } from '@reomi/shared';
import { user } from './auth';

export const uiActionReceipts = pgTable('ui_action_receipts', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').notNull(),
  requestId: uuid('request_id').notNull(),
  requestHash: text('request_hash').notNull(),
  kind: text('kind').notNull().$type<UiActionKind>(),
  target: jsonb('target').notNull().$type<UiActionTarget>(),
  label: text('label').notNull(),
  inverse: jsonb('inverse').$type<UiActionInverse>(),
  undoTarget: jsonb('undo_target').$type<UiActionTarget>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  undoUntil: timestamp('undo_until', { withTimezone: true }),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
}, t => [uniqueIndex('ui_action_owner_request_idx').on(t.userId, t.requestId),
  index('ui_action_owner_session_expiry_idx').on(t.userId, t.sessionId, t.undoUntil, t.id),
  index('ui_action_owner_session_order_idx').on(t.userId, t.sessionId, t.id.desc()).where(sql`${t.consumedAt} IS NULL AND ${t.undoUntil} IS NOT NULL`),
  index('ui_action_expiry_idx').on(t.expiresAt)]);

export const deckHierarchyRevisions = pgTable('deck_hierarchy_revisions', {
  userId: text('user_id').primaryKey().references(() => user.id, { onDelete: 'cascade' }),
  revision: bigint('revision', { mode: 'number' }).notNull().default(0),
});
