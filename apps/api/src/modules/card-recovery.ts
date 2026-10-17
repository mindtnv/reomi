import { Elysia, ElysiaCustomStatusResponse, t } from 'elysia';
import { noteTypes } from '@reomi/db';
import { eq } from 'drizzle-orm';
import type { UiActionEnvelope } from '@reomi/shared';
import { authPlugin } from '../auth-plugin';
import { requestLogFromContext } from '../logger';
import { createNoteForRequest, editNote, enqueueCardsForIndex, noteCreateBody, noteEditOptions } from './notes';
import { withUserRevisionLock } from './note-revisions';
import { convertKind, createNoteTypeForRequest, editNoteType, kindEditOptions, noteTypeCreateBody, noteTypeEditOptions } from './note-types';
import { ActionDomainError, performUiAction, type ActionMutation, type ActionTx } from './ui-action-receipts';
import { StudyError } from './study-notes';

const id = t.String({ format: 'uuid' });
const date = t.String({ format: 'date-time' });
const envelope = { requestId: id, sessionId: id };

function unwrap<T>(value: T): Exclude<T, ElysiaCustomStatusResponse<any, any>> {
  if (value instanceof ElysiaCustomStatusResponse) throw new ActionDomainError(value.code as 400 | 404 | 409 | 413 | 503, value.response);
  return value as Exclude<T, ElysiaCustomStatusResponse<any, any>>;
}
async function noteMutation(tx: ActionTx, result: Awaited<ReturnType<typeof createNoteForRequest>> | Awaited<ReturnType<typeof editNote>>): Promise<ActionMutation> {
  const value = unwrap(result);
  if ('impact' in value) throw new StudyError(400, 'preview_requires_read_route');
  const [type] = await tx.select({ updatedAt: noteTypes.updatedAt }).from(noteTypes).where(eq(noteTypes.id, value.note.noteTypeId));
  if (!type) throw new StudyError(409, 'note_type_changed');
  return { result: value, label: 'Card', target: { kind: 'card-note', id: value.note.id,
    revision: `${value.note.updatedAt.toISOString()}_${type.updatedAt.toISOString()}` } };
}
function typeMutation(result: Awaited<ReturnType<typeof editNoteType>> | Awaited<ReturnType<typeof createNoteTypeForRequest>> | Awaited<ReturnType<typeof convertKind>>): ActionMutation {
  const row = unwrap(result);
  if ('impact' in row) throw new StudyError(400, 'preview_requires_read_route');
  return { result: row, label: row.name, target: { kind: 'note-type', id: row.id, revision: row.updatedAt.toISOString() } };
}
async function recover(context: { user: { id: string }; body: UiActionEnvelope & { input: unknown } }, kind: 'card-note-save' | 'note-type-save',
  targetId: string | null, mutate: (tx: ActionTx, indexIds: string[]) => Promise<ActionMutation>,
) {
  const indexIds: string[] = [];
  const result = await performUiAction(context.user.id, context.body, kind, { targetId, input: context.body.input }, tx => mutate(tx, indexIds));
  if (!result.replayed && indexIds.length) enqueueCardsForIndex(indexIds, requestLogFromContext(context));
  return result;
}

/** Separate URLs fail closed against an old API; all domain checks stay shared. */
export const cardRecoveryModule = new Elysia({ prefix: '/ui-actions/v1' }).use(authPlugin)
  .post('/card-notes', context => recover(context, 'card-note-save', null, async (tx, ids) =>
    noteMutation(tx, await createNoteForRequest({ ...context, body: context.body.input }, tx, ids))), {
    auth: true, body: t.Object({ ...envelope, input: t.Object({ ...noteCreateBody.properties, expectedTypeUpdatedAt: date }) }),
  })
  .patch('/card-notes/:id', context => recover(context, 'card-note-save', context.params.id, async (tx, ids) => {
    if (context.body.input.preview) throw new StudyError(400, 'preview_requires_read_route');
    await withUserRevisionLock(tx, context.user.id);
    return noteMutation(tx, await editNote({ ...context, body: context.body.input }, tx, ids));
  }), { auth: true, params: t.Object({ id }), body: t.Object({ ...envelope,
    input: t.Object({ ...noteEditOptions.body.properties, expectedUpdatedAt: date, expectedTypeUpdatedAt: date }),
  }) })
  .post('/note-types', context => recover(context, 'note-type-save', null, async tx =>
    typeMutation(await createNoteTypeForRequest({ ...context, body: context.body.input }, tx))), {
    auth: true, body: t.Object({ ...envelope, input: noteTypeCreateBody }),
  })
  .patch('/note-types/:id', context => recover(context, 'note-type-save', context.params.id, async (tx, ids) => {
    if (context.body.input.preview) throw new StudyError(400, 'preview_requires_read_route');
    return typeMutation(await editNoteType({ ...context, body: context.body.input }, false, tx, ids));
  }), { auth: true, params: t.Object({ id }), body: t.Object({ ...envelope,
    input: t.Object({ ...noteTypeEditOptions.body.properties, expectedUpdatedAt: date }),
  }) })
  .post('/note-types/:id/kind', context => recover(context, 'note-type-save', context.params.id, async (tx, ids) =>
    typeMutation(await convertKind({ ...context, body: context.body.input }, false, tx, ids))), {
    auth: true, params: t.Object({ id }), body: t.Object({ ...envelope, input: kindEditOptions.body }),
  });
