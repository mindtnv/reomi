'use client';

import { Button } from '@/components/design-system/primitives';


// "Similar cards" panel — semantic neighbours of one card, fed by
// GET /cards/:id/similar (stored-vector lookup, no runtime embedding call).
// Used in the cards-browser edit dock and the reviewer drawer. Plain-text
// snippets only — RichCard stays the sole card-HTML sink.

import React, { useEffect, useMemo, useState } from 'react';
import { NNBadge, NNIcon } from '@/components/ui';
import { api, ok } from '@/lib/api';
import { useNN } from '@/lib/store';
import { useT } from '@/lib/i18n';

export interface SimilarItem {
  cardId: string;
  deckId: string;
  score: number;
  snippet: string;
}

interface SimilarState {
  cardId?: string | null;
  items: SimilarItem[];
  loading: boolean;
  reason?: 'not_indexed';
}

// Module-level cache: scores only change on reindex, so a session-lived cache
// per cardId is safe and makes reopening the dock/drawer instant.
const cache = new Map<string, { items: SimilarItem[]; reason?: 'not_indexed' }>();

export function useSimilarCards(cardId: string | null): SimilarState {
  const [state, setState] = useState<SimilarState>({ items: [], loading: false });

  useEffect(() => {
    if (!cardId) {
      setState({ cardId, items: [], loading: false });
      return;
    }
    const cached = cache.get(cardId);
    if (cached) {
      setState({ ...cached, cardId, loading: false });
      return;
    }
    let cancelled = false;
    setState({ cardId, items: [], loading: true });
    (async () => {
      try {
        const body = (await ok(
          await (api as any).cards({ id: cardId }).similar.get({ query: {} }),
        )) as { items: SimilarItem[]; reason?: 'not_indexed' };
        if (!Array.isArray(body.items)) throw new Error('invalid_similar_cards');
        cache.set(cardId, body);
        if (!cancelled) setState({ ...body, cardId, loading: false });
      } catch {
        if (!cancelled) setState({ cardId, items: [], loading: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cardId]);

  return state.cardId === cardId ? state : { items: [], loading: Boolean(cardId) };
}

/**
 * List of semantically similar cards with a score badge. `onOpen(cardId)` is
 * the navigation seam — the browser focuses its dock, the reviewer jumps to
 * `/cards?focus=`.
 */
export const SimilarCardsPanel = ({
  cardId,
  onOpen,
}: {
  cardId: string;
  onOpen: (cardId: string) => void;
}) => {
  const t = useT();
  const { items, loading, reason } = useSimilarCards(cardId);
  if (loading) {
    return (
      <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: '10px 0' }}>
        {t('cards.panel.similar.loading')}
      </div>
    );
  }
  if (reason === 'not_indexed') {
    return (
      <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: '10px 0' }}>
        {t('cards.panel.similar.notIndexed')}
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div style={{ fontSize: 12, color: 'var(--text-dim)', padding: '10px 0' }}>
        {t('cards.panel.similar.empty')}
      </div>
    );
  }

  return <SimilarCardsList items={items} onOpen={onOpen} />;
};

export function SimilarCardsList({ items, onOpen }: { items: SimilarItem[]; onOpen: (id: string) => void }) {
  const cards = useNN((s) => s.cards);
  const decks = useNN((s) => s.decks);
  const deckNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of decks) m.set(d.id, d.name);
    return m;
  }, [decks]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {items.map((item) => {
        // Prefer the mirror's front text (fresh after edits); fall back to the
        // server snippet for cards outside the ≤500-row bootstrap page.
        const mirrored = cards.find((c) => c.id === item.cardId);
        const text = mirrored?.renderFrontText?.trim() || item.snippet;
        return (
          <Button variant="bare"
            key={item.cardId}
            type="button"
            onClick={() => onOpen(item.cardId)}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 8,
              padding: '8px 10px',
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--r-md)',
              cursor: 'pointer',
              textAlign: 'left',
              width: '100%',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 12.5,
                  color: 'var(--text)',
                  overflow: 'hidden',
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                }}
              >
                {text}
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 3 }}>
                {deckNameById.get(item.deckId) ?? ''}
              </div>
            </div>
            <NNBadge tone="lime" size="xs">
              {Math.round(item.score * 100)}%
            </NNBadge>
            <NNIcon name="chevr" size={12} color="var(--text-dim)" />
          </Button>
        );
      })}
    </div>
  );
};
