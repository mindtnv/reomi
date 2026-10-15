/** Counts cover the complete owned collection, never the client card cache. */
export interface StudyCounts {
  total: number;
  newCount: number;
  learningCount: number;
  reviewCount: number;
  suspendedCount: number;
  dueNew: number;
  dueLearning: number;
  dueReview: number;
  nextLearningAt: string | null;
  nextDueAt: string | null;
}

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

export interface StudyOverview {
  overall: StudySummary;
  /** Each deck includes all its descendants and its effective daily limits. */
  decks: Record<string, StudySummary>;
  direct: Record<string, StudyCounts>;
}
