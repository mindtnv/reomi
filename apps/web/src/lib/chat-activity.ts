// Pure helper module for the Codex-like condensed agent transcript (chat redesign).
//
// This module holds ALL pure, React-free logic the chat screen needs so it can be
// unit-tested via `bun test` (this repo has no chat component-render harness — see
// the plan, Principle P3). The chat screen (`chat.tsx`) re-imports the moved types
// + helpers and wires them into JSX.
//
// MOVED here (one definition each, no type split): the view-model + persisted-row
// TYPES (`MessageVM`, `ToolCallVM`, `PersistedMessageRow`) and the pure
// reconstruction/parse helpers (`reconstructMessages`, `parseToolArgs`,
// `parseToolResultContent`, `hasAnswerlessUserTail`, `WRITE_SRS_TOOL_NAMES`,
// `TOOL_LABEL_KEY`).
//
// NEW pure functions for the redesign: `toolLabel`, `formatElapsed`,
// `summarizeSteps`, `groupHeaderState`, `applySummaryFrom`, `dropTrailingExchange`,
// `TOOL_ICON_KEY`.

import type {
  Citation,
  ConfirmImpact,
  MessageAttachment,
  MessageMention,
  MessageUsage,
} from '@reomi/shared';
import type { IconName } from '@/components/ui';

// ── View models (Eden serializes dates → ISO strings) ────────────────────────

// One agentic tool call surfaced in the stream. `args` is the parsed (or raw)
// argument object the model emitted; `result` is a one-line summary for the
// collapsible body; `citations` are the cited cards (search_cards only) / web
// results (web_search only) attached after the tool resolves.
export interface ToolCallVM {
  id: string;
  name: string;
  args: unknown;
  status: 'running' | 'ok' | 'error';
  /** One-line human summary from the tool_result frame (optional). */
  result?: string;
  /** Cited cards for search_cards (rendered via RichCard — the only card sink). */
  citations?: Citation[];
  // ── Phase B: confirm-before-write (S10) ────────────────────────────────────
  /**
   * True while this write/SRS tool call is paused awaiting human approval (the
   * `await_confirmation` frame arrived and the stream closed with no `done`).
   * The card renders Apply/Reject controls + the blast-radius summary.
   */
  awaitingConfirmation?: boolean;
  /**
   * Dry-run blast radius + confirm previews (C8: fieldDiffs / proposedFields /
   * tagsChange / deckChange / suspendedChange) from the `await_confirmation` frame.
   */
  impact?: ConfirmImpact;
  /**
   * The decision the user picked, once clicked. Set IMMEDIATELY on click so both
   * buttons disable and a double-apply can't be issued from the UI side (the
   * server has its own atomic backstop, but this prevents the second request).
   */
  decision?: 'apply' | 'reject';
  // ── Codex-like redesign (ephemeral; never persisted, not on the wire) ───────
  /** Wall-clock ms when `onToolCall` fired for this step. */
  startedAt?: number;
  /** Wall-clock ms span from `startedAt` to `onToolResult` (stamped, NOT rendered). */
  durationMs?: number;
  /** Post-apply write summary (create/edit), rendered as a single line in the step body. */
  applySummary?: ApplySummary;
}

export interface MessageVM {
  id: string;
  // `tool` only appears on reload reconstruction — a persisted role:'tool' row is
  // folded into its parent assistant message's toolCalls, never rendered as its
  // own bubble (see openThread reconstruction rule).
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  citations: Citation[];
  /** Streamed reasoning trace for this assistant turn (ephemeral, never persisted). */
  reasoning?: string;
  /** Tool calls made during this assistant turn, in call order. */
  toolCalls?: ToolCallVM[];
  /** True while tokens are still streaming into this assistant message. */
  streaming?: boolean;
  /** ISO createdAt of the persisted row — surfaced as a hover title on the message timestamp. */
  createdAt?: string;
  // ── Codex-like redesign timing (T-accumulate single-stamp; ephemeral) ───────
  /** Wall-clock ms stamped ONCE when this turn's host placeholder is created. */
  turnStartedAt?: number;
  /** Computed turn duration: `Date.now() - turnStartedAt`, set only at onDone/onError. */
  elapsedMs?: number;
  // ── Agentic-environment additions ────────────────────────────────────────────
  /** Accumulated token usage for a finished assistant turn (C1; persisted row / usage frame). */
  usage?: MessageUsage;
  /** Effective model for an assistant turn (C1; the picker choice or env default). */
  model?: string;
  /** Composer @-mentions on a user message (C7) — rendered as chips under the bubble. */
  mentions?: MessageMention[];
  context?: import('@reomi/shared').AssistantContextSnapshot;
  /** Composer attachments on a user message — image previews + file chips. */
  attachments?: MessageAttachment[];
}

// Persisted-row wire shape (Eden serializes message rows verbatim).
export interface PersistedMessageRow {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  citations?: Citation[] | null;
  toolCalls?: { id: string; name: string; arguments: string; impact?: ConfirmImpact }[] | null;
  toolCallId?: string | null;
  createdAt?: string | null;
  usage?: MessageUsage | null;
  model?: string | null;
  mentions?: MessageMention[] | null;
  context?: import('@reomi/shared').AssistantContextSnapshot | null;
  attachments?: MessageAttachment[] | null;
}

// ── Tool label / icon maps ────────────────────────────────────────────────────

// Per-tool verb-phrase label key (single source — NO `chat.tool.label.*` split).
export const TOOL_LABEL_KEY: Record<string, string> = {
  get_capabilities: 'chat.tool.get_capabilities',
  list_cards: 'chat.tool.list_cards',
  list_tags: 'chat.tool.list_tags',
  get_review_queue: 'chat.tool.get_review_queue',
  get_card_sources: 'chat.tool.get_card_sources',
  get_similar_cards: 'chat.tool.get_similar_cards',
  get_semantic_graph: 'chat.tool.get_semantic_graph',
  list_note_types: 'chat.tool.list_note_types',
  list_deck_options: 'chat.tool.list_deck_options',
  list_filtered_decks: 'chat.tool.list_filtered_decks',
  get_retention: 'chat.tool.get_retention',
  list_library: 'chat.tool.list_library',
  search_library: 'chat.tool.search_library',
  get_library_item: 'chat.tool.get_library_item',
  read_source_chunks: 'chat.tool.read_source_chunks',
  read_source: 'chat.tool.read_source',
  search_source: 'chat.tool.search_source',
  list_marked_passages: 'chat.tool.list_marked_passages',
  get_source_cards: 'chat.tool.get_source_cards',
  get_source_marks: 'chat.tool.get_source_marks',
  get_source_annotations: 'chat.tool.get_source_annotations',
  list_notebooks: 'chat.tool.list_notebooks',
  get_notebook: 'chat.tool.get_notebook',
  list_notebook_sources: 'chat.tool.list_notebook_sources',
  list_notebook_notes: 'chat.tool.list_notebook_notes',
  list_artifacts: 'chat.tool.list_artifacts',
  get_artifact: 'chat.tool.get_artifact',
  list_quiz_attempts: 'chat.tool.list_quiz_attempts',
  get_notebook_coverage: 'chat.tool.get_notebook_coverage',
  get_concept_map: 'chat.tool.get_concept_map',
  create_deck: 'chat.tool.create_deck',
  update_deck: 'chat.tool.update_deck',
  delete_deck: 'chat.tool.delete_deck',
  create_notebook: 'chat.tool.create_notebook',
  update_notebook: 'chat.tool.update_notebook',
  delete_notebook: 'chat.tool.delete_notebook',
  update_note: 'chat.tool.update_note',
  delete_note: 'chat.tool.delete_note',
  attach_source: 'chat.tool.attach_source',
  detach_source: 'chat.tool.detach_source',
  update_source: 'chat.tool.update_source',
  set_reading_status: 'chat.tool.set_reading_status',
  delete_card: 'chat.tool.delete_card',
  delete_flashcard_note: 'chat.tool.delete_flashcard_note',
  create_text_source: 'chat.tool.create_text_source',
  create_url_source: 'chat.tool.create_url_source',
  list_notes: 'chat.tool.list_notes',
  read_note: 'chat.tool.read_note',
  read_context_object: 'chat.tool.read_context_object',
  list_source_notes: 'chat.tool.list_source_notes',
  get_source_note: 'chat.tool.get_source_note',
  list_source_artifacts: 'chat.tool.list_source_artifacts',
  get_source_artifact: 'chat.tool.get_source_artifact',
  list_source_quiz_attempts: 'chat.tool.list_source_quiz_attempts',

  search_cards: 'chat.tool.search_cards',
  web_search: 'chat.tool.web_search',
  card_progress: 'chat.tool.card_progress',
  study_stats: 'chat.tool.study_stats',
  due_forecast: 'chat.tool.due_forecast',
  list_decks: 'chat.tool.list_decks',
  browse_cards: 'chat.tool.browse_cards',
  get_card: 'chat.tool.get_card',
  fetch_page: 'chat.tool.fetch_page',
  // Write/SRS tools (B5) — previously fell back to the raw key string.
  create_card: 'chat.tool.create_card',
  edit_card: 'chat.tool.edit_card',
  suspend: 'chat.tool.suspend',
  set_due: 'chat.tool.set_due',
  forget: 'chat.tool.forget',
  // Notebook write tool (Р14 / N3) — saves a note into the notebook.
  save_note: 'chat.tool.save_note',
  save_source_note: 'chat.tool.save_source_note',
};

// Tool names that have a `chat.tool.<name>_n` plural key for contiguous-run header
// phrases (AC2.2: "Reviewed 7 cards"). Single source — `ToolActivityGroup` imports
// this instead of maintaining a local Set.
export const PLURAL_TOOL_NAMES = new Set([
  'get_card',
  'card_progress',
  'browse_cards',
  'due_forecast',
  'fetch_page',
]);

// Tool-type icon map (AC3.1) — parallel to TOOL_LABEL_KEY. Reuses existing
// NNIcon names only (no new icons). Default fallback is `bolt`.
export const TOOL_ICON_KEY: Record<string, IconName> = {
  get_capabilities: 'settings',
  list_cards: 'cards',
  list_tags: 'tag',
  get_review_queue: 'clock',
  get_card_sources: 'doc',
  get_similar_cards: 'cards',
  get_semantic_graph: 'graph',
  list_note_types: 'grid',
  list_deck_options: 'settings',
  list_filtered_decks: 'filter',
  get_retention: 'chart',
  list_library: 'library',
  search_library: 'search',
  get_library_item: 'doc',
  read_source_chunks: 'doc',
  read_source: 'doc',
  search_source: 'search',
  list_marked_passages: 'edit',
  get_source_cards: 'cards',
  get_source_marks: 'edit',
  get_source_annotations: 'edit',
  list_notebooks: 'notebook',
  get_notebook: 'notebook',
  list_notebook_sources: 'library',
  list_notebook_notes: 'note',
  list_artifacts: 'doc',
  get_artifact: 'doc',
  list_quiz_attempts: 'chart',
  get_notebook_coverage: 'cards',
  get_concept_map: 'graph',
  create_deck: 'plus',
  update_deck: 'edit',
  delete_deck: 'x',
  create_notebook: 'notebook',
  update_notebook: 'edit',
  delete_notebook: 'x',
  update_note: 'edit',
  delete_note: 'x',
  attach_source: 'plus',
  detach_source: 'x',
  update_source: 'edit',
  set_reading_status: 'check',
  delete_card: 'x',
  delete_flashcard_note: 'x',
  create_text_source: 'doc',
  create_url_source: 'link',
  list_notes: 'note',
  read_note: 'note',
  read_context_object: 'doc',
  list_source_notes: 'doc',
  get_source_note: 'doc',
  list_source_artifacts: 'doc',
  get_source_artifact: 'doc',
  list_source_quiz_attempts: 'doc',

  get_card: 'brain',
  card_progress: 'brain',
  list_decks: 'stack',
  browse_cards: 'stack',
  study_stats: 'target',
  due_forecast: 'target',
  web_search: 'link',
  fetch_page: 'doc',
  search_cards: 'search',
  create_card: 'plus',
  edit_card: 'edit',
  suspend: 'pause',
  set_due: 'clock',
  forget: 'sync',
  save_note: 'doc',
  save_source_note: 'doc',
};

/** Resolve a tool's icon, falling back to `bolt` for unknown tool names. */
export function toolIcon(name: string): IconName {
  return TOOL_ICON_KEY[name] ?? 'bolt';
}

// ── Parse helpers (MOVED from chat.tsx) ──────────────────────────────────────

// Parse a persisted `role:'tool'` row's `content` into a UI status + summary.
// The backend stores the tool's model-facing TEXT on success (plain, capped) and
// `JSON.stringify({ ok:false, error })` on failure — so a JSON `{ ok:false }`
// payload is a failed call, anything else is a successful text result.
export function parseToolResultContent(content: string): { ok: boolean; summary?: string } {
  if (content.length === 0) return { ok: true };
  try {
    const parsed = JSON.parse(content) as { ok?: boolean; error?: string; summary?: string };
    // A structured failure envelope from the loop.
    if (parsed && typeof parsed === 'object' && parsed.ok === false) {
      const summary =
        typeof parsed.error === 'string'
          ? parsed.error
          : typeof parsed.summary === 'string'
            ? parsed.summary
            : undefined;
      return { ok: false, summary };
    }
    // JSON but not a failure envelope — fall through to treat as text below.
  } catch {
    // Not JSON — the common case (success text). Fall through.
  }
  return { ok: true, summary: content };
}

export function parseToolArgs(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// Write/SRS tool names — these PAUSE the loop for human approval (Phase B).
// `save_note` (notebook mode, Р14) joins them: it confirms before writing a note,
// and reload must re-render its Apply/Reject affordance (not spin forever).
export const WRITE_SRS_TOOL_NAMES = new Set([
  'create_deck',
  'update_deck',
  'delete_deck',
  'create_notebook',
  'update_notebook',
  'delete_notebook',
  'update_note',
  'delete_note',
  'attach_source',
  'detach_source',
  'update_source',
  'set_reading_status',
  'delete_card',
  'delete_flashcard_note',
  'create_text_source',
  'create_url_source',

  'create_card',
  'edit_card',
  'suspend',
  'set_due',
  'forget',
  'save_note',
  'save_source_note',
]);

// ── Persisted-row → view-model reconstruction (reload) ───────────────────────
// Folds the persisted wire shape back into the grouped UI view models WITHOUT
// ever leaking a sentinel or a JSON-in-content tool row as a blank/garbled bubble:
//   • user                              → a user bubble
//   • assistant rows of ONE turn        → MERGED into a single assistant VM
//     (tool_calls rows append steps; the final prose row becomes its content) —
//     exactly the shape the live streaming path builds, so a reloaded turn
//     renders as one activity feed instead of N stacked "Assistant" blocks
//   • role:'tool'                       → folded into the matching tool call
//     (searched across the whole transcript so far — robust to legacy rows
//     whose same-timestamp order shuffled)
export function reconstructMessages(rows: PersistedMessageRow[]): MessageVM[] {
  const out: MessageVM[] = [];
  // The assistant VM accumulating the CURRENT turn (closed by a user/system row).
  let turnVM: MessageVM | null = null;
  // Tool calls still awaiting a role:'tool' row across the whole transcript; the
  // post-pass promotes the unresolved write/SRS ones to awaitingConfirmation.
  const unresolved: ToolCallVM[] = [];

  const findCall = (id: string | null | undefined): ToolCallVM | undefined => {
    if (!id) return undefined;
    // Current turn first, then earlier assistant VMs (legacy shuffled rows).
    const inTurn = turnVM?.toolCalls?.find((c) => c.id === id);
    if (inTurn) return inTurn;
    for (let i = out.length - 1; i >= 0; i--) {
      const tc = out[i]!.toolCalls?.find((c) => c.id === id);
      if (tc) return tc;
    }
    return undefined;
  };

  for (const row of rows) {
    const citations = Array.isArray(row.citations) ? row.citations : [];

    if (row.role === 'tool') {
      // A tool-result row — fold into the matching tool call. Never a bubble.
      const parsed = parseToolResultContent(row.content);
      const tc = findCall(row.toolCallId);
      if (tc) {
        tc.status = parsed.ok ? 'ok' : 'error';
        if (parsed.summary !== undefined) tc.result = parsed.summary;
        // Resolved — drop it from the unresolved set.
        const idx = unresolved.indexOf(tc);
        if (idx !== -1) unresolved.splice(idx, 1);
      }
      continue;
    }

    if (row.role === 'assistant') {
      if (!turnVM) {
        turnVM = {
          id: row.id,
          role: 'assistant',
          content: '',
          citations: [],
          createdAt: row.createdAt ?? undefined,
          model: row.model ?? undefined,
        };
        out.push(turnVM);
      }
      if (row.model) turnVM.model = row.model;
      // Usage may land on several rows of one turn (a suspended turn parks its
      // usage-so-far on the pending row; the continuation stamps its own on the
      // final row) — summing them yields the turn totals.
      if (row.usage) turnVM.usage = addUsage(turnVM.usage, row.usage);

      if (row.toolCalls && row.toolCalls.length > 0) {
        // Tool-call row — append steps; a following role:'tool' row resolves them.
        const calls: ToolCallVM[] = row.toolCalls.map((c) => ({
          id: c.id,
          name: c.name,
          args: parseToolArgs(c.arguments),
          impact: c.impact,
          status: 'running' as const,
        }));
        turnVM.toolCalls = [...(turnVM.toolCalls ?? []), ...calls];
        for (const c of calls) unresolved.push(c);
      } else {
        // Prose row — the turn's answer text (or, degenerately, a second text
        // row in a corrupted turn — appended, never dropped).
        turnVM.content = turnVM.content ? `${turnVM.content}\n\n${row.content}` : row.content;
        if (citations.length > 0) turnVM.citations = [...turnVM.citations, ...citations];
      }
      continue;
    }

    // user OR system → a normal bubble; closes the current assistant turn.
    out.push({
      id: row.id,
      role: row.role,
      content: row.content,
      citations,
      createdAt: row.createdAt ?? undefined,
      usage: row.usage ?? undefined,
      model: row.model ?? undefined,
      mentions: row.mentions ?? undefined,
      context: row.context ?? undefined,
      attachments: row.attachments ?? undefined,
    });
    turnVM = null;
  }

  // Post-pass: any unresolved tool call is a tool that never got its result row.
  // A write/SRS one is a suspended-pending-write → re-render Apply/Reject so the
  // user can resume it (impact isn't persisted, so the blast-radius is omitted
  // on reload — the buttons still drive resumeChat). A read tool left unresolved
  // is a torn transcript; mark it errored rather than spin forever.
  for (const tc of unresolved) {
    if (WRITE_SRS_TOOL_NAMES.has(tc.name)) {
      tc.awaitingConfirmation = true;
    } else {
      tc.status = 'error';
    }
  }

  return out;
}

/** Sum two usage payloads (per-row stamps of one turn → turn totals). */
function addUsage(a: MessageUsage | undefined, b: MessageUsage): MessageUsage {
  if (!a) return b;
  return {
    promptTokens: (a.promptTokens ?? 0) + (b.promptTokens ?? 0),
    completionTokens: (a.completionTokens ?? 0) + (b.completionTokens ?? 0),
    totalTokens: (a.totalTokens ?? 0) + (b.totalTokens ?? 0),
  };
}

// The abort/regenerate cliff: the user row is pre-committed server-side (before
// streaming), but the assistant turn only commits at end-of-stream. So an
// aborted/torn turn leaves a TRAILING `user` message with NO following assistant
// row — a question with no answer. Detect it so the "stopped — regenerate?"
// recovery affordance renders both live (on abort) and on reload.
export function hasAnswerlessUserTail(messages: MessageVM[]): boolean {
  const last = messages[messages.length - 1];
  return !!last && last.role === 'user';
}

// ── Action-label derivation (Component 2 / AC2.1, AC2.2) ─────────────────────

// Context the label templates use to resolve UUIDs into human-readable text. Both
// resolvers are ALREADY available on the tool-card path (no new data fetch).
export interface ToolLabelCtx {
  /** Resolve a card's front text from its id (store mirror → fetched). */
  resolveCardFront?: (cardId: string) => string | undefined;
  /** Resolve a deck's name from its id. */
  deckName?: (deckId: string) => string | undefined;
}

export interface ToolLabelResult {
  /** i18n key — `chat.tool.<name>` (or `chat.tool.<name>_n` for the pluralized collapse). */
  labelKey: string;
  /** Interpolation params for the i18n string (e.g. {front}, {query}, {scope}, {count}). */
  params: Record<string, string | number>;
  /** Optional arg string to render in --font-mono (queries). Never a UUID/JSON. */
  argMono?: string;
}

// Best-effort cast of the model's arg object to a record (never trusts shape).
function argRecord(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/**
 * Derive a human-readable verb-phrase label for one tool call — NEVER leaking a
 * UUID or raw JSON (AC2.1/2.2). Returns the i18n `labelKey` (single
 * `chat.tool.<name>` namespace), interpolation `params`, and an optional `argMono`
 * string (a query, rendered in monospace in S4).
 */
export function toolLabel(name: string, args: unknown, ctx: ToolLabelCtx = {}): ToolLabelResult {
  const a = argRecord(args);
  const labelKey = TOOL_LABEL_KEY[name] ?? `chat.tool.${name}`;

  switch (name) {
    case 'get_card':
    case 'card_progress': {
      const cardId = nonEmptyString(a.cardId);
      const front = cardId ? ctx.resolveCardFront?.(cardId) : undefined;
      // Resolved front, else a SHORT id slice — NEVER the full UUID/JSON.
      const display = front ?? (cardId ? cardId.slice(0, 8) : '');
      return { labelKey, params: { front: display } };
    }
    case 'browse_cards': {
      const query = nonEmptyString(a.query);
      if (query) return { labelKey, params: { query }, argMono: query };
      const deckId = nonEmptyString(a.deckId);
      const deck = deckId ? ctx.deckName?.(deckId) : undefined;
      return { labelKey, params: { query: deck ?? '' } };
    }
    case 'list_decks':
      return { labelKey, params: {} };
    case 'study_stats': {
      const scope = nonEmptyString(a.scope) ?? 'global';
      const deckId = nonEmptyString(a.deckId);
      const deck = deckId ? ctx.deckName?.(deckId) : undefined;
      return { labelKey, params: { scope: deck ?? scope } };
    }
    case 'search_cards':
    case 'web_search': {
      const query = nonEmptyString(a.query) ?? '';
      return { labelKey, params: { query }, argMono: query || undefined };
    }
    case 'fetch_page': {
      // Compact URL (scheme/www stripped, truncated) — readable, never raw JSON.
      const url = nonEmptyString(a.url);
      const shortened = url ? url.replace(/^https?:\/\//i, '').replace(/^www\./i, '') : '';
      const display = shortened.length > 60 ? `${shortened.slice(0, 60)}…` : shortened;
      return { labelKey, params: {}, argMono: display || undefined };
    }
    // Write/SRS tools (B5) — card-targeting ones resolve the card front; the
    // creator resolves the deck name. Never a UUID, never raw JSON.
    case 'edit_card':
    case 'suspend':
    case 'set_due':
    case 'forget': {
      const cardId = nonEmptyString(a.cardId);
      const front = cardId ? ctx.resolveCardFront?.(cardId) : undefined;
      const display = front ?? (cardId ? cardId.slice(0, 8) : '');
      return { labelKey, params: { front: display } };
    }
    case 'create_card': {
      const deckId = nonEmptyString(a.deckId);
      const deck = deckId ? ctx.deckName?.(deckId) : undefined;
      // A `cards: [...]` batch reads as "Drafted N cards", not "Drafted a card".
      const batch = Array.isArray(a.cards) ? a.cards.length : 0;
      if (batch > 1) {
        return deck
          ? { labelKey: 'chat.tool.create_card_batch', params: { count: batch, deck } }
          : { labelKey: 'chat.tool.create_card_batch_nodeck', params: { count: batch } };
      }
      // Unresolvable deck → the deck-less phrasing, never an empty «» hole.
      if (!deck) return { labelKey: 'chat.tool.create_card_nodeck', params: {} };
      return { labelKey, params: { deck } };
    }
    case 'save_note': {
      // Show the note's title in the activity line (NEVER raw JSON). Falls back to
      // a generic label key when the title is empty/missing.
      const title = nonEmptyString(a.title);
      const display = title
        ? title.length > 60
          ? `${title.slice(0, 60)}…`
          : title
        : '';
      return display
        ? { labelKey, params: { title: display }, argMono: display }
        : { labelKey: 'chat.tool.save_note_untitled', params: {} };
    }
    default: {
      // Unknown tool — bare label key + a COMPACT readable arg line (B5: never
      // `[object Object]`, never raw JSON).
      return { labelKey, params: {}, argMono: TOOL_LABEL_KEY[name] ? undefined : formatToolArgs(args) };
    }
  }
}

// ── Compact tool-arg formatting (B5) ──────────────────────────────────────────

export interface FormatToolArgsOpts {
  /** Max key:value pairs rendered (rest collapses to `…`). Default 4. */
  maxPairs?: number;
  /** Max chars per rendered value. Default 40. */
  maxValueLen?: number;
}

// A full-UUID value never renders verbatim (the no-UUID-leak invariant of the
// activity feed) — it collapses to its first 8 chars, like the label resolvers.
const UUID_VALUE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function maskUuid(s: string): string {
  return UUID_VALUE_RE.test(s) ? s.slice(0, 8) : s;
}

function formatArgValue(v: unknown, maxLen: number): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') {
    const s = maskUuid(v.replace(/\s+/g, ' ').trim());
    return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    if (v.length <= 3 && v.every((x) => typeof x === 'string' || typeof x === 'number')) {
      const joined = v.map((x) => (typeof x === 'string' ? maskUuid(x) : String(x))).join(', ');
      return joined.length > maxLen ? `[${v.length}]` : joined;
    }
    return `[${v.length}]`;
  }
  return '{…}';
}

/**
 * Render a tool's arg object as a compact `key: value; key2: value2` line —
 * NEVER `[object Object]`, never multi-line JSON. Strings truncate, arrays show
 * a short join or `[N]`, nested objects collapse to `{…}`, null/undefined are
 * skipped. Non-object args render via String(). Returns undefined for empty.
 */
export function formatToolArgs(args: unknown, opts: FormatToolArgsOpts = {}): string | undefined {
  const maxPairs = opts.maxPairs ?? 4;
  const maxValueLen = opts.maxValueLen ?? 40;
  if (args === null || args === undefined) return undefined;
  if (typeof args !== 'object') {
    const s = String(args).replace(/\s+/g, ' ').trim();
    return s.length > 0 ? (s.length > maxValueLen ? `${s.slice(0, maxValueLen)}…` : s) : undefined;
  }
  const entries = Object.entries(args as Record<string, unknown>).filter(
    ([, v]) => v !== null && v !== undefined,
  );
  if (entries.length === 0) return undefined;
  const shown = entries.slice(0, maxPairs);
  const parts = shown.map(([k, v]) => {
    const rendered = formatArgValue(v, maxValueLen);
    return rendered.length > 0 ? `${k}: ${rendered}` : k;
  });
  if (entries.length > maxPairs) parts.push('…');
  return parts.join('; ');
}

// ── Confirm-preview rows (B4 / C8) ────────────────────────────────────────────

export interface ConfirmDiffRow {
  field: string;
  /** Present for edit_card diffs (rose, leading −). */
  before?: string;
  /** Present for edit diffs AND create proposals (lime, leading +). */
  after?: string;
  /** Batch create (`proposedCards`): 0-based index of the card this row belongs to. */
  cardIndex?: number;
}

/**
 * Normalize a paused tool's `impact` previews into render-ready rows:
 *   • edit_card  → fieldDiffs (before/after) + a tags row when tagsChange present
 *   • create_card → proposedFields (after-only), or per-card rows tagged with
 *     `cardIndex` for a `cards: [...]` batch (proposedCards)
 * Absent/old payloads → `[]` (the confirm card degrades to blast-radius-only).
 */
export function confirmDiffRows(name: string, impact: ConfirmImpact | undefined): ConfirmDiffRow[] {
  if (!impact) return [];
  const rows: ConfirmDiffRow[] = [];
  if (name === 'edit_card') {
    for (const d of impact.fieldDiffs ?? []) {
      rows.push({ field: d.field, before: d.before, after: d.after });
    }
    if (impact.tagsChange) {
      rows.push({
        field: 'tags',
        before: impact.tagsChange.before.join(', '),
        after: impact.tagsChange.after.join(', '),
      });
    }
  } else if (name === 'create_card') {
    if (impact.proposedCards && impact.proposedCards.length > 0) {
      impact.proposedCards.forEach((card, i) => {
        for (const p of card.fields) {
          rows.push({ field: p.field, after: p.value, cardIndex: i });
        }
      });
    } else {
      for (const p of impact.proposedFields ?? []) {
        rows.push({ field: p.field, after: p.value });
      }
    }
  }
  return rows;
}

// ── Editable create_card confirm draft (per-card accept/edit/exclude) ────────

export interface ConfirmCardDraft {
  fieldValues: Record<string, string>;
}

/**
 * Parse a pending `create_card`'s ORIGINAL args into editable per-card drafts
 * (full values — the impact preview is capped for display, so the editor reads
 * the args instead). Batch `cards: [...]` → N entries; the single `fieldValues`
 * shape → one entry. Null for other tools / malformed args (the confirm card
 * degrades to the read-only preview).
 */
export function createCardDraft(args: unknown): ConfirmCardDraft[] | null {
  const a = argRecord(args);
  const toDraft = (fv: unknown): ConfirmCardDraft | null => {
    if (!fv || typeof fv !== 'object' || Array.isArray(fv)) return null;
    const fieldValues: Record<string, string> = {};
    for (const [k, v] of Object.entries(fv as Record<string, unknown>)) {
      if (typeof v === 'string') fieldValues[k] = v;
    }
    return Object.keys(fieldValues).length > 0 ? { fieldValues } : null;
  };
  if (Array.isArray(a.cards)) {
    const out: ConfirmCardDraft[] = [];
    for (const item of a.cards) {
      const d = toDraft((item as { fieldValues?: unknown } | null)?.fieldValues);
      if (!d) return null; // one malformed entry degrades the whole editor
      out.push(d);
    }
    return out.length > 0 ? out : null;
  }
  const single = toDraft(a.fieldValues);
  return single ? [single] : null;
}

/**
 * Build the resume `cardSelections` payload from the confirm editor's state:
 * excluded cards are sent as `include:false`, edited ones carry their full
 * `fieldValues`; untouched cards are OMITTED (the server applies them as
 * proposed). An empty result means "apply exactly as proposed".
 */
export function buildCardSelections(
  original: ConfirmCardDraft[],
  state: { include: boolean; fieldValues: Record<string, string> }[],
): { index: number; include: boolean; fieldValues?: Record<string, string> }[] {
  const out: { index: number; include: boolean; fieldValues?: Record<string, string> }[] = [];
  for (let i = 0; i < original.length && i < state.length; i++) {
    const st = state[i]!;
    if (!st.include) {
      out.push({ index: i, include: false });
      continue;
    }
    const orig = original[i]!.fieldValues;
    const keys = new Set([...Object.keys(orig), ...Object.keys(st.fieldValues)]);
    const changed = [...keys].some((k) => (orig[k] ?? '') !== (st.fieldValues[k] ?? ''));
    if (changed) out.push({ index: i, include: true, fieldValues: st.fieldValues });
  }
  return out;
}

/**
 * The confirm wizard's "next card to decide" — the first undecided index AFTER
 * `after` (wrapping to the start), or -1 when every card is decided (→ the
 * review step). Re-deciding an earlier card therefore jumps forward to the
 * remaining undecided ones instead of marching through already-decided cards.
 */
export function nextUndecidedIndex(
  decisions: ('accepted' | 'excluded' | null)[],
  after: number,
): number {
  const n = decisions.length;
  for (let offset = 1; offset <= n; offset++) {
    const i = (after + offset) % n;
    if (decisions[i] === null) return i;
  }
  return -1;
}

// ── Usage badge helper (B6) ───────────────────────────────────────────────────

/** Total token count for the badge; guards NaN/partial payloads → 0. */
export function usageTotal(usage: MessageUsage | undefined): number {
  if (!usage) return 0;
  const total =
    Number.isFinite(usage.totalTokens) && usage.totalTokens > 0
      ? usage.totalTokens
      : (Number.isFinite(usage.promptTokens) ? usage.promptTokens : 0) +
        (Number.isFinite(usage.completionTokens) ? usage.completionTokens : 0);
  return Number.isFinite(total) && total > 0 ? total : 0;
}

// ── Day separators (B2) ───────────────────────────────────────────────────────

/** LOCAL calendar-day key (YYYY-MM-DD) for an ISO timestamp; null when absent/invalid. */
export function dayKey(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** True when a separator should render between two adjacent messages. */
export function needsDaySeparator(prevIso: string | undefined, currIso: string | undefined): boolean {
  const curr = dayKey(currIso);
  if (!curr) return false;
  const prev = dayKey(prevIso);
  // First dated message gets a separator; same-day neighbours don't.
  return prev !== curr;
}

/**
 * Human day label: today/yesterday via i18n keys, otherwise a locale date
 * (day + month, + year when not the current year).
 */
export function formatDayLabel(iso: string, locale: string, t: T, now = new Date()): string {
  const key = dayKey(iso);
  const todayKey = localKeyOf(now);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const yesterdayKey = localKeyOf(yesterday);
  if (key === todayKey) return t('chat.stream.today');
  if (key === yesterdayKey) return t('chat.stream.yesterday');
  const d = new Date(iso);
  const sameYear = d.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(d);
}

function localKeyOf(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ── Follow-up queue guard (D4) ────────────────────────────────────────────────

/** True while ANY tool call is paused awaiting confirmation (undecided). */
export function hasPendingConfirmation(messages: MessageVM[]): boolean {
  return messages.some((m) =>
    (m.toolCalls ?? []).some((tc) => tc.awaitingConfirmation === true && !tc.decision),
  );
}

// ── Elapsed-time formatting (AC1.5) ──────────────────────────────────────────

type T = (key: string, params?: Record<string, string | number>) => string;

/**
 * Hand-rolled "Worked for Ns" formatter (mirrors the relativeUpdated style).
 *   • < 1s          → chat.activity.workedSub  ("<1s")
 *   • 1–59s         → chat.activity.workedSeconds {count}
 *   • 60s–59m59s    → chat.activity.workedMinutes {m, s}
 *   • ≥ 3600s       → chat.activity.workedHours {h, m}  (runaway cap — no raw seconds)
 * Pure (takes `t`). A negative/NaN ms collapses to the sub-second form.
 */
export function formatElapsed(ms: number, t: T): string {
  if (!Number.isFinite(ms) || ms < 1000) return t('chat.activity.workedSub');
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return t('chat.activity.workedSeconds', { count: totalSeconds });
  if (totalSeconds < 3600) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return t('chat.activity.workedMinutes', { m, s });
  }
  // ≥ 1h — cap as "Hh Mm" so a runaway turn reads sanely (never raw "7412s").
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return t('chat.activity.workedHours', { h, m });
}

// ── Repeated-call summarization (AC2.2 / Assumption 4) ───────────────────────

export interface StepGroup {
  name: string;
  count: number;
  /** Index of the first step in this contiguous run (preserves call order). */
  firstIndex: number;
}

/**
 * Collapse ONLY CONSECUTIVE same-tool runs into one group (preserves call order).
 * Interleaved runs (A,A,B,A) do NOT merge across the B — they stay
 * `[A×2, B, A×1]`, so the header copy never under-counts or implies a contiguity
 * that didn't happen. The summed group counts always equal the raw step count.
 */
export function summarizeSteps(steps: { name: string }[]): StepGroup[] {
  const groups: StepGroup[] = [];
  for (let i = 0; i < steps.length; i++) {
    const name = steps[i]!.name;
    const last = groups[groups.length - 1];
    if (last && last.name === name) {
      last.count += 1;
    } else {
      groups.push({ name, count: 1, firstIndex: i });
    }
  }
  return groups;
}

// ── Activity-group header state (AC1.2 / AC1.3 / Change 5) ───────────────────

export interface GroupHeaderInput {
  /** The turn is still streaming. */
  streaming: boolean;
  /** The final prose answer has begun arriving. */
  answerStarted: boolean;
  /**
   * Single-step group auto-opens (Decision A1): when there is exactly one step the
   * group renders light + expanded. Multi-step groups collapse-on-answer via `live`.
   */
  singleStepAutoOpen: boolean;
  /**
   * Force the group open while ANY step is awaiting human confirmation (AC1.4).
   * A pending-confirmation step is always visible even in a multi-step group where
   * `initialOpen` and `live` are both false — without this the Apply/Reject controls
   * are hidden behind a closed group and the turn is stuck with no affordance.
   */
  anyAwaiting?: boolean;
}

export interface GroupHeaderState {
  status: 'running' | 'done' | 'error';
  /** Auto-collapse flag — mirrors ReasoningBlock.live (streaming && !answerStarted). */
  live: boolean;
  /** Initial open state before any manual toggle: `initialOpen || live` drives the group. */
  initialOpen: boolean;
}

/**
 * Derive the activity-group header status + auto-collapse `live` flag + the
 * `initialOpen` branch. Status: any error → error; any running → running; else
 * done. `live = streaming && !answerStarted` (mirrors ReasoningBlock). The
 * single-step group's `initialOpen` is true (auto-expanded); a multi-step group's
 * `initialOpen` is false so it collapses-on-answer via `live`. When `anyAwaiting`
 * is true (a step is paused for human approval), `initialOpen` is forced true so
 * the Apply/Reject controls are never hidden behind a closed group (AC1.4).
 */
export function groupHeaderState(
  steps: { status: ToolCallVM['status'] }[],
  { streaming, answerStarted, singleStepAutoOpen, anyAwaiting }: GroupHeaderInput,
): GroupHeaderState {
  const anyError = steps.some((s) => s.status === 'error');
  const anyRunning = steps.some((s) => s.status === 'running');
  const status: GroupHeaderState['status'] = anyError ? 'error' : anyRunning ? 'running' : 'done';
  const live = streaming && !answerStarted;
  // Force initialOpen when a step is awaiting confirmation so the controls are
  // always visible regardless of step count or whether an answer has arrived.
  const initialOpen = singleStepAutoOpen || (anyAwaiting === true);
  return { status, live, initialOpen };
}

// ── Post-apply write summary (Component 5 / AC5.1) ───────────────────────────

export interface ApplySummary {
  kind: 'create' | 'edit';
  count?: number;
  deckId?: string;
  cardId?: string;
}

/**
 * Derive a post-apply write summary from an APPLIED create/edit tool's name+args
 * (used by the S5 render path). Reads only `cards`/`cardIds`/`deckId`/`cardId`
 * already on the tool args. Returns null for reject/other tools so nothing renders.
 */
export function applySummaryFrom(name: string, args: unknown): ApplySummary | null {
  const a = argRecord(args);
  if (name === 'create_card') {
    const deckId = nonEmptyString(a.deckId);
    // A `cards: [...]` batch carries its count in the args; legacy `cardIds`
    // kept as a fallback; a single fieldValues call counts 1.
    const batch = Array.isArray(a.cards) ? a.cards.length : undefined;
    const cardIds = Array.isArray(a.cardIds) ? a.cardIds.length : undefined;
    const count = batch ?? cardIds ?? 1;
    return { kind: 'create', count, deckId };
  }
  if (name === 'edit_card') {
    const cardId = nonEmptyString(a.cardId);
    return { kind: 'edit', cardId };
  }
  return null;
}

// ── B1 fallback helper (client-only resend; only if api build unavailable) ───

/**
 * Trim the trailing user[+assistant] exchange from a message list (the B1 fallback
 * edit-and-rerun path). With B2 (server-side) chosen as the default this is unused
 * by the live UI, but it is kept + unit-tested so the fallback path is provable.
 * Drops a trailing assistant VM (if present) then a trailing user VM (if present).
 */
export function dropTrailingExchange(messages: MessageVM[]): MessageVM[] {
  let end = messages.length;
  if (end > 0 && messages[end - 1]!.role === 'assistant') end -= 1;
  if (end > 0 && messages[end - 1]!.role === 'user') end -= 1;
  return messages.slice(0, end);
}
