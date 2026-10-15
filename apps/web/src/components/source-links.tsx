'use client';

// "Sources" backlink panel — the source passages a card was generated from
// (NotebookLM M3), fed by GET /cards/:id/sources. Mounted in the cards-browser
// edit dock and the reviewer drawer, next to SimilarCardsPanel. Renders NOTHING
// when the card has no provenance (don't clutter hand-authored cards). Plain-text
// snippets only — never raw HTML. Reads are account-scoped and revalidated.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAppNavigation } from '@/components/navigation';
import type { CardSourceLink } from '@/lib/types';
import { NNBadge, NNIcon } from '@/components/ui';
import { assistantApi, ok } from '@/lib/api';
import { useT } from '@/lib/i18n';
import { cardSourceHref, followCardSourceHref } from '@/lib/card-source-link';
import { useNN } from '@/lib/store';

interface SourceLinksState {
  items: CardSourceLink[];
  loading: boolean;
  reload(): Promise<CardSourceLink[]>;
}

export function useCardSources(cardId: string | null): SourceLinksState {
  const ownerId = useNN(state => state.profile?.userId);
  const key = `${ownerId ?? ''}:${cardId ?? ''}`;
  const generation = useRef(0);
  const [state, setState] = useState<{ key: string; items: CardSourceLink[]; loading: boolean }>({ key, items: [], loading: false });
  const reload = useCallback(async () => {
    const current = ++generation.current;
    if (!cardId || !ownerId) { setState({ key, items: [], loading: false }); return []; }
    setState(previous => ({ key, items: previous.key === key ? previous.items : [], loading: true }));
    try {
      const body = await ok(await assistantApi.cards({ id: cardId }).sources.get());
      if (current !== generation.current || useNN.getState().profile?.userId !== ownerId) return [];
      const items: CardSourceLink[] = body.items.map(item => ({ ...item, cardId, createdAt: item.createdAt ? new Date(item.createdAt).toISOString() : '' }));
      setState({ key, items, loading: false }); return items;
    } catch {
      if (current === generation.current) setState(previous => ({ ...previous, loading: false }));
      return [];
    }
  }, [cardId, ownerId, key]);
  useEffect(() => {
    void reload(); const refresh = () => { void reload(); };
    window.addEventListener('nn:knowledge-changed', refresh);
    return () => { generation.current++; window.removeEventListener('nn:knowledge-changed', refresh); };
  }, [reload]);
  return { items: state.key === key ? state.items : [], loading: state.key === key ? state.loading : Boolean(cardId), reload };
}

/**
 * Provenance list for a card: each row is a cited source passage (title + page +
 * 2-line snippet). Clicking a non-tombstone row jumps to the full library reader
 * (`/library/<sourceId>`) scrolled to that chunk/page (L2 — no notebook needed).
 * Tombstone rows (source deleted ⇒ NULL refs) render muted + inert. Renders null
 * when the card has no provenance.
 */
export const SourceLinksPanel = ({ cardId }: { cardId: string }) => {
  const t = useT();
  const router = useAppNavigation();
  const { items, reload } = useCardSources(cardId);

  if (items.length === 0) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div
        style={{
          fontSize: 11,
          color: 'var(--text-dim)',
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          marginBottom: 2,
        }}
      >
        {t('notebooks.backlinks.title')}
      </div>
      {items.map((item) => {
        // L2 — a row is a tombstone ONLY when the SOURCE itself is gone (NULL
        // sourceId). A NULL notebookId no longer implies deletion (the notebook a
        // card was born in can be deleted while the source lives on in the library).
        const tombstone = !item.sourceId;
        const open = async () => {
          if (tombstone) return;
          const location = window.location.href;
          const fresh = (await reload()).find(link => link.id === item.id);
          if (!fresh?.sourceId || window.location.href !== location) return;
          const href=cardSourceHref(fresh);if(href)followCardSourceHref(href,(path)=>router.push(path));
        };
        return (
          <button
            key={item.id}
            type="button"
            disabled={tombstone}
            onClick={open}
            title={tombstone ? undefined : t('notebooks.backlinks.open')}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              padding: '8px 10px',
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r-md)',
              cursor: tombstone ? 'default' : 'pointer',
              textAlign: 'left',
              width: '100%',
              opacity: tombstone ? 0.6 : 1,
            }}
          >
            {tombstone ? (
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <NNIcon name="doc" size={12} color="var(--text-dim)" />
                <span style={{ fontSize: 12, color: 'var(--text-dim)', fontStyle: 'italic' }}>
                  {item.sourceTitle ? `${item.sourceTitle} · ` : ''}{t('notebooks.backlinks.tombstone')}
                </span>
              </span>
            ) : (
              <>
                <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <NNIcon name="doc" size={12} color="var(--sky-400)" />
                  <span
                    style={{
                      fontSize: 12.5,
                      fontWeight: 600,
                      color: 'var(--text)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      minWidth: 0,
                      flex: 1,
                    }}
                  >
                    {item.sourceTitle ?? t('notebooks.backlinks.untitled')}
                  </span>
                  {item.page != null && (
                    <NNBadge tone="sky" size="xs">
                      {t('notebooks.backlinks.page', { n: item.page })}
                    </NNBadge>
                  )}
                </span>
                {item.snippet && (
                  <span
                    style={{
                      fontSize: 12,
                      lineHeight: 1.45,
                      color: 'var(--text-muted)',
                      overflow: 'hidden',
                      display: '-webkit-box',
                      WebkitLineClamp: 2,
                      WebkitBoxOrient: 'vertical',
                      wordBreak: 'break-word',
                    }}
                  >
                    {item.snippet}
                  </span>
                )}
              </>
            )}
            {Boolean(item.sourceSnapshot?.quote) && (item.sourceSnapshot?.kind === 'user_quote' || item.sourceSnapshot?.kind === 'user_selection') && <small>{t('chat.confirm.userQuoteEvidence')}</small>}
            {tombstone && item.snippet && <span style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{item.snippet}</span>}
            {!tombstone && item.locationAvailable === false && <small>{t('assistant.anchorUnavailable')}</small>}
          </button>
        );
      })}
    </div>
  );
};
