// Builtin note-types bootstrap — the single test/startup-time writer that
// guarantees the 3 global builtins (Basic / Cloze / Type-in) exist on a fresh
// schema. The prod contract is migration 0007 (raw INSERT); this is the
// programmatic counterpart used by `db:seed` and the bare-schema onboarding
// test where the DB is reset between cases.
//
// Idempotent + concurrency-safe via the partial unique index
// `note_types_builtin_uq` (name, WHERE is_builtin AND user_id IS NULL) and a
// TARGETED `ON CONFLICT ... DO NOTHING` (N1) whose predicate exactly mirrors the
// index — NOT a bare DO NOTHING. Two concurrent callers therefore never insert
// duplicate builtins.
//
// The builtin UUIDs / fields / templates come from `BUILTIN_NOTE_TYPES` in
// @reomi/shared (single source of truth — same literals migration 0007
// uses), so the persisted ids are stable across every environment.

import { sql } from 'drizzle-orm';
import { BUILTIN_NOTE_TYPES } from '@reomi/shared';
import type { Db } from './client.ts';
import { noteTypes } from './schema/index.ts';

/**
 * Ensure the 3 global builtin note-types exist (userId NULL, isBuiltin true).
 * No-op for rows that already exist (targeted ON CONFLICT). Safe to call
 * repeatedly and from concurrent processes.
 */
export async function ensureBuiltins(db: Db): Promise<void> {
  for (const def of BUILTIN_NOTE_TYPES) {
    await db
      .insert(noteTypes)
      .values({
        id: def.id,
        userId: null,
        name: def.name,
        fields: def.fields,
        templates: def.templates,
        styling: def.styling,
        kind: def.kind,
        isBuiltin: true,
      })
      .onConflictDoNothing({
        // drizzle-orm 0.38.x: `where` is the conflict-TARGET predicate here —
        // it renders `ON CONFLICT (name) WHERE <predicate> DO NOTHING`, matching
        // the partial unique index `note_types_builtin_uq` exactly (N1, targeted
        // — not a bare DO NOTHING).
        target: noteTypes.name,
        where: sql`is_builtin AND user_id IS NULL`,
      });
  }
}
