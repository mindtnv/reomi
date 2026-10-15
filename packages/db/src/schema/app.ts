import { DECK_COLORS } from '@reomi/shared';
import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  bigint,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  primaryKey,
  uniqueIndex,
  unique,
  uuid,
  vector,
} from 'drizzle-orm/pg-core';
import type {
  SourceTextSelection,
  AssistantContextPolicy,
  AssistantContextSnapshot,
  AssistantObjectKind,
  AssistantObjectSnapshot,
  CardTemplate,
  CardEvidenceSnapshot,
  Citation,
  FieldValues,
  MarkRect,
  MessageAttachment,
  MessageGrounding,
  MessageMention,
  MessageUsage,
  NoteField,
  PageAnnotations,
  QuizContent,
  ToolCallRecord,
} from '@reomi/shared';
import { user } from './auth.ts';

// Embedding vector dimension baked into the `kb_chunk.embedding` column type.
// MUST match the configured EMBEDDING_MODEL (text-embedding-3-small = 1536).
// The migration bakes this LITERAL into the generated SQL; changing it requires
// the reindex-on-model-change runbook (see CLAUDE.md → AI / RAG): regenerate the
// migration (drop + re-add the vector column + rebuild the HNSW index) + reindex.
export const EMBEDDING_DIM = 1536;

// Citation is imported from @reomi/shared (packages/shared/src/kb-chunk.ts).
// Re-export so consumers of @reomi/db/schema can import it from one place.
export type { Citation };

// Catalog of plant species. All species are available to every user (the
// achievement-gated unlock flow was removed). Keep this list in sync with
// PLANT_SPECIES in @reomi/shared.
export const plantSpeciesEnum = [
  'fern',
  'cactus',
  'succulent',
  'bonsai',
  'sakura',
  'mushroom',
] as const;

// ── enums ───────────────────────────────────────────────────────────────────

export const deckColor = pgEnum('deck_color', DECK_COLORS);
export const plantSpecies = pgEnum('plant_species', plantSpeciesEnum);
export const cardState = pgEnum('card_state', ['new', 'learning', 'review', 'relearning']);

// ── profile ─────────────────────────────────────────────────────────────────
// One-to-one with auth.user. Uses user.id as the primary key so there's no
// ambiguity between "profile row" and "user row".

export const profile = pgTable('profile', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  level: integer('level').notNull().default(1),
  xp: integer('xp').notNull().default(0),
  streakDays: integer('streak_days').notNull().default(0),
  lastReviewDate: text('last_review_date'), // ISO date yyyy-mm-dd
  // Gamification — freezes absorb one missed day each. Capped at
  // `MAX_STREAK_FREEZES` in shared helpers.
  streakFreezes: integer('streak_freezes').notNull().default(0),
  // Per-day review-minute ledger. `todayMinutesDate` is the ISO date that
  // `todayMinutes` belongs to; when a new day arrives, the counter resets
  // inside the grade transaction.
  todayMinutes: integer('today_minutes').notNull().default(0),
  todayMinutesDate: text('today_minutes_date'),
  // How many calendar days the user has met their daily goal on — used by the
  // achievements screen ("perfect week" etc).
  dailyGoalMetCount: integer('daily_goal_met_count').notNull().default(0),
  dailyGoalMetDate: text('daily_goal_met_date'),
  dailyGoalMinutes: integer('daily_goal_minutes').notNull().default(15),
  // Per-day new-card + review counters. Reset when `dailyCountsDate` (ISO
  // yyyy-mm-dd) differs from today — same pattern as `todayMinutes` ledger.
  newIntroducedToday: integer('new_introduced_today').notNull().default(0),
  reviewsDoneToday: integer('reviews_done_today').notNull().default(0),
  dailyCountsDate: text('daily_counts_date'),
  studyEpochStart: timestamp('study_epoch_start', { withTimezone: true }),
  studyEpochEnd: timestamp('study_epoch_end', { withTimezone: true }),
  lastReviewEpochEnd: timestamp('last_review_epoch_end', { withTimezone: true }),
  goalMetEpochStart: timestamp('goal_met_epoch_start', { withTimezone: true }),
  desiredRetention: doublePrecision('desired_retention'),
  // Standing instructions for the agentic chat (settings → injected into the
  // system prompt as preferences; can never override grounding/confirm rules).
  // Cap (2000 chars) enforced at the PATCH route, not the column.
  agentInstructions: text('agent_instructions'),
  plantSpecies: plantSpecies('plant_species').notNull().default('fern'),
  plantStage: integer('plant_stage').notNull().default(0),
  unlockedSpecies: text('unlocked_species')
    .array()
    .notNull()
    .default(sql`ARRAY['fern','cactus','succulent','bonsai','sakura','mushroom']::text[]`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  check(
    'profile_study_epoch_bounds_chk',
    sql`(${t.studyEpochStart} is null and ${t.studyEpochEnd} is null) or ${t.studyEpochStart} < ${t.studyEpochEnd}`,
  ),
]);

export const studyDayPolicy = pgTable(
  'study_day_policy',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    timeZone: text('time_zone').notNull(),
    rolloverMinute: integer('rollover_minute').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('study_day_policy_rollover_minute_chk', sql`${t.rolloverMinute} between 0 and 1439`),
  ],
);

// ── deck_options_preset ──────────────────────────────────────────────────────
// Named FSRS / scheduling preset that can be attached to one or more decks.
// When a deck's `presetId` is set, its FSRS parameters (steps, retention,
// limits) are resolved from the preset instead of the user's global profile.
// `desiredRetention` is NULLABLE — when NULL, falls back to profile-level.

export const deckOptionsPreset = pgTable(
  'deck_options_preset',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    newPerDay: integer('new_per_day').notNull().default(20),
    reviewsPerDay: integer('reviews_per_day').notNull().default(200),
    learningSteps: text('learning_steps')
      .array()
      .notNull()
      .default(sql`ARRAY['1m','10m']::text[]`),
    relearningSteps: text('relearning_steps')
      .array()
      .notNull()
      .default(sql`ARRAY['10m']::text[]`),
    desiredRetention: doublePrecision('desired_retention'),
    leechThreshold: integer('leech_threshold').notNull().default(8),
    maximumInterval: integer('maximum_interval').notNull().default(36500),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('deck_options_preset_user_idx').on(t.userId)],
);

// ── decks ───────────────────────────────────────────────────────────────────
// Self-referential parent for Anki-style nested decks. ON DELETE CASCADE at the
// DB level drops the whole subtree in one shot.

export const decks = pgTable(
  'decks',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    metadataRevision: bigint('metadata_revision', { mode: 'number' }).notNull().default(0),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id').references((): any => decks.id, {
      onDelete: 'cascade',
    }),
    name: text('name').notNull(),
    color: deckColor('color').notNull().default('lime'),
    icon: text('icon'),
    position: integer('position').notNull().default(0),
    species: plantSpecies('species').notNull().default('fern'),
    // Optional binding to a named FSRS preset. ON DELETE SET NULL so deleting a
    // preset unbinds decks automatically rather than cascading the deck delete.
    presetId: uuid('preset_id').references(() => deckOptionsPreset.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('decks_user_idx').on(t.userId),
    index('decks_parent_idx').on(t.parentId),
    index('decks_preset_idx').on(t.presetId),
  ],
);

// ── note_types ────────────────────────────────────────────────────────────────
// Anki-style note-type definitions (Milestone 1, Decision B1 + C-4). A note-type
// owns a set of fields + card templates + styling. `userId` is NULLABLE: a NULL
// owner means a GLOBAL built-in (visible to every user), seeded once with
// `isBuiltin = true`. User-created / cloned types carry `userId = <owner>`.
// `fields` / `templates` are typed JSON (NoteField[] / CardTemplate[] from
// @reomi/shared). `kind` is the RenderKind denormalized for fast render-mode
// selection.

export const noteTypes = pgTable(
  'note_types',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    // NULLABLE → global builtin (C-4). No ON DELETE needed for NULL rows; user
    // rows cascade when the user is deleted.
    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    fields: jsonb('fields').notNull().$type<NoteField[]>(),
    templates: jsonb('templates').notNull().$type<CardTemplate[]>(),
    styling: text('styling').notNull().default(''),
    kind: text('kind').notNull().default('custom'),
    isBuiltin: boolean('is_builtin').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('note_types_user_idx').on(t.userId),
    // Partial unique index over global builtins (userId NULL, isBuiltin true) so
    // `ensureBuiltins()` / migration 0007 can `ON CONFLICT (name) WHERE
    // is_builtin AND user_id IS NULL DO NOTHING` — idempotent + concurrency-safe.
    // User-owned rows (userId set) are excluded, so a user may freely name a
    // type "Basic" without clashing with the global builtin.
    uniqueIndex('note_types_builtin_uq')
      .on(t.name)
      .where(sql`is_builtin AND user_id IS NULL`),
  ],
);

// ── notes ─────────────────────────────────────────────────────────────────────
// A note is the user's content: field values keyed by field name (already
// sanitized at the save edge) + note-level tags (Anki tags are note-level). Each
// note generates one-or-more `cards` via the note-type's templates.

export const notes = pgTable(
  'notes',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    noteTypeId: uuid('note_type_id')
      .notNull()
      .references(() => noteTypes.id, { onDelete: 'cascade' }),
    fieldValues: jsonb('field_values').notNull().$type<FieldValues>(),
    acceptedAnswers: text('accepted_answers').array().notNull().default(sql`ARRAY[]::text[]`),
    tags: text('tags').array().notNull().default(sql`ARRAY[]::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notes_user_idx').on(t.userId),
    // GIN on tags (re-homed from cards) powers `tag:` array containment.
    index('notes_tags_gin_idx').using('gin', t.tags),
    index('notes_user_created_idx').on(t.userId, t.createdAt),
  ],
);

// ── cards ───────────────────────────────────────────────────────────────────
// A card is one (note × template) pairing carrying its own FSRS state. Content
// is derived from its note via the note-type template; the `render*` columns
// denormalize PLAINTEXT (tags + cloze stripped) for SQL search only — display
// HTML is rendered lazily from sanitized field values. `renderKind` lets
// `/cards/queue` + review pick a render mode with no extra fetch/join.
// FSRS state is flattened into dedicated columns so `due` can be indexed for
// cheap "what's due now" queries.

export const cards = pgTable(
  'cards',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    deckId: uuid('deck_id')
      .notNull()
      .references(() => decks.id, { onDelete: 'cascade' }),
    noteId: uuid('note_id')
      .notNull()
      .references(() => notes.id, { onDelete: 'cascade' }),
    templateOrd: integer('template_ord').notNull().default(0),
    // null = ordinary question; 0 = legacy aggregate; positive = one cloze group.
    clozeNumber: integer('cloze_number'),
    // Denormalized plaintext (search cache, NOT a security artifact).
    renderText: text('render_text').notNull().default(''),
    renderFrontText: text('render_front_text').notNull().default(''),
    renderBackText: text('render_back_text').notNull().default(''),
    renderKind: text('render_kind').notNull().default('basic'),
    // FSRS state
    due: timestamp('due', { withTimezone: true }).notNull().defaultNow(),
    stability: doublePrecision('stability').notNull().default(0),
    difficulty: doublePrecision('difficulty').notNull().default(0),
    elapsedDays: integer('elapsed_days').notNull().default(0),
    scheduledDays: integer('scheduled_days').notNull().default(0),
    learningSteps: integer('learning_steps').notNull().default(0),
    reps: integer('reps').notNull().default(0),
    lapses: integer('lapses').notNull().default(0),
    state: cardState('state').notNull().default('new'),
    lastReview: timestamp('last_review', { withTimezone: true }),
    // bookkeeping
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    suspended: boolean('suspended').notNull().default(false),
  },
  (t) => [
    index('cards_user_idx').on(t.userId),
    index('cards_deck_idx').on(t.deckId),
    index('cards_due_idx').on(t.userId, t.due),
    index('cards_note_idx').on(t.noteId),
    unique('cards_note_template_cloze_uq').on(t.noteId, t.templateOrd, t.clozeNumber).nullsNotDistinct(),
    // Card-database (Browse) query paths:
    //  - (user_id, state) and (user_id, created_at, id) match the hot filter+sort
    //    paths of GET /cards/search (is:/state filters, default created sort).
    //  - tag: now resolves via notes.tags GIN (notes_tags_gin_idx).
    index('cards_user_state_idx').on(t.userId, t.state),
    index('cards_user_created_idx').on(t.userId, t.createdAt, t.id),
  ],
);

// ── reviews ─────────────────────────────────────────────────────────────────
// Append-only history of every grade. Useful for stats, heatmap, FSRS retuning.

// Pre-grade snapshot stored on the review row that created the grade. Holds the
// card columns from the FSRS step and the study-ledger columns from the
// rollup. Undo restores those. plantStage restores from the snapshot unless a
// later edit left a stage that is not the streak formula. profile.updatedAt
// restores only while the grade is still the last writer. name,
// dailyGoalMinutes, desiredRetention, plantSpecies and agentInstructions are
// optional identity so a same-millisecond profile edit is visible. Older
// snapshots omit them. Date columns are ISO strings.
export interface UndoSnapshot {
  // Filtered practice sets this false. Older rows omit it and still count.
  countsTowardBudget?: boolean;
  card: {
    due: string; // ISO
    stability: number;
    difficulty: number;
    elapsedDays: number;
    scheduledDays: number;
    learningSteps: number;
    reps: number;
    lapses: number;
    state: 'new' | 'learning' | 'review' | 'relearning';
    lastReview: string | null; // ISO | null
    suspended: boolean;
    updatedAt: string; // ISO
  };
  // Null when the user had no profile row at grade time (rollup was skipped).
  profile: {
    streakDays: number;
    streakFreezes: number;
    lastReviewDate: string | null;
    todayMinutes: number;
    todayMinutesDate: string | null;
    dailyGoalMetCount: number;
    dailyGoalMetDate: string | null;
    xp: number;
    level: number;
    plantStage: number;
    newIntroducedToday: number;
    reviewsDoneToday: number;
    dailyCountsDate: string | null;
    updatedAt: string; // ISO
    studyEpochStart?: string | null;
    studyEpochEnd?: string | null;
    lastReviewEpochEnd?: string | null;
    goalMetEpochStart?: string | null;
    name?: string;
    dailyGoalMinutes?: number;
    desiredRetention?: number | null;
    plantSpecies?: (typeof plantSpeciesEnum)[number];
    agentInstructions?: string | null;
  } | null;
}

export const reviews = pgTable(
  'reviews',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    cardId: uuid('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    // Historical location, not ownership of the review. Deleting a former
    // deck must not delete reviews of a card that has since moved elsewhere.
    deckId: uuid('deck_id').references(() => decks.id, { onDelete: 'set null' }),
    rating: integer('rating').notNull(), // 1..4
    durationMs: integer('duration_ms').notNull().default(0),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }).notNull().defaultNow(),
    nextDue: timestamp('next_due', { withTimezone: true }).notNull(),
    nextStability: doublePrecision('next_stability').notNull(),
    nextDifficulty: doublePrecision('next_difficulty').notNull(),
    // Pre-grade snapshot of the card + profile mutate-set, written when this
    // review row is created. `POST /reviews/undo` restores the card + profile
    // from this snapshot and deletes the row — atomic, byte-identical rollback
    // of exactly the fields the grade transaction mutates. NULL on legacy rows
    // (pre-0008) or rows that have already been undone (the row is deleted).
    // Date fields are stored as ISO strings (reconstructed via `new Date(...)`).
    undoSnapshot: jsonb('undo_snapshot').$type<UndoSnapshot>(),
    studyDay: text('study_day'),
    studyEpochStart: timestamp('study_epoch_start', { withTimezone: true }),
  },
  (t) => [
    index('reviews_user_idx').on(t.userId, t.reviewedAt),
    index('reviews_user_study_day_idx').on(t.userId, t.studyDay),
    index('reviews_card_idx').on(t.cardId),
    // Deck-scoped study_stats / retention aggregations filter by
    // (user_id, deck_id IN (...), reviewed_at >= ...) — this index lets
    // Postgres enter the right slice directly instead of post-filtering
    // the (user_id, reviewed_at) scan.
    index('reviews_user_deck_reviewed_idx').on(t.userId, t.deckId, t.reviewedAt),
  ],
);

// Durable receipts for the versioned grading route. A removed review leaves a
// tombstone so a retry cannot recreate an undone/deleted grade.
export const reviewOperations = pgTable('review_operations', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: text('user_id').notNull().references(() => user.id, {onDelete:'cascade'}),
  operationId: uuid('operation_id').notNull(),
  argumentsHash: text('arguments_hash').notNull(),
  reviewId: uuid('review_id').references(() => reviews.id, {onDelete:'set null'}),
  result: jsonb('result').$type<Record<string, unknown>>().notNull(),
  createdAt: timestamp('created_at', {withTimezone:true}).notNull().defaultNow(),
}, table => [
  uniqueIndex('review_operations_owner_operation_idx').on(table.userId,table.operationId),
  index('review_operations_review_idx').on(table.reviewId),
]);

// Durable receipts for versioned note creation. A deleted note leaves a
// tombstone so a retry cannot insert another copy. Field text stays on the note.
export const noteOperations = pgTable('note_operations', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  operationId: uuid('operation_id').notNull(),
  argumentsHash: text('arguments_hash').notNull(),
  noteId: uuid('note_id').references(() => notes.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('note_operations_owner_operation_idx').on(table.userId, table.operationId),
  index('note_operations_note_idx').on(table.noteId),
]);

// ── media ───────────────────────────────────────────────────────────────────
// Tracks uploaded media objects (images) stored in S3-compatible storage.
// `id` is the UUID used as both the DB primary key and the S3 key
// (`media/{id}`, ext-free per C-1). The API reads the returned `id` to
// construct the storage key and the `/m/{id}` token. `s3Key` stores the full
// key (`media/{id}`) for clarity; it is unique across the bucket. `userId`
// cascades on user delete.
//
// Ownership-bound lifecycle (M2 validation fix): `POST /media/presign` INSERTs a
// PENDING row (`verified = false`) immediately to CLAIM the uuid under the
// caller; `POST /media/:id/finalize` SELECTs it by `(id, userId)` (404 if
// missing — so user B can't finalize user A's presigned uuid) then flips
// `verified = true` after the HEAD + magic-byte sniff. `GET /media` returns only
// `verified = true` rows. Pending/unverified rows are orphan-cleanup candidates.
// (The dead `width`/`height` columns were dropped in migration 0005 — re-add in
// a future milestone if image dimensions are needed.)

export const media = pgTable(
  'media',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    s3Key: text('s3_key').notNull().unique(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    // false until finalize verifies the real bytes; presign sets it false.
    verified: boolean('verified').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('media_user_idx').on(t.userId)],
);

// ── filtered_deck ────────────────────────────────────────────────────────────
// A filtered (cram) deck: a saved query + scheduling policy that pulls cards
// matching arbitrary criteria into a temporary study session without moving
// them out of their home decks permanently. `sort_order` and `card_limit` use
// explicit column names to avoid SQL reserved words `order`/`limit`.

export const filteredDeck = pgTable(
  'filtered_deck',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    query: text('query').notNull(),
    sortOrder: text('sort_order').notNull().default('due'),
    cardLimit: integer('card_limit').notNull().default(50),
    includeSuspended: boolean('include_suspended').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('filtered_deck_user_idx').on(t.userId)],
);

// ── kb_chunk ──────────────────────────────────────────────────────────────────
// DERIVED, disposable knowledge-base index (RAG substrate). NOT a source of
// truth: each row is rebuildable at any time from `cards.render_text` (like
// `cards.render_text` is itself a derived search cache). Deleting the source
// card cascades the chunk via the typed `card_id` FK.
//
// AC7 SEAM — source-agnostic by design. Generic `source_type`/`source_id`/
// `parent_id` columns let a future `'document'` (multi-chunk) or `'note'` source
// plug in WITHOUT touching retrieval/chat core (which only reads generic chunk
// columns). A real FK is only safe for the card source, so cascade-on-delete is
// achieved via a nullable typed `card_id → cards(cascade)` (set for card chunks,
// null for future doc chunks); future sources each add their own nullable FK.
//
// `embedding` is NULLABLE so a row can exist before it is embedded. `source_hash`
// = hash(render_text + embeddingModel): indexCard/reconcile SKIP re-embedding
// when it already matches, so a no-content `updatedAt` bump (forget/setDue/bulk
// move) does NOT trigger a paid re-embed; including embeddingModel means a model
// change naturally invalidates every chunk → full reindex.
//
// Index choice — HNSW over IVFFlat: no training / `lists` tuning, good recall on
// a small/growing corpus, fine build cost at n=1. The HNSW index is GLOBAL across
// all users — retrieval MUST always carry a `user_id = $userId` predicate (it is
// the sole cross-tenant boundary).

export const kbChunk = pgTable(
  'kb_chunk',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    sourceType: text('source_type').notNull(),
    sourceId: uuid('source_id').notNull(),
    parentId: uuid('parent_id').notNull(),
    position: integer('position').notNull().default(0),
    text: text('text').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }),
    embeddingModel: text('embedding_model'),
    sourceHash: text('source_hash'),
    // Typed cascade FK for the card source (null for future non-card sources).
    cardId: uuid('card_id').references(() => cards.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('kb_chunk_user_idx').on(t.userId),
    index('kb_chunk_source_idx').on(t.sourceType, t.sourceId),
    // Idempotent upsert key for card re-index (one chunk per (card, position)).
    uniqueIndex('kb_chunk_card_pos_uq').on(t.cardId, t.position),
    // Idempotent upsert key for DOCUMENT re-index (one chunk per (source, pos)).
    // Partial WHERE so it coexists with the card key: document chunks carry a
    // NULL card_id (the card key's (NULL, position) rows are distinct in PG), so
    // a dedicated (source_id, position) unique is needed for the document upsert
    // conflict target. Precedent: note_types_builtin_uq / messages_tool_result_uq
    // prove db:generate round-trips a partial WHERE.
    uniqueIndex('kb_chunk_source_pos_uq')
      .on(t.sourceId, t.position)
      .where(sql`source_type = 'document'`),
    // HNSW cosine index for ANN search via the `<=>` operator.
    index('kb_chunk_embedding_hnsw').using('hnsw', t.embedding.op('vector_cosine_ops')),
    // Card-source invariant: a 'card' chunk MUST carry its typed cardId (so the
    // cascade FK fires on card delete); non-card sources MUST leave it null.
    check('kb_chunk_card_source_chk', sql`(source_type = 'card') = (card_id is not null)`),
  ],
);

// ── conversations ─────────────────────────────────────────────────────────────
// A persisted chat thread, user-scoped. Newest-first listing via the
// (user_id, updated_at desc) index.

export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    title: text('title'),
    // Legacy notebook binding remains readable; durable typed context below
    // survives deletion of its target. Deleting a notebook never deletes chat.
    notebookId: uuid('notebook_id').references(() => notebooks.id, { onDelete: 'set null' }),
    contextPolicy: text('context_policy').notNull().$type<AssistantContextPolicy>().default('focus'),
    contextVersion: integer('context_version').notNull().default(0),
    contextRevision: integer('context_revision').notNull().default(0),
    // Pinned threads sort above the date groups. Pin toggles do NOT bump
    // `updatedAt` (recency must reflect actual conversation activity).
    pinned: boolean('pinned').notNull().default(false),
    // Context auto-compression cache: a model-generated summary of the turns
    // older than `summaryUpto` (the created_at of the last summarized row).
    // Rebuilt lazily when more rows age past the keep-window; losing it only
    // costs one extra summarization call.
    summary: text('summary'),
    summaryUpto: timestamp('summary_upto', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('conversations_user_updated_idx').on(t.userId, t.updatedAt.desc()),
    // Notebook thread listing: GET /chat/conversations?notebookId=… (M2).
    index('conversations_user_notebook_idx').on(t.userId, t.notebookId),
    index('conversations_user_pinned_updated_id_idx').on(t.userId, t.pinned.desc(), t.updatedAt.desc(), t.id.desc()),
    check('conversations_context_policy_check', sql`${t.contextPolicy} IN ('focus', 'strict')`),
    check('conversations_context_revision_check', sql`${t.contextRevision} >= 0 AND ${t.contextVersion} IN (0, 1)`),
  ],
);

// Polymorphic targets deliberately have no FK: the original context remains
// identifiable after deletion. The resolver checks current owner access.
export const conversationContexts = pgTable('conversation_contexts', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  conversationId: uuid('conversation_id').notNull().references(() => conversations.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().$type<AssistantObjectKind>(),
  objectId: uuid('object_id').notNull(),
  refKey: text('ref_key').notNull(),
  snapshot: jsonb('snapshot').notNull().$type<AssistantObjectSnapshot>(),
  position: integer('position').notNull(),
}, t => [
  uniqueIndex('conversation_contexts_ref_uq').on(t.conversationId, t.refKey),
  index('conversation_contexts_user_object_idx').on(t.userId, t.kind, t.objectId, t.conversationId),
  index('conversation_contexts_order_idx').on(t.conversationId, t.position),
  check('conversation_contexts_position_check', sql`${t.position} >= 0 AND ${t.position} < 16`),
]);

// ── messages ────────────────────────────────────────────────────────────────────
// One turn in a conversation. `citations` carries the resolved source cards for
// an assistant message (rendered through RichCard on the client) — empty for
// user/system turns and for "not in your cards" answers. `user_id` is
// denormalized for cheap user-scoping; the conversation FK cascades on delete.

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').notNull(), // 'user' | 'assistant' | 'system' | 'tool'
    // `content` stays NOT NULL (additive — no destructive DROP NOT NULL). A
    // tool-calls-only assistant row stores `''` (sentinel); a `role:'tool'` row
    // stores the JSON-stringified tool result. Disambiguation is structural
    // (non-null `toolCalls` ⇒ tool-call row; `role='tool'` ⇒ result row), never
    // by content emptiness — see the agent loop history mapping + chat UI
    // reconstruction rule.
    content: text('content').notNull(),
    // Set on an assistant row that emitted tool calls (the OpenAI wire shape so
    // a persisted row replays straight back into `messages[]`); null otherwise.
    toolCalls: jsonb('tool_calls').$type<ToolCallRecord[]>(),
    // Set on a `role:'tool'` result row, linking it to its parent's tool call;
    // null otherwise.
    toolCallId: text('tool_call_id'),
    citations: jsonb('citations')
      .notNull()
      .$type<Citation[]>()
      .default(sql`'[]'::jsonb`),
    // Accumulated token usage for the turn (final assistant text row; a
    // suspended turn parks its usage-so-far on the pending tool_calls row).
    // Null when the provider reports no usage.
    usage: jsonb('usage').$type<MessageUsage>(),
    // Effective model for the turn (assistant rows only) — the per-turn picker
    // choice or the env default at the time of the turn.
    model: text('model'),
    // Composer @-mentions (user rows only). Snapshot at send time; the stored
    // `content` stays clean — the <mentioned_cards> block is appended to the
    // model-facing content at history-build time.
    mentions: jsonb('mentions').$type<MessageMention[]>(),
    // Exact per-turn references/policy, independent of later route/pin changes.
    context: jsonb('context').$type<AssistantContextSnapshot>(),
    // Composer file attachments (user rows only): image refs (`/m/<uuid>` token,
    // server-resolved from the user-scoped media row) and inline text files.
    // Model-facing parts/blocks are built at history time; content stays clean.
    attachments: jsonb('attachments').$type<MessageAttachment[]>(),
    // Notebook-turn grounding snapshot (M3): the distinct source_chunk ids the
    // turn read via search_source/read_source, stamped ONLY on the pending
    // assistant tool_calls row of a SUSPENDED create_card — so server-side
    // auto-provenance survives /resume and reload. Null everywhere else.
    grounding: jsonb('grounding').$type<MessageGrounding>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('messages_conversation_idx').on(t.conversationId, t.createdAt),
    // Idempotent resume backstop (Phase B): at most one `role:'tool'` result row
    // per (conversation, tool_call_id) so a double/concurrent Apply hits a
    // unique violation at the storage layer. Partial index — precedent
    // `note_types_builtin_uq` proves db:generate round-trips `WHERE` clauses.
    uniqueIndex('messages_tool_result_uq')
      .on(t.conversationId, t.toolCallId)
      .where(sql`role = 'tool'`),
  ],
);

// ── notebooks ───────────────────────────────────────────────────────────────
// NotebookLM-style collection of sources (book/PDF/article/URL/text) the user
// reads + chats over (grounded) + generates flashcards from. User-scoped.
// (Feature: NotebookLM-sourced cards, M1.)

export const notebooks = pgTable(
  'notebooks',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    metadataRevision: bigint('metadata_revision', { mode: 'number' }).notNull().default(0),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    // ── «Блокноты 2.0» metadata (Р13, N1) — all additive/nullable except the
    // two booleans (NOT NULL DEFAULT false). ───────────────────────────────────
    emoji: text('emoji'),
    color: text('color'), // one of NOTEBOOK_COLORS (deck palette); validated at the API
    description: text('description'), // ≤500 (validated at the API)
    pinned: boolean('pinned').notNull().default(false),
    archived: boolean('archived').notNull().default(false),
    // Overview cache (Р6, N2): a generated briefing + suggested questions, keyed
    // by `overviewFingerprint` = hash(sorted ready sourceIds + each chunkCount).
    overview: text('overview'),
    suggestedQuestions: jsonb('suggested_questions').$type<string[]>(),
    overviewFingerprint: text('overview_fingerprint'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('notebooks_user_idx').on(t.userId)],
);

// ── notebook_notes ───────────────────────────────────────────────────────────
// «Блокноты 2.0» (Р1, N1): a user-editable markdown note — either hand-written
// (`kind:'manual'`) or a saved chat answer (`kind:'answer'`, Р7). A saved answer
// REFERENCES the message it came from (`message_id` SET NULL — the note survives
// regenerate/thread-delete via its `citations` snapshot), but lives by its own
// content. Both notebook + user FKs CASCADE; `user_id` stays the first conjunct.

export const notebookNotes = pgTable(
  'notebook_notes',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    metadataRevision: bigint('metadata_revision', { mode: 'number' }).notNull().default(0),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    ownerKind: text('owner_kind').notNull().default('notebook').$type<'notebook' | 'source'>(),
    notebookId: uuid('notebook_id').references(() => notebooks.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id').references(() => sources.id, { onDelete: 'set null' }),
    sourceOriginId: uuid('source_origin_id'),
    sourceOriginTitle: text('source_origin_title'),
    title: text('title').notNull(), // ≤NOTE_TITLE_MAX (API)
    content: text('content').notNull(), // markdown, ≤NOTE_CONTENT_MAX (API)
    kind: text('kind').notNull().default('manual'), // 'manual' | 'answer'
    // Snapshot of the saved answer's SourceCitation[] (kind='answer'); null else.
    citations: jsonb('citations').$type<Citation[]>(),
    // The chat message this note was saved from (Р7). SET NULL on message delete
    // — the note keeps living off its content + citations snapshot.
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    pinned: boolean('pinned').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('notebook_notes_owner_check', sql`(
      (${t.ownerKind} = 'notebook' AND ${t.notebookId} IS NOT NULL AND ${t.sourceId} IS NULL AND ${t.sourceOriginId} IS NULL AND ${t.sourceOriginTitle} IS NULL)
      OR (${t.ownerKind} = 'source' AND ${t.notebookId} IS NULL AND ${t.sourceOriginId} IS NOT NULL
        AND ${t.sourceOriginTitle} IS NOT NULL AND length(${t.sourceOriginTitle}) BETWEEN 1 AND 200
        AND (${t.sourceId} IS NULL OR ${t.sourceId} = ${t.sourceOriginId}))
    )`),
    index('notebook_notes_source_origin_idx').on(t.userId, t.sourceOriginId, t.updatedAt.desc()),
    index('notebook_notes_retained_idx').on(t.userId, t.updatedAt.desc(), t.id)
      .where(sql`${t.ownerKind} = 'source' AND ${t.sourceId} IS NULL`),
    // Per-notebook listing: pinned-first, recency-second.
    index('notebook_notes_nb_pinned_updated_idx').on(
      t.notebookId,
      t.pinned.desc(),
      t.updatedAt.desc(),
    ),
    index('notebook_notes_user_idx').on(t.userId),
  ],
);

// ── notebook_artifacts ─────────────────────────────────────────────────────────
// «Блокноты 2.0» (Р1/Р2, schema in N1 / generation in N2-N3): a GENERATED study
// document. The ROW IS THE JOB (simplified sources-ingest pattern): `status`
// drives a single-`complete()` async generation (pending→generating→ready|error).
// Markdown types write `content_md`; the structured `quiz` writes `content_json`.
// `source_ids` snapshots the generation scope (for display + regenerate); the
// async worker pulls `user_id` from THIS row (no session). `error_code` is a
// MACHINE code mapped to i18n on the client (like ingest). Both FKs CASCADE.

export const notebookArtifacts = pgTable(
  'notebook_artifacts',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    ownerKind: text('owner_kind').notNull().default('notebook').$type<'notebook' | 'source'>(),
    notebookId: uuid('notebook_id').references(() => notebooks.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id').references(() => sources.id, { onDelete: 'set null' }),
    sourceOriginId: uuid('source_origin_id'),
    sourceOriginTitle: text('source_origin_title'),
    type: text('type').notNull(), // NOTEBOOK_ARTIFACT_TYPES
    status: text('status').notNull().default('pending'), // ARTIFACT_STATUSES
    operationRunId: uuid('operation_run_id'),
    operationStartedAt: timestamp('operation_started_at', { withTimezone: true }),
    operationFinishedAt: timestamp('operation_finished_at', { withTimezone: true }),
    generationOptions: jsonb('generation_options').$type<{ questionCount?: number }>(),
    title: text('title').notNull(),
    contentMd: text('content_md'),
    contentJson: jsonb('content_json').$type<QuizContent>(),
    sourceIds: jsonb('source_ids').notNull().$type<string[]>(),
    errorCode: text('error_code'), // ARTIFACT_ERROR_CODES (machine code)
    model: text('model'), // effective CHAT_MODEL at generation time
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('notebook_artifacts_owner_check', sql`(
      (${t.ownerKind} = 'notebook' AND ${t.notebookId} IS NOT NULL AND ${t.sourceId} IS NULL AND ${t.sourceOriginId} IS NULL AND ${t.sourceOriginTitle} IS NULL)
      OR (${t.ownerKind} = 'source' AND ${t.notebookId} IS NULL AND ${t.sourceOriginId} IS NOT NULL
        AND ${t.sourceOriginTitle} IS NOT NULL AND length(${t.sourceOriginTitle}) BETWEEN 1 AND 200
        AND (${t.sourceId} IS NULL OR ${t.sourceId} = ${t.sourceOriginId}))
    )`),
    index('notebook_artifacts_source_origin_idx').on(t.userId, t.sourceOriginId, t.updatedAt.desc()),
    index('notebook_artifacts_retained_idx').on(t.userId, t.updatedAt.desc(), t.id)
      .where(sql`${t.ownerKind} = 'source' AND ${t.sourceId} IS NULL`),
    index('notebook_artifacts_active_source_idx').on(t.userId, t.sourceOriginId).where(sql`${t.ownerKind} = 'source' AND ${t.status} IN ('pending','generating')`),
    index('notebook_artifacts_nb_created_idx').on(t.notebookId, t.createdAt.desc()),
    index('notebook_artifacts_user_idx').on(t.userId),
    index('artifacts_operation_active_idx').on(t.userId, t.operationStartedAt, t.id)
      .where(sql`${t.status} IN ('pending','generating')`),
    index('artifacts_operation_recent_idx').on(t.userId, t.operationFinishedAt.desc(), t.id),
    // One generation per notebook at a time (Р16): the CAS concurrency check
    // probes for a pending|generating row of the notebook.
    index('notebook_artifacts_active_idx')
      .on(t.notebookId)
      .where(sql`status IN ('pending','generating')`),
  ],
);

// ── quiz_attempts ──────────────────────────────────────────────────────────────
// «Блокноты 2.0» (Р8, schema in N1 / scoring in N3): one persisted run of a quiz
// artifact. `answers` is the per-question record; `correct`/`total` are the
// server-recomputed score (MCQ/TF auto-graded, `open` is the human's self-grade).
// CASCADE on the artifact: deleting the quiz drops its attempt history (the
// history is meaningless without the artifact; created cards survive via
// card_sources). `user_id` is the first conjunct.

export const quizAttempts = pgTable(
  'quiz_attempts',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => notebookArtifacts.id, { onDelete: 'cascade' }),
    answers: jsonb('answers').notNull(),
    correct: integer('correct').notNull(),
    total: integer('total').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('quiz_attempts_artifact_created_idx').on(t.artifactId, t.createdAt.desc()),
    index('quiz_attempts_user_idx').on(t.userId),
  ],
);

// ── notebook_sources ───────────────────────────────────────────────────────────
// Many-to-many attach edge: a LIBRARY source plugged into a notebook. Cascades
// give the ownership model its shape: deleting a notebook kills only the edges
// (the source + its chunks/vectors/markup survive in the library); deleting a
// source detaches it from every notebook. `user_id` is the mandatory FIRST
// conjunct on every query (repo invariant).

export const notebookSources = pgTable(
  'notebook_sources',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    notebookId: uuid('notebook_id')
      .notNull()
      .references(() => notebooks.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Plain (non-partial) unique — the idempotent attach upsert target
    // (`onConflictDoNothing({ target })`, no `where` needed).
    uniqueIndex('notebook_sources_nb_src_uq').on(t.notebookId, t.sourceId),
    index('notebook_sources_source_idx').on(t.sourceId),
    index('notebook_sources_user_idx').on(t.userId),
  ],
);

// ── sources ─────────────────────────────────────────────────────────────────
// One ingested LIBRARY material (user-level — notebooks attach it via
// notebook_sources). The ROW IS THE INGEST JOB: `status` drives the async worker
// (pending→parsing→indexing→ready|error|deleting), and the worker pulls `userId`
// from this row (it runs with NO auth session). Uploaded bytes (pdf/epub) live in
// S3 under `storageKey` (`source/{id}`); url/text carry no bytes. `byteHash`
// (sha256 at finalize) powers per-USER dedup (app-level SELECT — historical dupes
// are legal, no unique index). `errorCode` is a MACHINE code (not prose) mapped
// to i18n on the client. `verified` mirrors media's claim-on-presign ownership
// pattern. The progress numerator is COMPUTED (COUNT source_chunks.embedded),
// NOT a stored counter. Metadata columns (author/description/language/pageCount/
// coverMediaId/tags) are all optional library-card fields.

export const sources = pgTable(
  'sources',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    metadataRevision: bigint('metadata_revision', { mode: 'number' }).notNull().default(0),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(), // 'pdf' | 'epub' | 'url' | 'text' | 'youtube'
    title: text('title').notNull(),
    url: text('url'),
    storageKey: text('storage_key'),
    mime: text('mime'),
    byteSize: integer('byte_size'),
    byteHash: text('byte_hash'),
    status: text('status').notNull().default('pending'),
    operationRunId: uuid('operation_run_id'),
    operationStartedAt: timestamp('operation_started_at', { withTimezone: true }),
    operationFinishedAt: timestamp('operation_finished_at', { withTimezone: true }),
    // 'pending' | 'parsing' | 'indexing' | 'ready' | 'error' | 'deleting'
    errorCode: text('error_code'),
    charCount: integer('char_count'),
    chunkCount: integer('chunk_count'),
    verified: boolean('verified').notNull().default(false),
    author: text('author'),
    description: text('description'),
    language: text('language'),
    pageCount: integer('page_count'),
    coverMediaId: uuid('cover_media_id').references(() => media.id, { onDelete: 'set null' }),
    tags: text('tags').array().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('sources_user_idx').on(t.userId),
    // Powers the worker claim (`WHERE status = 'pending' … FOR UPDATE SKIP LOCKED`).
    index('sources_status_idx').on(t.status),
    index('sources_operation_active_idx').on(t.userId, t.operationStartedAt, t.id)
      .where(sql`${t.status} IN ('pending','parsing','indexing')`),
    index('sources_operation_recent_idx').on(t.userId, t.operationFinishedAt.desc(), t.id),
    index('sources_tags_gin_idx').using('gin', t.tags),
    uniqueIndex('sources_youtube_url_uq')
      .on(t.userId, t.url)
      .where(sql`${t.kind} = 'youtube' AND ${t.status} NOT IN ('error', 'deleting')`),
  ],
);

// ── source_chunks ──────────────────────────────────────────────────────────────
// SoT for parsed document text. Unlike card chunks (rebuildable from
// cards.render_text), a document's text is NOT cheaply re-derivable (it needs
// re-download + re-parse), so it lives here and SURVIVES a kb_chunk rebuild
// (re-embed-on-model-change reads from here). `embedded` flips true in the SAME
// transaction as its kb_chunk embedding write — so the ingest progress numerator
// is COUNT(embedded = true): crash-safe, never a desynced counter.

export const sourceChunks = pgTable(
  'source_chunks',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    text: text('text').notNull(),
    page: integer('page'),
    heading: text('heading'),
    startSeconds: integer('start_seconds'),
    tokenCount: integer('token_count'),
    embedded: boolean('embedded').notNull().default(false),
    sourceHash: text('source_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('source_chunks_source_pos_uq').on(t.sourceId, t.position),
    index('source_chunks_user_idx').on(t.userId),
    index('source_chunks_source_idx').on(t.sourceId),
  ],
);

// ── card_sources ───────────────────────────────────────────────────────────────
// Provenance edge (M1 lays the schema; M3 populates it): a card remembers which
// source chunk(s) + chat turn it was generated from. CASCADE ASYMMETRY (the only
// place in the schema a referencing row survives its referent): the CARD side
// cascades (delete card → drop the edge), but every SOURCE/CHAT side is SET NULL —
// deleting a source/notebook/conversation must NOT delete the card the user
// authored ("nothing is lost"). A row left with all-NULL refs but `cardId` is a
// tombstone; M3 backlink reads LEFT JOIN and render "source deleted". Live-dedup
// via the PARTIAL unique (NULLs are distinct in PG, so tombstones are
// intentionally NOT deduped) — precedent note_types_builtin_uq.

export const cardSources = pgTable(
  'card_sources',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    cardId: uuid('card_id')
      .notNull()
      .references(() => cards.id, { onDelete: 'cascade' }),
    sourceChunkId: uuid('source_chunk_id').references(() => sourceChunks.id, {
      onDelete: 'set null',
    }),
    sourceId: uuid('source_id').references(() => sources.id, { onDelete: 'set null' }),
    notebookId: uuid('notebook_id').references(() => notebooks.id, { onDelete: 'set null' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    messageId: uuid('message_id').references(() => messages.id, { onDelete: 'set null' }),
    sourceSnapshot: jsonb('source_snapshot').$type<CardEvidenceSnapshot>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('card_sources_card_idx').on(t.cardId),
    index('card_sources_source_idx').on(t.sourceId),
    index('card_sources_chunk_idx').on(t.sourceChunkId),
    // Live-dedup only on real chunk links. PG unique indexes are NULLS DISTINCT by
    // default, so tombstone rows (source_chunk_id NULL after a source delete)
    // accumulate freely; the partial WHERE keeps the unique meaningful for live edges.
    uniqueIndex('card_sources_card_chunk_uq')
      .on(t.cardId, t.sourceChunkId)
      .where(sql`source_chunk_id IS NOT NULL`),
  ],
);

// ── source_annotations ─────────────────────────────────────────────────────────
// PDF reader ink markup (M4): one row per (source, page) holding the page's
// VECTOR ink strokes (normalized page coordinates) + the `marked_text` extracted
// from under the strokes (the AI-visible markup, read by `list_marked_passages`).
// `page` is 1-BASED (the pdf.js convention). The (source_id, page) unique is a
// PLAIN (non-partial) unique so the PUT can `onConflictDoUpdate` on it with no
// WHERE. Sources are user-owned; `user_id` is still the first conjunct on every
// query (the (user_id) index supports the per-source list). Both FKs CASCADE so
// deleting a source/user drops its annotations.

export const sourceAnnotations = pgTable(
  'source_annotations',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    // 1-based page index (pdf.js convention).
    page: integer('page').notNull(),
    strokes: jsonb('strokes').notNull().$type<PageAnnotations>(),
    markedText: text('marked_text'),
    // «Урожай выделений → карточки» (feature #2): when this page's ink markup has
    // been turned into flashcards, stamp the harvest time so a re-run skips it.
    // Nullable — never harvested rows stay NULL. NOT a CASCADE on the card: a
    // harvested marking outlives any card it produced.
    harvestedAt: timestamp('harvested_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Plain (non-partial) unique upsert key — one annotation row per (source, page).
    uniqueIndex('source_annotations_source_page_uq').on(t.sourceId, t.page),
    index('source_annotations_user_idx').on(t.userId),
  ],
);

// Text-source marks retain ordered render-text locators across chunk replacement.
// Chunk IDs intentionally have no FK: reingestion marks anchors unavailable,
// while the user's quote and note remain until source/mark deletion.
export const sourceTextMarks = pgTable('source_text_marks', {
  id: uuid('id').primaryKey().default(sql`uuidv7()`),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  sourceId: uuid('source_id').notNull().references(() => sources.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull().$type<'highlight' | 'note'>(),
  color: text('color').notNull().default('yellow'),
  selection: jsonb('selection').notNull().$type<SourceTextSelection>(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index('source_text_marks_owner_source_idx').on(t.userId, t.sourceId, t.createdAt, t.id),
  check('source_text_marks_kind_check', sql`${t.kind} IN ('highlight','note')`),
  check('source_text_marks_color_check', sql`${t.color} IN ('yellow','green','blue','pink','violet')`),
  check('source_text_marks_note_check', sql`${t.note} IS NULL OR length(${t.note}) <= 2000`),
  check('source_text_marks_selection_check', sql`jsonb_typeof(${t.selection}) = 'object' AND ${t.selection}->>'version' = '1'
    AND length(${t.selection}->>'quote') BETWEEN 1 AND 4000 AND octet_length(${t.selection}::text) <= 24000`),
]);

// ── source_marks ─────────────────────────────────────────────────────────────
// Reading-workflow TEXT markup (M5): one row per text-selection highlight/note
// in a source's reader. UNLIKE source_annotations (one row per page holding the
// whole page's VECTOR ink), a mark is INDIVIDUALLY addressable (its own id —
// the popover edits/deletes one mark) and anchors a TEXT selection: the
// selected `quote` + the selection's bounding `rects` (normalized page coords,
// the render anchor) + a palette `color`; `kind:'note'` adds a freeform `note`
// body, `kind:'highlight'` leaves it null. `page` is 1-BASED (pdf.js). Both FKs
// CASCADE (delete source/user drops its marks); `user_id` stays the first
// conjunct on every query. Marks feed `list_marked_passages` alongside ink and
// are the substrate for quick-card provenance.

export const sourceMarks = pgTable(
  'source_marks',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    // 1-based page index (pdf.js convention), matching source_annotations.
    page: integer('page').notNull(),
    kind: text('kind').notNull(), // 'highlight' | 'note' | 'card'
    // Selected text (server-capped MARK_QUOTE_MAX); the AI-visible passage. For a
    // 'card' marker (M5.1) this is the card's Back excerpt (or the request quote).
    quote: text('quote').notNull(),
    // Selection quads in normalized page coords (0..1) — the render anchor.
    rects: jsonb('rects').notNull().$type<MarkRect[]>(),
    // One of SOURCE_MARK_COLORS; defaults to the palette's first entry.
    color: text('color').notNull().default('lime'),
    // Freeform body for kind 'note' (capped MARK_NOTE_MAX); null for highlights.
    note: text('note'),
    // For kind 'card' (M5.1): the flashcard this marker anchors. ON DELETE
    // CASCADE — a marker without its card is meaningless, so the marker dies with
    // the card. NULL for highlight/note marks.
    cardId: uuid('card_id').references(() => cards.id, { onDelete: 'cascade' }),
    // «Урожай выделений → карточки» (feature #2): set when this highlight/note has
    // been harvested into flashcards so a re-run won't re-offer it. SEPARATE from
    // `cardId` ON DELETE CASCADE — deleting a card must NOT erase the user's
    // highlight, so the harvest record lives on its own nullable column.
    harvestedAt: timestamp('harvested_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Per-source listing ordered (page, created_at) — the «Разметка» panel + the
    // list_marked_passages merge both read by source then page.
    index('source_marks_source_page_idx').on(t.sourceId, t.page),
    index('source_marks_user_idx').on(t.userId),
    index('source_marks_card_idx').on(t.cardId),
  ],
);

// ── source_reading_state ───────────────────────────────────────────────────────
// Per-(user, source) reading position + status, synced across devices (the old
// `nn:pdf:pos:<id>` localStorage becomes a write-through cache migrated on first
// open). `status` flips unread→reading automatically on the first progress PUT;
// 'finished' is set ONLY manually (a percent-based auto-finish misfires on
// reference books). The (user_id, updated_at) index powers the «Продолжить
// чтение» shelf (top-N WHERE status='reading' ORDER BY updated_at DESC).

export const sourceReadingState = pgTable(
  'source_reading_state',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('unread'), // 'unread' | 'reading' | 'finished'
    // PDF-mode position (1-based page) — null when reading in text mode.
    page: integer('page'),
    // Text-mode position (source_chunks.position) — null when reading the PDF.
    chunkPos: integer('chunk_pos'),
    // 0..1 fraction for the library progress bar.
    percent: real('percent'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Plain unique — the upsert target (onConflictDoUpdate, no `where`).
    uniqueIndex('source_reading_state_src_user_uq').on(t.sourceId, t.userId),
    index('source_reading_state_user_updated_idx').on(t.userId, t.updatedAt),
  ],
);

// ── relations ──────────────────────────────────────────────────────────────

export const profileRelations = relations(profile, ({ one }) => ({
  user: one(user, { fields: [profile.userId], references: [user.id] }),
}));

export const deckOptionsPresetRelations = relations(deckOptionsPreset, ({ one, many }) => ({
  user: one(user, { fields: [deckOptionsPreset.userId], references: [user.id] }),
  decks: many(decks),
}));

export const decksRelations = relations(decks, ({ one, many }) => ({
  user: one(user, { fields: [decks.userId], references: [user.id] }),
  parent: one(decks, {
    fields: [decks.parentId],
    references: [decks.id],
    relationName: 'deck_parent',
  }),
  children: many(decks, { relationName: 'deck_parent' }),
  preset: one(deckOptionsPreset, { fields: [decks.presetId], references: [deckOptionsPreset.id] }),
  cards: many(cards),
}));

export const noteTypesRelations = relations(noteTypes, ({ one, many }) => ({
  user: one(user, { fields: [noteTypes.userId], references: [user.id] }),
  notes: many(notes),
}));

export const notesRelations = relations(notes, ({ one, many }) => ({
  user: one(user, { fields: [notes.userId], references: [user.id] }),
  noteType: one(noteTypes, { fields: [notes.noteTypeId], references: [noteTypes.id] }),
  cards: many(cards),
}));

export const cardsRelations = relations(cards, ({ one, many }) => ({
  user: one(user, { fields: [cards.userId], references: [user.id] }),
  deck: one(decks, { fields: [cards.deckId], references: [decks.id] }),
  note: one(notes, { fields: [cards.noteId], references: [notes.id] }),
  reviews: many(reviews),
}));

export const reviewsRelations = relations(reviews, ({ one }) => ({
  user: one(user, { fields: [reviews.userId], references: [user.id] }),
  card: one(cards, { fields: [reviews.cardId], references: [cards.id] }),
  deck: one(decks, { fields: [reviews.deckId], references: [decks.id] }),
}));

export const mediaRelations = relations(media, ({ one }) => ({
  user: one(user, { fields: [media.userId], references: [user.id] }),
}));

export const filteredDeckRelations = relations(filteredDeck, ({ one }) => ({
  user: one(user, { fields: [filteredDeck.userId], references: [user.id] }),
}));

export const kbChunkRelations = relations(kbChunk, ({ one }) => ({
  user: one(user, { fields: [kbChunk.userId], references: [user.id] }),
  card: one(cards, { fields: [kbChunk.cardId], references: [cards.id] }),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  user: one(user, { fields: [conversations.userId], references: [user.id] }),
  notebook: one(notebooks, {
    fields: [conversations.notebookId],
    references: [notebooks.id],
  }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  user: one(user, { fields: [messages.userId], references: [user.id] }),
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
}));

export const notebooksRelations = relations(notebooks, ({ one, many }) => ({
  user: one(user, { fields: [notebooks.userId], references: [user.id] }),
  sourceLinks: many(notebookSources),
  conversations: many(conversations),
  notes: many(notebookNotes),
  artifacts: many(notebookArtifacts),
}));

export const notebookNotesRelations = relations(notebookNotes, ({ one }) => ({
  user: one(user, { fields: [notebookNotes.userId], references: [user.id] }),
  notebook: one(notebooks, { fields: [notebookNotes.notebookId], references: [notebooks.id] }),
  message: one(messages, { fields: [notebookNotes.messageId], references: [messages.id] }),
}));

export const notebookArtifactsRelations = relations(notebookArtifacts, ({ one, many }) => ({
  user: one(user, { fields: [notebookArtifacts.userId], references: [user.id] }),
  notebook: one(notebooks, {
    fields: [notebookArtifacts.notebookId],
    references: [notebooks.id],
  }),
  attempts: many(quizAttempts),
}));

export const quizAttemptsRelations = relations(quizAttempts, ({ one }) => ({
  user: one(user, { fields: [quizAttempts.userId], references: [user.id] }),
  artifact: one(notebookArtifacts, {
    fields: [quizAttempts.artifactId],
    references: [notebookArtifacts.id],
  }),
}));

export const notebookSourcesRelations = relations(notebookSources, ({ one }) => ({
  user: one(user, { fields: [notebookSources.userId], references: [user.id] }),
  notebook: one(notebooks, { fields: [notebookSources.notebookId], references: [notebooks.id] }),
  source: one(sources, { fields: [notebookSources.sourceId], references: [sources.id] }),
}));

export const sourcesRelations = relations(sources, ({ one, many }) => ({
  user: one(user, { fields: [sources.userId], references: [user.id] }),
  notebookLinks: many(notebookSources),
  chunks: many(sourceChunks),
  annotations: many(sourceAnnotations),
  cover: one(media, { fields: [sources.coverMediaId], references: [media.id] }),
}));

export const sourceReadingStateRelations = relations(sourceReadingState, ({ one }) => ({
  user: one(user, { fields: [sourceReadingState.userId], references: [user.id] }),
  source: one(sources, { fields: [sourceReadingState.sourceId], references: [sources.id] }),
}));

export const sourceAnnotationsRelations = relations(sourceAnnotations, ({ one }) => ({
  user: one(user, { fields: [sourceAnnotations.userId], references: [user.id] }),
  source: one(sources, { fields: [sourceAnnotations.sourceId], references: [sources.id] }),
}));

export const sourceMarksRelations = relations(sourceMarks, ({ one }) => ({
  user: one(user, { fields: [sourceMarks.userId], references: [user.id] }),
  source: one(sources, { fields: [sourceMarks.sourceId], references: [sources.id] }),
  card: one(cards, { fields: [sourceMarks.cardId], references: [cards.id] }),
}));

export const sourceChunksRelations = relations(sourceChunks, ({ one }) => ({
  user: one(user, { fields: [sourceChunks.userId], references: [user.id] }),
  source: one(sources, { fields: [sourceChunks.sourceId], references: [sources.id] }),
}));

export const cardSourcesRelations = relations(cardSources, ({ one }) => ({
  user: one(user, { fields: [cardSources.userId], references: [user.id] }),
  card: one(cards, { fields: [cardSources.cardId], references: [cards.id] }),
  sourceChunk: one(sourceChunks, {
    fields: [cardSources.sourceChunkId],
    references: [sourceChunks.id],
  }),
  source: one(sources, { fields: [cardSources.sourceId], references: [sources.id] }),
  notebook: one(notebooks, { fields: [cardSources.notebookId], references: [notebooks.id] }),
  conversation: one(conversations, {
    fields: [cardSources.conversationId],
    references: [conversations.id],
  }),
  message: one(messages, { fields: [cardSources.messageId], references: [messages.id] }),
}));

// ── study reminders ────────────────────────────────────────────────────────
// Account choices live outside `profile` so a review undo snapshot cannot
// restore a previous reminder hour. Rows appear only after an explicit save.
// Push endpoints and client keys stay on `push_subscriptions`. Delivery
// receipts store a slot, never the endpoint path.

export const notificationSettings = pgTable(
  'notification_settings',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    digestEnabled: boolean('digest_enabled').notNull().default(false),
    streakWarningEnabled: boolean('streak_warning_enabled').notNull().default(false),
    timeZone: text('time_zone').notNull(),
    digestHour: integer('digest_hour').notNull(),
    streakHour: integer('streak_hour').notNull(),
    emailEnabled: boolean('email_enabled').notNull().default(false),
    pushEnabled: boolean('push_enabled').notNull().default(false),
    locale: text('locale').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('notification_settings_digest_hour_chk', sql`${t.digestHour} between 0 and 23`),
    check('notification_settings_streak_hour_chk', sql`${t.streakHour} between 0 and 23`),
    check('notification_settings_locale_chk', sql`${t.locale} in ('ru', 'en')`),
  ],
);

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    expiration: timestamp('expiration', { withTimezone: true }),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    failureCount: integer('failure_count').notNull().default(0),
  },
  (t) => [unique('push_subscriptions_user_endpoint_uq').on(t.userId, t.endpoint)],
);

export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    channel: text('channel').notNull(),
    studyDay: text('study_day').notNull(),
    status: text('status').notNull(),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    errorCode: text('error_code'),
    pushService: text('push_service'),
  },
  (t) => [
    unique('notification_deliveries_slot_uq').on(t.userId, t.kind, t.channel, t.studyDay),
    check('notification_deliveries_kind_chk', sql`${t.kind} in ('due_digest', 'streak_warning')`),
    check('notification_deliveries_channel_chk', sql`${t.channel} in ('web_push', 'email')`),
    check('notification_deliveries_status_chk', sql`${t.status} in ('reserved', 'sent', 'skipped', 'failed')`),
    check(
      'notification_deliveries_push_service_chk',
      sql`${t.pushService} is null or ${t.pushService} in ('fcm', 'mozilla', 'apple', 'other')`,
    ),
  ],
);

// ── topic study plan ───────────────────────────────────────────────────────
// One notebook owns at most one plan. Modules are an ordered list the user
// edits. Source links are a separate table so dropping a module does not
// delete the library row.

export const topicPlans = pgTable(
  'topic_plans',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    notebookId: uuid('notebook_id')
      .notNull()
      .references(() => notebooks.id, { onDelete: 'cascade' }),
    goal: text('goal').notNull(),
    level: text('level'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('topic_plans_notebook_uq').on(t.notebookId),
    index('topic_plans_user_idx').on(t.userId),
    check('topic_plans_goal_chk', sql`char_length(${t.goal}) between 1 and 200`),
    check('topic_plans_level_chk', sql`${t.level} is null or char_length(${t.level}) between 1 and 80`),
  ],
);

export const topicModules = pgTable(
  'topic_modules',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    planId: uuid('plan_id')
      .notNull()
      .references(() => topicPlans.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    title: text('title').notNull(),
    outcome: text('outcome').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('topic_modules_plan_position_uq').on(t.planId, t.position),
    index('topic_modules_user_idx').on(t.userId),
    check('topic_modules_position_chk', sql`${t.position} >= 0`),
    check('topic_modules_title_chk', sql`char_length(${t.title}) between 1 and 120`),
    check('topic_modules_outcome_chk', sql`char_length(${t.outcome}) between 1 and 400`),
  ],
);

export const topicModulePrerequisites = pgTable(
  'topic_module_prerequisites',
  {
    moduleId: uuid('module_id')
      .notNull()
      .references(() => topicModules.id, { onDelete: 'cascade' }),
    prerequisiteModuleId: uuid('prerequisite_module_id')
      .notNull()
      .references(() => topicModules.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.moduleId, t.prerequisiteModuleId] }),
    check('topic_module_prereq_not_self', sql`${t.moduleId} <> ${t.prerequisiteModuleId}`),
  ],
);

export const topicModuleSources = pgTable(
  'topic_module_sources',
  {
    moduleId: uuid('module_id')
      .notNull()
      .references(() => topicModules.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.moduleId, t.sourceId] }),
    index('topic_module_sources_source_idx').on(t.sourceId),
    index('topic_module_sources_user_idx').on(t.userId),
  ],
);

// ── inferred types ─────────────────────────────────────────────────────────

export type Profile = typeof profile.$inferSelect;
export type NewProfile = typeof profile.$inferInsert;
export type Deck = typeof decks.$inferSelect;
export type NewDeck = typeof decks.$inferInsert;
export type NoteType = typeof noteTypes.$inferSelect;
export type NewNoteType = typeof noteTypes.$inferInsert;
export type Note = typeof notes.$inferSelect;
export type NewNote = typeof notes.$inferInsert;
export type Card = typeof cards.$inferSelect;
export type NewCard = typeof cards.$inferInsert;
export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
export type Media = typeof media.$inferSelect;
export type NewMedia = typeof media.$inferInsert;
export type DeckOptionsPreset = typeof deckOptionsPreset.$inferSelect;
export type NewDeckOptionsPreset = typeof deckOptionsPreset.$inferInsert;
export type FilteredDeck = typeof filteredDeck.$inferSelect;
export type NewFilteredDeck = typeof filteredDeck.$inferInsert;
export type KbChunk = typeof kbChunk.$inferSelect;
export type NewKbChunk = typeof kbChunk.$inferInsert;
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
export type Notebook = typeof notebooks.$inferSelect;
export type NewNotebook = typeof notebooks.$inferInsert;
export type NotebookNote = typeof notebookNotes.$inferSelect;
export type NewNotebookNote = typeof notebookNotes.$inferInsert;
export type NotebookArtifact = typeof notebookArtifacts.$inferSelect;
export type NewNotebookArtifact = typeof notebookArtifacts.$inferInsert;
export type QuizAttempt = typeof quizAttempts.$inferSelect;
export type NewQuizAttempt = typeof quizAttempts.$inferInsert;
export type Source = typeof sources.$inferSelect;
export type NewSource = typeof sources.$inferInsert;
export type SourceChunk = typeof sourceChunks.$inferSelect;
export type NewSourceChunk = typeof sourceChunks.$inferInsert;
export type CardSource = typeof cardSources.$inferSelect;
export type NewCardSource = typeof cardSources.$inferInsert;
export type SourceAnnotation = typeof sourceAnnotations.$inferSelect;
export type NewSourceAnnotation = typeof sourceAnnotations.$inferInsert;
export type SourceMark = typeof sourceMarks.$inferSelect;
export type NewSourceMark = typeof sourceMarks.$inferInsert;
export type NotebookSource = typeof notebookSources.$inferSelect;
export type NewNotebookSource = typeof notebookSources.$inferInsert;
export type SourceReadingState = typeof sourceReadingState.$inferSelect;
export type NewSourceReadingState = typeof sourceReadingState.$inferInsert;
export type NotificationSettings = typeof notificationSettings.$inferSelect;
export type NewNotificationSettings = typeof notificationSettings.$inferInsert;
export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type NewPushSubscription = typeof pushSubscriptions.$inferInsert;
export type NotificationDelivery = typeof notificationDeliveries.$inferSelect;
export type NewNotificationDelivery = typeof notificationDeliveries.$inferInsert;
export type TopicPlan = typeof topicPlans.$inferSelect;
export type NewTopicPlan = typeof topicPlans.$inferInsert;
export type TopicModule = typeof topicModules.$inferSelect;
export type NewTopicModule = typeof topicModules.$inferInsert;
export type TopicModulePrerequisite = typeof topicModulePrerequisites.$inferSelect;
export type NewTopicModulePrerequisite = typeof topicModulePrerequisites.$inferInsert;
export type TopicModuleSource = typeof topicModuleSources.$inferSelect;
export type NewTopicModuleSource = typeof topicModuleSources.$inferInsert;
