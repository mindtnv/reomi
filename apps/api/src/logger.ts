// Structured, privacy-safe logger boundary.
//
// Dev: human-readable via pino-pretty.
// Prod: one JSON object per line for the container log collector.
// Tests: silent by default, with pure helpers exported for contract tests.

import pino, { type Logger, type LoggerOptions } from 'pino';
import { newUuidV7 } from '@reomi/shared';

const DEFAULT_TEXT_LIMIT = 300;
const UPSTREAM_READ_LIMIT = 4096;
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NUMERIC_SEGMENT = /^\d+$/;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const trustedSafeErrors = new WeakSet<object>();

export interface SafeErrorSummary {
  name: string;
  message: string;
  code?: string;
}

export interface UpstreamErrorSummary {
  status: number;
  code?: string;
  type?: string;
  message?: string;
  truncated?: true;
}

export interface LogCorrelation {
  requestId?: string;
}

function cap(value: string, limit = DEFAULT_TEXT_LIMIT): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

/** Censor common credential shapes inside a string before it reaches Pino. */
export function censorSensitiveText(value: string, limit = DEFAULT_TEXT_LIMIT): string {
  const censored = value
    .replace(/(^|\n)\s*params\s*:[^\n]*/gi, '$1params:[REDACTED]')
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
    .replace(/\bnn_pat_[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\b(?:sk|hs)[-_][A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(
      /\b(api[_-]?key|access[_-]?key|authorization|cookie|password|secret|token|prompt|content|document|field[_-]?values)\b\s*[:=]\s*[^\s,"';}]+/gi,
      '$1=[REDACTED]',
    )
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]');
  return cap(censored, limit);
}

function safeMachineValue(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value);
  if (!/^[A-Za-z0-9._:-]{1,80}$/.test(text)) return undefined;
  return text;
}

/** Allow-listed, bounded exception summary. Arbitrary thrown objects are never walked. */
export function safeError(error: unknown): SafeErrorSummary {
  if (!(error instanceof Error)) {
    const summary = { name: 'NonError', message: 'Non-error value thrown' };
    trustedSafeErrors.add(summary);
    return summary;
  }
  const code = safeMachineValue((error as Error & { code?: unknown }).code);
  const summary = {
    name: cap(error.name || 'Error', 80),
    message: censorSensitiveText(error.message || 'Unknown error'),
    ...(code ? { code } : {}),
  };
  trustedSafeErrors.add(summary);
  return summary;
}

function serializeSafeError(error: unknown): SafeErrorSummary {
  if (error && typeof error === 'object' && trustedSafeErrors.has(error)) {
    return error as SafeErrorSummary;
  }
  return safeError(error);
}

/** Low-cardinality path for request logs and safe URL summaries. */
export function normalizeLogPath(input: string): string {
  let pathname = input;
  try {
    pathname = new URL(input, 'http://log.invalid').pathname;
  } catch {
    pathname = input.split(/[?#]/, 1)[0] ?? '/';
  }
  const normalized = pathname
    .split('/')
    .map((segment) => {
      if (UUID_SEGMENT.test(segment)) return ':uuid';
      if (NUMERIC_SEGMENT.test(segment)) return ':id';
      return segment;
    })
    .join('/');
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

/** Origin + normalized path only; removes user-info, query, and fragment. */
export function safeLogUrl(input: string): string {
  try {
    const url = new URL(input);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '[invalid-url]';
    return `${url.protocol}//${url.host}${normalizeLogPath(url.pathname)}`;
  } catch {
    return '[invalid-url]';
  }
}

async function readBoundedResponseText(
  response: Response,
  limit = UPSTREAM_READ_LIMIT,
): Promise<{ text: string; truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        const keep = Math.max(0, value.byteLength - (bytes - limit));
        text += decoder.decode(value.slice(0, keep), { stream: true });
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    truncated = true;
  }
  return { text, truncated };
}

function fieldFromTruncatedJson(text: string, field: string): string | undefined {
  const match = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)`, 'i').exec(text);
  if (!match?.[1]) return undefined;
  try {
    return JSON.parse(`"${match[1].replace(/"$/, '')}"`) as string;
  } catch {
    return match[1].replace(/\\[nrt]/g, ' ');
  }
}

/** Consume at most a small prefix of an upstream error body and expose allow-listed fields. */
export async function summarizeUpstreamResponse(
  response: Response,
): Promise<UpstreamErrorSummary> {
  const { text, truncated } = await readBoundedResponseText(response);
  let candidate: unknown;
  try {
    const parsed = JSON.parse(text) as unknown;
    candidate =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? (parsed as { error: unknown }).error
        : parsed;
  } catch {
    candidate = undefined;
  }

  const object = candidate && typeof candidate === 'object' ? (candidate as Record<string, unknown>) : {};
  const code = safeMachineValue(object.code) ?? safeMachineValue(fieldFromTruncatedJson(text, 'code'));
  const type = safeMachineValue(object.type) ?? safeMachineValue(fieldFromTruncatedJson(text, 'type'));
  const rawMessage =
    (typeof object.message === 'string' ? object.message : undefined) ??
    fieldFromTruncatedJson(text, 'message');
  const message = rawMessage ? censorSensitiveText(rawMessage) : undefined;
  return {
    status: response.status,
    ...(code ? { code } : {}),
    ...(type ? { type } : {}),
    ...(message ? { message } : {}),
    ...(truncated ? { truncated: true as const } : {}),
  };
}

export function createLoggerOptions(opts?: {
  nodeEnv?: string;
  level?: string;
}): LoggerOptions {
  const nodeEnv = opts?.nodeEnv ?? process.env.NODE_ENV ?? 'development';
  const level =
    opts?.level ??
    process.env.LOG_LEVEL ??
    (nodeEnv === 'test' ? 'silent' : nodeEnv === 'production' ? 'info' : 'debug');
  const isProd = nodeEnv === 'production';
  return {
    level,
    base: { app: 'neuronexus-api' },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      err: serializeSafeError,
      error: serializeSafeError,
    },
    ...(isProd
      ? {}
      : {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              singleLine: true,
              ignore: 'pid,hostname',
              translateTime: 'HH:MM:ss.l',
            },
          },
        }),
    redact: {
      paths: [
        'authorization',
        'cookie',
        'password',
        'newPassword',
        'token',
        'apiKey',
        'api_key',
        'accessKey',
        'secret',
        'credentials',
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers.set-cookie',
        'res.headers.set-cookie',
        'body.password',
        'body.newPassword',
        'body.token',
        '*.authorization',
        '*.cookie',
        '*.password',
        '*.newPassword',
        '*.token',
        '*.apiKey',
        '*.api_key',
        '*.accessKey',
        '*.secret',
        '*.credentials',
      ],
      censor: '[REDACTED]',
    },
  };
}

export const rootLogger: Logger = pino(createLoggerOptions());

/** Read the per-request derived logger without falling back to shared app state. */
export function requestLogFromContext(context: unknown, fallback: Logger = rootLogger): Logger {
  if (context && typeof context === 'object' && 'log' in context) {
    const candidate = (context as { log?: unknown }).log;
    if (candidate && typeof (candidate as Logger).child === 'function') return candidate as Logger;
  }
  return fallback;
}

/** Extract only safe causal metadata before work crosses an async queue boundary. */
export function logCorrelation(log: Logger): LogCorrelation | undefined {
  const requestId = log.bindings().requestId;
  return typeof requestId === 'string' && REQUEST_ID.test(requestId) ? { requestId } : undefined;
}

export function workerLogger(
  worker: string,
  correlation?: LogCorrelation,
  parent: Logger = rootLogger,
): Logger {
  return parent.child({ worker, ...(correlation ?? {}) });
}

/** Per-request child logger. `requestId` lets downstream lines group. */
export function requestLogger(
  opts: { requestId: string; method: string; path: string; userId?: string },
  parent: Logger = rootLogger,
): Logger {
  return parent.child({ ...opts, path: normalizeLogPath(opts.path) });
}

/** Accept a log-safe upstream request id or generate a UUIDv7. */
export function pickRequestId(headers: Headers): string {
  const incoming = headers.get('x-request-id');
  if (incoming && REQUEST_ID.test(incoming)) return incoming;
  return newUuidV7();
}
