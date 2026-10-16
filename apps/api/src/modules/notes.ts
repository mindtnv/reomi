// Notes CRUD + card generation (Milestone 1, Phase 4).
//
//   POST   /notes            → create a note + generate one card per template
//   GET    /notes/cardless   → notes whose cards were all deleted
//   PATCH  /notes/:id        → re-generate; FSRS preserved on surviving templateOrds
//   POST   /notes/:id/restore → recreate cards for a cardless note in a chosen deck
//   DELETE /notes/:id        → delete (cascade drops cards via FK)
//
// Field values are lossless Markdown SOURCE, not safe HTML. The historical
// sanitizeFieldValues helper copies source without interpreting its syntax.
// render* is a disposable search cache; display parses Markdown with html:false
// and sanitizes the resulting HTML at the browser sink.
//
// Deck assignment (Decision A1): all generated cards get the note's chosen
// deckId. FSRS is initialised per generated card via `newFsrsCard`.

import { Elysia, ElysiaCustomStatusResponse, t, status as reply } from 'elysia';
import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { cards, db, decks, noteOperations, noteTypes, notes, type Db } from '@reomi/db';
import {
  generateCards,
  acceptedAnswerVariants,
  ClozeSyntaxError,
  NoteContentError,
  NoteTagError,
  normalizeNoteTags,
  type NoteContentErrorCode,
  isLegacyClozeCard,
  MAX_CLOZE_NUMBER,
  newFsrsCard,
  stateLabel,
  type FieldValues,
  type NoteTypeDef,
} from '@reomi/shared';
import { authPlugin } from '../auth-plugin.ts';
import {
  logCorrelation,
  requestLogFromContext,
  rootLogger,
  safeError,
} from '../logger.ts';
import type { Logger } from 'pino';
import { sanitizeFieldValues } from '../sanitize.ts';
import { defFromRow } from './note-types.ts';
import { enqueueIndex } from '../ai/index-queue.ts';
import { applyRegeneration, loadRegenerationCards, NoteWriteConflict, planRegeneration, regenerationImpact, regenerationToken } from './card-regeneration';
import { actionHash } from './ui-action-receipts.ts';

/** A Drizzle transaction handle (the arg passed to `db.transaction(async (tx) => …)`). */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Fire-and-forget RAG index enqueue for created/updated cards. Runs AFTER the
 * note transaction commits; `enqueueIndex` is sync + non-blocking (and a no-op
 * when embeddings are disabled), so a queue error can never affect the HTTP
 * response. Wrapped defensively all the same.
 *
 * Exported so the agentic `create_card`/`edit_card` tools (which reuse the
 * extracted note helpers below) enqueue identically after their own commit.
 */
export function enqueueCardsForIndex(
  cardIds: Array<string | undefined>,
  log: Logger = rootLogger,
): void {
  try {
    const correlation = logCorrelation(log);
    for (const id of cardIds) if (id) enqueueIndex(id, correlation);
  } catch (err) {
    log.warn({ err: safeError(err) }, 'ai.index.enqueue_failed');
  }
}

// Size caps (DoS hardening): bound field-name length, per-value HTML length, and
// the number of fields a single note may carry.
const fieldValuesSchema = t.Record(
  t.String({ maxLength: 128 }),
  t.String({ maxLength: 65536 }),
  { maxProperties: 64 },
);

/** Build the FSRS-initialised column set for a freshly generated card. */
function freshFsrsColumns(now: Date) {
  const initial = newFsrsCard(now);
  return {
    due: new Date(initial.due),
    stability: initial.stability,
    difficulty: initial.difficulty,
    elapsedDays: initial.elapsed_days,
    scheduledDays: initial.scheduled_days,
    learningSteps: initial.learning_steps,
    reps: initial.reps,
    lapses: initial.lapses,
    state: stateLabel(initial.state),
  };
}

// ── Extracted, reuse-by-the-agentic-tools helpers (Phase B) ──────────────────
//
// These hoist the deck/note-type-ownership + sanitize + generateCards logic out
// of the route bodies so the `create_card`/`edit_card` chat tools (apps/api/src/
// ai/tools.ts) can wrap the EXACT same path — no FSRS/sanitizer/regenerate
// reimplementation (Principle 2). The route handlers below call these verbatim,
// so route behavior is unchanged. The DB-writing halves take a transaction
// handle so a caller (e.g. the resume route) can run the mutation atomically
// with its own `role:tool` insert.

/** Resolved (validation-only, no DB write) inputs for a note create. */
export type NoteCreateResolution =
  | { ok: true; def: NoteTypeDef; typeUpdatedAt: Date; sanitized: FieldValues; acceptedAnswers: string[]; generated: ReturnType<typeof generateCards> }
  | { ok: false; error: 'deck_not_found' | 'note_type_not_found' | 'invalid_cloze' | NoteContentErrorCode };

/**
 * Validate deck + note-type ownership and pre-compute the sanitized field values
 * + generated card descriptors for a note create. No DB writes. Shared by the
 * POST /notes route and the `create_card` tool so ownership/sanitize/gen match.
 */
export async function resolveNoteCreate(
  userId: string,
  input: { deckId: string; noteTypeId: string; fieldValues: FieldValues; acceptedAnswers?: string[] },
  executor: Pick<Db, 'select'> = db,
): Promise<NoteCreateResolution> {
  const [deck] = await executor
    .select({ id: decks.id })
    .from(decks)
    .where(and(eq(decks.id, input.deckId), eq(decks.userId, userId)))
    .limit(1);
  if (!deck) return { ok: false, error: 'deck_not_found' };

  const [noteType] = await executor
    .select()
    .from(noteTypes)
    .where(eq(noteTypes.id, input.noteTypeId))
    .limit(1);
  if (!noteType || (noteType.userId !== null && noteType.userId !== userId)) {
    return { ok: false, error: 'note_type_not_found' };
  }

  const sanitized = sanitizeFieldValues(input.fieldValues);
  const def = defFromRow(noteType);
  let generated: ReturnType<typeof generateCards>;
  let acceptedAnswers: string[];
  try { acceptedAnswers = acceptedAnswerVariants(input.acceptedAnswers ?? []); generated = generateCards(def, sanitized); } catch (error) { if (error instanceof ClozeSyntaxError) return { ok: false, error: 'invalid_cloze' }; if (error instanceof NoteContentError) return { ok: false, error: error.code }; throw error; }
  return { ok: true, def, typeUpdatedAt: noteType.updatedAt, sanitized, acceptedAnswers, generated };
}

/**
 * Insert a note + its generated cards inside the supplied transaction. Pure DB
 * write — the caller passes an already-resolved `sanitized`/`generated` pair
 * (from {@link resolveNoteCreate}) and is responsible for the index enqueue
 * AFTER commit (route + tool both call `enqueueCardsForIndex`).
 */
export async function insertNoteAndCards(
  tx: Tx,
  input: {
    userId: string;
    deckId: string;
    noteTypeId: string;
    expectedTypeUpdatedAt: Date;
    sanitized: FieldValues;
    acceptedAnswers?: string[];
    tags: string[];
    generated: ReturnType<typeof generateCards>;
    now?: Date;
  },
): Promise<{ note: typeof notes.$inferSelect; cards: (typeof cards.$inferSelect)[] }> {
  const now = input.now ?? new Date();
  const tags = normalizeNoteTags(input.tags);
  if (!tags.ok) throw new NoteTagError(tags.error);
  const [currentType] = await tx.select().from(noteTypes).where(eq(noteTypes.id, input.noteTypeId)).for('share');
  if (!currentType || currentType.updatedAt.getTime() !== input.expectedTypeUpdatedAt.getTime()) throw new NoteWriteConflict('note_type_changed');
  const [note] = await tx
    .insert(notes)
    .values({
      userId: input.userId,
      noteTypeId: input.noteTypeId,
      fieldValues: input.sanitized,
      acceptedAnswers: input.acceptedAnswers ?? [],
      tags: tags.tags,
    })
    .returning();

  const createdCards: (typeof cards.$inferSelect)[] = [];
  for (const g of input.generated) {
    const [card] = await tx
      .insert(cards)
      .values({
        userId: input.userId,
        deckId: input.deckId,
        noteId: note!.id,
        templateOrd: g.templateOrd,
        clozeNumber: g.clozeNumber,
        renderText: g.renderText,
        renderFrontText: g.renderFrontText,
        renderBackText: g.renderBackText,
        renderKind: g.renderKind,
        ...freshFsrsColumns(now),
      })
      .returning();
    createdCards.push(card!);
  }
  return { note: note!, cards: createdCards };
}

/** Resolved (validation-only, no DB write) inputs for a note field/tags update. */
export type NoteUpdateResolution =
  | {
      ok: true;
      note: typeof notes.$inferSelect;
      nextFieldValues: FieldValues;
      nextTags: string[];
      nextAcceptedAnswers: string[];
      generated: ReturnType<typeof generateCards>;
      typeUpdatedAt: Date;
    }
  | { ok: false; error: 'not_found' | 'note_type_not_found' | 'invalid_cloze' | 'invalid_cloze_split' | 'tag_too_long' | 'too_many_tags' | NoteContentErrorCode };

/**
 * Load + validate a note for a field/tags update and pre-compute the next
 * sanitized field values + regenerated card descriptors. No DB writes. Shared by
 * the PATCH /notes/:id route, the `edit_card` tool's `dryRun` (count diff), and
 * its `execute` (so ownership/sanitize/regenerate match the route exactly).
 */
export async function resolveNoteUpdate(
  userId: string,
  noteId: string,
  patch: { acceptedAnswers?: string[]; fieldValues?: FieldValues; tags?: string[]; clozeRetainHistoryFor?: Record<string, number> },
  executor: Pick<Db, 'select'> = db,
): Promise<NoteUpdateResolution> {
  const [note] = await executor
    .select()
    .from(notes)
    .where(and(eq(notes.id, noteId), eq(notes.userId, userId)))
    .limit(1);
  if (!note) return { ok: false, error: 'not_found' };

  const [noteType] = await executor
    .select()
    .from(noteTypes)
    .where(eq(noteTypes.id, note.noteTypeId))
    .limit(1);
  if (!noteType) return { ok: false, error: 'note_type_not_found' };

  const nextFieldValues =
    patch.fieldValues !== undefined
      ? sanitizeFieldValues(patch.fieldValues)
      : (note.fieldValues as FieldValues);
  let nextTags = note.tags;
  if (patch.tags !== undefined) {
    const parsedTags = normalizeNoteTags(patch.tags);
    if (!parsedTags.ok) return { ok: false, error: parsedTags.error };
    nextTags = parsedTags.tags;
  }
  let nextAcceptedAnswers: string[];
  try { nextAcceptedAnswers = acceptedAnswerVariants(patch.acceptedAnswers ?? note.acceptedAnswers); }
  catch (error) { if (error instanceof NoteContentError) return { ok: false, error: error.code }; throw error; }

  const def = defFromRow(noteType);
  const existing = await executor.select({ clozeNumber: cards.clozeNumber, templateOrd: cards.templateOrd, renderKind: cards.renderKind }).from(cards)
    .where(and(eq(cards.noteId, noteId), eq(cards.userId, userId)));
  const legacy = existing.some(isLegacyClozeCard);
  let generated: ReturnType<typeof generateCards>;
  try { generated = generateCards(def, nextFieldValues, { legacyCloze: legacy && patch.clozeRetainHistoryFor === undefined }); }
  catch (error) { if (error instanceof ClozeSyntaxError) return { ok: false, error: 'invalid_cloze' }; if (error instanceof NoteContentError) return { ok: false, error: error.code }; throw error; }
  if (patch.clozeRetainHistoryFor !== undefined && (def.kind !== 'cloze' || !legacy ||
    existing.filter(isLegacyClozeCard).some((card) => !generated.some((next) => next.templateOrd === card.templateOrd && next.clozeNumber === patch.clozeRetainHistoryFor![String(card.templateOrd)])) ||
    Object.keys(patch.clozeRetainHistoryFor).some((ord) => !existing.some((card) => isLegacyClozeCard(card) && String(card.templateOrd) === ord)))) {
    return { ok: false, error: 'invalid_cloze_split' };
  }
  if (!generated.length) return { ok: false, error: 'no_cards_generated' };
  return { ok: true, note, nextAcceptedAnswers, typeUpdatedAt: noteType.updatedAt, nextFieldValues, nextTags, generated };
}

/**
 * Apply a resolved note update inside the supplied transaction: update the note
 * row + regenerate cards (diff by `templateOrd` — surviving ords keep their FSRS
 * state, new ords insert fresh, removed ords delete). Identical to the PATCH
 * route body; FSRS-on-survivors and the destructive drop are NOT reimplemented
 * by callers (Principle 2). The caller enqueues the index after commit.
 */
export interface NoteUpdateInput {
  nextAcceptedAnswers?: string[];
  clozeRetainHistoryFor?: Record<string, number>;
  userId: string;
  noteId: string;
  nextFieldValues: FieldValues;
  nextTags: string[];
  generated: ReturnType<typeof generateCards>;
  expectedUpdatedAt: Date;
  expectedTypeUpdatedAt: Date;
  deckId?: string;
  now?: Date;
}

/** Lock type -> note -> cards, the same order as note-type reconciliation. */
export async function prepareNoteUpdate(tx: Tx, input: NoteUpdateInput) {
  const [initial] = await tx.select().from(notes).where(and(eq(notes.id, input.noteId), eq(notes.userId, input.userId)));
  if (!initial) throw new NoteWriteConflict('note_changed');
  const [type] = await tx.select().from(noteTypes).where(eq(noteTypes.id, initial.noteTypeId)).for('share');
  if (!type || type.updatedAt.getTime() !== input.expectedTypeUpdatedAt.getTime()) throw new NoteWriteConflict('note_type_changed');
  const [note] = await tx.select().from(notes).where(and(eq(notes.id, input.noteId), eq(notes.userId, input.userId))).for('update');
  if (!note || note.noteTypeId !== type.id || note.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) throw new NoteWriteConflict('note_changed');
  const existing = await loadRegenerationCards(tx, input.userId, [input.noteId]);
  const plan = planRegeneration(existing, input.generated, undefined, input.clozeRetainHistoryFor);
  const deckId = input.deckId ?? existing[0]?.deckId;
  if (plan.create.length && !deckId) throw new NoteWriteConflict('note_deck_required');
  const impact = { ...regenerationImpact([plan]), ...(input.clozeRetainHistoryFor !== undefined ? { retainedClozeTargets: input.clozeRetainHistoryFor } : {}) };
  const preview = { impact, sourceVersion: note.updatedAt.toISOString(), confirmationToken: regenerationToken({
    userId: input.userId, note, typeVersion: type.updatedAt, existing,
    patch: { acceptedAnswers: input.nextAcceptedAnswers ?? note.acceptedAnswers, fields: input.nextFieldValues, tags: input.nextTags, deckId: input.deckId, clozeRetainHistoryFor: input.clozeRetainHistoryFor },
  }) };
  return { note, plan, deckId, preview };
}

export async function applyNoteUpdate(tx: Tx, input: NoteUpdateInput, prepared?: Awaited<ReturnType<typeof prepareNoteUpdate>>) {
  const state = prepared ?? await prepareNoteUpdate(tx, input);
  const now = new Date(Math.max((input.now ?? new Date()).getTime(), state.note.updatedAt.getTime() + 1));
  const [updatedNote] = await tx.update(notes)
    .set({ acceptedAnswers: input.nextAcceptedAnswers ?? state.note.acceptedAnswers, fieldValues: input.nextFieldValues, tags: input.nextTags, updatedAt: now })
    .where(and(eq(notes.id, input.noteId), eq(notes.userId, input.userId))).returning();
  const indexIds = await applyRegeneration(tx, { userId: input.userId, noteId: input.noteId,
    plan: state.plan, deckId: state.deckId, moveToDeckId: input.deckId, now });
  const finalCards = await tx.select().from(cards).where(and(eq(cards.noteId, input.noteId), eq(cards.userId, input.userId)));
  return { note: updatedNote!, cards: finalCards, indexIds, updated: state.plan.keep.length,
    inserted: state.plan.create.length, deleted: state.plan.remove.length };
}

type NoteEdit = { acceptedAnswers?: string[]; expectedTypeUpdatedAt?: string; clozeRetainHistoryFor?: Record<string, number>; fieldValues?: FieldValues; tags?: string[]; deckId?: string; preview?: boolean; confirmationToken?: string; expectedUpdatedAt?: string };
export const noteEditOptions = {
      auth: true as const,
      params: t.Object({ id: t.String({ format: 'uuid' }) }),
      body: t.Partial(
        t.Object({
          clozeRetainHistoryFor: t.Record(t.String({ pattern: '^(0|[1-9][0-9]*)$', maxLength: 3 }), t.Integer({ minimum: 1, maximum: MAX_CLOZE_NUMBER }), { minProperties: 1, maxProperties: 32 }),
          preview: t.Boolean(),
          confirmationToken: t.String({ maxLength: 64 }),
          expectedUpdatedAt: t.String({ format: 'date-time' }),
          expectedTypeUpdatedAt: t.String({ format: 'date-time' }),
          acceptedAnswers: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 256 }), { maxItems: 20 })),
          fieldValues: fieldValuesSchema,
          tags: t.Array(t.String()),
          deckId: t.String({ format: 'uuid' }),
        }),
      ),
    };
export async function editNote(context: { user: { id: string }; params: { id: string }; body: NoteEdit }, transaction?: Tx, deferredIndex?: string[]) {
      const { user, params, body } = context;
      const status = reply;
      const log = requestLogFromContext(context);
      const resolved = await resolveNoteUpdate(user.id, params.id, {
        fieldValues: body.fieldValues,
        acceptedAnswers: body.acceptedAnswers,
        tags: body.tags,
        clozeRetainHistoryFor: body.clozeRetainHistoryFor,
      }, transaction ?? db);
      if (!resolved.ok) return status(resolved.error === 'not_found' || resolved.error === 'note_type_not_found' ? 404 : 400, { error: resolved.error });
      if (body.expectedTypeUpdatedAt && new Date(body.expectedTypeUpdatedAt).getTime() !== resolved.typeUpdatedAt.getTime()) return status(409, { error: 'note_type_changed' });
      if (body.deckId !== undefined) {
        const [target] = await (transaction ?? db).select({ id: decks.id }).from(decks)
          .where(and(eq(decks.id, body.deckId), eq(decks.userId, user.id))).limit(1);
        if (!target) return status(400, { error: 'deck_not_found' });
      }

      const input: NoteUpdateInput = {
        userId: user.id, noteId: params.id, nextFieldValues: resolved.nextFieldValues,
        nextTags: resolved.nextTags, nextAcceptedAnswers: resolved.nextAcceptedAnswers, generated: resolved.generated, deckId: body.deckId, clozeRetainHistoryFor: body.clozeRetainHistoryFor,
        expectedUpdatedAt: body.expectedUpdatedAt ? new Date(body.expectedUpdatedAt) : resolved.note.updatedAt,
        expectedTypeUpdatedAt: resolved.typeUpdatedAt,
      };
      const run = async (tx: Tx) => {
        const prepared = await prepareNoteUpdate(tx, input);
        if (body.preview) return prepared.preview;
        if ((prepared.preview.impact.willDeleteCards > 0 || body.clozeRetainHistoryFor !== undefined || body.confirmationToken) &&
          body.confirmationToken !== prepared.preview.confirmationToken) {
          throw new NoteWriteConflict(body.confirmationToken ? 'preview_changed' : 'card_removal_confirmation_required');
        }
        return applyNoteUpdate(tx, input, prepared);
      };
      const result = await (transaction ? run(transaction) : db.transaction(run)).catch((error) => { if (error instanceof NoteWriteConflict) return error; throw error; });
      if (result instanceof NoteWriteConflict) return status(409, { error: result.code });
      if ('impact' in result) return result;

      log.info(
        {
          noteId: params.id,
          noteTypeId: resolved.note.noteTypeId,
          cardsUpdated: result.updated,
          cardsInserted: result.inserted,
          cardsDeleted: result.deleted,
        },
        'note.update',
      );

      // RAG index hook (Slice 3): re-enqueue surviving + new cards after commit.
      // The sourceHash skip means an unchanged render_text costs nothing.
      if (transaction) deferredIndex?.push(...result.cards.map(c => c.id));
      else enqueueCardsForIndex(result.cards.map((c) => c.id), log);

      return { note: result.note, cards: result.cards };
}

export const noteCreateBody = t.Object({
        noteTypeId: t.String({ format: 'uuid' }),
        expectedTypeUpdatedAt: t.Optional(t.String({ format: 'date-time' })),
        acceptedAnswers: t.Optional(t.Array(t.String({ minLength: 1, maxLength: 256 }), { maxItems: 20 })),
        fieldValues: fieldValuesSchema,
        tags: t.Optional(t.Array(t.String())),
        deckId: t.String({ format: 'uuid' }),
      });

export async function createNoteForRequest(context: { user: { id: string }; body: typeof noteCreateBody.static }, transaction?: Tx, deferredIndex?: string[]) {
      const { user, body } = context;
      const status = reply;
      const log = requestLogFromContext(context);
      // Authorize deck + note-type ownership and pre-compute sanitize+gen.
      const resolved = await resolveNoteCreate(user.id, {
        deckId: body.deckId,
        noteTypeId: body.noteTypeId,
        fieldValues: body.fieldValues,
        acceptedAnswers: body.acceptedAnswers,
      }, transaction ?? db);
      if (!resolved.ok) return status(400, { error: resolved.error });
      if (body.expectedTypeUpdatedAt && new Date(body.expectedTypeUpdatedAt).getTime() !== resolved.typeUpdatedAt.getTime()) return status(409, { error: 'note_type_changed' });
      if (resolved.generated.length === 0) return status(400, { error: 'no_cards_generated' });
      const tags = normalizeNoteTags(body.tags ?? []);
      if (!tags.ok) return status(400, { error: tags.error });

      const now = new Date();
      const run = (tx: Tx) =>
        insertNoteAndCards(tx, {
          userId: user.id,
          deckId: body.deckId,
          noteTypeId: body.noteTypeId,
          expectedTypeUpdatedAt: resolved.typeUpdatedAt,
          sanitized: resolved.sanitized,
          acceptedAnswers: resolved.acceptedAnswers,
          tags: tags.tags,
          generated: resolved.generated,
          now,
        });
      const result = await (transaction ? run(transaction) : db.transaction(run)).catch((error) => {
        if (error instanceof NoteWriteConflict || error instanceof NoteTagError) return error;
        throw error;
      });
      if (result instanceof NoteWriteConflict) return status(409, { error: result.code });
      if (result instanceof NoteTagError) return status(400, { error: result.code });

      log.info(
        {
          noteId: result.note.id,
          noteTypeId: body.noteTypeId,
          cardsGenerated: result.cards.length,
        },
        'note.create',
      );

      // RAG index hook (Slice 3): enqueue each generated card after commit.
      if (transaction) deferredIndex?.push(...result.cards.map(c => c.id));
      else enqueueCardsForIndex(result.cards.map((c) => c?.id), log);

      return result;
}

const cardlessNoteColumns = {
  id: notes.id,
  noteTypeId: notes.noteTypeId,
  noteTypeName: noteTypes.name,
  fieldValues: notes.fieldValues,
  tags: notes.tags,
  createdAt: notes.createdAt,
  updatedAt: notes.updatedAt,
};

/** Owned notes with no generated cards. Card deletion does not remove the note. */
export async function listCardlessNotes(userId: string) {
  const items = await db
    .select(cardlessNoteColumns)
    .from(notes)
    .innerJoin(noteTypes, eq(noteTypes.id, notes.noteTypeId))
    .leftJoin(cards, and(eq(cards.noteId, notes.id), eq(cards.userId, notes.userId)))
    .where(and(eq(notes.userId, userId), isNull(cards.id)))
    .orderBy(desc(notes.updatedAt), desc(notes.id));
  return { total: items.length, items };
}

function restoreStatus(error: string): 400 | 404 | 409 {
  if (error === 'not_found' || error === 'note_type_not_found') return 404;
  if (
    error === 'note_has_cards' ||
    error === 'note_changed' ||
    error === 'note_type_changed' ||
    error === 'note_deck_required' ||
    error === 'preview_changed' ||
    error === 'card_removal_confirmation_required'
  ) return 409;
  return 400;
}

/**
 * Recreate cards for a note that has none. The caller chooses the deck.
 * A note that already has a card is left unchanged.
 */
export async function restoreCardlessNote(userId: string, noteId: string, deckId: string, log: Logger = rootLogger) {
  const deferred: string[] = [];
  const result = await db.transaction(async (tx) => {
    const [deck] = await tx.select({ id: decks.id }).from(decks)
      .where(and(eq(decks.id, deckId), eq(decks.userId, userId))).limit(1);
    if (!deck) return { ok: false as const, error: 'deck_not_found' };

    const [peek] = await tx.select({ noteTypeId: notes.noteTypeId }).from(notes)
      .where(and(eq(notes.id, noteId), eq(notes.userId, userId))).limit(1);
    if (!peek) return { ok: false as const, error: 'not_found' };

    const [type] = await tx.select().from(noteTypes).where(eq(noteTypes.id, peek.noteTypeId)).for('share');
    if (!type || (type.userId !== null && type.userId !== userId)) return { ok: false as const, error: 'note_type_not_found' };

    const [note] = await tx.select().from(notes)
      .where(and(eq(notes.id, noteId), eq(notes.userId, userId))).for('update');
    if (!note || note.noteTypeId !== type.id) return { ok: false as const, error: 'not_found' };

    const [existing] = await tx.select({ id: cards.id }).from(cards)
      .where(and(eq(cards.noteId, noteId), eq(cards.userId, userId))).limit(1);
    if (existing) return { ok: false as const, error: 'note_has_cards' };

    const resolved = await resolveNoteUpdate(userId, noteId, {}, tx);
    if (!resolved.ok) return { ok: false as const, error: resolved.error };

    const applied = await applyNoteUpdate(tx, {
      userId,
      noteId,
      nextFieldValues: resolved.nextFieldValues,
      nextTags: resolved.nextTags,
      nextAcceptedAnswers: resolved.nextAcceptedAnswers,
      generated: resolved.generated,
      deckId,
      expectedUpdatedAt: note.updatedAt,
      expectedTypeUpdatedAt: type.updatedAt,
    });
    deferred.push(...applied.indexIds);
    return { ok: true as const, note: applied.note, cards: applied.cards };
  }).catch((error) => {
    if (error instanceof NoteWriteConflict) return { ok: false as const, error: error.code };
    throw error;
  });

  if (!result.ok) return result;
  enqueueCardsForIndex(deferred, log);
  log.info({ noteId, cardsGenerated: result.cards.length }, 'note.restore');
  return result;
}

async function readOwnedNote(executor: Pick<Db, 'select'>, userId: string, noteId: string) {
  const [note] = await executor.select().from(notes).where(and(eq(notes.id, noteId), eq(notes.userId, userId))).limit(1);
  if (!note) return null;
  const generated = await executor.select().from(cards)
    .where(and(eq(cards.userId, userId), eq(cards.noteId, noteId)))
    .orderBy(asc(cards.templateOrd), asc(cards.clozeNumber), asc(cards.id));
  return { note, cards: generated };
}

function noteOperationHash(body: typeof noteCreateBody.static) {
  const tags = normalizeNoteTags(body.tags ?? []);
  return actionHash({
    noteTypeId: body.noteTypeId,
    expectedTypeUpdatedAt: body.expectedTypeUpdatedAt ?? null,
    deckId: body.deckId,
    fieldValues: body.fieldValues,
    acceptedAnswers: body.acceptedAnswers ?? [],
    tags: tags.ok ? tags.tags : (body.tags ?? []),
  });
}

/** Versioned create. The same operation id replays one note; legacy POST /notes stays insert-only. */
export async function createNoteOperation(
  context: { user: { id: string }; body: typeof noteCreateBody.static },
  operationId: string,
) {
  const argumentsHash = noteOperationHash(context.body);
  const deferred: string[] = [];
  const outcome = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${context.user.id}:${operationId}`}, 941))`);
    const [receipt] = await tx.select().from(noteOperations)
      .where(and(eq(noteOperations.userId, context.user.id), eq(noteOperations.operationId, operationId)))
      .limit(1);
    if (receipt) {
      if (receipt.argumentsHash !== argumentsHash) return reply(409, { error: 'operation_conflict' });
      const existing = receipt.noteId ? await readOwnedNote(tx, context.user.id, receipt.noteId) : null;
      if (!existing) return reply(409, { error: 'operation_reverted' });
      return { ...existing, replayed: true as const };
    }
    const created = await createNoteForRequest(context, tx, deferred);
    if (created instanceof ElysiaCustomStatusResponse || !created || typeof created !== 'object' || !('note' in created)) return created;
    await tx.insert(noteOperations).values({
      userId: context.user.id,
      operationId,
      argumentsHash,
      noteId: created.note.id,
    });
    return { note: created.note, cards: created.cards, replayed: false as const };
  });
  if (outcome && typeof outcome === 'object' && 'replayed' in outcome && outcome.replayed === false) enqueueCardsForIndex(deferred);
  return outcome;
}

export async function getNoteOperation(userId: string, operationId: string) {
  const [receipt] = await db.select().from(noteOperations)
    .where(and(eq(noteOperations.userId, userId), eq(noteOperations.operationId, operationId)))
    .limit(1);
  if (!receipt) return reply(404, { error: 'operation_not_found' });
  const existing = receipt.noteId ? await readOwnedNote(db, userId, receipt.noteId) : null;
  if (!existing) return { status: 'reverted' as const };
  return { status: 'committed' as const, result: existing };
}

export const notesModule = new Elysia({ prefix: '/notes' })
  .use(authPlugin)
  .get('/cardless', async ({ user }) => listCardlessNotes(user.id), { auth: true })
  .post('/', createNoteForRequest, { auth: true, body: noteCreateBody })
  .post('/operations/:operationId', (context) => createNoteOperation(context, context.params.operationId), {
    auth: true,
    body: noteCreateBody,
    params: t.Object({ operationId: t.String({ format: 'uuid' }) }),
  })
  .get('/operations/:operationId', ({ user, params }) => getNoteOperation(user.id, params.operationId), {
    auth: true,
    params: t.Object({ operationId: t.String({ format: 'uuid' }) }),
  })
  .patch('/:id', editNote, noteEditOptions)
  .get('/:id', async ({ user, params, status }) => {
    const [row] = await db.select({ note: notes, noteType: noteTypes }).from(notes)
      .innerJoin(noteTypes, and(eq(noteTypes.id, notes.noteTypeId), or(eq(noteTypes.userId, user.id), and(isNull(noteTypes.userId), eq(noteTypes.isBuiltin, true)))))
      .where(and(eq(notes.userId, user.id), eq(notes.id, params.id))).limit(1);
    if (!row) return status(404, { error: 'not_found' });
    const generated = await db.select({ id: cards.id, deckId: cards.deckId, templateOrd: cards.templateOrd, clozeNumber: cards.clozeNumber }).from(cards)
      .where(and(eq(cards.userId, user.id), eq(cards.noteId, params.id))).orderBy(asc(cards.templateOrd), asc(cards.clozeNumber), asc(cards.id)).limit(2001);
    if (generated.length > 2000) return status(400, { error: 'note_too_large' });
    return { ...row, cards: generated };
  }, { auth: true, params: t.Object({ id: t.String({ format: 'uuid' }) }) })
  .post('/:id/preview', (context) => editNote({ ...context, body: { ...context.body, preview: true } }), noteEditOptions)
  .post('/:id/restore', async ({ user, params, body, status, ...rest }) => {
    const result = await restoreCardlessNote(user.id, params.id, body.deckId, requestLogFromContext({ user, params, body, status, ...rest }));
    if (!result.ok) return status(restoreStatus(result.error), { error: result.error });
    return { note: result.note, cards: result.cards };
  }, {
    auth: true,
    params: t.Object({ id: t.String({ format: 'uuid' }) }),
    body: t.Object({ deckId: t.String({ format: 'uuid' }) }),
  })
  .delete(
    '/:id',
    async ({ user, params, status }) => {
      // Cascade drops cards (and their reviews) via FK ON DELETE CASCADE.
      const [deleted] = await db
        .delete(notes)
        .where(and(eq(notes.id, params.id), eq(notes.userId, user.id)))
        .returning({ id: notes.id });
      if (!deleted) return status(404, { error: 'not_found' });
      return { ok: true };
    },
    { auth: true, params: t.Object({ id: t.String({ format: 'uuid' }) }) },
  );
