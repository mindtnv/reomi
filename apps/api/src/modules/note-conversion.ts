import { Elysia, t, status } from 'elysia';
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import { cards, db, decks, notes, noteTypes } from '@reomi/db';
import { ClozeSyntaxError, NoteContentError, generateCards, isLegacyClozeCard, typedAnswerField,
  type FieldValues, type NoteConversionInput, type NoteConversionPreview } from '@reomi/shared';
import type { Logger } from 'pino';
import { requestLogFromContext } from '../logger';
import { authPlugin } from '../auth-plugin';
import { defFromRow } from './note-types';
import { applyRegeneration, loadRegenerationCards, planRegeneration, regenerationImpact, regenerationToken, type RegenerationPlan } from './card-regeneration';
import { enqueueCardsForIndex } from './notes';
import { enrichCards } from './cards';

const MAX_NOTES = 200;
const MAX_CARDS = 2000;
class ConversionError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409 = 400) { super(code); }
}
const body = t.Object({
  newCardsDeckId: t.Optional(t.String({ format: 'uuid' })),
  noteIds: t.Array(t.String({ format: 'uuid' }), { minItems: 1, maxItems: MAX_NOTES, uniqueItems: true }),
  sourceTypeId: t.String({ format: 'uuid' }), targetTypeId: t.String({ format: 'uuid' }),
  sourceVersion: t.String({ format: 'date-time' }), targetVersion: t.String({ format: 'date-time' }),
  fieldMap: t.Record(t.String({ maxLength: 128 }), t.Union([t.String({ maxLength: 128 }), t.Null()]), { maxProperties: 64 }),
  templateMap: t.Record(t.String({ maxLength: 128 }), t.Union([t.String({ maxLength: 128 }), t.Null()]), { maxProperties: 32 }),
  preserveUnmappedFields: t.Boolean(), confirmationToken: t.Optional(t.String({ maxLength: 64 })),
});

async function convert(userId: string, input: NoteConversionInput, previewOnly: boolean, log: Logger) {
  if (input.sourceTypeId === input.targetTypeId) throw new ConversionError('conversion_same_type');
  const result = await db.transaction(async (tx) => {
    // Stable type -> note -> card lock order, shared with ordinary note writes.
    const types = await tx.select().from(noteTypes).where(and(inArray(noteTypes.id, [input.sourceTypeId, input.targetTypeId]),
      or(eq(noteTypes.userId, userId), isNull(noteTypes.userId)))).orderBy(asc(noteTypes.id)).for('share');
    const source = types.find((type) => type.id === input.sourceTypeId);
    const target = types.find((type) => type.id === input.targetTypeId);
    if (!source || !target) throw new ConversionError('not_found', 404);
    if (source.updatedAt.getTime() !== new Date(input.sourceVersion).getTime() || target.updatedAt.getTime() !== new Date(input.targetVersion).getTime()) throw new ConversionError('note_type_changed', 409);
    const [newDeck] = input.newCardsDeckId ? await tx.select({ id: decks.id, name: decks.name }).from(decks).where(and(eq(decks.userId, userId), eq(decks.id, input.newCardsDeckId))) : [];
    if (input.newCardsDeckId && !newDeck) throw new ConversionError('not_found', 404);
    const sourceDef = defFromRow(source); const targetDef = defFromRow(target);
    const selected = await tx.select().from(notes).where(and(eq(notes.userId, userId), inArray(notes.id, input.noteIds)))
      .orderBy(asc(notes.id)).for('update');
    if (selected.length !== input.noteIds.length) throw new ConversionError('not_found', 404);
    if (selected.some((note) => note.noteTypeId !== source.id)) throw new ConversionError('conversion_source_changed', 409);
    const sourceNames = new Set([...sourceDef.fields.map((field) => field.name), ...selected.flatMap((note) => Object.keys(note.fieldValues))]);
    if (Object.keys(input.fieldMap).length !== targetDef.fields.length || targetDef.fields.some((field) => !Object.hasOwn(input.fieldMap, field.name)) ||
      Object.entries(input.fieldMap).some(([name, from]) => !targetDef.fields.some((field) => field.name === name) || from !== null && !sourceNames.has(from))) throw new ConversionError('invalid_field_mapping');
    if (Object.keys(input.templateMap).length !== targetDef.templates.length || targetDef.templates.some((template) => !Object.hasOwn(input.templateMap, template.id!)) ||
      Object.entries(input.templateMap).some(([id, from]) => !targetDef.templates.some((template) => template.id === id) || from !== null && !sourceDef.templates.some((template) => template.id === from))) throw new ConversionError('invalid_template_mapping');
    const mappedTemplates = Object.values(input.templateMap).filter((id): id is string => id !== null);
    if (new Set(mappedTemplates).size !== mappedTemplates.length) throw new ConversionError('duplicate_template_mapping');
    const compatibleMode = source.kind === target.kind || ['basic', 'custom'].includes(source.kind) && ['basic', 'custom'].includes(target.kind);
    const compatibleAnswer = source.kind !== 'typein' || input.fieldMap[typedAnswerField(targetDef.fields)?.name ?? ''] === typedAnswerField(sourceDef.fields)?.name;
    const discardAlternatives = target.kind === 'typein' && !(source.kind === 'typein' && compatibleAnswer);
    if (mappedTemplates.length && (!compatibleMode || !compatibleAnswer)) throw new ConversionError('incompatible_card_mapping');
    const ordMap = new Map(sourceDef.templates.flatMap((old) => {
      const next = targetDef.templates.find((template) => input.templateMap[template.id!] === old.id);
      return next ? [[old.ord, next.ord] as const] : [];
    }));
    const cardIds = await tx.select({ id: cards.id }).from(cards).where(and(eq(cards.userId, userId), inArray(cards.noteId, input.noteIds))).limit(MAX_CARDS + 1);
    if (cardIds.length > MAX_CARDS) throw new ConversionError('conversion_too_many_cards');
    const existing = await loadRegenerationCards(tx, userId, input.noteIds);
    const byNote = new Map<string, typeof existing>();
    for (const card of existing) { const list = byNote.get(card.noteId) ?? []; list.push(card); byNote.set(card.noteId, list); }
    const plans = new Map<string, RegenerationPlan>();
    const valuesByNote = new Map<string, FieldValues>();
    const fieldImpact = new Map<string, { field: string; action: 'preserve' | 'discard'; nonemptyNotes: number; example: string }>();
    const used = new Set(Object.values(input.fieldMap).filter((name): name is string => name !== null));
    const validation: NonNullable<NoteConversionPreview['validation']> = { checkedNotes: selected.length, invalidNotes: 0, samples: [] };
    for (const note of selected) {
      const extras = Object.entries(note.fieldValues).filter(([name]) => !used.has(name));
      for (const [field, value] of extras) {
        const item = fieldImpact.get(field) ?? { field, action: input.preserveUnmappedFields ? 'preserve' : 'discard', nonemptyNotes: 0, example: '' };
        if (value.trim()) { item.nonemptyNotes++; item.example ||= value.slice(0, 160); }
        fieldImpact.set(field, item);
      }
      const entries = targetDef.fields.map((field) => { const from = input.fieldMap[field.name]; return [field.name, from && Object.hasOwn(note.fieldValues, from) ? note.fieldValues[from] : ''] as const; });
      if (input.preserveUnmappedFields && extras.some(([name, value]) => entries.some(([to, mapped]) => to === name && value !== mapped))) throw new ConversionError('conversion_field_collision');
      const values = Object.fromEntries([...(input.preserveUnmappedFields ? extras : []), ...entries]);
      if (Object.keys(values).length > 64) throw new ConversionError('conversion_too_many_fields');
      valuesByNote.set(note.id, values);
      const prior = byNote.get(note.id) ?? [];
      let generated: ReturnType<typeof generateCards> = []; let error: string | undefined;
      try { generated = generateCards(targetDef, values, { legacyCloze: target.kind === 'cloze' && prior.some(isLegacyClozeCard) }); }
      catch (err) { if (err instanceof NoteContentError) error = err.code; else if (err instanceof ClozeSyntaxError) error = 'invalid_cloze'; else throw err; }
      if (!generated.length) error ??= 'no_cards_generated';
      const plan = planRegeneration(prior, generated, ordMap);
      if (plan.create.length && !newDeck && new Set(prior.map((card) => card.deckId)).size !== 1) error ??= 'conversion_deck_required';
      plans.set(note.id, plan);
      if (error) validation.invalidNotes++;
      const sample = { front: prior[0]?.renderFrontText.slice(0, 160) ?? '', questions: generated.slice(0, 5).map((card) => card.renderFrontText.slice(0, 160)), answers: generated.slice(0, 5).map((card) => card.renderBackText.slice(0, 160)),
        omittedTemplates: targetDef.templates.filter((template) => !generated.some((card) => card.templateOrd === template.ord)).map((template) => template.name), ...(error ? { error } : {}) };
      if (validation.samples.length < 5) validation.samples.push(sample);
      else if (error) { const i = validation.samples.findIndex((item) => !item.error); if (i >= 0) validation.samples[i] = sample; }
    }
    if ([...plans.values()].reduce((sum, plan) => sum + plan.keep.length + plan.create.length, 0) > MAX_CARDS) throw new ConversionError('conversion_too_many_cards');
    const fields = [...fieldImpact.values()].sort((a, b) => a.field.localeCompare(b.field));
    const preview: NoteConversionPreview = { impact: regenerationImpact([...plans.values()]), validation,
      ...(newDeck ? { newCardsDeckId: newDeck.id, newCardsDeckName: newDeck.name } : {}),
      sourceVersion: source.updatedAt.toISOString(), targetVersion: target.updatedAt.toISOString(), noteCount: selected.length,
      cardMapping: targetDef.templates.map((template) => {
        const prior = sourceDef.templates.find((old) => old.id === input.templateMap[template.id!]);
        return { target: { name: template.name, ord: template.ord }, source: prior ? { name: prior.name, ord: prior.ord } : null };
      }),
      fieldMapping: targetDef.fields.map((field) => ({ target: field.name, source: input.fieldMap[field.name] })),
      unmappedFields: fields.slice(0, 50), unmappedFieldCount: fields.length,
      discardedAlternatives: discardAlternatives ? selected.reduce((sum, note) => sum + note.acceptedAnswers.length, 0) : 0,
      discardedValues: fields.filter((field) => field.action === 'discard').reduce((sum, field) => sum + field.nonemptyNotes, 0),
      confirmationToken: regenerationToken({ userId, input: { ...input, confirmationToken: undefined }, source, target, newDeck, notes: selected, cards: existing }),
    };
    if (previewOnly) return { preview };
    if (validation.invalidNotes) throw new ConversionError('conversion_invalid_notes');
    if (input.confirmationToken !== preview.confirmationToken) throw new ConversionError(input.confirmationToken ? 'preview_changed' : 'conversion_confirmation_required', 409);
    const indexIds: string[] = [];
    for (const note of selected) {
      const now = new Date(Math.max(Date.now(), note.updatedAt.getTime() + 1));
      await tx.update(notes).set({ noteTypeId: target.id, fieldValues: valuesByNote.get(note.id)!, acceptedAnswers: discardAlternatives ? [] : note.acceptedAnswers, updatedAt: now })
        .where(and(eq(notes.id, note.id), eq(notes.userId, userId)));
      indexIds.push(...await applyRegeneration(tx, { userId, noteId: note.id, plan: plans.get(note.id)!, deckId: newDeck?.id ?? byNote.get(note.id)?.[0]?.deckId, now }));
    }
    const finalCards = await tx.select().from(cards).where(and(eq(cards.userId, userId), inArray(cards.noteId, input.noteIds)));
    return { cards: await enrichCards(finalCards, tx), indexIds, noteIds: input.noteIds };
  });
  if ('preview' in result) return result.preview;
  enqueueCardsForIndex(result.indexIds, log);
  log.info({ notesConverted: result.noteIds.length, cardsAfter: result.cards.length }, 'note.convert');
  return { noteIds: result.noteIds, cards: result.cards };
}
async function handle(userId: string, input: NoteConversionInput, preview: boolean, log: Logger) {
  try { return await convert(userId, input, preview, log); }
  catch (error) { if (error instanceof ConversionError) return status(error.status, { error: error.code }); throw error; }
}
export const noteConversionModule = new Elysia({ prefix: '/notes' }).use(authPlugin)
  .post('/convert/preview', (context) => handle(context.user.id, context.body, true, requestLogFromContext(context)), { auth: true, body })
  .post('/convert', (context) => handle(context.user.id, context.body, false, requestLogFromContext(context)), { auth: true, body });
