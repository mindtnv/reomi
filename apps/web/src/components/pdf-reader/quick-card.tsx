'use client';

import { Button } from '@/components/design-system/primitives';


// M5 — QuickCardDialog: selection → flashcard.
// Opened from the selection popover («В карточку») or a mark's edit popover.
// Deck picker uses the same NNSelect + buildDeckTree/flattenTree/deckPathLabel
// pattern as card-form.tsx; last-used deck persisted to localStorage.
//
// M5-T3 polish: backdrop blur, clear header/body/footer hierarchy, lime CTA,
// ⌘Enter hint in the footer.

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { isCooldownError, useNN } from '@/lib/store';
import { buildDeckTree, deckPathLabel, flattenTree } from '@/lib/decks';
import { NNSelect, type NNSelectOption } from '@/components/nn-select';
import { quickCard, suggestCard } from '@/lib/pdf-annotations';
import { raiseToast } from '@/components/toasts';
import type { Deck, QuickCardResult } from '@/lib/types';
import type { MarkRect, SourceTextSelection } from '@reomi/shared';
import { LayerParent, useTransientLayer } from '@/lib/use-transient-layer';
import { useModalFocus } from '@/lib/use-modal-focus';
import { useNavigationGuard } from '@/components/navigation';
import { useDialog } from '@/components/dialog';
import { InlineDeckCreate } from '../inline-deck-create';
import { readBrowserValue, writeBrowserValue } from '@/lib/storage-migration';

const DECK_KEY = 'nn:nb:quickdeck';

type T = (key: string, params?: Record<string, string | number>) => string;

export interface QuickCardDialogProps {
  open: boolean;
  onClose: () => void;
  sourceId: string;
  sourceName: string;
  sourceVersion?: string;
  page?: number;
  quote?: string;
  textSelection?: SourceTextSelection;
  prefillFront?: string;
  prefillBack?: string;
  /** W4: marquee/selection rects so the server can plant a card marker. */
  rects?: MarkRect[];
  /** Locale (e.g. 'en'|'ru') — passed to suggest-card so AI writes in the user's language. */
  locale?: string;
  onCreated: (result: QuickCardResult, firstCardId: string) => void;
  chatEnabled: boolean;
  t: T;
}

export function QuickCardDialog({
  open,
  onClose,
  sourceId,
  sourceName,
  sourceVersion,
  page,
  quote,
  textSelection,
  prefillFront,
  prefillBack,
  rects,
  locale,
  onCreated,
  chatEnabled,
  t,
}: QuickCardDialogProps) {
  const decks = useNN((s) => s.decks);
  const { select } = useDialog();
  const dialogRoot = useRef<HTMLDivElement>(null), submitLock = useRef(false);
  useModalFocus(dialogRoot, open);

  const [deckId, setDeckId] = useState<string>('');
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState(false);

  const frontRef = useRef<HTMLTextAreaElement>(null);

  const deckOptions = useMemo<NNSelectOption<string>[]>(
    () =>
      flattenTree(buildDeckTree(decks), new Set(decks.map((d: Deck) => d.id))).map((node) => ({
        value: node.deck.id,
        label: node.deck.name,
        depth: node.depth,
        searchText: deckPathLabel(decks, node.deck.id),
      })),
    [decks],
  );

  useEffect(() => {
    if (!open) return;
    setFront(prefillFront ?? '');
    setBack(prefillBack ?? quote ?? '');
    setSuggestError(false);
    setSubmitError(false);
    try {
      const saved = readBrowserValue(localStorage, DECK_KEY);
      if (saved && decks.some((d: Deck) => d.id === saved)) {
        setDeckId(saved);
      } else if (decks.length > 0) {
        setDeckId(decks[0]!.id);
      } else {
        setDeckId('');
      }
    } catch {
      if (decks.length > 0) setDeckId(decks[0]!.id);
    }
    requestAnimationFrame(() => frontRef.current?.focus());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleDeckChange = useCallback((id: string) => {
    setDeckId(id);
    try { writeBrowserValue(localStorage, DECK_KEY, id); } catch { /* ignore */ }
  }, []);

  const handleFormulate = useCallback(async () => {
    if (!quote || suggesting) return;
    setSuggesting(true);
    setSuggestError(false);
    try {
      const r = await suggestCard(sourceId, { quote, page, locale });
      setFront(r.front);
      setBack(r.back);
    } catch (err) {
      // 429 cooldown is NOT a failure — it's "you just asked, wait a moment".
      if (isCooldownError(err)) {
        raiseToast({ kind: 'info', title: t('notebooks.quickcard.cooldown') });
      } else {
        setSuggestError(true);
      }
    } finally {
      setSuggesting(false);
    }
  }, [sourceId, quote, page, locale, suggesting, t]);

  const handleSubmit = useCallback(async () => {
    if (!deckId || submitLock.current || !front.trim()) return false;
    submitLock.current = true; setSubmitting(true);
    setSubmitError(false);
    try {
      const result = await quickCard(sourceId, {
        deckId,
        front: front.trim(),
        back: back.trim(),
        page,
        quote,
        textSelection,
        ...(sourceVersion && page ? { pdfSelection: { version: 1, sourceVersion, page, quote: quote ?? '' } } : {}),
        rects,
      });
      const firstCardId = result.cardIds[0] ?? '';
      onCreated(result, firstCardId);
      onClose(); return true;
    } catch {
      // Leave dialog open + surface an inline failure line so the user can retry.
      setSubmitError(true); return false;
    } finally {
      submitLock.current = false; setSubmitting(false);
    }
  }, [sourceId, sourceVersion, deckId, front, back, page, quote, textSelection, rects, submitting, onCreated, onClose]);

  const layer = useTransientLayer({ root: dialogRoot, enabled: open, modal: true, busy: submitting || suggesting, onClose });
  useNavigationGuard(async () => {
    if (submitLock.current || suggesting) return false;
    if (front === (prefillFront ?? '') && back === (prefillBack ?? quote ?? '')) return true;
    const choice = await select({ title: t('editor.draft.leaveTitle'), value: 'discard',
      options: [...(deckId && front.trim() ? [{ value: 'save', label: t('editor.draft.saveAndLeave') }] : []), { value: 'discard', label: t('editor.draft.discardAndLeave') }], cancelLabel: t('editor.draft.stay') });
    return choice === 'discard' || choice === 'save' && await handleSubmit();
  }, open ? layer.id : false);

  const onKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation();
    if ((e.key === 'Enter' && (e.metaKey || e.ctrlKey)) && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void handleSubmit();
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      void layer.close('escape');
    }
  }, [handleSubmit, layer.close]);

  if (!open) return null;

  const canSubmit = !!deckId && !!front.trim() && !submitting;

  return (
    // Backdrop with blur
    <LayerParent.Provider value={layer.id}><div
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget) void layer.close('outside'); }}
      className="nn-dialog-backdrop"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1200,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        background: 'var(--scrim)',
      }}
    >
      {/* Dialog box */}
      <div ref={dialogRoot} role="dialog" aria-modal="true" aria-label={t('notebooks.quickcard.title')} tabIndex={-1}
        onKeyDown={onKeyDown}
        style={{
          width: '100%',
          maxWidth: 480,
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-xl)',
          boxShadow: 'var(--shadow-lg)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '14px 18px 12px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <span
            style={{
              fontSize: 15,
              fontWeight: 700,
              color: 'var(--text)',
              fontFamily: 'var(--font-sans)',
              letterSpacing: '-0.01em',
            }}
          >
            {t('notebooks.quickcard.title')}
          </span>
          <Button variant="bare"
            type="button"
            onClick={() => void layer.close()}
            aria-label="Close"
            style={{
              width: 30,
              height: 30,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 'var(--r-md)',
              border: 'none',
              background: 'transparent',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: 16,
              lineHeight: 1,
            }}
          >
            ×
          </Button>
        </div>

        {/* Body */}
        <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Deck picker */}
          <div>
            <label
              style={{
                display: 'block',
                fontSize: 10.5,
                fontWeight: 700,
                color: 'var(--text-dim)',
                marginBottom: 5,
                textTransform: 'uppercase',
                letterSpacing: '0.07em',
              }}
            >
              {t('notebooks.quickcard.deckLabel')}
            </label>
            <NNSelect<string>
              value={deckId}
              onChange={handleDeckChange}
              options={deckOptions}
              placeholder={t('notebooks.quickcard.deckPlaceholder')}
            />
            <InlineDeckCreate onCreated={handleDeckChange} disabled={submitting} />
          </div>

          {/* Front */}
          <div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 5,
              }}
            >
              <label
                style={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  color: 'var(--text-dim)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.07em',
                }}
              >
                {t('notebooks.quickcard.frontLabel')}
              </label>
              {chatEnabled && quote && (
                <Button variant="bare"
                  type="button"
                  onClick={() => void handleFormulate()}
                  disabled={suggesting}
                  title={t('notebooks.quickcard.formulateHint')}
                  style={{
                    height: 26,
                    padding: '0 9px',
                    borderRadius: 'var(--r-sm)',
                    border: '1px solid var(--lime-500)',
                    background: suggesting
                      ? 'var(--surface-2)'
                      : 'color-mix(in srgb, var(--lime-500) 12%, var(--surface))',
                    color: suggesting ? 'var(--text-dim)' : 'var(--lime-400)',
                    cursor: suggesting ? 'default' : 'pointer',
                    fontSize: 12,
                    fontWeight: 600,
                    fontFamily: 'var(--font-sans)',
                    opacity: suggesting ? 0.6 : 1,
                    transition: 'opacity 100ms',
                  }}
                >
                  {suggesting ? '…' : t('notebooks.quickcard.formulateBtn')}
                </Button>
              )}
            </div>
            {suggestError && (
              <p style={{ margin: '0 0 5px', fontSize: 11.5, color: 'var(--rose-400)' }}>
                {t('notebooks.quickcard.formulateError')}
              </p>
            )}
            <textarea
              ref={frontRef}
              aria-label={t('notebooks.quickcard.frontLabel')}
              disabled={submitting || suggesting}
              value={front}
              onChange={(e) => setFront(e.target.value)}
              placeholder={t('notebooks.quickcard.frontPlaceholder')}
              rows={2}
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 'var(--r-md)',
                border: '1px solid var(--border)',
                background: 'var(--surface-2)',
                color: 'var(--text)',
                fontSize: 13,
                fontFamily: 'var(--font-sans)',
                resize: 'vertical',
                lineHeight: 1.5,
                boxSizing: 'border-box',
                outline: 'none',
                transition: 'border-color 100ms',
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--lime-500)')}
              onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
            />
          </div>

          {/* Back */}
          <div>
            <label
              style={{
                display: 'block',
                fontSize: 10.5,
                fontWeight: 700,
                color: 'var(--text-dim)',
                marginBottom: 5,
                textTransform: 'uppercase',
                letterSpacing: '0.07em',
              }}
            >
              {t('notebooks.quickcard.backLabel')}
            </label>
            <textarea
              aria-label={t('notebooks.quickcard.backLabel')}
              disabled={submitting || suggesting}
              value={back}
              onChange={(e) => setBack(e.target.value)}
              placeholder={t('notebooks.quickcard.backPlaceholder')}
              rows={3}
              style={{
                width: '100%',
                padding: '8px 10px',
                borderRadius: 'var(--r-md)',
                border: '1px solid var(--border)',
                background: 'var(--surface-2)',
                color: 'var(--text)',
                fontSize: 13,
                fontFamily: 'var(--font-sans)',
                resize: 'vertical',
                lineHeight: 1.5,
                boxSizing: 'border-box',
                outline: 'none',
                transition: 'border-color 100ms',
              }}
              onFocus={(e) => (e.currentTarget.style.borderColor = 'var(--lime-500)')}
              onBlur={(e) => (e.currentTarget.style.borderColor = 'var(--border)')}
            />
          </div>
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 18px 12px',
            borderTop: '1px solid var(--border)',
            gap: 10,
            background: 'var(--surface-2)',
          }}
        >
          {/* Provenance hint — replaced by an inline failure line on a create error. */}
          <span
            style={{
              fontSize: 11,
              color: submitError ? 'var(--rose-400)' : 'var(--text-dim)',
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {submitError
              ? t('notebooks.quickcard.createError')
              : page != null
                ? t('notebooks.quickcard.source', { n: page, title: sourceName })
                : sourceName}
          </span>
          {/* ⌘Enter hint */}
          <span style={{ fontSize: 10.5, color: 'var(--text-dim)', flexShrink: 0, fontFamily: 'var(--font-mono)' }}>
            ⌘↵
          </span>
          {/* Submit CTA */}
          <Button variant="bare"
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            style={{
              height: 36,
              padding: '0 16px',
              borderRadius: 'var(--r-md)',
              border: 'none',
              background: canSubmit ? 'var(--lime-500)' : 'var(--surface-3)',
              color: canSubmit ? 'var(--text-on-accent)' : 'var(--text-dim)',
              cursor: canSubmit ? 'pointer' : 'default',
              fontSize: 13,
              fontWeight: 700,
              fontFamily: 'var(--font-sans)',
              flexShrink: 0,
              transition: 'background 100ms, color 100ms',
            }}
          >
            {submitting ? t('notebooks.quickcard.creating') : t('notebooks.quickcard.createBtn')}
          </Button>
        </div>
      </div>
    </div></LayerParent.Provider>
  );
}
