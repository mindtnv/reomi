import { Elysia, ElysiaCustomStatusResponse } from 'elysia';
import { cors } from '@elysiajs/cors';
import { swagger } from '@elysiajs/swagger';
import { env } from './env.ts';
import { dbPing } from '@reomi/db';
import { authPlugin } from './auth-plugin.ts';
import { decksModule } from './modules/decks.ts';
import { deckOptionsModule } from './modules/deck-options.ts';
import { filteredDecksModule } from './modules/filtered-decks.ts';
import { cardsModule } from './modules/cards.ts';
import { noteTypesModule } from './modules/note-types.ts';
import { notesModule } from './modules/notes.ts';
import { noteConversionModule } from './modules/note-conversion';
import { ClozeSyntaxError, NoteContentError } from '@reomi/shared';
import { NoteWriteConflict } from './modules/card-regeneration';
import { reviewsModule } from './modules/reviews.ts';
import { statsModule } from './modules/stats.ts';
import { profileModule } from './modules/profile.ts';
import { mediaModule } from './modules/media.ts';
import { aiModule, chatModule, contextualChatModule } from './modules/ai.ts';
import { cardsSimilarModule, graphModule } from './modules/semantic.ts';
import { notebooksModule, sourcesModule } from './modules/notebooks.ts';
import { topicPlanRoutes } from './modules/topic-plan.ts';
import { sourceStudyModule } from './modules/source-study.ts';
import { sourceTextMarksModule } from './modules/source-text-marks.ts';
import { StudyError } from './modules/study-notes.ts';
import { libraryModule } from './modules/library.ts';
import { operationsModule } from './modules/operations';
import { uiActionsModule } from './modules/ui-actions';
import { cardRecoveryModule } from './modules/card-recovery';
import { remindersModule } from './modules/reminders';
import { ActionDomainError } from './modules/ui-action-receipts';
import { personalTokensModule } from './modules/personal-tokens.ts';
import { handleMcp } from './mcp/server.ts';
import { AUTH_RATE_RULES, clientIpFromRequest, rateLimitCheck } from './rate-limit.ts';
import { pickRequestId, requestLogger, rootLogger, safeError } from './logger.ts';
import type { Logger } from 'pino';
import { embeddingDegraded } from './ai/index-queue.ts';
import {
  artifactWorkerState,
  indexWorkerState,
  lifecycleSnapshot,
  reminderWorkerState,
  sourceIngestWorkerState,
} from './runtime-state.ts';

export interface BuildAppOptions {
  logger?: Logger;
  pingDb?: typeof dbPing;
  embeddingIsDegraded?: () => boolean;
}

interface RequestLifecycleState {
  errorStatus?: number;
}

/**
 * Build the full Elysia app (no .listen). Separating this from the binding
 * lets tests call `app.handle(req)` directly against an in-process instance.
 */
export function buildApp(options: BuildAppOptions = {}) {
  const baseLogger = options.logger ?? rootLogger;
  const pingDb = options.pingDb ?? dbPing;
  const embeddingIsDegraded = options.embeddingIsDegraded ?? embeddingDegraded;
  let readHandle: (request: Request) => Promise<Response>;
  // Global request body ceiling (DoS hardening): cap any single request body at
  // 2 MiB. `serve.maxRequestBodySize` is the Bun.serve option Elysia forwards
  // (Elysia 1.4 `ElysiaConfig.serve: Partial<Serve>` → Bun `Serve.Options`).
  const app = new Elysia({ serve: { maxRequestBodySize: 2 * 1024 * 1024 } })
    .use(
      cors({
        origin: env.WEB_ORIGIN,
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'x-request-id', 'mcp-protocol-version'],
        exposeHeaders: ['x-request-id'],
      }),
    )
    .use(swagger({ path: '/docs' }))
    // Per-request derivation, never shared mutable state. Every downstream hook
    // and route receives its own logger/request id even under concurrency.
    .derive({ as: 'global' }, ({ request, set }) => {
      const requestId = pickRequestId(request.headers);
      const url = new URL(request.url);
      const child = requestLogger({
        requestId,
        method: request.method,
        path: url.pathname,
      }, baseLogger);
      set.headers['x-request-id'] = requestId;
      const requestState: RequestLifecycleState = {};
      return {
        log: child,
        requestId,
        requestStartedAt: performance.now(),
        requestState,
      };
    })
    .onAfterHandle({ as: 'global' }, ({ requestState, responseValue }) => {
      if (!requestState) return;
      if (responseValue instanceof ElysiaCustomStatusResponse) {
        requestState.errorStatus = responseValue.code;
      } else if (responseValue instanceof Response) {
        requestState.errorStatus = responseValue.status;
      }
    })
    .onAfterResponse(
      { as: 'global' },
      async ({ log, requestStartedAt, requestState, set, responseValue, route }) => {
      // Elysia maps custom/not-found responses immediately after the handler;
      // one microtask lets `set.status` settle to the final wire status.
      await Bun.sleep(0);
      try {
        const rawStatus = set.status;
        const status =
          requestState.errorStatus ??
          (!route || route === '/*'
            ? 404
            : responseValue instanceof ElysiaCustomStatusResponse
              ? responseValue.code
              : typeof rawStatus === 'number'
                ? rawStatus
                : Number(rawStatus) || 200);
        log.info(
          {
            event: 'http.request.completed',
            matchedRoute: route || undefined,
            status,
            durationMs: Math.max(0, Math.round(performance.now() - requestStartedAt)),
          },
          'http.request.completed',
        );
      } catch {
        // Observability must never change the response path.
      }
      },
    )
    // IP-based rate limiter for the auth surface. Runs before `.mount(auth.handler)`
    // in authPlugin, so any 429 short-circuits BetterAuth entirely.
    .onRequest(({ request, set }) => {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;
      if (method !== 'POST') return;
      const rule =
        path === '/api/auth/sign-in/email'
          ? AUTH_RATE_RULES.signIn
          : path === '/api/auth/sign-up/email'
            ? AUTH_RATE_RULES.signUp
            : path === '/api/auth/forget-password' || path === '/api/auth/forgot-password'
              ? AUTH_RATE_RULES.forgot
              : null;
      if (!rule) return;
      const ip = clientIpFromRequest(request);
      const check = rateLimitCheck(ip, rule);
      if (check.allowed) return;
      const retryS = Math.ceil(check.retryAfterMs / 1000);
      set.status = 429;
      set.headers['retry-after'] = String(retryS);
      return { error: 'rate_limited', retryAfterSeconds: retryS };
    })
    .use(authPlugin)
    .get('/health', async ({ status, log }) => {
      try {
        const ping = await pingDb();
        return { ok: true, now: new Date().toISOString(), db: ping };
      } catch (err) {
        log.error({ err: safeError(err) }, 'health.db_ping_failed');
        return status(503, {
          ok: false,
          now: new Date().toISOString(),
          db: { ok: false, error: 'unavailable' },
        });
      }
    })
    .get('/ready', async ({ status, log }) => {
      const lifecycle = lifecycleSnapshot();
      const workers = {
        index: indexWorkerState.snapshot(),
        sourceIngest: sourceIngestWorkerState.snapshot(),
        artifact: artifactWorkerState.snapshot(),
        reminder: reminderWorkerState.snapshot(),
      };
      let db: { ok: true; latencyMs: number } | { ok: false; error: 'unavailable' };
      try {
        db = await pingDb();
      } catch (err) {
        log.error({ err: safeError(err) }, 'readiness.db_ping_failed');
        db = { ok: false, error: 'unavailable' };
      }

      const degraded: Array<{ code: string; at?: string }> = [];
      if (embeddingIsDegraded()) degraded.push({ code: 'embedding_dimension_mismatch' });
      for (const [name, snapshot] of Object.entries(workers)) {
        if (snapshot.lastFailure) {
          degraded.push({
            code: `${name === 'sourceIngest' ? 'source_ingest' : name}:${snapshot.lastFailure.code}`,
            at: snapshot.lastFailure.at,
          });
        }
      }

      const notReady = !db.ok || lifecycle.state === 'shutting_down';
      const readinessStatus = notReady ? 'not_ready' : degraded.length > 0 ? 'degraded' : 'ready';
      const body = {
        ok: !notReady,
        status: readinessStatus,
        now: new Date().toISOString(),
        db,
        lifecycle,
        workers,
        degraded,
      };
      return notReady ? status(503, body) : body;
    })
    .onError({ as: 'global' }, ({ code, error, status, log, requestState }) => {
      const state = requestState as RequestLifecycleState | undefined;
      const errorLog = log ?? baseLogger;
      if (error instanceof ActionDomainError) {
        if (state) state.errorStatus = error.status;
        return status(error.status, error.payload);
      }
      if (error instanceof StudyError) {
        if (state) state.errorStatus = error.status;
        return status(error.status, { error: error.message });
      }
      if (error instanceof NoteContentError) {
        if (state) state.errorStatus = 400;
        return status(400, { error: error.code });
      }
      if (error instanceof ClozeSyntaxError) {
        if (state) state.errorStatus = 400;
        return status(400, { error: 'invalid_cloze' });
      }
      if (error instanceof NoteWriteConflict) {
        if (state) state.errorStatus = 409;
        return status(409, { error: error.code });
      }
      if (code === 'VALIDATION') {
        if (state) state.errorStatus = 400;
        const issueCount = Array.isArray((error as { all?: unknown[] }).all)
          ? (error as { all: unknown[] }).all.length
          : 1;
        errorLog.warn({ event: 'http.validation.failed', code, issueCount }, 'validation');
        return status(400, { error: 'ValidationError', detail: 'Invalid request' });
      }
      if (code === 'NOT_FOUND') {
        if (state) state.errorStatus = 404;
        return status(404, { error: 'NotFound' });
      }
      if (state) state.errorStatus = 500;
      errorLog.error({ code, err: safeError(error) }, 'unhandled');
      return status(500, { error: 'InternalServerError' });
    })
    .use(profileModule)
    .use(personalTokensModule)
    .use(decksModule)
    .use(noteTypesModule)
    .use(notesModule)
    .use(noteConversionModule)
    .use(cardsModule)
    .use(cardsSimilarModule)
    .use(graphModule)
    .use(deckOptionsModule)
    .use(filteredDecksModule)
    .use(reviewsModule)
    .use(statsModule)
    .use(mediaModule)
    .use(aiModule)
    .use(chatModule)
    .use(contextualChatModule)
    .use(topicPlanRoutes)
    .use(notebooksModule)
    .use(sourcesModule)
    .use(sourceStudyModule)
    .use(sourceTextMarksModule)
    .use(libraryModule)
    .use(operationsModule)
    .use(uiActionsModule)
    .use(cardRecoveryModule)
    .use(remindersModule)
    .all('/mcp', ({ request, log }) => handleMcp(request, (req) => readHandle(req), log), { parse: 'none' })
    // Explicit fallback keeps the completion hook's final status accurate for
    // unmatched routes too (Elysia's implicit 404 is mapped after analytics).
    .all('/*', ({ set }) => {
      set.status = 404;
      return { error: 'NotFound' as const };
    });
  readHandle = (request) => app.handle(request);
  return app;
}

export type App = ReturnType<typeof buildApp>;
