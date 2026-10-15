'use client';

// Shared transcript, citation, approval and picker presentation. No stream ownership.
import { useTransientLayer } from '@/lib/use-transient-layer';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAppNavigation } from '@/components/navigation';
import type {
  CardCitation,
  ChatModelOption,
  ChatResumeRequest,
  Citation,
  MessageAttachmentInput,
  SourceCitation,
} from '@reomi/shared';
import {
  CARD_TOKEN_RE as CARD_TOKEN_CORE_RE,
  SRC_TOKEN_RE as SRC_TOKEN_CORE_RE,
  isSourceCitation,
  MAX_MEDIA_BYTES,
  MEDIA_MIME_ALLOWLIST,
} from '@reomi/shared';
import {
  NNBadge,
  NNBtn,
  NNCard,
  NNIcon,
  NNInlineRefresh,
  NNKbd,
  NNLoadError,
  NNSkeleton,
} from '@/components/ui';
import { RichCard } from '@/components/rich-card';
import { compactToolText } from '@/lib/panel-width';
import { topicPlanCardRows } from '@/lib/topic-plan-card';
import { renderCardHtml, SafeHtml } from '@/lib/render-card';
import { api, ok } from '@/lib/api';
import { resolveMediaSrc } from '@/lib/media-url';
import { toApiError, type ResourceState } from '@/lib/resource-state';
import { ChatUnavailable } from './chat-unavailable';
import {
  fetchSessionResource,
  peekSessionResource,
  clearSessionResourceCache,
} from '@/lib/session-resource';
import {
  regenerateChat,
  resumeChat,
  streamChat,
  type ChatStreamHandlers,
} from '@/lib/chat-stream';
import {
  applySummaryFrom,
  buildCardSelections,
  confirmDiffRows,
  createCardDraft,
  formatDayLabel,
  formatElapsed,
  groupHeaderState,
  hasAnswerlessUserTail,
  hasPendingConfirmation,
  needsDaySeparator,
  nextUndecidedIndex,
  PLURAL_TOOL_NAMES,
  reconstructMessages,
  summarizeSteps,
  toolIcon,
  toolLabel,
  usageTotal,
  type MessageVM,
  type PersistedMessageRow,
  type ToolCallVM,
} from '@/lib/chat-activity';
import { type ConversationVM } from '@/lib/chat-threads';
import {
  applyTrigger,
  detectComposerTrigger,
  filterSlashCommands,
  searchMentions,
  slashTemplate,
  type ComposerTrigger,
} from '@/lib/chat-mentions';
import { ThreadRail } from '@/components/chat/thread-rail';
import { ConfirmDiff } from '@/components/chat/confirm-diff';
import { MentionPopover, SlashMenu, mentionItems } from '@/components/chat/mention-popover';
import { useCodeCopyButtons } from '@/components/chat/code-copy';
import { useInlineCitations } from '@/components/chat/source-citations';
import {
  buildCitationNumbering,
  citationCoverLetter,
  citationCoverTone,
  citationLocation,
  type CitationNumbering,
} from '@/lib/chat-citations';
import { useStickToBottom } from '@/lib/use-stick-to-bottom';
import { cardFromApi, deckFromApi } from '@/lib/mappers';
import { useNN } from '@/lib/store';
import { getDueCards } from '@/lib/cards';
import type { Card } from '@/lib/types';
import { useBreakpoint } from '@/lib/use-breakpoint';
import { useT, useLocale } from '@/lib/i18n';
import { useDialog } from '@/components/dialog';
import { raiseToast } from '@/components/toasts';


function formatTimestamp(iso: string | undefined, locale: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return d.toLocaleString();
  }
}

// Strip the inline [card:<id>] grounding tokens the model emits — the cited
// cards live in the collapsible "sources" block below, so the raw tokens are
// noise in the prose. Only spaces/tabs around a token are absorbed (never
// newlines), then runs of spaces are collapsed.
//
// Built from the shared core pattern (`CARD_TOKEN_CORE_RE` from @reomi/shared)
// so the server's citation-dedup and this client stay in lockstep on the token
// shape; the leading `[ \t]*` whitespace-absorber stays local to the renderer.
const CARD_TOKEN_RE = new RegExp(`[ \\t]*${CARD_TOKEN_CORE_RE.source}`, 'g');
// Source-citation token strip (M2) — same whitespace-absorbing variant as the
// card token, so `[src:<sourceChunkId>]` markers vanish from rendered prose.
const SRC_TOKEN_RE = new RegExp(`[ \\t]*${SRC_TOKEN_CORE_RE.source}`, 'g');
export function stripCardTokens(text: string): string {
  return text
    .replace(CARD_TOKEN_RE, '')
    .replace(SRC_TOKEN_RE, '')
    .replace(/[ \t]{2,}/g, ' ');
}
// Notebook citation variant — keeps the `[src:<id>]` tokens in the prose so the
// inline-citation DOM decoration (`useInlineCitations`) can turn them into
// numbered chips. Only the card tokens (never numbered in notebook mode) are
// stripped. Used when `citeNumbers` is passed to AssistantMarkdown.
function stripCardTokensKeepSrc(text: string): string {
  return text.replace(CARD_TOKEN_RE, '').replace(/[ \t]{2,}/g, ' ');
}

// Validate a web-search result URL before rendering it as an <a href>. Mirrors
// the sanitizer's uponSanitizeAttribute scheme discipline (https?: / mailto:),
// but for web_search we only ever surface http(s) links. Anything else (a
// `javascript:` payload, a relative ref, garbage) is rejected → rendered as
// inert plain text, never a clickable link.
function safeWebUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

// Reconstruction note: the persisted-row → view-model reconstruction
// (`reconstructMessages`, `parseToolArgs`, `parseToolResultContent`,
// `WRITE_SRS_TOOL_NAMES`) and the answerless-tail detector (`hasAnswerlessUserTail`)
// now live in `@/lib/chat-activity` (re-imported above), so they can be unit-tested
// without a React import.

// Render assistant prose as Markdown through the SAME pipeline cards use
// (markdown-it → DOMPurify via SafeHtml) so lists/bold/headings/code render —
// the sanitizer stays the single security boundary and is never edited here. A
// synthetic single-field "basic" note-type with a `{{Body}}` template feeds the
// model text through `renderCardHtml`; `SafeHtml` is the one allowed inject sink.
const CHAT_MD_NOTE_TYPE = {
  kind: 'basic' as const,
  templates: [{ name: 'chat', ord: 0, frontTemplate: '{{Body}}', backTemplate: '{{Body}}' }],
};

const AssistantMarkdown = ({
  content,
  final,
  citeNumbers,
  citationOf,
  onCite,
  t,
}: {
  content: string;
  /** Code-copy buttons decorate only FINAL renders (no churn while streaming). */
  final: boolean;
  /** Notebook mode: chunkId → number for inline numbered citations. When passed,
   *  the `[src:]` tokens are KEPT in the prose and decorated into chips. */
  citeNumbers?: Map<string, number>;
  citationOf?: (chunkId: string) => SourceCitation | undefined;
  onCite?: (c: SourceCitation) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) => {
  const citeMode = !!citeNumbers && (citeNumbers.size ?? 0) > 0;
  const html = useMemo(
    () =>
      renderCardHtml(
        CHAT_MD_NOTE_TYPE,
        { Body: citeMode ? stripCardTokensKeepSrc(content) : stripCardTokens(content) },
        'front',
      ),
    [content, citeMode],
  );
  const hostRef = useRef<HTMLDivElement>(null);
  const copyLabels = useMemo(
    () => ({ copy: t('chat.message.codeCopy'), copied: t('chat.message.codeCopied') }),
    [t],
  );
  // B3 — post-render DOM decoration of `pre` blocks; the sanitizer never sees
  // the button. Scoped to THIS host only (cited RichCards are unaffected).
  useCodeCopyButtons(hostRef, { html, final }, copyLabels);
  // A2 — inline numbered citation chips (notebook mode only). Same post-render
  // decoration discipline; gated off entirely in card mode (`enabled`).
  const noCite = useMemo(() => new Map<string, number>(), []);
  const noopCitation = useCallback(() => undefined, []);
  const noopCite = useCallback(() => {}, []);
  useInlineCitations(
    hostRef,
    { html, final, enabled: citeMode && !!onCite },
    citeNumbers ?? noCite,
    citationOf ?? noopCitation,
    onCite ?? noopCite,
  );
  return (
    <div ref={hostRef} className="reomi-chat-prose">
      <SafeHtml
        html={html}
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: 16,
          lineHeight: 1.7,
          color: 'var(--text)',
          wordBreak: 'break-word',
        }}
      />
    </div>
  );
};

// ── Component ──────────────────────────────────────────────────────────────────

// localStorage key for the last-used model selection (re-validated on load).

type StreamPhase = 'thinking' | 'calling_tool' | 'answering' | null;

interface MessageRowProps {
  message: MessageVM;
  /** Coarse loop phase of the in-flight turn (only set on the streaming row). */
  phase?: StreamPhase;
  resolveCard: (cardId: string) => Card | undefined;
  deckNameById: Map<string, string>;
  /**
   * Answer a paused write/SRS tool call (Phase B). Carries the parent assistant
   * message id so the resume targets the right bubble.
   */
  onConfirm: (
    assistantMsgId: string,
    toolCallId: string,
    decision: 'apply' | 'reject',
    payload?: ConfirmPayload,
  ) => void;
  /** Show the regenerate action (only on the last, finished assistant message). */
  canRegenerate?: boolean;
  /** Copy this message's clean prose to the clipboard (assistant only). */
  onCopy?: () => void;
  /** «В заметки» (Р7) — save this answer into the notebook's notes (notebook
   *  mode only; undefined ⇒ the button is hidden). */
  onSaveAnswer?: () => void;
  /** Regenerate the last assistant turn (assistant only). */
  onRegenerate?: () => void;
  /** Show the edit-and-rerun affordance (only on the last user message). */
  canEdit?: boolean;
  /** Edit-and-rerun the last user message with the edited text (AC4.1/4.2). */
  onEdit?: (text: string) => void | boolean | Promise<void | boolean>;
  /** Open a cited card in /cards (jump-to-card, AC3.6). */
  onOpenCard?: (cardId: string) => void;
  /** Open a deck's cards in /cards (post-create exit when no card id, P3.7). */
  onOpenDeckCards?: (deckName: string) => void;
  /** A source citation chip was clicked (workspace scrolls the reader). */
  onSourceCitation?: (c: SourceCitation) => void;
  /** Notebook mode (A2): numbered inline citations + «по N источникам» meta. */
  isNotebook?: boolean;
  /** Size of the active source scope — drives «по N источникам» (undefined ⇒
   *  hidden). Notebook mode only. */
  sourceCount?: number;
  /** Resolve a model id to its picker label (B6) — falls back to the raw id. */
  modelLabel?: (id: string) => string;
  /** Active locale for absolute-timestamp formatting on hover. */
  locale: string;
  t: (key: string, params?: Record<string, string | number>) => string;
}

/** Short HH:MM time for the inline message timestamp (B2). */
function formatTimeShort(iso: string | undefined, locale: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export const MessageRow = ({
  message,
  phase = null,
  resolveCard,
  deckNameById,
  onConfirm,
  canRegenerate = false,
  onCopy,
  onSaveAnswer,
  onRegenerate,
  canEdit = false,
  onEdit,
  onOpenCard,
  onOpenDeckCards,
  onSourceCitation,
  isNotebook = false,
  sourceCount,
  modelLabel,
  locale,
  t,
}: MessageRowProps) => {
  const isUser = message.role === 'user';
  // Cited cards are collapsed by default (they can be large); a count summary
  // toggles the full RichCard list. Hook declared before the user-message early
  // return so it's always called in the same order.
  const [sourcesOpen, setSourcesOpen] = useState(false);
  // Edit-and-rerun inline state (AC4.1) — hooks before the early return.
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState('');
  const [submittingEdit, setSubmittingEdit] = useState(false);
  const toolCalls = message.toolCalls ?? [];
  const hasReasoning = (message.reasoning ?? '').trim().length > 0;
  // Notebook numbered citations (A2): build the per-message chunkId→number map +
  // ordered chip list from the prose's first-appearance order. Card mode skips
  // this (numbering stays empty ⇒ inline decoration is a no-op).
  const numbering: CitationNumbering = useMemo(
    () =>
      isNotebook
        ? buildCitationNumbering(message.content, message.citations)
        : { numberOf: new Map(), ordered: [] },
    [isNotebook, message.content, message.citations],
  );
  const citationOf = useCallback(
    (chunkId: string): SourceCitation | undefined =>
      numbering.ordered.find((o) => o.citation.sourceChunkId === chunkId)?.citation,
    [numbering],
  );
  // While the turn is still streaming and the final answer hasn't begun, the
  // thinking placeholder shows; once any prose/tool work exists it gives way.
  const isStreaming = !!message.streaming;
  const answerStarted = message.content.length > 0;

  if (isUser) {
    const startEdit = () => {
      setEditDraft(message.content);
      setEditing(true);
    };
    const commitEdit = async () => {
      if (submittingEdit) return;
      const text = editDraft.trim();
      if (!text || text === message.content) { setEditing(false); return; }
      setSubmittingEdit(true);
      try {
        if (await onEdit?.(text) !== false) setEditing(false);
      } catch {
        // The caller displays the request error; retain the edited text here.
      } finally { setSubmittingEdit(false); }
    };
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        {editing ? (
          // Inline editable field (reuses the thread inline-rename pattern). Enter
          // confirms (edit-and-rerun), Esc cancels.
          <input
            autoFocus
            value={editDraft}
            readOnly={submittingEdit}
            aria-busy={submittingEdit}
            maxLength={8000}
            aria-label={t('chat.message.editSave')}
            onChange={(e) => setEditDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void commitEdit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setEditing(false);
              }
            }}
            onBlur={() => { if (!submittingEdit && editDraft === message.content) setEditing(false); }}
            style={{
              maxWidth: '78%',
              width: '78%',
              padding: '10px 14px',
              borderRadius: 'var(--r-lg)',
              border: '1px solid var(--border-2)',
              background: 'var(--surface-2)',
              color: 'var(--text)',
              fontFamily: 'var(--font-sans)',
              fontSize: 14,
              lineHeight: 1.5,
              outline: 'none',
            }}
          />
        ) : (
          <div
            className="nn-chat-user-bubble nn-msg-row"
            title={formatTimestamp(message.createdAt, locale)}
            style={{
              display: 'inline-flex',
              alignItems: 'flex-start',
              gap: 6,
              maxWidth: '78%',
            }}
          >
            {formatTimeShort(message.createdAt, locale) && (
              <span
                className="nn-msg-time"
                style={{
                  alignSelf: 'center',
                  fontSize: 10.5,
                  color: 'var(--text-dim)',
                  fontFamily: 'var(--font-sans)',
                  flexShrink: 0,
                }}
              >
                {formatTimeShort(message.createdAt, locale)}
              </span>
            )}
            {canEdit && onEdit && (
              <button
                type="button"
                aria-label={t('chat.message.edit')}
                title={t('chat.message.edit')}
                onClick={startEdit}
                style={{
                  display: 'flex',
                  alignSelf: 'center',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--text-dim)',
                  padding: 2,
                  flexShrink: 0,
                }}
              >
                <NNIcon name="edit" size={14} />
              </button>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
              {/* Attachments — image previews + file chips, above the text. */}
              {(message.attachments ?? []).length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, justifyContent: 'flex-end' }}>
                  {message.attachments!.map((a, i) =>
                    a.kind === 'image' ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        key={`${a.mediaId}-${i}`}
                        src={resolveMediaSrc(a.token)}
                        alt={a.name ?? 'attachment'}
                        title={a.name}
                        style={{
                          maxHeight: 180,
                          maxWidth: 260,
                          borderRadius: 'var(--r-md)',
                          border: '1px solid var(--border-2)',
                          objectFit: 'cover',
                        }}
                      />
                    ) : (
                      <span
                        key={`${a.name}-${i}`}
                        title={a.name}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 5,
                          padding: '4px 10px',
                          borderRadius: 'var(--r-pill)',
                          border: '1px solid var(--border-2)',
                          background: 'var(--surface-2)',
                          color: 'var(--text-muted)',
                          fontFamily: 'var(--font-sans)',
                          fontSize: 12,
                          maxWidth: 220,
                        }}
                      >
                        <NNIcon name="doc" size={12} color="var(--text-dim)" />
                        <span
                          style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            minWidth: 0,
                          }}
                        >
                          {a.name}
                        </span>
                      </span>
                    ),
                  )}
                </div>
              )}
              <div
                className="nn-nb-user-bubble reomi-user-message"
                style={{
                  padding: '10px 14px',
                  borderRadius: 18,
                  background: 'var(--surface-3)',
                  border: '1px solid var(--border)',
                  color: 'var(--text)',
                  fontFamily: 'var(--font-sans)',
                  fontSize: 15,
                  lineHeight: 1.6,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  minWidth: 0,
                }}
              >
                {message.content}
              </div>
              {/* Mention chips on a persisted user message (C7/D1). */}
              {(message.mentions ?? []).length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, justifyContent: 'flex-end' }}>
                  {message.mentions!.map((m) => (
                    <button
                      key={m.cardId}
                      type="button"
                      onClick={() => onOpenCard?.(m.cardId)}
                      title={m.front}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: '2px 8px',
                        borderRadius: 'var(--r-pill)',
                        border: '1px solid var(--border-2)',
                        background: 'var(--surface-2)',
                        color: 'var(--text-dim)',
                        fontFamily: 'var(--font-sans)',
                        fontSize: 11,
                        cursor: onOpenCard ? 'pointer' : 'default',
                        maxWidth: 200,
                      }}
                    >
                      <NNIcon name="brain" size={11} color="var(--text-dim)" />
                      <span
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          minWidth: 0,
                        }}
                      >
                        {(resolveCard(m.cardId)?.renderFrontText || m.front || '').trim() || m.front}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    );
  }

  const activityFirst = isStreaming || !answerStarted || toolCalls.some(call => call.awaitingConfirmation && !call.decision);
  const activity = toolCalls.length > 0 ? (
    <ToolActivityGroup
          toolCalls={toolCalls}
          elapsedMs={message.elapsedMs}
          streaming={isStreaming}
          answerStarted={answerStarted}
          resolveCard={resolveCard}
          deckNameById={deckNameById}
          onConfirm={(toolCallId, decision, payload) =>
            onConfirm(message.id, toolCallId, decision, payload)
          }
          onOpenCard={onOpenCard}
          onOpenDeckCards={onOpenDeckCards}
          onSourceCitation={onSourceCitation}
          t={t}
        />
  ) : null;

  // Assistant turn: model prose (above) is visibly separate from the cited cards
  // (below), making own-vs-general content distinguishable (AC3).
  return (
    <div className="nn-msg-row reomi-assistant" style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      <div
        title={formatTimestamp(message.createdAt, locale)}
        style={{ display: 'flex', alignItems: 'center', gap: 8 }}
      >
        <span className="reomi-brand-mark" aria-hidden style={{ width: 19, height: 19 }} />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)', fontFamily: 'var(--font-sans)' }}>
          {t('chat.stream.assistantName')}
        </span>
        {isNotebook && sourceCount != null && (
          <span style={{ fontSize: 11, color: 'var(--text-dim)', fontFamily: 'var(--font-sans)' }}>
            {t('chat.stream.bySources', { count: sourceCount })}
          </span>
        )}
        {formatTimeShort(message.createdAt, locale) && (
          <span
            className="nn-msg-time"
            style={{
              fontSize: 10.5,
              color: 'var(--text-dim)',
              fontFamily: 'var(--font-sans)',
            }}
          >
            {formatTimeShort(message.createdAt, locale)}
          </span>
        )}
      </div>

      {/* Collapsible reasoning trace — live-streams while the answer is still
          generating, then auto-collapses once the final answer arrives. */}
      {hasReasoning && (
        <ReasoningBlock
          reasoning={message.reasoning ?? ''}
          // Auto-open while streaming with no answer yet; collapse once prose lands.
          live={isStreaming && !answerStarted}
          t={t}
        />
      )}

      {/* Pending confirmations and live work stay above the answer. */}
      {activityFirst && activity}

      {/* Model prose rendered as Markdown (same pipeline as cards, via SafeHtml).
          The inline [card:<id>] grounding tokens are stripped — the sources are
          shown in the collapsible block below. */}
      {answerStarted ? (
        <AssistantMarkdown
          content={message.content}
          final={!isStreaming}
          citeNumbers={isNotebook ? numbering.numberOf : undefined}
          citationOf={isNotebook ? citationOf : undefined}
          onCite={isNotebook ? onSourceCitation : undefined}
          t={t}
        />
      ) : isStreaming ? (
        <span style={{ fontSize: 13, color: 'var(--text-dim)', fontStyle: 'italic' }}>
          {phase === 'calling_tool'
            ? t('chat.tool.running')
            : t('chat.stream.thinking')}
        </span>
      ) : null}

      {/* Notebook mode (A2): a row of numbered source chips — each NBCite number
          + a 15×21 letter-tile cover + «Title · стр. N». Click → onSourceCitation
          (the workspace scrolls the reader). Inline ¹² chips in the prose share
          the same numbering. */}
      {isNotebook && numbering.ordered.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, paddingTop: 2 }}>
          {numbering.ordered.map(({ n, citation }) => (
            <NumberedSourceChip
              key={`nbsrc-${citation.sourceChunkId}-${n}`}
              n={n}
              citation={citation}
              onClick={onSourceCitation}
              t={t}
            />
          ))}
        </div>
      )}

      {/* Cited cards (card mode) — collapsed by default into a count summary
          (they can be large); expandable to the full RichCard list (AC8),
          clearly delimited as "from your cards". Notebook mode renders the
          numbered chip row above instead. */}
      {!isNotebook && message.citations.length > 0 && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            paddingTop: 4,
            borderTop: '1px dashed var(--border-2)',
          }}
        >
          <button
            type="button"
            onClick={() => setSourcesOpen((v) => !v)}
            aria-expanded={sourcesOpen}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              alignSelf: 'flex-start',
              background: 'transparent',
              border: 'none',
              padding: '2px 0',
              cursor: 'pointer',
              color: 'var(--lime-400)',
              fontFamily: 'var(--font-sans)',
            }}
          >
            <NNIcon name="stack" size={13} color="var(--lime-400)" />
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: 1,
                textTransform: 'uppercase',
              }}
            >
              {t('chat.stream.sourcesCount', { count: message.citations.length })}
            </span>
            <span
              style={{
                display: 'inline-flex',
                transform: sourcesOpen ? 'rotate(-90deg)' : 'rotate(180deg)',
                transition: 'transform 140ms ease',
              }}
            >
              <NNIcon name="chevl" size={12} color="var(--lime-400)" />
            </span>
          </button>
          {sourcesOpen &&
            message.citations.map((cit, ci) =>
              isSourceCitation(cit) ? (
                <SourceCitationChip
                  key={`src-${cit.sourceChunkId}-${ci}`}
                  citation={cit}
                  onClick={onSourceCitation}
                  t={t}
                />
              ) : (
                <CitationCard
                  key={`card-${cit.chunkId}-${ci}`}
                  citation={cit}
                  card={resolveCard(cit.cardId)}
                  deckName={cit.deckId ? deckNameById.get(cit.deckId) : undefined}
                  onOpenCard={onOpenCard}
                  t={t}
                />
              ),
            )}
        </div>
      )}

      {/* Completed work is secondary to the answer; keep it available below the prose. */}
      {!activityFirst && activity}

      {/* Per-message actions: copy clean prose + «В заметки» + (last assistant
          only) regenerate + a dim model · token badge (B6). Ghost 26px buttons
          (A2). Only on a finished turn with prose. */}
      {!isStreaming && answerStarted && (
        <div className="reomi-message-footer" style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginLeft: -6 }}>
          <ActionBtn icon="copy" label={t('chat.message.copy')} onClick={() => onCopy?.()} />
          {onSaveAnswer && (
            <ActionBtn
              icon="note"
              label={t('notebooks.notes.saveAnswer')}
              onClick={() => onSaveAnswer()}
            />
          )}
          {canRegenerate && (
            <ActionBtn
              icon="sync"
              label={t('chat.message.regenerateShort')}
              onClick={() => onRegenerate?.()}
            />
          )}
          {(message.model || usageTotal(message.usage) > 0) && (
            <span
              data-tooltip={
                message.usage
                  ? `${t('chat.message.tokens', { count: usageTotal(message.usage).toLocaleString() })} · ${message.usage.promptTokens} in · ${message.usage.completionTokens} out`
                  : undefined
              }
              style={{
                marginLeft: 10,
                fontSize: 10.5,
                color: 'var(--text-dim)',
                fontFamily: 'var(--font-sans)',
                whiteSpace: 'nowrap',
              }}
            >
              {message.model ? (modelLabel?.(message.model) ?? message.model) : t('chat.message.tokens', { count: usageTotal(message.usage).toLocaleString() })}
            </span>
          )}
        </div>
      )}
    </div>
  );
};

// ── Notebook empty state (A2) ────────────────────────────────────────────────
// Quiet reading welcome + suggestion cards + «Обновить подсказки».
// Suggestion icons/tones cycle by index (bolt/amber, clock/sky, bulb/lime,
// target/violet); clicking a card sends the question. The refresh button renders
// only when `onRefresh` is passed (workspace wires it to the overview regen).

const EMPTY_SUGGESTION_STYLES = [
  { icon: 'bolt', tone: 'amber' },
  { icon: 'clock', tone: 'sky' },
  { icon: 'bulb', tone: 'lime' },
  { icon: 'target', tone: 'violet' },
] as const;

export const NotebookChatEmpty = ({
  questions,
  sending,
  onAsk,
  onRefresh,
  refreshing,
  t,
}: {
  questions: string[];
  sending: boolean;
  onAsk: (q: string) => void;
  onRefresh?: () => void;
  refreshing: boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
}) => (
  <div
    style={{
      margin: 'auto',
      position: 'relative',
      width: '100%',
      maxWidth: 600,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      padding: '8px 0',
    }}
  >
    <span className="nn-nb-welcome-icon">
      <NNIcon name="sparkle" size={24} color="var(--accent-500)" />
    </span>
    <h1
      style={{
        margin: 0,
        fontFamily: 'var(--font-serif)',
        fontWeight: 400,
        fontSize: 30,
        lineHeight: 1.35,
        letterSpacing: -0.5,
        textWrap: 'balance',
        color: 'var(--text)',
        textAlign: 'center',
      }}
    >
      {t('notebooks.chat.heroTitle')}
    </h1>
    <p
      style={{
        margin: '10px 0 0',
        fontSize: 13.5,
        lineHeight: 1.6,
        color: 'var(--text-muted)',
        textAlign: 'center',
        maxWidth: 420,
      }}
    >
      {t('notebooks.chat.heroSubtitle')}
    </p>

    {questions.length > 0 && (
      <div
        style={{
          marginTop: 28,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          width: '100%',
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 10,
            width: '100%',
            maxWidth: 560,
          }}
        >
          {questions.slice(0, 4).map((q, i) => {
            const s = EMPTY_SUGGESTION_STYLES[i % EMPTY_SUGGESTION_STYLES.length];
            return (
              <button
                key={q}
                type="button"
                className="nn-nb-sug"
                disabled={sending}
                onClick={() => onAsk(q)}
              >
                <span className="nn-nb-sug-icon">
                  <NNIcon name={s.icon} size={13} color={`var(--${s.tone}-400)`} />
                </span>
                <span style={{ fontSize: 12.5, lineHeight: 1.45, color: 'var(--text-muted)' }}>{q}</span>
              </button>
            );
          })}
        </div>
        {onRefresh && (
          <button
            type="button"
            className="nn-nb-refresh"
            disabled={refreshing}
            onClick={onRefresh}
            style={{
              marginTop: 14,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 28,
              padding: '0 12px',
              borderRadius: 999,
              cursor: refreshing ? 'default' : 'pointer',
              background: 'transparent',
              border: 'none',
              color: 'var(--text-dim)',
              fontFamily: 'var(--font-sans)',
              fontSize: 11.5,
              fontWeight: 500,
              opacity: refreshing ? 0.6 : 1,
            }}
          >
            <span className={refreshing ? 'nn-spin' : undefined} style={{ display: 'inline-flex' }}>
              <NNIcon name="sync" size={12} />
            </span>
            {t('notebooks.chat.refreshSuggestions')}
          </button>
        )}
      </div>
    )}
  </div>
);

// ── Assistant action button (ghost, 26px) ───────────────────────────────────
// NBActionBtn from the design — copy / save-to-notes / regenerate under an
// answer. Hover surface-2 via `.nn-nb-action`.

const ActionBtn = ({
  icon,
  label,
  onClick,
}: {
  icon: string;
  label: string;
  onClick: () => void;
}) => (
  <button
    type="button"
    className="nn-nb-action"
    aria-label={label}
    title={label}
    onClick={onClick}
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 6,
      height: 30,
      width: 30,
      justifyContent: 'center',
      padding: 0,
      borderRadius: 7,
      cursor: 'pointer',
      background: 'transparent',
      border: 'none',
      color: 'var(--text-dim)',
      fontFamily: 'var(--font-sans)',
      fontSize: 11.5,
      fontWeight: 500,
    }}
  >
    <NNIcon name={icon} size={13} />
  </button>
);

// ── Numbered source chip (NBSourceChip) ──────────────────────────────────────
// One chip under a grounded answer: the citation number + a 15×21 letter-tile
// cover (deterministic tone) + «Title · стр. N». Click → onSourceCitation.

const NumberedSourceChip = ({
  n,
  citation,
  onClick,
  t,
}: {
  n: number;
  citation: SourceCitation;
  onClick?: (c: SourceCitation) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) => {
  const clickable = !!onClick;
  const title = citation.sourceTitle ?? t('chat.source.untitled');
  const loc = citationLocation(citation, t);
  const tone = citationCoverTone(citation.sourceId);
  return (
    <button
      type="button"
      className="nn-nb-srcchip"
      disabled={!clickable}
      onClick={() => onClick?.(citation)}
      title={clickable ? t('chat.source.open') : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px 6px 7px',
        borderRadius: 9,
        cursor: clickable ? 'pointer' : 'default',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <span className="nn-nb-cite nn-nb-cite-static">{n}</span>
      <span
        aria-hidden
        style={{
          width: 15,
          height: 21,
          borderRadius: 4,
          flexShrink: 0,
          position: 'relative',
          background: `linear-gradient(150deg, var(--${tone}-500), var(--${tone}-600))`,
          boxShadow: 'inset 2px 0 0 var(--inset-shadow), 0 1px 3px var(--ambient-shadow)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-serif)',
            fontSize: 9,
            color: 'color-mix(in srgb, var(--text-on-violet) 92%, transparent)',
            lineHeight: 1,
          }}
        >
          {citationCoverLetter(citation.sourceTitle)}
        </span>
      </span>
      <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
        <span style={{ color: 'var(--text)', fontWeight: 500 }}>{title}</span>
        {loc ? ` · ${loc}` : ''}
      </span>
    </button>
  );
};

// ── One cited card (RichCard front, or snippet fallback) ─────────────────────

interface CitationCardProps {
  citation: CardCitation;
  card: Card | undefined;
  deckName: string | undefined;
  /** Jump to this card in /cards (AC3.6) — opens the bottom edit dock there. */
  onOpenCard?: (cardId: string) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const CitationCard = ({ citation, card, deckName, onOpenCard, t }: CitationCardProps) => (
  <NNCard padding={14} style={{ background: 'var(--surface-2)' }}>
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 6,
        marginBottom: deckName || card ? 8 : 0,
      }}
    >
      {deckName ? (
        <NNBadge tone="lime" size="xs">
          {deckName}
        </NNBadge>
      ) : (
        <span />
      )}
      {onOpenCard && (
        <button
          type="button"
          aria-label={t('chat.message.openCard')}
          title={t('chat.message.openCard')}
          onClick={() => onOpenCard(citation.cardId)}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--lime-400)',
            fontFamily: 'var(--font-sans)',
            fontSize: 11,
            fontWeight: 600,
            padding: 2,
            flexShrink: 0,
          }}
        >
          <NNIcon name="link" size={12} color="var(--lime-400)" />
          {t('chat.message.openCard')}
        </button>
      )}
    </div>
    {card && card.noteType ? (
      // The ONLY card renderer (Principle 4). Render the card's FRONT side.
      <RichCard
        noteType={card.noteType}
        fieldValues={card.note?.fieldValues ?? {}}
        side="front"
        templateOrd={card.templateOrd}
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: 14,
          lineHeight: 1.5,
          color: 'var(--text)',
          wordBreak: 'break-word',
        }}
      />
    ) : (
      // Fallback when the card couldn't be resolved (deleted / foreign): show the
      // server-provided snippet as plain text — never raw HTML.
      <div
        style={{
          fontFamily: 'var(--font-sans)',
          fontSize: 13.5,
          lineHeight: 1.5,
          color: 'var(--text-muted)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {citation.snippet ?? ''}
      </div>
    )}
  </NNCard>
);

// ── One cited source passage (NotebookLM M2) ─────────────────────────────────
// A compact doc chip — title + page + 2-line snippet. Clicking it calls
// `onClick` (the workspace scrolls its reader to the passage); in the global
// chat (no handler) it renders inert. Plain text only — never raw HTML.

interface SourceCitationChipProps {
  citation: SourceCitation;
  onClick?: (c: SourceCitation) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const SourceCitationChip = ({ citation, onClick, t }: SourceCitationChipProps) => {
  const clickable = !!onClick;
  return (
    <button
      type="button"
      disabled={!clickable}
      onClick={() => onClick?.(citation)}
      title={clickable ? t('chat.source.open') : undefined}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        width: '100%',
        textAlign: 'left',
        padding: '10px 12px',
        borderRadius: 'var(--r-md)',
        border: '1px solid var(--border)',
        background: 'var(--surface-2)',
        cursor: clickable ? 'pointer' : 'default',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
        <NNIcon name="doc" size={13} color="var(--sky-400)" />
        <span
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: 'var(--text)',
            fontFamily: 'var(--font-sans)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
            flex: 1,
          }}
        >
          {citation.sourceTitle ?? t('chat.source.untitled')}
        </span>
        {citation.page != null && (
          <NNBadge tone="sky" size="xs">
            {t('chat.source.page', { n: citation.page })}
          </NNBadge>
        )}
      </span>
      {citation.snippet && (
        <span
          style={{
            fontSize: 12.5,
            lineHeight: 1.5,
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-sans)',
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            wordBreak: 'break-word',
          }}
        >
          {citation.snippet}
        </span>
      )}
    </button>
  );
};

// ── Collapsible reasoning trace ──────────────────────────────────────────────
// Hand-rolled (no UI lib — Principle 4). While `live` (turn streaming, no answer
// yet) the block is forced open so deltas are visible; once the answer arrives it
// auto-collapses. A manual toggle takes over from the auto behavior so a user who
// opens it to read isn't fought by the auto-collapse.

interface ReasoningBlockProps {
  reasoning: string;
  live: boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const ReasoningBlock = ({ reasoning, live, t }: ReasoningBlockProps) => {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const tailRef = useRef<HTMLDivElement>(null);

  // Effective open state: a manual choice wins; otherwise mirror `live`.
  const open = manualOpen ?? live;

  // Keep the live trace pinned to its newest line while streaming + open.
  useEffect(() => {
    if (open && live && tailRef.current) {
      tailRef.current.scrollTop = tailRef.current.scrollHeight;
    }
  }, [open, live, reasoning]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        borderLeft: '2px solid var(--border-2)',
        paddingLeft: 12,
      }}
    >
      <button
        type="button"
        onClick={() => setManualOpen(!open)}
        aria-expanded={open}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 7,
          alignSelf: 'flex-start',
          background: 'transparent',
          border: 'none',
          padding: '2px 0',
          cursor: 'pointer',
          color: 'var(--text-dim)',
          fontFamily: 'var(--font-sans)',
        }}
      >
        {live && (
          <span className="nn-spin" aria-hidden>
            <NNIcon name="sparkle" size={12} color="var(--violet-400)" />
          </span>
        )}
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 700,
            letterSpacing: 1,
            textTransform: 'uppercase',
          }}
        >
          {t('chat.reasoning.label')}
        </span>
        <span style={{ fontSize: 10.5, color: 'var(--text-dim)' }}>
          {open ? t('chat.reasoning.hide') : t('chat.reasoning.show')}
        </span>
        <span
          style={{
            display: 'inline-flex',
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 140ms ease',
          }}
        >
          <NNIcon name="chevd" size={12} color="var(--text-dim)" />
        </span>
      </button>
      {open && (
        <div
          ref={tailRef}
          className="nn-scroll"
          style={{
            maxHeight: live ? 180 : 320,
            overflowY: 'auto',
            fontFamily: 'var(--font-sans)',
            fontSize: 12.5,
            lineHeight: 1.6,
            color: 'var(--text-dim)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {reasoning}
        </div>
      )}
    </div>
  );
};

// ── Condensed activity group: step row + collapsible wrapper (Codex-like) ─────
// Hand-rolled (no UI lib — Principle 4). The group is a single timed, collapsible
// work block wrapping one assistant turn's tool steps; each step is a COMPACT ROW
// (icon + human label + optional monospace arg + status chip), expandable to its
// body. `NNCard` is reserved for the step BODY, never the row header (AC1.4). The
// step body REUSES verbatim the CitationCard/RichCard (the only card sink),
// WebSearchResultText (untrusted), and ConfirmControls (Phase B) of the old
// per-call card, plus a post-apply write-summary line (S5 / AC5.1).

interface ToolActivityStepProps {
  toolCall: ToolCallVM;
  resolveCard: (cardId: string) => Card | undefined;
  deckNameById: Map<string, string>;
  /** Answer this step's pending confirmation (Phase B; payload = per-card
   *  selections + feedback from the confirm editor). */
  onConfirm: (decision: 'apply' | 'reject', payload?: ConfirmPayload) => void;
  /** Jump to a cited card in /cards (AC3.6). */
  onOpenCard?: (cardId: string) => void;
  /** Open a deck's cards in /cards (post-create exit when no card id, P3.7). */
  onOpenDeckCards?: (deckName: string) => void;
  /** A source citation chip was clicked (search_source results, M2). */
  onSourceCitation?: (c: SourceCitation) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const ToolActivityStep = ({
  toolCall,
  resolveCard,
  deckNameById,
  onConfirm,
  onOpenCard,
  onOpenDeckCards,
  onSourceCitation,
  t,
}: ToolActivityStepProps) => {
  const [open, setOpen] = useState(false);
  // Human-readable verb-phrase label + optional monospace arg (NO UUID/JSON).
  const { labelKey, params, argMono } = toolLabel(toolCall.name, toolCall.args, {
    resolveCardFront: (cardId) => {
      const card = resolveCard(cardId);
      // The card's front text isn't directly available as a string here; the
      // first field value is the closest human-readable front for the label.
      const fields = card?.note?.fieldValues;
      if (fields) {
        const first = Object.values(fields).find((v) => typeof v === 'string' && v.trim());
        if (typeof first === 'string') return first.trim().slice(0, 80);
      }
      return undefined;
    },
    deckName: (deckId) => deckNameById.get(deckId),
  });
  const label = t(labelKey, params);
  const isWebSearch = toolCall.name === 'web_search';
  const cardCitations = toolCall.citations ?? [];
  const hasResultContent =
    cardCitations.length > 0 || (toolCall.result ?? '').trim().length > 0;
  // A body exists when there's something to expand: cited cards, a textual result,
  // a pending confirmation, or a post-apply summary line (S5).
  const hasBody =
    hasResultContent ||
    !!toolCall.awaitingConfirmation ||
    !!toolCall.applySummary;
  // PostApplySummary is the ONLY visible body element (no citations/result) → omit
  // its bottom margin so the NNCard padding isn't doubled at the bottom.
  const summaryIsLast = !!toolCall.applySummary && !hasResultContent && !toolCall.awaitingConfirmation;

  // An undecided pending write is "awaiting confirmation", NOT "running" — on
  // reload the spinner would otherwise imply server work that isn't happening.
  const pendingConfirm = !!toolCall.awaitingConfirmation && !toolCall.decision;
  const statusTone = pendingConfirm
    ? 'amber'
    : toolCall.status === 'ok'
      ? 'lime'
      : toolCall.status === 'error'
        ? 'rose'
        : 'neutral';
  const statusText = pendingConfirm
    ? t('chat.tool.awaiting')
    : toolCall.status === 'ok'
      ? t('chat.tool.done')
      : toolCall.status === 'error'
        ? t('chat.tool.failed')
        : t('chat.tool.running');

  // Awaiting-confirmation steps must show their Apply/Reject body without a click.
  const bodyOpen = open || pendingConfirm;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* Compact row header — NOT an NNCard. Click toggles the body. */}
      <button
        type="button"
        onClick={() => hasBody && setOpen((v) => !v)}
        aria-expanded={hasBody ? bodyOpen : undefined}
        disabled={!hasBody}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minWidth: 0,
          width: '100%',
          textAlign: 'left',
          background: 'transparent',
          border: 'none',
          padding: '4px 2px',
          cursor: hasBody ? 'pointer' : 'default',
        }}
      >
        <NNIcon name={toolIcon(toolCall.name)} size={14} color="var(--violet-400)" />
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0, flex: 1 }}>
          <span
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              color: 'var(--text)',
              fontFamily: 'var(--font-sans)',
              flexShrink: 0,
            }}
          >
            {label}
          </span>
          {/* A query arg is rendered in --font-mono for a code-like Codex feel (AC3.2). */}
          {argMono && (
            <span
              title={argMono}
              style={{
                fontSize: 12,
                color: 'var(--text-dim)',
                fontFamily: 'var(--font-mono)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
              }}
            >
              {argMono}
            </span>
          )}
        </span>
        {/* Status chip: pause while awaiting approval, spinner while running,
            ✓/✕ once resolved. */}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
          {pendingConfirm ? (
            <NNIcon name="pause" size={13} color="var(--amber-400)" />
          ) : toolCall.status === 'running' ? (
            <span className="nn-spin" aria-hidden>
              <NNIcon name="sync" size={13} color="var(--text-dim)" />
            </span>
          ) : (
            <NNIcon
              name={toolCall.status === 'ok' ? 'check' : 'x'}
              size={13}
              color={toolCall.status === 'ok' ? 'var(--lime-400)' : 'var(--rose-400)'}
            />
          )}
          {toolCall.status === 'ok' && !pendingConfirm ? <span className="reomi-visually-hidden">{statusText}</span> : <NNBadge tone={statusTone} size="xs">{statusText}</NNBadge>}
          {hasBody && (
            <span
              style={{
                display: 'inline-flex',
                transform: bodyOpen ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform 140ms ease',
              }}
            >
              <NNIcon name="chevd" size={12} color="var(--text-dim)" />
            </span>
          )}
        </span>
      </button>

      {/* Step body — NNCard is reserved for the BODY (AC1.4). */}
      {hasBody && bodyOpen && (
        <NNCard className={pendingConfirm ? 'reomi-confirm-surface' : 'reomi-read-surface'} padding={pendingConfirm ? 12 : 0} style={{ background: pendingConfirm ? 'var(--surface-2)' : 'transparent' }}>
          {/* Phase B: confirm-before-write controls (reused verbatim). */}
          {toolCall.awaitingConfirmation && (
            <ConfirmControls toolCall={toolCall} onConfirm={onConfirm} t={t} />
          )}

          {/* Post-apply write summary line (S5 / AC5.1) — a single line, NOT a
              diff card. Only after an APPLIED create/edit; reject renders nothing. */}
          {toolCall.applySummary && (
            <PostApplySummary
              summary={toolCall.applySummary}
              deckNameById={deckNameById}
              onOpenCard={onOpenCard}
              onOpenDeckCards={onOpenDeckCards}
              noBottomMargin={summaryIsLast}
              t={t}
            />
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {/* search_cards → cited cards through the ONLY card sink (RichCard);
                search_source → source-passage chips (M2). */}
            {!isWebSearch &&
              cardCitations.map((cit, ci) =>
                isSourceCitation(cit) ? (
                  <SourceCitationChip
                    key={`src-${cit.sourceChunkId}-${ci}`}
                    citation={cit}
                    onClick={onSourceCitation}
                    t={t}
                  />
                ) : (
                  <CitationCard
                    key={`card-${cit.chunkId}-${ci}`}
                    citation={cit}
                    card={resolveCard(cit.cardId)}
                    deckName={cit.deckId ? deckNameById.get(cit.deckId) : undefined}
                    onOpenCard={onOpenCard}
                    t={t}
                  />
                ),
              )}
            {/* search_cards with a textual summary but no cited cards (genuine
                no-hit / error) → render the one-line summary as plain text. */}
            {!isWebSearch &&
              cardCitations.length === 0 &&
              (toolCall.result ?? '').length > 0 && (
                <CompactToolResult text={toolCall.result ?? ''} toolName={toolCall.name} t={t} />
              )}
            {/* web_search → UNTRUSTED: plain-text result with scheme-validated links. */}
            {isWebSearch && (toolCall.result ?? '').length > 0 && (
              <CompactToolResult text={toolCall.result ?? ''} toolName={toolCall.name} t={t} />
            )}
          </div>
        </NNCard>
      )}
    </div>
  );
};

// ── Post-apply write-summary line (S5 / AC5.1) ───────────────────────────────
// A single line after an APPLIED create/edit: "Created N cards in ‹deck› · open"
// / "Card updated · open" with a jump-link reusing onOpenCard → /cards?focus=.
// NOT a diff card. Reject path renders nothing (no applySummary set).

interface PostApplySummaryProps {
  summary: NonNullable<ToolCallVM['applySummary']>;
  deckNameById: Map<string, string>;
  onOpenCard?: (cardId: string) => void;
  /** Open the deck's cards in /cards — the create exit when no card id is known. */
  onOpenDeckCards?: (deckName: string) => void;
  /** Omit the bottom margin when this is the only element in the step body. */
  noBottomMargin?: boolean;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const PostApplySummary = ({ summary, deckNameById, onOpenCard, onOpenDeckCards, noBottomMargin, t }: PostApplySummaryProps) => {
  const deckName = summary.deckId ? deckNameById.get(summary.deckId) : undefined;
  // Four create variants: ±deck name (an unresolved deck must NOT leave an
  // «in  · open» hole) × singular/plural (proper phrasing for count=1).
  const count = summary.count ?? 1;
  const createKey =
    count === 1
      ? deckName
        ? 'chat.activity.appliedCreatedOne'
        : 'chat.activity.appliedCreatedOneNodeck'
      : deckName
        ? 'chat.activity.appliedCreated'
        : 'chat.activity.appliedCreatedNodeck';
  const text =
    summary.kind === 'create'
      ? t(createKey, { count, deck: deckName ?? '' })
      : t('chat.activity.appliedEdited');
  // Visible exit to the new/edited cards (P3.7): edit → /cards?focus=<id>; create
  // has no card id in-frame (the tool result is text-only), so fall back to the
  // deck filter /cards?q=deck:"<name>" when the deck resolves. No deck / no id ⇒
  // the line stays informational (no jump), exactly as before.
  const canOpen =
    summary.kind === 'edit'
      ? Boolean(summary.cardId && onOpenCard)
      : Boolean(deckName && onOpenDeckCards);
  const open = () => {
    if (summary.kind === 'edit') {
      if (summary.cardId) onOpenCard?.(summary.cardId);
    } else if (deckName) {
      onOpenDeckCards?.(deckName);
    }
  };
  return (
    <button
      type="button"
      onClick={open}
      disabled={!canOpen}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        alignSelf: 'flex-start',
        background: 'transparent',
        border: 'none',
        padding: '2px 0',
        marginBottom: noBottomMargin ? 0 : 6,
        cursor: canOpen ? 'pointer' : 'default',
        color: 'var(--lime-400)',
        fontFamily: 'var(--font-sans)',
        fontSize: 12.5,
        fontWeight: 600,
      }}
    >
      <NNIcon name="check" size={13} color="var(--lime-400)" />
      {text}
      {canOpen && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, opacity: 0.85 }}>
          · {t('chat.message.openCard')}
        </span>
      )}
    </button>
  );
};

// ── Condensed activity group (collapsible wrapper, Codex-like / AC1.1–1.3) ────
// Always wraps the turn's toolCalls[] (Decision A1). The header is the single
// collapse toggle: a work icon, a one-line summary ("Worked for Ns" once finished
// + `elapsedMs` present; live "working…" + nn-spin while live), the total step
// count (= raw step count = sum of summarizeSteps group counts), and overall
// status. Collapse state is driven ENTIRELY by groupHeaderState (Change 5):
// `manualOpen ?? (initialOpen || live)` (mirrors ReasoningBlock). Single-step
// renders light (no "N steps") + auto-expanded; multi-step collapses-on-answer.

interface ToolActivityGroupProps {
  toolCalls: ToolCallVM[];
  /** Turn-level wall-clock duration (ephemeral; absent on reload ⇒ no "Worked for Ns"). */
  elapsedMs?: number;
  streaming: boolean;
  answerStarted: boolean;
  resolveCard: (cardId: string) => Card | undefined;
  deckNameById: Map<string, string>;
  onConfirm: (toolCallId: string, decision: 'apply' | 'reject', payload?: ConfirmPayload) => void;
  onOpenCard?: (cardId: string) => void;
  onOpenDeckCards?: (deckName: string) => void;
  onSourceCitation?: (c: SourceCitation) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const ToolActivityGroup = ({
  toolCalls,
  elapsedMs,
  streaming,
  answerStarted,
  resolveCard,
  deckNameById,
  onConfirm,
  onOpenCard,
  onOpenDeckCards,
  onSourceCitation,
  t,
}: ToolActivityGroupProps) => {
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const singleStep = toolCalls.length === 1;
  // Force open when ANY step is awaiting confirmation so Apply/Reject is never
  // hidden behind a closed multi-step group (AC1.4).
  const anyAwaiting = toolCalls.some((c) => c.awaitingConfirmation && !c.decision);
  const { status, live, initialOpen } = groupHeaderState(toolCalls, {
    streaming,
    answerStarted,
    singleStepAutoOpen: singleStep && !answerStarted,
    anyAwaiting,
  });
  // Effective open state: a manual choice wins; else auto (initialOpen || live || anyAwaiting).
  const open = anyAwaiting || (manualOpen ?? (initialOpen || live));

  const groups = summarizeSteps(toolCalls);
  const totalSteps = toolCalls.length;
  // Per-tool pluralized phrase for a single CONTIGUOUS run of the same tool with a
  // `_n` plural key (AC2.2: "Reviewed 7 cards"). Only when the whole group is one
  // contiguous run (groups.length === 1) of count >= 2 and a `_n` key exists.
  // PLURAL_TOOL_NAMES is the single source (imported from chat-activity).
  const dominantPhrase =
    groups.length === 1 && groups[0]!.count >= 2 && PLURAL_TOOL_NAMES.has(groups[0]!.name)
      ? t(`chat.tool.${groups[0]!.name}_n`, { count: groups[0]!.count })
      : null;

  // Header summary line: live → "Working…"; finished with timing → "Worked for Ns";
  // finished without timing (reload) → the step count / pluralized phrase carries
  // it. Single-step is light (no "N steps" pluralization).
  const timeText =
    elapsedMs != null && !live ? t('chat.activity.worked', { time: formatElapsed(elapsedMs, t) }) : null;
  const countText = dominantPhrase ?? (singleStep ? '' : t('chat.activity.steps', { count: totalSteps }));
  const singleLabel = singleStep ? toolLabel(toolCalls[0]!.name, toolCalls[0]!.args) : null;
  const summaryText = live ? t('chat.activity.working') : (timeText ?? (singleLabel ? t(singleLabel.labelKey, singleLabel.params) : countText));
  // For a finished turn that ALSO has timing, surface the count/phrase as a suffix.
  const stepSuffix = !live && timeText && countText ? countText : null;

  const statusColor =
    status === 'error'
      ? 'var(--rose-400)'
      : status === 'running'
        ? 'var(--text-dim)'
        : 'var(--lime-400)';

  const renderStep = (tc: ToolCallVM) => <ToolActivityStep key={tc.id} toolCall={tc} resolveCard={resolveCard} deckNameById={deckNameById}
    onConfirm={(decision, payload) => onConfirm(tc.id, decision, payload)} onOpenCard={onOpenCard} onOpenDeckCards={onOpenDeckCards} onSourceCitation={onSourceCitation} t={t} />;
  if (anyAwaiting) {
    const pending = toolCalls.filter(call => call.awaitingConfirmation && !call.decision);
    const completed = toolCalls.filter(call => !pending.includes(call));
    return <div className="reomi-activity-stack">
      {completed.length > 0 && <details className="reomi-completed-actions"><summary><NNIcon name="check" size={13} />{t('chat.activity.completedSteps', { count: completed.length })}</summary>
        <div>{completed.map(renderStep)}</div>
      </details>}
      {pending.map(renderStep)}
    </div>;
  }

  if (singleStep && !live) return <div className="reomi-tool-trace">{renderStep(toolCalls[0]!)}</div>;

  return (
    <div className="reomi-chat-activity" data-live={live || undefined} data-open={open} data-settled={!live && !anyAwaiting || undefined}>
      {/* Header — the single collapse toggle for the whole work block. */}
      <button
        type="button"
        onClick={() => setManualOpen(!open)}
        aria-expanded={open}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          textAlign: 'left',
          background: 'transparent',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
        }}
      >
        {live ? (
          <span className="nn-spin" aria-hidden>
            <NNIcon name="bolt" size={14} color="var(--violet-400)" />
          </span>
        ) : (
          <NNIcon name="bolt" size={14} color={statusColor} />
        )}
        <span
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 8,
            flex: 1,
            minWidth: 0,
            fontFamily: 'var(--font-sans)',
          }}
        >
          <span style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text)' }}>
            {summaryText || t('chat.activity.steps', { count: totalSteps })}
          </span>
          {stepSuffix && (
            <span style={{ fontSize: 11.5, color: 'var(--text-dim)' }}>{stepSuffix}</span>
          )}
        </span>
        <span
          style={{
            display: 'inline-flex',
            flexShrink: 0,
            transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 140ms ease',
          }}
        >
          <NNIcon name="chevd" size={12} color="var(--text-dim)" />
        </span>
      </button>

      {/* Collapsed body = each step enumerated (the summarizeSteps grouping only
          drives the header copy; the expanded list shows EACH step — AC2.2). */}
      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {toolCalls.map((tc) => (
            <ToolActivityStep
              key={tc.id}
              toolCall={tc}
              resolveCard={resolveCard}
              deckNameById={deckNameById}
              onConfirm={(decision, payload) => onConfirm(tc.id, decision, payload)}
              onOpenCard={onOpenCard}
              onOpenDeckCards={onOpenDeckCards}
              onSourceCitation={onSourceCitation}
              t={t}
            />
          ))}
        </div>
      )}
    </div>
  );
};

// ── Confirm-before-write controls (Phase B / S10) ────────────────────────────
// Hand-rolled (no UI lib — Principle 4). Rendered inside a paused write/SRS
// tool-call card. Shows the dry-run blast radius ABOVE the Apply/Reject buttons
// so a destructive edit is confirmed knowingly; `willDelete` is surfaced
// PROMINENTLY (rose) because it loses FSRS history. Both buttons disable the
// instant one is clicked (`toolCall.decision` set) — the UI-side double-apply
// guard (the server enforces idempotency atomically too). Once a decision is
// chosen the controls collapse to a single status chip ("Applied"/"Rejected").

/** Per-card decisions + a note to the model, attached to a confirm answer. */
export type ConfirmPayload = Pick<ChatResumeRequest, 'cardSelections' | 'feedback'>;

export const ConfirmationAvailability = React.createContext(true);

interface ConfirmControlsProps {
  toolCall: ToolCallVM;
  onConfirm: (decision: 'apply' | 'reject', payload?: ConfirmPayload) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const ConfirmControls = ({ toolCall, onConfirm, t }: ConfirmControlsProps) => {
  const available = React.useContext(ConfirmationAvailability);
  const decided = toolCall.decision != null;
  const impact = toolCall.impact;
  const willDelete = impact?.willDeleteCards ?? 0;
  const affectsSiblings = impact?.affectsSiblings === true;
  // Editable per-card draft (create_card only) — parsed from the ORIGINAL args
  // (full values; the capped impact preview is display-only). Null → read-only
  // preview as before (other tools / malformed args).
  const draft = useMemo(
    () => (toolCall.name === 'create_card' ? createCardDraft(toolCall.args) : null),
    [toolCall.name, toolCall.args],
  );
  const [cards, setCards] = useState<{ include: boolean; fieldValues: Record<string, string> }[]>(
    () => (draft ?? []).map((d) => ({ include: true, fieldValues: { ...d.fieldValues } })),
  );
  const [feedback, setFeedback] = useState('');

  // Wizard (batch only): the user decides cards ONE AT A TIME — accept/exclude/
  // edit the current card, then advance; the decisions accumulate locally and
  // leave as ONE resume (`cardSelections`) from the final review step.
  const wizard = draft !== null && draft.length > 1;
  const [decisions, setDecisions] = useState<('accepted' | 'excluded' | null)[]>(
    () => (draft ?? []).map(() => null),
  );
  const [step, setStep] = useState(0);
  const [phase, setPhase] = useState<'cards' | 'review'>('cards');
  const acceptedCount = decisions.filter((d) => d === 'accepted').length;
  const excludedCount = decisions.filter((d) => d === 'excluded').length;

  const includedCount = wizard ? acceptedCount : cards.filter((c) => c.include).length;
  // B4/C8 — before/after previews (edit_card); create_card uses the editor when
  // the draft parsed, the capped preview rows otherwise.
  const diffRows = draft ? [] : confirmDiffRows(toolCall.name, impact);
  const willCreate = draft ? includedCount : (impact?.willCreateCards ?? 0);
  const planRows = toolCall.name === 'create_topic_plan' ? topicPlanCardRows(toolCall.args) : null;

  const setField = (cardIdx: number, field: string, value: string) =>
    setCards((prev) =>
      prev.map((c, i) =>
        i === cardIdx ? { ...c, fieldValues: { ...c.fieldValues, [field]: value } } : c,
      ),
    );
  const toggleCard = (cardIdx: number) =>
    setCards((prev) => prev.map((c, i) => (i === cardIdx ? { ...c, include: !c.include } : c)));

  // Decide the CURRENT wizard card and advance to the next undecided one (or
  // the review step once every card is decided). Re-deciding a visited card
  // overwrites and jumps forward to whatever is still undecided.
  const decide = (action: 'accepted' | 'excluded') => {
    const next = decisions.map((d, i) => (i === step ? action : d));
    setDecisions(next);
    const ni = nextUndecidedIndex(next, step);
    if (ni === -1) setPhase('review');
    else setStep(ni);
  };
  const jumpTo = (i: number) => {
    setStep(i);
    setPhase('cards');
  };

  const answer = (decision: 'apply' | 'reject') => {
    if (!available) return;
    const fb = feedback.trim();
    const state = wizard
      ? cards.map((c, i) => ({ include: decisions[i] === 'accepted', fieldValues: c.fieldValues }))
      : cards;
    const selections = decision === 'apply' && draft ? buildCardSelections(draft, state) : [];
    const payload: ConfirmPayload = {
      cardSelections: selections.length > 0 ? selections : undefined,
      feedback: fb.length > 0 ? fb : undefined,
    };
    onConfirm(decision, payload.cardSelections || payload.feedback ? payload : undefined);
  };

  /** One-line excerpt for the review rows (first non-empty field). */
  const excerptOf = (fv: Record<string, string>): string =>
    (Object.values(fv).find((v) => v.trim()) ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);

  return (
    <fieldset disabled={!available} className="reomi-confirm-content"
      style={{
        border: 0, margin: 0, padding: 0, minWidth: 0,
        marginTop: 10,
        paddingTop: 10,
        borderTop: '1px dashed var(--border-2)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <span
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: 1,
          textTransform: 'uppercase',
          color: 'var(--amber-400)',
          fontFamily: 'var(--font-sans)',
        }}
      >
        {t('chat.confirm.pendingTitle')}
      </span>

      {planRows && <PlanModuleList rows={planRows} t={t} confirm />}

      {/* What exactly changes / will be written — degrades silently when the
          payload is absent (old persisted rows, reload mid-pause). */}
      <ConfirmDiff rows={diffRows} proposalOnly={toolCall.name === 'create_card'} t={t} />
      {impact?.resourcePreview && !impact.proposedNote && <div className="reomi-resource-preview">
        {impact.resourcePreview.title && <strong>{impact.resourcePreview.title}</strong>}
        {impact.resourcePreview.destructive && <p className="reomi-resource-warning">{t('chat.confirm.resourceDeleteWarning')}</p>}
        <dl>{impact.resourcePreview.fields.map((field, index) => <div key={index}>
          <dt>{t(`chat.resourceFields.${field.field}`)}</dt>
          <dd>{field.before !== undefined && <del>{field.before}</del>}{field.after !== undefined && <span>{field.after}</span>}</dd>
        </div>)}</dl>
        {impact.resourcePreview.affected?.map(item => <span className="reomi-resource-count" key={item.kind}>{t(`chat.resourceKinds.${item.kind}`)}: {item.count}</span>)}
        {impact.resourcePreview.retained?.map(item => <span className="reomi-resource-count" key={`retained:${item.kind}`}>{t('chat.confirm.retainedResources')}: {t(`chat.resourceKinds.${item.kind}`)}: {item.count}</span>)}
        {toolCall.name === 'delete_notebook' && <p>{t('chat.confirm.notebookRetainedWork')}</p>}
      </div>}


      {/* save_note proposal (Р14 / N3): a flat preview — title + a capped content
          excerpt. NOT the create_card wizard (notes aren't cards), no −/+ diff
          (it's a creation). Present only for a notebook save_note. */}
      {impact?.proposedNote && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: 1,
              textTransform: 'uppercase',
              color: 'var(--text-dim)',
              fontFamily: 'var(--font-sans)',
            }}
          >
            {t('chat.confirm.noteTitle')}
          </span>
          <span
            style={{
              fontSize: 13,
              fontWeight: 700,
              color: 'var(--text)',
              fontFamily: 'var(--font-sans)',
              wordBreak: 'break-word',
            }}
          >
            {impact.proposedNote.title}
          </span>
          {impact.proposedNote.contentExcerpt.length > 0 && (
            <div
              style={{
                fontSize: 12,
                lineHeight: 1.5,
                color: 'var(--text-muted)',
                fontFamily: 'var(--font-sans)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                padding: '6px 8px',
                background: 'var(--surface-2)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--r-xs)',
              }}
            >
              {impact.proposedNote.contentExcerpt}
            </div>
          )}
        </div>
      )}

      {impact?.cardEvidence && <div className="reomi-card-evidence-preview">
        {impact.cardEvidence.map((evidence, index) => (!wizard || phase === 'review' || step === index) && <section key={index}>
          <strong>{t('chat.confirm.provenanceTitle')}{wizard ? ` · ${t('chat.confirm.cardOf', { n: index + 1, total: cards.length })}` : ''}</strong>
          {evidence.length ? evidence.map(item => <blockquote key={item.chunkId ?? `${item.sourceId}:${item.quote}`}>
            <span>{item.sourceTitle}{item.page != null ? ` · ${t('notebooks.reader.page', { n: item.page })}` : ''}</span>
            {item.kind === 'user_quote' && <small>{t('chat.confirm.userQuoteEvidence')}</small>}
            <p>{item.quote}</p>
          </blockquote>) : <p>{t('chat.confirm.noCardEvidence')}</p>}
        </section>)}
      </div>}

      {/* Source provenance (NotebookLM M3 / AC3.2): the passages the new card(s)
          will be LINKED to — «Источник: <title>, стр. N». Present only for a
          notebook create_card; absent everywhere else. */}
      {(impact?.provenance?.length ?? 0) > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              letterSpacing: 1,
              textTransform: 'uppercase',
              color: 'var(--text-dim)',
              fontFamily: 'var(--font-sans)',
            }}
          >
            {t('chat.confirm.provenanceTitle')}
          </span>
          {impact!.provenance!.map((p, i) => (
            <span
              key={`${p.chunkId}-${i}`}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                color: 'var(--text-muted)',
                fontFamily: 'var(--font-sans)',
              }}
            >
              <NNIcon name="doc" size={12} color="var(--sky-400)" />
              {p.page != null
                ? t('chat.confirm.provenanceRowPage', { title: p.sourceTitle, n: p.page })
                : t('chat.confirm.provenanceRow', { title: p.sourceTitle })}
            </span>
          ))}
        </div>
      )}

      {/* Single-card editor (create_card, one proposal): inline field edits.
          Built from the ORIGINAL args, so it works live AND after a reload. */}
      {draft && !wizard && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {cards.map((card, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 5,
                opacity: card.include ? 1 : 0.45,
                transition: 'opacity 120ms ease',
              }}
            >
              {!decided && !card.include && (
                <NNBtn size="sm" variant="ghost" icon="plus" onClick={() => toggleCard(i)}>
                  {t('chat.confirm.includeCard')}
                </NNBtn>
              )}
              {Object.entries(card.fieldValues).map(([field, value]) => (
                <label key={field} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span
                    style={{
                      fontSize: 10.5,
                      fontWeight: 600,
                      letterSpacing: 0.6,
                      textTransform: 'uppercase',
                      color: 'var(--text-dim)',
                      fontFamily: 'var(--font-sans)',
                    }}
                  >
                    {field}
                  </span>
                  <textarea
                    value={value}
                    disabled={decided || !card.include}
                    onChange={(e) => setField(i, field, e.target.value)}
                    rows={Math.min(6, Math.max(1, Math.ceil(value.length / 70) + (value.match(/\n/g)?.length ?? 0)))}
                    style={{
                      width: '100%',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12,
                      lineHeight: 1.5,
                      padding: '5px 8px',
                      borderRadius: 'var(--r-xs)',
                      border: '1px solid color-mix(in srgb, var(--lime-500) 25%, var(--border-2))',
                      background: 'color-mix(in srgb, var(--lime-500) 8%, transparent)',
                      color: 'var(--lime-300)',
                      resize: 'vertical',
                      outline: 'none',
                    }}
                  />
                </label>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Wizard (batch): ONE card at a time — accept / exclude / edit, then
          advance; a final review step fires the single resume. */}
      {wizard && !decided && phase === 'cards' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}>
            <span
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: 'var(--text)',
                fontFamily: 'var(--font-sans)',
              }}
            >
              {t('chat.confirm.cardOf', { n: step + 1, total: cards.length })}
            </span>
            <span style={{ fontSize: 11.5, color: 'var(--text-dim)', fontFamily: 'var(--font-sans)', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
              <span>✓ {acceptedCount}</span>
              <span>✕ {excludedCount}</span>
              {decisions[step] !== null && (
                <NNBadge tone={decisions[step] === 'accepted' ? 'lime' : 'neutral'} size="xs">
                  {decisions[step] === 'accepted'
                    ? t('chat.confirm.acceptedBadge')
                    : t('chat.confirm.excludedBadge')}
                </NNBadge>
              )}
            </span>
          </div>
          {Object.entries(cards[step]?.fieldValues ?? {}).map(([field, value]) => (
            <label key={`${step}:${field}`} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span
                style={{
                  fontSize: 10.5,
                  fontWeight: 600,
                  letterSpacing: 0.6,
                  textTransform: 'uppercase',
                  color: 'var(--text-dim)',
                  fontFamily: 'var(--font-sans)',
                }}
              >
                {field}
              </span>
              <textarea
                value={value}
                onChange={(e) => setField(step, field, e.target.value)}
                rows={Math.min(8, Math.max(1, Math.ceil(value.length / 70) + (value.match(/\n/g)?.length ?? 0)))}
                style={{
                  width: '100%',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  lineHeight: 1.5,
                  padding: '5px 8px',
                  borderRadius: 'var(--r-xs)',
                  border: '1px solid color-mix(in srgb, var(--lime-500) 25%, var(--border-2))',
                  background: 'color-mix(in srgb, var(--lime-500) 8%, transparent)',
                  color: 'var(--lime-300)',
                  resize: 'vertical',
                  outline: 'none',
                }}
              />
            </label>
          ))}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <NNBtn size="sm" variant="primary" icon="check" onClick={() => decide('accepted')}>
              {t('chat.confirm.acceptCard')}
            </NNBtn>
            <NNBtn size="sm" variant="ghost" icon="x" onClick={() => decide('excluded')}>
              {t('chat.confirm.excludeCard')}
            </NNBtn>
            <span style={{ flex: 1 }} />
            {step > 0 && (
              <NNBtn size="sm" variant="ghost" onClick={() => setStep(step - 1)}>
                {t('chat.confirm.back')}
              </NNBtn>
            )}
          </div>
        </div>
      )}

      {/* Wizard review: every card decided — a clickable summary, the feedback
          note, and the single Apply(N)/Reject pair below. */}
      {wizard && !decided && phase === 'review' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {cards.map((card, i) => (
            <button
              key={i}
              type="button"
              onClick={() => jumpTo(i)}
              title={t('chat.confirm.reviewJump')}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                width: '100%',
                textAlign: 'left',
                background: 'transparent',
                border: '1px solid var(--border-2)',
                borderRadius: 'var(--r-xs)',
                padding: '6px 9px',
                cursor: 'pointer',
                opacity: decisions[i] === 'excluded' ? 0.5 : 1,
              }}
            >
              <NNBadge tone={decisions[i] === 'accepted' ? 'lime' : 'neutral'} size="xs">
                {decisions[i] === 'accepted'
                  ? t('chat.confirm.acceptedBadge')
                  : t('chat.confirm.excludedBadge')}
              </NNBadge>
              <span
                style={{
                  fontSize: 12,
                  color: 'var(--text-muted)',
                  fontFamily: 'var(--font-sans)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  minWidth: 0,
                  textDecoration: decisions[i] === 'excluded' ? 'line-through' : 'none',
                }}
              >
                {t('chat.confirm.cardN', { n: i + 1 })} · {excerptOf(card.fieldValues)}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Optional note to the agent — "propose edits" without applying. Lands
          in the tool result on BOTH apply and reject. In the wizard it appears
          on the review step only. */}
      {!decided && (!wizard || phase === 'review') && (
        <textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder={t('chat.confirm.feedbackPlaceholder')}
          aria-label={t('chat.confirm.feedbackPlaceholder')}
          rows={1}
          maxLength={2000}
          style={{
            width: '100%',
            fontFamily: 'var(--font-sans)',
            fontSize: 12.5,
            lineHeight: 1.5,
            padding: '6px 9px',
            borderRadius: 'var(--r-xs)',
            border: '1px solid var(--border-2)',
            background: 'var(--surface-3)',
            color: 'var(--text)',
            resize: 'vertical',
            outline: 'none',
          }}
        />
      )}

      {/* Blast radius — only the parts the dry-run predicted. DELETE is prominent.
          In the wizard it shows on the review step (live count of accepted cards). */}
      {(!wizard || phase === 'review' || decided) &&
        (willCreate > 0 || willDelete > 0 || affectsSiblings) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {willCreate > 0 && (
            <span
              style={{
                fontSize: 12.5,
                color: 'var(--text-muted)',
                fontFamily: 'var(--font-sans)',
              }}
            >
              {t('chat.confirm.willCreate', { count: willCreate })}
            </span>
          )}
          {willDelete > 0 && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 13,
                fontWeight: 700,
                color: 'var(--rose-400)',
                fontFamily: 'var(--font-sans)',
              }}
            >
              <NNIcon name="x" size={13} color="var(--rose-400)" />
              {t('chat.confirm.willDelete', { count: willDelete })}
            </span>
          )}
          {affectsSiblings && (
            <span
              style={{
                fontSize: 12.5,
                color: 'var(--text-dim)',
                fontFamily: 'var(--font-sans)',
              }}
            >
              {t('chat.confirm.affectsSiblings')}
            </span>
          )}
        </div>
      )}

      {decided ? (
        // Once chosen, replace the buttons with a terminal status chip so the
        // decision is irreversible from the UI (no re-click path).
        <NNBadge tone={toolCall.decision === 'apply' ? 'lime' : 'neutral'} size="sm">
          {toolCall.decision === 'apply'
            ? t('chat.confirm.applied')
            : t('chat.confirm.rejected')}
        </NNBadge>
      ) : (
        // The single Apply/Reject pair: hidden mid-wizard (the per-card
        // accept/exclude buttons drive those steps), shown on review.
        (!wizard || phase === 'review') && (
          <div style={{ display: 'flex', gap: 8 }}>
            <NNBtn
              size="sm"
              variant="primary"
              icon="check"
              disabled={decided || (draft !== null && includedCount === 0)}
              onClick={() => answer('apply')}
            >
              {wizard ? t('chat.confirm.applyN', { count: includedCount }) : t('chat.confirm.apply')}
            </NNBtn>
            <NNBtn
              size="sm"
              variant="ghost"
              icon="x"
              disabled={decided}
              onClick={() => answer('reject')}
            >
              {t('chat.confirm.reject')}
            </NNBtn>
          </div>
        )
      )}
    </fieldset>
  );
};

// ── Untrusted web-search result renderer (plain text + safe links) ───────────
// Brave title/snippet/url are attacker-influenced. We render the result string
// as PLAIN React text nodes — markup like `[x](javascript:)` or `<img onerror>`
// shows literally, never interpreted. Bare http(s) URLs found in the text are
// promoted to <a href> ONLY after `safeWebUrl` validates the scheme; any other
// scheme stays inert literal text. There is NO markdown / SafeHtml path here.

const URL_CANDIDATE_RE = /(https?:\/\/[^\s<>"']+)/gi;

const WebSearchResultText = ({ text }: { text: string }) => {
  // Split on URL candidates and interleave validated links with literal text.
  const parts = text.split(URL_CANDIDATE_RE);
  return (
    <div
      style={{
        fontFamily: 'var(--font-sans)',
        fontSize: 13,
        lineHeight: 1.55,
        color: 'var(--text-muted)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {parts.map((part, i) => {
        // Odd indices are the captured URL candidates (split with one capture group).
        if (i % 2 === 1) {
          const href = safeWebUrl(part);
          if (href) {
            return (
              <a
                key={i}
                href={href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                style={{ color: 'var(--sky-400)', wordBreak: 'break-all' }}
              >
                {part}
              </a>
            );
          }
          // Rejected scheme / malformed → inert literal text.
          return <React.Fragment key={i}>{part}</React.Fragment>;
        }
        return <React.Fragment key={i}>{part}</React.Fragment>;
      })}
    </div>
  );
};

function PlanModuleList({
  rows,
  t,
  confirm = false,
}: {
  rows: NonNullable<ReturnType<typeof topicPlanCardRows>>;
  t: (key: string, params?: Record<string, string | number>) => string;
  confirm?: boolean;
}) {
  const pageCount = rows.reduce((count, row) => count + row.urls.length, 0);
  return (
    <div className="reomi-tool-result-list">
      {confirm && <div className="reomi-tool-result-count">{t('chat.plan.confirm')}</div>}
      <div className="reomi-tool-result-count">{t('chat.plan.modules', { count: rows.length })}</div>
      {confirm && pageCount > 0 && <div className="reomi-tool-result-count">{t('chat.plan.pages', { count: pageCount })}</div>}
      {rows.map((row, index) => <div className="reomi-tool-result-row" key={`${row.title}-${index}`}>
        <span>{row.title}</span>
        <small>{row.outcome}</small>
        {row.urls.map((url) => {
          const href = safeWebUrl(url);
          if (!href) return null;
          return <a key={href} href={href} target="_blank" rel="noopener noreferrer nofollow">{href}</a>;
        })}
      </div>)}
    </div>
  );
}

function CompactToolResult({ text, toolName, t }: { text: string; toolName: string; t: (key: string, params?: Record<string, string | number>) => string }) {
  const [expanded, setExpanded] = useState(false);
  const router = useAppNavigation();
  const planRows = toolName === 'propose_topic_plan' ? topicPlanCardRows(text) : null;
  if (planRows) return <PlanModuleList rows={planRows} t={t} />;
  const deckRows = Array.from(text.matchAll(/^\s*-\s+(.+?)\s+\[deck:([^\]]+)\]\s*[—–-]\s*(\d+) card\(s\), (\d+) due/gm), match => ({ title: match[1], id: match[2], total: match[3], due: match[4] }));
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { /* Existing plain-text tools. */ }
  const rawItems: any[] = Array.isArray(parsed?.items) ? parsed.items.filter((item: unknown) => item && typeof item === 'object' && !Array.isArray(item)) : [];
  const items: any[] = deckRows.length ? deckRows : rawItems.filter(item => typeof item.title === 'string' || typeof item.name === 'string');
  if (items.length) return <div className="reomi-tool-result-list">
    <div className="reomi-tool-result-count">{t('chat.activity.results', { count: typeof parsed?.total === 'number' ? parsed.total : items.length })}</div>
    {(expanded ? items : items.slice(0, 3)).map((item, index) => {
      const title = typeof item.title === 'string' ? item.title : item.name;
      const path = typeof item.id !== 'string' ? null : toolName === 'list_library' ? `/library/${encodeURIComponent(item.id)}` : toolName === 'list_notebooks' ? `/notebooks/${encodeURIComponent(item.id)}` : deckRows.length ? `/cards?q=${encodeURIComponent(`deck:"${title}"`)}` : null;
      return <div className="reomi-tool-result-row" key={item.id ?? index}>
        {path ? <button type="button" onClick={() => router.push(path)}>{title}</button> : <span>{title}</span>}
        {deckRows.length > 0 && <span className="reomi-tool-result-numbers">{t('chat.activity.cardsCount', { count: item.total })}<small>{t('chat.activity.dueCount', { count: item.due })}</small></span>}
        {item.kind && <small>{String(item.kind).toUpperCase()}</small>}
      </div>;
    })}
    {items.length > 3 && <button type="button" className="reomi-tool-more" onClick={() => setExpanded(value => !value)}>{t(expanded ? 'chat.activity.collapseResults' : 'chat.activity.moreResults', { count: items.length - 3 })}</button>}
  </div>;
  const printable = rawItems.some(item => typeof item.text === 'string') ? rawItems.filter(item => typeof item.text === 'string').map(item => item.text).join('\n\n') : text;
  const result = compactToolText(printable);
  return <div className="reomi-tool-result"><WebSearchResultText text={expanded ? result.full : result.preview} />
    {result.truncated && <button type="button" className="reomi-tool-more" onClick={() => setExpanded(value => !value)}>{t(expanded ? 'chat.activity.collapseResults' : 'chat.tool.resultDetails')}</button>}
  </div>;
}

// ── Compact dropdown menu (hand-rolled — no UI lib, Principle 4) ──────────────
// Shared by the model + deck-scope pickers. A trigger button opens a small
// absolutely-positioned popover above the composer; clicking outside or picking
// an option closes it. Inline styles + CSS vars; primitives from ui.tsx.

interface PickerMenuOption {
  id: string | null;
  label: string;
}

interface PickerMenuProps {
  /** Trigger label prefix (e.g. "Model"). */
  triggerLabel: string;
  /** Current selection's display label (shown after the prefix). */
  valueLabel: string;
  icon: 'bolt' | 'filter';
  options: PickerMenuOption[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

const PickerMenu = ({
  triggerLabel,
  valueLabel,
  icon,
  options,
  selectedId,
  onSelect,
}: PickerMenuProps) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const layer = useTransientLayer({ root: ref, enabled: open, onClose: () => setOpen(false) });

  return (
    <div ref={ref} style={{ position: 'relative' }} onKeyDown={event => {
      if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); void layer.close(); }
      if (open && ['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const items=Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')??[]);
        const index=items.indexOf(document.activeElement as HTMLButtonElement);
        const next=event.key==='Home'?0:event.key==='End'?items.length-1:Math.max(0,Math.min(items.length-1,index+(event.key==='ArrowDown'?1:-1)));
        items[next]?.focus();
      }
    }}>
      {/* Codex-style compact pill (S6 / AC6.1): leading glyph + value + chevron,
          --r-pill rounded. Cosmetic only — the menu/selection/persistence below
          are unchanged. Hand-rolled (inline + CSS vars, Principle 4). */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={triggerLabel}
        aria-label={triggerLabel}
        aria-expanded={open}
        className="reomi-composer-picker"
      >
        <NNIcon name={icon} size={13} color="var(--text-dim)" />
        <span
          style={{
            maxWidth: 160,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {valueLabel}
        </span>
        <NNIcon name="chevd" size={12} color="var(--text-dim)" />
      </button>
      {open && (
        <div
          role="menu"
          className="nn-scroll"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 6px)',
            left: 0,
            minWidth: 180,
            maxWidth: 280,
            maxHeight: 280,
            overflowY: 'auto',
            padding: 4,
            borderRadius: 'var(--r-md)',
            border: '1px solid var(--border-2)',
            background: 'var(--surface)',
            boxShadow: 'var(--shadow-lg)',
            zIndex: 20,
            display: 'flex',
            flexDirection: 'column',
            gap: 2,
          }}
        >
          {options.map((opt) => {
            const isSelected = opt.id === selectedId;
            return (
              <button
                key={opt.id ?? '__all__'}
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                onClick={() => {
                  onSelect(opt.id);
                  setOpen(false);
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 8,
                  padding: '8px 10px',
                  borderRadius: 'var(--r-sm)',
                  border: 'none',
                  cursor: 'pointer',
                  background: isSelected ? 'var(--surface-3)' : 'transparent',
                  color: 'var(--text)',
                  fontFamily: 'var(--font-sans)',
                  fontSize: 13,
                  textAlign: 'left',
                  width: '100%',
                }}
              >
                <span
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {opt.label}
                </span>
                {isSelected && <NNIcon name="check" size={13} color="var(--lime-400)" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ── Model (reasoning-level) picker (S3 / AC2.4) ──────────────────────────────
// Rendered only when status.models is non-empty. Selecting an option persists it
// as last-used; the chosen model rides every turn (send / resume / regenerate).

interface ModelPickerProps {
  models: ChatModelOption[];
  value: string | null;
  onSelect: (id: string) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

export const ModelPicker = ({ models, value, onSelect, t }: ModelPickerProps) => {
  const current = models.find((m) => m.id === value) ?? models.find((m) => m.default) ?? models[0];
  return (
    <PickerMenu
      triggerLabel={t('chat.composer.model')}
      valueLabel={current ? current.label : t('chat.composer.model')}
      icon="bolt"
      options={models.map((m) => ({ id: m.id, label: m.label }))}
      selectedId={current?.id ?? null}
      onSelect={(id) => {
        if (id) onSelect(id);
      }}
    />
  );
};

// ── Deep-research mode toggle ─────────────────────────────────────────────────
// A pill TOGGLE (not a dropdown) next to the pickers: active ⇒ every turn rides
// `research: true` (research prompt + raised step/budget caps server-side).
// Sticky via localStorage; hidden when the server has no fetch_page tool.

interface ResearchToggleProps {
  active: boolean;
  onToggle: () => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

export const ResearchToggle = ({ active, onToggle, t }: ResearchToggleProps) => (
  <button type="button" onClick={onToggle} className="reomi-composer-research"
    title={t('chat.composer.researchHint')} aria-label={t('chat.composer.research')} aria-pressed={active}>
    <NNIcon name="doc" size={16} />
  </button>
);

// ── Deck-scope picker (S7 / AC3.7) ───────────────────────────────────────────
// An optional, clearable deck scope sent as the turn-level deckId. "All cards"
// clears it (deckId undefined ⇒ global retrieval, today's behavior).

interface DeckScopePickerProps {
  decks: { id: string; name: string }[];
  value: string | null;
  onSelect: (id: string | null) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

export const DeckScopePicker = ({ decks, value, onSelect, t }: DeckScopePickerProps) => {
  const current = decks.find((d) => d.id === value);
  return (
    <PickerMenu
      triggerLabel={t('chat.composer.deckScope')}
      valueLabel={current ? current.name : t('chat.composer.allDecks')}
      icon="filter"
      options={[
        { id: null, label: t('chat.composer.allDecks') },
        ...decks.map((d) => ({ id: d.id, label: d.name })),
      ]}
      selectedId={value}
      onSelect={onSelect}
    />
  );
};
