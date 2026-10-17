'use client';

import { create } from 'zustand';
import { countDueCardsByDeck, getDueCards } from './cards';
import { api, assistantApi, ok, type ApiError } from './api';
import { toApiError, type LoadStatus } from './resource-state';
import { clearStudyHandoff } from './review-session';
import {
  cardFromApi,
  mergeReviewedCard,
  deckFromApi,
  filteredDeckFromApi,
  notebookArtifactFromApi,
  notebookFromApi,
  notebookNoteFromApi,
  noteTypeFromApi,
  presetFromApi,
  profileFromApi,
  quizAttemptFromApi,
  reviewFromApi,
} from './mappers';
import { normalizeNoteTags } from '@reomi/shared';
import type { NoteConversionInput, CardTemplate, FieldValues, NoteField, RenderKind } from '@reomi/shared';
import type { Card, ConceptMapResult, Deck, DeckOptionsPreset, FilteredDeck, FilteredDeckSortOrder, HarvestCandidate, LibraryItem, LibraryItemDetail, LibrarySearchResult, Notebook, NotebookArtifact, NotebookCoverage, NotebookNote, NoteType, Profile, QuizAttempt, Rating, ReadingStatus, Review, Source, SourceChunkPage, SourceLinkedCard, SuggestSourcesResult } from './types';
import type { NotebookArtifactType, NotebookColor, NotebookNoteKind, QuizAttemptAnswerInput, SourceKind, SourceMime } from '@reomi/shared';
import { writeBrowserValue } from './storage-migration';

// Server-first store. Zustand holds a cached mirror of the user's decks, cards,
// and profile — fetched at bootstrap, mutated optimistically-ish on each API
// call. Dexie is gone: the server is the source of truth now.

type BulkAction = 'move' | 'delete' | 'suspend' | 'unsuspend' | 'addTag' | 'removeTag' | 'forget' | 'setDue';

export interface CardlessNote {
  id: string;
  noteTypeId: string;
  noteTypeName: string;
  fieldValues: FieldValues;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

interface State {
  acceptRecoveredNote: (owner: string, result: any) => Card[];
  acceptRecoveredType: (owner: string, result: NoteType, originalId?: string) => Promise<NoteType>;
  bootstrapped: boolean;
  /** Detailed bootstrap lifecycle; `bootstrapped` remains for existing consumers. */
  bootstrapStatus: LoadStatus;
  bootstrapError: ApiError | null;
  decks: Deck[];
  cards: Card[];
  noteTypes: NoteType[];
  presets: DeckOptionsPreset[];
  filteredDecks: FilteredDeck[];
  profile: Profile | null;
  cardTags: string[];

  bootstrap: () => Promise<void>;
  reset: () => void;

  addDeck: (input: Omit<Deck, 'id' | 'createdAt'>) => Promise<Deck>;
  moveDeck: (id: string, targetId: string | null, placement: import('@reomi/shared').DeckPlacement) => Promise<void>;
  updateDeck: (id: string, patch: Partial<Omit<Deck, 'id' | 'createdAt'>>) => Promise<void>;
  deleteDeck: (id: string) => Promise<void>;

  /**
   * Create a note (POST /notes). The server generates one-or-more cards from
   * the note-type's templates; the response carries the note + the enriched
   * cards which we merge into the mirror. Returns the generated cards.
   */
  addNote: (input: {
    noteTypeId: string;
    expectedTypeUpdatedAt?: string;
    deckId: string;
    fieldValues: FieldValues;
    acceptedAnswers?: string[];
    tags: string[];
  }) => Promise<Card[]>;

  /**
   * Update a note (PATCH /notes/:id). The server re-generates cards (FSRS
   * preserved on surviving template ords) and returns the note + cards; we
   * replace this note's cards in the mirror.
   */
  updateNote: (
    noteId: string,
    patch: { acceptedAnswers?: string[]; fieldValues?: FieldValues; tags?: string[]; deckId?: string; expectedUpdatedAt?: string; confirmationToken?: string; expectedTypeUpdatedAt?: string; clozeRetainHistoryFor?: Record<string, number> },
  ) => Promise<Card[]>;

  /** Delete a note (DELETE /notes/:id). Cascades its cards via FK; mirror drops them. */
  deleteNote: (noteId: string) => Promise<void>;

  /** Notes whose cards were all deleted. The note text stays until restore or an explicit delete. */
  listCardlessNotes: () => Promise<{ total: number; items: CardlessNote[] }>;

  /** Recreate cards for a cardless note in the chosen deck and add them to the mirror. */
  restoreCardlessNote: (noteId: string, deckId: string) => Promise<Card[]>;

  /** Delete a single card (DELETE /cards/:id). Card-level delete still exists. */
  deleteCard: (id: string) => Promise<void>;

  /**
   * Reset a card's FSRS schedule to "new" (PATCH /cards/:id `{ forget: true }`).
   * Server zeroes reps/lapses, sets due=now, state="new". The returned card is
   * merged into the mirror.
   */
  forgetCard: (id: string) => Promise<void>;

  /**
   * Set a card's due date to a specific instant (PATCH /cards/:id
   * `{ setDue }`). `iso` is an ISO-8601 string; the server 400s on an invalid
   * date. The returned card is merged into the mirror.
   */
  setCardDue: (id: string, iso: string) => Promise<void>;

  /**
   * Refetch a single card (GET /cards/:id) and merge it into the mirror —
   * update-in-place by id, or append when it's a card the mirror hadn't seen.
   * Used after an out-of-band write (e.g. the agentic chat applies an
   * `edit_card`/SRS tool) to reflect the server change without a full reload.
   * Silently no-ops if the card is gone/foreign (404). Does NOT change the data
   * model — it's a thin GET-and-merge over the existing `cards` array.
   */
  refetchCard: (id: string) => Promise<void>;

  /**
   * Refetch the cards of a deck (GET /cards?deckId=:id) and merge them into the
   * mirror (update-by-id, append new). Used after an agentic `create_card` write
   * resolves so newly-generated cards appear app-wide. Thin GET-and-merge; no
   * data-model change. Silently no-ops on error.
   */
  refetchDeckCards: (deckId: string) => Promise<void>;

  /** Fetch own + builtin note-types (GET /note-types) into the store. */
  getNoteTypes: () => Promise<NoteType[]>;

  /** Create a user-owned note-type (POST /note-types). Appends to the mirror. */
  addNoteType: (def: {
    name: string;
    fields: NoteField[];
    templates: CardTemplate[];
    styling?: string;
    kind?: RenderKind;
  }) => Promise<NoteType>;

  /**
   * Edit a note-type (PATCH /note-types/:id). CLONE-ON-EDIT: editing a global
   * builtin makes the server return a NEW user-owned copy with a DIFFERENT id —
   * we append the clone (the builtin stays in the list) and return it. Editing
   * an owned type returns the same id and we replace it in the mirror.
   */
  updateNoteType: (
    id: string,
    patch: {
      name?: string;
      fields?: NoteField[];
      templates?: CardTemplate[];
      styling?: string;
      kind?: RenderKind;
      answerFieldId?: string;
      expectedUpdatedAt?: string;
      confirmationToken?: string;
    },
  ) => Promise<NoteType>;

  convertNotes: (input: NoteConversionInput) => Promise<Card[]>;

  /** Delete an own note-type (DELETE /note-types/:id). Cascades notes+cards. */
  deleteNoteType: (id: string, confirmationToken: string) => Promise<void>;

  /**
   * Search cards via the server (GET /cards/search). Maps rows via cardFromApi,
   * merges returned items into the mirror (dedupe by id), returns typed results.
   * Eden key is `query` — NOT `$query` (Architect must-fix #2).
   */
  searchCards: (
    q: string,
    opts?: { sort?: string; cursor?: string; limit?: string; noteTypeId?: string },
  ) => Promise<{ items: Card[]; nextCursor: string | null }>;

  /**
   * Bulk operation on a set of card ids (POST /cards/bulk). Applies the same
   * mutation to the in-memory mirror so the UI updates without a reload.
   */
  bulkCards: (
    action: BulkAction,
    cardIds: string[],
    payload?: { deckId?: string; tag?: string; setDue?: string },
  ) => Promise<void>;

  /**
   * Fetch the distinct tag universe from the server (GET /cards/tags). Caches
   * the result in `cardTags` on the store. Call after tag bulk-ops to refresh.
   */
  getCardTags: () => Promise<string[]>;

  gradeCard: (cardId: string, rating: Rating, durationMs: number, source?: 'regular' | 'filtered', displayedCard?: Card, operationId?: string) => Promise<Review & { card: Card }>;

  /**
   * Undo the user's most recent grade (POST /reviews/undo). Restores the card +
   * profile in the in-memory mirror to their pre-grade state. Returns the
   * restored card id on success; throws on 404 (nothing to undo) / 409 (card
   * modified since the grade) so callers can surface the right toast.
   */
  undoLastReview: (reviewId?: string, displayedCard?: Card) => Promise<{ cardId: string; card: Card; reviewId: string }>;
  updateProfile: (patch: Partial<Omit<Profile, 'id'>>) => Promise<void>;

  /** Create a preset (POST /deck-options). Appends to the mirror. */
  addPreset: (input: {
    name: string;
    newPerDay: number;
    reviewsPerDay: number;
    learningSteps: string[];
    relearningSteps: string[];
    desiredRetention?: number | null;
    leechThreshold: number;
    maximumInterval: number;
  }) => Promise<DeckOptionsPreset>;

  /** Update a preset (PATCH /deck-options/:id). Replaces in the mirror. */
  updatePreset: (
    id: string,
    patch: Partial<{
      name: string;
      newPerDay: number;
      reviewsPerDay: number;
      learningSteps: string[];
      relearningSteps: string[];
      desiredRetention: number | null;
      leechThreshold: number;
      maximumInterval: number;
    }>,
  ) => Promise<DeckOptionsPreset>;

  /**
   * Delete a preset (DELETE /deck-options/:id). Returns the count of decks
   * whose presetId was SET NULL by the server (they revert to defaults).
   */
  deletePreset: (id: string) => Promise<{ affectedDecks: number }>;

  /**
   * Bind (or unbind) a preset to a deck (PATCH /decks/:id { presetId }).
   * Pass null to unbind (revert to defaults).
   */
  bindDeckPreset: (deckId: string, presetId: string | null) => Promise<void>;

  /** Create a filtered deck (POST /filtered-decks). Appends to the mirror. */
  addFilteredDeck: (input: {
    name: string;
    query: string;
    sortOrder: FilteredDeckSortOrder;
    cardLimit: number;
    includeSuspended: boolean;
  }) => Promise<FilteredDeck>;

  /** Update a filtered deck (PATCH /filtered-decks/:id). Replaces in the mirror. */
  updateFilteredDeck: (
    id: string,
    patch: Partial<{
      name: string;
      query: string;
      sortOrder: FilteredDeckSortOrder;
      cardLimit: number;
      includeSuspended: boolean;
    }>,
  ) => Promise<FilteredDeck>;

  /** Delete a filtered deck (DELETE /filtered-decks/:id). Removes from mirror. */
  deleteFilteredDeck: (id: string) => Promise<void>;

  /**
   * Upload an image to S3 (M2 Phase 4). Three-step (plan Decision A1): presign →
   * direct multipart POST to S3 (bytes never touch Bun) → finalize. Returns the
   * relative media token `/m/{uuid}` to embed as markdown (the only img-src
   * shape the dual-edge sanitizer keeps). Display resolves that token through
   * the session-checked media route. Plus the media id.
   */
  uploadMedia: (file: File) => Promise<{ token: string; mediaId: string }>;

  // ── NotebookLM sources (M1) ──────────────────────────────────────────────────
  // Lazy, screen-local data (like chat conversations — NOT part of the bootstrap
  // mirror), so these are thin Eden pass-throughs that return server rows; the
  // /notebooks screen owns the list state + polling.

  /** List the user's notebooks (GET /notebooks). Pinned-first, recency-second;
   *  pass `{ archived: true }` for the archive shelf. Rows carry grid counts. */
  listNotebooks: (params?: { archived?: boolean }) => Promise<Notebook[]>;
  /** Create a notebook (POST /notebooks). */
  createNotebook: (title: string) => Promise<Notebook>;
  /** Rename a notebook (PATCH /notebooks/:id) — title-only convenience. */
  renameNotebook: (id: string, title: string) => Promise<Notebook>;
  /** One notebook's full row (GET /notebooks/:id) — incl. metadata. */
  getNotebook: (id: string) => Promise<Notebook>;
  /** GET /notebooks/:id/plan. A missing plan is null. Any other failure throws. */
  getNotebookPlan: (id: string) => Promise<unknown | null>;
  /** POST /notebooks/:id/plan/modules/:moduleId/open. Same payload as GET. */
  openNotebookPlanModule: (id: string, moduleId: string) => Promise<unknown | null>;
  /** Patch notebook metadata (PATCH /notebooks/:id) — title/emoji/color/
   *  description/pinned/archived (Р13). Empty patch is a no-op (returns the row). */
  patchNotebook: (id: string, patch: NotebookPatch) => Promise<Notebook>;
  /** Delete a notebook + its sources (DELETE /notebooks/:id). */
  deleteNotebook: (id: string) => Promise<void>;

  // ── Notebook notes (Р1/Р7, N1) ───────────────────────────────────────────────
  /** List a notebook's notes (GET /notebooks/:id/notes) — pinned-first, opt `q`. */
  getNotebookNote: (notebookId: string, noteId: string) => Promise<NotebookNote>;
  listNotebookNotes: (notebookId: string, q?: string) => Promise<NotebookNote[]>;
  /** Create a note (POST /notebooks/:id/notes). */
  createNotebookNote: (notebookId: string, input: CreateNoteInput) => Promise<NotebookNote>;
  /** Patch a note (PATCH /notebooks/:id/notes/:noteId) — title?/content?/pinned?. */
  patchNotebookNote: (
    notebookId: string,
    noteId: string,
    patch: { title?: string; content?: string; pinned?: boolean },
  ) => Promise<NotebookNote>;
  /** Delete a note (DELETE /notebooks/:id/notes/:noteId). */
  deleteNotebookNote: (notebookId: string, noteId: string) => Promise<void>;

  // ── Notebook studio: artifacts + overview (N2) ────────────────────────────────
  /** List a notebook's artifacts — LIGHT (no content) (GET …/artifacts). */
  listArtifacts: (notebookId: string) => Promise<NotebookArtifact[]>;
  /** Create an artifact job (POST …/artifacts). The optional `sourceIds` scope is
   *  intersected with the notebook's ready sources server-side. Throws on
   *  400 invalid_type/no_sources or 409 too_many_artifacts/generation_in_progress
   *  (the caller maps the error code to a toast). */
  createArtifact: (
    notebookId: string,
    type: NotebookArtifactType,
    sourceIds?: string[],
    /** quiz only (N3): how many questions to generate (server clamps to the
     *  QUIZ_QUESTIONS_MAX cap). Ignored for markdown types. */
    questionCount?: number,
  ) => Promise<NotebookArtifact>;
  /** Fetch one full artifact incl. content (GET …/artifacts/:artifactId). */
  getArtifact: (notebookId: string, artifactId: string) => Promise<NotebookArtifact>;
  /** Delete an artifact (DELETE …/artifacts/:artifactId). */
  deleteArtifact: (notebookId: string, artifactId: string) => Promise<void>;
  /** Re-run an artifact's generation, keeping its source snapshot (POST
   *  …/artifacts/:artifactId/regenerate). Throws on 409 not_terminal /
   *  generation_in_progress. */
  regenerateArtifact: (notebookId: string, artifactId: string) => Promise<NotebookArtifact>;
  /** Generate the notebook overview + suggested questions (POST …/overview).
   *  Throws on 400 no_sources / 503 ai_disabled / 502 overview_failed. */
  generateOverview: (
    notebookId: string,
  ) => Promise<{ overview: string; questions: string[]; fingerprint: string }>;
  /** Submit a quiz attempt (POST …/artifacts/:artifactId/attempts). The server
   *  re-scores mcq/tf from `content_json`; `open` trusts the `{ selfCorrect }`
   *  self-grade. Throws on 400 invalid_attempt / 404. */
  submitQuizAttempt: (
    notebookId: string,
    artifactId: string,
    answers: QuizAttemptAnswerInput[],
  ) => Promise<QuizAttempt>;
  /** List a quiz artifact's recent attempts — last 10, newest-first (GET
   *  …/artifacts/:artifactId/attempts). */
  listQuizAttempts: (notebookId: string, artifactId: string) => Promise<QuizAttempt[]>;
  /** Card-coverage of the notebook's attached sources (GET …/coverage). SQL-only
   *  — works without a chat key. */
  getCoverage: (notebookId: string) => Promise<NotebookCoverage>;
  /** Sectional concept-map of the notebook (GET …/concept-map). Vectors-only —
   *  works without a chat key; degrades to `{nodes:[],edges:[],reason}`. */
  conceptMap: (notebookId: string) => Promise<ConceptMapResult>;
  /** Recommend other library sources near the notebook's centroid (GET
   *  …/suggest-sources). Vectors-only; degrades to `{items:[],reason?}`. */
  suggestSources: (notebookId: string) => Promise<SuggestSourcesResult>;

  /** List a notebook's sources with computed indexing progress (GET /notebooks/:id/sources). */
  listSources: (notebookId: string) => Promise<Source[]>;
  /** Add a url source (POST /notebooks/:id/sources, kind:'url') + enqueue. */
  addUrlSource: (notebookId: string, title: string, url: string) => Promise<Source>;
  /** Add an inline text source (POST /notebooks/:id/sources, kind:'text') + enqueue. */
  addTextSource: (notebookId: string, title: string, text: string) => Promise<Source>;
  /**
   * Upload a pdf/epub source file: claim+presign → direct POST to S3 → finalize
   * (MIRRORS uploadMedia, but on the source claim-presign endpoint). The server
   * enqueues ingest on finalize. Returns the finalized source row.
   */
  uploadSource: (
    notebookId: string,
    file: File,
    title: string,
    mime: SourceMime,
  ) => Promise<Source>;
  /** Poll one source's status + computed progress (GET /sources/:id). */
  getSource: (id: string) => Promise<Source>;
  /** Rename a source (PATCH /sources/:id). */
  renameSource: (id: string, title: string) => Promise<Source>;
  /** Soft-delete a source + clean its index (DELETE /sources/:id). */
  deleteSource: (id: string) => Promise<void>;
  /** Read a page of a source's parsed chunks for the reader (GET /sources/:id/chunks). */
  getSourceChunks: (id: string, from?: number, limit?: number) => Promise<SourceChunkPage>;
  /** List the cards generated from a source (GET /sources/:id/cards). */
  listSourceCards: (id: string) => Promise<SourceLinkedCard[]>;

  // ── «Урожай выделений → карточки» (feature #2) ───────────────────────────────
  /** Generate card candidates from the source's UNHARVESTED markup (POST
   *  /sources/:id/harvest-cards). `locale` rides into the prompt (cards in the
   *  user's language). 503 ai_disabled / 429 cooldown / 502 harvest_failed map
   *  to a toast; an empty result means nothing left to harvest. */
  harvestCards: (sourceId: string, locale?: 'en' | 'ru') => Promise<HarvestCandidate[]>;
  /** Apply the wizard's selection (POST /sources/:id/harvest-cards/apply) — one
   *  tx creating the chosen cards + provenance + stamping harvested_at on their
   *  origin markings. Returns the created card ids. */
  applyHarvest: (
    sourceId: string,
    body: { deckId: string; cards: HarvestCandidate[] },
  ) => Promise<{ created: number; cardIds: string[] }>;

  // ── Library (L1) — the user-level material store (GET/POST/PATCH/DELETE /library) ──
  /** Paginated material list + filters (GET /library). */
  listLibrary: (params?: LibraryQuery) => Promise<{ items: LibraryItem[]; nextCursor: string | null }>;
  /** Semantic search across the library (GET /library/search). */
  searchLibrary: (q: string, limit?: number) => Promise<LibrarySearchResult>;
  /** One item: metadata + status + attached notebooks + cardCount (GET /library/items/:id). */
  getLibraryItem: (id: string) => Promise<LibraryItemDetail>;
  /** Inline url/text create (POST /library/items, + optional immediate attach). */
  addLibraryUrl: (title: string, url: string, notebookId?: string) => Promise<LibraryItem>;
  /** Inline text create (POST /library/items kind:'text', + optional attach). */
  addLibraryText: (title: string, text: string, notebookId?: string) => Promise<LibraryItem>;
  /**
   * Upload a pdf/epub into the library: claim+presign → direct POST to S3 →
   * finalize (MIRRORS uploadSource). 409 duplicate_source rejects with an
   * `existingSourceId` field the screen can surface. Optional notebook attach.
   */
  uploadLibraryItem: (
    file: File,
    title: string,
    mime: SourceMime,
    notebookId?: string,
  ) => Promise<LibraryItem>;
  /** Edit item metadata (PATCH /library/items/:id) — title/author/tags/readingStatus. */
  patchLibraryItem: (id: string, patch: LibraryPatch) => Promise<LibraryItem>;
  /** Full source delete (DELETE /library/items/:id) — edges cascade, card tombstones. */
  deleteLibraryItem: (id: string) => Promise<void>;
  /** Re-run ingest (POST /library/items/:id/reingest). Throws on 409 not_terminal
   *  / 400 not_reingestable (text) — the caller maps to a toast. */
  reingestLibraryItem: (id: string) => Promise<void>;
  /** Upsert reading position/percent (PUT /library/items/:id/reading-state). Best-
   *  effort; unread→reading flips server-side. */
  putReadingState: (id: string, state: ReadingStatePatch) => Promise<void>;

  // ── Notebook ↔ source attach/detach (L1 §4.2) ─────────────────────────────────
  /** Attach existing library sources to a notebook (POST /notebooks/:id/sources/attach). */
  attachSources: (notebookId: string, sourceIds: string[]) => Promise<void>;
  /** Detach a source from a notebook — NOT a delete (DELETE /notebooks/:id/sources/:sourceId). */
  detachSource: (notebookId: string, sourceId: string) => Promise<void>;
}

/** Filters for the /library list. */
export interface LibraryQuery {
  q?: string;
  kind?: SourceKind;
  tag?: string;
  reading?: ReadingStatus;
  shelf?: 'reading' | 'unattached';
  sort?: 'added' | 'title' | 'lastRead';
  limit?: number;
  cursor?: string;
}

/** Reading-position upsert body (PUT /library/items/:id/reading-state). */
export interface ReadingStatePatch {
  page?: number;
  chunkPos?: number;
  percent?: number;
}

/** Editable library metadata (explicit-field PATCH). */
export interface LibraryPatch {
  coverMediaId?: string;
  pageCount?: number;
  title?: string;
  author?: string;
  description?: string;
  tags?: string[];
  readingStatus?: ReadingStatus;
}

/** Editable notebook metadata (explicit-field PATCH, Р13). `null` clears
 *  emoji/color/description. */
export interface NotebookPatch {
  title?: string;
  emoji?: string | null;
  color?: NotebookColor | null;
  description?: string | null;
  pinned?: boolean;
  archived?: boolean;
}

/** New-note body (POST /notebooks/:id/notes). `kind`/`citations`/`messageId`
 *  ride only the «save chat answer» path (Р7). */
export interface CreateNoteInput {
  title: string;
  content: string;
  kind?: NotebookNoteKind;
  citations?: unknown[] | null;
  messageId?: string;
}

/** A 409 duplicate_source on library upload carries the existing source id. */
export class DuplicateSourceError extends Error {
  existingSourceId: string;
  constructor(existingSourceId: string) {
    super('duplicate_source');
    this.name = 'DuplicateSourceError';
    this.existingSourceId = existingSourceId;
  }
}

/** A 409 library_full on library create/upload (per-user cap reached). */
export class LibraryFullError extends Error {
  constructor() {
    super('library_full');
    this.name = 'LibraryFullError';
  }
}

/** A 429 cooldown from a paid AI endpoint (overview/suggest-card, P1) — the web
 *  maps it to an info ("wait a moment") toast, NOT an error. */
export class CooldownError extends Error {
  retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super('cooldown');
    this.name = 'CooldownError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** True when an unknown error is a CooldownError (cross-bundle-safe name check). */
export function isCooldownError(err: unknown): err is CooldownError {
  return err instanceof CooldownError || (err instanceof Error && err.name === 'CooldownError');
}

let bootstrapPromise: Promise<void> | null = null;
let bootstrapGeneration = 0;

/** Account epoch bumped by reset(). Screen-local caches compare it around awaits. */
export function mirrorAccountGeneration(): number {
  return bootstrapGeneration;
}
let typeMutationSequence = 0;
const latestTypeMutation = new Map<string, number>();
let cardReadGeneration = 0;

async function mergeNoteTypeResult(updated: NoteType, id: string, current: () => boolean, get: () => State, set: (update: (state: State) => Partial<State>) => void, refreshCards = true) {
    cardReadGeneration += 1;
    const refreshed = new Map<string, Card>();
    if (refreshCards && updated.id === id) {
      const loadedIds = get().cards.filter((card) => card.noteType?.id === id).map((card) => card.id);
      const reads: Promise<any>[] = [(api as any).cards.get({ query: { noteTypeId: id, includeSuspended: 'true' } }).then(ok)];
      for (let offset = 0; offset < loadedIds.length; offset += 200) {
        reads.push((api as any).cards.lookup.post({ ids: loadedIds.slice(offset, offset + 200) }).then(ok));
      }
      for (const result of await Promise.allSettled(reads)) {
        if (result.status === 'fulfilled') for (const row of result.value.items ?? []) {
          const card = cardFromApi(row); refreshed.set(card.id, card);
        }
      }
      if (!current()) return updated;
    }
    // Clone-on-edit: editing a global builtin returns a NEW id (a user-owned
    // copy). The original builtin stays in the list; we append the clone.
    // Editing an owned type returns the same id and we replace it in place.
    set((s) => {
      const exists = s.noteTypes.some((nt) => nt.id === updated.id);
      return {
        ...(refreshCards && updated.id === id ? { cards: [...s.cards.filter((card) => card.noteType?.id !== id), ...refreshed.values()] } : {}),
        noteTypes: exists
          ? s.noteTypes.map((nt) => (nt.id === updated.id ? updated : nt))
          : [...s.noteTypes, updated],
      };
    });
    if (current()) latestTypeMutation.delete(id);
    return updated;
}

export const useNN = create<State>()((set, get) => ({
  bootstrapped: false,
  bootstrapStatus: 'idle',
  bootstrapError: null,
  decks: [],
  cards: [],
  noteTypes: [],
  presets: [],
  filteredDecks: [],
  profile: null,
  cardTags: [],

  async bootstrap() {
    if (get().bootstrapped) return;
    if (bootstrapPromise) return bootstrapPromise;
    const generation = bootstrapGeneration;
    set((state) => ({
      bootstrapStatus: state.bootstrapped ? 'refreshing' : 'loading',
      bootstrapError: null,
    }));
    // Parallel fetch of the user's snapshot. /cards is cursor-paginated;
    // bootstrap takes the first page (500 most recent cards). If the user has
    // more, we load on-demand later — all current UI fits in one page. Note-
    // types (own + global builtins) load too so the note editor can pick one.
    // Presets (deck-options) are also fetched here so the settings editor and
    // per-deck binding are immediately available.
    let request!: Promise<void>;
    request = (async () => {
      try {
        const [profile, decks, cardsPage, noteTypes, presetsRes, filteredDecksRes] = await Promise.all([
          ok(await (api as any).profile.get()),
          ok(await (api as any).decks.get()),
          ok(await (api as any).cards.get()),
          ok(await (api as any)['note-types'].get()),
          ok(await (api as any)['deck-options'].get()),
          ok(await (api as any)['filtered-decks'].get()),
        ]);
        if (generation !== bootstrapGeneration) return;
        const cardRows = Array.isArray(cardsPage)
          ? cardsPage
          : ((cardsPage as { items: unknown[] }).items ?? []);
        set({
          profile: profileFromApi(profile),
          decks: (decks as any[]).map(deckFromApi),
          cards: (cardRows as any[]).map(cardFromApi),
          noteTypes: (noteTypes as any[]).map(noteTypeFromApi),
          presets: (presetsRes as any[]).map(presetFromApi),
          filteredDecks: (filteredDecksRes as any[]).map(filteredDeckFromApi),
          bootstrapped: true,
          bootstrapStatus: 'ready',
          bootstrapError: null,
        });
      } catch (error) {
        if (generation === bootstrapGeneration) {
          set({ bootstrapStatus: 'error', bootstrapError: toApiError(error) });
        }
        throw error;
      } finally {
        if (bootstrapPromise === request) bootstrapPromise = null;
      }
    })();
    bootstrapPromise = request;
    return request;
  },

  reset() {
    cardReadGeneration += 1;
    latestTypeMutation.clear();
    clearStudyHandoff();
    // Server is source of truth — blow away the local mirror and let bootstrap
    // repopulate on next mount.
    bootstrapGeneration += 1;
    bootstrapPromise = null;
    set({
      decks: [],
      cards: [],
      noteTypes: [],
      presets: [],
      filteredDecks: [],
      profile: null,
      cardTags: [],
      bootstrapped: false,
      bootstrapStatus: 'idle',
      bootstrapError: null,
    });
  },

  async addDeck(input) {
    const generation = bootstrapGeneration;
    const created = deckFromApi(
      await ok(
        await (api as any).decks.post({
          name: input.name,
          color: input.color,
          icon: input.icon,
          parentId: input.parentId,
        }),
      ),
    );
    if (generation === bootstrapGeneration) set((s) => ({ decks: [...s.decks, created] }));
    return created;
  },

  async updateDeck(id, patch) {
    const generation = bootstrapGeneration;
    const updated = deckFromApi(await ok(await (api as any).decks({ id }).patch(patch)));
    if (generation === bootstrapGeneration) set((s) => ({ decks: s.decks.map((d) => (d.id === id ? updated : d)) }));
  },

  async moveDeck(id, targetId, placement) {
    const generation = bootstrapGeneration;
    const ownerId = get().profile?.userId;
    const rows = await ok(await (api as any).decks({ id }).move.post({ targetId, placement })) as any[];
    if (generation !== bootstrapGeneration || get().profile?.userId !== ownerId) return;
    set({ decks: rows.map(deckFromApi) });
  },

  async deleteDeck(id) {
    const generation = bootstrapGeneration;
    await ok(await (api as any).decks({ id }).delete());
    if (generation !== bootstrapGeneration) return;
    // Drop this deck + any local descendants + any cards under them. The server
    // cascades via FK ON DELETE CASCADE, we mirror that in the cache.
    const all = get().decks;
    const queue = [id];
    const removed = new Set<string>();
    while (queue.length) {
      const cur = queue.shift()!;
      if (removed.has(cur)) continue;
      removed.add(cur);
      for (const d of all) if (d.parentId === cur) queue.push(d.id);
    }
    set((s) => ({
      decks: s.decks.filter((d) => !removed.has(d.id)),
      cards: s.cards.filter((c) => !removed.has(c.deckId)),
    }));
  },

  acceptRecoveredNote(owner, result) {
    if (get().profile?.userId !== owner) return [];
    if (!result?.note?.id || !Array.isArray(result.cards)) throw new Error('invalid_note_result');
    const noteType = get().noteTypes.find(type => type.id === result.note.noteTypeId)
      ?? get().cards.find(card => card.noteId === result.note.id)?.noteType;
    const updated = result.cards.map((row: any) => cardFromApi({ ...row, note: result.note, noteType }));
    cardReadGeneration += 1;
    set(state => ({ cards: [...state.cards.filter(card => card.noteId !== result.note.id), ...updated] }));
    return updated;
  },

  async acceptRecoveredType(owner, updated, originalId) {
    const id = originalId ?? updated.id;
    const generation = bootstrapGeneration, operation = ++typeMutationSequence;
    latestTypeMutation.set(id, operation);
    const current = () => generation === bootstrapGeneration && get().profile?.userId === owner && latestTypeMutation.get(id) === operation;
    if (!current()) return updated;
    return mergeNoteTypeResult(updated, id, current, get, set, Boolean(originalId));
  },

  async addNote(input) {
    const generation = bootstrapGeneration;
    // POST /notes → server generates cards from the note-type templates and
    // returns the enriched cards (each carrying its embedded note + noteType).
    const res: any = await ok(
      await (api as any).notes.post({
        noteTypeId: input.noteTypeId,
        expectedTypeUpdatedAt: input.expectedTypeUpdatedAt,
        deckId: input.deckId,
        fieldValues: input.fieldValues,
        acceptedAnswers: input.acceptedAnswers,
        tags: input.tags,
      }),
    );
    const noteType = get().noteTypes.find((type) => type.id === res.note.noteTypeId);
    const created: Card[] = ((res.cards ?? []) as any[]).map((row) => cardFromApi({ ...row, note: res.note, noteType }));
    if (generation !== bootstrapGeneration) return created;
    set((s) => ({ cards: [...s.cards, ...created] }));
    return created;
  },

  async updateNote(noteId, patch) {
    const generation = bootstrapGeneration;
    const body: any = {};
    if (patch.acceptedAnswers !== undefined) body.acceptedAnswers = patch.acceptedAnswers;
    if (patch.fieldValues !== undefined) body.fieldValues = patch.fieldValues;
    if (patch.tags !== undefined) body.tags = patch.tags;
    if (patch.deckId !== undefined) body.deckId = patch.deckId;
    if (patch.expectedUpdatedAt !== undefined) body.expectedUpdatedAt = patch.expectedUpdatedAt;
    if (patch.expectedTypeUpdatedAt !== undefined) body.expectedTypeUpdatedAt = patch.expectedTypeUpdatedAt;
    if (patch.confirmationToken !== undefined) body.confirmationToken = patch.confirmationToken;
    if (patch.clozeRetainHistoryFor !== undefined) body.clozeRetainHistoryFor = patch.clozeRetainHistoryFor;
    const res: any = await ok(await (api as any).notes({ id: noteId }).patch(body));
    const noteType = get().noteTypes.find((type) => type.id === res.note.noteTypeId)
      ?? get().cards.find((card) => card.noteId === noteId)?.noteType;
    const updated: Card[] = ((res.cards ?? []) as any[]).map((row) => cardFromApi({ ...row, note: res.note, noteType }));
    if (generation !== bootstrapGeneration) return updated;
    // Replace this note's cards in the mirror (regeneration may add/remove).
    set((s) => {
      const kept = s.cards.filter((c) => c.noteId !== noteId);
      return { cards: [...kept, ...updated] };
    });
    return updated;
  },

  async deleteNote(noteId) {
    const generation = bootstrapGeneration;
    await ok(await (api as any).notes({ id: noteId }).delete());
    if (generation !== bootstrapGeneration) return;
    set((s) => ({ cards: s.cards.filter((c) => c.noteId !== noteId) }));
  },

  async listCardlessNotes() {
    const res = await ok(await (api as any).notes.cardless.get());
    return res as { total: number; items: CardlessNote[] };
  },

  async restoreCardlessNote(noteId, deckId) {
    const generation = bootstrapGeneration;
    const res: any = await ok(await (api as any).notes({ id: noteId }).restore.post({ deckId }));
    const noteType = get().noteTypes.find((type) => type.id === res.note.noteTypeId);
    const created: Card[] = ((res.cards ?? []) as any[]).map((row) => cardFromApi({ ...row, note: res.note, noteType }));
    if (generation !== bootstrapGeneration) return created;
    set((s) => ({ cards: [...s.cards, ...created] }));
    return created;
  },

  async deleteCard(id) {
    const generation = bootstrapGeneration;
    await ok(await (api as any).cards({ id }).delete());
    if (generation !== bootstrapGeneration) return;
    set((s) => ({ cards: s.cards.filter((c) => c.id !== id) }));
  },

  async forgetCard(id) {
    const generation = bootstrapGeneration;
    const updated = mergeReviewedCard(await ok(await (api as any).cards({ id }).patch({ forget: true })), get().cards.find((c) => c.id === id));
    if (generation !== bootstrapGeneration) return;
    set((s) => ({ cards: s.cards.map((c) => (c.id === updated.id ? updated : c)) }));
  },

  async setCardDue(id, iso) {
    const generation = bootstrapGeneration;
    const updated = mergeReviewedCard(await ok(await (api as any).cards({ id }).patch({ setDue: iso })), get().cards.find((c) => c.id === id));
    if (generation !== bootstrapGeneration) return;
    set((s) => ({ cards: s.cards.map((c) => (c.id === updated.id ? updated : c)) }));
  },

  async refetchCard(id) {
    const generation = cardReadGeneration;
    const account = bootstrapGeneration;
    try {
      const updated = cardFromApi(await ok(await (api as any).cards({ id }).get()));
      if (generation !== cardReadGeneration || account !== bootstrapGeneration) return;
      set((s) => {
        const exists = s.cards.some((c) => c.id === updated.id);
        return {
          cards: exists
            ? s.cards.map((c) => (c.id === updated.id ? updated : c))
            : [...s.cards, updated],
        };
      });
    } catch {
      // Card deleted / foreign / chat-applied write that removed it — no-op.
    }
  },

  async refetchDeckCards(deckId) {
    const generation = cardReadGeneration;
    const account = bootstrapGeneration;
    try {
      // GET /cards?deckId=… is cursor-paginated ({ items, nextCursor }) but the
      // first page (≤500) is enough to surface freshly-created cards in the
      // mirror; deeper pages load on-demand elsewhere (same contract bootstrap uses).
      const page: any = await ok(await (api as any).cards.get({ query: { deckId } }));
      if (generation !== cardReadGeneration || account !== bootstrapGeneration) return;
      const rows = Array.isArray(page) ? page : (page?.items ?? []);
      const fresh: Card[] = (rows as any[]).map(cardFromApi);
      if (fresh.length === 0) return;
      set((s) => {
        const byId = new Map(s.cards.map((c) => [c.id, c]));
        for (const c of fresh) byId.set(c.id, c);
        return { cards: [...byId.values()] };
      });
    } catch {
      // Deck gone / foreign — no-op (the chat answer still rendered).
    }
  },

  async getNoteTypes() {
    const generation = bootstrapGeneration;
    const rows: any = await ok(await (api as any)['note-types'].get());
    const list: NoteType[] = (rows as any[]).map(noteTypeFromApi);
    if (generation === bootstrapGeneration) set({ noteTypes: list });
    return list;
  },

  async addNoteType(def) {
    const generation = bootstrapGeneration;
    const created = noteTypeFromApi(
      await ok(
        await (api as any)['note-types'].post({
          name: def.name,
          fields: def.fields,
          templates: def.templates,
          styling: def.styling ?? '',
          kind: def.kind ?? 'custom',
        }),
      ),
    );
    if (generation === bootstrapGeneration) set((s) => ({ noteTypes: [...s.noteTypes, created] }));
    return created;
  },

  async updateNoteType(id, patch) {
    const generation = bootstrapGeneration;
    const operation = ++typeMutationSequence;
    latestTypeMutation.set(id, operation);
    const current = () => generation === bootstrapGeneration && latestTypeMutation.get(id) === operation;
    const body: any = {};
    if (patch.name !== undefined) body.name = patch.name;
    if (patch.fields !== undefined) body.fields = patch.fields;
    if (patch.templates !== undefined) body.templates = patch.templates;
    if (patch.styling !== undefined) body.styling = patch.styling;
    if (patch.kind !== undefined) body.kind = patch.kind;
    if (patch.answerFieldId !== undefined) body.answerFieldId = patch.answerFieldId;
    if (patch.expectedUpdatedAt !== undefined) body.expectedUpdatedAt = patch.expectedUpdatedAt;
    if (patch.confirmationToken !== undefined) body.confirmationToken = patch.confirmationToken;
    const updated = noteTypeFromApi(
      await ok(await (patch.kind !== undefined
        ? (api as any)['note-types']({ id }).kind.post(body)
        : (api as any)['note-types']({ id }).patch(body))),
    );
    if (!current()) return updated;
    return mergeNoteTypeResult(updated, id, current, get, set);
  },

  async convertNotes(input) {
    const generation = bootstrapGeneration;
    const result: any = await ok(await (api as any).notes.convert.post(input));
    const converted = (result.cards ?? []).map(cardFromApi) as Card[];
    if (generation !== bootstrapGeneration) return converted;
    cardReadGeneration += 1;
    const noteIds = new Set<string>(result.noteIds);
    set((state) => ({ cards: [...state.cards.filter((card) => !noteIds.has(card.noteId)), ...converted] }));
    return converted;
  },

  async deleteNoteType(id, confirmationToken) {
    const generation = bootstrapGeneration;
    const operation = ++typeMutationSequence;
    latestTypeMutation.set(id, operation);
    await ok(await (api as any)['note-types']({ id }).delete({ confirmationToken }));
    if (generation !== bootstrapGeneration || latestTypeMutation.get(id) !== operation) return;
    cardReadGeneration += 1;
    set((s) => ({ noteTypes: s.noteTypes.filter((nt) => nt.id !== id), cards: s.cards.filter((card) => card.noteType?.id !== id) }));
    latestTypeMutation.delete(id);
  },

  async searchCards(q, opts) {
    const generation = cardReadGeneration;
    const account = bootstrapGeneration;
    const res: any = await ok(
      await (api as any).cards.search.get({
        query: {
          q,
          noteTypeId: opts?.noteTypeId,
          sort: opts?.sort,
          cursor: opts?.cursor,
          limit: opts?.limit,
        },
      }),
    );
    const items: Card[] = (res.items as any[]).map(cardFromApi);
    if (generation !== cardReadGeneration || account !== bootstrapGeneration) return { items, nextCursor: res.nextCursor ?? null };
    // Merge into mirror: update existing by id, append new.
    set((s) => {
      const byId = new Map(s.cards.map((c) => [c.id, c]));
      for (const c of items) byId.set(c.id, c);
      return { cards: [...byId.values()] };
    });
    return { items, nextCursor: res.nextCursor ?? null };
  },

  async bulkCards(action, cardIds, payload) {
    const generation = bootstrapGeneration;
    const result: any = await ok(await (api as any).cards.bulk.post({ action, cardIds, payload }));
    if (generation !== bootstrapGeneration) return;
    if (action === 'forget' || action === 'setDue') {
      set((state) => {
        const byId = new Map(state.cards.map((card) => [card.id, card]));
        for (const row of result.cards ?? []) byId.set(row.id, mergeReviewedCard(row, byId.get(row.id)));
        return { cards: [...byId.values()] };
      });
      return;
    }
    // Mirror the same mutation locally so the UI reflects immediately.
    const idSet = new Set(cardIds);
    // Tags are NOTE-level: the server mutates notes.tags for the notes of the
    // selected cards, so the mirror must update EVERY card sharing one of those
    // notes (multi-template siblings), not just the selected card ids.
    const noteIdSet = new Set(
      get().cards.filter((c) => idSet.has(c.id)).map((c) => c.noteId),
    );
    set((s) => {
      switch (action) {
        case 'move': {
          const deckId = payload?.deckId;
          if (!deckId) return s;
          return {
            cards: s.cards.map((c) => (idSet.has(c.id) ? { ...c, deckId } : c)),
          };
        }
        case 'delete':
          return { cards: s.cards.filter((c) => !idSet.has(c.id)) };
        case 'suspend':
          return {
            cards: s.cards.map((c) => (idSet.has(c.id) ? { ...c, suspended: true } : c)),
          };
        case 'unsuspend':
          return {
            cards: s.cards.map((c) => (idSet.has(c.id) ? { ...c, suspended: false } : c)),
          };
        case 'addTag': {
          const parsed = payload?.tag === undefined ? null : normalizeNoteTags(payload.tag);
          if (!parsed?.ok || parsed.tags.length === 0) return s;
          return {
            cards: s.cards.map((c) => {
              if (!noteIdSet.has(c.noteId)) return c;
              const next = [...c.tags];
              for (const tag of parsed.tags) if (!next.includes(tag)) next.push(tag);
              return next.length === c.tags.length ? c : { ...c, tags: next };
            }),
          };
        }
        case 'removeTag': {
          const parsed = payload?.tag === undefined ? null : normalizeNoteTags(payload.tag);
          if (!parsed?.ok || parsed.tags.length === 0) return s;
          const drop = new Set(parsed.tags);
          return {
            cards: s.cards.map((c) =>
              noteIdSet.has(c.noteId) ? { ...c, tags: c.tags.filter((tag) => !drop.has(tag)) } : c,
            ),
          };
        }
      }
    });
  },

  async getCardTags() {
    const generation = bootstrapGeneration;
    const res: any = await ok(await (api as any).cards.tags.get());
    const tags: string[] = res.tags ?? [];
    if (generation === bootstrapGeneration) set({ cardTags: tags });
    return tags;
  },

  async gradeCard(cardId, rating, durationMs, source, displayedCard, operationId) {
    const generation = bootstrapGeneration;
    const previous = displayedCard ?? get().cards.find((c) => c.id === cardId);
    const body: Record<string, unknown> = { cardId, rating, durationMs };
    if (source) body.source = source;
    if (previous) {
      body.expectedReps = previous.fsrs.reps;
      body.expectedUpdatedAt = new Date(previous.updatedAt).toISOString();
    }
    const res: any = await ok(
      await (operationId ? (api as any).reviews.operations({operationId}).post(body) : (api as any).reviews.post(body)),
    );
    // A receipt is immutable, but the live card/profile can have changed since
    // that commit. Never roll the client mirror back to a replayed response.
    if(res.replayed) {
      const [liveCard,liveProfile]=await Promise.all([ok(await (api as any).cards({id:cardId}).get()),ok(await api.profile.get())]);
      res.card=liveCard;res.profile=liveProfile;
    }
    const updatedCard = res.replayed ? cardFromApi(res.card) : mergeReviewedCard(res.card, previous);
    const review = reviewFromApi(res.review);
    if (generation !== bootstrapGeneration) return { ...review, card: updatedCard };
    const nextProfile = res.profile ? profileFromApi(res.profile) : null;
    set((s) => ({
      cards: s.cards.some((c) => c.id === cardId)
        ? s.cards.map((c) => (c.id === cardId ? updatedCard : c))
        : [...s.cards, updatedCard],
      profile: nextProfile ?? s.profile,
    }));

    if (!res.replayed && typeof window !== 'undefined' && get().profile?.userId) {
      try { writeBrowserValue(window.localStorage, `nn:study:changed:${get().profile!.userId}`, review.id); } catch { /* Optional invalidation signal. */ }
    }

    // Fire gamification toasts. The server returns everything we need in the
    // grade response (freezeUsed, dailyGoalJustMet) — we just turn them into
    // user-visible notifications without pulling in an extra subscription layer.
    if (typeof window !== 'undefined' && !res.replayed) {
      // Defer a tick so React has committed the state update first.
      queueMicrotask(async () => {
        if (generation !== bootstrapGeneration) return;
        const dispatch = (detail: {
          kind: string;
          title?: string;
          description?: string;
          titleKey?: string;
          descriptionKey?: string;
        }) => {
          window.dispatchEvent(new CustomEvent('nn:toast', { detail }));
        };
        // Leech auto-suspend — surface it so the user knows the card left the queue.
        if (res.leeched) {
          dispatch({
            kind: 'leech',
            titleKey: 'toasts.leech.title',
            descriptionKey: 'toasts.leech.description',
          });
        }
        if (res.freezeUsed) {
          dispatch({
            kind: 'freeze',
            titleKey: 'toasts.freeze.title',
            descriptionKey: 'toasts.freeze.description',
          });
        }
        if (res.dailyGoalJustMet) {
          dispatch({
            kind: 'dailyGoal',
            titleKey: 'toasts.dailyGoal.title',
            descriptionKey: 'toasts.dailyGoal.description',
          });
        }
      });
    }

    return { ...review, card: updatedCard };
  },

  async undoLastReview(reviewId, displayedCard) {
    const generation = bootstrapGeneration;
    // Don't go through `ok()` — we want the HTTP status to distinguish 404
    // (nothing to undo) from 409 (card modified since the grade) so the UI can
    // pick the right toast. The thrown error carries `.code` for the caller.
    const { data, error }: any = await (api as any).reviews.undo.post(reviewId ? { reviewId } : undefined);
    if (error) {
      const err = new Error(
        error.value?.error ?? `undo_failed_${error.status ?? ''}`,
      ) as Error & { code?: string; status?: number };
      err.code = error.value?.error;
      err.status = error.status;
      throw err;
    }
    const prior=displayedCard ?? get().cards.find((c)=>c.id===data.card.id);
    const restoredCard = prior?.note ? mergeReviewedCard(data.card,prior)
      : cardFromApi(await ok(await (api as any).cards({id:data.card.id}).get()));
    const result = { cardId: restoredCard.id, card: restoredCard, reviewId: data.reviewId };
    if (generation !== bootstrapGeneration) return result;
    const nextProfile = data.profile ? profileFromApi(data.profile) : null;
    set((s) => ({
      cards: s.cards.some((c) => c.id === restoredCard.id)
        ? s.cards.map((c) => (c.id === restoredCard.id ? restoredCard : c))
        : [...s.cards, restoredCard],
      profile: nextProfile ?? s.profile,
    }));
    if (typeof window !== 'undefined' && get().profile?.userId) {
      try { writeBrowserValue(window.localStorage, `nn:study:changed:${get().profile!.userId}`, `undo:${data.reviewId}`); } catch { /* Refocus still revalidates. */ }
    }
    return result;
  },

  async updateProfile(patch) {
    const generation = bootstrapGeneration;
    const body: any = {};
    if (patch.name !== undefined) body.name = patch.name;
    if (patch.dailyGoalMinutes !== undefined) body.dailyGoalMinutes = patch.dailyGoalMinutes;
    if (patch.desiredRetention !== undefined) body.desiredRetention = patch.desiredRetention;
    if (patch.plantStage !== undefined) body.plantStage = patch.plantStage;
    if (patch.plantSpecies !== undefined) body.plantSpecies = patch.plantSpecies;
    if (patch.agentInstructions !== undefined) body.agentInstructions = patch.agentInstructions;
    const next = profileFromApi(await ok(await (api as any).profile.patch(body)));
    if (generation === bootstrapGeneration) set({ profile: next });
  },

  async addPreset(input) {
    const generation = bootstrapGeneration;
    const created = presetFromApi(
      await ok(
        await (api as any)['deck-options'].post({
          name: input.name,
          newPerDay: input.newPerDay,
          reviewsPerDay: input.reviewsPerDay,
          learningSteps: input.learningSteps,
          relearningSteps: input.relearningSteps,
          desiredRetention: input.desiredRetention ?? null,
          leechThreshold: input.leechThreshold,
          maximumInterval: input.maximumInterval,
        }),
      ),
    );
    if (generation === bootstrapGeneration) set((s) => ({ presets: [...s.presets, created] }));
    return created;
  },

  async updatePreset(id, patch) {
    const body: any = {};
    if (patch.name !== undefined) body.name = patch.name;
    if (patch.newPerDay !== undefined) body.newPerDay = patch.newPerDay;
    if (patch.reviewsPerDay !== undefined) body.reviewsPerDay = patch.reviewsPerDay;
    if (patch.learningSteps !== undefined) body.learningSteps = patch.learningSteps;
    if (patch.relearningSteps !== undefined) body.relearningSteps = patch.relearningSteps;
    if ('desiredRetention' in patch) body.desiredRetention = patch.desiredRetention ?? null;
    if (patch.leechThreshold !== undefined) body.leechThreshold = patch.leechThreshold;
    if (patch.maximumInterval !== undefined) body.maximumInterval = patch.maximumInterval;
    const generation = bootstrapGeneration;
    const updated = presetFromApi(
      await ok(await (api as any)['deck-options']({ id }).patch(body)),
    );
    if (generation === bootstrapGeneration) set((s) => ({ presets: s.presets.map((p) => (p.id === id ? updated : p)) }));
    return updated;
  },

  async deletePreset(id) {
    const generation = bootstrapGeneration;
    const res: any = await ok(await (api as any)['deck-options']({ id }).delete());
    const affectedDecks: number = res.affectedDecks ?? 0;
    if (generation !== bootstrapGeneration) return { affectedDecks };
    set((s) => ({
      presets: s.presets.filter((p) => p.id !== id),
      // Mirror the SET NULL that the server applied to bound decks.
      decks: s.decks.map((d) => (d.presetId === id ? { ...d, presetId: null } : d)),
    }));
    return { affectedDecks };
  },

  async bindDeckPreset(deckId, presetId) {
    const generation = bootstrapGeneration;
    const updated = deckFromApi(
      await ok(await (api as any).decks({ id: deckId }).patch({ presetId })),
    );
    if (generation === bootstrapGeneration) set((s) => ({ decks: s.decks.map((d) => (d.id === deckId ? updated : d)) }));
  },

  async addFilteredDeck(input) {
    const generation = bootstrapGeneration;
    const created = filteredDeckFromApi(
      await ok(
        await (api as any)['filtered-decks'].post({
          name: input.name,
          query: input.query,
          sortOrder: input.sortOrder,
          cardLimit: input.cardLimit,
          includeSuspended: input.includeSuspended,
        }),
      ),
    );
    if (generation === bootstrapGeneration) set((s) => ({ filteredDecks: [...s.filteredDecks, created] }));
    return created;
  },

  async updateFilteredDeck(id, patch) {
    const generation = bootstrapGeneration;
    const body: any = {};
    if (patch.name !== undefined) body.name = patch.name;
    if (patch.query !== undefined) body.query = patch.query;
    if (patch.sortOrder !== undefined) body.sortOrder = patch.sortOrder;
    if (patch.cardLimit !== undefined) body.cardLimit = patch.cardLimit;
    if (patch.includeSuspended !== undefined) body.includeSuspended = patch.includeSuspended;
    const updated = filteredDeckFromApi(
      await ok(await (api as any)['filtered-decks']({ id }).patch(body)),
    );
    if (generation === bootstrapGeneration) set((s) => ({
      filteredDecks: s.filteredDecks.map((fd) => (fd.id === id ? updated : fd)),
    }));
    return updated;
  },

  async deleteFilteredDeck(id) {
    const generation = bootstrapGeneration;
    await ok(await (api as any)['filtered-decks']({ id }).delete());
    if (generation !== bootstrapGeneration) return;
    set((s) => ({ filteredDecks: s.filteredDecks.filter((fd) => fd.id !== id) }));
  },

  async uploadMedia(file) {
    // 1. Presign: server validates {mime,size}, mints a uuid, returns the POST
    //    policy (url + fields) + the relative token. NO DB row yet.
    const presign: any = await ok(
      await (api as any).media.presign.post({ mime: file.type, size: file.size }),
    );

    // 2. Direct multipart POST to S3/MinIO — a RAW cross-origin fetch, NOT Eden
    //    (the bytes must bypass Bun, plan A1). The policy fields go first, then
    //    Content-Type (signed in the policy), then the file LAST per S3's rules.
    const fd = new FormData();
    for (const [k, v] of Object.entries(presign.upload.fields as Record<string, string>)) {
      fd.append(k, v);
    }
    fd.set('Content-Type', file.type);
    fd.append('file', file);
    const res = await fetch(presign.upload.url, { method: 'POST', body: fd });
    if (!res.ok) {
      throw new Error(`upload failed (${res.status})`);
    }

    // 3. Finalize: server HEADs the object for real size + ranged-GET magic-byte
    //    sniff, then inserts the media row (deletes + 400 on mismatch).
    await ok(await (api as any).media({ id: presign.mediaId }).finalize.post());

    return { token: presign.token as string, mediaId: presign.mediaId as string };
  },

  // ── NotebookLM sources (M1) ──────────────────────────────────────────────────

  async listNotebooks(params) {
    const query: Record<string, string> = {};
    if (params?.archived) query.archived = 'true';
    const res = (await ok(await (api as any).notebooks.get({ query }))) as { items: any[] };
    return res.items.map(notebookFromApi);
  },

  async createNotebook(title) {
    return notebookFromApi(await ok(await (api as any).notebooks.post({ title })));
  },

  async renameNotebook(id, title) {
    return notebookFromApi(await ok(await (api as any).notebooks({ id }).patch({ title })));
  },

  async getNotebook(id) {
    return notebookFromApi(await ok(await (api as any).notebooks({ id }).get()));
  },

  async getNotebookPlan(id) {
    const res = await (api as any).notebooks({ id }).plan.get();
    if (res.error?.status === 404) return null;
    return ok(res);
  },

  async openNotebookPlanModule(id, moduleId) {
    const res = await (api as any).notebooks({ id }).plan.modules({ moduleId }).open.post();
    if (res.error?.status === 404) return null;
    return ok(res);
  },

  async patchNotebook(id, patch) {
    return notebookFromApi(await ok(await (api as any).notebooks({ id }).patch(patch)));
  },

  async deleteNotebook(id) {
    await ok(await (api as any).notebooks({ id }).delete());
  },

  // ── Notebook notes (Р1/Р7, N1) ───────────────────────────────────────────────

  async getNotebookNote(notebookId,noteId) {
    return notebookNoteFromApi(await ok(await assistantApi.notebooks({id:notebookId}).notes({noteId}).get()));
  },
  async listNotebookNotes(notebookId, q) {
    const query: Record<string, string> = {};
    if (q && q.trim()) query.q = q.trim();
    const res = (await ok(
      await (assistantApi as any).notebooks({ id: notebookId }).notes.get({ query }),
    )) as { items: any[] };
    return res.items.map(notebookNoteFromApi);
  },

  async createNotebookNote(notebookId, input) {
    const body: Record<string, unknown> = { title: input.title, content: input.content };
    if (input.kind) body.kind = input.kind;
    if (input.citations != null) body.citations = input.citations;
    if (input.messageId) body.messageId = input.messageId;
    return notebookNoteFromApi(
      await ok(await (assistantApi as any).notebooks({ id: notebookId }).notes.post(body)),
    );
  },

  async patchNotebookNote(notebookId, noteId, patch) {
    return notebookNoteFromApi(
      await ok(
        await (assistantApi as any).notebooks({ id: notebookId }).notes({ noteId }).patch(patch),
      ),
    );
  },

  async deleteNotebookNote(notebookId, noteId) {
    await ok(await (assistantApi as any).notebooks({ id: notebookId }).notes({ noteId }).delete());
  },

  // ── Notebook studio: artifacts + overview (N2) ────────────────────────────────

  async listArtifacts(notebookId) {
    const res = (await ok(
      await (api as any).notebooks({ id: notebookId }).artifacts.get(),
    )) as { items: any[] };
    return res.items.map(notebookArtifactFromApi);
  },

  async createArtifact(notebookId, type, sourceIds, questionCount) {
    const body: Record<string, unknown> = { type };
    if (sourceIds && sourceIds.length > 0) body.sourceIds = sourceIds;
    if (type === 'quiz' && typeof questionCount === 'number') body.questionCount = questionCount;
    return notebookArtifactFromApi(
      await ok(await (api as any).notebooks({ id: notebookId }).artifacts.post(body)),
    );
  },

  async getArtifact(notebookId, artifactId) {
    return notebookArtifactFromApi(
      await ok(await (api as any).notebooks({ id: notebookId }).artifacts({ artifactId }).get()),
    );
  },

  async deleteArtifact(notebookId, artifactId) {
    await ok(await (api as any).notebooks({ id: notebookId }).artifacts({ artifactId }).delete());
  },

  async regenerateArtifact(notebookId, artifactId) {
    return notebookArtifactFromApi(
      await ok(
        await (api as any).notebooks({ id: notebookId }).artifacts({ artifactId }).regenerate.post(),
      ),
    );
  },

  async generateOverview(notebookId) {
    const res = await (api as any).notebooks({ id: notebookId }).overview.post();
    if (res.error?.status === 429 && res.error.value?.error === 'cooldown') {
      throw new CooldownError(Number(res.error.value.retryAfterMs) || 0);
    }
    return (await ok(res)) as { overview: string; questions: string[]; fingerprint: string };
  },

  // ── Notebook quiz: attempts (N3) ──────────────────────────────────────────────

  async submitQuizAttempt(notebookId, artifactId, answers) {
    return quizAttemptFromApi(
      await ok(
        await (api as any)
          .notebooks({ id: notebookId })
          .artifacts({ artifactId })
          .attempts.post({ answers }),
      ),
    );
  },

  async listQuizAttempts(notebookId, artifactId) {
    const res = (await ok(
      await (api as any).notebooks({ id: notebookId }).artifacts({ artifactId }).attempts.get(),
    )) as { items: any[] };
    return res.items.map(quizAttemptFromApi);
  },

  async getCoverage(notebookId) {
    const res = (await ok(
      await (api as any).notebooks({ id: notebookId }).coverage.get(),
    )) as NotebookCoverage;
    // The route already returns the exact shape; normalize defensively.
    return {
      items: Array.isArray(res.items) ? res.items : [],
      aggregate: res.aggregate ?? { totalChunks: 0, coveredChunks: 0, cardCount: 0, pct: 0 },
      gaps: Array.isArray(res.gaps) ? res.gaps : [],
    };
  },

  async conceptMap(notebookId) {
    // Hyphenated route segment → Eden bracket access.
    const res = (await ok(
      await (api as any).notebooks({ id: notebookId })['concept-map'].get(),
    )) as ConceptMapResult;
    return {
      nodes: Array.isArray(res.nodes) ? res.nodes : [],
      edges: Array.isArray(res.edges) ? res.edges : [],
      ...(res.reason ? { reason: res.reason } : {}),
    };
  },

  async suggestSources(notebookId) {
    const res = (await ok(
      await (api as any).notebooks({ id: notebookId })['suggest-sources'].get(),
    )) as SuggestSourcesResult;
    return {
      items: Array.isArray(res.items) ? res.items : [],
      ...(res.reason ? { reason: res.reason } : {}),
    };
  },

  async listSources(notebookId) {
    const res = (await ok(
      await (api as any).notebooks({ id: notebookId }).sources.get(),
    )) as { items: Source[] };
    return res.items;
  },

  async addUrlSource(notebookId, title, url) {
    return (await ok(
      await (api as any).notebooks({ id: notebookId }).sources.post({ kind: 'url', title, url }),
    )) as Source;
  },

  async addTextSource(notebookId, title, text) {
    return (await ok(
      await (api as any).notebooks({ id: notebookId }).sources.post({ kind: 'text', title, text }),
    )) as Source;
  },

  async uploadSource(notebookId, file, title, mime) {
    // 1. Claim + presign: the server inserts a pending (verified=false) source
    //    row under the caller and returns the source id + the S3 POST policy.
    const claim: any = await ok(
      await (api as any)
        .notebooks({ id: notebookId })
        .sources.post({ kind: 'upload', title, mime, size: file.size }),
    );

    // 2. Direct multipart POST to S3/MinIO — RAW cross-origin fetch (bytes bypass
    //    Bun, same as uploadMedia). Policy fields first, Content-Type, file LAST.
    const fd = new FormData();
    for (const [k, v] of Object.entries(claim.upload.fields as Record<string, string>)) {
      fd.append(k, v);
    }
    fd.set('Content-Type', mime);
    fd.append('file', file);
    const res = await fetch(claim.upload.url, { method: 'POST', body: fd });
    if (!res.ok) {
      throw new Error(`upload failed (${res.status})`);
    }

    // 3. Finalize: server HEADs for real size, dedups by byte hash, enqueues the
    //    ingest worker, and returns the verified source row.
    return (await ok(
      await (api as any).sources({ id: claim.sourceId }).finalize.post(),
    )) as Source;
  },

  async getSource(id) {
    return (await ok(await (api as any).sources({ id }).get())) as Source;
  },

  async renameSource(id, title) {
    return (await ok(await (api as any).sources({ id }).patch({ title }))) as Source;
  },

  async deleteSource(id) {
    await ok(await (api as any).sources({ id }).delete());
  },

  async getSourceChunks(id, from, limit) {
    const query: Record<string, number> = {};
    if (from != null) query.from = from;
    if (limit != null) query.limit = limit;
    return (await ok(
      await (api as any).sources({ id }).chunks.get({ query }),
    )) as SourceChunkPage;
  },

  async listSourceCards(id) {
    const res = (await ok(await (api as any).sources({ id }).cards.get())) as {
      items: SourceLinkedCard[];
    };
    return res.items ?? [];
  },

  // ── «Урожай выделений → карточки» (feature #2) ───────────────────────────────

  async harvestCards(sourceId, locale) {
    const body: Record<string, string> = {};
    if (locale) body.locale = locale;
    const res = (await ok(
      await (assistantApi as any).sources({ id: sourceId })['harvest-cards'].post(body),
    )) as { candidates: HarvestCandidate[] };
    return res.candidates ?? [];
  },

  async applyHarvest(sourceId, body) {
    return (await ok(
      await (api as any).sources({ id: sourceId })['harvest-cards'].apply.post(body),
    )) as { created: number; cardIds: string[] };
  },

  // ── Library (L1) ──────────────────────────────────────────────────────────────

  async listLibrary(params) {
    const query: Record<string, string | number> = {};
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v != null && v !== '') query[k] = v as string | number;
      }
    }
    return (await ok(await (api as any).library.get({ query }))) as {
      items: LibraryItem[];
      nextCursor: string | null;
    };
  },

  async searchLibrary(q, limit) {
    const query: Record<string, string | number> = { q };
    if (limit != null) query.limit = limit;
    return (await ok(
      await (api as any).library.search.get({ query }),
    )) as LibrarySearchResult;
  },

  async getLibraryItem(id) {
    return (await ok(
      await (api as any).library.items({ id }).get(),
    )) as LibraryItemDetail;
  },

  async addLibraryUrl(title, url, notebookId) {
    const res = await (api as any).library.items.post({ kind: 'url', title, url, ...(notebookId ? { notebookId } : {}) });
    const value = res.error?.value as { error?: string; existingSourceId?: string } | undefined;
    if (res.error?.status === 409 && value?.error === 'duplicate_source' && value.existingSourceId) {
      throw new DuplicateSourceError(value.existingSourceId);
    }
    if (res.error?.status === 409 && value?.error === 'library_full') throw new LibraryFullError();
    return (await ok(res)) as LibraryItem;
  },

  async addLibraryText(title, text, notebookId) {
    return (await ok(
      await (api as any).library.items.post({ kind: 'text', title, text, ...(notebookId ? { notebookId } : {}) }),
    )) as LibraryItem;
  },

  async uploadLibraryItem(file, title, mime, notebookId) {
    // 1. Claim + presign (per-user cap enforced server-side → 409 library_full).
    const presignRes = await (api as any).library.items.presign.post({
      title,
      mime,
      size: file.size,
    });
    if (presignRes.error) {
      if (presignRes.error.status === 409) throw new LibraryFullError();
      throw new Error(JSON.stringify(presignRes.error.value ?? presignRes.error));
    }
    const claim = presignRes.data as { sourceId: string; upload: { url: string; fields: Record<string, string> } };

    // 2. Direct multipart POST to S3/MinIO (bytes bypass Bun — same as uploadMedia).
    const fd = new FormData();
    for (const [k, v] of Object.entries(claim.upload.fields)) fd.append(k, v);
    fd.set('Content-Type', mime);
    fd.append('file', file);
    const s3 = await fetch(claim.upload.url, { method: 'POST', body: fd });
    if (!s3.ok) throw new Error(`upload failed (${s3.status})`);

    // 3. Finalize: byte-dedup (409 duplicate_source → existingSourceId) + enqueue.
    const finalizeRes = await (api as any).library
      .items({ id: claim.sourceId })
      .finalize.post(notebookId ? { notebookId } : {});
    if (finalizeRes.error) {
      const value = finalizeRes.error.value as { error?: string; existingSourceId?: string } | undefined;
      if (finalizeRes.error.status === 409 && value?.error === 'duplicate_source' && value.existingSourceId) {
        throw new DuplicateSourceError(value.existingSourceId);
      }
      if (finalizeRes.error.status === 409 && value?.error === 'library_full') {
        throw new LibraryFullError();
      }
      throw new Error(JSON.stringify(value ?? finalizeRes.error));
    }
    return finalizeRes.data as LibraryItem;
  },

  async patchLibraryItem(id, patch) {
    await ok(await (api as any).library.items({ id }).patch(patch));
    // PATCH returns a source row; GET includes coverUrl, progress and library counts.
    return (await ok(await (api as any).library.items({ id }).get())) as LibraryItemDetail;
  },

  async deleteLibraryItem(id) {
    await ok(await (api as any).library.items({ id }).delete());
  },

  async reingestLibraryItem(id) {
    await ok(await (api as any).library.items({ id }).reingest.post());
  },

  async putReadingState(id, state) {
    const body: Record<string, number> = {};
    if (state.page != null) body.page = state.page;
    if (state.chunkPos != null) body.chunkPos = state.chunkPos;
    if (state.percent != null) body.percent = state.percent;
    await ok(await (api as any).library.items({ id })['reading-state'].put(body));
  },

  // ── Notebook ↔ source attach/detach ───────────────────────────────────────────

  async attachSources(notebookId, sourceIds) {
    await ok(
      await (api as any).notebooks({ id: notebookId }).sources.attach.post({ sourceIds }),
    );
  },

  async detachSource(notebookId, sourceId) {
    await ok(
      await (api as any).notebooks({ id: notebookId }).sources({ sourceId }).delete(),
    );
  },
}));

// Selectors (pure functions, used in components with `useNN(selector)`)
export const selectDueCards = (now: Date = new Date()) => (s: State) =>
  getDueCards(s.cards, now);

export const selectDeckById = (id: string) => (s: State) => s.decks.find((d) => d.id === id);

export const selectCardsByDeck = (deckId: string) => (s: State) =>
  s.cards.filter((c) => c.deckId === deckId);

export const selectDueCountByDeck = (now: Date = new Date()) => (s: State) =>
  countDueCardsByDeck(s.cards, now);
