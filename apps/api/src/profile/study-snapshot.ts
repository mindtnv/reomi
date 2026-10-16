import { readFileSync } from 'node:fs';
import { eq, isNull, or, sql } from 'drizzle-orm';
import {
  cards,
  db,
  deckOptionsPreset,
  decks,
  filteredDeck,
  media,
  noteTypes,
  notes,
  notificationSettings,
  profile,
  reviews,
  studyDayPolicy,
  user as userTable,
} from '@reomi/db';

export const STUDY_EXPORT_SCHEMA_VERSION = 1;
export const EXPORT_MAX_BYTES = 32 * 1024 * 1024;
export const LOSS_WINDOW =
  'Commits that land after this snapshot are not in the file. A grade is included with its card state or not at all.';
export const MEDIA_NOTE =
  'Image bytes stay in object storage. The snapshot lists each owned file and rebuilds its key as media/<id> on an empty account. It does not copy the bytes.';

const MEDIA_TOKEN = /\/m\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
const JOURNAL_URL = new URL(
  '../../../../packages/db/src/migrations/meta/_journal.json',
  import.meta.url,
);

export class StudyExportTooLarge extends Error {
  readonly maxBytes: number;
  constructor(maxBytes: number) {
    super('export_too_large');
    this.name = 'StudyExportTooLarge';
    this.maxBytes = maxBytes;
  }
}

let pauseForTests: (() => Promise<void>) | null = null;
let maxBytesForTests: number | null = null;

export function __setStudyExportPauseForTests(fn: (() => Promise<void>) | null): void {
  pauseForTests = fn;
}

export function __setStudyExportMaxBytesForTests(maxBytes: number | null): void {
  maxBytesForTests = maxBytes;
}

export interface SnapshotUser {
  id: string;
  email: string;
  name: string;
}

export interface SnapshotMedia {
  id: string;
  userId: string;
  mime: string;
  size: number;
  verified: boolean;
  createdAt: string;
  referenced: boolean;
}

export interface SnapshotMissingMedia {
  id: string;
  reason: 'not_owned';
}

export interface StudySnapshot {
  schemaVersion: number;
  isolation: 'repeatable read';
  exportedAt: string;
  lossWindow: string;
  mediaNote: string;
  migrationHead: string;
  user: SnapshotUser;
  profile: Record<string, unknown> | null;
  studyDayPolicy: Record<string, unknown> | null;
  reminders: Record<string, unknown> | null;
  presets: Record<string, unknown>[];
  decks: Record<string, unknown>[];
  filteredDecks: Record<string, unknown>[];
  noteTypes: Record<string, unknown>[];
  notes: Record<string, unknown>[];
  cards: Record<string, unknown>[];
  reviews: Record<string, unknown>[];
  media: SnapshotMedia[];
  missingMedia: SnapshotMissingMedia[];
}

export interface SnapshotCounts {
  presets: number;
  decks: number;
  filteredDecks: number;
  noteTypes: number;
  notes: number;
  cards: number;
  reviews: number;
  media: number;
  missingMedia: number;
}

function iso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function requiredIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function byId<T extends { id: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

function mediaTokens(notesRows: { fieldValues: unknown }[]): string[] {
  const found = new Set<string>();
  for (const note of notesRows) {
    const text = JSON.stringify(note.fieldValues ?? '');
    for (const match of text.matchAll(MEDIA_TOKEN)) {
      const id = match[1];
      if (id) found.add(id.toLowerCase());
    }
  }
  return [...found];
}

export function readMigrationHead(): string {
  const journal = JSON.parse(readFileSync(JOURNAL_URL, 'utf8')) as {
    entries?: { tag?: string }[];
  };
  const tag = journal.entries?.at(-1)?.tag;
  if (!tag) throw new Error('migration journal has no entries');
  return tag;
}

export function countsOf(snapshot: StudySnapshot): SnapshotCounts {
  return {
    presets: snapshot.presets.length,
    decks: snapshot.decks.length,
    filteredDecks: snapshot.filteredDecks.length,
    noteTypes: snapshot.noteTypes.length,
    notes: snapshot.notes.length,
    cards: snapshot.cards.length,
    reviews: snapshot.reviews.length,
    media: snapshot.media.length,
    missingMedia: snapshot.missingMedia.length,
  };
}

function idSet(rows: { id?: unknown }[]): Set<string> {
  return new Set(rows.map((row) => String(row.id)));
}

function uniqueIds(rows: { id?: unknown }[]): boolean {
  const ids = rows.map((row) => row.id);
  return ids.every((id) => typeof id === 'string' && id.length > 0) && new Set(ids).size === ids.length;
}

function sameOwner(rows: { userId?: unknown }[], userId: string): boolean {
  return rows.every((row) => row.userId === userId);
}

function decksAcyclic(rows: { id?: unknown; parentId?: unknown }[]): boolean {
  const ids = new Set(rows.map((row) => String(row.id)));
  const pending = new Set(ids);
  let guard = rows.length;
  while (pending.size > 0 && guard >= 0) {
    guard -= 1;
    let progressed = false;
    for (const id of pending) {
      const row = rows.find((candidate) => candidate.id === id);
      const parentId = row?.parentId;
      if (parentId == null || !pending.has(String(parentId))) {
        if (parentId != null && !ids.has(String(parentId))) return false;
        pending.delete(id);
        progressed = true;
      }
    }
    if (!progressed) return false;
  }
  return pending.size === 0;
}

export function snapshotCoherent(snapshot: StudySnapshot): boolean {
  if (!snapshot || snapshot.schemaVersion !== STUDY_EXPORT_SCHEMA_VERSION) return false;
  if (snapshot.isolation !== 'repeatable read') return false;
  if (!snapshot.user?.id) return false;
  const userId = snapshot.user.id;
  const lists = [
    snapshot.presets,
    snapshot.decks,
    snapshot.filteredDecks,
    snapshot.noteTypes,
    snapshot.notes,
    snapshot.cards,
    snapshot.reviews,
    snapshot.media,
    snapshot.missingMedia,
  ];
  if (lists.some((rows) => !Array.isArray(rows))) return false;
  if (lists.some((rows) => !uniqueIds(rows))) return false;
  if (!uniqueIds(snapshot.missingMedia)) return false;
  if (!sameOwner(snapshot.presets, userId)) return false;
  if (!sameOwner(snapshot.decks, userId)) return false;
  if (!sameOwner(snapshot.filteredDecks, userId)) return false;
  if (!sameOwner(snapshot.notes, userId)) return false;
  if (!sameOwner(snapshot.cards, userId)) return false;
  if (!sameOwner(snapshot.reviews, userId)) return false;
  if (!sameOwner(snapshot.media, userId)) return false;
  if (snapshot.profile && snapshot.profile.userId !== userId) return false;
  if (snapshot.studyDayPolicy && snapshot.studyDayPolicy.userId !== userId) return false;
  if (snapshot.reminders && snapshot.reminders.userId !== userId) return false;
  if (!snapshot.noteTypes.every((row) => row.userId == null || row.userId === userId)) return false;
  if (!decksAcyclic(snapshot.decks)) return false;

  const presetIds = idSet(snapshot.presets);
  const deckIds = idSet(snapshot.decks);
  const noteTypeIds = idSet(snapshot.noteTypes);
  const noteIds = idSet(snapshot.notes);
  const cardIds = idSet(snapshot.cards);
  const mediaIds = idSet(snapshot.media);
  if (!snapshot.decks.every((row) => row.presetId == null || presetIds.has(String(row.presetId)))) return false;
  if (!snapshot.notes.every((row) => noteTypeIds.has(String(row.noteTypeId)))) return false;
  if (!snapshot.cards.every((row) => deckIds.has(String(row.deckId)) && noteIds.has(String(row.noteId)))) {
    return false;
  }
  if (
    !snapshot.reviews.every(
      (row) => cardIds.has(String(row.cardId)) && (row.deckId == null || deckIds.has(String(row.deckId))),
    )
  ) {
    return false;
  }
  if (snapshot.missingMedia.some((row) => row.reason !== 'not_owned' || mediaIds.has(row.id))) return false;
  return true;
}

export async function loadStudySnapshot(userId: string): Promise<StudySnapshot> {
  const snapshot = await db.transaction(
    async (tx) => {
      // Repeatable read freezes at the first statement, not at BEGIN.
      await tx.execute(sql`select clock_timestamp()`);
      if (pauseForTests) await pauseForTests();

      const [account] = await tx
        .select({ id: userTable.id, email: userTable.email, name: userTable.name })
        .from(userTable)
        .where(eq(userTable.id, userId));
      if (!account) throw new Error('export user missing');

      const [profileRow] = await tx.select().from(profile).where(eq(profile.userId, userId));
      const [policyRow] = await tx.select().from(studyDayPolicy).where(eq(studyDayPolicy.userId, userId));
      const [reminderRow] = await tx
        .select()
        .from(notificationSettings)
        .where(eq(notificationSettings.userId, userId));
      const presetRows = await tx.select().from(deckOptionsPreset).where(eq(deckOptionsPreset.userId, userId));
      const deckRows = await tx.select().from(decks).where(eq(decks.userId, userId));
      const filteredRows = await tx.select().from(filteredDeck).where(eq(filteredDeck.userId, userId));
      const noteTypeRows = await tx
        .select()
        .from(noteTypes)
        .where(or(eq(noteTypes.userId, userId), isNull(noteTypes.userId)));
      const noteRows = await tx.select().from(notes).where(eq(notes.userId, userId));
      const cardRows = await tx.select().from(cards).where(eq(cards.userId, userId));
      const reviewRows = await tx.select().from(reviews).where(eq(reviews.userId, userId));
      const mediaRows = await tx.select().from(media).where(eq(media.userId, userId));
      const ownedIds = new Set(mediaRows.map((row) => row.id.toLowerCase()));
      const referencedIds = new Set(mediaTokens(noteRows));

      const body: StudySnapshot = {
        schemaVersion: STUDY_EXPORT_SCHEMA_VERSION,
        isolation: 'repeatable read',
        exportedAt: new Date().toISOString(),
        lossWindow: LOSS_WINDOW,
        mediaNote: MEDIA_NOTE,
        migrationHead: readMigrationHead(),
        user: { id: account.id, email: account.email, name: account.name },
        profile: profileRow
          ? {
              userId: profileRow.userId,
              name: profileRow.name,
              level: profileRow.level,
              xp: profileRow.xp,
              streakDays: profileRow.streakDays,
              lastReviewDate: profileRow.lastReviewDate,
              streakFreezes: profileRow.streakFreezes,
              todayMinutes: profileRow.todayMinutes,
              todayMinutesDate: profileRow.todayMinutesDate,
              dailyGoalMetCount: profileRow.dailyGoalMetCount,
              dailyGoalMetDate: profileRow.dailyGoalMetDate,
              dailyGoalMinutes: profileRow.dailyGoalMinutes,
              newIntroducedToday: profileRow.newIntroducedToday,
              reviewsDoneToday: profileRow.reviewsDoneToday,
              dailyCountsDate: profileRow.dailyCountsDate,
              studyEpochStart: iso(profileRow.studyEpochStart),
              studyEpochEnd: iso(profileRow.studyEpochEnd),
              lastReviewEpochEnd: iso(profileRow.lastReviewEpochEnd),
              goalMetEpochStart: iso(profileRow.goalMetEpochStart),
              desiredRetention: profileRow.desiredRetention,
              agentInstructions: profileRow.agentInstructions,
              plantSpecies: profileRow.plantSpecies,
              plantStage: profileRow.plantStage,
              unlockedSpecies: profileRow.unlockedSpecies,
              createdAt: requiredIso(profileRow.createdAt),
              updatedAt: requiredIso(profileRow.updatedAt),
            }
          : null,
        studyDayPolicy: policyRow
          ? {
              userId: policyRow.userId,
              timeZone: policyRow.timeZone,
              rolloverMinute: policyRow.rolloverMinute,
              updatedAt: requiredIso(policyRow.updatedAt),
            }
          : null,
        reminders: reminderRow
          ? {
              userId: reminderRow.userId,
              digestEnabled: reminderRow.digestEnabled,
              streakWarningEnabled: reminderRow.streakWarningEnabled,
              timeZone: reminderRow.timeZone,
              digestHour: reminderRow.digestHour,
              streakHour: reminderRow.streakHour,
              emailEnabled: reminderRow.emailEnabled,
              pushEnabled: reminderRow.pushEnabled,
              locale: reminderRow.locale,
              updatedAt: requiredIso(reminderRow.updatedAt),
            }
          : null,
        presets: byId(
          presetRows.map((row) => ({
            id: row.id,
            userId: row.userId,
            name: row.name,
            newPerDay: row.newPerDay,
            reviewsPerDay: row.reviewsPerDay,
            learningSteps: row.learningSteps,
            relearningSteps: row.relearningSteps,
            desiredRetention: row.desiredRetention,
            leechThreshold: row.leechThreshold,
            maximumInterval: row.maximumInterval,
            createdAt: requiredIso(row.createdAt),
            updatedAt: requiredIso(row.updatedAt),
          })),
        ),
        decks: byId(
          deckRows.map((row) => ({
            id: row.id,
            metadataRevision: row.metadataRevision,
            userId: row.userId,
            parentId: row.parentId,
            name: row.name,
            color: row.color,
            icon: row.icon,
            position: row.position,
            species: row.species,
            presetId: row.presetId,
            createdAt: requiredIso(row.createdAt),
          })),
        ),
        filteredDecks: byId(
          filteredRows.map((row) => ({
            id: row.id,
            userId: row.userId,
            name: row.name,
            query: row.query,
            sortOrder: row.sortOrder,
            cardLimit: row.cardLimit,
            includeSuspended: row.includeSuspended,
            createdAt: requiredIso(row.createdAt),
            updatedAt: requiredIso(row.updatedAt),
          })),
        ),
        noteTypes: byId(
          noteTypeRows.map((row) => ({
            id: row.id,
            userId: row.userId,
            name: row.name,
            fields: row.fields,
            templates: row.templates,
            styling: row.styling,
            kind: row.kind,
            isBuiltin: row.isBuiltin,
            createdAt: requiredIso(row.createdAt),
            updatedAt: requiredIso(row.updatedAt),
          })),
        ),
        notes: byId(
          noteRows.map((row) => ({
            id: row.id,
            userId: row.userId,
            noteTypeId: row.noteTypeId,
            fieldValues: row.fieldValues,
            acceptedAnswers: row.acceptedAnswers,
            tags: row.tags,
            createdAt: requiredIso(row.createdAt),
            updatedAt: requiredIso(row.updatedAt),
          })),
        ),
        cards: byId(
          cardRows.map((row) => ({
            id: row.id,
            userId: row.userId,
            deckId: row.deckId,
            noteId: row.noteId,
            templateOrd: row.templateOrd,
            clozeNumber: row.clozeNumber,
            renderText: row.renderText,
            renderFrontText: row.renderFrontText,
            renderBackText: row.renderBackText,
            renderKind: row.renderKind,
            due: requiredIso(row.due),
            stability: row.stability,
            difficulty: row.difficulty,
            elapsedDays: row.elapsedDays,
            scheduledDays: row.scheduledDays,
            learningSteps: row.learningSteps,
            reps: row.reps,
            lapses: row.lapses,
            state: row.state,
            lastReview: iso(row.lastReview),
            createdAt: requiredIso(row.createdAt),
            updatedAt: requiredIso(row.updatedAt),
            suspended: row.suspended,
          })),
        ),
        reviews: byId(
          reviewRows.map((row) => ({
            id: row.id,
            userId: row.userId,
            cardId: row.cardId,
            deckId: row.deckId,
            rating: row.rating,
            durationMs: row.durationMs,
            reviewedAt: requiredIso(row.reviewedAt),
            nextDue: requiredIso(row.nextDue),
            nextStability: row.nextStability,
            nextDifficulty: row.nextDifficulty,
            undoSnapshot: row.undoSnapshot,
            studyDay: row.studyDay,
            studyEpochStart: iso(row.studyEpochStart),
          })),
        ),
        media: byId(
          mediaRows.map((row) => ({
            id: row.id,
            userId: row.userId,
            mime: row.mime,
            size: row.size,
            verified: row.verified,
            createdAt: requiredIso(row.createdAt),
            referenced: referencedIds.has(row.id.toLowerCase()),
          })),
        ),
        missingMedia: [...referencedIds]
          .filter((id) => !ownedIds.has(id))
          .sort()
          .map((id) => ({ id, reason: 'not_owned' as const })),
      };
      return body;
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );

  const maxBytes = maxBytesForTests ?? EXPORT_MAX_BYTES;
  const bytes = Buffer.byteLength(JSON.stringify(snapshot));
  if (bytes > maxBytes) throw new StudyExportTooLarge(maxBytes);
  return snapshot;
}

export function rehearsalReport(snapshot: StudySnapshot, startedMs: number) {
  return {
    dryRun: true as const,
    schemaVersion: snapshot.schemaVersion,
    coherent: snapshotCoherent(snapshot),
    counts: countsOf(snapshot),
    bytes: Buffer.byteLength(JSON.stringify(snapshot)),
    lossWindow: LOSS_WINDOW,
    mediaNote: MEDIA_NOTE,
    migrationHead: readMigrationHead(),
    elapsedMs: Date.now() - startedMs,
  };
}
