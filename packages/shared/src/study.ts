/** Counts cover the complete owned collection, never the client card cache. */
export interface StudyCounts {
  total: number;
  newCount: number;
  learningCount: number;
  reviewCount: number;
  suspendedCount: number;
  buriedCount: number;
  dueBuried: number;
  dueNew: number;
  dueLearning: number;
  dueReview: number;
  nextLearningAt: string | null;
  nextDueAt: string | null;
}

/** Numeric keys summed by loadStudyCounts. A test fails if this list and a zero StudyCounts disagree. */
export const STUDY_COUNT_KEYS = [
  'total', 'newCount', 'learningCount', 'reviewCount', 'suspendedCount', 'buriedCount', 'dueBuried',
  'dueNew', 'dueLearning', 'dueReview',
] as const satisfies readonly (keyof StudyCounts)[];

export interface StudySummary extends StudyCounts {
  newRemaining: number;
  reviewRemaining: number;
  availableNew: number;
  availableReview: number;
  totalAvailable: number;
  limitedNew: number;
  limitedReview: number;
  serverNow: string;
}

/** The open study interval the queue, home, and summary agree on. */
export interface StudyDaySnapshot {
  label: string;
  startsAt: string;
  endsAt: string;
  usedNew: number;
  usedReviews: number;
  todayMinutes: number;
  legacy: boolean;
  zone: string;
  rolloverMinute: number;
}

export interface StudyOverview {
  overall: StudySummary;
  /** Each deck includes all its descendants and its effective daily limits. */
  decks: Record<string, StudySummary>;
  direct: Record<string, StudyCounts>;
  studyDay: StudyDaySnapshot;
}
