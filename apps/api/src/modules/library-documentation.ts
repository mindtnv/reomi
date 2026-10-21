import { Elysia, t } from 'elysia';
import { authPlugin } from '../auth-plugin';
import { interruptDocumentationFetch, wakeDocumentationWorker } from '../ai/library-documentation-worker';
import { cancelDocumentation, confirmDocumentation, disconnectDocumentation, documentationPageErrors, documentationSummary, listDocumentation, previewDocumentation, updateDocumentation } from './library-documentation-service';

const params = t.Object({ id: t.String({ format: 'uuid' }) });
export const libraryDocumentationModule = new Elysia({ prefix: '/library/documentation' }).use(authPlugin)
  .get('/', ({ user }) => listDocumentation(user.id), { auth: true })
  .post('/preview', ({ user, body }) => previewDocumentation(user.id, body.url, body.locale), {
    auth: true, body: t.Object({ url: t.String({ minLength: 1, maxLength: 2000 }), locale: t.Union([t.Literal('en'), t.Literal('ru')]) }),
  })
  .get('/:id', ({ user, params }) => documentationSummary(user.id, params.id), { auth: true, params })
  .get('/:id/errors', ({ user, params }) => documentationPageErrors(user.id, params.id), { auth: true, params })
  .post('/:id/confirm', async ({ user, params, body }) => {
    const result = await confirmDocumentation(user.id, params.id, body.title, body.prefixes); wakeDocumentationWorker(); return result;
  }, { auth: true, params, body: t.Object({ title: t.String({ minLength: 1, maxLength: 100 }), prefixes: t.Array(t.String({ minLength: 1, maxLength: 2000 }), { minItems: 1, maxItems: 1000 }) }) })
  .post('/:id/updates', async ({ user, params }) => {
    const result = await updateDocumentation(user.id, params.id); wakeDocumentationWorker(); return result;
  }, { auth: true, params })
  .post('/:id/cancel', async ({ user, params }) => {
    const result = await cancelDocumentation(user.id, params.id); interruptDocumentationFetch(params.id); return result;
  }, { auth: true, params })
  .delete('/:id', async ({ user, params }) => {
    const result = await disconnectDocumentation(user.id, params.id); interruptDocumentationFetch(params.id); return result;
  }, { auth: true, params });
