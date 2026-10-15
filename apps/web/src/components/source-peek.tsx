'use client';

/* eslint-disable react/forbid-elements -- TODO: replace raw input, select, and button with TextInput, Button, or NNSelect. */

// Feature #1 — «провал → источник». A lightweight reviewer surface, fed by the
// SAME `useCardSources` hook the SourceLinksPanel uses, but tuned for the in-flow
// reveal/grade loop (NOT a backlink list):
//
//   • SourcePeekChip   — a quiet, non-intrusive chip shown AFTER reveal for any
//     grade («↗ из: «{title}», стр. {n}»). First cited source only.
//   • SourcePeekPanel  — shown on a lapse (Again): instantly renders the cited
//     snippet, then a «раскрыть полностью» button dotts the FULL chunk text via
//     store.getSourceChunks(sourceId,{from:position,limit:1}). Source content is
//     rendered as plain, whitespace-preserved TEXT — never raw HTML.
//
// Only renders when the card HAS provenance (`useCardSources(id).items.length>0`)
// — hand-authored cards stay clean. The single navigation (open in the library)
// is an explicit secondary action; it never fires implicitly (navigating away
// rebuilds the review queue and kills the session).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { CardSourceLink } from '@/lib/types';
import { formatCueTime } from '@reomi/shared';
import { NNBadge, NNBtn, NNIcon } from '@/components/ui';
import { useNN } from '@/lib/store';
import { useT } from '@/lib/i18n';
import { assistantApi, ok } from '@/lib/api';
import { cardSourceHref as libraryHref } from '@/lib/card-source-link';
import { raiseToast } from './toasts';
import { useCardSources } from '@/components/source-links';

type Tr = (key: string, params?: Record<string, string | number>) => string;

/** The first cited source for a card (the one the peek surfaces), or null. */
export function useFirstCardSource(cardId: string | null): CardSourceLink | null {
  const { items } = useCardSources(cardId);
  // Prefer a non-tombstone source (sourceId present) so the chip/panel can act.
  return items.find((it) => it.sourceId) ?? items[0] ?? null;
}

async function freshLink(item: CardSourceLink): Promise<CardSourceLink | null> {
  if(!item.cardId)return item;
  const ownerId=useNN.getState().profile?.userId;
  try {
    const data=await ok(await assistantApi.cards({id:item.cardId}).sources.get());
    if(useNN.getState().profile?.userId!==ownerId)return null;
    const row=data.items.find(row=>row.id===item.id);
    return row?{...row,cardId:item.cardId,createdAt:row.createdAt?new Date(row.createdAt).toISOString():''}:null;
  }catch{return null;}
}
async function openFresh(item: CardSourceLink, onOpen: (href:string)=>void, isCurrent:()=>boolean=()=>true) {
  const location=window.location.href;
  const current=await freshLink(item),href=current?libraryHref(current):null;
  if(!isCurrent()||window.location.href!==location)return;
  if(href)onOpen(href);else raiseToast({kind:'info',titleKey:'assistant.sourceUnavailable'});
}

function originLabel(item: CardSourceLink, t: Tr): string {
  const title = item.sourceTitle?.trim();
  if (!title) return t('review.peek.fromUntitled');
  if (item.startSeconds != null) return t('review.peek.fromTime', { title, time: formatCueTime(item.startSeconds) });
  return item.page != null
    ? t('review.peek.fromPage', { title, n: item.page })
    : t('review.peek.from', { title });
}

/**
 * The quiet provenance chip shown after reveal (any grade). Click is an explicit
 * jump into the library reader; for a tombstone source it's inert. Renders null
 * with no provenance.
 */
export const SourcePeekChip = ({
  item,
  onOpen,
}: {
  item: CardSourceLink | null;
  onOpen: (href: string) => void;
}) => {
  const t = useT();
  const navigation=useRef(0);
  useEffect(()=>{navigation.current++;return()=>{navigation.current++;};},[item?.id,item?.sourceId,item?.sourceChunkId]);
  if (!item) return null;
  const href = libraryHref(item);
  return (
    <button
      type="button"
      disabled={!href}
      onClick={() => { const current=navigation.current;if(href)void openFresh(item,onOpen,()=>navigation.current===current); }}
      title={href ? t(item.sourceKind === 'youtube' ? 'review.peek.openVideo' : 'review.peek.openInLibrary') : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        maxWidth: '100%',
        padding: '4px 9px',
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--r-pill)',
        cursor: href ? 'pointer' : 'default',
        color: 'var(--text-muted)',
        fontFamily: 'var(--font-sans)',
        fontSize: 11.5,
        lineHeight: 1.2,
      }}
    >
      <NNIcon name="doc" size={12} color="var(--sky-400)" />
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          minWidth: 0,
        }}
      >
        {originLabel(item, t)}
      </span>
    </button>
  );
};

/**
 * The lapse passage panel. Shows the cited snippet immediately; «раскрыть
 * полностью» dotts the full chunk text. `compact` trims padding for the inline
 * (non-overlay) placement. The optional `onOpenLibrary`/`onDismiss` render the
 * secondary actions row.
 */
export const SourcePeekPanel = ({
  item,
  onOpenLibrary,
  onDismiss,
}: {
  item: CardSourceLink;
  onOpenLibrary?: (href: string) => void;
  onDismiss?: () => void;
}) => {
  const t = useT();
  const getSourceChunks = useNN((s) => s.getSourceChunks);
  const generation=useRef(0);
  const [unavailable,setUnavailable]=useState(false);
  useEffect(()=>{generation.current++;setFullText(null);setLoadingFull(false);setUnavailable(false);return()=>{generation.current++;};},[item.id,item.sourceId,item.sourceChunkId,item.locationAvailable,item.sourceSnapshot?.textHash,item.sourceSnapshot?.sourceVersion]);
  const [fullText, setFullText] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const href = libraryHref(item);

  const expand = useCallback(async () => {
    if(fullText!=null||loadingFull||item.locationAvailable===false)return;
    const current=generation.current;setLoadingFull(true);
    try {
      const fresh=await freshLink(item);
      if(!fresh?.sourceId||fresh.position==null||fresh.locationAvailable===false){if(current===generation.current)setUnavailable(true);return;}
      const page=await getSourceChunks(fresh.sourceId,fresh.position,1);
      if(current!==generation.current)return;
      const chunk=page.items.find(chunk=>chunk.id===fresh.sourceChunkId);
      if(!chunk){setUnavailable(true);return;}
      setFullText(chunk.text);
    }catch{if(current===generation.current)setUnavailable(true);}
    finally{if(current===generation.current)setLoadingFull(false);}
  },[fullText,loadingFull,item,getSourceChunks]);

  // The body text: full chunk once dotted, else the snippet. Plain TEXT only
  // (whitespace preserved) — this is source content, rendered safely without HTML.
  const body = fullText ?? item.snippet ?? '';
  const canExpand = !unavailable && item.locationAvailable !== false && fullText == null && item.sourceChunkId != null && item.sourceId != null && item.position != null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <NNIcon name="doc" size={13} color="var(--sky-400)" />
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--text)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 0,
            flex: 1,
          }}
        >
          {item.sourceTitle?.trim() || t('review.peek.fromUntitled')}
        </span>
        {item.page != null && (
          <NNBadge tone="sky" size="xs">
            {t('notebooks.backlinks.page', { n: item.page })}
          </NNBadge>
        )}
      </div>

      {body && (
        <div
          className="nn-scroll"
          style={{
            fontSize: 13,
            lineHeight: 1.55,
            color: 'var(--text-muted)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 220,
            overflowY: 'auto',
            padding: '8px 10px',
            background: 'var(--surface-2)',
            border: '1px solid var(--border)',
            borderRadius: 'var(--r-md)',
          }}
        >
          {body}
        </div>
      )}

      {(unavailable || item.locationAvailable === false) && <small>{t('assistant.anchorUnavailable')}</small>}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {canExpand && (
          <NNBtn size="sm" variant="ghost" icon="chevd" onClick={() => void expand()} disabled={loadingFull}>
            {loadingFull ? t('review.peek.loading') : t('review.peek.expand')}
          </NNBtn>
        )}
        {href && onOpenLibrary && (
          <NNBtn size="sm" variant="ghost" icon="link" onClick={() => { const current=generation.current;void openFresh(item,onOpenLibrary,()=>generation.current===current); }}>
            {t('review.peek.openInLibrary')}
          </NNBtn>
        )}
        <div style={{ flex: 1 }} />
        {onDismiss && (
          <NNBtn size="sm" variant="soft" onClick={onDismiss}>
            {t('review.peek.dismiss')}
          </NNBtn>
        )}
      </div>
    </div>
  );
};
