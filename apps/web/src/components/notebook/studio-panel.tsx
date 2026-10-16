'use client';

import { Button, TextInput } from '@/components/design-system/primitives';


import { Modal } from '../design-system/modal';
import { useTransientLayer } from '@/lib/use-transient-layer';
import { useWorkspaceState } from '@/components/navigation';
import { useNavigationScroll } from '@/lib/use-navigation-scroll';
import { AssistantAskButton } from '../chat/assistant-ask-button';

// StudioPanel («Блокноты 2.0» N2, Р12 «Студия» tab) — the right-dock studio
// surface: a grid of generation tiles, the artifact list with job-status badges
// (polled by use-artifact-status while any job is non-terminal). Opening a
// document mounts the FULL-WINDOW ArtifactReader overlay (the 340px dock was a
// «микро окно» for a generated document); the panel just owns the open-id +
// content fetch/polling and threads them into the reader.
//
//  • Tiles: 5 markdown types (summary/study_guide/faq/timeline/glossary) + a
//    `quiz` tile (N3) that opens a question-count dialog before generating. A
//    markdown tile click POSTs createArtifact(type) over the workspace's checked
//    source scope, then optimistically refreshes the list. 4xx/409 errors map to
//    an i18n toast by the machine error code (generation_in_progress → «Дождитесь…»).
//  • List rows: type icon + title + status badge (spinner/pulse for pending/
//    generating, rose for error with the errorCode prose, plain for ready) +
//    updatedAt + a ⋯ menu (regenerate / delete with confirm). A ready/generating
//    row opens the reader overlay.
//  • Reader overlay (ArtifactReader): full-window, centered readable column. md
//    renders via the RichCard pipeline with inline numbered `[src:]` citation
//    chips + a footnote row (click → onOpenCitation); a ready `quiz` embeds the
//    QuizPlayer. Actions: copy, to a note, download .md, regenerate, delete.
//  • Gating: !chatEnabled ⇒ a setup notice instead of the tiles (degrade).
//
// Panel-local state; the parent owns the store methods + the chat-prefill /
// citation-open handoffs. Inline styles + CSS vars + ui.tsx primitives only.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  NOTEBOOK_ARTIFACT_TYPES,
  QUIZ_QUESTIONS_DEFAULT,
  QUIZ_QUESTIONS_MAX,
  type ArtifactErrorCode,
  type ArtifactStatus,
  type NotebookArtifactType,
} from '@reomi/shared';
import { NNBtn, NNCard, NNIcon, NNSkeleton } from '@/components/ui';
import { useDialog } from '@/components/dialog';
import { raiseToast } from '@/components/toasts';
import { useArtifactStatus, useArtifactTimers } from '@/lib/use-artifact-status';
import { relativeUpdated } from '@/lib/notebook-format';
import {
  formatCharCount,
  formatElapsedSeconds,
  splitElapsed,
} from '@/lib/artifact-progress';
import { ArtifactReader } from '@/components/notebook/artifact-reader';
import type { buildAttemptAnswers } from '@/lib/quiz-player';
import type { NotebookArtifact, QuizAttempt } from '@/lib/types';

type Tfn = (key: string, params?: Record<string, string | number>) => string;

// The icon shown per artifact type (from the available NNIcon set).
const TYPE_ICON: Record<NotebookArtifactType, string> = {
  summary: 'doc',
  study_guide: 'book',
  faq: 'bulb',
  timeline: 'clock',
  glossary: 'tag',
  quiz: 'target',
};

// Per-type accent tone (A4 redesign) — the generation-tile icon backdrop.
const TYPE_TONE: Record<NotebookArtifactType, string> = {
  summary: 'lime',
  study_guide: 'sky',
  faq: 'amber',
  timeline: 'violet',
  glossary: 'rose',
  quiz: 'sky',
};

// The non-quiz markdown types, in generation-tile order (quiz is appended last
// and opens a question-count dialog before generating — N3).
const MARKDOWN_TYPES = NOTEBOOK_ARTIFACT_TYPES.filter((tp) => tp !== 'quiz');

const ARTIFACT_ERROR_CODE_SET = new Set<string>([
  'ai_disabled',
  'timeout',
  'generation_failed',
  'invalid_quiz',
  'no_sources',
  'source_unavailable',
  'interrupted',
]);

export interface StudioPanelProps {
  notebookId?: string;
  studyScope?: { kind: 'source'; id: string } | { kind: 'saved' };
  allowGenerate?: boolean;
  initialArtifactId?: string | null;
  onInitialOpen?: () => void;
  /** The workspace's checked source scope (chat checkboxes). Empty ⇒ the server
   *  defaults to all ready sources. */
  scopeIds: string[];
  /** /ai/status.chatEnabled — gates the generation tiles (degrade, never crash). */
  chatEnabled: boolean;
  listArtifacts: (notebookId: string) => Promise<NotebookArtifact[]>;
  createArtifact: (
    notebookId: string,
    type: NotebookArtifactType,
    sourceIds?: string[],
    questionCount?: number,
  ) => Promise<NotebookArtifact>;
  getArtifact: (notebookId: string, artifactId: string) => Promise<NotebookArtifact>;
  deleteArtifact: (notebookId: string, artifactId: string) => Promise<void>;
  regenerateArtifact: (notebookId: string, artifactId: string) => Promise<NotebookArtifact>;
  /** Quiz attempt submit + history (N3) — threaded into the quiz player. */
  submitQuizAttempt: (
    notebookId: string,
    artifactId: string,
    answers: ReturnType<typeof buildAttemptAnswers>,
  ) => Promise<QuizAttempt>;
  listQuizAttempts: (notebookId: string, artifactId: string) => Promise<QuizAttempt[]>;
  /** A `[src:]` footnote chip was clicked — the workspace resolves the chunk's
   *  source + opens its citation-viewer. */
  onOpenCitation: (chunkId: string, sourceIds: string[]) => void;
  /** «В заметку» — save a ready artifact's markdown into the notebook's notes. */
  onSaveToNote: (title: string, contentMd: string, artifact?: NotebookArtifact) => void | Promise<void>;
  /** «Слабые места → карточки» — prefill the chat composer (quiz result, N3). */
  onPrefillChat: (text: string, artifactId?: string) => void;
  t: Tfn;
}

export const StudioPanel = ({
  notebookId: legacyNotebookId,
  studyScope,
  allowGenerate = true,
  initialArtifactId,
  onInitialOpen,
  scopeIds,
  chatEnabled,
  listArtifacts,
  createArtifact,
  getArtifact,
  deleteArtifact,
  regenerateArtifact,
  submitQuizAttempt,
  listQuizAttempts,
  onOpenCitation,
  onSaveToNote,
  onPrefillChat,
  t,
}: StudioPanelProps) => {
  const { confirm } = useDialog();
  const notebookId = studyScope?.kind === 'source' ? studyScope.id : studyScope?.kind === 'saved' ? '' : legacyNotebookId ?? '';

  // Quiz question-count picker (N3): when the quiz tile is clicked we open a small
  // inline dialog (presets + slider) before POSTing the artifact job.
  const [quizDialogOpen, setQuizDialogOpen] = useState(false);

  const [artifacts, setArtifacts] = useState<NotebookArtifact[]>([]);
  const [loaded, setLoaded] = useState(false);
  const consumedInitial = useRef<string | null>(null);
  const [creating, setCreating] = useState<NotebookArtifactType | null>(null);
  const [generationError, setGenerationError] = useState<string | null>(null);
  useEffect(() => { setGenerationError(null); }, [notebookId]);

  // Open viewer (full artifact incl. content); null = list.
  const navigationScope = studyScope?.kind === 'source' ? `source:${notebookId}` : `notebook:${notebookId}`;
  const [openId, setOpenId] = useWorkspaceState<string | null>(navigationScope,'artifactId',null);
  const listPosition=useNavigationScroll(navigationScope,'artifacts-list',{ready:loaded});
  const [openFull, setOpenFull] = useState<NotebookArtifact | null>(null);
  const [openLoading, setOpenLoading] = useState(false);
  const [openError, setOpenError] = useState(false);
  const loadSequence = useRef(0);
  const refreshSequence = useRef(0);
  useEffect(() => () => { refreshSequence.current++; }, [notebookId]);
  useEffect(() => () => { loadSequence.current++; }, [notebookId]);

  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      const rows = await listArtifacts(notebookId);
      if (sequence !== refreshSequence.current) return;
      setArtifacts(rows);
    } catch {
      /* keep current on a transient error */
    } finally {
      if (sequence === refreshSequence.current) setLoaded(true);
    }
  }, [listArtifacts, notebookId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Poll the list while any job is non-terminal (pending|generating).
  useArtifactStatus({ items: artifacts, refresh, enabled: chatEnabled });

  // Live elapsed timers (anchored on first non-terminal sighting, NOT createdAt —
  // a regenerate keeps the old createdAt). `now` ticks every second while running.
  const { startedAt, now } = useArtifactTimers(artifacts);

  // Keep the open viewer fresh: when a polled list row for the open artifact
  // flips to ready, re-fetch the full content.
  const openListRow = useMemo(
    () => (openId ? artifacts.find((a) => a.id === openId) ?? null : null),
    [artifacts, openId],
  );
  const openFullStatusRef = useRef<ArtifactStatus | null>(null);
  openFullStatusRef.current = openFull?.status ?? null;

  const loadFull = useCallback(
    async (artifactId: string) => {
      const sequence = ++loadSequence.current;
      setOpenLoading(true);
      setOpenError(false);
      try {
        const full = await getArtifact(notebookId, artifactId);
        if (sequence === loadSequence.current) setOpenFull(full);
      } catch (error) {
        if (sequence === loadSequence.current) {
          if ((error as {status?:number}).status === 404) {
            setOpenFull(null); setOpenId(null);
            raiseToast({kind:'error',title:t('notebooks.studio.notFound')});
          } else setOpenError(true);
        }
      } finally {
        if (sequence === loadSequence.current) setOpenLoading(false);
      }
    },
    [getArtifact, notebookId, setOpenId, t],
  );

  // Re-fetch the full content when the open row's status changes under polling
  // (e.g. generating → ready), so the viewer shows the finished document.
  useEffect(() => {
    if (!openId || !loaded) return;
    if (!openListRow || openListRow.status !== openFullStatusRef.current) {
      void loadFull(openId);
    }
  }, [openId, openListRow, loadFull, loaded]);

  // LIVE viewer: while the open artifact is still generating, poll its FULL
  // content every ~2s so the growing partial text streams into the viewer (the
  // list-row status alone stays 'generating', so the status-change effect above
  // never re-fires during a stream). Stops the instant it goes terminal.
  const openFullStatus = openFull?.status ?? null;
  useEffect(() => {
    if (!openId) return;
    if (openFullStatus !== 'pending' && openFullStatus !== 'generating') return;
    const interval = setInterval(() => { if (document.visibilityState !== 'hidden') void loadFull(openId); }, 2000);
    return () => clearInterval(interval);
  }, [openId, openFullStatus, loadFull]);

  const openArtifact = useCallback(
    (a: NotebookArtifact) => {
      setOpenId(a.id);
      setOpenFull(null);
      void loadFull(a.id);
    },
    [loadFull, setOpenId],
  );

  useEffect(() => {
    if (!initialArtifactId) { consumedInitial.current = null; return; }
    if (!loaded || consumedInitial.current === initialArtifactId) return;
    consumedInitial.current = initialArtifactId;
    const artifact = artifacts.find(a => a.id === initialArtifactId);
    if (artifact) openArtifact(artifact);
    else raiseToast({ kind: 'error', title: t('notebooks.studio.notFound') });
    onInitialOpen?.();
  }, [initialArtifactId, loaded, artifacts, openArtifact, onInitialOpen, t]);

  // ── Generate ──────────────────────────────────────────────────────────────────
  const onGenerate = useCallback(
    async (type: NotebookArtifactType, questionCount?: number) => {
      if (creating) return;
      setCreating(type);
      setGenerationError(null);
      try {
        const scope = scopeIds.length > 0 ? scopeIds : undefined;
        const created = await createArtifact(notebookId, type, scope, questionCount);
        setArtifacts((prev) => [created, ...prev]);
      } catch (err) {
        setGenerationError(artifactErrorToast(err, t));
        raiseToast({ kind: 'info', title: artifactErrorToast(err, t) });
      } finally {
        setCreating(null);
      }
    },
    [creating, scopeIds, createArtifact, notebookId, t],
  );

  // Quiz tile → open the question-count dialog; the dialog's «Generate» calls
  // onGenerate('quiz', count).
  const onQuizConfirm = useCallback(
    (count: number) => {
      setQuizDialogOpen(false);
      void onGenerate('quiz', count);
    },
    [onGenerate],
  );

  // ── Row actions ─────────────────────────────────────────────────────────────────
  const onRegenerate = useCallback(
    async (a: NotebookArtifact) => {
      try {
        const updated = await regenerateArtifact(notebookId, a.id);
        setArtifacts((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
        if (openId === a.id) setOpenFull(updated);
      } catch (err) {
        raiseToast({ kind: 'info', title: artifactErrorToast(err, t) });
      }
    },
    [regenerateArtifact, notebookId, openId, t],
  );

  const onDelete = useCallback(
    async (a: NotebookArtifact) => {
      const yes = await confirm({
        title: t('notebooks.studio.delete'),
        message: t('notebooks.studio.deleteConfirm'),
        danger: true,
        confirmLabel: t('notebooks.studio.delete'),
      });
      if (!yes) return;
      try {
        await deleteArtifact(notebookId, a.id);
        setArtifacts((prev) => prev.filter((x) => x.id !== a.id));
        if (openId === a.id) {
          setOpenId(null);
          setOpenFull(null);
        }
      } catch {
        raiseToast({ kind: 'info', title: t('notebooks.studio.createFailed') });
      }
    },
    [confirm, t, deleteArtifact, notebookId, openId],
  );

  const closeViewer = useCallback(() => {
    loadSequence.current++;
    setOpenId(null);
    setOpenFull(null);
    setOpenLoading(false);
  }, []);

  // ── Render: list + tiles (the reader is a full-window overlay over them) ──────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Full-window reader overlay — a ready/generating document opens here. */}
      {openId && (
        <ArtifactReader
          loadError={openError}
          onRetry={() => { if (openId) void loadFull(openId); }}
          notebookId={notebookId}
          artifact={openFull}
          loading={openLoading}
          sourceIds={openFull?.sourceIds ?? openListRow?.sourceIds ?? []}
          submitQuizAttempt={submitQuizAttempt}
          listQuizAttempts={listQuizAttempts}
          onOpenCitation={onOpenCitation}
          onSaveToNote={onSaveToNote}
          onPrefillChat={text => onPrefillChat(text, openId)}
          onRegenerate={() => {
            if (!openFull) return;
            // Kick the regenerate and close the reader so the user sees the pending
            // badge + live polling (the reader would otherwise show the stale/old
            // content while the new one generates).
            void onRegenerate(openFull);
            closeViewer();
          }}
          onDelete={() => {
            if (openFull) void onDelete(openFull);
          }}
          onClose={closeViewer}
          t={t}
        />
      )}
      {quizDialogOpen && (
        <QuizCountDialog
          onConfirm={onQuizConfirm}
          onClose={() => setQuizDialogOpen(false)}
          t={t}
        />
      )}
      <div ref={listPosition.ref} className="nn-scroll" style={{ flex: 1, overflowY: 'auto', padding: '10px 10px 14px' }}>
        {/* Generation tiles (or a setup notice when chat is off). */}
        {!allowGenerate ? null : !chatEnabled ? (
          <div className="nn-empty-state" style={{ paddingTop: 24, paddingBottom: 24 }}>
            <span className="nn-empty-state-icon">
              <NNIcon name="sparkle" size={26} color="var(--text-dim)" />
            </span>
            <p className="nn-empty-state-hint">{t('notebooks.studio.setupHint')}</p>
          </div>
        ) : (
          <>
            <span
              className="nn-chrome"
              style={{
                display: 'block',
                fontSize: 11,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.07em',
                color: 'var(--text-dim)',
                marginBottom: 8,
              }}
            >
              {t('notebooks.studio.generateHeading')}
            </span>
            <div className="nn-studio-tiles">
              {MARKDOWN_TYPES.map((type) => (
                <StudioTile
                  key={type}
                  type={type}
                  busy={creating === type}
                  disabled={creating !== null}
                  onClick={() => void onGenerate(type)}
                  t={t}
                />
              ))}
              {/* Quiz (N3) — opens a question-count dialog before generating. */}
              <StudioTile
                key="quiz"
                type="quiz"
                busy={creating === 'quiz'}
                disabled={creating !== null}
                onClick={() => setQuizDialogOpen(true)}
                t={t}
              />
            </div>
          </>
        )}

        {/* Artifact list. */}
        <span
          className="nn-chrome"
          style={{
            display: 'block',
            fontSize: 11,
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.07em',
            color: 'var(--text-dim)',
            margin: '16px 0 8px',
          }}
        >
          {t('notebooks.studio.listHeading')}
        </span>
        {generationError && <p role="alert" style={{ color: 'var(--rose-400)', fontSize: 12 }}>{generationError}</p>}
        {!loaded ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <NNSkeleton style={{ height: 44 }} />
            <NNSkeleton style={{ height: 44 }} />
          </div>
        ) : artifacts.length === 0 ? (
          <div className="nn-empty-state" style={{ paddingTop: 18, paddingBottom: 18 }}>
            <span className="nn-empty-state-icon">
              <NNIcon name="stack" size={24} color="var(--text-dim)" />
            </span>
            <p className="nn-empty-state-hint">{t('notebooks.studio.empty')}</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {artifacts.map((a) => (
              <ArtifactRow
                key={a.id}
                artifact={a}
                // A ready row opens the final viewer; a generating row opens the
                // LIVE viewer (growing partial text + caret). pending/error don't open.
                onOpen={() =>
                  (a.status === 'ready' || a.status === 'generating') && openArtifact(a)
                }
                elapsedMs={
                  a.status === 'generating'
                    ? (startedAt(a.id) ? now - startedAt(a.id)! : 0)
                    : undefined
                }
                onRegenerate={() => void onRegenerate(a)}
                onDelete={() => void onDelete(a)}
                t={t}
              />
            ))}
          </div>
        )}

        {/* Footnote under the document list (only when the tiles are shown). */}
        {chatEnabled && allowGenerate && (
          <p
            style={{
              marginTop: 12,
              marginBottom: 0,
              fontSize: 10.5,
              lineHeight: 1.5,
              color: 'var(--text-dim)',
              padding: '0 2px',
            }}
          >
            {t(studyScope?.kind === 'source' ? 'assistant.sourceDocumentsHint' : studyScope?.kind === 'saved' ? 'assistant.savedDocumentsHint' : 'notebooks.studio.docsHint')}
          </p>
        )}
      </div>
    </div>
  );
};

// ── Generation tile ────────────────────────────────────────────────────────────

const StudioTile = ({
  type,
  busy = false,
  disabled = false,
  onClick,
  t,
}: {
  type: NotebookArtifactType;
  busy?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  t: Tfn;
}) => (
  <Button variant="bare"
    type="button"
    className="nn-studio-tile"
    disabled={disabled}
    onClick={onClick}
    title={t(`notebooks.studio.type_${type}Desc`)}
  >
    <span
      className="nn-studio-tile-icon"
      style={{
        width: 24,
        height: 24,
        borderRadius: 7,
        background: `color-mix(in srgb, var(--${TYPE_TONE[type]}-500) 14%, transparent)`,
        border: `1px solid color-mix(in srgb, var(--${TYPE_TONE[type]}-500) 30%, transparent)`,
      }}
    >
      {busy ? (
        <span className="nn-spin" style={{ display: 'flex' }}>
          <NNIcon name="sync" size={13} color={`var(--${TYPE_TONE[type]}-400)`} />
        </span>
      ) : (
        <NNIcon name={TYPE_ICON[type]} size={13} color={`var(--${TYPE_TONE[type]}-400)`} />
      )}
    </span>
    <span className="nn-studio-tile-body">
      <span className="nn-studio-tile-name">{t(`notebooks.studio.type_${type}`)}</span>
      <span className="nn-studio-tile-desc">{t(`notebooks.studio.type_${type}Desc`)}</span>
    </span>
  </Button>
);

// ── Artifact list row ─────────────────────────────────────────────────────────

const ArtifactRow = ({
  artifact,
  onOpen,
  elapsedMs,
  onRegenerate,
  onDelete,
  t,
}: {
  artifact: NotebookArtifact;
  onOpen: () => void;
  /** Elapsed ms since the job was first seen generating (live timer). */
  elapsedMs?: number;
  onRegenerate: () => void;
  onDelete: () => void;
  t: Tfn;
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRoot = useRef<HTMLDivElement>(null);
  useTransientLayer({ root: menuRoot, enabled: menuOpen, onClose: () => setMenuOpen(false) });
  const ready = artifact.status === 'ready';
  const generating = artifact.status === 'generating';
  const pending = artifact.status === 'pending';
  const isError = artifact.status === 'error';
  const inFlight = generating || pending;
  // A generating row is openable too (LIVE viewer); pending/error are not.
  const openable = ready || generating;
  const terminal = ready || isError;

  // Icon-tile tone: lime (ready) / amber (generating) / sky (pending) / rose (error).
  const tone = ready ? 'lime' : isError ? 'rose' : generating ? 'amber' : 'sky';

  // Subline per status.
  const liveParts: string[] = [];
  if (generating) {
    if (typeof elapsedMs === 'number') liveParts.push(formatElapsed(elapsedMs, t));
    if (typeof artifact.progressChars === 'number' && artifact.progressChars > 0) {
      liveParts.push(formatChars(artifact.progressChars, t));
    }
  }

  return (
    <div
      className="nn-source-row"
      style={{
        cursor: openable ? 'pointer' : 'default',
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        borderLeft: '1px solid var(--border)',
        padding: '10px 11px',
        borderRadius: 'var(--r-md)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <Button variant="bare"
          type="button"
          onClick={openable ? onOpen : undefined}
          disabled={!openable}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            flex: 1,
            minWidth: 0,
            background: 'transparent',
            border: 'none',
            cursor: openable ? 'pointer' : 'default',
            padding: 0,
            textAlign: 'left',
          }}
        >
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
              flexShrink: 0,
              borderRadius: 8,
              background: `color-mix(in srgb, var(--${tone}-500) 12%, transparent)`,
              border: `1px solid color-mix(in srgb, var(--${tone}-500) 28%, transparent)`,
            }}
          >
            <NNIcon name={TYPE_ICON[artifact.type]} size={13} color={`var(--${tone}-400)`} />
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span
              style={{
                display: 'block',
                fontSize: 12.5,
                fontWeight: 600,
                color: 'var(--text)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {artifact.title}
            </span>
            {/* Subline: ready → «Готово · N ago»; generating → amber pulse + live;
                pending → queued; error → error-code prose (rose). */}
            {ready ? (
              <span style={{ display: 'block', fontSize: 10.5, color: 'var(--text-dim)' }}>
                {t('notebooks.studio.readyAt', { time: relativeUpdated(artifact.updatedAt, t) })}
              </span>
            ) : isError ? (
              <span style={{ display: 'block', fontSize: 10.5, color: 'var(--rose-400)' }}>
                {t(`notebooks.studio.error_${errorCodeOf(artifact.errorCode)}`)}
              </span>
            ) : (
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 5,
                  fontSize: 10.5,
                  color: 'var(--amber-400)',
                }}
              >
                <span className="nn-pulse-dot" />
                {pending
                  ? t('notebooks.studio.queued')
                  : liveParts.length > 0
                    ? liveParts.join(' · ')
                    : t('notebooks.studio.statusGenerating')}
              </span>
            )}
          </span>
        </Button>
        {/* In-flight → a cancel (delete) affordance; otherwise the ⋯ menu. */}
        {artifact.status === 'ready' && <AssistantAskButton object={{ kind: 'artifact', id: artifact.id }} compact />}
        {inFlight ? (
          <NNBtn
            variant="ghost"
            size="sm"
            icon="x"
            ariaLabel={t('notebooks.studio.cancelGeneration')}
            title={t('notebooks.studio.cancelGeneration')}
            onClick={onDelete}
          />
        ) : (
          <div ref={menuRoot}
            className="nn-source-row-actions"
            style={{ display: 'flex', gap: 0, flexShrink: 0, position: 'relative', opacity: 1 }}
          >
            <NNBtn
              variant="ghost"
              size="sm"
              icon="dots"
              ariaLabel={t('library.item.menu')}
              title={t('library.item.menu')}
              onClick={() => setMenuOpen((v) => !v)}
            />
            {menuOpen && (
              <>
                <div role="menu" aria-label={t('library.item.menu')} className="nn-lib-menu" style={{ right: 0, top: 'calc(100% + 4px)', minWidth: 180 }}>
                  <Button variant="bare"
                    type="button"
                    className="nn-lib-menu-item"
                    disabled={!terminal || (artifact.ownerKind === 'source' && !artifact.sourceId)}
                    title={artifact.ownerKind === 'source' && !artifact.sourceId ? t('assistant.sourceUnavailable') : undefined}
                    onClick={() => {
                      setMenuOpen(false);
                      onRegenerate();
                    }}
                  >
                    <NNIcon name="sync" size={14} color="var(--text-muted)" />
                    {t('notebooks.studio.regenerate')}
                  </Button>
                  <Button variant="bare"
                    type="button"
                    className="nn-lib-menu-item"
                    onClick={() => {
                      setMenuOpen(false);
                      onDelete();
                    }}
                  >
                    <NNIcon name="x" size={14} color="var(--text-muted)" />
                    {t('notebooks.studio.delete')}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
      {/* Indeterminate progress bar while generating. */}
      {generating && (
        <div className="nn-nb-doc-progress" style={{ marginTop: 8 }}>
          <span className="nn-nb-doc-progress-inner" />
        </div>
      )}
    </div>
  );
};

/** Normalize an artifact error code to a known key (fallback generation_failed). */
function errorCodeOf(code: string | null): ArtifactErrorCode {
  return (code && ARTIFACT_ERROR_CODE_SET.has(code) ? code : 'generation_failed') as ArtifactErrorCode;
}

/** «N сек» / «N мин M сек» from elapsed ms via the pure splitters. */
function formatElapsed(elapsedMs: number, t: Tfn): string {
  const { minutes, seconds } = splitElapsed(formatElapsedSeconds(elapsedMs));
  return minutes > 0
    ? t('notebooks.studio.elapsedMin', { minutes, seconds })
    : t('notebooks.studio.elapsedSec', { seconds });
}

/** The bare formatted count «1 234» / «12,3 тыс.» (no «симв.» unit). */
function liveCharsDisplay(n: number, t: Tfn): string {
  const c = formatCharCount(n);
  return c.isThousands ? `${c.display} ${t('notebooks.studio.charsK')}` : c.display;
}

/** «≈1 234 симв.» / «≈12,3 тыс. симв.» from a raw char count. */
function formatChars(n: number, t: Tfn): string {
  return t('notebooks.studio.chars', { chars: liveCharsDisplay(n, t) });
}

// ── Quiz question-count dialog (N3) ─────────────────────────────────────────────
// A small modal: presets (5/10/15/20) + a slider, default QUIZ_QUESTIONS_DEFAULT.
// «Сгенерировать» POSTs a quiz job with the chosen count (server clamps to the cap).

const QUIZ_PRESETS = [5, 10, 15, 20] as const;

const QuizCountDialog = ({
  onConfirm,
  onClose,
  t,
}: {
  onConfirm: (count: number) => void;
  onClose: () => void;
  t: Tfn;
}) => {
  const [count, setCount] = useState<number>(QUIZ_QUESTIONS_DEFAULT);
  return (
    <Modal open title={t('notebooks.quiz.dialogTitle')} closeLabel={t('actions.cancel')} onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: '12px 22px 22px' }}>
          <p style={{ fontSize: 12.5, color: 'var(--text-dim)', margin: 0 }}>
            {t('notebooks.quiz.dialogHint')}
          </p>

          {/* Presets */}
          <div style={{ display: 'flex', gap: 8 }}>
            {QUIZ_PRESETS.map((p) => (
              <Button variant="bare"
                key={p}
                type="button"
                className={`nn-quiz-preset${count === p ? ' selected' : ''}`}
                onClick={() => setCount(p)}
              >
                {p}
              </Button>
            ))}
          </div>

          {/* Slider + live value */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <TextInput
              type="range"
              min={3}
              max={QUIZ_QUESTIONS_MAX}
              step={1}
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              className="nn-quiz-slider"
              style={{ flex: 1, accentColor: 'var(--accent-500)' }}
              aria-label={t('notebooks.quiz.dialogTitle')}
            />
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)', minWidth: 24, textAlign: 'right' }}>
              {count}
            </span>
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <NNBtn variant="ghost" size="sm" onClick={onClose}>
              {t('actions.cancel')}
            </NNBtn>
            <NNBtn variant="primary" size="sm" icon="target" onClick={() => onConfirm(count)}>
              {t('notebooks.quiz.dialogGenerate')}
            </NNBtn>
          </div>
      </div>
    </Modal>
  );
};

// ── Error → toast text ──────────────────────────────────────────────────────────

const ROUTE_ERROR_CODES = new Set([
  'no_sources',
  'source_unavailable',
  'invalid_type',
  'too_many_artifacts',
  'generation_in_progress',
  'not_terminal',
  'ai_disabled',
]);

/** Map a thrown ok()-error to a studio toast string by its machine code. */
function artifactErrorToast(err: unknown, t: Tfn): string {
  const code = extractErrorCode(err);
  if (code && ROUTE_ERROR_CODES.has(code)) return t(`notebooks.studio.err_${code}`);
  return t('notebooks.studio.createFailed');
}

/** Best-effort extraction of the `{ error: <code> }` body from an ok() throw. */
function extractErrorCode(err: unknown): string | null {
  if (!err) return null;
  // ok() throws an Error whose message is the JSON-stringified error body.
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/"error"\s*:\s*"([a-z_]+)"/);
  if (m) return m[1]!;
  // Plain code string fallback.
  if (/^[a-z_]+$/.test(msg)) return msg;
  return null;
}
