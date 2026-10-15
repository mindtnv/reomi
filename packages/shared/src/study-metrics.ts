// Shared study-metric definitions. Again (1) is a miss. Hard (2), Good (3) and
// Easy (4) are successful recall, so one of each rating is 75%. True retention
// is a different population: the first review of each card on a UTC day.

export interface RecallGradeCounts {
  1: number;
  2: number;
  3: number;
  4: number;
}

/** Hard, Good and Easy. Again is not successful recall. */
export function isRecallSuccess(rating: number): boolean {
  return rating === 2 || rating === 3 || rating === 4;
}

/** Null when there are no answers, so a missing day is not rendered as 0%. */
export function percentOf(part: number, total: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return null;
  return Math.round((part / total) * 100);
}

/** Share of all answers that are Hard, Good or Easy. */
export function recallSuccessPercent(grades: RecallGradeCounts): number | null {
  const total = grades[1] + grades[2] + grades[3] + grades[4];
  return percentOf(grades[2] + grades[3] + grades[4], total);
}
