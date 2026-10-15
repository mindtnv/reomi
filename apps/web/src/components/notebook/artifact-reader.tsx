'use client';

/* eslint-disable react/forbid-elements -- TODO: replace raw input, select, and button with TextInput, Button, or NNSelect. */

// ArtifactReader («Блокноты 2.0» — full-window studio document reader). The
// generated studio document was unreadable in the 340px dock («микро окно»), so
// a ready artifact now opens here: a full-window overlay (like the citation
// viewer, but on the whole screen) with a centered, readable column.
//
//   ┌────────────────────────────── overlay ──────────────────────────────┐
//   │ ▣ type · title            копир · в заметку · перегенер · .md · ✕    │ ← header
//   ├──────────────────────────────────────────────────────────────────────┤
//   │            ┌────────── max-width 860, font 15/1.7 ──────────┐         │
//   │            │  rendered markdown (RichCard pipeline)         │  scroll │
//   │            │  [src:] tokens → inline numbered chips ¹²      │         │
//   │            │  ── footnote row [1][2]… ──                    │         │
//   │            └────────────────────────────────────────────────┘         │
//   └──────────────────────────────────────────────────────────────────────┘
//
//  • md (ready): RichCard with the ARTIFACT_MD_NOTE_TYPE shim. The prose keeps
//    its `[src:<chunkId>]` tokens; `useInlineCitations` decorates them into
//    clickable numbered superscripts AFTER each render (re-runs on contentMd
//    change; walks text nodes only, so mermaid SVG islands are untouched). A
//    footnote chip row at the foot mirrors them. Both call onOpenCitation(chunkId).
//  • live (pending|generating): the same partial-stream view as the old inline
//    viewer — growing markdown + a blinking caret + a «≈N симв.» counter (quiz
//    shows a spinner placeholder, its raw JSON isn't readable).
//  • quiz (ready): the QuizPlayer rendered inside the overlay (wider = comfier).
//
// Esc closes. The component is presentational — the parent (StudioPanel) owns the
// store calls + polling and threads them in as callbacks.

import { NavigationReturn } from '../navigation';
import { LayerParent, useTransientLayer } from '@/lib/use-transient-layer';
import { useNavigationScroll } from '@/lib/use-navigation-scroll';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { SourceCitation } from '@reomi/shared';
import { NNBtn, NNIcon, NNSkeleton } from '@/components/ui';
import { RichCard } from '@/components/rich-card';
import { useInlineCitations } from '@/components/chat/source-citations';
import { raiseToast } from '@/components/toasts';
import {
  ARTIFACT_MD_NOTE_TYPE,
  parseArtifactCitations,
  stripSrcTokens,
} from '@/lib/notebook-artifacts';
import { downloadMarkdown } from '@/lib/markup-export';
import { formatCharCount } from '@/lib/artifact-progress';
import { QuizPlayer } from '@/components/notebook/quiz-player';
import type { buildAttemptAnswers } from '@/lib/quiz-player';
import type { NotebookArtifactType } from '@reomi/shared';
import type { NotebookArtifact, QuizAttempt } from '@/lib/types';

type Tfn = (key: string, params?: Record<string, string | number>) => string;

// The icon shown per artifact type (mirrors the studio panel's TYPE_ICON).
const TYPE_ICON: Record<NotebookArtifactType, string> = {
  summary: 'doc',
  study_guide: 'book',
  faq: 'bulb',
  timeline: 'clock',
  glossary: 'tag',
  quiz: 'target',
};

// Per-type accent tone (mirrors the studio panel's TYPE_TONE).
const TYPE_TONE: Record<NotebookArtifactType, string> = {
  summary: 'lime',
  study_guide: 'sky',
  faq: 'amber',
  timeline: 'violet',
  glossary: 'rose',
  quiz: 'sky',
};

export interface ArtifactReaderProps {
  loadError?: boolean;
  onRetry?: () => void;
  notebookId: string;
  /** The open artifact (full variant with contentMd/contentJson), or null while
   *  the first load resolves. */
  artifact: NotebookArtifact | null;
  /** True while the full content is (re)fetching and we have nothing to show. */
  loading: boolean;
  /** Source-id scope snapshot (for citation resolution). */
  sourceIds: string[];
  /** Quiz attempt submit + history (threaded into the embedded QuizPlayer). */
  submitQuizAttempt: (
    notebookId: string,
    artifactId: string,
    answers: ReturnType<typeof buildAttemptAnswers>,
  ) => Promise<QuizAttempt>;
  listQuizAttempts: (notebookId: string, artifactId: string) => Promise<QuizAttempt[]>;
  /** A `[src:]` chip was clicked — the workspace resolves the chunk's source +
   *  opens its citation-viewer. */
  onOpenCitation: (chunkId: string, sourceIds: string[]) => void;
  /** «В заметку» — save the ready artifact's markdown into the notebook's notes. */
  onSaveToNote: (title: string, contentMd: string, artifact?: NotebookArtifact) => void | Promise<void>;
  /** «Перегенерировать» — kick a regenerate (the parent closes the reader). */
  onRegenerate: () => void;
  /** «Удалить» — delete the artifact (the parent closes the reader). */
  onDelete: () => void;
  /** «Слабые места → карточки» (quiz) — prefill the chat composer. */
  onPrefillChat: (text: string) => void;
  /** ✕ / Esc / backdrop — close the overlay. */
  onClose: () => void;
  t: Tfn;
}

export const ArtifactReader = ({
  loadError,
  onRetry,
  notebookId,
  artifact,
  loading,
  sourceIds,
  submitQuizAttempt,
  listQuizAttempts,
  onOpenCitation,
  onSaveToNote,
  onRegenerate,
  onDelete,
  onPrefillChat,
  onClose,
  t,
}: ArtifactReaderProps) => {
  const root = useRef<HTMLDivElement>(null);
  // The artifact is addressed by its existing route/journal entry. Register
  // dismissal/focus ownership without inserting another browser history entry.
  const layer = useTransientLayer({ root, modal: true, history: false, onClose });

  // A ready quiz renders the PLAYER inside the overlay (wider = comfier).
  const isQuizReady =
    artifact != null && artifact.type === 'quiz' && artifact.status === 'ready';

  return (
    <LayerParent.Provider value={layer.id}>
      <div
        className="nn-dialog-backdrop nn-artifact-reader-backdrop"
        onClick={() => void layer.close()}
        aria-hidden
      />
      <div ref={root} className="nn-artifact-reader" role="dialog" aria-modal="true" aria-label={artifact?.title ?? t('notebooks.studio.heading')} tabIndex={-1}>
        {loadError && <div role="alert" className="nn-navigation-notice"><span>{t('assistant.contextFailed')}</span><NNBtn size="sm" onClick={onRetry}>{t('review.retry')}</NNBtn></div>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 16px', fontSize: 12, color: 'var(--text-dim)' }}><NavigationReturn showLabel />
          {artifact?.ownerKind === 'source' && <span>{artifact.sourceOriginTitle}{!artifact.sourceId ? ` · ${t('assistant.sourceUnavailable')}` : ''}</span>}
        </div>
        {isQuizReady ? (
          // The QuizPlayer owns its own header (Back) — drop our chrome and let it
          // fill the overlay column. A thin close affordance rides the corner.
          <div className="nn-artifact-reader-quiz">
            <QuizPlayer
              notebookId={notebookId}
              artifact={artifact!}
              sourceIds={artifact!.sourceIds ?? sourceIds}
              submitQuizAttempt={submitQuizAttempt}
              listQuizAttempts={listQuizAttempts}
              onOpenCitation={onOpenCitation}
              onPrefillChat={onPrefillChat}
              onBack={() => void layer.close()}
              t={t}
            />
          </div>
        ) : (
          <DocumentBody
            artifact={artifact}
            loading={loading}
            sourceIds={sourceIds}
            onOpenCitation={onOpenCitation}
            onSaveToNote={onSaveToNote}
            onRegenerate={onRegenerate}
            onDelete={onDelete}
            onClose={() => void layer.close()}
            t={t}
          />
        )}
      </div>
    </LayerParent.Provider>
  );
};

// ── Markdown document body (header + readable column) ───────────────────────────

const DocumentBody = ({
  artifact,
  loading,
  sourceIds,
  onOpenCitation,
  onSaveToNote,
  onRegenerate,
  onDelete,
  onClose,
  t,
}: {
  artifact: NotebookArtifact | null;
  loading: boolean;
  sourceIds: string[];
  onOpenCitation: (chunkId: string, sourceIds: string[]) => void;
  onSaveToNote: (title: string, contentMd: string, artifact?: NotebookArtifact) => void | Promise<void>;
  onRegenerate: () => void;
  onDelete: () => void;
  onClose: () => void;
  t: Tfn;
}) => {
  const navigationScope=artifact?.ownerKind==='source'?`source:${artifact.sourceId??artifact.sourceOriginId??''}`:`notebook:${artifact?.notebookId??''}`;
  const position=useNavigationScroll(navigationScope,'artifact',{ready:Boolean(artifact)&&!loading,queryKey:artifact?.id});
  const contentMd = artifact?.contentMd ?? '';
  // A job still running streams partial raw text into content_md — show it live
  // (md: caret-tailed prose; quiz: a placeholder, the raw JSON isn't readable).
  const live =
    artifact != null && (artifact.status === 'generating' || artifact.status === 'pending');

  const { prose, footnotes, numbering } = useMemo(
    () => parseArtifactCitations(contentMd),
    [contentMd],
  );

  const onCopy = useCallback(() => {
    void navigator.clipboard
      ?.writeText(stripSrcTokens(contentMd))
      .then(() => raiseToast({ kind: 'info', title: t('notebooks.studio.copied') }))
      .catch(() => undefined);
  }, [contentMd, t]);

  const onDownload = useCallback(() => {
    if (!artifact) return;
    downloadMarkdown(artifact.title || t('notebooks.studio.untitled'), stripSrcTokens(contentMd));
  }, [artifact, contentMd, t]);

  const tone = artifact ? TYPE_TONE[artifact.type] : 'sky';
  const icon = artifact ? TYPE_ICON[artifact.type] : 'doc';

  return (
    <div className="nn-artifact-reader-shell">
      {/* Header */}
      <div className="nn-artifact-reader-head">
        <span
          className="nn-artifact-reader-tile"
          style={{
            background: `color-mix(in srgb, var(--${tone}-500) 14%, transparent)`,
            border: `1px solid color-mix(in srgb, var(--${tone}-500) 30%, transparent)`,
          }}
          aria-hidden
        >
          <NNIcon name={icon} size={15} color={`var(--${tone}-400)`} />
        </span>
        <span className="nn-artifact-reader-title" title={artifact?.title}>
          {artifact?.title ?? t('notebooks.studio.untitled')}
        </span>
        <span style={{ flex: 1 }} />
        {artifact && !live && (
          <>
            <NNBtn
              variant="ghost"
              size="sm"
              icon="clip"
              ariaLabel={t('notebooks.studio.copy')}
              title={t('notebooks.studio.copy')}
              onClick={onCopy}
            />
            <NNBtn
              variant="ghost"
              size="sm"
              icon="doc"
              ariaLabel={t('notebooks.studio.toNote')}
              title={artifact.ownerKind === 'source' && !artifact.sourceId ? t('assistant.sourceUnavailable') : t('notebooks.studio.toNote')}
              disabled={artifact.ownerKind === 'source' && !artifact.sourceId}
              onClick={() => void onSaveToNote(artifact.title, contentMd, artifact)}
            />
            <NNBtn
              variant="ghost"
              size="sm"
              icon="arrow"
              ariaLabel={t('notebooks.studio.download')}
              title={t('notebooks.studio.download')}
              onClick={onDownload}
            />
            <NNBtn
              variant="ghost"
              size="sm"
              icon="sync"
              ariaLabel={t('notebooks.studio.regenerate')}
              title={artifact.ownerKind === 'source' && !artifact.sourceId ? t('assistant.sourceUnavailable') : t('notebooks.studio.regenerate')}
              disabled={artifact.ownerKind === 'source' && !artifact.sourceId}
              onClick={onRegenerate}
            />
            <NNBtn
              variant="ghost"
              size="sm"
              icon="x"
              ariaLabel={t('notebooks.studio.delete')}
              title={t('notebooks.studio.delete')}
              onClick={onDelete}
            />
            <span className="nn-artifact-reader-head-sep" aria-hidden />
          </>
        )}
        <NNBtn
          variant="ghost"
          size="sm"
          icon="chevd"
          ariaLabel={t('notebooks.studio.readerClose')}
          title={t('notebooks.studio.readerClose')}
          onClick={onClose}
        />
      </div>

      {/* Scrollable readable column */}
      <div ref={position.ref} className="nn-scroll nn-artifact-reader-scroll">
        <div className="nn-artifact-reader-col">
          {(loading && !artifact) || !artifact ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <NNSkeleton style={{ height: 22, width: '50%' }} />
              <NNSkeleton style={{ height: 160 }} />
            </div>
          ) : live && artifact.type === 'quiz' ? (
            // Quiz streams raw JSON into content_md — unreadable as markdown.
            <div className="nn-empty-state" style={{ paddingTop: 40, paddingBottom: 40 }}>
              <span className="nn-empty-state-icon">
                <span className="nn-spin" style={{ display: 'flex' }}>
                  <NNIcon name="sync" size={24} color="var(--lime-400)" />
                </span>
              </span>
              <p className="nn-empty-state-hint">
                {t('notebooks.studio.quizGenerating', {
                  chars: liveCharsDisplay(contentMd.length, t),
                })}
              </p>
            </div>
          ) : live ? (
            // Markdown types: render the partial prose with a blinking caret. Skip
            // the footnote row — [src:] tokens finalize (intersect) only at ready.
            <>
              <h1 className="nn-artifact-reader-doc-title">{artifact.title}</h1>
              {contentMd.length === 0 ? (
                <p style={{ fontSize: 14, color: 'var(--text-dim)', margin: 0 }}>
                  {t('notebooks.studio.liveGenerating')}
                </p>
              ) : (
                <div style={{ position: 'relative' }}>
                  <RichCard
                    noteType={ARTIFACT_MD_NOTE_TYPE}
                    fieldValues={{ Body: stripSrcTokens(prose) }}
                    side="front"
                    className="nn-artifact-reader-prose"
                  />
                  <span className="nn-artifact-caret" aria-hidden="true" />
                </div>
              )}
              {artifact.progressChars != null && artifact.progressChars > 0 && (
                <p className="nn-artifact-reader-live-meta">
                  {t('notebooks.studio.chars', { chars: liveCharsDisplay(contentMd.length, t) })}
                </p>
              )}
            </>
          ) : (
            <ReadyMarkdown
              title={artifact.title}
              prose={prose}
              footnotes={footnotes}
              numbering={numbering}
              sourceIds={sourceIds}
              onOpenCitation={onOpenCitation}
              t={t}
            />
          )}
        </div>
      </div>
    </div>
  );
};

// ── Ready markdown render + inline citation decoration ──────────────────────────

const ReadyMarkdown = ({
  title,
  prose,
  footnotes,
  numbering,
  sourceIds,
  onOpenCitation,
  t,
}: {
  title: string;
  prose: string;
  footnotes: { n: number; chunkId: string }[];
  numbering: Map<string, number>;
  sourceIds: string[];
  onOpenCitation: (chunkId: string, sourceIds: string[]) => void;
  t: Tfn;
}) => {
  // Decorate the RichCard's rendered HTML AFTER React commits it — the wrapper div
  // is the decoration host (RichCard's SafeHtml lives under it). The token regex
  // walks text nodes only, so mermaid SVG islands carry no tokens and stay intact.
  const hostRef = useRef<HTMLDivElement>(null);

  // `useInlineCitations` is built for a SourceCitation payload, but the artifact
  // viewer only knows chunk ids (no chunk→source map is persisted). Resolve a
  // chunk id to a MINIMAL SourceCitation that only carries the chunkId — the click
  // unwraps it back to `onOpenCitation(chunkId, sourceIds)` (the workspace probes
  // the source from the chunk). Stable identities so the effect doesn't re-run.
  const citationOf = useCallback(
    (chunkId: string): SourceCitation | undefined =>
      numbering.has(chunkId)
        ? { kind: 'source', sourceId: '', sourceChunkId: chunkId }
        : undefined,
    [numbering],
  );
  const onCite = useCallback(
    (c: SourceCitation) => onOpenCitation(c.sourceChunkId, sourceIds),
    [onOpenCitation, sourceIds],
  );

  // The decoration host content changes with `prose`; RichCard renders mermaid
  // islands async (a second commit), so the effect must re-run on `prose`. We key
  // the `html` dep on the raw prose — every RichCard re-render re-injects tokens.
  useInlineCitations(
    hostRef,
    { html: prose, final: true, enabled: numbering.size > 0 },
    numbering,
    citationOf,
    onCite,
  );

  return (
    <>
      <h1 className="nn-artifact-reader-doc-title">{title}</h1>
      <div ref={hostRef}>
        <RichCard
          noteType={ARTIFACT_MD_NOTE_TYPE}
          fieldValues={{ Body: prose }}
          side="front"
          className="nn-artifact-reader-prose"
        />
      </div>
      {footnotes.length > 0 && (
        <div className="nn-studio-footnotes">
          {footnotes.map((f) => (
            <button
              key={f.chunkId}
              type="button"
              className="nn-studio-footnote"
              onClick={() => onOpenCitation(f.chunkId, sourceIds)}
              title={t('notebooks.backlinks.open')}
            >
              <NNIcon name="doc" size={10} color="var(--sky-400)" />
              {f.n}
            </button>
          ))}
        </div>
      )}
    </>
  );
};

// ── Live char-count display ─────────────────────────────────────────────────────

/** The bare formatted count «1 234» / «12,3 тыс.» (no «симв.» unit). */
function liveCharsDisplay(n: number, t: Tfn): string {
  const c = formatCharCount(n);
  return c.isThousands ? `${c.display} ${t('notebooks.studio.charsK')}` : c.display;
}
