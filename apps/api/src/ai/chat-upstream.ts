// One observation decides both the learner sentence and the chat probe.
// The markup itself is never stored.

import { env } from '../env.ts';

export type ChatUpstreamObservation = {
  status: number | null;
  html: boolean;
};

export type ChatUpstreamVerdict =
  | { kind: 'unavailable' }
  | { kind: 'reachable' }
  | { kind: 'rejected' };

export type LearnerStreamCode =
  | 'ai_unavailable'
  | 'chat_failed'
  | 'chat_stream_torn'
  | 'ai_disabled:chat'
  | 'ai_disabled:embedding';

// HTML is an outage at every status, including a 200 that returned a proxy page.
export function judgeChatUpstream(observation: ChatUpstreamObservation): ChatUpstreamVerdict {
  if (
    observation.html ||
    observation.status === null ||
    observation.status === 404 ||
    observation.status >= 500
  ) {
    return { kind: 'unavailable' };
  }
  if (observation.status >= 200 && observation.status < 300) return { kind: 'reachable' };
  return { kind: 'rejected' };
}

// Fixed message so a missed classifier cannot forward `chat_failed:<status>`.
export class UpstreamChatError extends Error {
  readonly observation: ChatUpstreamObservation;

  constructor(observation: ChatUpstreamObservation) {
    super('upstream_chat');
    this.name = 'UpstreamChatError';
    this.observation = observation;
  }
}

const LEGACY_STATUS = /^(?:chat_failed|complete_failed):(\d+)$/;

// Codes come from `error.code` and `cause.code`. The message text is not scanned,
// so a host written into the text is not a signal.
const TRANSPORT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

type CodedCause = { code?: unknown; cause?: unknown };

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function hasTransportCode(err: unknown): boolean {
  let current: unknown = err;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth += 1) {
    if (seen.has(current)) return false;
    seen.add(current);
    const coded = current as CodedCause;
    if (typeof coded.code === 'string' && TRANSPORT_CODES.has(coded.code)) return true;
    current = coded.cause;
  }
  return false;
}

export function isTransportFailure(err: unknown): boolean {
  if (isAbortError(err)) return false;
  if (err instanceof Error && err.message === 'fetch failed') return true;
  return hasTransportCode(err);
}

function disabledSurface(err: unknown): 'ai_disabled:chat' | 'ai_disabled:embedding' | null {
  if (!(err instanceof Error) || err.name !== 'AiDisabledError') return null;
  if (err.message === 'ai_disabled:chat' || err.message === 'ai_disabled:embedding') return err.message;
  return null;
}

function codeForObservation(observation: ChatUpstreamObservation): 'ai_unavailable' | 'chat_failed' {
  return judgeChatUpstream(observation).kind === 'unavailable' ? 'ai_unavailable' : 'chat_failed';
}

export function learnerCodeForThrown(err: unknown): LearnerStreamCode {
  const disabled = disabledSurface(err);
  if (disabled) return disabled;
  if (err instanceof UpstreamChatError) return codeForObservation(err.observation);
  if (err instanceof Error && err.message === 'chat_stream_torn') return 'chat_stream_torn';
  if (err instanceof Error) {
    const legacy = LEGACY_STATUS.exec(err.message);
    if (legacy) {
      return codeForObservation({ status: Number(legacy[1]), html: false });
    }
  }
  if (isTransportFailure(err)) return 'ai_unavailable';
  return 'chat_failed';
}

export function isChatUpstreamOutage(err: unknown): boolean {
  if (isTransportFailure(err)) return true;
  return err instanceof UpstreamChatError && judgeChatUpstream(err.observation).kind === 'unavailable';
}

export function preFlushChatFailure(
  err: unknown,
): { status: 503; error: 'ai_unavailable' } | { status: 502; error: 'chat_failed' } | null {
  if (!isChatUpstreamOutage(err) && !(err instanceof UpstreamChatError)) return null;
  return learnerCodeForThrown(err) === 'ai_unavailable'
    ? { status: 503, error: 'ai_unavailable' }
    : { status: 502, error: 'chat_failed' };
}

type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

let fetchOverride: FetchImpl | null = null;

export function __setChatUpstreamFetchForTests(impl: FetchImpl | null): void {
  fetchOverride = impl;
}

export function chatUpstreamFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const impl = fetchOverride ?? globalThis.fetch;
  return impl(input, init);
}

export function contentTypeIsHtml(header: string | null): boolean {
  const mime = header?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return mime === 'text/html' || mime === 'application/xhtml+xml';
}

type UpstreamFailureLog = {
  error: (fields: { status: number | null; html: boolean }, event: string) => void;
};

type ResponseWithBody = Response & { body: NonNullable<Response['body']> };

export async function requestChatCompletion(
  url: string,
  init: RequestInit,
  opts: { log: UpstreamFailureLog; event: string; requireBody: true },
): Promise<ResponseWithBody>;
export async function requestChatCompletion(
  url: string,
  init: RequestInit,
  opts: { log: UpstreamFailureLog; event: string; requireBody?: boolean },
): Promise<Response>;
export async function requestChatCompletion(
  url: string,
  init: RequestInit,
  opts: { log: UpstreamFailureLog; event: string; requireBody?: boolean },
): Promise<Response> {
  let res: Response;
  try {
    res = await chatUpstreamFetch(url, init);
  } catch (err) {
    if (isAbortError(err)) throw err;
    opts.log.error({ status: null, html: false }, opts.event);
    throw new UpstreamChatError({ status: null, html: false });
  }
  const html = contentTypeIsHtml(res.headers.get('content-type'));
  if (!res.ok || html || (opts.requireBody && !res.body)) {
    opts.log.error({ status: res.status, html }, opts.event);
    await res.body?.cancel().catch(() => undefined);
    throw new UpstreamChatError({ status: res.status, html });
  }
  return res;
}

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_PEEK_BYTES = 64;

async function peekHtml(res: Response): Promise<boolean> {
  const fromType = contentTypeIsHtml(res.headers.get('content-type'));
  const body = res.body;
  if (!body) return fromType;
  const reader = body.getReader();
  let fromBytes = false;
  try {
    const { value } = await reader.read();
    if (value && value.byteLength > 0) {
      const sample = value.subarray(0, PROBE_PEEK_BYTES);
      const text = new TextDecoder('utf-8', { fatal: false }).decode(sample);
      fromBytes = /^\s*</.test(text);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return fromType || fromBytes;
}

export type ChatProbeBody =
  | { ok: true }
  | { ok: false; state: 'unavailable' | 'rejected' };

type ProbeLog = {
  info: (fields: { status: number | null; html: boolean; kind: ChatUpstreamVerdict['kind'] }, event: string) => void;
};

export async function probeChatUpstream(log: ProbeLog): Promise<ChatProbeBody> {
  const base = env.ai.CHAT_BASE_URL.replace(/\/$/, '');
  const observation = await observeChatModels(`${base}/models`, env.ai.CHAT_API_KEY ?? '');
  const verdict = judgeChatUpstream(observation);
  log.info(
    { status: observation.status, html: observation.html, kind: verdict.kind },
    'ai.chat.probe',
  );
  if (verdict.kind === 'reachable') return { ok: true };
  if (verdict.kind === 'unavailable') return { ok: false, state: 'unavailable' };
  return { ok: false, state: 'rejected' };
}

async function observeChatModels(url: string, apiKey: string): Promise<ChatUpstreamObservation> {
  let res: Response;
  try {
    res = await chatUpstreamFetch(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${apiKey}` },
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    return { status: null, html: false };
  }
  return { status: res.status, html: await peekHtml(res) };
}
