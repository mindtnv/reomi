import { MAX_REVIEW_DURATION_MS, xpForRating } from '@reomi/shared';
import type { Rating } from './types';
import { currentStorageKey, readBrowserValue, removeBrowserValue, writeBrowserValue, type MigratingStorage } from './storage-migration';

export interface StudyResult {
  version: 1;
  userId: string;
  completedAt: number;
  deckName: string;
  answers: number;
  cards: number;
  xpGained: number;
  durationMs: number;
  grades: Record<Rating, number>;
  mode: 'regular' | 'filtered';
  reviewHref: string;
}

type ResultStorage = MigratingStorage;
let inMemory: StudyResult | null = null;
const key = (userId: string) => `nn:lastSession:${userId}`;
const natural = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function valid(value: unknown, userId: string): value is StudyResult {
  if (!value || typeof value !== 'object') return false;
  const row = value as StudyResult;
  if (row.version !== 1 || row.userId !== userId || !natural(row.completedAt) ||
    typeof row.deckName !== 'string' || row.deckName.length > 200 ||
    !natural(row.answers) || row.answers < 1 || !natural(row.cards) || row.cards < 1 || row.cards > row.answers ||
    !natural(row.durationMs) || row.durationMs > row.answers * MAX_REVIEW_DURATION_MS ||
    !natural(row.xpGained) || !row.grades || !['regular', 'filtered'].includes(row.mode) ||
    typeof row.reviewHref !== 'string' || row.reviewHref.length > 2048 || !/^\/review(?:\?|$)/.test(row.reviewHref)) return false;
  const ratings = [1, 2, 3, 4] as const;
  return ratings.every((rating) => natural(row.grades[rating])) &&
    ratings.reduce((sum, rating) => sum + row.grades[rating], 0) === row.answers &&
    ratings.reduce((sum, rating) => sum + row.grades[rating] * xpForRating(rating), 0) === row.xpGained;
}

export function saveStudyResult(result: StudyResult, storage?: ResultStorage): void {
  if (!valid(result, result.userId)) return;
  inMemory = result;
  try { writeBrowserValue(storage ?? localStorage, key(result.userId), JSON.stringify(result)); } catch {}
}

function readStored(userId: string, storage?: ResultStorage): StudyResult | null | undefined {
  try {
    const value: unknown = JSON.parse(readBrowserValue(storage ?? localStorage, key(userId)) ?? 'null');
    return valid(value, userId) ? value : null;
  } catch { return undefined; }
}

function sameReport(left: StudyResult, right: StudyResult): boolean {
  const ratings = [1, 2, 3, 4] as const;
  return left.deckName === right.deckName && left.answers === right.answers && left.cards === right.cards &&
    left.xpGained === right.xpGained && left.durationMs === right.durationMs && left.mode === right.mode &&
    left.reviewHref === right.reviewHref && ratings.every((rating) => left.grades[rating] === right.grades[rating]);
}

function fresher(memory: StudyResult | null, stored: StudyResult | null): StudyResult | null {
  if (!stored) return memory;
  if (!memory) return stored;
  if (stored.completedAt !== memory.completedAt) return stored.completedAt > memory.completedAt ? stored : memory;
  return sameReport(memory, stored) ? memory : stored;
}

function remember(userId: string, chosen: StudyResult | null): void {
  if (inMemory && inMemory.userId !== userId) return;
  inMemory = chosen;
}

export function readStudyResult(userId: string | undefined, storage?: ResultStorage): StudyResult | null {
  if (!userId) return null;
  const memory = inMemory?.userId === userId ? inMemory : null;
  const stored = readStored(userId, storage);
  if (stored === undefined) return memory;
  const chosen = fresher(memory, stored);
  remember(userId, chosen);
  return chosen;
}

export function clearStudyResult(userId: string, storage?: ResultStorage): void {
  if (inMemory?.userId === userId) inMemory = null;
  try { removeBrowserValue(storage ?? localStorage, key(userId)); } catch {}
}

function ownsResultKey(eventKey: string | null, userId: string): boolean {
  if (!eventKey) return false;
  const logical = key(userId);
  return eventKey === logical || eventKey === currentStorageKey(logical);
}

export function subscribeStudyResult(userId: string, onChange: (result: StudyResult | null) => void, storage?: ResultStorage, target?: EventTarget): () => void {
  const source = target ?? (typeof window === 'undefined' ? null : window);
  if (!source) return () => {};
  const onStorage = (event: Event) => {
    const notice = event as { key?: string | null; newValue?: string | null };
    if (!ownsResultKey(notice.key ?? null, userId)) return;
    if ((notice.newValue == null || notice.newValue === '') && inMemory?.userId === userId) inMemory = null;
    onChange(readStudyResult(userId, storage));
  };
  source.addEventListener('storage', onStorage);
  return () => source.removeEventListener('storage', onStorage);
}
