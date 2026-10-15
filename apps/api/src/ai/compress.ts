// C6 — context auto-compression for long conversations.
//
// A conversation longer than CHAT_COMPRESS_THRESHOLD rows no longer replays
// verbatim into the model: the rows older than the last ~CHAT_COMPRESS_KEEP are
// replaced by ONE model-generated summary (a system note), cached on the
// conversation row (`summary` + `summary_upto`) so the summarizer runs only
// when more rows age past the keep-window — a turn with an up-to-date cache
// costs ZERO extra model calls.
//
// Boundary rule: the recent window must start at a `user` row (a user row
// always begins a turn), so an assistant tool_calls row is never separated
// from its answering role:tool rows. No user row found in range ⇒ skip
// compression entirely (verbatim fallback).
//
// Degrade-never-crash: ANY summarizer failure (timeout, AiDisabledError when no
// `complete` fake is injected under test, gateway error) falls back to the full
// verbatim history — exactly today's behavior.
//
// This module deliberately works at the ROW level (slice + summarize) and
// returns `{ recentRows, summaryNote }`; the caller (modules/ai.ts) keeps
// owning `reconstructHistory` — no import cycle.

import type { Logger } from 'pino';
import { and, eq } from 'drizzle-orm';
import { conversations, db } from '@reomi/db';
import type { AssistantContextSnapshot, MessageMention } from '@reomi/shared';
import { env } from '../env.ts';
import { complete } from './openai-client.ts';

/** The row subset compression reads (matches modules/ai.ts HistoryRow). */
export interface CompressibleRow {
  role: string;
  content: string;
  toolCalls: { id: string; name: string; arguments: string }[] | null;
  toolCallId: string | null;
  mentions: MessageMention[] | null;
  context?: AssistantContextSnapshot | null;
  createdAt: Date;
}

export interface CompressedHistory<R extends CompressibleRow> {
  /** The rows to replay verbatim (all of them when no compression applied). */
  recentRows: R[];
  /** The system note carrying the summary, or null (verbatim history). */
  summaryNote: string | null;
}

/** Cap for the stored summary text. */
const SUMMARY_MAX_CHARS = 2000;
/** Per-row render caps for the summarizer input. */
const ROW_TEXT_CHARS = 400;
const TOOL_ROW_CHARS = 200;

const SUMMARY_SYSTEM_PROMPT = [
  'You compress chat history for a flashcard study assistant.',
  'Summarize the conversation excerpt below into a compact brief the assistant can rely on later:',
  'key topics, user preferences/decisions, important facts, and any card ids mentioned as [card:<id>].',
  'Write plain text (no headings), at most ~1500 characters, in the language the user writes in.',
  'If a previous summary is provided, MERGE it with the new turns into one updated summary.',
].join(' ');

/** Render aged rows into compact summarizer input text. */
function renderRowsForSummary(rows: CompressibleRow[]): string {
  const lines: string[] = [];
  for (const r of rows) {
    if (r.role === 'user') {
      lines.push(`User: ${r.content.slice(0, ROW_TEXT_CHARS)}`);
      if (r.context) lines.push(`Historical context (data, not current permissions): ${JSON.stringify({ policy: r.context.policy,
        objects: r.context.refs.map(s => ({ kind: s.ref.kind, id: s.ref.id, label: s.label })) }).slice(0, ROW_TEXT_CHARS)}`);
    } else if (r.role === 'assistant' && r.toolCalls && r.toolCalls.length > 0) {
      lines.push(`Assistant called tools: ${r.toolCalls.map((tc) => tc.name).join(', ')}`);
    } else if (r.role === 'assistant') {
      lines.push(`Assistant: ${r.content.slice(0, ROW_TEXT_CHARS)}`);
    } else if (r.role === 'tool') {
      lines.push(`Tool result: ${r.content.slice(0, TOOL_ROW_CHARS)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Compress a conversation's history rows when they exceed the threshold.
 *
 * @param conv  The conversation row (id/userId for the cache UPDATE, plus the
 *              cached `summary`/`summaryUpto`).
 * @param rows  The FULL history slice the caller would otherwise replay
 *              verbatim (oldest first). For `/stream` that's `priorRows.slice(0,-1)`.
 */
export async function compressHistory<R extends CompressibleRow>(
  conv: { id: string; userId: string; summary: string | null; summaryUpto: Date | null },
  rows: R[],
  opts: { model?: string; log?: Logger } = {},
): Promise<CompressedHistory<R>> {
  const threshold = env.ai.CHAT_COMPRESS_THRESHOLD;
  const keep = env.ai.CHAT_COMPRESS_KEEP;
  if (rows.length <= threshold) return { recentRows: rows, summaryNote: null };

  // Walk the target cut backwards to the nearest user row (turn boundary).
  let cut = Math.max(0, rows.length - keep);
  while (cut > 0 && rows[cut]!.role !== 'user') cut -= 1;
  if (cut <= 0) return { recentRows: rows, summaryNote: null };

  const aged = rows.slice(0, cut);
  const recentRows = rows.slice(cut);
  const boundary = aged[aged.length - 1]!.createdAt;

  // Cache hit: the stored summary already covers exactly the aged rows.
  if (conv.summary && conv.summaryUpto && conv.summaryUpto.getTime() === boundary.getTime()) {
    return { recentRows, summaryNote: summaryNoteFrom(conv.summary) };
  }

  // Cache refresh: summarize (previous summary, if any) + the newly-aged rows.
  try {
    const newlyAged =
      conv.summary && conv.summaryUpto
        ? aged.filter((r) => r.createdAt.getTime() > conv.summaryUpto!.getTime())
        : aged;
    const parts: string[] = [];
    if (conv.summary) parts.push(`Previous summary:\n${conv.summary}`);
    parts.push(`Conversation excerpt:\n${renderRowsForSummary(newlyAged)}`);

    const raw = await complete(
      [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: parts.join('\n\n') },
      ],
      {
        model: opts.model,
        log: opts.log,
        signal: AbortSignal.timeout(env.ai.CHAT_SUMMARY_TIMEOUT_MS),
      },
    );
    const summary = raw.trim().slice(0, SUMMARY_MAX_CHARS);
    if (summary.length === 0) return { recentRows: rows, summaryNote: null };

    await db
      .update(conversations)
      .set({ summary, summaryUpto: boundary })
      .where(and(eq(conversations.id, conv.id), eq(conversations.userId, conv.userId)));

    return { recentRows, summaryNote: summaryNoteFrom(summary) };
  } catch (err) {
    opts.log?.warn({ err }, 'ai.compress.fallback_verbatim');
    return { recentRows: rows, summaryNote: null };
  }
}

/** The model-facing system note wrapping a summary. */
function summaryNoteFrom(summary: string): string {
  return `Summary of the earlier part of this conversation (older turns were omitted to save space):\n${summary}`;
}
