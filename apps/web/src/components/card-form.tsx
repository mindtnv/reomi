'use client';

import { Button, TextInput } from '@/components/design-system/primitives';


import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAppNavigation } from '@/components/navigation';
import { NNBtn, NNBadge, NNTag, NNCard, NNIcon, NNPageSkeleton } from '@/components/ui';
import { useNN } from '@/lib/store';
import type { Card, NoteType } from '@/lib/types';
import { useBreakpoint } from '@/lib/use-breakpoint';
import { useLocale, useT } from '@/lib/i18n';
import { useDialog } from '@/components/dialog';
import { NNSelect, type NNSelectOption } from '@/components/nn-select';
import { buildDeckTree, deckPathLabel, flattenTree } from '@/lib/decks';
import { renderCardHtml } from '@/lib/render-card';
import { useEditorDraft } from '@/lib/use-editor-draft';
import { draftFingerprint } from '@/lib/editor-drafts';
import { isNoteDraftValue, type NoteDraftValue } from '@/lib/editor-draft-values';
import { useRecoverableAction, type RecoveryAction } from '@/lib/use-recoverable-action';
import { readNoteOperation, saveNoteOperation } from '@/lib/note-operations';
import { SaveFeedback } from './save-feedback';
import { EditorDraftNotice } from './editor-draft-notice';
import { NoteConversionDialog } from './note-conversion';
import { RichCard } from '@/components/rich-card';
import { api, ApiError, ok } from '@/lib/api';
import { cardFromApi, noteTypeFromApi } from '@/lib/mappers';
import {
  MAX_MEDIA_BYTES,
  MAX_MEDIA_LABEL,
  MEDIA_MIME_ALLOWLIST,
  newUuidV7,
  generateCards,
  NoteContentError,
  fieldPlainText,
  typedAnswerField,
  acceptedAnswerVariants,
  normalizeNoteTags,
  ClozeSyntaxError,
  renameFieldValues,
  type FieldValues,
  type CardRegenerationPreview,
} from '@reomi/shared';

// ─────────────────────────────────────────────
// Note editor (Milestone 1, Phase 5a)
//
// The card editor is now a NOTE editor: pick a note-type (own or builtin), fill
// its DYNAMIC fields (one rich-text input per note-type field), see a live
// per-card preview rendered from the note-type template + the field values
// (DOMPurified via <SafeHtml>), then save → store.addNote / store.updateNote.
//
// Custom note-type AUTHORING (creating your own field/template sets) is Phase 5b
// — here we only support creating/editing notes of the existing note-types.
//
// Re-sync strategy (Critic C1 / Architect should-fix #8): an effect keyed on
// `card?.id` resets state whenever the selected card changes (browser inline
// prev/next that does NOT re-mount). Consumers may ALSO mount with
// `key={card?.id ?? 'new'}` — both paths are supported.
// ─────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 10,
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  color: 'var(--text)',
  fontFamily: 'var(--font-sans)',
  fontSize: 14,
  outline: 'none',
  boxSizing: 'border-box',
};

type NoteRevisionRow = { id: string; revisedAt: string | Date; noteTypeId: string; label: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function noteRevisionRows(value: unknown): NoteRevisionRow[] {
  if (!isRecord(value) || !Array.isArray(value.items)) return [];
  return value.items.flatMap((item) => {
    if (!isRecord(item)) return [];
    const revisedAt = item.revisedAt;
    if (typeof item.id !== 'string' || typeof item.noteTypeId !== 'string' || typeof item.label !== 'string') return [];
    if (typeof revisedAt !== 'string' && !(revisedAt instanceof Date)) return [];
    return [{ id: item.id, noteTypeId: item.noteTypeId, label: item.label, revisedAt }];
  });
}

type RestoredNoteDocument = {
  note?: { fieldValues?: FieldValues; tags?: string[]; acceptedAnswers?: string[]; updatedAt?: string | Date };
  cards?: unknown[];
};

function isRestoredNoteDocument(value: unknown): value is RestoredNoteDocument {
  return isRecord(value) && 'note' in value && 'cards' in value;
}

function revisionStamp(value: string | Date, locale: string) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--text-dim)',
  textTransform: 'uppercase',
  letterSpacing: 0.8,
  marginBottom: 6,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

// Client-side image pre-checks (server re-validates at presign + finalize). The
// allowlist + cap come from @reomi/shared (single source of truth, mirrored
// by the server) — they're a fast UX gate, not the security boundary. The label
// is derived from the byte cap so the copy can never drift from the real limit.
const ALLOWED_IMAGE_TYPES: readonly string[] = MEDIA_MIME_ALLOWLIST;
const MAX_IMAGE_BYTES = MAX_MEDIA_BYTES;
const MAX_IMAGE_LABEL = MAX_MEDIA_LABEL;

// ── Markdown-source field input ───────────────────────────────────────────────
//
// A plain <textarea> holding the field's RAW MARKDOWN source (NOT HTML). The
// value is the literal text the user typed; Enter is a newline (`\n`), never a
// `<div>`. A tiny toolbar inserts MARKDOWN syntax (bold/italic/code/list/heading)
// around the textarea selection, plus image upload (inserts `![](/m/<uuid>)`) and
// LaTeX (`\(\)`). The markdown → HTML render + sanitize happens entirely at the
// render edge (render-card.tsx); this editor produces no HTML at all.

const RichField = ({
  value,
  onChange,
  placeholder,
  label,
  serif,
  minHeight,
  autoFocus,
  resetKey,
  blocked = false,
  onUploadChange,
}: {
  value: string;
  onChange: (markdown: string) => void;
  placeholder?: string;
  label?: string;
  serif?: boolean;
  minHeight: number;
  autoFocus?: boolean;
  resetKey: string;
  blocked?: boolean;
  onUploadChange?: (pending: boolean) => void;
}) => {
  const t = useT();
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadMedia = useNN((s) => s.uploadMedia);
  const [uploading, setUploading] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const uploadLock = useRef(false);
  const identity = useRef(resetKey);
  identity.current = resetKey;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // Auto-grow: keep the textarea height matched to its content (no scrollbar mid-
  // edit). Runs on every value change AND on entity switch (resetKey).
  const autoGrow = useCallback(() => {
    const el = ref.current;
    if (!el || el.clientWidth === 0) return;
    // scrollHeight includes padding but excludes borders; the textarea uses border-box.
    const style = getComputedStyle(el);
    const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    el.style.height = 'auto';
    el.style.height = `${Math.max(minHeight, Math.ceil(el.scrollHeight + borders) + 1)}px`;
    el.scrollTop = 0;
  }, [minHeight]);

  useLayoutEffect(() => { autoGrow(); }, [value, resetKey, autoGrow]);

  useEffect(() => {
    let cancelled = false;
    const measure = () => { if (!cancelled) autoGrow(); };
    // Local fonts may finish loading after the initial layout measurement.
    void document.fonts?.ready.then(measure);
    document.fonts?.addEventListener('loadingdone', measure);
    return () => { cancelled = true; document.fonts?.removeEventListener('loadingdone', measure); };
  }, [autoGrow]);

  useEffect(() => {
    const container = ref.current?.parentElement;
    if (!container) return;
    let width = container.clientWidth;
    const observer = new ResizeObserver(() => {
      const next = container.clientWidth;
      if (next > 0 && next !== width) { width = next; autoGrow(); }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [autoGrow]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFocus, resetKey]);

  // Replace the current textarea selection with `next`, then restore the caret to
  // `[selStart, selEnd]` (offsets into the NEW value) and propagate via onChange.
  const applyEdit = (next: string, selStart: number, selEnd: number) => {
    onChange(next);
    // Restore selection after React commits the controlled value.
    requestAnimationFrame(() => {
      const el = ref.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(selStart, selEnd);
      autoGrow();
    });
  };

  // Wrap the current selection in `before…after` markers. Empty selection → insert
  // the markers and place the caret between them so the user types inside.
  const wrap = (before: string, after: string) => {
    const el = ref.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = value.slice(start, end);
    const next = value.slice(0, start) + before + selected + after + value.slice(end);
    if (start === end) {
      const caret = start + before.length;
      applyEdit(next, caret, caret);
    } else {
      applyEdit(next, start + before.length, start + before.length + selected.length);
    }
  };

  // Prefix every line touched by the selection with `prefix` (markdown list /
  // heading). With an empty selection, prefix the current line.
  const prefixLines = (prefix: string) => {
    const el = ref.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    // Expand the range to whole lines.
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = value.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = value.length;
    const block = value.slice(lineStart, lineEnd);
    const prefixed = block
      .split('\n')
      .map((line) => prefix + line)
      .join('\n');
    const next = value.slice(0, lineStart) + prefixed + value.slice(lineEnd);
    applyEdit(next, lineStart, lineStart + prefixed.length);
  };

  // Insert raw text at the caret (replacing any selection), optionally placing the
  // caret `caretBack` chars from the end of the inserted text.
  const insertAtCaret = (text: string, caretBack = 0) => {
    const el = ref.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = value.slice(0, start) + text + value.slice(end);
    const caret = start + text.length - caretBack;
    applyEdit(next, caret, caret);
  };

  const onPickImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input so picking the same file again re-triggers change.
    e.target.value = '';
    if (!file || uploadLock.current || blocked) return;
    setMediaError(null);
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      setMediaError(t('editor.media.badType'));
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setMediaError(t('editor.media.tooLarge', { size: MAX_IMAGE_LABEL }));
      return;
    }
    // Capture the caret BEFORE the await — focus may move during upload.
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const original = value;
    const owner = resetKey;
    uploadLock.current = true;
    onUploadChange?.(true);
    setUploading(true);
    try {
      const { token } = await uploadMedia(file);
      if (!alive.current || identity.current !== owner) return;
      // Insert MARKDOWN image syntax with the RELATIVE token only — markdown-it
      // renders it to `<img src="/m/<uuid>">`, the sole img-src shape the render
      // edge's MEDIA_TOKEN_RE keeps. Display then loads the authenticated media
      // route. Alt is the file name (sans extension) for accessibility.
      const alt = file.name.replace(/\.[^.]+$/, '').replace(/[\\\[\]]/g, '\\$&').replace(/[\r\n]/g, ' ');
      const snippet = `![${alt}](${token})`;
      const latest = ref.current?.value ?? original;
      // The captured selection belongs to the original text. If typing has
      // changed it, append the image without replacing any newer edits.
      const next = latest === original
        ? latest.slice(0, start) + snippet + latest.slice(end)
        : `${latest}${latest.endsWith('\n') ? '' : '\n'}${snippet}`;
      const caret = latest === original ? start + snippet.length : next.length;
      applyEdit(next, caret, caret);
    } catch (err) {
      console.error('image upload failed', err);
      if (alive.current) setMediaError(t('editor.media.failed'));
    } finally {
      uploadLock.current = false;
      onUploadChange?.(false);
      if (alive.current) setUploading(false);
    }
  };

  // Insert the inline-math delimiters and place the caret between them so the user
  // types the formula inside. The field stores raw LaTeX; KaTeX renders it.
  const onInsertMath = () => insertAtCaret('\\(\\)', 2);

  // textarea keydown: Tab navigates between sibling fields (never inserts a tab
  // char) so the multi-field flow keeps its keyboard ergonomics.
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      const container = ref.current?.closest('[data-nn-fields]');
      if (!container) return;
      const fields = Array.from(
        container.querySelectorAll<HTMLTextAreaElement>('textarea[data-nn-field]'),
      );
      const idx = fields.indexOf(ref.current as HTMLTextAreaElement);
      if (idx === -1) return;
      const nextIdx = e.shiftKey ? idx - 1 : idx + 1;
      // Inside the ring: move to the sibling and swallow Tab (no tab char).
      // At the ends (out of range): let the browser move focus out naturally.
      if (nextIdx >= 0 && nextIdx <= fields.length - 1) {
        e.preventDefault();
        fields[nextIdx]?.focus();
      }
    }
  };

  // A toolbar button wired to a custom activation handler. `onMouseDown` +
  // preventDefault keeps the textarea selection alive when the button is pressed.
  const toolBtn = (
    key: string,
    content: React.ReactNode,
    title: string,
    onActivate: () => void,
    disabled?: boolean,
  ): React.ReactNode => (
    <Button variant="bare"
      key={key}
      type="button"
      title={title}
      disabled={blocked || disabled}
      onMouseDown={(e) => {
        e.preventDefault();
        if (!blocked && !disabled) onActivate();
      }}
      style={{
        minWidth: 28,
        height: 26,
        padding: '0 7px',
        borderRadius: 6,
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        color: 'var(--text-muted)',
        fontFamily: 'var(--font-sans)',
        fontSize: 13,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {content}
    </Button>
  );

  return (
    <div className="reomi-rich-field" data-front={serif || undefined}>
      <div className="reomi-rich-field-toolbar" style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        {toolBtn('bold', 'B', t('editor.richText.bold'), () => wrap('**', '**'))}
        {toolBtn('italic', 'I', t('editor.richText.italic'), () => wrap('_', '_'))}
        {toolBtn('code', '`', t('editor.richText.inlineCode'), () => wrap('`', '`'))}
        {toolBtn('heading', 'H', t('editor.richText.heading'), () => prefixLines('# '))}
        {toolBtn('list', '•', t('editor.richText.bulletList'), () => prefixLines('- '))}
        {toolBtn(
          'image',
          <NNIcon name="image" size={14} />,
          t('editor.richText.image'),
          () => fileInputRef.current?.click(),
          uploading,
        )}
        {toolBtn('math', 'ƒₓ', t('editor.richText.math'), onInsertMath)}
        {uploading && (
          <span style={{ fontSize: 11, color: 'var(--text-dim)', marginLeft: 2 }}>
            {t('editor.media.uploading')}
          </span>
        )}
        <TextInput
          ref={fileInputRef}
          type="file"
          accept={ALLOWED_IMAGE_TYPES.join(',')}
          onChange={onPickImage}
          style={{ display: 'none' }}
        />
      </div>
      {mediaError && (
        <div style={{ fontSize: 11.5, color: 'var(--rose-400)', marginBottom: 6 }}>
          {mediaError}
        </div>
      )}
      <textarea
        ref={ref}
        disabled={blocked}
        data-nn-field
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onInput={autoGrow}
        onKeyDown={onKeyDown}
        rows={1}
        wrap="soft"
        spellCheck
        style={{
          width: '100%',
          minHeight,
          padding: '12px 14px',
          borderRadius: 10,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          color: 'var(--text)',
          // Markdown SOURCE → monospace reads better; the front field stays serif
          // to echo its display weight while still being a plain source editor.
          fontFamily: serif ? 'var(--font-serif)' : 'var(--font-mono)',
          fontSize: serif ? 18 : 14,
          lineHeight: 1.5,
          outline: 'none',
          boxSizing: 'border-box',
          overflowWrap: 'anywhere',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          overflow: 'hidden',
          resize: 'none',
          display: 'block',
        }}
      />
    </div>
  );
};

export interface CardFormDraft {
  preview?: { templateOrd: number; clozeNumber: number | null };
  cardId?: string;
  noteType?: NoteType;
  fieldValues: FieldValues;
  tags: string[];
}

export interface NNCardFormProps {
  /** The card to edit. Omit / null to create a new note. */
  card?: Card | null;
  /** Deck pre-selected when creating a new note. */
  defaultDeckId?: string;
  defaultNoteTypeId?: string;
  /** Called after a successful save (create or update) with a resulting card. */
  onSaved?: (card: Card) => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Current unsaved content for an external preview; never persists changes. */
  onDraftChange?: (draft: CardFormDraft) => void;
  /** Called after a successful delete with the deleted card id. */
  onDeleted?: (id: string) => void;
  /** Render the compact read-only FSRS status line in the header (existing cards only). Default true. */
  showFsrsHeader?: boolean;
  compactHeader?: boolean;
  heading?: string;
  actionsPlacement?: 'header' | 'footer';
  inlinePreview?: boolean;
  /** Auto-focus the first field when creating a new note. */
  autoFocusFront?: boolean;
  /** Extra controls rendered in the top action bar (e.g. prev/next). */
  footerExtra?: React.ReactNode;
  saveLabel?: string;
  /**
   * Layout hint. `'panel'` (default) is the tall side/standalone form; `'dock'`
   * lays the dynamic fields out in two columns on non-mobile to suit the
   * wide-short bottom dock in the cards browser.
   */
  layout?: 'panel' | 'dock';
}

const CardFormEditor = ({
  card,
  defaultDeckId,
  defaultNoteTypeId,
  onSaved,
  onDirtyChange,
  onDraftChange,
  onDeleted,
  showFsrsHeader = true,
  compactHeader = false,
  heading,
  actionsPlacement = 'header',
  inlinePreview = true,
  autoFocusFront = false,
  footerExtra,
  saveLabel,
  layout = 'panel',
}: NNCardFormProps) => {
  const t = useT();
  const { locale } = useLocale();
  const { confirm } = useDialog();
  const router = useAppNavigation();
  const bp = useBreakpoint();
  const isMobile = bp === 'mobile';

  const decks = useNN((s) => s.decks);
  const noteTypes = useNN((s) => s.noteTypes);
  const deleteNote = useNN((s) => s.deleteNote);

  const editing = card ?? null;
  const ownerId = useNN((state) => state.profile?.userId) ?? '';
  const [restoredType, setRestoredType] = useState<NoteType | undefined>();
  const [baseVersion, setBaseVersion] = useState(editing?.note?.updatedAt);
  const [latest, setLatest] = useState<Card | null>(null);
  const [latestType, setLatestType] = useState<NoteType | null>(null);

  // Default note-type: Basic if present, else the first available.
  const defaultNoteType = useMemo<NoteType | undefined>(() => {
    return noteTypes.find((nt) => nt.id === defaultNoteTypeId) ?? noteTypes.find((nt) => nt.kind === 'basic') ?? noteTypes[0];
  }, [noteTypes, defaultNoteTypeId]);

  // The note-type backing the form. When editing, prefer the card's embedded
  // noteType (it carries the templates needed to preview); fall back to the
  // store list by id.
  const editingNoteTypeId = editing?.noteType?.id ?? null;
  const editingNoteType = useMemo<NoteType | undefined>(() => {
    if (!editing) return undefined;
    const fromStore = editingNoteTypeId
      ? noteTypes.find((nt) => nt.id === editingNoteTypeId)
      : undefined;
    if (fromStore) return fromStore;
    // Synthesize from the embedded payload when the type isn't in the store.
    if (editing.noteType) {
      return {
        id: editing.noteType.id,
        updatedAt: editing.noteType.updatedAt,
        name: editing.noteType.name || editing.noteType.kind,
        fields: editing.noteType.fields ?? [],
        templates: editing.noteType.templates,
        styling: editing.noteType.styling,
        kind: editing.noteType.kind,
        isBuiltin: true,
      };
    }
    return undefined;
  }, [editing, editingNoteTypeId, noteTypes]);

  const [noteTypeId, setNoteTypeId] = useState<string>(
    editingNoteTypeId ?? defaultNoteType?.id ?? '',
  );

  const resolvedDefaultDeckId = useMemo(() => {
    if (editing) return editing.deckId;
    if (defaultDeckId && decks.some((d) => d.id === defaultDeckId)) return defaultDeckId;
    return decks[0]?.id ?? '';
  }, [editing, defaultDeckId, decks]);

  const [deckId, setDeckId] = useState<string>(resolvedDefaultDeckId);
  const [baseDeckId, setBaseDeckId] = useState<string>(resolvedDefaultDeckId);
  const [savedNoteId, setSavedNoteId] = useState<string | undefined>();
  const [savedCardId, setSavedCardId] = useState<string | undefined>();
  const [createOperationId, setCreateOperationId] = useState(newUuidV7);
  const [fieldValues, setFieldValues] = useState<FieldValues>(() => ({ ...(editing?.note?.fieldValues ?? {}) }));
  const [acceptedAnswersText, setAcceptedAnswersText] = useState(editing?.note?.acceptedAnswers?.join('\n') ?? '');

  const [tagsText, setTagsText] = useState<string>(editing?.tags?.join(', ') ?? '');
  const [converting, setConverting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const mutationLock = useRef(false);
  const uploadCount = useRef(0);
  const [uploadingFields, setUploadingFields] = useState(0);
  const mounted = useRef(true);
  const formRoot = useRef<HTMLDivElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const onUploadChange = useCallback((pending: boolean) => {
    uploadCount.current = Math.max(0, uploadCount.current + (pending ? 1 : -1));
    if (mounted.current) setUploadingFields(uploadCount.current);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<NoteRevisionRow[]>([]);
  const [blockedRevisionIds, setBlockedRevisionIds] = useState<string[]>([]);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const historyNoteId = editing?.noteId;

  const loadRevisions = useCallback(async (noteId: string) => {
    try {
      return noteRevisionRows(await ok(await api.notes({ id: noteId }).revisions.get()));
    } catch {
      return [];
    }
  }, []);
  useEffect(() => {
    if (!historyNoteId) { setRevisions([]); return; }
    let cancelled = false;
    void loadRevisions(historyNoteId).then((items) => { if (!cancelled && mounted.current) setRevisions(items); });
    return () => { cancelled = true; };
  }, [historyNoteId, loadRevisions]);

  // Preview flip card (replaces the always-on dual front+back inline preview).
  const [showPreview, setShowPreview] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const [previewKey, setPreviewKey] = useState('');
  const [clozeRetainHistoryFor, setClozeRetainHistoryFor] = useState<Record<string, number> | undefined>();
  useEffect(() => { setPreviewKey(''); setClozeRetainHistoryFor(undefined); }, [editing?.id]);

  // The active note-type: the store entry for `noteTypeId`, or the editing one.
  const activeNoteType = useMemo<NoteType | undefined>(() => {
    return restoredType?.id === noteTypeId ? restoredType : noteTypes.find((nt) => nt.id === noteTypeId) ?? editingNoteType;
  }, [noteTypes, noteTypeId, editingNoteType, restoredType]);

  // The field set to render inputs for. When editing a synthesized type with no
  // fields, fall back to the field names present in the note's values.
  const fields = useMemo(() => {
    if (activeNoteType && activeNoteType.fields.length > 0) {
      return [...activeNoteType.fields].sort((a, b) => a.ord - b.ord);
    }
    const fv = editing?.note?.fieldValues ?? {};
    return Object.keys(fv).map((name, ord) => ({ name, ord }));
  }, [activeNoteType, editing]);

  const isCloze = activeNoteType?.kind === 'cloze';

  const setField = useCallback((name: string, markdown: string) => {
    setFieldValues((prev) => ({ ...prev, [name]: markdown }));
  }, []);

  const parsedTags = useMemo(() => normalizeNoteTags(tagsText), [tagsText]);
  const tags = parsedTags.ok ? parsedTags.tags : [];



  useEffect(() => {
    if (!editing || !onDirtyChange) return;
    const saved = editing.note?.fieldValues ?? {};
    const fieldsChanged = [...new Set([...Object.keys(saved), ...Object.keys(fieldValues)])].some(key => (saved[key] ?? '') !== (fieldValues[key] ?? ''));
    onDirtyChange(fieldsChanged || tags.join(',') !== editing.tags.join(','));
  }, [editing, fieldValues, tags, onDirtyChange]);

  const currentDeck = decks.find((d) => d.id === deckId);

  // Deck options for NNSelect: nested rows (indented when not searching) carrying
  // the full deck path as `searchText` so filtering + the trigger show hierarchy.
  const deckOptions = useMemo<NNSelectOption<string>[]>(
    () =>
      flattenTree(buildDeckTree(decks), new Set(decks.map((d) => d.id))).map((node) => ({
        value: node.deck.id,
        label: node.deck.name,
        depth: node.depth,
        searchText: deckPathLabel(decks, node.deck.id),
      })),
    [decks],
  );

  const noteTypeOptions = useMemo<NNSelectOption<string>[]>(
    () => noteTypes.map((nt) => ({ value: nt.id, label: nt.isBuiltin && nt.kind !== 'custom'
      ? t(nt.kind === 'cloze' ? 'editor.variants.cloze' : nt.kind === 'typein' ? 'editor.variants.type' : 'editor.variants.basic') : nt.name })),
    [noteTypes, t],
  );

  // Live preview: render front + back HTML from the note-type template + the
  // current field values. Question validity comes from the same generator as the API.
  const legacyCloze = isCloze && editing?.clozeNumber === 0;
  const generation = useMemo(() => {
    if (!activeNoteType) return { cards: [], legacyCards: [], numbered: [], error: null };
    try {
      const legacyCards = legacyCloze ? generateCards(activeNoteType, fieldValues, { legacyCloze: true }) : [];
      let numbered: ReturnType<typeof generateCards> = [];
      try { numbered = generateCards(activeNoteType, fieldValues); }
      catch (error) { if (!legacyCloze || clozeRetainHistoryFor !== undefined || !(error instanceof ClozeSyntaxError)) throw error; }
      return { cards: legacyCloze && clozeRetainHistoryFor === undefined ? legacyCards : numbered,
        legacyCards, numbered, error: null };
    } catch (error) {
      if (error instanceof ClozeSyntaxError) return { cards: [], legacyCards: [], numbered: [], error: 'invalid_cloze' };
      if (error instanceof NoteContentError) return { cards: [], legacyCards: [], numbered: [], error: error.code };
      throw error;
    }
  }, [activeNoteType, fieldValues, legacyCloze, clozeRetainHistoryFor]);
  const splitChoices = generation.legacyCards.map((card) => ({ templateOrd: card.templateOrd,
    name: activeNoteType?.templates.find((template) => template.ord === card.templateOrd)?.name ?? '',
    numbers: generation.numbered.filter((next) => next.templateOrd === card.templateOrd && next.clozeNumber).map((next) => next.clozeNumber!),
  }));
  const splitExplanation = clozeRetainHistoryFor === undefined ? '' : splitChoices.map((choice) =>
    `${choice.name}: ${t('editor.cloze.splitHint', { n: clozeRetainHistoryFor[String(choice.templateOrd)] ?? '—' })}`).join('\n');
  const keyFor = (card: { templateOrd: number; clozeNumber: number | null }) => `${card.templateOrd}:${card.clozeNumber ?? 'plain'}`;
  const selectedPreview = generation.cards.find((card) => keyFor(card) === previewKey)
    ?? generation.cards.find((card) => card.templateOrd === editing?.templateOrd && (card.clozeNumber ?? null) === (editing?.clozeNumber ?? null))
    ?? generation.cards[0];
  const selectedPreviewKey = selectedPreview ? keyFor(selectedPreview) : '';
  useEffect(() => {
    onDraftChange?.({ cardId: editing?.id, noteType: activeNoteType, fieldValues, tags,
      preview: selectedPreview ? { templateOrd: selectedPreview.templateOrd, clozeNumber: selectedPreview.clozeNumber } : undefined });
  }, [editing?.id, activeNoteType, fieldValues, tags, selectedPreview?.templateOrd, selectedPreview?.clozeNumber, onDraftChange]);
  const omittedTemplates = activeNoteType?.templates.filter((template) => !generation.cards.some((card) => card.templateOrd === template.ord)) ?? [];
  useEffect(() => setFlipped(false), [selectedPreviewKey]);
  const preview = useMemo(() => {
    if (!activeNoteType || !selectedPreview) return { front: '', back: '' };
    return {
      front: renderCardHtml(activeNoteType, fieldValues, 'front', selectedPreview.templateOrd, selectedPreview.clozeNumber),
      back: renderCardHtml(activeNoteType, fieldValues, 'back', selectedPreview.templateOrd, selectedPreview.clozeNumber),
    };
  }, [activeNoteType, fieldValues, selectedPreview]);

  const contentError = (code: string) => t(code === 'invalid_cloze' ? 'editor.errors.invalidCloze'
    : code === 'html_image_requires_markdown' ? 'editor.errors.htmlImage'
    : code === 'typein_answer_required' ? 'editor.errors.typeinAnswer'
    : code === 'typein_answer_placement' ? 'editor.errors.typeinPlacement'
    : 'editor.errors.invalidTemplate');
  const answerField = typedAnswerField(fields);
  const saveFingerprint = draftFingerprint({ fieldValues, deckId, noteTypeId, tagsText, acceptedAnswersText, clozeRetainHistoryFor });
  const recovery = useRecoverableAction(ownerId, saveFingerprint, baseVersion);
  const handleSave = async (notify = true): Promise<boolean> => {
    if ((ownerId && useNN.getState().profile?.userId !== ownerId) || mutationLock.current || uploadCount.current > 0 || localDraft.blocked) return false;
    const recovering = recovery.snapshot.status === 'uncertain' && Boolean(recovery.snapshot.pending);
    let acceptedAnswers: string[] = [];
    if (!recovering) {
    setError(null);
    if (!deckId || !decks.some((deck) => deck.id === deckId)) {
      setError(t('editor.errors.pickDeck'));
      return false;
    }
    if (Object.keys(fieldValues).length > 64) { setError(t('editor.draft.tooManyFields')); return false; }
    if (!activeNoteType) {
      setError(t('editor.errors.pickNoteType'));
      return false;
    }
    if (generation.error) { setError(contentError(generation.error)); return false; }
    try { acceptedAnswers = acceptedAnswerVariants(acceptedAnswersText.split('\n').map((line) => line.trim()).filter(Boolean)); }
    catch { setError(t('editor.errors.invalidAnswers')); return false; }
    if (clozeRetainHistoryFor !== undefined && !splitChoices.every((choice) => choice.numbers.includes(clozeRetainHistoryFor[String(choice.templateOrd)]))) {
      setError(t('editor.errors.invalidClozeSplit')); return false;
    }
    if (generation.cards.length === 0) {
      setError(t(isCloze ? 'editor.errors.clozeRequired' : 'editor.errors.noCards'));
      return false;
    }
    if (!parsedTags.ok) {
      setError(t(parsedTags.error === 'tag_too_long' ? 'editor.errors.tagTooLong' : 'editor.errors.tooManyTags'));
      return false;
    }
    }
    mutationLock.current = true;
    setSaving(true);
    try {
      const targetNoteId = editing?.noteId ?? savedNoteId;
      let action: RecoveryAction;
      if (recovering && recovery.snapshot.pending) {
        action = recovery.snapshot.pending.payload;
      } else if (targetNoteId) {
        const patch = { fieldValues, tags, acceptedAnswers, expectedTypeUpdatedAt: activeNoteType?.updatedAt, ...(deckId !== baseDeckId ? { deckId } : {}),
          ...(clozeRetainHistoryFor !== undefined ? { clozeRetainHistoryFor } : {}) };
        const preview = await ok(await (api as any).notes({ id: targetNoteId }).preview.post({
          ...patch, preview: true, expectedUpdatedAt: baseVersion,
        })) as CardRegenerationPreview;
        if (!mounted.current) return false;
        if (preview.impact.willDeleteCards || clozeRetainHistoryFor !== undefined) {
          const details = preview.impact.removedCards.map((card) => `• ${card.front} (${card.reviews})`).join('\n');
          if (!(await confirm({ title: t('noteTypes.impact.title'), danger: preview.impact.willDeleteCards > 0,
            confirmLabel: clozeRetainHistoryFor !== undefined ? t('editor.cloze.split') : undefined,
            message: `${t('noteTypes.impact.counts', { create: preview.impact.willCreateCards, keep: preview.impact.willKeepCards,
              remove: preview.impact.willDeleteCards, reviews: preview.impact.willDeleteReviews })}${clozeRetainHistoryFor !== undefined ? `\n${splitExplanation}` : ''}\n\n${details}`,
          }))) return false;
        }
        if (!mounted.current) return false;
        action = { path: `/card-notes/${targetNoteId}`, method: 'PATCH', args: { input: { ...patch,
          expectedUpdatedAt: preview.sourceVersion, confirmationToken: preview.confirmationToken } } };
      } else {
        action = { path: `/notes/operations/${createOperationId}`, method: 'POST', args: { input: {
          noteTypeId: activeNoteType!.id, expectedTypeUpdatedAt: activeNoteType!.updatedAt,
          deckId, fieldValues, acceptedAnswers, tags,
        } } };
      }
      if (!recovering) action.draft = { ...draftValue, pendingSave: null };
      const operationId = action.path.startsWith('/notes/operations/') ? action.path.slice('/notes/operations/'.length) : '';
      const accepted = operationId
        ? await recovery.controller.run(action, saveFingerprint,
          (request) => saveNoteOperation(ownerId, request.payload.path.slice('/notes/operations/'.length), request.payload.args.input as object),
          () => readNoteOperation(ownerId, operationId))
        : await recovery.save(action, saveFingerprint);
      if (!accepted) {
        const snap = recovery.controller.getSnapshot();
        throw new ApiError(snap.error ?? 'save_failed', { status: snap.errorStatus ?? 0 });
      }
      if (!mounted.current || useNN.getState().profile?.userId !== ownerId) return false;
      if (!accepted.response.result || accepted.response.outcome !== 'applied') {
        setSavedNoteId(accepted.response.receipt.target.id);
        if (accepted.response.result) { const current = useNN.getState().acceptRecoveredNote(ownerId, accepted.response.result); if (current[0]) { setSavedCardId(current[0].id); setLatest(current[0]); } }
        throw new ApiError('note_changed', { status: 409 });
      }
      const updated = useNN.getState().acceptRecoveredNote(ownerId, accepted.response.result);
      const saved = updated.find(card => card.id === (editing?.id ?? savedCardId)) ?? updated[0];
      if (!saved) { setError(t('editor.errors.noCards')); return false; }
      setSavedNoteId(saved.noteId); setSavedCardId(saved.id); setBaseDeckId(saved.deckId); setBaseVersion(saved.note?.updatedAt);
      setLatest(null); setLatestType(null);
      const submittedDraft = isNoteDraftValue(accepted.submitted.payload.draft) ? accepted.submitted.payload.draft : draftValue;
      localDraft.markSaved(accepted.submitted.fingerprint, { ...submittedDraft, pendingSave: null, savedNoteId: saved.noteId, cardId: saved.id, baseVersion: saved.note?.updatedAt });
      if (accepted.currentMatches) { if (notify) onSaved?.(saved); return true; }
      return false;
    } catch (err) {
      if (mounted.current) {
        if (err instanceof ApiError && err.safeMessage === 'operation_reverted') {
          setCreateOperationId(newUuidV7());
          setError(t('editor.errors.saveFailed'));
        } else if (err instanceof ApiError && err.status === 409) {
          setError(t('editor.errors.changed'));
          try {
            let currentTypeId = activeNoteType?.id ?? noteTypeId;
            if (editing) {
              const current = cardFromApi(await ok(await (api as any).cards({ id: editing.id }).get()));
              currentTypeId = current.noteType?.id ?? currentTypeId;
              if (mounted.current) setLatest(current);
            }
            if (err.safeMessage === 'note_type_changed' || currentTypeId !== activeNoteType?.id) {
              const rows = await ok(await (api as any)['note-types'].get()) as any[];
              const current = rows.find((row) => row.id === currentTypeId);
              if (current && mounted.current) setLatestType(noteTypeFromApi(current));
            }
          } catch { /* Preserve the local draft if reloading is unavailable. */ }
        } else setError(t('editor.errors.saveFailed'));
      }
    } finally {
      mutationLock.current = false;
      if (mounted.current) setSaving(false);
    }
    return false;
  };

  const draftValue: NoteDraftValue = { fieldValues, deckId, noteTypeId, tagsText, acceptedAnswersText, createOperationId,
    baseVersion, baseDeckId, savedNoteId, pendingSave: recovery.snapshot.pending, cardId: editing?.id ?? savedCardId, label: selectedPreview?.renderFrontText.slice(0, 160), noteType: activeNoteType, clozeRetainHistoryFor };
  const localDraft = useEditorDraft({ scope: { ownerId, kind: 'note', entityId: editing?.noteId ?? 'new' },
    value: draftValue, fingerprint: saveFingerprint,
    validate: isNoteDraftValue, unsettled: Boolean(recovery.snapshot.pending), busy: saving || deleting || uploadingFields > 0, onSave: () => handleSave(false),
    onRestore: (value) => {
      if (value.createOperationId) setCreateOperationId(value.createOperationId);
      if (value.pendingSave) recovery.controller.restorePending(value.pendingSave);
      setSavedNoteId(value.savedNoteId); setSavedCardId(value.cardId);
      // An unchanged deck selection was not an instruction to move sibling
      // cards back after an external move or opening another direction.
      const originalDeck = value.baseDeckId ?? value.deckId;
      const restoredDeck = editing && value.deckId === originalDeck ? editing.deckId : value.deckId;
      setFieldValues(value.fieldValues); setDeckId(restoredDeck); setBaseDeckId(value.deckId === originalDeck ? editing?.deckId ?? originalDeck : originalDeck); setNoteTypeId(value.noteTypeId);
      setTagsText(value.tagsText); setAcceptedAnswersText(value.acceptedAnswersText); setBaseVersion(value.baseVersion);
      setRestoredType(value.noteType); setClozeRetainHistoryFor(value.clozeRetainHistoryFor);
      const currentType = noteTypes.find(type => type.id === editing?.noteType?.id);
      setError(null);
      setLatest(editing && value.baseVersion !== editing.note?.updatedAt ? editing : null);
      setLatestType(currentType && (currentType.id !== value.noteTypeId || currentType.updatedAt !== value.noteType?.updatedAt) ? currentType : null);
      requestAnimationFrame(() => formRoot.current?.querySelector<HTMLTextAreaElement>('textarea[data-nn-field]')?.focus());
    },
  });

  const applyRevisionResult = (result: RestoredNoteDocument) => {
    const updated = useNN.getState().acceptRecoveredNote(ownerId, result);
    const saved = updated.find((next) => next.id === editing?.id) ?? updated[0];
    const note = saved?.note ?? result.note;
    const nextFields = { ...(note?.fieldValues ?? {}) };
    const nextTags = (note?.tags ?? saved?.tags ?? []).join(', ');
    const nextAnswers = (note?.acceptedAnswers ?? []).join('\n');
    const stamp = note?.updatedAt;
    localDraft.markSaved(draftFingerprint({ fieldValues: nextFields, deckId, noteTypeId, tagsText: nextTags, acceptedAnswersText: nextAnswers, clozeRetainHistoryFor }));
    setFieldValues(nextFields);
    setTagsText(nextTags);
    setAcceptedAnswersText(nextAnswers);
    setBaseVersion(stamp instanceof Date ? stamp.toISOString() : stamp);
    setLatest(null);
    setLatestType(null);
    setError(null);
    if (saved) onSaved?.(saved);
  };

  const restoreRevision = async (item: NoteRevisionRow) => {
    if (!editing || mutationLock.current || restoringId) return;
    if (item.noteTypeId !== activeNoteType?.id || blockedRevisionIds.includes(item.id)) return;
    if (!(await confirm({ title: t('editor.history.confirm') }))) return;
    if (!mounted.current || mutationLock.current) return;
    mutationLock.current = true;
    setRestoringId(item.id);
    setError(null);
    try {
      const expectedUpdatedAt = baseVersion;
      const expectedTypeUpdatedAt = activeNoteType?.updatedAt;
      if (typeof expectedUpdatedAt !== 'string' || typeof expectedTypeUpdatedAt !== 'string') return;
      const body = { expectedUpdatedAt, expectedTypeUpdatedAt };
      const preview = await ok(await api.notes({ id: editing.noteId }).revisions({ revisionId: item.id }).restore.post({ ...body, preview: true }));
      if (!mounted.current) return;
      if ('impact' in preview) {
        if (preview.impact.willDeleteCards > 0) {
          const details = preview.impact.removedCards.map((removed) => `• ${removed.front} (${removed.reviews})`).join('\n');
          if (!(await confirm({ title: t('noteTypes.impact.title'), danger: true,
            message: `${t('noteTypes.impact.counts', { create: preview.impact.willCreateCards, keep: preview.impact.willKeepCards,
              remove: preview.impact.willDeleteCards, reviews: preview.impact.willDeleteReviews })}\n\n${details}`,
          }))) return;
          if (!mounted.current) return;
        }
        const applied = await ok(await api.notes({ id: editing.noteId }).revisions({ revisionId: item.id }).restore.post(
          preview.impact.willDeleteCards > 0 ? { ...body, confirmationToken: preview.confirmationToken } : body,
        ));
        if (!mounted.current || !isRestoredNoteDocument(applied)) return;
        applyRevisionResult(applied);
      } else if (isRestoredNoteDocument(preview)) {
        applyRevisionResult(preview);
      }
      const items = await loadRevisions(editing.noteId);
      if (mounted.current) setRevisions(items);
    } catch (err) {
      if (mounted.current) {
        if (err instanceof ApiError && err.status === 409 && err.safeMessage === 'note_changed') {
          setError(t('editor.errors.changed'));
          try {
            const current = cardFromApi(await ok(await (api as any).cards({ id: editing.id }).get()));
            if (mounted.current) setLatest(current);
          } catch { /* The local draft stays when the current card cannot be reloaded. */ }
        } else if (err instanceof ApiError && err.safeMessage === 'note_type_changed') {
          setBlockedRevisionIds((ids) => ids.includes(item.id) ? ids : [...ids, item.id]);
          setError(t('editor.history.typeChanged'));
        } else setError(t('editor.errors.saveFailed'));
      }
    } finally {
      mutationLock.current = false;
      if (mounted.current) setRestoringId(null);
    }
  };

  const handleDelete = async () => {
    if (!editing || mutationLock.current || localDraft.blocked || uploadCount.current > 0) return;
    mutationLock.current = true;
    try {
      if (!(await confirm({ title: t('editor.deleteConfirm'), danger: true }))) return;
      if (!mounted.current) return;
      setDeleting(true);
      setError(null);
      await deleteNote(editing.noteId);
      if (mounted.current) { localDraft.markSaved(); onDeleted?.(editing.id); }
    } catch (err) {
      console.error('deleteNote failed', err);
      if (mounted.current) setError(t('editor.errors.deleteFailed'));
    } finally {
      mutationLock.current = false;
      if (mounted.current) setDeleting(false);
    }
  };

  // ⌘/Ctrl+Enter triggers save.
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !e.nativeEvent.isComposing && !e.repeat) {
      e.preventDefault();
      if (!saving) void handleSave();
    }
  };

  const deckTone = (currentDeck?.color ?? 'neutral') as
    | 'neutral' | 'lime' | 'amber' | 'violet' | 'sky' | 'rose';

  // Stable reset key for the rich-text fields — changes when the edited entity
  // OR note-type changes (so inputs re-hydrate from `fieldValues`).
  const resetKey = `${editing?.id ?? 'new'}::${noteTypeId}`;

  const actionButtons = <>
          {footerExtra}
          <NNBtn size="sm" variant="ghost" onClick={() => router.push('/editor?drafts=1')}>{t('editor.draft.libraryTitle')}</NNBtn>
          {editing && layout !== 'dock' && <NNBtn size="sm" variant="soft" disabled={saving || deleting || uploadingFields > 0 || localDraft.blocked} onClick={() => {
            if (JSON.stringify(fieldValues) !== JSON.stringify(editing.note?.fieldValues ?? {}) || tagsText !== editing.tags.join(', ') || deckId !== editing.deckId || acceptedAnswersText !== (editing.note?.acceptedAnswers ?? []).join('\n')) {
              setError(t('noteTypes.convert.saveFirst')); return;
            }
            setConverting(true);
          }}>{t('noteTypes.convert.open')}</NNBtn>}
          {editing && (
            <NNBtn size="sm" variant="danger" icon="x" onClick={handleDelete} loading={deleting} disabled={saving || uploadingFields > 0 || localDraft.blocked}>{t('actions.delete')}</NNBtn>
          )}
          <NNBtn size="sm" variant="primary" icon="check" onClick={() => handleSave()} loading={saving} disabled={deleting || uploadingFields > 0 || localDraft.blocked}>
            {saving ? t('editor.saving') : saveLabel ?? (editing || savedNoteId ? t('actions.save') : t('actions.create'))}
          </NNBtn>
  </>;

  return (
    <div ref={formRoot} className="reomi-card-form" data-actions={actionsPlacement}

      onKeyDown={handleKeyDown}
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: isMobile ? 'auto' : 'hidden',
      }}
    >
      {converting && editing && <NoteConversionDialog cards={[editing]} onClose={() => setConverting(false)} onConverted={(converted) => {
        setConverting(false); const saved = converted.find((card) => card.id === editing.id) ?? converted[0];
        if (saved) {
          localDraft.markSaved(draftFingerprint({ fieldValues: saved.note?.fieldValues ?? {}, deckId: saved.deckId, noteTypeId: saved.noteType?.id ?? noteTypeId, tagsText: saved.tags.join(', '), acceptedAnswersText: (saved.note?.acceptedAnswers ?? []).join('\n'), clozeRetainHistoryFor: undefined }));
          setRestoredType(undefined); setDeckId(saved.deckId); setBaseDeckId(saved.deckId);
          setNoteTypeId(saved.noteType?.id ?? noteTypeId); setFieldValues({ ...(saved.note?.fieldValues ?? {}) });
          setTagsText(saved.tags.join(', ')); setAcceptedAnswersText((saved.note?.acceptedAnswers ?? []).join('\n'));
          setBaseVersion(saved.note?.updatedAt); setLatest(null); setLatestType(null); setError(null);
          setPreviewKey(''); setFlipped(false); setClozeRetainHistoryFor(undefined); onSaved?.(saved);
        }
      }} />}
      <div className="reomi-card-form-scroll nn-scroll" style={{ padding: isMobile ? '16px 14px' : 24, overflow: isMobile ? 'visible' : 'auto' }}>
        <SaveFeedback status={recovery.snapshot.status} errorCode={recovery.snapshot.error} onRetry={() => void handleSave()} />
        <EditorDraftNotice draft={localDraft} stale={Boolean(localDraft.pending && (localDraft.pending.value.baseVersion !== editing?.note?.updatedAt || localDraft.pending.value.noteType?.updatedAt !== (noteTypes.find(type => type.id === localDraft.pending!.value.noteTypeId) ?? editingNoteType)?.updatedAt))} />
        <fieldset disabled={localDraft.blocked} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
        {actionsPlacement === 'header' && <div className="reomi-card-form-actions" style={{ display: 'flex', alignItems: 'center', gap: isMobile ? 6 : 8, marginBottom: 20, flexWrap: 'wrap' }}>
          {compactHeader ? <span className="reomi-card-form-heading">{heading ?? t('cards.panel.content')}</span> : <>

          <NNBadge tone={deckTone} size="sm">{currentDeck?.name ?? t('editor.noDeck')}</NNBadge>
          <span style={{ color: 'var(--text-dim)', fontSize: 13 }}>/</span>
          <span style={{ fontSize: 13, color: 'var(--text)' }}>
            {editing ? t('editor.editingCard', { id: editing.id.slice(0, 6) }) : t('editor.newCard')}
          </span>
          </>}
          <div style={{ flex: 1 }}/>
          {actionButtons}
        </div>}



        {decks.length === 0 && <div style={{ marginBottom: 16 }}>
          <NNBtn variant="soft" onClick={() => router.push('/decks')}>{t('decks.newDeck')}</NNBtn>
        </div>}

        {/* Compact FSRS status line — existing cards only, when the header is on.
            New cards / browser inline editor render nothing (no em-dash rows). */}
        {editing && showFsrsHeader && (
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: isMobile ? 10 : 16,
            marginBottom: 18, fontSize: 12, color: 'var(--text-dim)',
          }}>
            {(() => {
              const fsrs = editing.fsrs;
              const rows: { l: string; v: string }[] = [
                { l: t('editor.fsrsLabels.stability'), v: t('editor.stabilityDays', { n: fsrs.stability?.toFixed?.(1) ?? '-' }) },
                { l: t('editor.fsrsLabels.difficulty'), v: `${fsrs.difficulty?.toFixed?.(1) ?? '-'}` },
                { l: t('editor.fsrsLabels.reps'), v: `${fsrs.reps ?? 0}` },
                { l: t('editor.fsrsLabels.lapses'), v: `${fsrs.lapses ?? 0}` },
              ];
              return rows.map((p) => (
                <span key={p.l} style={{ display: 'inline-flex', gap: 5, alignItems: 'baseline' }}>
                  <span>{p.l}</span>
                  <span className="mono" style={{ color: 'var(--text-muted)' }}>{p.v}</span>
                </span>
              ));
            })()}
          </div>
        )}

        {/* Deck + note-type selectors */}
        <div className="reomi-card-form-meta" style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: isMobile ? 8 : 12, marginBottom: 16 }}>
          <div>
            <div className="reomi-editor-label" style={labelStyle}><span>{t('editor.deckLabel')}</span></div>
            <NNSelect
              value={deckId}
              onChange={setDeckId}
              options={deckOptions}
              placeholder={t('editor.noDecksYet')}
              emptyText={t('editor.noDecksYet')}
              ariaLabel={t('editor.deckLabel')}
              disabled={saving || deleting}
            />
          </div>
          <div>
            <div className="reomi-editor-label" style={labelStyle}>
              <span>{t('editor.noteTypeLabel')}</span>
              <div style={{ flex: 1 }} />
              <Button variant="bare"
                type="button"
                onClick={() => router.push('/note-types')}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  color: 'var(--lime-400)',
                  fontFamily: 'var(--font-sans)',
                  fontSize: 11,
                  letterSpacing: 0,
                  textTransform: 'none',
                  cursor: 'pointer',
                }}
              >
                {t('editor.manageNoteTypes')}
              </Button>
            </div>
            <NNSelect
              value={noteTypeId}
              onChange={setNoteTypeId}
              options={noteTypeOptions}
              placeholder={t('editor.noNoteTypes')}
              emptyText={t('editor.noNoteTypes')}
              ariaLabel={t('editor.noteTypeLabel')}
              // Changing the note-type only matters for NEW notes (an existing
              // note keeps its type; clone/convert is Phase 5b).
              disabled={saving || deleting || uploadingFields > 0 || !!editing || noteTypes.length === 0}
            />
          </div>
        </div>

        {editing && <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 14px' }}>{t('editor.sharedNoteHint')}</p>}

        {/* Dynamic fields. `data-nn-fields` marks the Tab-navigation ring: the
            RichField keydown handler walks the `textarea[data-nn-field]` siblings
            inside it. In the `dock` layout (wide-short bottom panel) the fields
            sit in two columns on non-mobile to use the horizontal space. */}
        <div
          data-nn-fields
          style={
            layout === 'dock' && !isMobile
              ? { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, alignItems: 'start' }
              : undefined
          }
        >
          {fields.map((field, i) => {
            const isFront = i === 0;
            const fieldLabel = activeNoteType?.isBuiltin
              ? field.name === 'Front' ? t('review.questionLabel') : field.name === 'Back' ? t('review.answerLabel')
                : field.name === 'Text' ? t('editor.fields.clozeText') : field.name === 'Extra' ? t('editor.fields.extra') : field.name
              : field.name;
            return (
              <div key={field.name} style={{ marginBottom: layout === 'dock' && !isMobile ? 0 : 14 }}>
                <div className="reomi-editor-label" style={labelStyle}>
                  <span>{fieldLabel}</span>

                  {isCloze && isFront && (
                    <span style={{ textTransform: 'none', letterSpacing: 0, color: 'var(--text-dim)' }}>
                      {t('editor.fields.clozeHint', { syntax: '{{c1::…}}' })}
                    </span>
                  )}
                </div>
                <RichField
                  value={fieldValues[field.name] ?? ''}
                  onChange={(markdown) => setField(field.name, markdown)}
                  placeholder={isFront ? t('editor.fields.frontPlaceholder') : undefined}
                  serif={isFront}
                  minHeight={isFront ? (isMobile ? 90 : 100) : isMobile ? 120 : 110}
                  autoFocus={autoFocusFront && !editing && isFront}
                  resetKey={resetKey}
                  blocked={saving || deleting}
                  label={fieldLabel}
                  onUploadChange={onUploadChange}
                />
              </div>
            );
          })}
        </div>

        {/* Tags */}
        <div style={{ marginTop: 16 }}>
          <div className="reomi-editor-label" style={labelStyle}><span>{t('editor.tagsLinks')}</span></div>
          <TextInput
            value={tagsText}
            disabled={saving || deleting}
            aria-label={t('editor.tagsLinks')}
            onChange={(e) => setTagsText(e.target.value)}
            placeholder={t('editor.tagsPlaceholder')}
            style={inputStyle}
          />

        </div>

        {editing && revisions.length > 0 && <div data-note-history style={{ marginTop: 16 }}>
          {revisions.map((item) => {
            const typeChanged = item.noteTypeId !== activeNoteType?.id || blockedRevisionIds.includes(item.id);
            return (
              <div key={item.id} style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{revisionStamp(item.revisedAt, locale)}</div>
                  <div style={{ fontSize: 13, overflowWrap: 'anywhere' }}>{item.label}</div>
                  {typeChanged && <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 2 }}>{t('editor.history.typeChanged')}</div>}
                </div>
                <NNBtn size="sm" variant="ghost" disabled={typeChanged || saving || deleting || restoringId !== null || localDraft.blocked}
                  loading={restoringId === item.id} onClick={() => void restoreRevision(item)}>
                  {t('editor.history.restore')}
                </NNBtn>
              </div>
            );
          })}
        </div>}

        {error && (
          <div role="alert" style={{

            marginTop: 14, padding: '10px 12px',
            background: 'var(--tone-rose-bg)', border: '1px solid var(--tone-rose-border)',
            borderRadius: 10, color: 'var(--rose-400)', fontSize: 12.5,
          }}>
            {error}
          </div>
        )}

        {Object.entries(fieldValues).some(([name]) => !fields.some(field => field.name === name)) && <NNCard padding={14} style={{ marginTop: 12 }}>
          <p>{t('editor.draft.extraFields')}</p>
          {Object.entries(fieldValues).filter(([name]) => !fields.some(field => field.name === name)).map(([name, value]) => <div key={name} style={{ marginTop: 12 }}>
            <label>{name}<textarea readOnly aria-label={name} value={value} style={{ width: '100%', minHeight: 80, background: 'var(--surface)', color: 'var(--text)' }} /></label>
            <NNBtn size="sm" variant="ghost" disabled={saving || deleting} onClick={async () => {
              if (await confirm({ title: t('editor.draft.removeField', { name }), danger: true })) setFieldValues(current => Object.fromEntries(Object.entries(current).filter(([key]) => key !== name)));
            }}>{t('editor.draft.removeExtra')}</NNBtn>
          </div>)}
        </NNCard>}

        {(latest?.note || latestType) && <NNCard padding={14} style={{ marginTop: 12 }}>
          <div>{t('editor.conflict.latest')}</div>
          {Object.entries(latest?.note?.fieldValues ?? {}).map(([name, value]) => <div key={name} style={{ marginTop: 8 }}>
            <label>{name}<textarea readOnly value={value} style={{ width: '100%', minHeight: 64 }} /></label>
          </div>)}
          {latestType && <div>
            <p>{latestType.name} · {latestType.fields.map((field) => field.name).join(', ')}</p>
            {latestType.templates.map((template) => <details key={template.id ?? template.ord}>
              <summary>{template.name}</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{template.frontTemplate}{'\n'}{template.backTemplate}</pre>
            </details>)}
          </div>}
          <NNBtn disabled={saving} size="sm" onClick={async () => {
            if (await confirm({ title: t('editor.conflict.keepDraft'), danger: true })) {
              if (latestType) {
                const renames = new Map((activeNoteType?.fields ?? []).flatMap((old) => {
                  const next = latestType.fields.find((field) => field.id && field.id === old.id);
                  return next ? [[old.name, next.name] as const] : [];
                }));
                const mapped = renameFieldValues(fieldValues, renames);
                if (!mapped) { setError(t('editor.errors.schemaCollision')); return; }
                useNN.setState((state) => ({ noteTypes: [...state.noteTypes.filter((type) => type.id !== latestType.id), latestType] }));
                setFieldValues({ ...(latest?.note?.fieldValues ?? {}), ...mapped }); setNoteTypeId(latestType.id); setRestoredType(latestType);
              }
              setBaseVersion(latest?.note?.updatedAt); setLatest(null); setLatestType(null); setError(null);
            }
          }}>{t('editor.conflict.reviewDraft')}</NNBtn>
        </NNCard>}

        {activeNoteType?.kind === 'typein' && <div style={{ marginTop: 14 }}>
          <p>{t('editor.typein.target', { field: answerField?.name ?? '' })}: <strong>{fieldPlainText(fieldValues[answerField?.name ?? ''] ?? '') || '—'}</strong></p>
          <label style={{ display: 'block' }}>{t('editor.typein.alternatives')}
            <textarea value={acceptedAnswersText} onChange={(event) => setAcceptedAnswersText(event.target.value)} rows={3}
              style={{ width: '100%', background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 8, padding: 10 }} />
          </label>
          <p style={{ color: 'var(--text-muted)', fontSize: 12 }}>{t('editor.typein.hint')}</p>
        </div>}
        {generation.error && !error && showPreview && <div role="status" style={{ marginTop: 12, color: 'var(--rose-400)' }}>{contentError(generation.error)}</div>}
        {legacyCloze && <NNCard padding={14} style={{ marginTop: 12 }}>
          <p>{t('editor.cloze.legacy')}</p>
          {splitChoices.some((choice) => !choice.numbers.length) && <p>{t('editor.cloze.addNumbers')}</p>}
          {clozeRetainHistoryFor === undefined ? <NNBtn size="sm" disabled={saving || !splitChoices.length || splitChoices.some((choice) => !choice.numbers.length)}
            onClick={() => setClozeRetainHistoryFor(Object.fromEntries(splitChoices.map((choice) => [String(choice.templateOrd), choice.numbers[0]])))}>{t('editor.cloze.split')}</NNBtn>
            : <>
              {splitChoices.map((choice) => <div key={choice.templateOrd}>
                <label>{choice.name}</label>
                <NNSelect value={String(clozeRetainHistoryFor[String(choice.templateOrd)])} disabled={saving}
                  onChange={(value) => setClozeRetainHistoryFor((previous) => ({ ...previous, [String(choice.templateOrd)]: Number(value) }))}
                  options={choice.numbers.map((number) => ({ value: String(number), label: `c${number}` }))} ariaLabel={t('editor.cloze.historyTarget')} />
              </div>)}
              <p style={{ whiteSpace: 'pre-wrap' }}>{splitExplanation}</p>
              <NNBtn size="sm" disabled={saving} onClick={() => setClozeRetainHistoryFor(undefined)}>{t('actions.cancel')}</NNBtn>
            </>}

        </NNCard>}
        {!generation.error && activeNoteType && (inlinePreview || generation.cards.length !== 1 || omittedTemplates.length > 0) && <div style={{ marginTop: 14 }}>
          <label>{t('editor.previewQuestion', { n: generation.cards.length })}</label>
          {generation.cards.length > 1 && <NNSelect value={selectedPreviewKey} onChange={setPreviewKey} options={generation.cards.map((card) => ({
            value: keyFor(card), label: `${activeNoteType?.templates.find((template) => template.ord === card.templateOrd)?.name ?? String(card.templateOrd + 1)}${card.clozeNumber ? ` · c${card.clozeNumber}` : ''}`,
          }))} ariaLabel={t('editor.previewQuestion', { n: generation.cards.length })} />}
          {omittedTemplates.length > 0 && <p style={{ color: 'var(--text-dim)', fontSize: 12 }}>
            {t('editor.omittedTemplates', { names: omittedTemplates.map((template) => template.name).join(', ') })}
          </p>}
        </div>}

        {/* Preview: a single flip card behind a toggle (replaces the always-on
            dual front+back inline preview). Reuses the `preview` memo + SafeHtml,
            so images + KaTeX render exactly as in review. */}
        {inlinePreview && <div style={{ marginTop: 22 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
            <NNBtn
              size="sm"
              variant={showPreview ? 'primary' : 'ghost'}
              icon="eye"
              onClick={() => { setShowPreview((v) => !v); setFlipped(false); }}
            >
              {t('editor.previewToggle')}
            </NNBtn>
            {showPreview && (
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{t('editor.flipHint')}</span>
            )}
          </div>
          {/* A6: field values accept Markdown source; the preview above renders it
              via the same SafeHtml pipeline as review. An unobtrusive hint — no
              WYSIWYG-markdown mode (plan A6: rendering is primary). */}
          <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginBottom: 8 }}>
            {t('editor.richText.markdownMode')}
          </div>
          {showPreview && (
            <NNCard padding={0} style={{ overflow: 'hidden' }}>
              <div
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  // Don't flip when clicking interactive children or an image
                  // (matches review.tsx's guard, plus <img> per Execution note #3).
                  const tgt = e.target as HTMLElement;
                  if (
                    tgt.tagName === 'INPUT' ||
                    tgt.tagName === 'BUTTON' ||
                    tgt.tagName === 'A' ||
                    tgt.tagName === 'IMG' ||
                    tgt.closest('button') ||
                    tgt.closest('a') ||
                    tgt.closest('.nn-content-error')
                  )
                    return;
                  setFlipped((v) => !v);
                }}
                onKeyDown={(e) => {
                  if (e.key === ' ' || e.key === 'Spacebar' || e.key === 'Enter') {
                    e.preventDefault();
                    setFlipped((v) => !v);
                  }
                }}
                style={{
                  padding: isMobile ? '20px 18px' : '30px 34px',
                  display: 'flex',
                  flexDirection: 'column',
                  minHeight: isMobile ? 160 : 200,
                  cursor: 'pointer',
                  outline: 'none',
                }}
              >
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: isMobile ? 18 : 24 }}>
                  <NNBadge size="xs" tone="neutral">{activeNoteType?.name ?? '—'}</NNBadge>
                  {tags.map((tag, i) => (
                    <NNTag key={`pv-${tag}-${i}`} color={deckTone === 'neutral' ? 'sky' : deckTone}>{tag}</NNTag>
                  ))}
                </div>
                {/* Question eyebrow — mirrors review.tsx hierarchy. For cloze the
                    label flips to "Answer" once the prompt side is revealed. */}
                <div
                  style={{
                    fontSize: 10.5,
                    fontWeight: 600,
                    letterSpacing: 1.6,
                    textTransform: 'uppercase',
                    color: 'var(--text-dim)',
                    fontFamily: 'var(--font-sans)',
                    marginBottom: 12,
                  }}
                >
                  {activeNoteType?.kind === 'cloze' && flipped ? t('review.answerLabel') : t('review.questionLabel')}
                </div>
                {/* Front / prompt — 1:1 with review.tsx front styling. For cloze
                    the prompt side flips to the answer on reveal (mirrors review). */}
                {preview.front.trim() && activeNoteType ? (
                  <RichCard
                    noteType={activeNoteType}
                    fieldValues={fieldValues}
                    templateOrd={selectedPreview?.templateOrd}
                    clozeNumber={selectedPreview?.clozeNumber}
                    side={activeNoteType.kind === 'cloze' ? (flipped ? 'back' : 'front') : 'front'}
                    style={{
                      fontFamily: 'var(--font-serif)',
                      fontSize: isMobile ? (activeNoteType.kind === 'cloze' ? 28 : 32) : (activeNoteType.kind === 'cloze' ? 36 : 48),
                      lineHeight: 1.15,
                      letterSpacing: -1,
                      color: 'var(--text)',
                      fontWeight: 400,
                      wordBreak: 'break-word',
                    }}
                  />
                ) : (
                  <div style={{ color: 'var(--text-dim)', fontFamily: 'var(--font-serif)', fontSize: isMobile ? 32 : 48 }}>
                    {t('editor.frontPreview')}
                  </div>
                )}
                {/* Divider + revealed answer — 1:1 with review.tsx (non-cloze):
                    "Answer" eyebrow, a thin lime accent rule, calm --text serif
                    (NOT lime text). Cloze reveals by flipping the prompt side
                    above, so no separate answer block (matches review). */}
                {activeNoteType?.kind !== 'cloze' && (
                  <>
                    <div
                      style={{
                        marginTop: isMobile ? 26 : 32,
                        height: 1,
                        background: 'linear-gradient(to right, var(--border-2), transparent)',
                      }}
                    />
                    <div
                      style={{
                        opacity: flipped ? 1 : 0,
                        transform: flipped ? 'translateY(0)' : 'translateY(8px)',
                        transition: 'opacity 240ms ease, transform 240ms ease',
                        pointerEvents: flipped ? 'auto' : 'none',
                        minHeight: flipped ? 40 : 0,
                        marginTop: flipped ? (isMobile ? 22 : 28) : 0,
                      }}
                    >
                      {flipped && (
                        <>
                          <div
                            style={{
                              fontSize: 10.5,
                              fontWeight: 600,
                              letterSpacing: 1.6,
                              textTransform: 'uppercase',
                              color: 'var(--lime-400)',
                              fontFamily: 'var(--font-sans)',
                              marginBottom: 12,
                            }}
                          >
                            {t('review.answerLabel')}
                          </div>
                          {preview.back.trim() && activeNoteType ? (
                            <div style={{ borderLeft: '2px solid var(--lime-500)', paddingLeft: isMobile ? 14 : 18 }}>
                              <RichCard
                                noteType={activeNoteType}
                                fieldValues={fieldValues}
                                templateOrd={selectedPreview?.templateOrd}
                                clozeNumber={selectedPreview?.clozeNumber}
                                side="back"
                                style={{
                                  fontFamily: 'var(--font-serif)',
                                  fontSize: isMobile ? 21 : 24,
                                  fontWeight: 400,
                                  color: 'var(--text)',
                                  letterSpacing: -0.3,
                                  lineHeight: 1.45,
                                  wordBreak: 'break-word',
                                }}
                              />
                            </div>
                          ) : (
                            <div style={{ color: 'var(--text-dim)', fontSize: 16 }}>{t('editor.backPreview')}</div>
                          )}
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
            </NNCard>
          )}
        </div>}
        </fieldset>

      </div>
      {actionsPlacement === 'footer' && <footer className="reomi-card-form-footer">
        {error && <p role="alert" className="reomi-card-form-footer-error">{error}</p>}
        <div className="reomi-card-form-footer-actions">{actionButtons}</div>
      </footer>}
    </div>
  );
};


/** Account and card identity changes remount field state; sibling cards share a note draft slot. */
export function NNCardForm(props: NNCardFormProps) {
  const owner = useNN(state => state.profile?.userId) ?? '';
  const ready = useNN(state => state.bootstrapped);
  if (!ready) return <NNPageSkeleton />;
  return <CardFormEditor key={`${owner}:${props.card?.id ?? `new:${props.defaultDeckId ?? ''}:${props.defaultNoteTypeId ?? ''}`}`} {...props} />;
}
