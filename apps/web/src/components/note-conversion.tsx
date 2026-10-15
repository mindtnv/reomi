'use client';

/* eslint-disable react/forbid-elements -- TODO: replace raw input, select, and button with TextInput, Button, or NNSelect. */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { typedAnswerField, type NoteConversionInput, type NoteConversionPreview } from '@reomi/shared';
import { useNN } from '@/lib/store';
import { useT } from '@/lib/i18n';
import { api, ApiError, ok } from '@/lib/api';
import type { Card, NoteType } from '@/lib/types';
import { deckPathLabel } from '@/lib/decks';
import { LayerParent, useTransientLayer } from '@/lib/use-transient-layer';
import { useModalFocus } from '@/lib/use-modal-focus';
import { NNBtn } from './ui';

const selectStyle: React.CSSProperties = { width: '100%', padding: 10, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 10 };
export function NoteConversionDialog({ cards, targetTypeId, onClose, onConverted }: {
  cards: Card[]; targetTypeId?: string; onClose: () => void; onConverted: (cards: Card[]) => void;
}) {
  const t = useT();
  const types = useNN((state) => state.noteTypes);
  const decks = useNN((state) => state.decks);
  const [newCardsDeckId, setNewCardsDeckId] = useState('');
  const typeLabel = (type?: NoteType) => type ? `${type.name} · ${t(type.isBuiltin ? 'noteTypes.list.builtin' : 'noteTypes.list.custom')}` : '';
  const templateLabel = (template: { name: string; ord: number }, siblings: { name: string }[]) => siblings.filter((item) => item.name === template.name).length > 1 ? `${template.name} (${template.ord + 1})` : template.name;
  const convert = useNN((state) => state.convertNotes);
  const root = useRef<HTMLDivElement>(null);
  const targetSelect = useRef<HTMLSelectElement>(null);
  const previewHeading = useRef<HTMLHeadingElement>(null);
  useModalFocus(root);
  const alive = useRef(true); const lock = useRef(false);
  useEffect(() => {
    alive.current = true;
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { alive.current = false; document.body.style.overflow = overflow; };
  }, []);
  const source = types.find((type) => type.id === cards[0]?.noteType?.id);
  const noteIds = useMemo(() => [...new Set(cards.map((card) => card.noteId))], [cards]);
  const sourceNames = useMemo(() => [...new Set([...(source?.fields.map((field) => field.name) ?? []), ...cards.flatMap((card) => Object.keys(card.note?.fieldValues ?? {}))])], [source, cards]);
  const eligible = Boolean(source && cards.every((card) => card.noteType?.id === source.id) && noteIds.length <= 200);
  const [targetId, setTargetId] = useState(targetTypeId ?? '');
  const target = types.find((type) => type.id === targetId && type.id !== source?.id);
  const [fieldMap, setFieldMap] = useState<Record<string, string | null>>({});
  const [templateMap, setTemplateMap] = useState<Record<string, string | null>>({});
  const [preserve, setPreserve] = useState(true);
  const [busy, setBusy] = useState(false);
  const layer = useTransientLayer({ root, modal: true, busy, onClose });
  const [error, setError] = useState<string | null>(null);
  const [needsReload, setNeedsReload] = useState(false);
  const [preview, setPreview] = useState<{ input: NoteConversionInput; result: NoteConversionPreview } | null>(null);
  useEffect(() => { if (preview) previewHeading.current?.focus(); else targetSelect.current?.focus(); }, [preview]);
  useEffect(() => {
    setFieldMap(Object.fromEntries((target?.fields ?? []).map((field) => [field.name, sourceNames.includes(field.name) ? field.name : null])));
    setTemplateMap(Object.fromEntries((target?.templates ?? []).map((template) => {
      const matches = source?.templates.filter((prior) => prior.name === template.name) ?? [];
      return [template.id!, matches.length === 1 ? matches[0].id! : null];
    })));
    setPreview(null); setError(null);
  }, [target?.id, target?.updatedAt, source?.id, source?.updatedAt, sourceNames.join('\u0000')]);
  const compatible = Boolean(source && target && (source.kind === target.kind || ['basic', 'custom'].includes(source.kind) && ['basic', 'custom'].includes(target.kind)) &&
    (source.kind !== 'typein' || fieldMap[typedAnswerField(target.fields)?.name ?? ''] === typedAnswerField(source.fields)?.name));
  const errorText = (code: string) => t(code === 'conversion_field_collision' ? 'noteTypes.convert.collision'
    : code === 'duplicate_template_mapping' ? 'noteTypes.convert.duplicateTemplates'
    : code === 'conversion_too_many_cards' || code === 'conversion_too_many_fields' ? 'noteTypes.convert.tooLarge'
    : code === 'preview_changed' || code === 'conversion_source_changed' || code === 'note_type_changed' ? 'noteTypes.convert.changed'
    : code === 'conversion_invalid_notes' || code === 'invalid_field_mapping' || code === 'invalid_template_mapping' || code === 'incompatible_card_mapping' ? 'noteTypes.convert.invalid'
    : 'noteTypes.errors.saveFailed');
  const run = async (apply: boolean) => {
    if (lock.current || !eligible || !source || !target) return;
    lock.current = true; setBusy(true); setError(null); setNeedsReload(false);
    try {
      if (apply && preview) {
        const result = await convert({ ...preview.input, confirmationToken: preview.result.confirmationToken });
        if (alive.current) onConverted(result);
      } else {
        const input: NoteConversionInput = { ...(newCardsDeckId ? { newCardsDeckId } : {}), noteIds, sourceTypeId: source.id, targetTypeId: target.id,
          sourceVersion: source.updatedAt!, targetVersion: target.updatedAt!, fieldMap,
          templateMap: compatible ? templateMap : Object.fromEntries(target.templates.map((template) => [template.id!, null])), preserveUnmappedFields: preserve };
        const result = await ok(await (api as any).notes.convert.preview.post(input)) as NoteConversionPreview;
        if (alive.current && input.newCardsDeckId && result.newCardsDeckId !== input.newCardsDeckId) { setError(t('noteTypes.convert.deckUnsupported')); return; }
        if (alive.current) setPreview({ input, result });
      }
    } catch (error) {
      if (error instanceof ApiError && error.safeMessage === 'note_type_changed') { try { await useNN.getState().getNoteTypes(); } catch { /* keep the error and mapping if refreshing is unavailable */ } }
      if (alive.current) {
        const checkState = (apply && (!(error instanceof ApiError) || error.status >= 500)) || (error instanceof ApiError && (error.safeMessage === 'conversion_source_changed' || error.status === 404));
        setNeedsReload(checkState); setError(checkState ? t('noteTypes.convert.checkState') : errorText(error instanceof ApiError ? error.safeMessage : ''));
        if (apply) setPreview(null);
      } }
    finally { lock.current = false; if (alive.current) setBusy(false); }
  };
  return createPortal(<LayerParent.Provider value={layer.id}><div onClick={(event) => { event.stopPropagation(); if (event.target === event.currentTarget && !busy) void layer.close('outside'); }}
    className="reomi-overlay-backdrop reomi-conversion-backdrop">
    <div ref={root} role="dialog" aria-modal="true" aria-labelledby="note-conversion-title" tabIndex={-1}
      onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Escape' && !busy) { event.preventDefault(); void layer.close('escape'); } }}
      className="reomi-flow-dialog reomi-conversion-dialog">
      <header><div><small>{t(preview ? 'noteTypes.convert.stepReview' : 'noteTypes.convert.stepMapping')}</small><h2 id="note-conversion-title">{t('noteTypes.convert.title')}</h2></div><NNBtn onClick={() => void layer.close()} disabled={busy} variant="ghost" icon="x" ariaLabel={t('actions.cancel')} /></header>
      <p className="reomi-flow-intro">{t('noteTypes.convert.scope', { n: noteIds.length, source: typeLabel(source) })}</p>
      {!eligible ? <p role="alert">{t(noteIds.length > 200 ? 'noteTypes.convert.tooLarge' : 'noteTypes.convert.oneType')}</p> : !preview ? <fieldset disabled={busy} style={{ border: 0, padding: 0, display: 'grid', gap: 14 }}>
        <label>{t('noteTypes.convert.target')}<select ref={targetSelect} aria-label={t('noteTypes.convert.target')} style={selectStyle} value={targetId} onChange={(event) => setTargetId(event.target.value)}>
          <option value="">{t('noteTypes.convert.choose')}</option>{types.filter((type) => type.id !== source?.id).map((type) => <option key={type.id} value={type.id}>{typeLabel(type)}</option>)}
        </select></label>
        {target && <>
          <h3>{t('noteTypes.convert.fields')}</h3>
          {target.fields.map((field) => <label key={field.id}>{field.name}<select aria-label={t('noteTypes.convert.fieldLabel', { field: field.name })} style={selectStyle} value={fieldMap[field.name] ?? ''}
            onChange={(event) => setFieldMap((current) => ({ ...current, [field.name]: event.target.value || null }))}>
            <option value="">{t('noteTypes.convert.empty')}</option>{sourceNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </select></label>)}
          <label><input type="checkbox" checked={preserve} onChange={(event) => setPreserve(event.target.checked)} /> {t('noteTypes.convert.preserve')}</label>
          <h3>{t('noteTypes.convert.cards')}</h3>
          <p>{t(compatible ? 'noteTypes.convert.mappingHint' : 'noteTypes.convert.reset')}</p>
          {target.templates.map((template) => <label key={template.id}>{templateLabel(template, target.templates)}<select aria-label={t('noteTypes.convert.templateLabel', { template: templateLabel(template, target.templates) })} style={selectStyle}
            disabled={!compatible} value={compatible ? templateMap[template.id!] ?? '' : ''} onChange={(event) => setTemplateMap((current) => ({ ...current, [template.id!]: event.target.value || null }))}>
            <option value="">{t('noteTypes.convert.newCard')}</option>{source?.templates.map((prior) => <option key={prior.id} value={prior.id}>{templateLabel(prior, source.templates)}</option>)}
          </select></label>)}
          <label>{t('noteTypes.convert.newDeck')}<select aria-label={t('noteTypes.convert.newDeck')} style={selectStyle} value={newCardsDeckId} onChange={(event) => setNewCardsDeckId(event.target.value)}>
            <option value="">{t('noteTypes.convert.inheritDeck')}</option>{decks.map((deck) => <option key={deck.id} value={deck.id}>{deckPathLabel(decks, deck.id)}</option>)}
          </select><small>{t('noteTypes.convert.deckHint')}</small></label>
          <NNBtn variant="primary" onClick={() => run(false)}>{busy ? t('states.loading') : t('noteTypes.kind.preview')}</NNBtn>
        </>}
      </fieldset> : <>
        <h3 ref={previewHeading} tabIndex={-1}>{typeLabel(source)} → {typeLabel(target)}</h3>
        <p>{t('noteTypes.impact.counts', { create: preview.result.impact.willCreateCards, keep: preview.result.impact.willKeepCards, remove: preview.result.impact.willDeleteCards, reviews: preview.result.impact.willDeleteReviews })}</p>
        {preview.result.impact.willCreateCards > 0 && <p>{t('noteTypes.convert.newDeck')}: {preview.result.newCardsDeckId ? deckPathLabel(decks, preview.result.newCardsDeckId) : t('noteTypes.convert.inheritDeck')}</p>}
        {Boolean(preview.result.cardMapping?.length) && <><h3>{t('noteTypes.convert.cards')}</h3><ul>{preview.result.cardMapping!.map((mapping) => <li key={mapping.target.ord}>
          {mapping.source ? templateLabel(mapping.source, source?.templates ?? []) : t('noteTypes.convert.newCard')} → {templateLabel(mapping.target, target?.templates ?? [])}
        </li>)}</ul></>}
        {preview.result.impact.removedCards.length > 0 && <><p>{t('noteTypes.impact.removed')}</p><ul>{preview.result.impact.removedCards.map((card) => <li key={card.id}>{card.front || t('noteTypes.validation.media')} ({card.reviews})</li>)}</ul></>}
        <h3>{t('noteTypes.convert.fields')}</h3>
        <ul>{preview.result.fieldMapping.map((field) => <li key={field.target}>{field.source ?? t('noteTypes.convert.empty')} → {field.target}</li>)}</ul>
        {preview.result.discardedAlternatives > 0 && <p>{t('noteTypes.convert.alternatives', { n: preview.result.discardedAlternatives })}</p>}
        <p>{t('noteTypes.convert.unmapped', { n: preview.result.unmappedFieldCount, lost: preview.result.discardedValues })}</p>
        <ul>{preview.result.unmappedFields.map((field) => <li key={field.field}>{field.field}: {t(field.action === 'preserve' ? 'noteTypes.convert.kept' : 'noteTypes.convert.discarded')} ({field.nonemptyNotes}) {field.example && <code>{field.example}</code>}</li>)}</ul>
        {preview.result.unmappedFieldCount > 50 && <p>{t('noteTypes.convert.truncated')}</p>}
        {Boolean(preview.result.validation?.invalidNotes) && <p role="alert" style={{ color: 'var(--rose-400)' }}>{t('noteTypes.validation.blocked', { n: preview.result.validation!.invalidNotes })}</p>}
        <p>{t('noteTypes.convert.samples')}</p>
        <ul>{preview.result.validation?.samples.map((sample, index) => <li key={index}>{sample.front || '—'} → {sample.error ? t(sample.error === 'conversion_deck_required' ? 'noteTypes.convert.deckRequired' : sample.error === 'typein_answer_placement' ? 'editor.errors.typeinPlacement' : 'noteTypes.validation.invalid') : sample.questions.map((question, index) => `${question || t('noteTypes.validation.media')}${sample.answers?.[index] ? ` — ${sample.answers[index]}` : ''}`).join(' / ')}</li>)}</ul>
        <div style={{ display: 'flex', gap: 12 }}><NNBtn disabled={busy} onClick={() => setPreview(null)}>{t('noteTypes.convert.back')}</NNBtn>
          <NNBtn disabled={busy || Boolean(preview.result.validation?.invalidNotes)} variant={preview.result.impact.willDeleteCards || preview.result.discardedValues || preview.result.discardedAlternatives ? 'danger' : 'primary'} onClick={() => run(true)}>{busy ? t('noteTypes.actions.saving') : t('noteTypes.convert.apply', { n: preview.result.noteCount })}</NNBtn></div>
      </>}
      {needsReload && <NNBtn disabled={busy} onClick={() => window.location.reload()}>{t('noteTypes.convert.reload')}</NNBtn>}
      {error && <p role="alert" style={{ color: 'var(--rose-400)' }}>{error}</p>}
    </div>
  </div></LayerParent.Provider>, document.body);
}
