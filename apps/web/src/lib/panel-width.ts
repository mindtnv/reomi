import { readBrowserValue } from './storage-migration';

export function boundedPanelWidth(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.round(value))) : fallback;
}
export const CHAT_RAIL = { key: 'nn:chat:rail-width', min: 220, max: 420, default: 280 } as const;
export function readChatRailWidth(): number {
  try {
    const raw = readBrowserValue(localStorage, CHAT_RAIL.key);
    return raw?.trim() ? boundedPanelWidth(Number(raw), CHAT_RAIL.min, CHAT_RAIL.max, CHAT_RAIL.default) : CHAT_RAIL.default;
  } catch { return CHAT_RAIL.default; }
}
/** Human-readable tool text; protocol references are not useful display content. */
export function compactToolText(raw: string): { preview: string; full: string; truncated: boolean } {
  const full = raw.replace(/\[(?:card|deck|source|src|notebook):[^\]\s]+\]/g, '').replace(/[ \t]+\n/g, '\n').replace(/ {2,}/g, ' ').trim();
  const lines = full.split('\n').filter(line => line.trim());
  const preview = lines.slice(0, 3).join('\n').slice(0, 280);
  return { full, preview, truncated: lines.length > 3 || full.length > 280 };
}

export const CARD_PANEL = { key: 'nn:cards:panel-width', min: 420, max: 1120, default: 720 } as const;
export function readCardPanelWidth(): number {
  try {
    const raw = readBrowserValue(localStorage, CARD_PANEL.key);
    return raw?.trim() ? boundedPanelWidth(Number(raw), CARD_PANEL.min, CARD_PANEL.max, CARD_PANEL.default) : CARD_PANEL.default;
  } catch { return CARD_PANEL.default; }
}

export const CARD_FILTERS = { key: 'nn:cards:filters-width', min: 180, max: 440, default: 196 } as const;
export function readCardFiltersWidth(): number {
  try {
    const raw = readBrowserValue(localStorage, CARD_FILTERS.key);
    return raw?.trim() ? boundedPanelWidth(Number(raw), CARD_FILTERS.min, CARD_FILTERS.max, CARD_FILTERS.default) : CARD_FILTERS.default;
  } catch { return CARD_FILTERS.default; }
}

export const REVIEW_INSPECTOR = { key: 'nn:review:inspector-width', min: 220, max: 420, default: 256 } as const;
export function readReviewInspectorWidth(storage?: Pick<Storage, 'getItem'>): number {
  try {
    const raw = readBrowserValue(storage ?? localStorage, REVIEW_INSPECTOR.key);
    return raw?.trim() ? boundedPanelWidth(Number(raw), REVIEW_INSPECTOR.min, REVIEW_INSPECTOR.max, REVIEW_INSPECTOR.default) : REVIEW_INSPECTOR.default;
  } catch { return REVIEW_INSPECTOR.default; }
}
