import { closeDb } from '@reomi/db';
import { buildApp, type App } from './app.ts';
import { env } from './env.ts';
import { rootLogger, safeError } from './logger.ts';
import { runMediaGc } from './media-gc.ts';
import { createReceiptMaintenance } from './receipt-maintenance';
import { cleanupUiActionReceipts } from './modules/ui-action-receipts';
import { cleanupOperationRetryReceipts } from './modules/operation-retry';
import { drainIndexQueue, reconcileOnStartup } from './ai/index-queue.ts';
import {
  drainSourceIngest,
  reconcileDocumentsOnStartup,
  resumeSourceIngestOnStartup,
} from './ai/source-ingest.ts';
import {
  drainArtifactGeneration,
  reconcileArtifactsOnStartup,
} from './ai/artifacts.ts';
import { createProcessFailureHandlers, createShutdownCoordinator } from './shutdown.ts';
import { drainReminders, startReminderScheduler } from './reminders/scheduler.ts';
import { drainDocumentationWorker, startDocumentationWorker } from './ai/library-documentation-worker';

const receiptMaintenance = createReceiptMaintenance(async () => {
  await cleanupUiActionReceipts(); await cleanupOperationRetryReceipts();
}, error => rootLogger.warn({ err: safeError(error) }, 'receipts.cleanup_failed'));

const mediaGc = createReceiptMaintenance(async () => {
  const report = await runMediaGc();
  if (report.listFailures > 0) {
    rootLogger.warn({ event: 'media.gc.list_failed', ...report }, 'media.gc.list_failed');
    return;
  }
  rootLogger.info({ event: 'media.gc.completed', ...report }, 'media.gc.completed');
}, error => rootLogger.warn({ err: safeError(error) }, 'media.gc.failed'), env.MEDIA_GC_INTERVAL_MS);

const app = buildApp().listen(env.PORT, () => {
  rootLogger.info(
    { event: 'api.listening', port: env.PORT, corsOrigin: env.WEB_ORIGIN, nodeEnv: env.NODE_ENV },
    'api.listening',
  );
  // Startup work has no causal request id and is deliberately root-scoped.
  void reconcileOnStartup().then(() => reconcileDocumentsOnStartup({ all: true }));
  void resumeSourceIngestOnStartup();
  void startDocumentationWorker().catch(err => rootLogger.error({ err: safeError(err) }, 'documentation.start_failed'));
  void reconcileArtifactsOnStartup();
  receiptMaintenance.start();
  if (env.NODE_ENV !== 'test' && env.MEDIA_GC_ENABLED) mediaGc.start();
  if (env.NODE_ENV !== 'test') startReminderScheduler();
});

const shutdown = createShutdownCoordinator({
  logger: rootLogger,
  timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  stopServer: () => { receiptMaintenance.cancel(); mediaGc.cancel(); return app.stop(); },
  workers: {
    index: (timeoutMs) => drainIndexQueue({ timeoutMs }),
    sourceIngest: (timeoutMs) => drainSourceIngest({ timeoutMs }),
    artifact: (timeoutMs) => drainArtifactGeneration({ timeoutMs }),
    receipts: () => receiptMaintenance.drain(),
    mediaGc: () => mediaGc.drain(),
    reminder: () => drainReminders(),
    documentation: timeoutMs => drainDocumentationWorker(timeoutMs),
  },
  closeDb,
  // Avoid process.exit(): after the listener/pool close, the event loop exits
  // naturally and Pino gets a chance to flush the final outcome line.
  exit: (code) => {
    process.exitCode = code;
  },
});

const processHandlers = createProcessFailureHandlers({
  logger: rootLogger,
  shutdown: shutdown.shutdown,
});

process.on('SIGTERM', processHandlers.sigterm);
process.on('SIGINT', processHandlers.sigint);
process.on('uncaughtException', processHandlers.uncaughtException);
process.on('unhandledRejection', processHandlers.unhandledRejection);

// Exported *type only* — the Eden Treaty client in apps/web imports this to
// derive end-to-end route types. No runtime shape ever crosses the boundary.
export type { App };
void app;
