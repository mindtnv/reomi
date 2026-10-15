import { MAX_REVIEW_DURATION_MS, xpForRating } from '@reomi/shared';
import type { Rating } from './types';
import { readBrowserValue, removeBrowserValue, writeBrowserValue, type MigratingStorage } from './storage-migration';

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

export function readStudyResult(userId: string | undefined, storage?: ResultStorage): StudyResult | null {
  if (!userId) return null;
  if (inMemory?.userId === userId) return inMemory;
  try {
    const value: unknown = JSON.parse(readBrowserValue(storage ?? localStorage, key(userId)) ?? 'null');
    return valid(value, userId) ? value : null;
  } catch { return null; }
}

export function clearStudyResult(userId: string, storage?: ResultStorage): void {
  if (inMemory?.userId === userId) inMemory = null;
  try { removeBrowserValue(storage ?? localStorage, key(userId)); } catch {}
}
