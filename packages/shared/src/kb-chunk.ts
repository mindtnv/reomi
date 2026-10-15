// Shared chunker interfaces + types for the RAG knowledge-base pipeline.
// Pure TS — no DOM, no Node-only APIs — imported by both apps/api and apps/web.

// ── Source input ────────────────────────────────────────────────────────────
// Describes the raw source that the chunker will split into one-or-more chunks.
// `sourceType` widens as new source types are added (AC7 seam).

export interface SourceInput {
  /** Source category. 'card' (single-chunk) or 'document' (multi-chunk window). */
  sourceType: 'card' | 'document';
  /** Primary key of the source entity (cards.id for 'card', sources.id for 'document'). */
  sourceId: string;
  /**
   * Navigable parent id — same as sourceId for BOTH cards and documents.
   * (Documents carried the notebook id before the library refactor; sources are
   * user-level now, so the column keeps its NOT NULL with the card convention.)
   */
  parentId: string;
  /** Raw text to chunk (card path: cards.render_text). Ignored on the document path (use `units`). */
  text: string;
  /**
   * Document path only: parsed units (text + page/heading) produced by a parser.
   * The chunker token-windows ACROSS units, preserving the leading unit's
   * page/heading on each emitted chunk.
   */
  units?: SourceUnit[];
  /** Document path only: chunking config (token target + overlap). */
  chunkOptions?: DocumentChunkOptions;
  /** Arbitrary metadata for filter + citation display (deckId, noteId, tags, …). */
  meta?: Record<string, string>;
}

/** One parsed unit of a document (a PDF page, an EPUB chapter, a text blob). */
export interface SourceUnit {
  text: string;
  /** 1-based PDF page (when known). */
  page?: number;
  /** EPUB chapter / section heading (when known). */
  heading?: string;
}

/** Document chunking configuration. */
export interface DocumentChunkOptions {
  /** Target tokens per chunk (~chars/4 heuristic). Default 800. */
  tokensPerChunk?: number;
  /** Fractional overlap between adjacent chunks, clamped to [0, 0.5]. Default 0.12. */
  overlap?: number;
}

// ── Chunk output ────────────────────────────────────────────────────────────
// One unit of embeddable content. Retrieval + chat code reads only these generic
// fields, so adding a new source type never touches retrieval/chat core.

export interface KbChunkInput {
  sourceType: string;
  sourceId: string;
  parentId: string;
  /** 0-based position within the source. Always 0 for single-chunk cards. */
  position: number;
  text: string;
  /** Document path: 1-based source page (when known). */
  page?: number;
  /** Document path: source heading (when known). */
  heading?: string;
  /** Estimated token count for the chunk (chars/4 heuristic). */
  tokenCount?: number;
  meta?: Record<string, string>;
}

// ── Chunker ────────────────────────────────────────────────────────────────
// card → exactly 1 chunk at position 0 (text = full render_text, no split).
// document → token-windowed multi-chunk over the parsed `units`, with overlap,
// preserving each window's leading page/heading. Pure TS (no tokenizer dep) —
// token estimate is a cheap chars/4 heuristic (deterministic, tested).

/** Cheap token estimate — chars/4, min 1 for non-empty text. */
export function estimateTokens(text: string): number {
  const n = text.trim().length;
  return n === 0 ? 0 : Math.max(1, Math.ceil(n / 4));
}

export function chunkSource(input: SourceInput): KbChunkInput[] {
  if (input.sourceType === 'card') {
    return [
      {
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        parentId: input.parentId,
        position: 0,
        text: input.text,
        meta: input.meta,
      },
    ];
  }
  if (input.sourceType === 'document') {
    return chunkDocument(input);
  }
  throw new Error('not_implemented');
}

const DEFAULT_TOKENS_PER_CHUNK = 800;
const DEFAULT_OVERLAP = 0.12;

/**
 * Token-window the document's units into chunks. Units are concatenated in order;
 * a chunk closes once it reaches `tokensPerChunk` (estimated), then the next chunk
 * re-includes a trailing `overlap` fraction of the previous chunk's text for
 * context continuity. Each chunk carries the page/heading of its FIRST contributing
 * unit. Empty units are skipped; a single oversized unit becomes its own chunk
 * (and is split on whitespace if it alone exceeds the target).
 */
function chunkDocument(input: SourceInput): KbChunkInput[] {
  const units = (input.units ?? []).filter((u) => u.text.trim().length > 0);
  const target = Math.max(1, input.chunkOptions?.tokensPerChunk ?? DEFAULT_TOKENS_PER_CHUNK);
  const overlap = Math.min(0.5, Math.max(0, input.chunkOptions?.overlap ?? DEFAULT_OVERLAP));
  const out: KbChunkInput[] = [];

  // Flatten units into segments, splitting any single oversized unit on paragraph
  // / whitespace boundaries so one giant unit can't produce a multi-target chunk.
  type Seg = { text: string; page?: number; heading?: string };
  const segs: Seg[] = [];
  for (const u of units) {
    if (estimateTokens(u.text) <= target) {
      segs.push({ text: u.text.trim(), page: u.page, heading: u.heading });
      continue;
    }
    for (const piece of splitToTarget(u.text, target)) {
      segs.push({ text: piece, page: u.page, heading: u.heading });
    }
  }

  let buf: string[] = [];
  let bufTokens = 0;
  let page: number | undefined;
  let heading: string | undefined;
  let position = 0;

  const flush = () => {
    if (buf.length === 0) return;
    const text = buf.join('\n\n').trim();
    if (text.length === 0) {
      buf = [];
      bufTokens = 0;
      return;
    }
    out.push({
      sourceType: 'document',
      sourceId: input.sourceId,
      parentId: input.parentId,
      position,
      text,
      page,
      heading,
      tokenCount: estimateTokens(text),
      meta: input.meta,
    });
    position += 1;
    // Seed the next buffer with a trailing overlap slice of this chunk's text.
    if (overlap > 0) {
      const keepChars = Math.floor(text.length * overlap);
      const tail = keepChars > 0 ? text.slice(text.length - keepChars) : '';
      buf = tail ? [tail] : [];
      bufTokens = tail ? estimateTokens(tail) : 0;
    } else {
      buf = [];
      bufTokens = 0;
    }
    // page/heading reset to the next contributing seg.
    page = undefined;
    heading = undefined;
  };

  for (const seg of segs) {
    if (buf.length === 0 || (page === undefined && heading === undefined)) {
      if (page === undefined) page = seg.page;
      if (heading === undefined) heading = seg.heading;
    }
    buf.push(seg.text);
    bufTokens += estimateTokens(seg.text);
    if (bufTokens >= target) flush();
  }
  flush();
  return out;
}

/** Split an oversized unit into ~target-token pieces on whitespace boundaries. */
function splitToTarget(text: string, target: number): string[] {
  const words = text.trim().split(/\s+/);
  const pieces: string[] = [];
  let cur: string[] = [];
  let curTokens = 0;
  for (const w of words) {
    const t = estimateTokens(w) + 1; // +1 for the join space
    if (curTokens + t > target && cur.length > 0) {
      pieces.push(cur.join(' '));
      cur = [];
      curTokens = 0;
    }
    cur.push(w);
    curTokens += t;
  }
  if (cur.length > 0) pieces.push(cur.join(' '));
  return pieces;
}

// ── Citation ────────────────────────────────────────────────────────────────
// Resolved source reference attached to an assistant message. A discriminated
// union: card citations (the original RAG shape — persisted rows predate `kind`,
// so its ABSENCE means 'card') and document-source citations (NotebookLM M2 —
// a passage of an ingested source, addressable down to the source_chunk).

export interface CardCitation {
  /** Discriminant. Optional for backward compat: persisted legacy rows have no
   *  `kind` — absence means 'card'. Use `isSourceCitation()` to narrow. */
  kind?: 'card';
  cardId: string;
  chunkId: string;
  deckId?: string;
  snippet?: string;
}

/** A grounded-chat citation of a notebook source passage (M2). The web chip
 *  opens the workspace reader scrolled to `position`; provenance (M3) links
 *  created cards to the same `sourceChunkId`. */
export interface SourceCitation {
  kind: 'source';
  sourceId: string;
  sourceChunkId: string;
  notebookId?: string;
  /** 0-based chunk position within the source — the reader's scroll anchor. */
  position?: number;
  /** 1-based source page (PDF), when known. */
  page?: number;
  sourceTitle?: string;
  snippet?: string;
}

export type Citation = CardCitation | SourceCitation;

/** Narrow a Citation to the source variant (legacy rows lack `kind` = card). */
export function isSourceCitation(c: Citation): c is SourceCitation {
  return c.kind === 'source';
}

/**
 * Grounding snapshot persisted on the pending assistant tool_calls row of a
 * SUSPENDED notebook create_card turn (messages.grounding jsonb): the distinct
 * source_chunk ids the turn read via search_source/read_source, in accumulation
 * order. Server-side auto-provenance (M3) links created cards to these chunks.
 */
export interface MessageGrounding {
  version?: 1;
  evidence?: import('./card-evidence').ChunkCardEvidenceSnapshot[];
  chunkIds: string[];
}

// ── SSE event types (Slice 4 server ↔ Slice 5 client) ──────────────────────
// The streaming chat endpoint emits a discriminated union of these frames.
// Both ends import from here so there is one source of truth.

/** Request body for POST /chat/conversations/:id/stream */
export interface ChatStreamRequest {
  policySelection?: import('./assistant-context').AssistantContextPolicy;
  content: string;
  context?: import('./assistant-context').AssistantContextInput;
  expectedContextRevision?: number;
  /** Optional model id; validated server-side against the CHAT_MODELS allow-list. */
  model?: string;
  /** Optional per-turn deck scope (AC3.7) — constrains card retrieval to a deck (subtree). */
  deckId?: string;
  /** Deep-research MODE (composer toggle): research prompt + raised step/budget caps. */
  research?: boolean;
  /**
   * Cards the user explicitly attached via composer @-mentions (max 8).
   * Resolved server-side (user-scoped; foreign/missing ids silently dropped),
   * persisted on the user row's `mentions` jsonb, and injected into the
   * model-facing content as a `<mentioned_cards>` block at history-build time —
   * the STORED content stays clean for display.
   */
  mentionedCardIds?: string[];
  /**
   * Composer file attachments (max 4 per message). Images reference an
   * already-uploaded media object by id ONLY — token/mime are resolved
   * server-side from the user-scoped `media` row (never trusted from the
   * client). Text files carry their (client-truncated) content inline; the
   * server re-caps it. Persisted on the user row's `attachments` jsonb; the
   * model sees images as multimodal `image_url` parts and text files as an
   * `<attached_file>` block — the STORED content stays clean.
   */
  attachments?: MessageAttachmentInput[];
  /**
   * Notebook workspace only (M2): the per-turn SOURCE scope — which of the
   * notebook's sources are checked into the chat. The NOTEBOOK itself is
   * derived from the conversation row server-side (never from the body); these
   * ids are INTERSECTED with the notebook's own ready sources (foreign ids
   * silently dropped). Absent ⇒ all ready sources of the notebook.
   */
  sourceIds?: string[];
}

/** Wire shape of one composer attachment (client → server). */
export type MessageAttachmentInput =
  | { kind: 'image'; mediaId: string; name?: string }
  | { kind: 'text'; name: string; text: string };

/**
 * One persisted attachment on a user message row (server-resolved snapshot).
 * `token` is the stored `/m/<uuid>` path. It is not a public object URL;
 * the web client resolves it to the session-checked media route at render time.
 */
export type MessageAttachment =
  | { kind: 'image'; mediaId: string; token: string; mime: string; name?: string }
  | { kind: 'text'; name: string; text: string };

/**
 * Token usage for one persisted assistant turn, as reported by the gateway's
 * `stream_options: { include_usage: true }` final chunk. Accumulated across all
 * steps of an agentic turn. Absent (null column) when the provider omits usage.
 */
export interface MessageUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * One composer @-mention persisted on a user message row. `front` is a snapshot
 * excerpt taken at send time (a later card edit does NOT rewrite chat history —
 * deterministic replay wins over freshness).
 */
export interface MessageMention {
  cardId: string;
  front: string;
  deckName?: string;
}

/**
 * Blast radius + previews for a paused write/SRS tool call (the
 * `await_confirmation` frame and the tools' `dryRun()` output share this shape
 * via the `ToolImpact` alias in apps/api). All fields optional — SRS tools emit
 * no impact at all (frame carries `impact: undefined`).
 */
export interface ConfirmImpact {
  /** Server consistency token; never supplied by the model. */
  confirmationToken?: string;
  /** Server-generated fingerprint for stale-approval checks, never model-authored. */
  snapshotHash?: string;
  resourcePreview?: {
    title?: string;
    fields: { field: string; before?: string; after?: string }[];
    affected?: { kind: string; count: number }[];
    retained?: { kind: string; count: number }[];
    destructive?: boolean;
  };

  willDeleteCards?: number;
  willCreateCards?: number;
  affectsSiblings?: boolean;
  /** edit_card: changed fields only; values capped ~300 chars, whitespace-collapsed. */
  fieldDiffs?: { field: string; before: string; after: string }[];
  /** edit_card: full before/after tag lists when `tags` is part of the proposal. */
  tagsChange?: { before: string[]; after: string[] };
  /** edit_card: deck move target (args-only — no DB read in this branch). */
  deckChange?: { toDeckId: string };
  /** edit_card: proposed `suspended` value when part of the args. */
  suspendedChange?: boolean;
  /** create_card: proposed field values (capped ~300 chars each). */
  cardEvidence?: import('./card-evidence').CardEvidenceSnapshot[][];
  proposedFields?: { field: string; value: string }[];
  /**
   * create_card batch (`cards: [...]`): per-card proposed field values, one entry
   * per card in batch order. Single-card calls keep using `proposedFields`.
   */
  proposedCards?: { fields: { field: string; value: string }[] }[];
  /**
   * Notebook create_card (M3 / AC3.2): the source passages the new card(s) will
   * be LINKED to (server-side auto-provenance) — previewed on the confirm card
   * («Источник: <title>, p.N»). Resolved by the loop from the turn's grounding
   * accumulator (capped CARD_SOURCE_LINK_CAP), NOT by the tool's dryRun.
   */
  provenance?: { sourceTitle: string; page?: number; chunkId: string }[];
  /**
   * Notebook save_note (Р14 / N3): the note the agent proposes to save — title +
   * a capped content excerpt — previewed on a FLAT confirm card (NOT the create_card
   * wizard). Set by the save_note tool's dryRun; the web `confirm-diff` renders it
   * as its own branch.
   */
  proposedNote?: { title: string; contentExcerpt: string };
}

/**
 * Request body for POST /chat/conversations/:id/resume — answers a paused
 * write/SRS tool call (the `await_confirmation` frame). `decision: 'apply'`
 * executes the pending mutation + continues the loop; `'reject'` records a
 * "user rejected" tool result so the model can answer without mutating.
 * `model?` carries the user's current selection so the continuation stays
 * consistent with their choice (AC2.5).
 */
export interface ChatResumeRequest {
  resumeToolCallId: string;
  decision: 'apply' | 'reject';
  model?: string;
  /** Deep-research mode toggle state — keeps a research turn's continuation
   *  on the raised caps + research prompt. */
  research?: boolean;
  /**
   * Per-card decisions for a pending `create_card` confirm (apply path):
   * `index` addresses the proposed card (batch order; a single-card proposal is
   * index 0), `include:false` drops it, `fieldValues` overrides its content
   * (inline edit). Unmentioned indexes apply as proposed. ALL excluded ⇒ the
   * apply degrades to a reject. Ignored for other tools.
   */
  cardSelections?: { index: number; include: boolean; fieldValues?: Record<string, string> }[];
  /**
   * Optional user note passed through to the MODEL in the tool result (both
   * apply and reject) — "propose edits" without applying anything.
   */
  feedback?: string;
  /** Notebook workspace only (M2): per-turn source scope for the CONTINUATION
   *  (same semantics as ChatStreamRequest.sourceIds). */
  sourceIds?: string[];
}

/**
 * One allow-listed chat model surfaced by GET /ai/status + consumed by the web
 * picker. Derived from the CSV `CHAT_MODELS` env (`model[|label]`, first=default).
 * NOT a secret — only `{ id, label, default }` ever leaves the server.
 */
export interface ChatModelOption {
  id: string;
  label: string;
  default: boolean;
}

/**
 * One streamed tool call as the gateway/agent loop assembled it. `arguments` is
 * the raw JSON string the model emitted (parsed at execute time) — matches the
 * OpenAI wire shape so a persisted row replays straight back into `messages[]`.
 */
export interface ToolCallRecord {
  impact?: ConfirmImpact;
  id: string;
  name: string;
  arguments: string;
  confirmationToken?: string;
}

/** Discriminated union of SSE frames emitted by the chat stream endpoint. */
export type ChatStreamEvent =
  | { type: 'context'; context: import('./assistant-context').AssistantContextSnapshot }
  | { type: 'token'; delta: string }
  | { type: 'citation'; citations: Citation[] }
  | { type: 'done'; messageId: string }
  | { type: 'error'; message: string }
  | { type: 'reasoning'; delta: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown; status: 'running' }
  | { type: 'tool_result'; id: string; ok: boolean; summary?: string; citations?: Citation[] }
  | { type: 'status'; phase: 'thinking' | 'calling_tool' | 'answering' }
  // Auto-generated thread title (first turn of an untitled conversation).
  // Emitted before `done`; older clients ignore unknown frames.
  | { type: 'title'; title: string }
  // Accumulated token usage for the turn. Emitted before `done`; absent
  // entirely when the provider reports no usage.
  | { type: 'usage'; promptTokens: number; completionTokens: number; totalTokens?: number }
  | {
      type: 'await_confirmation';
      toolCall: { id: string; name: string; args: unknown };
      impact?: ConfirmImpact;
    };

// ── Model-emitted card-citation token ────────────────────────────────────────
// The grounded chat model marks the cards it cites inline as `[card:<uuid>]`.
// Shared between the server (citation union-dedup — intersect with the tokens
// the answer actually emitted) and the web client (chat.tsx, which wraps this in
// a local whitespace-absorbing variant for stripping the token from rendered
// prose). Capture group 1 = the cardId. `g` flag — reset `lastIndex` or use a
// fresh literal when matching repeatedly.
export const CARD_TOKEN_RE = /\[card:([0-9a-fA-F-]+)\]/g;

// ── Model-emitted source-citation token (NotebookLM M2) ──────────────────────
// The source-grounded chat model marks the passages it cites inline as
// `[src:<sourceChunkId>]` — the document analog of `[card:<id>]`. Shared
// between the server (citation intersect/dedup) and the web client (token
// stripping + chip rendering). Capture group 1 = the sourceChunkId. `g` flag —
// reset `lastIndex` or use a fresh literal when matching repeatedly.
export const SRC_TOKEN_RE = /\[src:([0-9a-fA-F-]+)\]/g;
