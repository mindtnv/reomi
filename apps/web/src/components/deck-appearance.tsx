'use client';

import { TextInput, Button } from '@/components/design-system/primitives';

import { useState } from 'react';
import { DECK_COLORS as COLOR_CATALOG } from '@reomi/shared';
import { NNIcon } from './ui';
import { useT } from '@/lib/i18n';
import type { DeckColor } from '@/lib/types';

export const DECK_ICONS = ['decks', 'book', 'brain', 'code', 'globe', 'chat', 'bolt', 'target', 'doc', 'graph', 'star', 'note', 'cards', 'library', 'notebook', 'chart', 'home', 'garden', 'archive', 'stack', 'flame', 'clock', 'trophy', 'mic', 'bulb', 'pin', 'math', 'flask', 'atom', 'dna', 'laptop', 'cpu', 'database', 'terminal', 'cloud', 'shield', 'key', 'briefcase', 'scales', 'heart', 'music', 'camera', 'compass', 'map', 'rocket', 'puzzle', 'coffee', 'dumbbell'] as const;
export const DECK_COLORS: readonly DeckColor[] = COLOR_CATALOG;
export const deckIconName = (value?: string) => DECK_ICONS.includes(value as any) ? value! : 'decks';
export const deckColorValue = (color: string) => color === 'neutral' ? 'var(--text-muted)' : `var(--${color}-500)`;
export function DeckAppearance({ icon, color, disabled, onIcon, onColor }: {
  icon: string; color: DeckColor; disabled?: boolean; onIcon: (value: string) => void; onColor: (value: DeckColor) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState('');
  const icons = DECK_ICONS.filter(value => `${t(`decks.icons.${value}`)} ${value}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <>
    <fieldset className="reomi-deck-icon-field"><legend>{t('decks.appearance.icon')}</legend>
      <TextInput className="reomi-input" aria-label={t('decks.appearance.search')} placeholder={t('decks.appearance.search')} value={query} onChange={event => setQuery(event.target.value)}/>
      <div className="reomi-deck-icon-options nn-scroll">{icons.map(value => <Button variant="bare" key={value} type="button" disabled={disabled}
        aria-label={t(`decks.icons.${value}`)} title={t(`decks.icons.${value}`)} aria-pressed={icon === value}
        onClick={() => onIcon(value)} style={{ color: deckColorValue(color) }}><NNIcon name={value} size={22}/></Button>)}</div>
    </fieldset>
    <fieldset className="reomi-color-field"><legend>{t('decks.color')}</legend>
      <div className="reomi-color-options reomi-deck-color-options">{DECK_COLORS.map(value => <Button variant="bare" key={value} type="button" disabled={disabled}
        aria-label={t(`decks.colors.${value}`)} title={t(`decks.colors.${value}`)} aria-pressed={color === value}
        onClick={() => onColor(value)} style={{ background: deckColorValue(value) }}>{color === value && <NNIcon name="check" size={16}/>}</Button>)}</div>
    </fieldset>
  </>;
}
