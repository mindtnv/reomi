// One observation decides both the learner sentence and the chat probe.
// The markup itself is never stored.

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
  return err instanceof UpstreamChatError || isTransportFailure(err);
}
