function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function positiveNumber(key: string, fallback: number): number {
  const parsed = Number(process.env[key] ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const env = {
  PORT: Number(process.env.API_PORT ?? 3000),
  WEB_ORIGIN: process.env.WEB_ORIGIN ?? 'http://localhost:3001',
  DATABASE_URL: required('DATABASE_URL'),
  BETTER_AUTH_URL: required('BETTER_AUTH_URL'),
  BETTER_AUTH_SECRET: required('BETTER_AUTH_SECRET'),
  NODE_ENV: process.env.NODE_ENV ?? 'development',
  // Optional Web Push (VAPID). Empty or absent disables push with 503
  // push_disabled and leaves the rest of the API up. Read live so a process
  // can observe keys without a module reload in tests.
  get VAPID_PUBLIC_KEY() {
    const value = process.env.VAPID_PUBLIC_KEY?.trim();
    return value || undefined;
  },
  get VAPID_PRIVATE_KEY() {
    const value = process.env.VAPID_PRIVATE_KEY?.trim();
    return value || undefined;
  },
  get VAPID_SUBJECT() {
    const value = process.env.VAPID_SUBJECT?.trim();
    return value || 'https://app.reomi.ru';
  },
  // Total application shutdown budget. Keep below the container stop grace.
  SHUTDOWN_TIMEOUT_MS: positiveNumber('SHUTDOWN_TIMEOUT_MS', 8000),
  // ── Media storage (M2) — S3-compatible (MinIO local / R2-S3 prod) ──────────
  S3_ENDPOINT: required('S3_ENDPOINT'),
  S3_REGION: process.env.S3_REGION ?? 'us-east-1',
  S3_BUCKET: required('S3_BUCKET'),
  S3_ACCESS_KEY_ID: required('S3_ACCESS_KEY_ID'),
  S3_SECRET_ACCESS_KEY: required('S3_SECRET_ACCESS_KEY'),
  // Object base URL. Card/cover bytes are not served from here; authenticated
  // `GET /media/:id/content` is the read path. Anonymous bucket download stays off.
  S3_PUBLIC_BASE_URL: required('S3_PUBLIC_BASE_URL'),
  // MinIO needs path-style addressing; real S3/R2 use virtual-hosted by default.
  S3_FORCE_PATH_STYLE: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
  // Hard upload ceiling (bytes). Default 5 MiB.
  MAX_MEDIA_BYTES: Number(process.env.MAX_MEDIA_BYTES ?? 5 * 1024 * 1024),
  // ── AI / RAG (all OPTIONAL — degrade, never crash) ─────────────────────────
  // Two independent feature switches derived below. The whole block is optional:
  // absence must NOT crash the API or break existing tests (do NOT use
  // `required()` here). Secrets are server-only — never expose as NEXT_PUBLIC_*.
  ai: {
    // Embeddings (indexing side).
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    // Embeddings base URL — SEPARATE from CHAT_BASE_URL: the embedder may run on
    // a different host/provider than the chat gateway (e.g. OpenAI embeddings +
    // a self-hosted OpenAI-compatible chat gateway). Defaults to OpenAI.
    EMBEDDING_BASE_URL: process.env.EMBEDDING_BASE_URL ?? 'https://api.openai.com/v1',
    // OPTIONAL egress proxy for embedding calls ONLY (http(s):// — Bun fetch
    // has no SOCKS support; a socks5 upstream needs a converter sidecar).
    // Used when the embedding provider is geo-blocked from the server.
    EMBEDDING_PROXY_URL: process.env.EMBEDDING_PROXY_URL,
    EMBEDDING_MODEL: process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small',
    // Baked into the kb_chunk.embedding column dimension via the migration —
    // must match the embedding model. Changing it requires the reindex-on-
    // model-change runbook (see CLAUDE.md → AI / RAG).
    EMBEDDING_DIM: Number(process.env.EMBEDDING_DIM ?? 1536),
    // Chat (retrieval-grounded completion side). OpenAI-compatible base URL.
    CHAT_BASE_URL: process.env.CHAT_BASE_URL ?? 'https://api.openai.com/v1',
    CHAT_MODEL: process.env.CHAT_MODEL ?? 'gpt-4o-mini',
    CHAT_API_KEY: process.env.CHAT_API_KEY,
    // Optional model allow-list (CSV `model[|label]`, first=default) for the
    // per-turn reasoning/model picker. Unset ⇒ the picker is hidden and chat
    // uses CHAT_MODEL exactly as today (degrade — NO required()). Parsed via
    // `parseChatModels` from @reomi/shared; only the parsed {id,label,
    // default} is ever exposed via /ai/status — never the key/base URL.
    CHAT_MODELS: process.env.CHAT_MODELS,
    // Lets ops pause indexing independently of chat (default on).
    INDEXING_ENABLED: process.env.INDEXING_ENABLED ?? 'true',
    // Retrieval tuning (chat grounding):
    //  * RETRIEVE_K — max card chunks pulled per turn (a topic with more relevant
    //    cards than this is capped here).
    //  * RETRIEVE_MIN_SCORE — minimum cosine similarity (0..1) a chunk must clear.
    //    Below it the chunk is dropped, so an off-topic message (a greeting) pulls
    //    0 cards instead of k irrelevant ones. Calibrated for text-embedding-3-small
    //    (unrelated ≲0.27, relevant ≳0.35); lower it to be more inclusive.
    RETRIEVE_K: Number(process.env.RETRIEVE_K ?? 12),
    RETRIEVE_MIN_SCORE: Number(process.env.RETRIEVE_MIN_SCORE ?? 0.32),
    // ── Agentic tool-calling chat ────────────────────────────────────────────
    // Web search (Brave) — OPTIONAL. Absent ⇒ the `web_search` tool is simply
    // not offered to the model (chat unaffected — Principle 1). The ONLY web
    // provider for now; a second provider would be a clean drop-in (no
    // WEB_SEARCH_PROVIDER selector env — YAGNI).
    BRAVE_SEARCH_API_KEY: process.env.BRAVE_SEARCH_API_KEY,
    // ── Deep research (fetch_page + Exa) ─────────────────────────────────────
    // Exa (exa.ai) — OPTIONAL. When set it becomes BOTH the web-search provider
    // (preferred over Brave) AND the `fetch_page` backend (Exa /contents crawls
    // the page on THEIR network — the API makes no direct outbound fetch, so
    // there is no SSRF surface on this path).
    EXA_API_KEY: process.env.EXA_API_KEY,
    // Kill-switch for the `fetch_page` tool ('false' ⇒ tool not offered).
    // Without an Exa key the tool uses a direct SSRF-guarded fetcher.
    CHAT_FETCH_PAGE: process.env.CHAT_FETCH_PAGE ?? 'true',
    // Per-fetch_page hard timeout (ms; also Exa's livecrawlTimeout) + byte cap
    // for the direct fetcher's response body.
    FETCH_PAGE_TIMEOUT_MS: Number(process.env.FETCH_PAGE_TIMEOUT_MS ?? 10000),
    FETCH_PAGE_MAX_BYTES: Number(process.env.FETCH_PAGE_MAX_BYTES ?? 2_000_000),
    // Per-turn tool-result char budget = TOOL_RESULT_MAX_CHARS × this factor.
    // Default 8 (was a hardcoded ×4) so a deep-research turn can read several
    // page slices before the loop forces a final answer; ordinary turns never
    // approach the ceiling.
    TOOL_RESULT_BUDGET_FACTOR: Number(process.env.TOOL_RESULT_BUDGET_FACTOR ?? 8),
    // Hard ceiling on agent loop iterations (loop-enforced — the cap is the
    // source of truth, NOT the gateway honoring tool_choice:'none').
    AGENT_MAX_STEPS: Number(process.env.AGENT_MAX_STEPS ?? 8),
    // Deep-research MODE (the composer toggle): a research turn gets a higher
    // step ceiling + tool-result budget factor so the agent can read many page
    // slices/subpages before drafting cards. Both optional.
    RESEARCH_MAX_STEPS: Number(process.env.RESEARCH_MAX_STEPS ?? 16),
    RESEARCH_TOOL_RESULT_BUDGET_FACTOR: Number(
      process.env.RESEARCH_TOOL_RESULT_BUDGET_FACTOR ?? 16,
    ),
    // Per-web_search-call hard timeout (ms) via AbortController so one tool call
    // can't stall the SSE stream.
    WEB_SEARCH_TIMEOUT_MS: Number(process.env.WEB_SEARCH_TIMEOUT_MS ?? 7000),
    // Per-`role:tool` content cap (chars) — bounds how much a single tool result
    // can grow the context window; the loop also tracks the cross-turn total.
    TOOL_RESULT_MAX_CHARS: Number(process.env.TOOL_RESULT_MAX_CHARS ?? 4000),
    // ── Agentic-environment tunables (all OPTIONAL) ──────────────────────────
    // Kill-switch for `stream_options: { include_usage: true }` — some
    // OpenAI-compatible gateways reject unknown params. 'false' ⇒ no usage
    // accounting (frames/columns simply stay absent — degrade, never crash).
    CHAT_STREAM_USAGE: process.env.CHAT_STREAM_USAGE ?? 'true',
    // Auto-title generation timeout (ms). On timeout/error the turn completes
    // without a `title` frame; the next turn retries (gate is `title IS NULL`).
    // 10 s default: slow self-hosted gateways routinely take >5 s per completion.
    CHAT_TITLE_TIMEOUT_MS: Number(process.env.CHAT_TITLE_TIMEOUT_MS ?? 10000),
    // Context auto-compression: when a conversation exceeds THRESHOLD rows,
    // turns older than the last KEEP rows are replaced by a model-generated
    // summary (cached on the conversation row). Summarizer failure ⇒ verbatim
    // history (current behavior).
    CHAT_COMPRESS_THRESHOLD: Number(process.env.CHAT_COMPRESS_THRESHOLD ?? 80),
    CHAT_COMPRESS_KEEP: Number(process.env.CHAT_COMPRESS_KEEP ?? 30),
    CHAT_SUMMARY_TIMEOUT_MS: Number(process.env.CHAT_SUMMARY_TIMEOUT_MS ?? 8000),
    // Vision kill-switch: 'false' hides the image-attachment affordance and
    // replays images as text placeholders (for gateways/models that reject
    // multimodal `image_url` content parts). Text-file attachments are
    // unaffected — they never need vision.
    CHAT_VISION: process.env.CHAT_VISION ?? 'true',
    // ── NotebookLM sources (M1) — all OPTIONAL ───────────────────────────────
    // Per-file caps. A book PDF/EPUB is ~5–50 MB; default 25 MB. The chunk cap
    // bounds the paid-embedding cost of one source (worker → status='error',
    // error_code='too_many_chunks' when exceeded — degrade, never crash).
    MAX_SOURCE_BYTES: Number(process.env.MAX_SOURCE_BYTES ?? 25 * 1024 * 1024),
    MAX_SOURCE_CHUNKS: Number(process.env.MAX_SOURCE_CHUNKS ?? 1500),
    // Aggregate caps — bound the paid-embedding DoS surface (one user uploading
    // dozens of books). Enforced at the create/finalize routes (clean error).
    MAX_SOURCES_PER_NOTEBOOK: Number(process.env.MAX_SOURCES_PER_NOTEBOOK ?? 50),
    MAX_NOTEBOOKS_PER_USER: Number(process.env.MAX_NOTEBOOKS_PER_USER ?? 25),
    // ── Library (L1) — all OPTIONAL ──────────────────────────────────────────
    // Total library size per user (sources, excluding `deleting`) — the global
    // upload DoS bound (per-notebook caps don't bound the whole library now that
    // sources are user-level). Over it ⇒ 409 `library_full`.
    MAX_LIBRARY_ITEMS_PER_USER: Number(process.env.MAX_LIBRARY_ITEMS_PER_USER ?? 300),
    // Max source ids one attach call may add to a notebook (→ 400 too_many_sources).
    MAX_ATTACH_BATCH: Number(process.env.MAX_ATTACH_BATCH ?? 20),
    // GET /library cursor page size (max 200).
    LIBRARY_PAGE: Number(process.env.LIBRARY_PAGE ?? 60),
    // Ingest worker tuning. Serial by default so a 1500-chunk book doesn't fan
    // out hundreds of concurrent embed calls (mirrors index-queue DRAIN cap).
    SOURCE_INGEST_CONCURRENCY: Number(process.env.SOURCE_INGEST_CONCURRENCY ?? 1),
    // Document chunker window (token target + fractional overlap). chars/4 token
    // heuristic; overlap clamped to [0, 0.5] in the chunker.
    SOURCE_CHUNK_TOKENS: Number(process.env.SOURCE_CHUNK_TOKENS ?? 800),
    SOURCE_CHUNK_OVERLAP: Number(process.env.SOURCE_CHUNK_OVERLAP ?? 0.12),
    // Max total decompressed bytes for an EPUB archive (zip-bomb guard). Default 200 MB.
    MAX_SOURCE_DECOMPRESSED_BYTES: Number(process.env.MAX_SOURCE_DECOMPRESSED_BYTES ?? 200 * 1024 * 1024),
    // ── NotebookLM workspace (M2/M3) — all OPTIONAL ──────────────────────────
    // Max DISTINCT source chunks a created card is provenance-linked to
    // (card_sources rows per card). The turn may ground on more; the link
    // writer keeps the first K in accumulation order (AC3.1).
    CARD_SOURCE_LINK_CAP: Number(process.env.CARD_SOURCE_LINK_CAP ?? 5),
    // Reader pagination: chunks per GET /sources/:id/chunks page (max 200).
    SOURCE_CHUNKS_PAGE: Number(process.env.SOURCE_CHUNKS_PAGE ?? 50),
    // Sequential-reading tool: source chunks per read_source slice.
    READ_SOURCE_CHUNKS: Number(process.env.READ_SOURCE_CHUNKS ?? 3),
    // ── PDF reader annotations (M4) — OPTIONAL ───────────────────────────────
    // Byte cap on one page's ink strokes (JSON.stringify(body.strokes) length).
    // Over it ⇒ PUT 400 `annotation_too_large` (DoS guard alongside the
    // per-page stroke/point caps in @reomi/shared). Default 512 KiB.
    SOURCE_ANNOTATION_MAX_BYTES: Number(
      process.env.SOURCE_ANNOTATION_MAX_BYTES ?? 512 * 1024,
    ),
    // ── «Блокноты 2.0» studio (N2) — all OPTIONAL ────────────────────────────
    // Even, round-robin sample of source chunks fed to ONE artifact-generation
    // `complete()` call (Р4). ~50-60k tokens max at 800-token chunks (Р16).
    ARTIFACT_CONTEXT_CHUNKS: Number(process.env.ARTIFACT_CONTEXT_CHUNKS ?? 60),
    // Per-artifact generation timeout (Promise.race like ai/title.ts). The
    // artifact is an ASYNC job behind status polling, so this bound only guards
    // against zombie `generating` rows — it must be generous: a reasoning-heavy
    // model on a slow self-hosted gateway takes MINUTES to digest a ~50k-token
    // context (a 60s default timed out on every real generation).
    ARTIFACT_TIMEOUT_MS: Number(process.env.ARTIFACT_TIMEOUT_MS ?? 300_000),
    // Throttle for partial-content persistence during STREAMING generation. While
    // the streaming `chatStream` is active, the accumulated raw text is flushed to
    // `content_md` no more often than once per this interval (ms) — the studio's
    // live viewer reads the growing text via status polling, and a 0-row UPDATE
    // (the row was deleted/changed concurrently) aborts the stream (cancel-on-delete).
    ARTIFACT_PROGRESS_FLUSH_MS: Number(process.env.ARTIFACT_PROGRESS_FLUSH_MS ?? 1_500),
    // Notebook overview (Р6) — a smaller, sync single-`complete()` call. Sync
    // means the browser fetch holds — keep tighter than artifacts, but 20s was
    // not enough for reasoning models even at half the context.
    NOTEBOOK_OVERVIEW_TIMEOUT_MS: Number(process.env.NOTEBOOK_OVERVIEW_TIMEOUT_MS ?? 60_000),
    // Per-notebook artifact cap (Р16) → 409 `too_many_artifacts`.
    MAX_ARTIFACTS_PER_NOTEBOOK: Number(process.env.MAX_ARTIFACTS_PER_NOTEBOOK ?? 50),
    // ── «Блокноты 2.0» concept-map (N4 / Р10) — OPTIONAL ─────────────────────
    // Cap on the number of section-nodes the concept-map graph builds before the
    // ANN k-NN-join (even round-robin sample across sources by first_pos). Bounds
    // the LATERAL probe's worst case (sections × ~5 probe chunks × k*2 neighbours).
    CONCEPT_MAP_MAX_SECTIONS: Number(process.env.CONCEPT_MAP_MAX_SECTIONS ?? 60),
  },
};

// ── Derived AI feature flags (decoupled) ─────────────────────────────────────
// `embeddingEnabled` gates the index queue + write-hooks; `chatEnabled` gates
// the SSE stream endpoint. They are INDEPENDENT so indexing can be paused
// without breaking thread reads, and chat works (degraded retrieval) even when
// indexing is off, and vice-versa. `GET /ai/status` reports both.
// Under NODE_ENV=test the flags are FORCED off so the suite's baseline is
// "AI unconfigured" REGARDLESS of what's in the loaded .env (the dev .env may
// hold real keys). Tests enable AI exclusively via the injected fake client
// (`__setAiClientForTests`), and `isEmbeddingEnabled`/`isChatEnabled` OR these
// env flags with the injected client — so forcing false here means the test
// effective-flag is injection-driven, and no test path can make a real API call.
const aiEnvDisabled = env.NODE_ENV === 'test';
export const embeddingEnabled =
  !aiEnvDisabled && Boolean(env.ai.OPENAI_API_KEY) && env.ai.INDEXING_ENABLED !== 'false';
export const chatEnabled = !aiEnvDisabled && Boolean(env.ai.CHAT_API_KEY);
// Gates whether the `web_search` tool is OFFERED to the model. Decoupled from
// chat: no search key ⇒ tool not in the registry, chat works unchanged.
// Forced off under test like the others; a fake provider flips it on via the
// `__setWebSearchProviderForTests` seam (mirrors the isChatEnabled pattern).
// Either provider key enables it (Exa preferred at provider-selection time).
export const webSearchEnabled =
  !aiEnvDisabled && Boolean(env.ai.BRAVE_SEARCH_API_KEY || env.ai.EXA_API_KEY);
// Gates the `fetch_page` tool (deep research). On by default — the direct
// SSRF-guarded fetcher needs no key; `CHAT_FETCH_PAGE='false'` turns it off.
// Forced off under test; a fake reader flips it on via
// `__setPageReaderForTests` (page-reader.ts).
export const fetchPageEnabled = !aiEnvDisabled && env.ai.CHAT_FETCH_PAGE !== 'false';
// Historical notebook indexing capability, retained for API compatibility.
// It follows embedding readiness; ingest can still parse-and-park without it.
// Manual notebook organization and full source reading must not use this flag
// as a screen-wide gate. Individual AI features expose their own availability.
// Forced off under test like the others (embeddingEnabled already is).
export const notebooksEnabled = embeddingEnabled;
