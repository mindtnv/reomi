'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppNavigation } from '@/components/navigation';
import { parseCardQuery, CardQueryError } from '@reomi/shared';
import { NNBtn, NNBadge, NNIcon, NNPageSkeleton } from '@/components/ui';
import { useNN } from '@/lib/store';
import { useT } from '@/lib/i18n';
import { useDialog } from '@/components/dialog';
import { NNSelect, type NNSelectOption } from '@/components/nn-select';
import { useBreakpoint } from '@/lib/use-breakpoint';
import type { FilteredDeck, FilteredDeckSortOrder } from '@/lib/types';

// ─────────────────────────────────────────────
// Quick-action definitions (canonical presets per plan Decision 5 / Phase 8)
// ─────────────────────────────────────────────

interface QuickAction {
  nameKey: string;
  descKey: string;
  query: string;
  sortOrder: FilteredDeckSortOrder;
  icon: string;
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    nameKey: 'review.customStudy.quickActions.cram',
    descKey: 'review.customStudy.quickActions.cramDesc',
    query: '',
    sortOrder: 'cram',
    icon: 'bolt',
  },
  {
    nameKey: 'review.customStudy.quickActions.lapsed',
    descKey: 'review.customStudy.quickActions.lapsedDesc',
    query: 'prop:lapses>0',
    sortOrder: 'difficultyDesc',
    icon: 'flame',
  },
  {
    nameKey: 'review.customStudy.quickActions.hardFirst',
    descKey: 'review.customStudy.quickActions.hardFirstDesc',
    query: 'is:due',
    sortOrder: 'difficultyDesc',
    icon: 'target',
  },
];

const SORT_ORDER_VALUES: FilteredDeckSortOrder[] = [
  'due',
  'added',
  'random',
  'difficultyDesc',
  'overdue',
  'lapses',
  'cram',
];

function validateQuery(q: string): string | null {
  if (!q.trim()) return null; // empty query is valid (matches all cards)
  try {
    parseCardQuery(q);
    return null;
  } catch (err) {
    if (err instanceof CardQueryError) return err.message;
    return String(err);
  }
}

// ─────────────────────────────────────────────
// Inline form (create / edit)
// ─────────────────────────────────────────────

interface FormState {
  name: string;
  query: string;
  sortOrder: FilteredDeckSortOrder;
  cardLimit: number;
}

interface FilteredDeckFormProps {
  initial?: Partial<FormState> & { id?: string };
  onClose: () => void;
  onSaved: (id: string) => void;
}

const FilteredDeckForm = ({ initial, onClose, onSaved }: FilteredDeckFormProps) => {
  const t = useT();
  const addFilteredDeck = useNN((s) => s.addFilteredDeck);
  const updateFilteredDeck = useNN((s) => s.updateFilteredDeck);

  const [name, setName] = useState(initial?.name ?? '');
  const [query, setQuery] = useState(initial?.query ?? '');
  const [sortOrder, setSortOrder] = useState<FilteredDeckSortOrder>(initial?.sortOrder ?? 'due');
  const [cardLimit, setCardLimit] = useState(String(initial?.cardLimit ?? 50));
  const saveLock = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);

  const isEdit = !!initial?.id;

  const sortOrderOptions = useMemo<NNSelectOption<FilteredDeckSortOrder>[]>(
    () =>
      SORT_ORDER_VALUES.map((val) => ({
        value: val,
        label: t(`review.customStudy.sortOrders.${val}`),
      })),
    [t],
  );

  const handleSave = useCallback(async () => {
    if (saveLock.current) return;
    setSaveError(null);
    const qErr = validateQuery(query);
    if (qErr) {
      setQueryError(qErr);
      return;
    }
    setQueryError(null);
    if (!name.trim()) return;
    const limit = Number(cardLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) { setSaveError(t('review.customStudy.invalidLimit')); return; }
    saveLock.current = true;
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        query: query.trim(),
        sortOrder,
        cardLimit: limit,
        includeSuspended: false,
      };
      if (isEdit && initial?.id) {
        const updated = await updateFilteredDeck(initial.id, payload);
        if (alive.current) onSaved(updated.id);
      } else {
        const created = await addFilteredDeck(payload);
        if (alive.current) onSaved(created.id);
      }
    } catch {
      if (alive.current) setSaveError(t('review.customStudy.saveError'));
    } finally {
      saveLock.current = false;
      if (alive.current) setSaving(false);
    }
  }, [
    name, query, sortOrder, cardLimit,
    isEdit, initial, addFilteredDeck, updateFilteredDeck, onSaved, t,
  ]);

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px 12px',
    fontSize: 14,
    fontFamily: 'var(--font-sans)',
    borderRadius: 8,
    border: '1px solid var(--border-2)',
    background: 'var(--surface-2)',
    color: 'var(--text)',
    outline: 'none',
    boxSizing: 'border-box',
  };

  const labelStyle: React.CSSProperties = {
    fontSize: 12,
    color: 'var(--text-muted)',
    marginBottom: 4,
    display: 'block',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Name */}
      <div>
        <label style={labelStyle}>{t('review.customStudy.fieldName')}</label>
        <input
          style={inputStyle}
          aria-label={t('review.customStudy.fieldName')}
          maxLength={100}
          disabled={saving}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('review.customStudy.fieldNamePlaceholder')}
          autoFocus
        />
      </div>

      {/* Query */}
      <div>
        <label style={labelStyle}>{t('review.customStudy.fieldQuery')}</label>
        <input
          style={{
            ...inputStyle,
            borderColor: queryError ? 'var(--rose-500)' : 'var(--border-2)',
          }}
          aria-label={t('review.customStudy.fieldQuery')}
          disabled={saving}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setQueryError(null);
          }}
          placeholder={t('review.customStudy.fieldQueryPlaceholder')}
        />
        {queryError ? (
          <span style={{ fontSize: 11.5, color: 'var(--rose-500)', marginTop: 3, display: 'block' }}>
            {t('review.customStudy.queryError', { error: queryError })}
          </span>
        ) : (
          <span style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 3, display: 'block' }}>
            {t('review.customStudy.fieldQueryHint')}
          </span>
        )}
      </div>

      {/* Sort order */}
      <div>
        <label style={labelStyle}>{t('review.customStudy.fieldSortOrder')}</label>
        <NNSelect<FilteredDeckSortOrder>
          disabled={saving}
          value={sortOrder}
          onChange={setSortOrder}
          options={sortOrderOptions}
          ariaLabel={t('review.customStudy.fieldSortOrder')}
        />
      </div>

      {/* Card limit */}
      <div>
        <label style={labelStyle}>{t('review.customStudy.fieldCardLimit')}</label>
        <input
          style={inputStyle}
          type="number"
          min={1}
          max={1000}
          aria-label={t('review.customStudy.fieldCardLimit')}
          disabled={saving}
          value={cardLimit}
          onChange={(e) => setCardLimit(e.target.value)}
        />
      </div>

      {saveError && (
        <span role="alert" style={{ fontSize: 12, color: 'var(--rose-500)' }}>{saveError}</span>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
        <NNBtn size="md" variant="ghost" disabled={saving} onClick={onClose}>
          {t('review.customStudy.actions.cancel')}
        </NNBtn>
        <NNBtn
          size="md"
          variant="primary"
          onClick={handleSave}
          disabled={saving || !name.trim()}
        >
          {saving ? '…' : (isEdit ? t('review.customStudy.actions.save') : t('review.customStudy.actions.create'))}
        </NNBtn>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────
// Main Custom Study screen
// ─────────────────────────────────────────────

export const NNCustomStudy = () => {
  const t = useT();
  const { confirm } = useDialog();
  const router = useAppNavigation();
  const bp = useBreakpoint();
  const isMobile = bp === 'mobile';

  const bootstrapped = useNN((s) => s.bootstrapped);
  const quickLock = useRef(false);
  const deleteLock = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [quickBusy, setQuickBusy] = useState<string | null>(null);
  const filteredDecks = useNN((s) => s.filteredDecks);
  const addFilteredDeck = useNN((s) => s.addFilteredDeck);
  const deleteFilteredDeck = useNN((s) => s.deleteFilteredDeck);

  const [formOpen, setFormOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<FilteredDeck | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [quickActionError, setQuickActionError] = useState<string | null>(null);

  const openCreate = () => {
    setEditTarget(null);
    setFormOpen(true);
  };

  const openEdit = (fd: FilteredDeck) => {
    setEditTarget(fd);
    setFormOpen(true);
  };

  const handleSaved = useCallback(
    (id: string) => {
      setFormOpen(false);
      setEditTarget(null);
      if (!editTarget) router.push(`/review?filteredDeckId=${id}`);
    },
    [router, editTarget],
  );

  const handleStudy = useCallback(
    (id: string) => {
      router.push(`/review?filteredDeckId=${id}`);
    },
    [router],
  );

  const handleDelete = useCallback(async (fd: FilteredDeck) => {
    if (deleteLock.current) return;
    deleteLock.current = true;
    try {
      if (!(await confirm({ title: t('review.customStudy.deleteConfirm', { name: fd.name }), danger: true }))) return;
      setDeletingId(fd.id);
      setDeleteError(null);
      await deleteFilteredDeck(fd.id);
    } catch {
      if (alive.current) setDeleteError(t('review.customStudy.deleteError'));
    } finally {
      deleteLock.current = false;
      if (alive.current) setDeletingId(null);
    }
  }, [deleteFilteredDeck, t, confirm]);

  const handleQuickAction = useCallback(async (action: QuickAction) => {
    if (quickLock.current) return;
    quickLock.current = true;
    setQuickBusy(action.nameKey);
    setQuickActionError(null);
    try {
      const existing = filteredDecks.find((deck) => deck.query === action.query && deck.sortOrder === action.sortOrder && deck.cardLimit === 100);
      const selected = existing ?? await addFilteredDeck({
        name: t(action.nameKey), query: action.query, sortOrder: action.sortOrder,
        cardLimit: 100, includeSuspended: false,
      });
      if (alive.current) router.push(`/review?filteredDeckId=${selected.id}`);
    } catch {
      if (alive.current) setQuickActionError(t('review.customStudy.saveError'));
    } finally {
      quickLock.current = false;
      if (alive.current) setQuickBusy(null);
    }
  }, [filteredDecks, addFilteredDeck, router, t]);

  if (!bootstrapped) return <NNPageSkeleton />;

  return (
    <div
      style={{
        flex: 1,
        overflow: 'auto',
        padding: isMobile ? '16px 14px 32px' : '24px 32px 48px',
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
        maxWidth: 680,
        margin: '0 auto',
        width: '100%',
      }}
    >
      {/* Header */}
      <div>
        <h1 className="nn-h1" style={{ marginBottom: 4 }}>
          {t('review.customStudy.title')}
        </h1>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          {t('review.customStudy.subtitle')}
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>{t('review.customStudy.scheduleNotice')}</p>
      </div>

      {/* Quick actions */}
      <section>
        <div className="nn-section-label">{t('review.customStudy.quickActions.title')}</div>
        {quickActionError && (
          <div role="alert" style={{ fontSize: 12, color: 'var(--rose-500)', marginBottom: 8 }}>{quickActionError}</div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {QUICK_ACTIONS.map((action) => (
            <button
              key={action.nameKey}
              type="button"
              disabled={Boolean(quickBusy)}
              aria-busy={quickBusy === action.nameKey}
              onClick={() => handleQuickAction(action)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '12px 14px',
                borderRadius: 10,
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                cursor: 'pointer',
                color: 'var(--text)',
                fontFamily: 'var(--font-sans)',
                textAlign: 'left',
                transition: 'background 120ms ease',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = 'var(--surface-2)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = 'var(--surface)';
              }}
            >
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  background: 'var(--surface-3)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  color: 'var(--lime-500)',
                }}
              >
                <NNIcon name={action.icon} size={16} color="var(--lime-500)" />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.2 }}>
                  {t(quickBusy === action.nameKey ? 'review.customStudy.launching' : action.nameKey)}
                </div>
                <div role="alert" style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.3 }}>
                  {t(action.descKey)}
                </div>
              </div>
              <NNIcon name="chevr" size={14} color="var(--text-dim)" />
            </button>
          ))}
        </div>
      </section>

      {/* Saved sessions */}
      <section>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div className="nn-section-label">{t('review.customStudy.sessions')}</div>
          <NNBtn size="sm" variant="soft" icon="plus" onClick={openCreate}>
            {t('review.customStudy.createNew')}
          </NNBtn>
        </div>

        {/* Inline form */}
        {formOpen && (
          <div
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              padding: '16px 16px 12px',
              marginBottom: 10,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 12, color: 'var(--text)' }}>
              {editTarget
                ? t('review.customStudy.actions.edit')
                : t('review.customStudy.createNew')}
            </div>
            <FilteredDeckForm
              key={editTarget?.id ?? 'new'}
              initial={editTarget ?? undefined}
              onClose={() => { setFormOpen(false); setEditTarget(null); }}
              onSaved={handleSaved}
            />
          </div>
        )}

        {filteredDecks.length === 0 && !formOpen ? (
          <div
            className="nn-empty-state"
            style={{
              borderRadius: 10,
              background: 'var(--surface)',
              border: '1px solid var(--border)',
            }}
          >
            <span className="nn-empty-state-icon"><NNIcon name="filter" size={24} color="var(--text-dim)" /></span>
            <p className="nn-empty-state-hint">{t('review.customStudy.noSessions')}</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {filteredDecks.map((fd) => (
              <div
                key={fd.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 12px',
                  borderRadius: 10,
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text)', lineHeight: 1.2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {fd.name}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    {fd.query && (
                      <span className="mono" style={{ color: 'var(--text-muted)' }}>{fd.query}</span>
                    )}
                    <NNBadge size="xs" tone="neutral">
                      {t(`review.customStudy.sortOrders.${fd.sortOrder}`)}
                    </NNBadge>
                    <span>{fd.cardLimit}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  <NNBtn
                    size="sm"
                    variant="ghost"
                    onClick={() => openEdit(fd)}
                    icon="edit"
                  />
                  <NNBtn
                    size="sm"
                    variant="ghost"
                    onClick={() => handleDelete(fd)}
                    disabled={deletingId === fd.id}
                    icon="x"
                  />
                  <NNBtn
                    size="sm"
                    variant="primary"
                    onClick={() => handleStudy(fd.id)}
                    icon="play"
                  >
                    {t('review.customStudy.actions.study')}
                  </NNBtn>
                </div>
              </div>
            ))}
          </div>
        )}

        {deleteError && (
          <div role="alert" style={{ fontSize: 12, color: 'var(--rose-500)', marginTop: 6 }}>{deleteError}</div>
        )}
      </section>
    </div>
  );
};
