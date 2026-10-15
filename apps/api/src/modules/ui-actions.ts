import { Elysia, t } from 'elysia';
import { db, decks } from '@reomi/db';
import { eq, sql } from 'drizzle-orm';
import { newUuidV7, DECK_COLORS, NOTE_TITLE_MAX, NOTE_CONTENT_MAX, NOTEBOOK_TITLE_MAX } from '@reomi/shared';
import { authPlugin } from '../auth-plugin';
import { createStudyNote } from './study-notes';
import { getUiAction, listUiActions, performUiAction } from './ui-action-receipts';
import { editDeckAction, editNotebookAction, editSourceAction, editStudyNoteAction, hierarchyRevision, moveDeckInTransaction, undoUiAction } from './ui-action-mutations';

const id = t.String({ format: 'uuid' });
const envelope = { requestId: id, sessionId: id };
const revision = t.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const owner = t.Object({ kind: t.Union([t.Literal('source'), t.Literal('notebook')]), id });
const notePatch = t.Object({ title: t.Optional(t.String({ minLength: 1, maxLength: NOTE_TITLE_MAX })),
  content: t.Optional(t.String({ maxLength: NOTE_CONTENT_MAX })), pinned: t.Optional(t.Boolean()) }, { additionalProperties: false });

export const uiActionsModule = new Elysia({ prefix: '/ui-actions/v1' }).use(authPlugin)
  .post('/session', () => ({ sessionId: newUuidV7(), serverTime: new Date().toISOString() }), { auth: true })
  .get('', ({ user, query }) => listUiActions(user.id, query.sessionId, query.cursor), { auth: true,
    query: t.Object({ sessionId: id, cursor: t.Optional(id) }) })
  .get('/receipts/:requestId', ({ user, params }) => getUiAction(user.id, params.requestId), { auth: true, params: t.Object({ requestId: id }) })
  .post('/receipts/:id/undo', ({ user, params }) => undoUiAction(user.id, params.id), { auth: true, params: t.Object({ id }) })
  .post('/study-notes', ({ user, body }) => performUiAction(user.id, body, 'study-note-create', { owner: body.owner, input: body.input }, async tx => {
    const row = await createStudyNote(user.id, body.owner, body.input, tx);
    return { target: { kind: 'study-note', id: row.id, revision: String(row.metadataRevision) }, label: row.title, result: row };
  }), { auth: true, body: t.Object({ ...envelope, owner, input: t.Object({
    title: t.String({ minLength: 1, maxLength: NOTE_TITLE_MAX }), content: t.String({ maxLength: NOTE_CONTENT_MAX }),
    kind: t.Optional(t.Union([t.Literal('manual'), t.Literal('answer')])), citations: t.Optional(t.Unknown()), messageId: t.Optional(id),
  }, { additionalProperties: false }) }) })
  .patch('/study-notes/:id', ({ user, params, body }) => performUiAction(user.id, body,
    Object.keys(body.patch).length === 1 && body.patch.pinned !== undefined ? 'study-note-pin' : 'study-note-edit',
    { id: params.id, patch: body.patch, expectedRevision: body.expectedRevision },
    tx => editStudyNoteAction(tx, user.id, params.id, body.expectedRevision, body.patch)), { auth: true, params: t.Object({ id }),
    body: t.Object({ ...envelope, expectedRevision: revision, patch: notePatch }) })
  .patch('/sources/:id', ({ user, params, body }) => performUiAction(user.id, body, 'source-metadata',
    { id: params.id, patch: body.patch, expectedRevision: body.expectedRevision },
    tx => editSourceAction(tx, user.id, params.id, body.expectedRevision, body.patch)), { auth: true, params: t.Object({ id }),
    body: t.Object({ ...envelope, expectedRevision: revision, patch: t.Object({ title: t.Optional(t.String({ minLength: 1, maxLength: 300 })),
      author: t.Optional(t.Union([t.String({ maxLength: 500 }), t.Null()])), description: t.Optional(t.Union([t.String({ maxLength: 2000 }), t.Null()])),
      tags: t.Optional(t.Array(t.String({ maxLength: 64 }), { maxItems: 32 })),
    }, { additionalProperties: false }) }) })
  .patch('/notebooks/:id', ({ user, params, body }) => performUiAction(user.id, body, 'notebook-title',
    { id: params.id, patch: body.patch, expectedRevision: body.expectedRevision },
    tx => editNotebookAction(tx, user.id, params.id, body.expectedRevision, body.patch.title)), { auth: true, params: t.Object({ id }),
    body: t.Object({ ...envelope, expectedRevision: revision, patch: t.Object({ title: t.String({ minLength: 1, maxLength: NOTEBOOK_TITLE_MAX }) }, { additionalProperties: false }) }) })
  .patch('/decks/:id', ({ user, params, body }) => performUiAction(user.id, body, 'deck-metadata',
    { id: params.id, patch: body.patch, expectedRevision: body.expectedRevision },
    tx => editDeckAction(tx, user.id, params.id, body.expectedRevision, body.patch)), { auth: true, params: t.Object({ id }),
    body: t.Object({ ...envelope, expectedRevision: revision, patch: t.Object({ name: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
      color: t.Optional(t.Union(DECK_COLORS.map(color => t.Literal(color)))), icon: t.Optional(t.Union([t.String({ maxLength: 100 }), t.Null()])),
    }, { additionalProperties: false }) }) })
  .get('/deck-hierarchy', ({ user }) => db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${user.id}, 73))`);
    return { revision: await hierarchyRevision(tx, user.id), decks: await tx.select().from(decks).where(eq(decks.userId, user.id)) };
  }), { auth: true })
  .post('/decks/:id/move', ({ user, params, body }) => performUiAction(user.id, body, 'deck-move',
    { id: params.id, placement: body.placement, targetId: body.targetId, expectedRevision: body.expectedRevision },
    tx => moveDeckInTransaction(tx, user.id, params.id, body, body.expectedRevision)), { auth: true, params: t.Object({ id }),
    body: t.Object({ ...envelope, expectedRevision: revision, targetId: t.Union([id, t.Null()]),
      placement: t.Union([t.Literal('before'), t.Literal('after'), t.Literal('inside')]),
    }) });
