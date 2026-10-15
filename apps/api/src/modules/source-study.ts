import { Elysia, t } from 'elysia';
import { NOTE_CONTENT_MAX, NOTE_TITLE_MAX, QUIZ_QUESTIONS_MAX } from '@reomi/shared';
import { authPlugin } from '../auth-plugin';
import { createStudyNote, deleteStudyNote, getStudyNote, listStudyNotes, patchStudyNote } from './study-notes';
import { createSourceArtifact, deleteSourceArtifact, getSourceArtifact, listSourceArtifacts, regenerateSourceArtifact } from './study-artifacts';
import { requestLogFromContext } from '../logger';
import { submitStudyQuizAttempt, listStudyQuizAttempts } from './study-quiz';
const id = t.String({ format: 'uuid' });
const notePatch = t.Object({ title: t.Optional(t.String({ maxLength: NOTE_TITLE_MAX + 1 })), content: t.Optional(t.String({ maxLength: NOTE_CONTENT_MAX + 1 })), pinned: t.Optional(t.Boolean()) });
const listQuery = t.Object({ limit: t.Optional(t.Numeric({ minimum: 1, maximum: 50, multipleOf: 1 })), q: t.Optional(t.String({ maxLength: 200 })), offset: t.Optional(t.Numeric({ minimum: 0, maximum: 100_000 })), unavailable: t.Optional(t.String({ enum: ['true', 'false'] })) });
export const sourceStudyModule = new Elysia().use(authPlugin)
  .get('/sources/:id/notes', ({ user, params, query }) => listStudyNotes(user.id, { kind: 'source', id: params.id }, query), { auth: true, params: t.Object({ id }), query: t.Object({ limit: t.Optional(t.Numeric({ minimum: 1, maximum: 50, multipleOf: 1 })), q: t.Optional(t.String({ maxLength: 200 })), offset: t.Optional(t.Numeric({ minimum: 0, maximum: 100_000 })) }) })
  .post('/sources/:id/notes', ({ user, params, body }) => createStudyNote(user.id, { kind: 'source', id: params.id }, body), { auth: true, params: t.Object({ id }), body: t.Object({ title: t.String({ minLength: 1, maxLength: NOTE_TITLE_MAX + 1 }), content: t.String({ maxLength: NOTE_CONTENT_MAX + 1 }), kind: t.Optional(t.String({ maxLength: 16 })), citations: t.Optional(t.Unknown()), messageId: t.Optional(id) }) })
  .patch('/sources/:id/notes/:noteId', ({ user, params, body }) => patchStudyNote(user.id, params.noteId, body, { kind: 'source', id: params.id }), { auth: true, params: t.Object({ id, noteId: id }), body: notePatch })
  .delete('/sources/:id/notes/:noteId', ({ user, params }) => deleteStudyNote(user.id, params.noteId, { kind: 'source', id: params.id }), { auth: true, params: t.Object({ id, noteId: id }) })
  .get('/study/notes', ({ user, query }) => listStudyNotes(user.id, undefined, { ...query, unavailable: query.unavailable === 'true' }), { auth: true, query: listQuery })
  .get('/study/notes/:noteId', ({ user, params }) => getStudyNote(user.id, params.noteId), { auth: true, params: t.Object({ noteId: id }) })
  .patch('/study/notes/:noteId', ({ user, params, body }) => patchStudyNote(user.id, params.noteId, body), { auth: true, params: t.Object({ noteId: id }), body: notePatch })
  .delete('/study/notes/:noteId', ({ user, params }) => deleteStudyNote(user.id, params.noteId), { auth: true, params: t.Object({ noteId: id }) })
  .get('/sources/:id/artifacts', ({ user, params, query }) => listSourceArtifacts(user.id, params.id, false, query.offset, query.limit), { auth: true, params: t.Object({ id }), query: listQuery })
  .post('/sources/:id/artifacts', context => createSourceArtifact(context.user.id, context.params.id, context.body, requestLogFromContext(context)), { auth: true, params: t.Object({ id }), body: t.Object({ type: t.String({ maxLength: 32 }), questionCount: t.Optional(t.Integer({ minimum: 1, maximum: QUIZ_QUESTIONS_MAX })) }) })
  .get('/study/artifacts', ({ user, query }) => listSourceArtifacts(user.id, undefined, query.unavailable === 'true', query.offset, query.limit), { auth: true, query: listQuery })
  .get('/study/artifacts/:artifactId', ({ user, params }) => getSourceArtifact(user.id, params.artifactId), { auth: true, params: t.Object({ artifactId: id }) })
  .post('/study/artifacts/:artifactId/regenerate', context => regenerateSourceArtifact(context.user.id, context.params.artifactId, requestLogFromContext(context)), { auth: true, params: t.Object({ artifactId: id }) })
  .delete('/study/artifacts/:artifactId', ({ user, params }) => deleteSourceArtifact(user.id, params.artifactId), { auth: true, params: t.Object({ artifactId: id }) })
  .post('/study/artifacts/:artifactId/attempts', ({ user, params, body }) => submitStudyQuizAttempt(user.id, params.artifactId, body.answers), {
    auth: true, params: t.Object({ artifactId: id }), body: t.Object({ answers: t.Array(t.Object({ questionId: id,
      answer: t.Union([t.Number(), t.Boolean(), t.Object({ selfCorrect: t.Boolean() })]) }), { maxItems: QUIZ_QUESTIONS_MAX }) }),
  })
  .get('/study/artifacts/:artifactId/attempts', ({ user, params }) => listStudyQuizAttempts(user.id, params.artifactId), { auth: true, params: t.Object({ artifactId: id }) });
