import { and, count, eq, isNull, sql } from 'drizzle-orm';
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
import { NoteTagError, normalizeNoteTags } from '@reomi/shared';
import { insertExportedNoteRevisions } from '../modules/note-revisions.ts';
import {
  EXPORT_MAX_BYTES,
  type StudySnapshot,
  snapshotCoherent,
} from './study-snapshot.ts';

export interface ApplySuccess {
  ok: true;
  elapsedMs: number;
  counts: {
    presets: number;
    decks: number;
    filteredDecks: number;
    noteTypes: number;
    notes: number;
    cards: number;
    reviews: number;
    media: number;
  };
}

export interface ApplyFailure {
  ok: false;
  error: 'incoherent_snapshot' | 'target_not_empty' | 'user_missing' | 'export_too_large' | 'tag_too_long' | 'too_many_tags';
}

function currentDatabaseUrl(): string {
  if (process.env.NODE_ENV === 'test') {
    const testUrl = process.env.TEST_DATABASE_URL;
    if (!testUrl) throw new Error('NODE_ENV=test but TEST_DATABASE_URL is not set');
    return testUrl;
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  return url;
}

export function assertRehearsalDatabase(databaseUrl: string): string {
  let name = '';
  try {
    name = new URL(databaseUrl).pathname.replace(/^\//, '');
  } catch {
    name = '';
  }
  const slash = name.indexOf('/');
  if (slash >= 0) name = name.slice(0, slash);
  if (!/^(?:.+_)?(?:test|rehearsal)$/i.test(name)) {
    throw new Error(`refusing restore rehearsal against database "${name}"`);
  }
  return name;
}

function asDate(value: unknown): Date | null {
  if (value == null) return null;
  return new Date(String(value));
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

function normalizedSnapshotTags(value: unknown): string[] {
  const tags = normalizeNoteTags(asStringArray(value));
  if (!tags.ok) throw new NoteTagError(tags.error);
  return tags.tags;
}

function decksInParentOrder(rows: StudySnapshot['decks']): StudySnapshot['decks'] {
  const pending = new Set(rows.map((row) => String(row.id)));
  const ordered: StudySnapshot['decks'] = [];
  while (pending.size > 0) {
    let progressed = false;
    for (const id of [...pending]) {
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) return rows;
      if (row.parentId == null || !pending.has(String(row.parentId))) {
        ordered.push(row);
        pending.delete(id);
        progressed = true;
      }
    }
    if (!progressed) return rows;
  }
  return ordered;
}

async function occupiedStudyRows(tx: Parameters<Parameters<typeof db.transaction>[0]>[0], userId: string) {
  const tables = [deckOptionsPreset, decks, filteredDeck, notes, cards, reviews, media] as const;
  let total = 0;
  for (const table of tables) {
    const [row] = await tx.select({ n: count() }).from(table).where(eq(table.userId, userId));
    total += Number(row?.n ?? 0);
  }
  const [ownedTypes] = await tx.select({ n: count() }).from(noteTypes).where(eq(noteTypes.userId, userId));
  total += Number(ownedTypes?.n ?? 0);
  return total;
}

async function insertSnapshot(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  snapshot: StudySnapshot,
) {
  for (const row of snapshot.presets) {
    await tx.insert(deckOptionsPreset).values({
      id: String(row.id),
      userId: String(row.userId),
      name: String(row.name),
      newPerDay: Number(row.newPerDay),
      reviewsPerDay: Number(row.reviewsPerDay),
      learningSteps: asStringArray(row.learningSteps),
      relearningSteps: asStringArray(row.relearningSteps),
      desiredRetention: row.desiredRetention == null ? null : Number(row.desiredRetention),
      leechThreshold: Number(row.leechThreshold),
      maximumInterval: Number(row.maximumInterval),
      createdAt: asDate(row.createdAt) ?? new Date(),
      updatedAt: asDate(row.updatedAt) ?? new Date(),
    });
  }

  for (const row of decksInParentOrder(snapshot.decks)) {
    await tx.insert(decks).values({
      id: String(row.id),
      metadataRevision: Number(row.metadataRevision ?? 0),
      userId: String(row.userId),
      parentId: row.parentId == null ? null : String(row.parentId),
      name: String(row.name),
      color: row.color as typeof decks.$inferInsert.color,
      icon: row.icon == null ? null : String(row.icon),
      position: Number(row.position ?? 0),
      species: row.species as typeof decks.$inferInsert.species,
      presetId: row.presetId == null ? null : String(row.presetId),
      createdAt: asDate(row.createdAt) ?? new Date(),
    });
  }

  const noteTypeIds = new Map<string, string>();
  for (const row of snapshot.noteTypes) {
    const values = {
      id: String(row.id),
      userId: row.userId == null ? null : String(row.userId),
      name: String(row.name),
      fields: row.fields as typeof noteTypes.$inferInsert.fields,
      templates: row.templates as typeof noteTypes.$inferInsert.templates,
      styling: String(row.styling ?? ''),
      kind: String(row.kind ?? 'custom'),
      isBuiltin: Boolean(row.isBuiltin),
      createdAt: asDate(row.createdAt) ?? new Date(),
      updatedAt: asDate(row.updatedAt) ?? new Date(),
    };
    if (values.userId == null && values.isBuiltin) {
      const [existing] = await tx
        .select({ id: noteTypes.id })
        .from(noteTypes)
        .where(and(isNull(noteTypes.userId), eq(noteTypes.isBuiltin, true), eq(noteTypes.name, values.name)));
      if (existing) {
        noteTypeIds.set(values.id, existing.id);
        continue;
      }
      await tx.insert(noteTypes).values(values);
      noteTypeIds.set(values.id, values.id);
    } else if (values.userId == null) {
      await tx.insert(noteTypes).values(values).onConflictDoNothing({ target: noteTypes.id });
      noteTypeIds.set(values.id, values.id);
    } else {
      await tx.insert(noteTypes).values(values);
      noteTypeIds.set(values.id, values.id);
    }
  }

  for (const row of snapshot.notes) {
    const requestedTypeId = String(row.noteTypeId);
    await tx.insert(notes).values({
      id: String(row.id),
      userId: String(row.userId),
      noteTypeId: noteTypeIds.get(requestedTypeId) ?? requestedTypeId,
      fieldValues: row.fieldValues as typeof notes.$inferInsert.fieldValues,
      acceptedAnswers: asStringArray(row.acceptedAnswers),
      tags: normalizedSnapshotTags(row.tags),
      createdAt: asDate(row.createdAt) ?? new Date(),
      updatedAt: asDate(row.updatedAt) ?? new Date(),
    });
  }
  await insertExportedNoteRevisions(tx, snapshot, noteTypeIds);

  for (const row of snapshot.cards) {
    await tx.insert(cards).values({
      id: String(row.id),
      userId: String(row.userId),
      deckId: String(row.deckId),
      noteId: String(row.noteId),
      templateOrd: Number(row.templateOrd ?? 0),
      clozeNumber: row.clozeNumber == null ? null : Number(row.clozeNumber),
      renderText: String(row.renderText ?? ''),
      renderFrontText: String(row.renderFrontText ?? ''),
      renderBackText: String(row.renderBackText ?? ''),
      renderKind: String(row.renderKind ?? 'basic'),
      due: asDate(row.due) ?? new Date(),
      stability: Number(row.stability ?? 0),
      difficulty: Number(row.difficulty ?? 0),
      elapsedDays: Number(row.elapsedDays ?? 0),
      scheduledDays: Number(row.scheduledDays ?? 0),
      learningSteps: Number(row.learningSteps ?? 0),
      reps: Number(row.reps ?? 0),
      lapses: Number(row.lapses ?? 0),
      state: row.state as typeof cards.$inferInsert.state,
      lastReview: asDate(row.lastReview),
      createdAt: asDate(row.createdAt) ?? new Date(),
      updatedAt: asDate(row.updatedAt) ?? new Date(),
      suspended: Boolean(row.suspended),
    });
  }

  for (const row of snapshot.reviews) {
    await tx.insert(reviews).values({
      id: String(row.id),
      userId: String(row.userId),
      cardId: String(row.cardId),
      deckId: row.deckId == null ? null : String(row.deckId),
      rating: Number(row.rating),
      durationMs: Number(row.durationMs ?? 0),
      reviewedAt: asDate(row.reviewedAt) ?? new Date(),
      nextDue: asDate(row.nextDue) ?? new Date(),
      nextStability: Number(row.nextStability ?? 0),
      nextDifficulty: Number(row.nextDifficulty ?? 0),
      undoSnapshot: (row.undoSnapshot ?? null) as typeof reviews.$inferInsert.undoSnapshot,
      studyDay: row.studyDay == null ? null : String(row.studyDay),
      studyEpochStart: asDate(row.studyEpochStart),
    });
  }

  for (const row of snapshot.filteredDecks) {
    await tx.insert(filteredDeck).values({
      id: String(row.id),
      userId: String(row.userId),
      name: String(row.name),
      query: String(row.query),
      sortOrder: String(row.sortOrder ?? 'due'),
      cardLimit: Number(row.cardLimit ?? 50),
      includeSuspended: Boolean(row.includeSuspended),
      createdAt: asDate(row.createdAt) ?? new Date(),
      updatedAt: asDate(row.updatedAt) ?? new Date(),
    });
  }

  for (const row of snapshot.media) {
    await tx.insert(media).values({
      id: row.id,
      userId: snapshot.user.id,
      s3Key: `media/${row.id}`,
      mime: row.mime,
      size: row.size,
      verified: row.verified,
      createdAt: asDate(row.createdAt) ?? new Date(),
    });
  }

  if (snapshot.studyDayPolicy) {
    const [existing] = await tx
      .select({ userId: studyDayPolicy.userId })
      .from(studyDayPolicy)
      .where(eq(studyDayPolicy.userId, snapshot.user.id));
    if (!existing) {
      await tx.insert(studyDayPolicy).values({
        userId: snapshot.user.id,
        timeZone: String(snapshot.studyDayPolicy.timeZone),
        rolloverMinute: Number(snapshot.studyDayPolicy.rolloverMinute),
        updatedAt: asDate(snapshot.studyDayPolicy.updatedAt) ?? new Date(),
      });
    }
  }

  if (snapshot.reminders) {
    const [existing] = await tx
      .select({ userId: notificationSettings.userId })
      .from(notificationSettings)
      .where(eq(notificationSettings.userId, snapshot.user.id));
    if (!existing) {
      await tx.insert(notificationSettings).values({
        userId: snapshot.user.id,
        digestEnabled: Boolean(snapshot.reminders.digestEnabled),
        streakWarningEnabled: Boolean(snapshot.reminders.streakWarningEnabled),
        timeZone: String(snapshot.reminders.timeZone),
        digestHour: Number(snapshot.reminders.digestHour),
        streakHour: Number(snapshot.reminders.streakHour),
        emailEnabled: Boolean(snapshot.reminders.emailEnabled),
        pushEnabled: Boolean(snapshot.reminders.pushEnabled),
        locale: String(snapshot.reminders.locale),
        updatedAt: asDate(snapshot.reminders.updatedAt) ?? new Date(),
      });
    }
  }

  if (snapshot.profile) {
    const [existing] = await tx
      .select({ userId: profile.userId })
      .from(profile)
      .where(eq(profile.userId, snapshot.user.id));
    if (!existing) {
      const row = snapshot.profile;
      await tx.insert(profile).values({
        userId: snapshot.user.id,
        name: String(row.name),
        level: Number(row.level ?? 1),
        xp: Number(row.xp ?? 0),
        streakDays: Number(row.streakDays ?? 0),
        lastReviewDate: row.lastReviewDate == null ? null : String(row.lastReviewDate),
        streakFreezes: Number(row.streakFreezes ?? 0),
        todayMinutes: Number(row.todayMinutes ?? 0),
        todayMinutesDate: row.todayMinutesDate == null ? null : String(row.todayMinutesDate),
        dailyGoalMetCount: Number(row.dailyGoalMetCount ?? 0),
        dailyGoalMetDate: row.dailyGoalMetDate == null ? null : String(row.dailyGoalMetDate),
        dailyGoalMinutes: Number(row.dailyGoalMinutes ?? 15),
        newIntroducedToday: Number(row.newIntroducedToday ?? 0),
        reviewsDoneToday: Number(row.reviewsDoneToday ?? 0),
        dailyCountsDate: row.dailyCountsDate == null ? null : String(row.dailyCountsDate),
        studyEpochStart: asDate(row.studyEpochStart),
        studyEpochEnd: asDate(row.studyEpochEnd),
        lastReviewEpochEnd: asDate(row.lastReviewEpochEnd),
        goalMetEpochStart: asDate(row.goalMetEpochStart),
        desiredRetention: row.desiredRetention == null ? null : Number(row.desiredRetention),
        agentInstructions: row.agentInstructions == null ? null : String(row.agentInstructions),
        plantSpecies: row.plantSpecies as typeof profile.$inferInsert.plantSpecies,
        plantStage: Number(row.plantStage ?? 0),
        unlockedSpecies: asStringArray(row.unlockedSpecies),
        createdAt: asDate(row.createdAt) ?? new Date(),
        updatedAt: asDate(row.updatedAt) ?? new Date(),
      });
    }
  }
}

export async function applyStudySnapshot(input: unknown): Promise<ApplySuccess | ApplyFailure> {
  const started = Date.now();
  assertRehearsalDatabase(currentDatabaseUrl());
  if (!input || typeof input !== 'object') return { ok: false, error: 'incoherent_snapshot' };
  const snapshot = input as StudySnapshot;
  if (!snapshotCoherent(snapshot)) return { ok: false, error: 'incoherent_snapshot' };
  if (Buffer.byteLength(JSON.stringify(snapshot)) > EXPORT_MAX_BYTES) {
    return { ok: false, error: 'export_too_large' };
  }

  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select id from "user" where id = ${snapshot.user.id} for update`);
      const [account] = await tx
        .select({ id: userTable.id })
        .from(userTable)
        .where(eq(userTable.id, snapshot.user.id));
      if (!account) return { ok: false, error: 'user_missing' };
      if ((await occupiedStudyRows(tx, snapshot.user.id)) > 0) {
        return { ok: false, error: 'target_not_empty' };
      }
      await insertSnapshot(tx, snapshot);
      return {
        ok: true,
        elapsedMs: Date.now() - started,
        counts: {
          presets: snapshot.presets.length,
          decks: snapshot.decks.length,
          filteredDecks: snapshot.filteredDecks.length,
          noteTypes: snapshot.noteTypes.length,
          notes: snapshot.notes.length,
          cards: snapshot.cards.length,
          reviews: snapshot.reviews.length,
          media: snapshot.media.length,
        },
      };
    });
  } catch (error) {
    if (error instanceof NoteTagError) return { ok: false, error: error.code };
    throw error;
  }
}
