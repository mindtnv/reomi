import type { ActionTx } from './ui-action-receipts';
// Note-types CRUD (Milestone 1, Phase 4 — Decision C-4 global builtins).
//
//   GET    /note-types      → rows owned by the user OR global builtins
//   POST   /note-types      → create a user-owned note-type
//   PATCH  /note-types/:id   → edit own; CLONE-ON-EDIT for builtins/global rows
//   GET    /note-types/:id/delete-preview → complete deletion impact + token
//   DELETE /note-types/:id   → delete own after exact current consent
//
// All routes pass `{ auth: true }` and scope by `user.id`. Builtins (userId NULL,
// isBuiltin=true) are visible to everyone but never mutated — editing one creates
// a user-owned copy with the requested changes (clone-on-edit).
//
// Mass re-render (plan must-fix #6 / C-5): when a PATCH changes templates/styling,
// the denormalized plaintext search columns (render*) of ALL cards of ALL notes
// of that type are recomputed IN-TRANSACTION (FSRS preserved), and the change is
// logged `{ noteTypeId, cardsRerendered }`.

import { isDeepStrictEqual } from 'node:util';
import { Elysia, t, status as reply } from 'elysia';
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm';
import { cards, db, noteTypes, notes } from '@reomi/db';
import {
  generateCards,
  fieldPlainText,
  typedAnswerField,
  NoteContentError,
  ClozeSyntaxError,
  type CardRegenerationPreview,
  validFieldNames,
  validateTemplates,
  isLegacyClozeCard,
  identifiedFields,
  identifiedTemplates,
  newUuidV7,
  renameFieldValues,
  renameTemplateFields,
  type CardTemplate,
  type FieldValues,
  type NoteField,
  type NoteTypeDef,
  type RenderKind,
} from '@reomi/shared';
import { removeNoteType } from './note-type-deletion';
import { authPlugin } from '../auth-plugin.ts';
import { logCorrelation, requestLogFromContext, safeError } from '../logger.ts';
import { enqueueIndex } from '../ai/index-queue';
import { applyRegeneration, loadRegenerationCards, planRegeneration, regenerationImpact, regenerationToken, type RegenerationPlan } from './card-regeneration';
import { withUserRevisionLock, writeNoteDocument } from './note-revisions';

import { NOTE_TYPE_BUDGET, NoteTypeBudgetError, startNoteTypeBudget, noteTypeBudgetFailure, noteTypeExpansionBytes } from './note-type-budget';

const renderKindSchema = t.Union([
  t.Literal('basic'),
  t.Literal('cloze'),
  t.Literal('typein'),
  t.Literal('custom'),
]);

const noteFieldSchema = t.Object({
  id: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
  name: t.String({ minLength: 1, maxLength: 128 }),
  typeinAnswer: t.Optional(t.Boolean()),
  ord: t.Integer({ minimum: 0 }),
});

const cardTemplateSchema = t.Object({
  id: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
  name: t.String({ minLength: 1, maxLength: 128 }),
  ord: t.Integer({ minimum: 0 }),
  frontTemplate: t.String({ maxLength: 16384 }),
  backTemplate: t.String({ maxLength: 16384 }),
});

/**
 * Validate that field/template ordinals are dense (0..n-1) and unique, and that
 * there is at least one field and one template. Returns an error code or null.
 */
export function validateOrdinals(
  fields: { ord: number }[],
  templates: { ord: number }[],
): 'no_fields' | 'no_templates' | 'bad_field_ords' | 'bad_template_ords' | null {
  if (fields.length === 0) return 'no_fields';
  if (templates.length === 0) return 'no_templates';
  if (!isDenseUnique(fields.map((f) => f.ord))) return 'bad_field_ords';
  if (!isDenseUnique(templates.map((tpl) => tpl.ord))) return 'bad_template_ords';
  return null;
}

function isDenseUnique(ords: number[]): boolean {
  const sorted = [...ords].sort((a, b) => a - b);
  return sorted.every((o, i) => o === i);
}

/** Reconstruct a NoteTypeDef from a persisted row (drives generation). */
export function defFromRow(row: {
  id: string;
  name: string;
  fields: NoteField[];
  templates: CardTemplate[];
  styling: string;
  kind: string;
  isBuiltin: boolean;
}): NoteTypeDef {
  return {
    id: row.id,
    name: row.name,
    fields: identifiedFields(row.id, row.fields, row.kind),
    templates: identifiedTemplates(row.id, row.templates),
    styling: row.styling,
    isBuiltin: row.isBuiltin,
    kind: row.kind as RenderKind,
  };
}

type NoteTypeEdit = { name?: string; fields?: NoteField[]; templates?: CardTemplate[]; styling?: string; kind?: RenderKind; preview?: boolean; confirmationToken?: string; expectedUpdatedAt?: string };
export const noteTypeEditOptions = {
      auth: true as const,
      params: t.Object({ id: t.String({ format: 'uuid' }) }),
      body: t.Partial(
        t.Object({
          preview: t.Boolean(),
          confirmationToken: t.String({ maxLength: 64 }),
          expectedUpdatedAt: t.String({ format: 'date-time' }),
          name: t.String({ minLength: 1, maxLength: 128 }),
          fields: t.Array(noteFieldSchema, { minItems: 1, maxItems: 64 }),
          templates: t.Array(cardTemplateSchema, { minItems: 1, maxItems: 32 }),
          styling: t.String({ maxLength: 32768 }),
          kind: renderKindSchema,
        }),
      ),
    };
export async function editNoteType(context: { user: { id: string }; params: { id: string }; body: NoteTypeEdit }, kindConversion = false, transaction?: ActionTx, deferredIndex?: string[]) {
      const { user, params, body } = context;
      const status = reply;
      const log = requestLogFromContext(context);
      // Resolve the target row: must be owned OR a global builtin.
      const [target] = await (transaction ?? db)
        .select()
        .from(noteTypes)
        .where(
          and(
            eq(noteTypes.id, params.id),
            or(eq(noteTypes.userId, user.id), isNull(noteTypes.userId)),
          ),
        )
        .limit(1);
      if (!target) return status(404, { error: 'not_found' });
      if (body.kind !== undefined && body.kind !== target.kind && !kindConversion) return status(409, { error: 'kind_conversion_required' });
      if (body.expectedUpdatedAt && new Date(body.expectedUpdatedAt).getTime() !== target.updatedAt.getTime()) {
        return status(409, { error: 'note_type_changed' });
      }

      // Compute the merged next shape (used both for ordinal validation and for
      // deciding whether a re-render is needed).
      const oldFields = identifiedFields(target.id, target.fields, target.kind);
      const renames = new Map<string, string>();
      const nextFields = (body.fields ?? oldFields).map((field) => {
        const previous = field.id ? oldFields.find((old) => old.id === field.id)
          : oldFields.find((old) => old.name === field.name);
        const name = field.name.trim().normalize('NFC');
        if (previous && previous.name !== name) renames.set(previous.name, name);
        return { ...field, name, id: previous?.id ?? field.id ?? newUuidV7(),
          ...(field.typeinAnswer === undefined && previous?.typeinAnswer ? { typeinAnswer: true } : {}) };
      });
      if (!validFieldNames(nextFields)) {
        return status(400, { error: 'invalid_field_names' });
      }
      if (new Set(nextFields.map((field) => field.id)).size !== nextFields.length ||
        body.fields?.some((field) => field.id && !oldFields.some((old) => old.id === field.id))) {
        return status(400, { error: 'invalid_field_identity' });
      }
      // An old client cannot express whether remove+add means rename. Require
      // stable IDs for that ambiguous operation instead of silently hiding data.
      if (body.fields?.some((field) => !field.id && !oldFields.some((old) => old.name === field.name)) &&
        oldFields.some((old) => !nextFields.some((field) => field.id === old.id))) {
        return status(400, { error: 'field_identity_required' });
      }
      const oldTemplates = identifiedTemplates(target.id, target.templates);
      const nextTemplates = (body.templates ?? oldTemplates).map((template) => {
        const previous = template.id ? oldTemplates.find((old) => old.id === template.id)
          : oldTemplates.find((old) => old.name === template.name);
        return {
          ...template, id: previous?.id ?? template.id ?? newUuidV7(),
          frontTemplate: renameTemplateFields(template.frontTemplate, renames),
          backTemplate: renameTemplateFields(template.backTemplate, renames),
        };
      });
      if (new Set(nextTemplates.map((template) => template.id)).size !== nextTemplates.length ||
        body.templates?.some((template) => template.id && !oldTemplates.some((old) => old.id === template.id))) {
        return status(400, { error: 'invalid_template_identity' });
      }
      const nextOrdByOldOrd = new Map(oldTemplates.flatMap((old) => {
        const next = nextTemplates.find((template) => template.id === old.id);
        return next ? [[old.ord, next.ord] as const] : [];
      }));
      const nextStyling = body.styling ?? target.styling;
      const nextName = body.name ?? target.name;
      const nextKind = (body.kind ?? target.kind) as RenderKind;

      const err = validateOrdinals(nextFields, nextTemplates);
      if (err) return status(400, { error: err });
      if (nextFields.filter((field) => field.typeinAnswer).length > 1 ||
        (nextKind === 'typein' && target.kind === 'typein' && !nextFields.some((field) => field.typeinAnswer))) {
        return status(400, { error: 'invalid_typein_answer' });
      }
      if (nextKind === 'typein' && !nextFields.some((field) => field.typeinAnswer)) {
        const last = [...nextFields].sort((a, b) => b.ord - a.ord)[0];
        if (last) last.typeinAnswer = true;
      }
      const issues = validateTemplates(nextFields, nextTemplates);
      if (issues.length) return status(400, { error: 'invalid_template', issues });

      // CLONE-ON-EDIT: a builtin / global row (userId NULL or isBuiltin) is never
      // mutated. Create a user-owned copy carrying the requested changes.
      if (target.userId === null || target.isBuiltin) {
        if (body.preview) return { impact: regenerationImpact([]), sourceVersion: target.updatedAt.toISOString(), confirmationToken: '' };
        const [clone] = await (transaction ?? db)
          .insert(noteTypes)
          .values({
            userId: user.id,
            name: nextName,
            fields: nextFields,
            templates: nextTemplates,
            styling: nextStyling,
            kind: nextKind,
            isBuiltin: false,
          })
          .returning();
        return clone;
      }

      // Owned row: detect whether render output could change (templates/styling/
      // kind). Field renames also change render output (template references).
      const templatesChanged = !isDeepStrictEqual(nextTemplates, oldTemplates);
      const stylingChanged = body.styling !== undefined && body.styling !== target.styling;
      const kindChanged = body.kind !== undefined && body.kind !== target.kind;
      const fieldsChanged = !isDeepStrictEqual(nextFields, oldFields);
      const needsRerender = templatesChanged || stylingChanged || kindChanged || fieldsChanged;

      const indexIds: string[] = [];
      const run = async (tx: ActionTx) => {
        await withUserRevisionLock(tx, user.id);
        const checkBudget = await startNoteTypeBudget(tx);
        const [locked] = await tx.select().from(noteTypes)
          .where(eq(noteTypes.id, params.id)).for('update');
        if (!locked) return status(404, { error: 'not_found' });
        if (locked.updatedAt.getTime() !== target.updatedAt.getTime()) return status(409, { error: 'note_type_changed' });
        if (needsRerender) {
          // Check complete scope before loading source or taking thousands of
          // note/card locks. The type lock excludes concurrent note creation.
          const [scope] = await tx.select({ n: sql<number>`count(*)::int`,
            bytes: sql<number>`coalesce(sum(octet_length(${notes.fieldValues}::text)), 0)::bigint`.mapWith(Number),
          }).from(notes).where(and(eq(notes.noteTypeId, params.id), eq(notes.userId, user.id)));
          if (scope!.n > NOTE_TYPE_BUDGET.notes || scope!.bytes > NOTE_TYPE_BUDGET.sourceBytes)
            throw new NoteTypeBudgetError('note_type_operation_too_large');
          const [cardScope] = await tx.select({ n: sql<number>`count(*)::int` }).from(cards)
            .innerJoin(notes, eq(notes.id, cards.noteId))
            .where(and(eq(notes.noteTypeId, params.id), eq(notes.userId, user.id), eq(cards.userId, user.id)));
          if (cardScope!.n > NOTE_TYPE_BUDGET.cards) throw new NoteTypeBudgetError('note_type_operation_too_large');
          checkBudget();
        }
        const typeNotes = needsRerender ? await tx.select({
          id: notes.id, userId: notes.userId, fieldValues: notes.fieldValues, tags: notes.tags,
          acceptedAnswers: notes.acceptedAnswers, noteTypeId: notes.noteTypeId, updatedAt: notes.updatedAt,
        }).from(notes).where(and(eq(notes.noteTypeId, params.id), eq(notes.userId, user.id))).orderBy(asc(notes.id)).for('update') : [];
        const renamedValues = new Map<string, FieldValues>();
        const existing = await loadRegenerationCards(tx, user.id, typeNotes.map((note) => note.id));
        const existingByNote = new Map<string, typeof existing>();
        for (const card of existing) {
          const group = existingByNote.get(card.noteId) ?? [];
          group.push(card); existingByNote.set(card.noteId, group);
        }
        const plans = new Map<string, RegenerationPlan>();
        const def = defFromRow({ ...target, fields: nextFields, templates: nextTemplates, kind: nextKind, styling: nextStyling });
        const validation: NonNullable<CardRegenerationPreview['validation']> = { checkedNotes: typeNotes.length, invalidNotes: 0, samples: [] };
        let expandedBytes = 0;
        let generatedCount = 0;
        let generatedBytes = 0;
        for (const note of typeNotes) {
          checkBudget();
          const values = renameFieldValues(note.fieldValues, renames);
          if (!values) return status(400, { error: 'field_value_collision' });
          expandedBytes += noteTypeExpansionBytes(nextTemplates, values);
          if (expandedBytes > NOTE_TYPE_BUDGET.sourceBytes) throw new NoteTypeBudgetError('note_type_operation_too_large');
          renamedValues.set(note.id, values);
          const prior = existingByNote.get(note.id) ?? [];
          let generated: ReturnType<typeof generateCards> = [];
          let invalid: string | undefined;
          try { generated = generateCards(def, values, { legacyCloze: prior.some(isLegacyClozeCard), checkBudget }); }
          catch (error) { if (error instanceof NoteContentError || error instanceof ClozeSyntaxError) invalid = error instanceof NoteContentError ? error.code : 'invalid_cloze'; else throw error; }
          generatedCount += generated.length;
          generatedBytes += generated.reduce((n, card) => n + Buffer.byteLength(card.renderText), 0);
          if (generatedCount > NOTE_TYPE_BUDGET.cards || generatedBytes > NOTE_TYPE_BUDGET.sourceBytes)
            throw new NoteTypeBudgetError('note_type_operation_too_large');
          if (!generated.length) invalid ??= 'no_cards_generated';
          if (invalid) validation.invalidNotes++;
          const sample = { front: prior[0]?.renderFrontText.slice(0, 160) ?? '',
            ...(nextKind === 'typein' ? { answer: fieldPlainText(values[typedAnswerField(nextFields)?.name ?? ''] ?? '').slice(0, 160) } : {}),
            questions: generated.slice(0, 5).map((card) => card.renderFrontText.slice(0, 160)),
            omittedTemplates: nextTemplates.filter((template) => !generated.some((card) => card.templateOrd === template.ord)).map((template) => template.name),
            ...(invalid ? { error: invalid } : {}) };
          if (validation.samples.length < 5) validation.samples.push(sample);
          else if (invalid) { const index = validation.samples.findIndex((item) => !item.error); if (index >= 0) validation.samples[index] = sample; }
          const sameQuestionMode = !kindChanged || (['basic', 'custom'].includes(target.kind) && ['basic', 'custom'].includes(nextKind));
          const plan = planRegeneration(prior, generated, sameQuestionMode ? nextOrdByOldOrd : new Map());
          if (plan.create.length && !prior.length) return status(409, { error: 'note_deck_required' });
          plans.set(note.id, plan);
        }
        const impact = regenerationImpact([...plans.values()]);
        const confirmationToken = regenerationToken({ userId: user.id, typeId: target.id, version: locked.updatedAt,
          patch: { name: body.name, fields: body.fields, templates: body.templates, kind: body.kind, styling: body.styling },
          notes: typeNotes, cards: existing,
        });
        checkBudget();
        if (body.preview) return { impact, validation, ...(kindChanged ? { kindTransition: { from: target.kind, to: nextKind, resetsQuestions: !(['basic', 'custom'].includes(target.kind) && ['basic', 'custom'].includes(nextKind)) } } : {}), confirmationToken, sourceVersion: locked.updatedAt.toISOString() };
        if (validation.invalidNotes) return status(400, { error: 'invalid_existing_notes', validation });
        if ((kindChanged || impact.willDeleteCards > 0 || body.confirmationToken) && body.confirmationToken !== confirmationToken) {
          return status(409, { error: body.confirmationToken ? 'preview_changed' : 'card_removal_confirmation_required' });
        }
        // Pin one timestamp for the note-type row + every re-rendered card
        // (mirrors notes.ts, which pins `now` for the whole transaction).
        const now = new Date(Math.max(Date.now(), locked.updatedAt.getTime() + 1));
        const [updated] = await tx
          .update(noteTypes)
          .set({
            name: nextName,
            fields: nextFields,
            templates: nextTemplates,
            styling: nextStyling,
            kind: nextKind,
            updatedAt: now,
          })
          .where(eq(noteTypes.id, params.id))
          .returning();
        if (!updated) return status(404, { error: 'not_found' });

        for (const note of typeNotes) {
          checkBudget();
          const fieldValues = renamedValues.get(note.id)!;
          if (renames.size) await writeNoteDocument(tx, note, {
            fieldValues, updatedAt: new Date(Math.max(now.getTime(), note.updatedAt.getTime() + 1)),
          });
          const prior = existingByNote.get(note.id)?.[0];
          indexIds.push(...await applyRegeneration(tx, { userId: user.id, noteId: note.id,
            deckId: prior?.deckId, plan: plans.get(note.id)!, now, checkBudget,
          }));
        }
        checkBudget();
        log.info({ noteTypeId: params.id, cardsRerendered: impact.willKeepCards,
          cardsCreated: impact.willCreateCards, cardsRemoved: impact.willDeleteCards,
        }, 'note_type.rerender');

        return updated;
      };
      const result = await (transaction ? run(transaction) : db.transaction(run)).catch((error: unknown) => {
        const code = noteTypeBudgetFailure(error);
        if (!code) throw error;
        indexIds.length = 0; // The entire transaction was rolled back.
        return status(code === 'note_type_operation_too_large' ? 413 : 503, { error: code, limits: NOTE_TYPE_BUDGET });
      });
      // Budget failures clear the rolled-back IDs. Only committed changed text
      // or new cards are enqueued; deletions cascade their derived index rows.
      try {
        if (transaction) deferredIndex?.push(...indexIds);
        else for (const id of indexIds) enqueueIndex(id, logCorrelation(log));
      } catch (error) { log.warn({ err: safeError(error) }, 'ai.index.enqueue_failed'); }
      return result;
}

type KindEdit = { kind: RenderKind; answerFieldId?: string; expectedUpdatedAt: string; confirmationToken?: string };
export const kindEditOptions = {
  auth: true as const,
  params: t.Object({ id: t.String({ format: 'uuid' }) }),
  body: t.Object({ kind: renderKindSchema, answerFieldId: t.Optional(t.String({ maxLength: 128 })),
    expectedUpdatedAt: t.String({ format: 'date-time' }), confirmationToken: t.Optional(t.String({ maxLength: 64 })) }),
};
export async function convertKind(context: { user: { id: string }; params: { id: string }; body: KindEdit }, preview: boolean, transaction?: ActionTx, deferredIndex?: string[]) {
  const { user, params, body } = context;
  const [type] = await (transaction ?? db).select().from(noteTypes).where(and(eq(noteTypes.id, params.id), eq(noteTypes.userId, user.id)));
  if (!type || type.isBuiltin) return reply(404, { error: 'not_found' });
  if (body.kind === type.kind) return reply(400, { error: 'kind_unchanged' });
  const fields = identifiedFields(type.id, type.fields, type.kind);
  if (body.kind === 'typein' && !fields.some((field) => field.id === body.answerFieldId)) return reply(400, { error: 'invalid_typein_answer' });
  return editNoteType({ ...context, body: { kind: body.kind, expectedUpdatedAt: body.expectedUpdatedAt,
    confirmationToken: body.confirmationToken, preview,
    ...(body.kind === 'typein' ? { fields: fields.map((field) => ({ ...field, typeinAnswer: field.id === body.answerFieldId })) } : {}),
  } }, true, transaction, deferredIndex);
}

export const noteTypeCreateBody = t.Object({
        name: t.String({ minLength: 1, maxLength: 128 }),
        fields: t.Array(noteFieldSchema, { minItems: 1, maxItems: 64 }),
        templates: t.Array(cardTemplateSchema, { minItems: 1, maxItems: 32 }),
        styling: t.Optional(t.String({ maxLength: 32768 })),
        kind: t.Optional(renderKindSchema),
      });

export async function createNoteTypeForRequest({ user, body }: { user: { id: string }; body: typeof noteTypeCreateBody.static }, transaction?: ActionTx) {
      const status = reply;
      const err = validateOrdinals(body.fields, body.templates);
      if (err) return status(400, { error: err });
      if (!validFieldNames(body.fields)) return status(400, { error: 'invalid_field_names' });
      if (body.fields.filter((field) => field.typeinAnswer).length > 1) return status(400, { error: 'invalid_typein_answer' });
      const fields = identifiedFields('', body.fields.map((field) => ({ ...field, name: field.name.trim().normalize('NFC'), id: newUuidV7() })), body.kind);
      const templates = body.templates.map((template) => ({ ...template, id: newUuidV7(),
        frontTemplate: renameTemplateFields(template.frontTemplate, new Map()), backTemplate: renameTemplateFields(template.backTemplate, new Map()) }));
      const issues = validateTemplates(fields, templates);
      if (issues.length) return status(400, { error: 'invalid_template', issues });
      const [created] = await (transaction ?? db)
        .insert(noteTypes)
        .values({
          userId: user.id,
          name: body.name,
          fields,
          templates,
          styling: body.styling ?? '',
          kind: body.kind ?? 'custom',
          isBuiltin: false,
        })
        .returning();
      return created;
}

export const noteTypesModule = new Elysia({ prefix: '/note-types' })
  .use(authPlugin)
  // Owned rows + global builtins.
  .get(
    '/',
    async ({ user }) => {
      const rows = await db
        .select()
        .from(noteTypes)
        .where(or(eq(noteTypes.userId, user.id), isNull(noteTypes.userId)));
      return rows.map((row) => ({ ...row, fields: identifiedFields(row.id, row.fields, row.kind), templates: identifiedTemplates(row.id, row.templates) }));
    },
    { auth: true },
  )
  .post('/', createNoteTypeForRequest, { auth: true, body: noteTypeCreateBody })
  .post('/:id/kind/preview', (context) => convertKind(context, true), kindEditOptions)
  .post('/:id/kind', (context) => convertKind(context, false), kindEditOptions)
  .patch('/:id', (context) => editNoteType(context), noteTypeEditOptions)
  .post('/:id/preview', (context) => editNoteType({ ...context, body: { ...context.body, preview: true } }), noteTypeEditOptions)
  .get('/:id/delete-preview', ({ user, params, set }) => {
    set.headers['cache-control'] = 'no-store';
    return removeNoteType(user.id, params.id, true);
  },
    { auth: true, params: t.Object({ id: t.String({ format: 'uuid' }) }) })
  .delete('/:id', ({ user, params, body }) => removeNoteType(user.id, params.id, false, body?.confirmationToken), {
    auth: true, params: t.Object({ id: t.String({ format: 'uuid' }) }),
    body: t.Optional(t.Object({ confirmationToken: t.String({ minLength: 64, maxLength: 64 }) })),
  });
