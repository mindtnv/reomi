export type SortField = 'created' | 'updated' | 'due' | 'lapses' | 'reps' | 'front';
export interface CardColumn {
  id: string; labelKey: string; sort?: SortField; align?: 'left' | 'right'; mobile?: boolean; width: string; minWidth: number;
}
export const CARD_COLUMNS: readonly CardColumn[] = [
  { id: 'question', labelKey: 'cards.columns.question', sort: 'front', mobile: true, width: 'minmax(160px, 1.4fr)', minWidth: 160 },
  { id: 'answer', labelKey: 'cards.columns.answer', mobile: true, width: 'minmax(140px, 1.2fr)', minWidth: 140 },
  { id: 'deck', labelKey: 'cards.columns.deck', width: '140px', minWidth: 140 },
  { id: 'variant', labelKey: 'cards.columns.variant', width: '88px', minWidth: 88 },
  { id: 'state', labelKey: 'cards.columns.state', mobile: true, width: '100px', minWidth: 100 },
  { id: 'due', labelKey: 'cards.columns.due', sort: 'due', align: 'right', width: '110px', minWidth: 110 },
  { id: 'lapses', labelKey: 'cards.columns.lapses', sort: 'lapses', align: 'right', width: '76px', minWidth: 76 },
  { id: 'tags', labelKey: 'cards.columns.tags', width: '140px', minWidth: 140 },
  { id: 'created', labelKey: 'cards.columns.created', sort: 'created', align: 'right', width: '110px', minWidth: 110 },
  { id: 'edited', labelKey: 'cards.columns.edited', sort: 'updated', align: 'right', width: '110px', minWidth: 110 },
];
export const defaultCardColumns = (mobile: boolean): string[] => CARD_COLUMNS.filter(c => !mobile || c.mobile).map(c => c.id);
export function normalizeCardColumns(value: unknown, mobile: boolean): string[] {
  const stored = value as { version?: unknown; ids?: unknown } | null;
  if (!stored || stored.version !== 1 || !Array.isArray(stored.ids)) return defaultCardColumns(mobile);
  const ids = new Set(stored.ids.filter((id): id is string => typeof id === 'string'));
  ids.add('question');
  return CARD_COLUMNS.filter(c => ids.has(c.id)).map(c => c.id);
}
export const cardTableMinWidth = (columns: readonly CardColumn[]): number => 36 + columns.reduce((sum, column) => sum + column.minWidth, 0) + columns.length * 8 + 28;
import { readBrowserValue, writeBrowserValue, type MigratingStorage } from './storage-migration';
type StorageAccess = MigratingStorage;
const key = (mobile: boolean) => `nn:cards:columns:${mobile ? 'mobile' : 'desktop'}`;
export function readCardColumns(mobile: boolean, storage?: StorageAccess): string[] {
  try { return normalizeCardColumns(JSON.parse(readBrowserValue(storage ?? localStorage, key(mobile)) ?? 'null'), mobile); }
  catch { return defaultCardColumns(mobile); }
}
export function saveCardColumns(ids: string[], mobile: boolean, storage?: StorageAccess): void {
  try { writeBrowserValue(storage ?? localStorage, key(mobile), JSON.stringify({ version: 1, ids })); } catch { /* In-memory preference still works. */ }
}
