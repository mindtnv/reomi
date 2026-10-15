// OpenAI(-compatible) client — thin `fetch` wrapper (Decision 3, plan §46-52).
//
// Two surfaces:
//   * `embed(texts)`     → POST /v1/embeddings (OPENAI_API_KEY, EMBEDDING_MODEL).
//                          Batched by the caller; retry/backoff on 429/5xx;
//                          usage logged. Throws `AiDisabledError` when
//                          `!embeddingEnabled`.
//   * `chatStream(...)`  → POST /v1/chat/completions with `stream:true`, reads
//                          the SSE `data:` lines, yields token deltas (Slice 4).
//                          Throws `AiDisabledError` when `!chatEnabled`.
//
// Test seam (plan §257-259, CRITICAL): the two surfaces are read indirectly
// through a swappable client so tests can inject a deterministic fake WITHOUT
// real API keys. `__setAiClientForTests(fake)` overrides `embed`/`chatStream`
// AND flips the effective enabled-flags for the injected path, so the index
// queue / retrieve / chat all operate under tests with no env configured.
// Mirrors how the suite pins `now`/fuzz today.

import type { Logger } from 'pino';
import { env, embeddingEnabled, chatEnabled } from '../env.ts';
import { rootLogger, summarizeUpstreamResponse } from '../logger.ts';
import { requestChatCompletion } from './chat-upstream.ts';

/** Thrown when an AI surface is invoked while its feature flag is off. */
export class AiDisabledError extends Error {
  constructor(public readonly surface: 'embedding' | 'chat') {
    super(`ai_disabled:${surface}`);
    this.name = 'AiDisabledError';
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * One multimodal content part (OpenAI wire shape). A `user` message with image
 * attachments sends `content` as an ARRAY of parts — text first, then
 * `image_url` parts carrying base64 data URLs (the gateway never gets a
 * localhost URL it couldn't fetch).
 */
export type AgentContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * Server-internal message shape for the agentic loop. Extends `ChatMessage`
 * with the OpenAI tool-calling wire fields: an `assistant` row may carry
 * `tool_calls`, and a `tool` result row carries `tool_call_id`. The `role`
 * union widens to include `'tool'` (never exposed to the string consumer).
 * `content` widens to multimodal parts for user rows with image attachments.
 */
export interface AgentChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | AgentContentPart[];
  /** Set on an assistant turn that emitted tool calls (OpenAI wire shape). */
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  /** Set on a `role:'tool'` result row, linking it to its parent tool call. */
  tool_call_id?: string;
}

/** A tool exposed to the gateway in the `tools[]` request field. */
export interface OpenAiToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

export interface ChatStreamOpts {
  /** Overrides env.ai.CHAT_MODEL when set. */
  model?: string;
  /** Optional per-request child logger for usage lines. */
  log?: Logger;
  /**
   * Optional abort signal — aborting tears the gateway fetch mid-stream. The
   * artifact streamer passes one so a deadline / cancel-on-delete actually stops
   * the underlying request (an injected fake may ignore it; the loop stops
   * pulling regardless).
   */
  signal?: AbortSignal;
}

export interface AgentChatStreamOpts extends ChatStreamOpts {
  /** Tool specs offered to the model (omit/empty ⇒ no tools). */
  tools?: OpenAiToolSpec[];
  /** Tool-choice directive; defaults to `'auto'`. S4's forced-final passes `'none'`. */
  toolChoice?: 'auto' | 'none' | 'required';
  /**
   * Turn-level abort (client disconnect / Stop / superseded turn). Aborting
   * tears the gateway fetch mid-stream — the loop's caller treats it as a
   * cancelled turn, not an error.
   */
  signal?: AbortSignal;
}

/**
 * One streamed chunk from `chatStreamAgentic`. The generator emits a `finish`
 * chunk when the gateway reports `finish_reason` (or on `[DONE]` carrying one).
 * If the underlying reader hits EOF/`[DONE]` WITHOUT a `finish_reason`, the
 * generator returns with NO `finish` chunk — S4's never-terminated guard
 * detects buffered tool_call fragments + no `finish` as a torn stream.
 */
export type AgentStreamChunk =
  | { type: 'content'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; argsFragment?: string }
  | { type: 'finish'; reason: 'stop' | 'tool_calls' | 'length' }
  // Token usage from the gateway's `stream_options: { include_usage: true }`
  // final chunk (OpenAI sends it with `choices: []`, AFTER finish_reason).
  // Never emitted when the provider omits usage — consumers must not rely on it.
  | { type: 'usage'; promptTokens: number; completionTokens: number; totalTokens: number };

/** Options for the non-streaming `complete()` helper (titles/summaries). */
export interface CompleteOpts {
  /** Overrides env.ai.CHAT_MODEL when set. */
  model?: string;
  /** Bounded-time abort (callers pass AbortSignal.timeout(...)). */
  signal?: AbortSignal;
  /** Optional per-request child logger. */
  log?: Logger;
}

/** The injectable surface. A fake (tests) provides any subset of members. */
export interface AiClient {
  embed?: (texts: string[]) => Promise<number[][]>;
  chatStream?: (messages: ChatMessage[], opts?: ChatStreamOpts) => AsyncIterable<string>;
  chatStreamAgentic?: (
    messages: AgentChatMessage[],
    opts?: AgentChatStreamOpts,
  ) => AsyncIterable<AgentStreamChunk>;
  /**
   * Non-streaming completion for auxiliary calls (auto-titles, context
   * summaries). Deliberately SEPARATE from `chatStreamAgentic` so scripted
   * agent fakes don't have their turn scripts consumed by aux calls — a fake
   * that omits `complete` makes aux features skip gracefully (AiDisabledError
   * is caught at every call site).
   */
  complete?: (messages: ChatMessage[], opts?: CompleteOpts) => Promise<string>;
}

// ── Test-seam state ──────────────────────────────────────────────────────────
// When a fake is injected, the injected surface is treated as enabled REGARDLESS
// of env (so indexing/chat work in tests with no OPENAI_API_KEY). The real path
// still gates on the env-derived flags.

let injected: AiClient | null = null;

/**
 * Inject a deterministic fake client for tests. Pass `{ embed }` and/or
 * `{ chatStream }`. Call with `null` (or `__resetAiClientForTests`) to restore
 * the real `fetch`-backed client. Only intended for `NODE_ENV=test`.
 */
export function __setAiClientForTests(fake: AiClient | null): void {
  injected = fake;
}

export function __resetAiClientForTests(): void {
  injected = null;
}

/** Effective embedding switch: env flag OR an injected fake `embed`. */
export function isEmbeddingEnabled(): boolean {
  return embeddingEnabled || Boolean(injected?.embed);
}

/**
 * Effective chat switch: env flag OR an injected fake chat surface (either the
 * legacy string `chatStream` or the agentic `chatStreamAgentic`) — so an
 * agentic-only fake flips chat on in tests.
 */
export function isChatEnabled(): boolean {
  return chatEnabled || Boolean(injected?.chatStream) || Boolean(injected?.chatStreamAgentic);
}

/**
 * Whether the plain (tool-less) `chatStream` surface is usable RIGHT NOW — the
 * real env-enabled path OR an injected fake that provides `chatStream`. The
 * artifact generator uses this to prefer streaming (live partial persistence)
 * over `complete()`; a fake with only `complete` (every pre-existing test) makes
 * this `false`, so the worker falls back to the single-shot `complete()` path.
 */
export function isChatStreamEnabled(): boolean {
  return Boolean(injected?.chatStream) || chatEnabled;
}

/** Source artifacts need a tool-less stream or completion surface. */
export function isArtifactGenerationEnabled(): boolean {
  return chatEnabled || Boolean(injected?.chatStream) || Boolean(injected?.complete);
}

// ── Backoff helper ───────────────────────────────────────────────────────────

const MAX_RETRIES = 4;

function backoffMs(attempt: number): number {
  // 250ms, 500, 1000, 2000 (+ up to 250ms jitter). Bounded, never a hard stall.
  return Math.min(2000, 250 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

// ── Embeddings ───────────────────────────────────────────────────────────────

interface EmbeddingResponse {
  data: { embedding: number[]; index: number }[];
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

/**
 * Embed a batch of texts → one vector per input (same order). Retries on
 * 429/5xx with exponential backoff. Usage (count, tokens, latency) is logged.
 *
 * Throws `AiDisabledError('embedding')` when embeddings are not enabled and no
 * fake is injected. Empty input short-circuits to `[]` (no network call).
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (injected?.embed) return injected.embed(texts);
  if (!embeddingEnabled) throw new AiDisabledError('embedding');
  if (texts.length === 0) return [];

  const apiKey = env.ai.OPENAI_API_KEY!;
  // Embeddings hit EMBEDDING_BASE_URL (default OpenAI), NOT CHAT_BASE_URL — the
  // embedder and the chat gateway may be different hosts/providers.
  const url = `${env.ai.EMBEDDING_BASE_URL.replace(/\/$/, '')}/embeddings`;
  const log = rootLogger;
  const started = performance.now();

  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: env.ai.EMBEDDING_MODEL, input: texts }),
        // Bun fetch extension: route ONLY embedding calls through an egress
        // proxy (geo-blocked upstream). http(s):// proxies only — Bun has no
        // SOCKS support, a socks5 upstream needs a converter sidecar (gost).
        ...(env.ai.EMBEDDING_PROXY_URL ? { proxy: env.ai.EMBEDDING_PROXY_URL } : {}),
      });
    } catch (err) {
      // Network error — retry with backoff.
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw err;
    }

    if (res.ok) {
      const json = (await res.json()) as EmbeddingResponse;
      // Sort by index defensively — the API returns in-order, but don't rely on it.
      const vectors = json.data
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
      log.info(
        {
          model: env.ai.EMBEDDING_MODEL,
          count: texts.length,
          tokens: json.usage?.total_tokens,
          latencyMs: Math.round(performance.now() - started),
        },
        'ai.embed',
      );
      return vectors;
    }

    if (isRetryable(res.status) && attempt < MAX_RETRIES) {
      log.warn({ status: res.status, attempt }, 'ai.embed.retry');
      await sleep(backoffMs(attempt));
      continue;
    }

    const upstream = await summarizeUpstreamResponse(res);
    log.error({ upstream }, 'ai.embed.failed');
    throw new Error(`embed_failed:${res.status}`);
  }
  throw lastErr instanceof Error ? lastErr : new Error('embed_failed');
}

// ── Shared SSE frame splitting ────────────────────────────────────────────────

/** A sentinel parsed payload meaning the stream sent `data: [DONE]`. */
export const SSE_DONE = Symbol('sse_done');

/**
 * Read an OpenAI-compatible SSE body and yield each `data:` payload as it
 * completes a frame. Frames are separated by a blank line (`\n\n`); the trailing
 * partial is buffered across reads. Yields the parsed JSON of each `data:` line,
 * or `SSE_DONE` for `data: [DONE]`. Malformed/partial JSON lines are skipped
 * (the next read may complete them). Shared by `chatStream` (string consumer)
 * and `chatStreamAgentic` (agent consumer) so the frame-splitting is tested once.
 */
export async function* parseSseLines(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncIterable<unknown | typeof SSE_DONE> {
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are separated by a blank line. Process complete frames; keep
      // the trailing partial in the buffer.
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const rawLine of frame.split('\n')) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            yield SSE_DONE;
            return;
          }
          try {
            yield JSON.parse(payload);
          } catch {
            // Skip a malformed/partial JSON line — the next read may complete it.
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Chat completion (SSE stream) ──────────────────────────────────────────────

interface ChatChunk {
  choices?: { delta?: { content?: string } }[];
}

/**
 * Stream a chat completion as token deltas. Reads the OpenAI-compatible SSE
 * response (`data: {json}\n\n`, terminated by `data: [DONE]`) and yields each
 * `choices[0].delta.content` fragment as it arrives.
 *
 * Throws `AiDisabledError('chat')` when chat is not enabled and no fake is
 * injected. Errors after the first byte are the caller's concern (Slice 4 wraps
 * this in its own terminal `event: error` frame — see plan SHOULD-FIX #7).
 */
export async function* chatStream(
  messages: ChatMessage[],
  opts: ChatStreamOpts = {},
): AsyncIterable<string> {
  if (injected?.chatStream) {
    yield* injected.chatStream(messages, opts);
    return;
  }
  if (!chatEnabled) throw new AiDisabledError('chat');

  const apiKey = env.ai.CHAT_API_KEY!;
  const model = opts.model ?? env.ai.CHAT_MODEL;
  const url = `${env.ai.CHAT_BASE_URL.replace(/\/$/, '')}/chat/completions`;
  const log = opts.log ?? rootLogger;
  const started = performance.now();

  const res = await requestChatCompletion(
    url,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      signal: opts.signal,
      body: JSON.stringify({ model, messages, stream: true }),
    },
    { log, event: 'ai.chat.failed', requireBody: true },
  );

  // Count of streamed SSE content deltas — NOT model tokens (no usage parsing in
  // streaming mode). Named `deltas` so the observability log isn't misleading.
  let deltas = 0;

  for await (const payload of parseSseLines(res.body.getReader())) {
    if (payload === SSE_DONE) break;
    const chunk = payload as ChatChunk;
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) {
      deltas += 1;
      yield delta;
    }
  }

  log.info(
    { model, deltas, latencyMs: Math.round(performance.now() - started) },
    'ai.chat',
  );
}

// ── Agentic chat completion (tool-calling SSE stream) ─────────────────────────

/** SSE delta shape for the agentic loop — content + reasoning + tool_calls. */
interface AgentChatChunk {
  choices?: {
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: 'stop' | 'tool_calls' | 'length' | null;
  }[];
  // `stream_options: { include_usage: true }` final chunk. OpenAI sends it with
  // `choices: []` — it MUST be checked before any choices[0] guard.
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/**
 * Stream an agentic chat completion. Sends `tools` + `tool_choice` and parses
 * streamed `delta.content`, `delta.reasoning_content`, and `delta.tool_calls[]`
 * (each `{ index, id?, function?: { name?, arguments? } }`), emitting the
 * discriminated `AgentStreamChunk` union. Runs ALONGSIDE `chatStream` (which is
 * byte-identical for its string consumer) and shares `parseSseLines`.
 *
 * The generator emits a `finish` chunk on `finish_reason`. On EOF/`[DONE]`
 * WITHOUT a `finish_reason`, it returns with NO `finish` chunk — the agent loop
 * treats buffered-tool-fragments-but-no-finish as a torn stream (terminal error).
 *
 * Throws `AiDisabledError('chat')` when chat is not enabled and no fake is
 * injected. Post-first-byte errors are the caller's concern (S4 wraps them in a
 * terminal `event: error` frame).
 */
export async function* chatStreamAgentic(
  messages: AgentChatMessage[],
  opts: AgentChatStreamOpts = {},
): AsyncIterable<AgentStreamChunk> {
  if (injected?.chatStreamAgentic) {
    yield* injected.chatStreamAgentic(messages, opts);
    return;
  }
  if (!chatEnabled) throw new AiDisabledError('chat');

  const apiKey = env.ai.CHAT_API_KEY!;
  const model = opts.model ?? env.ai.CHAT_MODEL;
  const url = `${env.ai.CHAT_BASE_URL.replace(/\/$/, '')}/chat/completions`;
  const log = opts.log ?? rootLogger;
  const started = performance.now();

  const res = await requestChatCompletion(
    url,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      signal: opts.signal,
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        // Token accounting (C1). Kill-switch for gateways that reject the param —
        // without it the usage chunk simply never arrives (graceful degrade).
        ...(env.ai.CHAT_STREAM_USAGE !== 'false'
          ? { stream_options: { include_usage: true } }
          : {}),
        ...(opts.tools && opts.tools.length > 0
          ? { tools: opts.tools, tool_choice: opts.toolChoice ?? 'auto' }
          : {}),
      }),
    },
    { log, event: 'ai.chat.failed', requireBody: true },
  );

  let deltas = 0;

  for await (const payload of parseSseLines(res.body.getReader())) {
    if (payload === SSE_DONE) break;
    const chunk = payload as AgentChatChunk;
    // Usage rides a trailing chunk with `choices: []` — handle it BEFORE the
    // choices[0] guard or it is silently skipped.
    if (chunk.usage) {
      const prompt = chunk.usage.prompt_tokens ?? 0;
      const completion = chunk.usage.completion_tokens ?? 0;
      yield {
        type: 'usage',
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: chunk.usage.total_tokens ?? prompt + completion,
      };
    }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta;
    const reasoning = delta?.reasoning_content;
    if (reasoning) yield { type: 'reasoning', text: reasoning };
    const content = delta?.content;
    if (content) {
      deltas += 1;
      yield { type: 'content', text: content };
    }
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        yield {
          type: 'tool_call_delta',
          index: tc.index,
          id: tc.id,
          name: tc.function?.name,
          argsFragment: tc.function?.arguments,
        };
      }
    }
    if (choice.finish_reason) {
      log.info(
        {
          model,
          deltas,
          finish: choice.finish_reason,
          latencyMs: Math.round(performance.now() - started),
        },
        'ai.chat.agentic',
      );
      yield { type: 'finish', reason: choice.finish_reason };
      // A `finish_reason` ends this completion; if a `[DONE]` follows it is a
      // no-op (the for-await breaks on it). Keep reading in case the gateway
      // sends trailing keep-alives, but emit no further finish.
    }
  }
}

// ── Non-streaming completion (aux calls: titles, summaries) ──────────────────

interface CompleteResponse {
  choices?: { message?: { content?: string | null } }[];
}

/**
 * One-shot (non-streaming) chat completion for auxiliary calls — auto-titles
 * and context summaries. Deliberately NOT built on `chatStreamAgentic`: the
 * scripted test fakes consume one script turn per stream call, so routing aux
 * calls through the agent surface would silently eat their scripts. A fake
 * without `complete` (i.e. every pre-existing test) makes the real path throw
 * `AiDisabledError('chat')` under test env — call sites catch and skip.
 *
 * No retry loop: aux calls are best-effort and time-bounded by the caller's
 * `signal` (AbortSignal.timeout). Throws on non-2xx / abort; never retries.
 */
export async function complete(messages: ChatMessage[], opts: CompleteOpts = {}): Promise<string> {
  if (injected?.complete) return injected.complete(messages, opts);
  if (!chatEnabled) throw new AiDisabledError('chat');

  const apiKey = env.ai.CHAT_API_KEY!;
  const model = opts.model ?? env.ai.CHAT_MODEL;
  const url = `${env.ai.CHAT_BASE_URL.replace(/\/$/, '')}/chat/completions`;
  const log = opts.log ?? rootLogger;
  const started = performance.now();

  const res = await requestChatCompletion(
    url,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model, messages }),
      signal: opts.signal,
    },
    { log, event: 'ai.complete.failed' },
  );

  const json = (await res.json()) as CompleteResponse;
  const content = json.choices?.[0]?.message?.content ?? '';
  log.info({ model, latencyMs: Math.round(performance.now() - started) }, 'ai.complete');
  return content;
}
