import type { Card as FsrsCard } from 'ts-fsrs';
import type {
  ArtifactStatus,
  CardTemplate,
  FieldValues,
  IngestErrorCode,
  MarkRect,
  NotebookArtifactType,
  NotebookColor,
  NotebookNoteKind,
  NoteField,
  QuizAttemptAnswer,
  QuizContent,
  RenderKind,
  SourceKind,
  SourceMarkColor,
  SourceMarkKind,
  SourceStatus,
  CardHoldView,
} from '@reomi/shared';

export type DeckColor = import('@reomi/shared').DeckColor;
export type PlantSpecies = 'fern' | 'cactus' | 'succulent' | 'bonsai' | 'sakura' | 'mushroom';

export interface Deck {
  metadataRevision?: number;
  id: string;
  name: string;
  color: DeckColor;
  icon?: string;
  position?: number;
  species: PlantSpecies;
  createdAt: number;
  /** Parent deck id. Undefined for root-level decks. */
  parentId?: string;
  /** Bound preset id. Null or undefined = inherit/default. */
  presetId?: string | null;
}

// ── Deck Options Presets (M3) ─────────────────────────────────────────────────

/**
 * A named set of FSRS + queue options that can be bound to one or more decks.
 * When a deck has no preset bound, it uses the system Anki defaults.
 */
export interface DeckOptionsPreset {
  id: string;
  userId: string;
  name: string;
  newPerDay: number;
  reviewsPerDay: number;
  /** Learning steps, e.g. ["1m", "10m"]. */
  learningSteps: string[];
  /** Relearning steps, e.g. ["10m"]. */
  relearningSteps: string[];
  /** Override desired retention (0.7–0.99). Null = inherit global. */
  desiredRetention: number | null;
  leechThreshold: number;
  maximumInterval: number;
  createdAt: number;
  updatedAt: number;
}

// ── Filtered Decks (M3) ──────────────────────────────────────────────────────

/**
 * The sort order for a filtered-deck session. Mirrors the server enum
 * (`sort_order` column in `filtered_deck`).
 */
export type FilteredDeckSortOrder =
  | 'due'
  | 'added'
  | 'random'
  | 'difficultyDesc'
  | 'overdue'
  | 'lapses'
  | 'cram';

/**
 * A named custom-study session backed by a card query + sort/limit config.
 * Session cards are returned under the `due` key in the queue envelope and
 * graded with `source: 'filtered'` so the daily counters are skipped.
 */
export interface FilteredDeck {
  id: string;
  userId: string;
  name: string;
  /** Card search query (same grammar as the Browse search box). */
  query: string;
  sortOrder: FilteredDeckSortOrder;
  cardLimit: number;
  includeSuspended: boolean;
  createdAt: number;
  updatedAt: number;
}

// ── Note-types model (M1) ─────────────────────────────────────────────────────

/** A note-type the user can author against (own or a global builtin). */
export interface NoteType {
  id: string;
  updatedAt?: string;
  name: string;
  fields: NoteField[];
  templates: CardTemplate[];
  styling: string;
  kind: RenderKind;
  isBuiltin: boolean;
}

/** A note — the user's content. Generates one-or-more cards via its note-type. */
export interface Note {
  id: string;
  noteTypeId: string;
  fieldValues: FieldValues;
  tags: string[];
  /** All cards of a note share one deck (Decision A1). */
  deckId: string;
}

/**
 * A card is one (note × template) pairing with its own FSRS state. Content is
 * derived from its note via the note-type template. The `render*` columns are
 * the server-rendered PLAINTEXT search cache (tags + cloze stripped); display
 * HTML is rendered lazily from `note.fieldValues` + `noteType.templates`. The
 * embedded `note`/`noteType` come from the enriched card read-payload.
 */
export interface Card {
  id: string;
  deckId: string;
  noteId: string;
  templateOrd: number;
  clozeNumber?: number | null;
  /** Server-rendered plaintext (front + back, search cache). */
  renderText: string;
  /** Server-rendered plaintext front (Browse "Question" column). */
  renderFrontText: string;
  /** Server-rendered plaintext back (Browse "Answer" column). */
  renderBackText: string;
  /** Render mode — picked from the payload with no extra fetch (C-5). */
  renderKind: RenderKind;
  /** Note-level tags (Anki-correct), surfaced from the embedded note. */
  tags: string[];
  suspended: boolean;
  /** Active bury, or null when the card is free. Expired rows are already null. */
  hold: CardHoldView | null;
  createdAt: number;
  updatedAt: number;
  fsrs: FsrsCard;
  /** Embedded note (id, sanitized field values, tags) for lazy HTML render. */
  note?: { id: string; fieldValues: FieldValues; acceptedAnswers?: string[]; tags: string[]; updatedAt?: string } | null;
  /** Embedded note-type (name, kind, templates, styling) for lazy HTML render. */
  noteType?: {
    id: string;
    updatedAt?: string;
    name: string;
    kind: RenderKind;
    fields?: NoteField[];
    templates: CardTemplate[];
    styling: string;
  } | null;
}

// ── NotebookLM sources (M1) ───────────────────────────────────────────────────
// Thin view types over the server rows (GET /notebooks, GET /sources/:id). Dates
// stay as ISO strings — the library screen renders relative/badge UI, not the
// epoch-number FSRS math the mappers do for cards.

/** One attached source in a notebook's cover fan (GET /notebooks grid payload). */
export interface NotebookCoverSource {
  title: string;
  kind: SourceKind;
  coverMediaId: string | null;
}

export interface Notebook {
  metadataRevision?: number;
  id: string;
  title: string;
  /** «Блокноты 2.0» metadata (Р13) — all nullable. */
  emoji: string | null;
  color: NotebookColor | null;
  description: string | null;
  pinned: boolean;
  archived: boolean;
  /** Grid counts folded into GET /notebooks (no N+1). Absent on a bare row. */
  sourceCount?: number;
  noteCount?: number;
  cardCount?: number;
  /** «Блокноты редизайн» (A3) — studio document counts + cover fan folded into
   *  the GET /notebooks grid payload (no N+1). Absent on a bare/detail row. */
  artifactCount?: number;
  generatingCount?: number;
  /** Title of the most recent in-flight artifact (for the «Продолжить» strip). */
  generatingTitle?: string | null;
  /** ≤4 attached sources (oldest-attach first) for the cover fan. */
  coverSources?: NotebookCoverSource[];
  /** «Блокноты 2.0» (N2, Р6) overview cache — present on the GET /notebooks/:id
   *  detail row (and after a generate). `overview`/`suggestedQuestions` are null
   *  until the first generation; `overviewFingerprint` is the scope hash at that
   *  time, `currentFingerprint` is the server's live recompute (a mismatch ⇒ the
   *  cache is stale and the client offers «Обновить обзор»). */
  overview?: string | null;
  suggestedQuestions?: string[] | null;
  overviewFingerprint?: string | null;
  currentFingerprint?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** «Блокноты 2.0» (N2) studio artifact. The LIST variant (GET /notebooks/:id/
 *  artifacts) omits `contentMd`/`contentJson` (light); the FULL variant (GET
 *  …/artifacts/:artifactId) carries them. Status is a job lifecycle
 *  (pending→generating→ready|error); `errorCode` maps to an i18n string. */
export interface NotebookArtifact {
  id: string;
  notebookId: string | null;
  ownerKind?: 'notebook' | 'source';
  sourceId?: string | null;
  sourceOriginId?: string | null;
  sourceOriginTitle?: string | null;
  type: NotebookArtifactType;
  status: ArtifactStatus;
  title: string;
  /** Snapshot of the source ids the artifact was generated over. */
  sourceIds: string[];
  errorCode: string | null;
  model: string | null;
  /** Live char count of the partial text a streaming job has produced so far
   *  (list variant, pending|generating only — 0 for terminal rows). */
  progressChars?: number;
  /** Markdown body (full variant, markdown types). Absent on the list row. */
  contentMd?: string | null;
  /** Structured quiz payload (full variant, type='quiz'). Absent on the list row. */
  contentJson?: QuizContent | null;
  createdAt: string;
  updatedAt: string;
}

/** «Блокноты 2.0» (N3) one quiz attempt (POST/GET …/attempts). `answers` is the
 *  server-scored snapshot (the submitted answer + the server's verdict per
 *  question); `correct`/`total` are the score. Newest-first in the history. */
export interface QuizAttempt {
  id: string;
  correct: number;
  total: number;
  answers: QuizAttemptAnswer[];
  createdAt: string;
}

/** «Блокноты 2.0» (N3) one per-source coverage row (GET …/coverage). */
export interface NotebookCoverageItem {
  sourceId: string;
  title: string;
  totalChunks: number;
  coveredChunks: number;
  cardCount: number;
  /** 0..100 — coveredChunks/totalChunks. */
  pct: number;
}

/** «Блокноты 2.0» (N3) one coverage gap (GET …/coverage `gaps`): a heading with
 *  the most UNcovered chunks. `heading` is null for the unstructured-text bucket
 *  (the client labels it «без заголовка»). */
export interface NotebookCoverageGap {
  sourceId: string;
  sourceTitle: string;
  heading: string | null;
  uncovered: number;
}

/** «Блокноты 2.0» (N3) card-coverage of a notebook (GET …/coverage). SQL-only —
 *  works without a chat key (only the gap prefill buttons are gated). */
export interface NotebookCoverage {
  items: NotebookCoverageItem[];
  aggregate: { totalChunks: number; coveredChunks: number; cardCount: number; pct: number };
  gaps: NotebookCoverageGap[];
}

/** «Блокноты 2.0» (N4, Р10) one concept-map node — a (source, section) cluster of
 *  document chunks. `label` is the section heading, or null for a
 *  position-bucketed (headingless) section (the client labels it «часть N»).
 *  `firstChunkId`/`firstPos` are the citation-viewer scroll anchors. */
export interface ConceptMapNode {
  id: string;
  sourceId: string;
  sourceTitle: string;
  label: string | null;
  firstPos: number;
  firstChunkId: string;
  chunkCount: number;
}

/** «Блокноты 2.0» (N4, Р10) one undirected concept-map edge (a < b by id);
 *  `score` is the cosine similarity of the closest cross-section chunk pair. */
export interface ConceptMapEdge {
  a: string;
  b: string;
  score: number;
}

/** «Блокноты 2.0» (N4, Р10) the sectional semantic graph (GET …/concept-map).
 *  Vectors-only — works without a chat key. `reason='not_indexed'` when the
 *  notebook has no document vectors yet (honest degrade → empty-state). */
export interface ConceptMapResult {
  nodes: ConceptMapNode[];
  edges: ConceptMapEdge[];
  reason?: 'not_indexed';
}

/** «Блокноты 2.0» (N4, Р11) one recommended library source (GET …/suggest-sources)
 *  — a source near the notebook's centroid, NOT already attached. */
export interface SuggestedSource {
  sourceId: string;
  title: string;
  kind: SourceKind;
  /** Cosine similarity to the notebook centroid (1 = identical). */
  score: number;
}

/** «Блокноты 2.0» (N4, Р11) source recommendations (GET …/suggest-sources).
 *  Vectors-only; `reason='not_indexed'` ⇒ no centroid (nothing indexed yet). */
export interface SuggestSourcesResult {
  items: SuggestedSource[];
  reason?: 'not_indexed';
}

/** A notebook note (Р1/Р7) — user markdown (`manual`) or a saved chat answer
 *  (`answer`). The list view also folds in a light `excerpt`. */
export interface NotebookNote {
  metadataRevision?: number;
  id: string;
  notebookId: string | null;
  ownerKind?: 'notebook' | 'source';
  sourceId?: string | null;
  sourceOriginId?: string | null;
  sourceOriginTitle?: string | null;
  title: string;
  content: string;
  kind: NotebookNoteKind;
  /** Snapshot of source citations for kind='answer' (opaque; rendered as-is). */
  citations: unknown[] | null;
  /** Back-ref to the chat message a saved answer came from (null otherwise). */
  messageId: string | null;
  pinned: boolean;
  /** One-line excerpt (list view only). */
  excerpt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Source {
  metadataRevision?: number;
  searchAvailable?: boolean;
  id: string;
  notebookId: string;
  kind: SourceKind;
  title: string;
  url: string | null;
  status: SourceStatus;
  errorCode: IngestErrorCode | null;
  /** Computed progress: COUNT(embedded chunks). */
  indexed: number;
  /** Computed progress denominator: total chunk count (0 until parsed). */
  total: number;
  /** Metadata (M-Library) — present on the row, surfaced in the workspace rail. */
  author: string | null;
  coverMediaId: string | null;
  /** Reading state from `GET /notebooks/:id/sources` (per-source, user-scoped).
   *  `readingPercent` is a 0..1 fraction (null when never opened). */
  readingStatus: ReadingStatus | null;
  readingPercent: number | null;
  createdAt: string;
  updatedAt: string;
}

// ── Library (L1) — the user-level material store over `sources` ───────────────

export type ReadingStatus = 'unread' | 'reading' | 'finished';

/** One library item (GET /library list + GET /library/items/:id detail). A
 *  library item IS a `sources` row; the list/detail responses fold in the
 *  reading-state + aggregate counts (no N+1). */
export interface LibraryItem {
  metadataRevision?: number;
  searchAvailable?: boolean;
  id: string;
  kind: SourceKind;
  title: string;
  author: string | null;
  description: string | null;
  language: string | null;
  tags: string[];
  /** Ingest lifecycle status (pending|parsing|indexing|ready|error|deleting). */
  status: SourceStatus;
  errorCode: IngestErrorCode | null;
  /** Computed: COUNT(embedded chunks). */
  indexed: number;
  /** Computed denominator: total chunk count (0 until parsed). */
  total: number;
  readingStatus: ReadingStatus;
  /** Reading progress 0..1, or null when never opened. */
  percent: number | null;
  pageCount: number | null;
  byteSize: number | null;
  coverMediaId: string | null;
  /** Stored `/m/<uuid>` cover token (resolved to a private read at display), or null. */
  coverUrl: string | null;
  notebookCount: number;
  cardCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Persisted reading position (server-of-truth, GET /library/items/:id). null
 *  when the item was never opened. */
export interface ReadingState {
  status: ReadingStatus;
  /** PDF page (1-based) or null. */
  page: number | null;
  /** Text-mode chunk position (0-based) or null. */
  chunkPos: number | null;
  /** Progress 0..1 or null. */
  percent: number | null;
}

/** One semantic-search hit within a source (GET /library/search). */
export interface LibrarySearchHit {
  sourceChunkId: string;
  position: number;
  page: number | null;
  heading: string | null;
  snippet: string;
  score: number;
}

/** A source's grouped search hits (GET /library/search). */
export interface LibrarySearchGroup {
  source: {
    id: string;
    kind: SourceKind;
    title: string;
    author: string | null;
    coverUrl: string | null;
  };
  hits: LibrarySearchHit[];
}

/** GET /library/search response. `reason` set when degraded (no results). */
export interface LibrarySearchResult {
  groups: LibrarySearchGroup[];
  reason?: 'embedding_disabled' | 'no_sources';
}

/** GET /library/items/:id — a library item + the notebooks it's attached to. */
export interface LibraryItemDetail extends LibraryItem {
  notebooks: { id: string; title: string }[];
  /** L2 — exact reading position for restore (null when never opened). */
  readingState: ReadingState | null;
}

// ── NotebookLM reader + provenance (M2/M3) ────────────────────────────────────

/** One parsed source chunk page for the reader (GET /sources/:id/chunks). */
export interface SourceChunkRow {
  id: string;
  position: number;
  text: string;
  page: number | null;
  heading: string | null;
}

/** Reader pagination page (GET /sources/:id/chunks → items + cursor). */
export interface SourceChunkPage {
  items: SourceChunkRow[];
  total: number;
  nextFrom: number | null;
}

// ── «Урожай выделений → карточки» (feature #2) ─────────────────────────────────

/** Which marking a harvested card came from — a text highlight/note (addressed
 *  by its mark id) or an ink-underlined page (addressed by its 1-based page).
 *  Echoed back unchanged on apply so the server stamps the right origin row. */
export type HarvestOrigin =
  | { kind: 'mark'; markId: string }
  | { kind: 'ink'; page: number };

/** One AI-proposed card from the source's unharvested markup (POST
 *  /sources/:id/harvest-cards). `quote` is the source passage it came from
 *  (wizard context); `page` is its 1-based page or null. */
export interface HarvestCandidate {
  evidence?: { sourceVersion: string; originHash: string };
  origin: HarvestOrigin;
  page: number | null;
  front: string;
  back: string;
  quote: string;
}

/** One provenance backlink on a card (GET /cards/:id/sources). All ref fields go
 *  NULL after the source/notebook is deleted — a tombstone row («источник удалён»). */
export interface CardSourceLink {
  cardId?: string;
  sourceSnapshot?: import('@reomi/shared').CardEvidenceSnapshot | null;
  locationAvailable?: boolean;
  id: string;
  sourceChunkId: string | null;
  sourceId: string | null;
  notebookId: string | null;
  conversationId: string | null;
  messageId: string | null;
  sourceTitle: string | null;
  notebookTitle: string | null;
  sourceKind?: string | null;
  sourceUrl?: string | null;
  position: number | null;
  page: number | null;
  startSeconds?: number | null;
  heading: string | null;
  snippet: string | null;
  createdAt: string;
}

/** One card linked to a source (GET /sources/:id/cards). */
export interface SourceLinkedCard {
  cardId: string;
  front: string;
  deckId: string;
  deckName: string;
  count: number;
  createdAt: string;
}

// ── Reading-workflow marks (M5) ───────────────────────────────────────────────

/** One text-selection mark on a source (GET /sources/:id/marks). The server
 *  returns the full row (including `userId` — the caller's own id, not a leak),
 *  but the client only consumes the fields below; `rects` are normalized page
 *  coords. */
export interface SourceMark {
  id: string;
  sourceId: string;
  /** 1-based page index (pdf.js convention). */
  page: number;
  kind: SourceMarkKind;
  quote: string;
  rects: MarkRect[];
  color: SourceMarkColor;
  /** Freeform body for kind 'note'; null for highlights. */
  note: string | null;
  /** W4: present for kind 'card' — the id of the linked card. */
  cardId?: string | null;
  /** Feature #2: ISO timestamp when this highlight/note was harvested into cards
   *  (null = not yet harvested). Drives the «✓ в карточке» badge + dimming so a
   *  re-run won't re-offer it. */
  harvestedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** POST /sources/:id/quick-card → the created note + its cards. */
export interface QuickCardResult {
  noteId: string;
  cardIds: string[];
  /** W4: set when the server created a source_marks row for the card. */
  markId?: string;
}

/** POST /sources/:id/suggest-card → the AI-formulated front/back. */
export interface SuggestCardResult {
  front: string;
  back: string;
}

export type Rating = 1 | 2 | 3 | 4;

export interface Review {
  id: string;
  cardId: string;
  /** Historical deck may have been deleted after the card was moved. */
  deckId: string | null;
  rating: Rating;
  durationMs: number;
  reviewedAt: number;
  nextDue: number;
  nextStability: number;
  nextDifficulty: number;
}

export interface Profile {
  id: 'me';
  userId?: string;
  name: string;
  level: number;
  xp: number;
  streakDays: number;
  streakFreezes: number;
  lastReviewDate?: string;
  todayMinutes: number;
  todayMinutesDate?: string;
  dailyGoalMinutes: number;
  dailyGoalMetCount: number;
  dailyGoalMetDate?: string;
  desiredRetention?: number;
  /** Standing instructions for the agentic chat (C5) — injected into the system prompt. */
  agentInstructions?: string;
  plantSpecies: PlantSpecies;
  plantStage: 0 | 1 | 2 | 3 | 4 | 5;
  unlockedSpecies: PlantSpecies[];
  createdAt: number;
}
