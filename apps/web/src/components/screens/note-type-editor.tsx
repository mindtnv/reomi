'use client';

/* eslint-disable react/forbid-elements -- #78 */

import { withDraftKeys, withoutDraftKey, adoptTypeIdentities } from '@/lib/type-draft-identities';
import { newUuidV7, normalizeFieldName, validFieldNames, validateTemplates, typedAnswerField, renameFieldValues, renameTemplateFields } from '@reomi/shared';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LayerParent, useTransientLayer } from '@/lib/use-transient-layer';
import { useModalFocus } from '@/lib/use-modal-focus';
import { raiseToast } from '@/components/toasts';
import { useSearchParams } from 'next/navigation';
import { useAppNavigation } from '@/components/navigation';
import { NNBtn, NNBadge, NNCard, NNIcon, NNPageSkeleton } from '@/components/ui';
import { useNN } from '@/lib/store';
import type { NoteType } from '@/lib/types';
import { useBreakpoint } from '@/lib/use-breakpoint';
import { useT } from '@/lib/i18n';
import { useDialog } from '@/components/dialog';
import { renderCardHtml } from '@/lib/render-card';
import { RichCard } from '@/components/rich-card';
import type { RenderKind, CardRegenerationPreview, CardTemplate, FieldValues, NoteField } from '@reomi/shared';
import { api, ApiError, ok } from '@/lib/api';
import { NoteTypeDeletionDialog } from '@/components/note-type-deletion';
import { useEditorDraft } from '@/lib/use-editor-draft';
import { draftFingerprint } from '@/lib/editor-drafts';
import { isTypeDraftValue } from '@/lib/editor-draft-values';
import { EditorDraftNotice } from '@/components/editor-draft-notice';
import { useRecoverableAction, type RecoveryAction } from '@/lib/use-recoverable-action';
import { SaveFeedback } from '@/components/save-feedback';
import { noteTypeFromApi } from '@/lib/mappers';

// ─────────────────────────────────────────────
// Note-type editor (Milestone 1, Phase 5b)
//
// The headline "create your own card types" feature. Lets the user:
//   - list existing note-types (own + global builtins; builtins are read-only
//     and offer a "Clone to edit" affordance),
//   - create a new note-type (name + dynamic fields + card templates + styling),
//   - edit an own note-type, or CLONE-ON-EDIT a builtin (server returns a new
//     user-owned copy via PATCH /note-types/:id),
//   - delete an own note-type (cascade warning).
//
// Live preview: per template, render front + back HTML from the draft def +
// sample field values (via `renderCardHtml` → DOMPurified by <SafeHtml>). Honors
// the empty-front skip rule: a template whose front renders empty shows
// "no card generated".
//
// Custom types are `kind='custom'` (builtins keep their kind; M1 doesn't let
// users author basic/cloze/typein render modes).
// ─────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '9px 12px',
  borderRadius: 10,
  background: 'color-mix(in srgb, var(--surface-2) 60%, transparent)',
  border: '1px solid var(--panel-edge)',
  color: 'var(--text)',
  fontFamily: 'var(--font-sans)',
  fontSize: 14,
  outline: 'none',
  boxSizing: 'border-box',
};

const monoTextarea: React.CSSProperties = {
  ...inputStyle,
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  fontSize: 13,
  lineHeight: 1.5,
  resize: 'vertical',
  minHeight: 72,
};

const labelStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--text-dim)',
  fontWeight: 500,
  marginBottom: 6,
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: 'var(--text)',
};

const hintStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--text-dim)',
  lineHeight: 1.4,
};

// ── Draft model ───────────────────────────────────────────────────────────────

interface Draft {
  name: string;
  fields: NoteField[];
  templates: CardTemplate[];
  styling: string;
}

function emptyDraft(): Draft {
  return {
    name: '',
    fields: withDraftKeys([
      { name: 'Front', ord: 0 },
      { name: 'Back', ord: 1 },
    ]),
    templates: withDraftKeys([
      { name: 'Card 1', ord: 0, frontTemplate: '{{Front}}', backTemplate: '{{Front}}<hr>{{Back}}' },
    ]),
    styling: '',
  };
}

function draftFromNoteType(nt: NoteType): Draft {
  return {
    name: nt.name,
    fields: withDraftKeys([...nt.fields].sort((a, b) => a.ord - b.ord)),
    templates: withDraftKeys([...nt.templates].sort((a, b) => a.ord - b.ord)),
    styling: nt.styling,
  };
}

// Re-pack ordinals to be dense 0..n-1 (the server validates dense/unique ords).
function reindex<T extends { ord: number }>(items: T[]): T[] {
  return items.map((it, i) => ({ ...it, ord: i }));
}

// ── List view ─────────────────────────────────────────────────────────────────

const NoteTypeList = ({
  noteTypes,
  onCreate,
  onEdit,
  onDelete,
  onKind,
  onApply,
  onBack,
}: {
  noteTypes: NoteType[];
  onCreate: () => void;
  onEdit: (nt: NoteType) => void;
  onDelete: (nt: NoteType) => void;
  onKind: (nt: NoteType) => void;
  onApply: (nt: NoteType) => void;
  onBack: () => void;
}) => {
  const t = useT();
  const nav = useAppNavigation();
  const sorted = useMemo(
    () => [...noteTypes].sort((a, b) => Number(b.isBuiltin) - Number(a.isBuiltin) || a.name.localeCompare(b.name)),
    [noteTypes],
  );

  return (
<div className="reomi-page-surface reomi-note-types-workspace nn-scroll">
<header className="reomi-note-types-heading">
        <NNBtn size="sm" variant="ghost" icon="chevl" onClick={onBack}>
          {t('noteTypes.list.back')}
        </NNBtn>
        <div style={sectionTitleStyle}>{t('noteTypes.list.title')}</div>
        <div style={{ flex: 1 }} />
        <NNBtn size="sm" variant="soft" onClick={() => nav.push('/editor?drafts=1')}>{t('editor.draft.shortTitle')}</NNBtn>
        <NNBtn size="sm" variant="primary" icon="plus" onClick={onCreate}>
          {t('noteTypes.list.newType')}
        </NNBtn>
      </header>
      <p className="reomi-note-types-intro">{t('noteTypes.list.hint')}</p>

      {sorted.length === 0 ? (
        <NNCard>
          <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>{t('noteTypes.list.empty')}</div>
        </NNCard>
      ) : (
<div className="reomi-note-types-list">
          {sorted.map((nt) => (
            <NNCard key={nt.id} className="reomi-note-type-row">
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>{nt.name}</div>
                <NNBadge size="xs" tone={nt.isBuiltin ? 'sky' : 'lime'}>
                  {nt.isBuiltin ? t('noteTypes.list.builtin') : t('noteTypes.list.custom')}
                </NNBadge>
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                  {t('noteTypes.list.fieldsCount', { n: nt.fields.length })}
                </span>
                <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>·</span>
                <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                  {t('noteTypes.list.templatesCount', { n: nt.templates.length })}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                <NNBtn size="sm" variant="soft" icon="edit" onClick={() => onEdit(nt)}>
                  {t('noteTypes.list.edit')}
                </NNBtn>
                {!nt.isBuiltin && <NNBtn size="sm" variant="soft" onClick={() => onApply(nt)}>{t('noteTypes.convert.applyToNotes')}</NNBtn>}
                {!nt.isBuiltin && <NNBtn size="sm" variant="soft" onClick={() => onKind(nt)}>{t('noteTypes.kind.change')}</NNBtn>}
                {!nt.isBuiltin && (
                  <NNBtn size="sm" variant="danger" icon="x" onClick={() => onDelete(nt)}>
                    {t('noteTypes.list.delete')}
                  </NNBtn>
                )}
              </div>
            </NNCard>
          ))}
        </div>
      )}
    </div>
  );
};

// ── Field editor row ────────────────────────────────────────────────────────────

const FieldRow = ({
  field,
  index,
  count,
  onRename,
  onMove,
  onRemove,
}: {
  field: NoteField;
  index: number;
  count: number;
  onRename: (name: string) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) => {
  const t = useT();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <input
        value={field.name}
        onChange={(e) => onRename(e.target.value)}
        placeholder={t('noteTypes.fields.namePlaceholder')}
        style={{ ...inputStyle, flex: 1 }}
      />
      <NNBtn
        size="sm"
        variant="ghost"
        icon="chevd"
        ariaLabel={t('noteTypes.fields.moveDown')}
        disabled={index === count - 1}
        onClick={() => onMove(1)}
      />
      <NNBtn
        size="sm"
        variant="ghost"
        icon="chevd"
        ariaLabel={t('noteTypes.fields.moveUp')}
        disabled={index === 0}
        onClick={() => onMove(-1)}
        style={{ transform: 'rotate(180deg)' }}
      />
      <NNBtn
        size="sm"
        variant="ghost"
        icon="x"
        ariaLabel={t('noteTypes.fields.remove')}
        disabled={count <= 1}
        onClick={onRemove}
      />
    </div>
  );
};

// ── Template editor ─────────────────────────────────────────────────────────────

const TemplateEditor = ({
  template,
  count,
  fieldNames,
  onChange,
  onRemove,
}: {
  template: CardTemplate;
  count: number;
  fieldNames: string[];
  onChange: (patch: Partial<CardTemplate>) => void;
  onRemove: () => void;
}) => {
  const t = useT();
  const frontRef = useRef<HTMLTextAreaElement | null>(null);
  const backRef = useRef<HTMLTextAreaElement | null>(null);
  const [focused, setFocused] = useState<'front' | 'back'>('front');

  // Insert {{Field}} at the caret of the last-focused textarea.
  const insertField = (name: string) => {
    const token = `{{${name}}}`;
    const ref = focused === 'front' ? frontRef.current : backRef.current;
    const key = focused === 'front' ? 'frontTemplate' : 'backTemplate';
    const current = focused === 'front' ? template.frontTemplate : template.backTemplate;
    if (!ref) {
      onChange({ [key]: current + token } as Partial<CardTemplate>);
      return;
    }
    const start = ref.selectionStart ?? current.length;
    const end = ref.selectionEnd ?? current.length;
    const next = current.slice(0, start) + token + current.slice(end);
    onChange({ [key]: next } as Partial<CardTemplate>);
    // Restore caret after the inserted token on the next tick.
    requestAnimationFrame(() => {
      ref.focus();
      const pos = start + token.length;
      ref.setSelectionRange(pos, pos);
    });
  };

  return (
    <NNCard style={{ background: 'var(--surface-2, var(--surface))' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <input
          value={template.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder={t('noteTypes.templates.namePlaceholder')}
          style={{ ...inputStyle, flex: 1, fontWeight: 600 }}
        />
        <NNBtn
          size="sm"
          variant="ghost"
          icon="x"
          ariaLabel={t('noteTypes.templates.remove')}
          disabled={count <= 1}
          onClick={onRemove}
        />
      </div>

      {/* Field chips */}
      {fieldNames.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            {t('noteTypes.templates.availableFields')}:
          </span>
          {fieldNames.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => insertField(name)}
              title={t('noteTypes.templates.insert')}
              style={{
                padding: '3px 8px',
                borderRadius: 'var(--r-pill, 999px)',
                background: 'var(--surface-3)',
                border: '1px solid var(--border)',
                color: 'var(--text-muted)',
                fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                fontSize: 11.5,
                cursor: 'pointer',
              }}
            >
              {`{{${name}}}`}
            </button>
          ))}
        </div>
      )}

      <div style={{ marginBottom: 12 }}>
        <div style={labelStyle}>
          <span>{t('noteTypes.templates.frontLabel')}</span>
        </div>
        <textarea
          ref={frontRef}
          value={template.frontTemplate}
          onFocus={() => setFocused('front')}
          onChange={(e) => onChange({ frontTemplate: e.target.value })}
          style={monoTextarea}
        />
      </div>
      <div>
        <div style={labelStyle}>
          <span>{t('noteTypes.templates.backLabel')}</span>
        </div>
        <textarea
          ref={backRef}
          value={template.backTemplate}
          onFocus={() => setFocused('back')}
          onChange={(e) => onChange({ backTemplate: e.target.value })}
          style={monoTextarea}
        />
      </div>
    </NNCard>
  );
};

// ── Template preview ─────────────────────────────────────────────────────────────

const TemplatePreview = ({
  template,
  draft,
  sample,
}: {
  template: CardTemplate;
  draft: Draft;
  sample: FieldValues;
}) => {
  const t = useT();
  // Build a throwaway NoteTypeDef-shaped object for the render helper. Custom
  // types render straight template output (kind='custom').
  const def = useMemo(
    () => ({ kind: 'custom' as const, templates: draft.templates }),
    [draft.templates],
  );
  const front = useMemo(
    () => renderCardHtml(def, sample, 'front', template.ord),
    [def, sample, template.ord],
  );
  const back = useMemo(
    () => renderCardHtml(def, sample, 'back', template.ord),
    [def, sample, template.ord],
  );
  const empty = !front.trim();

  return (
    <NNCard padding={0} style={{ overflow: 'hidden' }}>
      <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 6 }}>
        <NNIcon name="stack" size={13} color="var(--text-dim)" />
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {template.name || t('noteTypes.preview.template')}
        </span>
      </div>
      {empty ? (
        <div style={{ padding: '18px 16px', color: 'var(--text-dim)', fontSize: 13 }}>
          {t('noteTypes.preview.noCard')}
        </div>
      ) : (
        <div style={{ padding: '18px 20px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div style={labelStyle}><span>{t('noteTypes.preview.front')}</span></div>
            <RichCard
              noteType={def}
              fieldValues={sample}
              side="front"
              templateOrd={template.ord}
              style={{ fontFamily: 'var(--font-sans)', fontSize: 22, lineHeight: 1.3, color: 'var(--text)', wordBreak: 'break-word' }}
            />
          </div>
          <div style={{ height: 1, background: 'linear-gradient(to right, transparent, var(--border-2), transparent)' }} />
          <div>
            <div style={labelStyle}><span>{t('noteTypes.preview.back')}</span></div>
            {back.trim() ? (
              <RichCard
                noteType={def}
                fieldValues={sample}
                side="back"
                templateOrd={template.ord}
                style={{ fontFamily: 'var(--font-sans)', fontSize: 15, color: 'var(--text-muted)', lineHeight: 1.5, wordBreak: 'break-word' }}
              />
            ) : (
              <div style={{ color: 'var(--text-dim)', fontSize: 14 }}>—</div>
            )}
          </div>
        </div>
      )}
    </NNCard>
  );
};

// ── Form view ────────────────────────────────────────────────────────────────

const NoteTypeForm = ({
  editing: initialEditing,
  onDone,
  onCancel,
}: {
  // The note-type being edited, or null for create. Builtins clone-on-edit.
  editing: NoteType | null;
  onDone: (saved: NoteType) => void;
  onCancel: () => void;
}) => {
  const t = useT();
  const router = useAppNavigation();
  const bp = useBreakpoint();
  const isMobile = bp === 'mobile';
  const [savedType, setSavedType] = useState<NoteType | null>(null);
  const editing = savedType ?? initialEditing;
  const { confirm } = useDialog();
  const saveLock = useRef(false);
  const formRoot = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const ownerId = useNN(state => state.profile?.userId) ?? '';
  const [baseVersion, setBaseVersion] = useState(editing?.updatedAt);
  const [baseKind, setBaseKind] = useState(editing?.kind ?? 'custom');
  const [latest, setLatest] = useState<NoteType | null>(null);
  const [offerCopy, setOfferCopy] = useState(false);

  const isClone = editing?.isBuiltin ?? false;
  const [draft, setDraft] = useState<Draft>(() =>
    editing ? { ...draftFromNoteType(editing), fields: withDraftKeys(editing.fields.map((field) => ({ ...field, ...(editing.kind === 'typein' && field === typedAnswerField(editing.fields) ? { typeinAnswer: true } : {}) }))) } : emptyDraft(),
  );
  // Per-field sample values for the preview, keyed by field name. Default to the
  // field name itself so the author immediately sees where each field lands.
  const [sample, setSample] = useState<FieldValues>(() => {
    const init: FieldValues = {};
    (editing ? editing.fields : emptyDraft().fields).forEach((f) => {
      init[f.name] = f.name;
    });
    return init;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const saveFingerprint = draftFingerprint(draft);
  const recovery = useRecoverableAction(ownerId, saveFingerprint, baseVersion);

  const fieldNames = useMemo(() => draft.fields.map((f) => f.name).filter(Boolean), [draft.fields]);

  // Keep sample values keyed by the CURRENT field names (drop renamed/removed,
  // seed new ones with the field name).
  const effectiveSample = useMemo(() => {
    const out: FieldValues = {};
    for (const name of fieldNames) {
      out[name] = sample[name] ?? name;
    }
    return out;
  }, [fieldNames, sample]);

  // ── Field mutations ──
  const setFieldName = useCallback((index: number, name: string) => {
    const previous = draft.fields[index]?.name;
    if (previous === undefined) return;
    const renames = new Map([[previous, name]]);
    setSample((values) => renameFieldValues(values, renames) ?? values);
    setDraft((d) => ({
      ...d,
      fields: d.fields.map((f, i) => (i === index ? { ...f, name } : f)),
      templates: d.templates.map((template) => ({
        ...template,
        frontTemplate: renameTemplateFields(template.frontTemplate, renames),
        backTemplate: renameTemplateFields(template.backTemplate, renames),
      })),
    }));
  }, [draft.fields]);

  const moveField = useCallback((index: number, dir: -1 | 1) => {
    setDraft((d) => {
      const next = [...d.fields];
      const j = index + dir;
      if (j < 0 || j >= next.length) return d;
      [next[index], next[j]] = [next[j], next[index]];
      return { ...d, fields: reindex(next) };
    });
  }, []);

  const removeField = useCallback((index: number) => {
    setDraft((d) => ({ ...d, fields: reindex(d.fields.filter((_, i) => i !== index)) }));
  }, []);

  const addField = useCallback(() => {
    setDraft((d) => ({
      ...d,
      fields: [...d.fields, { draftKey: newUuidV7(), name: `Field ${d.fields.length + 1}`, ord: d.fields.length }],
    }));
  }, []);

  // ── Template mutations ──
  const setTemplate = useCallback((index: number, patch: Partial<CardTemplate>) => {
    setDraft((d) => ({
      ...d,
      templates: d.templates.map((tpl, i) => (i === index ? { ...tpl, ...patch } : tpl)),
    }));
  }, []);

  const removeTemplate = useCallback((index: number) => {
    setDraft((d) => ({ ...d, templates: reindex(d.templates.filter((_, i) => i !== index)) }));
  }, []);

  const addTemplate = useCallback(() => {
    setDraft((d) => {
      const first = d.fields[0]?.name ?? 'Front';
      const second = d.fields[1]?.name ?? d.fields[0]?.name ?? 'Back';
      return {
        ...d,
        templates: [
          ...d.templates,
          {
            draftKey: newUuidV7(), name: `Card ${d.templates.length + 1}`,
            ord: d.templates.length,
            frontTemplate: `{{${first}}}`,
            backTemplate: `{{${first}}}<hr>{{${second}}}`,
          },
        ],
      };
    });
  }, []);

  const validate = (): string | null => {
    if (!draft.name.trim()) return t('noteTypes.errors.nameRequired');
    const names = draft.fields.map((f) => f.name.trim());
    if (names.length === 0 || names.some((n) => !n)) return t('noteTypes.errors.noFields');
    if (!validFieldNames(draft.fields)) return t('noteTypes.errors.invalidFields');
    if (editing?.kind === 'typein' && !draft.fields.some((field) => field.typeinAnswer)) return t('noteTypes.errors.answerRequired');
    const issue = validateTemplates(draft.fields, draft.templates)[0];
    if (issue?.code === 'unsupported_html') return t('noteTypes.errors.unsupportedHtml', { template: draft.templates.find((tpl) => tpl.ord === issue.templateOrd)?.name ?? '', tag: issue.tag ?? '', position: issue.offset + 1 });
    if (issue) return t('noteTypes.errors.invalidTemplate', { template: draft.templates.find((tpl) => tpl.ord === issue.templateOrd)?.name ?? '', side: issue.side === 'front' ? t('noteTypes.preview.front') : t('noteTypes.preview.back'), position: issue.offset + 1, field: issue.field ?? '' });
    const tnames = draft.templates.map((tpl) => tpl.name.trim());
    if (tnames.length === 0 || tnames.some((n) => !n)) return t('noteTypes.errors.noTemplates');
    if (new Set(tnames).size !== tnames.length) return t('noteTypes.errors.duplicateTemplates');
    return null;
  };

  const handleSave = async (saveCopy = false, notify = true): Promise<boolean> => {
    if ((ownerId && useNN.getState().profile?.userId !== ownerId) || saveLock.current || localDraft.blocked) return false;
    const v = validate();
    if (v) {
      setError(v);
      return false;
    }
    setError(null);
    saveLock.current = true;
    setSaving(true);
    // Re-pack ordinals dense+unique (server validates this) and trim names.
    const payload = {
      name: draft.name.trim(),
      fields: reindex(draft.fields.map((f) => ({ ...withoutDraftKey(f), name: normalizeFieldName(f.name) }))),
      templates: reindex(draft.templates.map((tpl) => ({ ...withoutDraftKey(tpl), name: tpl.name.trim(), frontTemplate: renameTemplateFields(tpl.frontTemplate, new Map()), backTemplate: renameTemplateFields(tpl.backTemplate, new Map()) }))),
      styling: draft.styling,
    };
    try {
      const fingerprint = saveFingerprint;
      let action: RecoveryAction;
      if (recovery.snapshot.status === 'uncertain' && recovery.snapshot.pending) {
        action = recovery.snapshot.pending.payload;
      } else if (editing && saveCopy) {
        recovery.controller.resolveConflict();
        action = { path: '/note-types', method: 'POST', args: { input: { ...payload, kind: editing.kind } } };
      } else if (editing && !editing.isBuiltin) {
        const preview = await ok(await (api as any)['note-types']({ id: editing.id }).preview.post({
          ...payload, preview: true, expectedUpdatedAt: baseVersion,
        })) as CardRegenerationPreview;
        if (!alive.current) return false;
        const impact = preview.impact;
        const sampleDetails = preview.validation?.samples.map((sample) => `• ${sample.front || '—'} → ${sample.error ? t(sample.error === 'typein_answer_placement' ? 'editor.errors.typeinPlacement' : 'noteTypes.validation.invalid') : sample.questions.join(' / ') || t('noteTypes.validation.media')}${sample.answer ? ` — ${t('noteTypes.answerField')}: ${sample.answer}` : ''}${sample.omittedTemplates.length ? ` (${t('noteTypes.validation.omitted', { names: sample.omittedTemplates.join(', ') })})` : ''}`).join('\n');
        if (preview.validation?.invalidNotes) {
          setError(`${t('noteTypes.validation.blocked', { n: preview.validation.invalidNotes })}\n${sampleDetails ?? ''}`);
          return false;
        }
        if (impact.willCreateCards || impact.willDeleteCards || preview.validation?.checkedNotes) {
          const details = impact.removedCards.map((card) => `• ${card.front || t('noteTypes.preview.noCard')} (${card.reviews})`).join('\n');
          if (!(await confirm({ title: t('noteTypes.impact.title'), danger: impact.willDeleteCards > 0,
            message: `${t('noteTypes.impact.counts', { create: impact.willCreateCards, keep: impact.willKeepCards,
              remove: impact.willDeleteCards, reviews: impact.willDeleteReviews })}${sampleDetails ? `\n\n${t('noteTypes.validation.samples')}\n${sampleDetails}` : ''}${details ? `\n\n${t('noteTypes.impact.removed')}\n${details}` : ''}`,
          }))) return false;
        }
        if (!alive.current) return false;
        action = { path: `/note-types/${editing.id}`, method: 'PATCH', args: { input: { ...payload,
          expectedUpdatedAt: preview.sourceVersion, confirmationToken: preview.confirmationToken } } };
      } else if (editing && editing.isBuiltin) {
        // CLONE-ON-EDIT: PATCH a builtin → server returns a NEW user-owned copy
        // (kind preserved server-side). Store appends the clone.
        action = { path: `/note-types/${editing.id}`, method: 'PATCH', args: { input: { ...payload, expectedUpdatedAt: baseVersion } } };
      } else {
        // New custom type.
        action = { path: '/note-types', method: 'POST', args: { input: { ...payload, kind: 'custom' } } };
      }
      if (recovery.snapshot.status !== 'uncertain') action.draft = { ...draft, baseVersion, kind: baseKind };
      const accepted = await recovery.save(action, fingerprint);
      if (!alive.current || useNN.getState().profile?.userId !== ownerId) return false;
      if (!accepted.response.result || accepted.response.outcome !== 'applied') {
        if (accepted.response.result) setLatest(noteTypeFromApi(accepted.response.result));
        throw new ApiError('note_type_changed', { status: 409 });
      }
      const saved = noteTypeFromApi(accepted.response.result);
      await useNN.getState().acceptRecoveredType(ownerId, saved, accepted.submitted.payload.method === 'PATCH' ? accepted.submitted.payload.path.split('/')[2] : undefined);
      if (!alive.current) return false;
      setSavedType(saved); setBaseVersion(saved.updatedAt); setBaseKind(saved.kind); setLatest(null);
      const submittedDraft = isTypeDraftValue(accepted.submitted.payload.draft) ? accepted.submitted.payload.draft : { ...draft, baseVersion, kind: baseKind };
      const canonical = adoptTypeIdentities(submittedDraft, submittedDraft, saved);
      const canonicalFingerprint = draftFingerprint({ name: canonical.name, fields: canonical.fields, templates: canonical.templates, styling: canonical.styling });
      setDraft(current => adoptTypeIdentities(current, submittedDraft, saved));
      recovery.controller.canonicalizeAcknowledgement(accepted.submitted.fingerprint, canonicalFingerprint);
      localDraft.markSaved(accepted.submitted.fingerprint, { ...canonical, baseVersion: saved.updatedAt, kind: saved.kind, savedType: saved, pendingSave: null }, canonicalFingerprint);
      if (accepted.currentMatches) { if (notify) onDone(saved); return true; }
      return false;
    } catch (err) {
      if (!alive.current) return false;
      if (err instanceof ApiError && err.safeMessage === 'note_type_operation_too_large') {
        setError(t('noteTypes.errors.tooLarge')); setOfferCopy(true);
      } else if (err instanceof ApiError && ['note_type_operation_busy', 'note_type_operation_timeout'].includes(err.safeMessage)) {
        setError(t('noteTypes.errors.busy'));
      } else if (err instanceof ApiError && err.status === 409 && editing) {
        setError(t('noteTypes.errors.changed'));
        try {
          const rows = await ok(await (api as any)['note-types'].get()) as any[];
          const current = rows.find((row) => row.id === editing.id);
          if (current && alive.current) setLatest(noteTypeFromApi(current));
        } catch { /* Keep the draft and conflict message if refreshing fails. */ }
      } else setError(t('noteTypes.errors.saveFailed'));
    } finally {
      saveLock.current = false;
      if (alive.current) setSaving(false);
    }
    return false;
  };

  const localDraft = useEditorDraft({ scope: { ownerId, kind: 'type', entityId: initialEditing?.id ?? 'new' },
    value: { ...draft, baseVersion, kind: baseKind, savedType: savedType ?? undefined, pendingSave: recovery.snapshot.pending }, fingerprint: saveFingerprint, validate: isTypeDraftValue,
    busy: saving, unsettled: Boolean(recovery.snapshot.pending), onSave: () => handleSave(false, false),
    onRestore: ({ baseVersion, kind, savedType, pendingSave, ...value }) => { if (pendingSave) recovery.controller.restorePending(pendingSave); setSavedType(savedType ?? null); setDraft(value); setBaseVersion(baseVersion); setBaseKind(kind ?? editing?.kind ?? 'custom'); setLatest(editing && baseVersion !== editing.updatedAt ? editing : null); setError(null); requestAnimationFrame(() => formRoot.current?.querySelector<HTMLInputElement>('input')?.focus()); },
  });

  const title = !editing
    ? t('noteTypes.editor.newTitle')
    : isClone
      ? t('noteTypes.editor.cloneTitle', { name: editing.name })
      : t('noteTypes.editor.editTitle', { name: editing.name });

  return (
    <div ref={formRoot} className="reomi-page-surface reomi-note-type-editor nn-scroll">
      <EditorDraftNotice draft={localDraft} stale={Boolean(localDraft.pending && localDraft.pending.value.baseVersion !== editing?.updatedAt)} />
<SaveFeedback status={recovery.snapshot.status} errorCode={recovery.snapshot.error} onRetry={() => void handleSave()} />
<header className="reomi-note-type-editor-heading">
        <NNBtn size="sm" variant="ghost" icon="chevl" onClick={() => { void localDraft.confirmLeave().then(allowed => { if (allowed) onCancel(); }); }} disabled={saving}>
          {t('noteTypes.editor.back')}
        </NNBtn>
        <div style={sectionTitleStyle}>{title}</div>
        <NNBtn size="sm" variant="ghost" onClick={() => router.push('/editor?drafts=1')}>{t('editor.draft.libraryTitle')}</NNBtn>
        <div style={{ flex: 1 }} />
        <NNBtn size="sm" variant="primary" icon="check" onClick={() => handleSave()} disabled={saving || localDraft.blocked}>
          {saving
            ? t('noteTypes.actions.saving')
            : t('noteTypes.actions.save')}
        </NNBtn>
        {editing && !isClone && <NNBtn size="sm" disabled={saving || localDraft.blocked} onClick={() => handleSave(true)}>{t('noteTypes.actions.saveCopy')}</NNBtn>}
      </header>

      {offerCopy && editing && <NNCard style={{ marginBottom: 16 }}>
        <p>{t('noteTypes.errors.copyHint')}</p>
      </NNCard>}


      {latest && <NNCard padding={16} style={{ marginBottom: 16 }}>
        <div role="status">{t('noteTypes.impact.latest')}</div>
        <p>{latest.name} · {latest.fields.map((field) => field.name).join(', ')}</p>
        {latest.templates.map((template) => <details key={template.id ?? template.ord}>
          <summary>{template.name}</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{template.frontTemplate}{'\n\n'}{template.backTemplate}</pre>
        </details>)}
        <NNBtn disabled={saving} size="sm" onClick={async () => {
          if (await confirm({ title: t('noteTypes.impact.replaceDraft'), danger: true })) {
            localDraft.markSaved(draftFingerprint(draftFromNoteType(latest)));
            setSavedType(latest); setDraft(draftFromNoteType(latest)); setBaseVersion(latest.updatedAt); setBaseKind(latest.kind); setLatest(null); setError(null);
          }
        }}>{t('noteTypes.impact.loadLatest')}</NNBtn>
      </NNCard>}

      <fieldset disabled={saving || localDraft.blocked} className="reomi-note-type-columns">
        {/* Left: editor */}
<div className="reomi-note-type-fields">
          {/* Name */}
          <div>
            <div style={labelStyle}><span>{t('noteTypes.editor.nameLabel')}</span></div>
            <input
              aria-label={t('noteTypes.editor.nameLabel')}
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder={t('noteTypes.editor.namePlaceholder')}
              style={inputStyle}
            />
          </div>

          {/* Fields */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
              <div style={sectionTitleStyle}>{t('noteTypes.fields.title')}</div>
              <div style={{ flex: 1 }} />
              <NNBtn size="sm" variant="soft" icon="plus" onClick={addField} disabled={draft.fields.length >= 64}>
                {t('noteTypes.fields.addField')}
              </NNBtn>
            </div>
            <div style={{ ...hintStyle, marginBottom: 10 }}>{t('noteTypes.fields.hint')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {draft.fields.map((field, i) => (
                <FieldRow
                  key={i}
                  field={field}
                  index={i}
                  count={draft.fields.length}
                  onRename={(name) => setFieldName(i, name)}
                  onMove={(dir) => moveField(i, dir)}
                  onRemove={() => removeField(i)}
                />
              ))}
            </div>
          </div>

          {editing?.kind === 'typein' && <label>{t('noteTypes.answerField')}
            <select aria-label={t('noteTypes.answerField')} style={inputStyle}
              value={draft.fields.findIndex((field) => field.typeinAnswer)}
              onChange={(event) => setDraft((previous) => ({ ...previous, fields: previous.fields.map((field, index) => ({ ...field, typeinAnswer: index === Number(event.target.value) })) }))}>
              <option value={-1} disabled>{t('noteTypes.errors.answerRequired')}</option>
              {draft.fields.map((field, index) => <option key={field.id ?? index} value={index}>{field.name}</option>)}
            </select>
          </label>}

          {/* Templates */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
              <div style={sectionTitleStyle}>{t('noteTypes.templates.title')}</div>
              <div style={{ flex: 1 }} />
              <NNBtn size="sm" variant="soft" icon="plus" onClick={addTemplate} disabled={draft.templates.length >= 32}>
                {t('noteTypes.templates.addTemplate')}
              </NNBtn>
            </div>
            <div style={{ ...hintStyle, marginBottom: 10 }}>
              {t('noteTypes.templates.syntaxHint', {
                field: '{{Field}}',
                cond: '{{#Field}}',
                inv: '{{^Field}}',
                condEnd: '{{/Field}}',
              })}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {draft.templates.map((tpl, i) => (
                <TemplateEditor
                  key={i}
                  template={tpl}
                  count={draft.templates.length}
                  fieldNames={fieldNames}
                  onChange={(patch) => setTemplate(i, patch)}
                  onRemove={() => removeTemplate(i)}
                />
              ))}
            </div>
          </div>

          {/* CSS is retained as legacy data; the renderer never applies it. */}
          <div>
            <div style={sectionTitleStyle}>{t('noteTypes.styling.title')}</div>
            <div style={{ ...hintStyle, margin: '6px 0 10px' }}>{t('noteTypes.styling.hint')}</div>
            {draft.styling && <details>
              <summary>{t('noteTypes.styling.saved')}</summary>
              <textarea readOnly aria-label={t('noteTypes.styling.saved')} value={draft.styling} style={monoTextarea} />
            </details>}
          </div>

          {error && (
            <div role="alert" style={{
              padding: '10px 12px',
              background: 'color-mix(in srgb, var(--rose-400) 8%, transparent)', border: '1px solid color-mix(in srgb, var(--rose-400) 28%, transparent)',
              borderRadius: 10, color: 'var(--rose-400)', fontSize: 12.5, whiteSpace: 'pre-wrap',
            }}>
              {error}
            </div>
          )}
        </div>

        {/* Right: sample values + live preview */}
<aside className="reomi-note-type-preview">
          <div>
            <div style={sectionTitleStyle}>{t('noteTypes.preview.title')}</div>
            <div style={{ ...hintStyle, margin: '6px 0 10px' }}>{t('noteTypes.preview.hint')}</div>
            <NNCard>
              <div style={labelStyle}><span>{t('noteTypes.preview.sampleLabel')}</span></div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {fieldNames.map((name) => (
                  <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)', minWidth: 80, fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>
                      {name}
                    </span>
                    <input
                      aria-label={`${t('noteTypes.preview.sampleLabel')}: ${name}`}
                      value={sample[name] ?? name}
                      onChange={(e) => setSample((s) => ({ ...s, [name]: e.target.value }))}
                      style={{ ...inputStyle, flex: 1, padding: '7px 10px', fontSize: 13 }}
                    />
                  </div>
                ))}
              </div>
            </NNCard>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {draft.templates.map((tpl, i) => (
              <TemplatePreview key={i} template={tpl} draft={draft} sample={effectiveSample} />
            ))}
          </div>
        </aside>
      </fieldset>
    </div>
  );
};

// A mode transition is reviewed separately from field/template edits.
const NoteTypeKindForm = ({ editing, onDone }: { editing: NoteType; onDone: () => void }) => {
  const t = useT();
  const modal = useRef<HTMLDivElement>(null);
  useModalFocus(modal);
  const { confirm } = useDialog();
  const ownerId = useNN(state => state.profile?.userId) ?? '';
  const [kind, setKind] = useState<RenderKind>(editing.kind);
  const [answerFieldId, setAnswerFieldId] = useState(typedAnswerField(editing.fields)?.id ?? '');
  const [version, setVersion] = useState(editing.updatedAt);
  const recovery = useRecoverableAction(ownerId, draftFingerprint({ kind, answerFieldId }), version);
  const [busy, setBusy] = useState(false);
  const layer = useTransientLayer({ root: modal, modal: true, busy, onClose: onDone });
  const [error, setError] = useState<string | null>(null);
  const lock = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const label = (value: RenderKind) => t(value === 'cloze' ? 'editor.variants.cloze' : value === 'typein' ? 'editor.variants.type' : value === 'custom' ? 'noteTypes.kind.custom' : 'editor.variants.basic');
  const apply = async () => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null);
    const body = { kind, expectedUpdatedAt: version, ...(kind === 'typein' ? { answerFieldId } : {}) };
    try {
      let action: RecoveryAction;
      if (recovery.snapshot.status === 'uncertain' && recovery.snapshot.pending) action = recovery.snapshot.pending.payload;
      else {
      const preview = await ok(await (api as any)['note-types']({ id: editing.id }).kind.preview.post(body)) as CardRegenerationPreview;
      if (!alive.current) return;
      const samples = preview.validation?.samples.map((sample) => `• ${sample.front || '—'} → ${sample.error ? t(sample.error === 'typein_answer_placement' ? 'editor.errors.typeinPlacement' : 'noteTypes.validation.invalid') : sample.questions.join(' / ') || t('noteTypes.validation.media')}${sample.answer ? ` — ${sample.answer}` : ''}`).join('\n') ?? '';
      if (preview.validation?.invalidNotes) {
        setError(`${t('noteTypes.validation.blocked', { n: preview.validation.invalidNotes })}\n${samples}`); return;
      }
      const impact = preview.impact;
      const approved = await confirm({ title: t('noteTypes.kind.confirm', { from: label(editing.kind), to: label(kind) }),
        danger: impact.willDeleteCards > 0,
        message: `${preview.kindTransition?.resetsQuestions ? t('noteTypes.kind.reset') : t('noteTypes.kind.preserve')}\n${t('noteTypes.impact.counts', { create: impact.willCreateCards, keep: impact.willKeepCards, remove: impact.willDeleteCards, reviews: impact.willDeleteReviews })}${samples ? `\n\n${t('noteTypes.validation.samples')}\n${samples}` : ''}`,
      });
      if (!approved || !alive.current) return;
      action = { path: `/note-types/${editing.id}/kind`, method: 'POST', args: { input: { ...body, expectedUpdatedAt: preview.sourceVersion, confirmationToken: preview.confirmationToken } } };
      }
      const accepted = await recovery.save(action);
      if (!alive.current || !accepted.response.result || accepted.response.outcome !== 'applied') throw new ApiError('note_type_changed', { status: 409 });
      const saved = noteTypeFromApi(accepted.response.result);
      setVersion(saved.updatedAt);
      await useNN.getState().acceptRecoveredType(ownerId, saved, editing.id);
      if (alive.current && accepted.currentMatches) onDone();
    } catch (error) {
      if (alive.current) {
        const tooLarge = error instanceof ApiError && error.safeMessage === 'note_type_operation_too_large';
        setError(tooLarge ? `${t('noteTypes.errors.tooLarge')} ${t('noteTypes.errors.kindCopyHint')}`
          : t(error instanceof ApiError && ['note_type_operation_busy', 'note_type_operation_timeout'].includes(error.safeMessage) ? 'noteTypes.errors.busy' : error instanceof ApiError && error.status === 409 ? 'noteTypes.kind.changed' : 'noteTypes.errors.saveFailed'));
      }
    } finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  return createPortal(<LayerParent.Provider value={layer.id}><div className="reomi-overlay-backdrop" onClick={event => { if (event.target === event.currentTarget && !busy) void layer.close('outside'); }}>
    <div ref={modal} role="dialog" aria-modal="true" aria-labelledby="note-type-mode-title" className="reomi-flow-dialog" tabIndex={-1}
      onKeyDown={event => { if (event.key === 'Escape' && !busy) { event.stopPropagation(); void layer.close('escape'); } }}>
    <header><h2 id="note-type-mode-title">{t('noteTypes.kind.title', { name: editing.name })}</h2><NNBtn variant="ghost" icon="x" onClick={() => void layer.close()} disabled={busy} ariaLabel={t('actions.close')} /></header>
    <p className="reomi-flow-intro">{t('noteTypes.kind.intro')}</p>
    <SaveFeedback status={recovery.snapshot.status} errorCode={recovery.snapshot.error} onRetry={() => void apply()} />
    <fieldset disabled={busy} style={{ border: 0, padding: 0, display: 'grid', gap: 16 }}>
      <label>{t('noteTypes.kind.mode')}<select aria-label={t('noteTypes.kind.mode')} style={inputStyle} value={kind} onChange={(event) => setKind(event.target.value as RenderKind)}>
        {(['basic', 'custom', 'typein', 'cloze'] as const).map((value) => <option value={value} key={value}>{label(value)}</option>)}
      </select></label>
      {kind === 'typein' && <label>{t('noteTypes.answerField')}<select aria-label={t('noteTypes.answerField')} style={inputStyle} value={answerFieldId} onChange={(event) => setAnswerFieldId(event.target.value)}>
        {editing.fields.map((field) => <option value={field.id} key={field.id}>{field.name}</option>)}
      </select></label>}
      <p>{kind === 'cloze' ? t('noteTypes.kind.cloze') : t('noteTypes.kind.scopeHint')}</p>
      <NNBtn variant="primary" disabled={kind === editing.kind} onClick={apply}>{busy ? t('noteTypes.actions.saving') : t('noteTypes.kind.preview')}</NNBtn>
    </fieldset>
    {error && <p role="alert" style={{ color: 'var(--rose-400)', whiteSpace: 'pre-wrap' }}>{error}</p>}
  </div></div></LayerParent.Provider>, document.body);
};

// ── Screen orchestrator ──────────────────────────────────────────────────────

export const NNNoteTypeEditor = () => {
  const t = useT();
  const router = useAppNavigation();
  const searchParams = useSearchParams();
  const kindId = searchParams?.get('kind') ?? null;
  const editId = searchParams?.get('edit') ?? kindId;
  const isNew = searchParams?.get('new') === '1';

  const noteTypes = useNN((s) => s.noteTypes);
  const ownerId = useNN(state => state.profile?.userId) ?? '';
  const bootstrapped = useNN(state => state.bootstrapped);
  const [deleting, setDeleting] = useState<NoteType | null>(null);

  const editing = useMemo(
    () => (editId ? noteTypes.find((nt) => nt.id === editId) ?? null : null),
    [noteTypes, editId],
  );

  const goList = useCallback(() => router.replace('/note-types', { track: false }), [router]);
  const goNew = useCallback(() => router.replace('/note-types?new=1', { track: false }), [router]);
  // Leave the (deep-linked) note-types screen — back when there's history,
  // else fall through to Home so the user is never stranded.
  const goBack = useCallback(() => {
    if (typeof window !== 'undefined' && window.history.length > 1) router.back();
    else router.push('/');
  }, [router]);
  const goEdit = useCallback(
    (nt: NoteType) => router.replace(`/note-types?edit=${encodeURIComponent(nt.id)}`, { track: false }),
    [router],
  );

  if (!bootstrapped) return <NNPageSkeleton />;


  // Form mode: explicit ?new=1 OR ?edit=<id> resolving to a known type.
  if (isNew || (editing && !kindId)) {
    return (
      <NoteTypeForm key={`${ownerId}:${editing?.id ?? 'new'}`}
        editing={editing}
        onDone={() => { raiseToast({ kind: 'success', title: t('noteTypes.saved') }); goList(); }}
        onCancel={goList}
      />
    );
  }

  return (
    <>
    {kindId && editing && !editing.isBuiltin && <NoteTypeKindForm key={editing.id} editing={editing} onDone={goList} />}
    {deleting && <NoteTypeDeletionDialog key={deleting.id} type={deleting} onClose={() => setDeleting(null)}
      onPreserve={() => { setDeleting(null); router.push(`/cards?noteTypeId=${encodeURIComponent(deleting.id)}`); }} />}
    <NoteTypeList
      noteTypes={noteTypes}
      onCreate={goNew}
      onEdit={goEdit}
      onDelete={setDeleting}
      onApply={(type) => router.push(`/cards?convertTo=${encodeURIComponent(type.id)}`)}
      onKind={(type) => router.replace(`/note-types?kind=${encodeURIComponent(type.id)}`, { track: false })}
      onBack={goBack}
    />
    </>
  );
};
