import { isLegacyClozeCard } from '@reomi/shared';
// Map API responses (ISO date strings, server column names) into the UI shape
// that apps/web components already expect. Keeps the component surface stable
// while the source of truth shifts from Dexie to the server.

import { State, type Card as FsrsCard } from 'ts-fsrs';
import type { RenderKind } from '@reomi/shared';
import type { ArtifactStatus, NotebookArtifactType, NotebookColor, NotebookNoteKind, SourceKind } from '@reomi/shared';
import type { QuizAttemptAnswer } from '@reomi/shared';
import type { Card, Deck, DeckOptionsPreset, FilteredDeck, FilteredDeckSortOrder, Note, Notebook, NotebookArtifact, NotebookNote, NoteType, Profile, QuizAttempt, Review } from './types';

type IsoOrDate = string | Date | null | undefined;

function toEpoch(v: IsoOrDate, fallback = 0): number {
  if (!v) return fallback;
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(v);
  return Number.isNaN(t) ? fallback : t;
}

function toDate(v: IsoOrDate): Date | undefined {
  if (!v) return undefined;
  if (v instanceof Date) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const stateFromLabel: Record<string, State> = {
  new: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
};

export function deckFromApi(row: any): Deck {
  return {
    metadataRevision: row.metadataRevision,
    id: row.id,
    name: row.name,
    color: row.color,
    icon: row.icon ?? undefined,
    position: row.position ?? 0,
    species: row.species ?? 'fern',
    createdAt: toEpoch(row.createdAt),
    parentId: row.parentId ?? undefined,
    presetId: row.presetId ?? null,
  };
}

export function presetFromApi(row: any): DeckOptionsPreset {
  return {
    id: row.id,
    userId: row.userId ?? '',
    name: row.name,
    newPerDay: row.newPerDay ?? 20,
    reviewsPerDay: row.reviewsPerDay ?? 200,
    learningSteps: Array.isArray(row.learningSteps) ? row.learningSteps : [],
    relearningSteps: Array.isArray(row.relearningSteps) ? row.relearningSteps : [],
    desiredRetention: row.desiredRetention ?? null,
    leechThreshold: row.leechThreshold ?? 8,
    maximumInterval: row.maximumInterval ?? 36500,
    createdAt: toEpoch(row.createdAt),
    updatedAt: toEpoch(row.updatedAt),
  };
}

export function filteredDeckFromApi(row: any): FilteredDeck {
  return {
    id: row.id,
    userId: row.userId ?? '',
    name: row.name,
    query: row.query ?? '',
    sortOrder: (row.sortOrder ?? 'due') as FilteredDeckSortOrder,
    cardLimit: row.cardLimit ?? 50,
    includeSuspended: row.includeSuspended ?? false,
    createdAt: toEpoch(row.createdAt),
    updatedAt: toEpoch(row.updatedAt),
  };
}

export function cardFromApi(row: any): Card {
  const fsrs: FsrsCard = {
    due: toDate(row.due) ?? new Date(),
    stability: row.stability ?? 0,
    difficulty: row.difficulty ?? 0,
    elapsed_days: row.elapsedDays ?? 0,
    scheduled_days: row.scheduledDays ?? 0,
    learning_steps: row.learningSteps ?? 0,
    reps: row.reps ?? 0,
    lapses: row.lapses ?? 0,
    state: stateFromLabel[row.state] ?? State.New,
    last_review: toDate(row.lastReview),
  };
  // Embedded note/noteType from the enriched card read-payload (used for the
  // lazy HTML render path). Tags live on the note (Anki-correct).
  const note = row.note
    ? {
        id: row.note.id,
        updatedAt: row.note.updatedAt ? new Date(row.note.updatedAt).toISOString() : undefined,
        acceptedAnswers: row.note.acceptedAnswers ?? [],
        fieldValues: (row.note.fieldValues ?? {}) as Record<string, string>,
        tags: (row.note.tags ?? []) as string[],
      }
    : null;
  const noteType = row.noteType
    ? {
        id: row.noteType.id,
        updatedAt: row.noteType.updatedAt ? new Date(row.noteType.updatedAt).toISOString() : undefined,
        name: row.noteType.name ?? '',
        kind: (row.noteType.kind ?? 'basic') as RenderKind,
        fields: row.noteType.fields,
        templates: row.noteType.templates ?? [],
        styling: row.noteType.styling ?? '',
      }
    : null;
  return {
    id: row.id,
    deckId: row.deckId,
    noteId: row.noteId,
    templateOrd: row.templateOrd ?? 0,
    clozeNumber: isLegacyClozeCard({ renderKind: row.renderKind ?? row.noteType?.kind ?? 'basic', clozeNumber: row.clozeNumber }) ? 0 : row.clozeNumber ?? null,
    renderText: row.renderText ?? '',
    renderFrontText: row.renderFrontText ?? '',
    renderBackText: row.renderBackText ?? '',
    renderKind: (row.renderKind ?? 'basic') as RenderKind,
    // Tags from the embedded note (fallback to row.tags / [] for safety).
    tags: note?.tags ?? row.tags ?? [],
    suspended: row.suspended ?? false,
    createdAt: toEpoch(row.createdAt),
    updatedAt: toEpoch(row.updatedAt),
    fsrs,
    note,
    noteType,
    hold: holdFromApi(row.hold),
  };
}

function holdFromApi(value: unknown): Card['hold'] {
  if (!value || typeof value !== 'object') return null;
  const hold = value as { until?: unknown; reason?: unknown };
  if (typeof hold.until !== 'string' || !hold.until) return null;
  if (hold.reason !== 'user' && hold.reason !== 'sibling') return null;
  return { until: hold.until, reason: hold.reason };
}

/** Grade/undo return bare scheduling rows, without the embedded content. */
export function mergeReviewedCard(row: any, previous?: Card): Card {
  const mapped = cardFromApi(row);
  if (previous?.id !== mapped.id) return mapped;
  return {
    ...mapped,
    note: row.note === undefined ? previous.note : mapped.note,
    noteType: row.noteType === undefined ? previous.noteType : mapped.noteType,
    tags: row.note === undefined && row.tags === undefined ? previous.tags : mapped.tags,
  };
}

export function noteFromApi(row: any): Note {
  return {
    id: row.id,
    noteTypeId: row.noteTypeId,
    fieldValues: (row.fieldValues ?? {}) as Record<string, string>,
    tags: (row.tags ?? []) as string[],
    deckId: row.deckId ?? '',
  };
}

export function noteTypeFromApi(row: any): NoteType {
  return {
    id: row.id,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : undefined,
    name: row.name,
    fields: row.fields ?? [],
    templates: row.templates ?? [],
    styling: row.styling ?? '',
    kind: (row.kind ?? 'custom') as RenderKind,
    isBuiltin: row.isBuiltin ?? false,
  };
}

export function profileFromApi(row: any): Profile {
  const plantStage = Math.max(0, Math.min(5, row.plantStage ?? 0)) as Profile['plantStage'];
  return {
    id: 'me',
    userId: row.userId ?? undefined,
    name: row.name ?? 'Friend',
    level: row.level ?? 1,
    xp: row.xp ?? 0,
    streakDays: row.streakDays ?? 0,
    streakFreezes: row.streakFreezes ?? 0,
    lastReviewDate: row.lastReviewDate ?? undefined,
    todayMinutes: row.todayMinutes ?? 0,
    todayMinutesDate: row.todayMinutesDate ?? undefined,
    dailyGoalMinutes: row.dailyGoalMinutes ?? 15,
    dailyGoalMetCount: row.dailyGoalMetCount ?? 0,
    dailyGoalMetDate: row.dailyGoalMetDate ?? undefined,
    desiredRetention: row.desiredRetention ?? undefined,
    agentInstructions: row.agentInstructions ?? undefined,
    plantSpecies: row.plantSpecies ?? 'fern',
    plantStage,
    unlockedSpecies: Array.isArray(row.unlockedSpecies)
      ? (row.unlockedSpecies as Profile['unlockedSpecies'])
      : ['fern'],
    createdAt: toEpoch(row.createdAt),
  };
}

// ── «Блокноты 2.0» (N1) ───────────────────────────────────────────────────────
// Notebook + note rows keep ISO date strings (like Source) — the list/notes UI
// renders relative/badge timestamps, not the epoch-number FSRS math.

export function notebookFromApi(row: any): Notebook {
  return {
    metadataRevision: row.metadataRevision,
    id: row.id,
    title: row.title,
    emoji: row.emoji ?? null,
    color: (row.color ?? null) as NotebookColor | null,
    description: row.description ?? null,
    pinned: row.pinned ?? false,
    archived: row.archived ?? false,
    // Counts are present only on the GET /notebooks grid payload.
    sourceCount: typeof row.sourceCount === 'number' ? row.sourceCount : undefined,
    noteCount: typeof row.noteCount === 'number' ? row.noteCount : undefined,
    cardCount: typeof row.cardCount === 'number' ? row.cardCount : undefined,
    // Studio document counts + cover fan — grid payload only (A3 redesign).
    artifactCount: typeof row.artifactCount === 'number' ? row.artifactCount : undefined,
    generatingCount: typeof row.generatingCount === 'number' ? row.generatingCount : undefined,
    generatingTitle: row.generatingTitle ?? null,
    coverSources: Array.isArray(row.coverSources)
      ? (row.coverSources as { title: string; kind: SourceKind; coverMediaId: string | null }[]).map((c) => ({
          title: c.title,
          kind: c.kind,
          coverMediaId: c.coverMediaId ?? null,
        }))
      : undefined,
    // Overview cache (N2) — present on the GET /notebooks/:id detail row.
    overview: row.overview ?? null,
    suggestedQuestions: Array.isArray(row.suggestedQuestions)
      ? (row.suggestedQuestions as string[])
      : null,
    overviewFingerprint: row.overviewFingerprint ?? null,
    currentFingerprint: row.currentFingerprint ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function notebookArtifactFromApi(row: any): NotebookArtifact {
  return {
    id: row.id,
    notebookId: row.notebookId ?? null,
    ownerKind: row.ownerKind ?? 'notebook', sourceId: row.sourceId ?? null,
    sourceOriginId: row.sourceOriginId ?? null, sourceOriginTitle: row.sourceOriginTitle ?? null,
    type: row.type as NotebookArtifactType,
    status: row.status as ArtifactStatus,
    title: row.title,
    sourceIds: Array.isArray(row.sourceIds) ? (row.sourceIds as string[]) : [],
    errorCode: row.errorCode ?? null,
    model: row.model ?? null,
    // progressChars rides the LIGHT list row (live job progress); absent on GET.
    progressChars: typeof row.progressChars === 'number' ? row.progressChars : undefined,
    // contentMd / contentJson only ride the FULL artifact GET.
    contentMd: typeof row.contentMd === 'string' ? row.contentMd : undefined,
    contentJson: row.contentJson ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function quizAttemptFromApi(row: any): QuizAttempt {
  return {
    id: row.id,
    correct: typeof row.correct === 'number' ? row.correct : 0,
    total: typeof row.total === 'number' ? row.total : 0,
    answers: Array.isArray(row.answers) ? (row.answers as QuizAttemptAnswer[]) : [],
    createdAt: row.createdAt,
  };
}

export function notebookNoteFromApi(row: any): NotebookNote {
  return {
    metadataRevision: row.metadataRevision,
    id: row.id,
    notebookId: row.notebookId ?? null,
    ownerKind: row.ownerKind ?? 'notebook', sourceId: row.sourceId ?? null,
    sourceOriginId: row.sourceOriginId ?? null, sourceOriginTitle: row.sourceOriginTitle ?? null,
    title: row.title,
    content: row.content ?? '',
    kind: (row.kind ?? 'manual') as NotebookNoteKind,
    citations: Array.isArray(row.citations) ? (row.citations as unknown[]) : null,
    messageId: row.messageId ?? null,
    pinned: row.pinned ?? false,
    excerpt: typeof row.excerpt === 'string' ? row.excerpt : undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function reviewFromApi(row: any): Review {
  return {
    id: row.id,
    cardId: row.cardId,
    deckId: row.deckId,
    rating: row.rating,
    durationMs: row.durationMs ?? 0,
    reviewedAt: toEpoch(row.reviewedAt),
    nextDue: toEpoch(row.nextDue),
    nextStability: row.nextStability ?? 0,
    nextDifficulty: row.nextDifficulty ?? 0,
  };
}
