// End-to-end typed API client via Eden Treaty.
//
// The backend is at apps/api. We import only its *type* (erased at build time),
// so no server code ends up in the browser bundle.
//
// Usage:
//   const { data, error } = await api.decks.get();
//   const { data } = await api.decks.post({ name: 'New deck' });
//   const { data } = await api.decks({ id }).patch({ name: 'Renamed' });

import { treaty } from '@elysiajs/eden';
import type { App } from '@reomi/api';

const baseURL =
  typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL
    ? process.env.NEXT_PUBLIC_API_URL
    : 'http://localhost:3000';
export { baseURL as apiBaseURL };

export const api = treaty<App>(baseURL, {
  fetch: {
    // Send + receive BetterAuth session cookies cross-origin.
    credentials: 'include',
  },
});

// Context excerpts are source text: Eden must not turn date-looking quotes,
// titles, or message contents into Date objects. Other existing clients retain
// their established date-revival behavior.
export const assistantApi = treaty<App>(baseURL, { parseDate: false, fetch: { credentials: 'include' } });

const CLIENT_ERROR_LIMIT = 240;

function safeClientText(value: string): string {
  const censored = value
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [REDACTED]')
    .replace(/\bnn_pat_[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/\b(?:sk|hs)[-_][A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(
      /\b(api[_-]?key|authorization|cookie|password|secret|token)\b\s*[:=]\s*[^\s,"';}]+/gi,
      '$1=[REDACTED]',
    );
  return censored.length <= CLIENT_ERROR_LIMIT
    ? censored
    : `${censored.slice(0, CLIENT_ERROR_LIMIT - 1)}…`;
}

function messageFromPayload(payload: unknown, fallback: string): string {
  if (typeof payload === 'string') return safeClientText(payload);
  if (payload && typeof payload === 'object') {
    const value = payload as Record<string, unknown>;
    if (typeof value.error === 'string') return safeClientText(value.error);
    if (typeof value.message === 'string') return safeClientText(value.message);
  }
  return fallback;
}

function responseRequestId(response?: Response): string | undefined {
  const value = response?.headers.get('x-request-id') ?? undefined;
  return value && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined;
}

export class ApiError extends Error {
  readonly status: number;
  readonly requestId?: string;
  readonly safeMessage: string;

  constructor(message: string, opts: { status: number; requestId?: string }) {
    const safeMessage = safeClientText(message || 'request_failed');
    const requestId =
      opts.requestId && /^[A-Za-z0-9._:-]{1,128}$/.test(opts.requestId)
        ? opts.requestId
        : undefined;
    const supportSuffix =
      opts.status >= 500 && requestId ? ` · request: ${requestId}` : '';
    super(`${safeMessage}${supportSuffix}`);
    this.name = 'ApiError';
    this.status = opts.status;
    this.requestId = requestId;
    this.safeMessage = safeMessage;
  }
}

async function readResponsePayload(response: Response): Promise<unknown> {
  try {
    const text = (await response.text()).slice(0, 4096);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  } catch {
    return undefined;
  }
}

export async function apiErrorFromResponse(
  response: Response,
  fallback = 'request_failed',
): Promise<ApiError> {
  const payload = await readResponsePayload(response);
  return new ApiError(messageFromPayload(payload, fallback), {
    status: response.status,
    requestId: responseRequestId(response),
  });
}

// Helpers that unwrap Eden's { data, error } envelope into plain promises.
// Throws on network / non-2xx so callers can use try/catch.
export async function ok<T, E>(result: {
  data: T | null;
  error: E | null;
  response?: Response;
  status?: number;
}): Promise<T> {
  if (result.error) {
    const payload =
      typeof result.error === 'object' && result.error && 'value' in result.error
        ? (result.error as { value: unknown }).value
        : result.error;
    const errorStatus =
      typeof result.error === 'object' && result.error && 'status' in result.error
        ? Number((result.error as { status: unknown }).status)
        : undefined;
    throw new ApiError(messageFromPayload(payload, 'request_failed'), {
      status: result.status ?? errorStatus ?? result.response?.status ?? 0,
      requestId: responseRequestId(result.response),
    });
  }
  if (result.data === null) {
    throw new ApiError('empty_response', {
      status: result.status ?? result.response?.status ?? 0,
      requestId: responseRequestId(result.response),
    });
  }
  return result.data;
}
