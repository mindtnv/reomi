'use client';

/* eslint-disable react/forbid-elements -- TODO: replace raw input, select, and button with TextInput, Button, or NNSelect. */

// MentionPopover + SlashMenu (D1/D2) — composer popovers, anchored above the
// textarea (PickerMenu's visual idiom: absolute, --shadow-lg, nn-scroll) but
// with full keyboard navigation driven by the PARENT (the textarea keeps focus;
// ArrowUp/Down move `activeIndex`, Enter/Tab pick, Esc closes — all handled in
// the composer's onKeyDown so the caret never leaves the input).

import React, { useMemo } from 'react';
import { NNIcon } from '@/components/ui';
import type { MentionResults } from '@/lib/chat-mentions';
import type { SlashCommand } from '@/lib/chat-mentions';

type T = (key: string, params?: Record<string, string | number>) => string;

// ── Generic flat list with sections (internal) ────────────────────────────────

export interface PopoverItem {
  key: string;
  /** Section heading rendered above the first item of each section. */
  section: string;
  label: string;
  sublabel?: string;
  glyph?: React.ReactNode;
}

interface PopoverListProps {
  items: PopoverItem[];
  activeIndex: number;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
  emptyLabel: string;
  maxHeight: number;
}

const PopoverList = ({
  items,
  activeIndex,
  onPick,
  onHover,
  emptyLabel,
  maxHeight,
}: PopoverListProps) => (
  <div
    role="listbox"
    className="nn-scroll"
    style={{
      position: 'absolute',
      bottom: 'calc(100% + 6px)',
      left: 0,
      right: 0,
      maxHeight,
      overflowY: 'auto',
      padding: 4,
      borderRadius: 'var(--r-md)',
      border: '1px solid var(--border-2)',
      background: 'var(--surface)',
      boxShadow: 'var(--shadow-lg)',
      zIndex: 30,
      display: 'flex',
      flexDirection: 'column',
      gap: 2,
    }}
  >
    {items.length === 0 ? (
      <span
        style={{
          fontSize: 12.5,
          color: 'var(--text-dim)',
          fontFamily: 'var(--font-sans)',
          padding: '8px 10px',
        }}
      >
        {emptyLabel}
      </span>
    ) : (
      items.map((item, i) => {
        const sectionStart = i === 0 || items[i - 1]!.section !== item.section;
        return (
          <React.Fragment key={item.key}>
            {sectionStart && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: 1.2,
                  textTransform: 'uppercase',
                  color: 'var(--text-dim)',
                  fontFamily: 'var(--font-sans)',
                  padding: '6px 10px 2px',
                }}
              >
                {item.section}
              </span>
            )}
            <button
              type="button"
              role="option"
              aria-selected={i === activeIndex}
              // Mousedown (not click) so the textarea never loses focus.
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(i);
              }}
              onMouseEnter={() => onHover(i)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 10px',
                borderRadius: 'var(--r-sm)',
                border: 'none',
                cursor: 'pointer',
                background: i === activeIndex ? 'var(--surface-3)' : 'transparent',
                color: 'var(--text)',
                fontFamily: 'var(--font-sans)',
                fontSize: 13,
                textAlign: 'left',
                width: '100%',
                minWidth: 0,
              }}
            >
              {item.glyph}
              <span
                style={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  minWidth: 0,
                  flex: 1,
                }}
              >
                {item.label}
              </span>
              {item.sublabel && (
                <span
                  style={{
                    fontSize: 11,
                    color: 'var(--text-dim)',
                    flexShrink: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: 110,
                  }}
                >
                  {item.sublabel}
                </span>
              )}
            </button>
          </React.Fragment>
        );
      })
    )}
  </div>
);

// ── @-mention popover (decks + cards) ─────────────────────────────────────────

export interface MentionPick {
  kind: 'deck' | 'card';
  id: string;
  label: string;
}

/** Flatten search results into the keyboard-navigable item list (decks first). */
export function mentionItems(results: MentionResults, t: T): { items: PopoverItem[]; picks: MentionPick[] } {
  const items: PopoverItem[] = [];
  const picks: MentionPick[] = [];
  for (const d of results.decks) {
    items.push({
      key: `deck-${d.id}`,
      section: t('chat.composer.mentionDecks'),
      label: d.name,
      glyph: <NNIcon name="stack" size={13} color="var(--text-dim)" />,
    });
    picks.push({ kind: 'deck', id: d.id, label: d.name });
  }
  for (const c of results.cards) {
    items.push({
      key: `card-${c.id}`,
      section: t('chat.composer.mentionCards'),
      label: c.front,
      glyph: <NNIcon name="brain" size={13} color="var(--text-dim)" />,
    });
    picks.push({ kind: 'card', id: c.id, label: c.front });
  }
  return { items, picks };
}

export interface MentionPopoverProps {
  results: MentionResults;
  activeIndex: number;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
  isMobile: boolean;
  t: T;
}

export const MentionPopover = ({
  results,
  activeIndex,
  onPick,
  onHover,
  isMobile,
  t,
}: MentionPopoverProps) => {
  const { items } = useMemo(() => mentionItems(results, t), [results, t]);
  return (
    <PopoverList
      items={items}
      activeIndex={activeIndex}
      onPick={onPick}
      onHover={onHover}
      emptyLabel={t('chat.composer.mentionNoResults')}
      maxHeight={isMobile ? Math.round(window.innerHeight * 0.4) : 320}
    />
  );
};

// ── Slash-command menu ────────────────────────────────────────────────────────

export interface SlashMenuProps {
  commands: SlashCommand[];
  activeIndex: number;
  onPick: (index: number) => void;
  onHover: (index: number) => void;
  isMobile: boolean;
  t: T;
}

export const SlashMenu = ({ commands, activeIndex, onPick, onHover, isMobile, t }: SlashMenuProps) => {
  const items: PopoverItem[] = commands.map((cmd) => ({
    key: cmd,
    section: '/',
    label: `/${cmd}`,
    sublabel: t(`chat.slash.${cmd}Label`),
    glyph: <NNIcon name="bolt" size={13} color="var(--text-dim)" />,
  }));
  return (
    <PopoverList
      items={items}
      activeIndex={activeIndex}
      onPick={onPick}
      onHover={onHover}
      emptyLabel={t('chat.composer.mentionNoResults')}
      maxHeight={isMobile ? Math.round(window.innerHeight * 0.4) : 240}
    />
  );
};
