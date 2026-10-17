import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, test } from 'bun:test';
import { and, eq, isNull } from 'drizzle-orm';
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
  reviews,
  studyDayPolicy,
} from '@reomi/db';
import { newUuidV7 } from '@reomi/shared';
import { buildApp } from '../src/app.ts';
import { applyStudySnapshot, assertRehearsalDatabase } from '../src/profile/restore-rehearsal.ts';
import {
  __setStudyExportMaxBytesForTests,
  __setStudyExportPauseForTests,
  type StudySnapshot,
} from '../src/profile/study-snapshot.ts';
import { callApp, resetTestDb, seedBasicCard, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();
const LOSS_WINDOW =
  'Commits that land after this snapshot are not in the file. A grade is included with its card state or not at all.';
const MEDIA_NOTE =
  'Image bytes stay in object storage. The snapshot lists each owned file and rebuilds its key as media/<id> on an empty account. It does not copy the bytes.';

beforeEach(async () => {
  __setStudyExportPauseForTests(null);
  __setStudyExportMaxBytesForTests(null);
  await resetTestDb();
});

async function ok<T>(res: Awaited<ReturnType<typeof callApp>>, label: string): Promise<T> {
  if (res.status !== 200) throw new Error(`${label} ${res.status} ${await res.text()}`);
  return res.json<T>();
}

describe('study export snapshot', () => {
  test('GET /profile/export is one versioned snapshot of presets, filtered decks, and media', async () => {
    const email = uniqueEmail('snap');
    const { cookie, userId } = await signUpAndCookie(app, email);
    await ok(await callApp(app, 'GET', '/profile', { cookie }), 'profile');
    const preset = await ok<{ id: string }>(
      await callApp(app, 'POST', '/deck-options', {
        cookie,
        body: {
          name: 'Rehearsal preset',
          newPerDay: 7,
          reviewsPerDay: 40,
          learningSteps: ['1m'],
          relearningSteps: ['10m'],
          desiredRetention: 0.85,
          leechThreshold: 4,
          maximumInterval: 100,
        },
      }),
      'preset',
    );
    const deck = await ok<{ id: string }>(
      await callApp(app, 'POST', '/decks', { cookie, body: { name: 'Home deck' } }),
      'deck',
    );
    await ok(
      await callApp(app, 'PATCH', `/decks/${deck.id}`, { cookie, body: { presetId: preset.id } }),
      'bind preset',
    );
    await ok(
      await callApp(app, 'POST', '/filtered-decks', {
        cookie,
        body: { name: 'Cram rehearsal', query: 'is:review', sortOrder: 'due', cardLimit: 12, includeSuspended: false },
      }),
      'filtered',
    );
    const ownedId = newUuidV7();
    const missingId = newUuidV7();
    await db.insert(media).values({
      id: ownedId,
      userId,
      s3Key: `media/${ownedId}`,
      mime: 'image/png',
      size: 12,
      verified: true,
    });
    const card = await seedBasicCard(app, cookie, {
      deckId: deck.id,
      front: `HarborFront ![](/m/${ownedId}) ![](/m/${missingId})`,
      back: 'answer',
    });
    await ok(
      await callApp(app, 'PUT', '/profile/reminders', {
        cookie,
        body: {
          digestEnabled: true,
          streakWarningEnabled: false,
          timeZone: 'America/New_York',
          digestHour: 9,
          streakHour: 21,
          emailEnabled: false,
          pushEnabled: false,
          locale: 'en',
        },
      }),
      'reminders',
    );
    await ok(
      await callApp(app, 'PATCH', '/profile/study-day', {
        cookie,
        body: { timeZone: 'Europe/Berlin', rolloverMinute: 120 },
      }),
      'study day',
    );
    const graded = await ok<{ card: { reps: number } }>(
      await callApp(app, 'POST', '/reviews', { cookie, body: { cardId: card.id, rating: 3, durationMs: 1000 } }),
      'grade',
    );
    expect(graded.card.reps).toBe(1);

    const exported = await callApp(app, 'GET', '/profile/export', { cookie });
    expect(exported.status).toBe(200);
    const text = await exported.text();
    const body = JSON.parse(text) as StudySnapshot;
    expect(exported.headers['content-disposition']).toBe('attachment; filename="reomi-study-export.json"');
    expect(exported.headers['cache-control']).toBe('no-store');
    expect(exported.headers['x-content-type-options']).toBe('nosniff');
    expect(body.schemaVersion).toBe(2);
    expect(body.isolation).toBe('repeatable read');
    expect(body.lossWindow).toBe(LOSS_WINDOW);
    expect(body.mediaNote).toBe(MEDIA_NOTE);
    expect(body.user.email).toBe(email);
    expect(body.presets.map((row) => [row.name, row.newPerDay])).toEqual([['Rehearsal preset', 7]]);
    expect(body.filteredDecks.map((row) => [row.name, row.cardLimit])).toEqual([['Cram rehearsal', 12]]);
    expect(body.decks.map((row) => row.presetId)).toEqual([preset.id]);
    expect(body.studyDayPolicy).toMatchObject({ timeZone: 'Europe/Berlin', rolloverMinute: 120 });
    expect(body.reminders).toMatchObject({ digestHour: 9, timeZone: 'America/New_York' });
    expect(body.media).toEqual([
      {
        id: ownedId,
        userId,
        mime: 'image/png',
        size: 12,
        verified: true,
        createdAt: body.media[0]!.createdAt,
        referenced: true,
      },
    ]);
    expect(body.missingMedia).toEqual([{ id: missingId, reason: 'not_owned' }]);
    expect(text).not.toContain(`media/${ownedId}`);
    expect(text).not.toContain('testtest123');
    expect(body.cards.map((row) => [row.id, row.reps])).toEqual([[card.id, 1]]);
    expect(body.reviews.map((row) => row.cardId)).toEqual([card.id]);

    const journal = JSON.parse(
      readFileSync(new URL('../../../packages/db/src/migrations/meta/_journal.json', import.meta.url), 'utf8'),
    ) as { entries: { tag: string }[] };
    const head = journal.entries[journal.entries.length - 1]!.tag;
    const report = await ok<{
      dryRun: boolean;
      counts: { cards: number; reviews: number; presets: number; filteredDecks: number; media: number; missingMedia: number };
      bytes: number;
      lossWindow: string;
      mediaNote: string;
      migrationHead: string;
      coherent: boolean;
    }>(await callApp(app, 'POST', '/profile/export/rehearse', { cookie }), 'rehearse');
    expect(report.dryRun).toBe(true);
    expect(report.coherent).toBe(true);
    expect(report.lossWindow).toBe(LOSS_WINDOW);
    expect(report.mediaNote).toBe(MEDIA_NOTE);
    expect(report.migrationHead).toBe(head);
    expect(report.counts).toMatchObject({
      cards: 1,
      reviews: 1,
      presets: 1,
      filteredDecks: 1,
      media: 1,
      missingMedia: 1,
    });
    expect(report.bytes).toBe(Buffer.byteLength(text));
    const after = JSON.parse(await (await callApp(app, 'GET', '/profile/export', { cookie })).text()) as StudySnapshot;
    expect(after.reviews.map((row) => row.cardId)).toEqual([card.id]);
    expect(after.cards.map((row) => row.reps)).toEqual([1]);
  });

  test('a grade that commits after the snapshot pin is absent from the file', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail('pin'));
    await ok(await callApp(app, 'GET', '/profile', { cookie }), 'profile');
    const deck = await ok<{ id: string }>(
      await callApp(app, 'POST', '/decks', { cookie, body: { name: 'Pinned deck' } }),
      'deck',
    );
    const card = await seedBasicCard(app, cookie, { deckId: deck.id, front: 'Pinned front', back: 'back' });
    const first = await ok<{ review: { id: string }; card: { reps: number } }>(
      await callApp(app, 'POST', '/reviews', {
        cookie,
        body: { cardId: card.id, rating: 3, durationMs: 500 },
      }),
      'first grade',
    );
    expect(first.card.reps).toBe(1);
    let secondReviewId = '';
    __setStudyExportPauseForTests(async () => {
      const graded = await ok<{ review: { id: string }; card: { reps: number } }>(
        await callApp(app, 'POST', '/reviews', {
          cookie,
          body: { cardId: card.id, rating: 3, durationMs: 500 },
        }),
        'second grade',
      );
      secondReviewId = graded.review.id;
      expect(graded.card.reps).toBe(2);
    });
    try {
      const body = await ok<StudySnapshot>(await callApp(app, 'GET', '/profile/export', { cookie }), 'export');
      expect(secondReviewId).not.toBe('');
      expect(body.cards.map((row) => [row.id, row.reps])).toEqual([[card.id, 1]]);
      expect(body.reviews.map((row) => row.id)).toEqual([first.review.id]);
      expect(body.reviews.map((row) => row.id)).not.toContain(secondReviewId);
    } finally {
      __setStudyExportPauseForTests(null);
    }
    const [live] = await db.select({ reps: cards.reps }).from(cards).where(eq(cards.id, card.id));
    expect(live?.reps).toBe(2);
    const liveReviews = await db.select({ id: reviews.id }).from(reviews).where(eq(reviews.cardId, card.id));
    expect(liveReviews.map((row) => row.id).sort()).toEqual([first.review.id, secondReviewId].sort());
  });

  test('rehearsal restores an empty account and a later grade sees the saved review', async () => {
    const email = uniqueEmail('restore');
    const owner = await signUpAndCookie(app, email);
    const stranger = await signUpAndCookie(app, uniqueEmail('stranger'));
    await ok(await callApp(app, 'GET', '/profile', { cookie: owner.cookie }), 'profile');
    await ok(await callApp(app, 'GET', '/profile', { cookie: stranger.cookie }), 'stranger profile');
    await ok(
      await callApp(app, 'POST', '/decks', { cookie: stranger.cookie, body: { name: 'Stranger deck stays' } }),
      'stranger deck',
    );
    const preset = await ok<{ id: string }>(
      await callApp(app, 'POST', '/deck-options', {
        cookie: owner.cookie,
        body: {
          name: 'Rehearsal preset',
          newPerDay: 7,
          reviewsPerDay: 40,
          learningSteps: ['1m'],
          relearningSteps: ['10m'],
          desiredRetention: 0.85,
          leechThreshold: 4,
          maximumInterval: 100,
        },
      }),
      'preset',
    );
    const deck = await ok<{ id: string }>(
      await callApp(app, 'POST', '/decks', { cookie: owner.cookie, body: { name: 'Home deck' } }),
      'deck',
    );
    await ok(
      await callApp(app, 'PATCH', `/decks/${deck.id}`, { cookie: owner.cookie, body: { presetId: preset.id } }),
      'bind',
    );
    await ok(
      await callApp(app, 'POST', '/filtered-decks', {
        cookie: owner.cookie,
        body: { name: 'Cram rehearsal', query: 'is:review', cardLimit: 12 },
      }),
      'filtered',
    );
    const ownedId = newUuidV7();
    await db.insert(media).values({
      id: ownedId,
      userId: owner.userId,
      s3Key: `media/${ownedId}`,
      mime: 'image/png',
      size: 4,
      verified: false,
    });
    const card = await seedBasicCard(app, owner.cookie, {
      deckId: deck.id,
      front: `![](/m/${ownedId})`,
      back: 'kept',
    });
    await ok(
      await callApp(app, 'PUT', '/profile/reminders', {
        cookie: owner.cookie,
        body: {
          digestEnabled: true,
          streakWarningEnabled: false,
          timeZone: 'America/New_York',
          digestHour: 9,
          streakHour: 21,
          emailEnabled: false,
          pushEnabled: false,
          locale: 'en',
        },
      }),
      'reminders',
    );
    await ok(
      await callApp(app, 'PATCH', '/profile/study-day', {
        cookie: owner.cookie,
        body: { timeZone: 'Europe/Berlin', rolloverMinute: 120 },
      }),
      'study day',
    );
    await ok(
      await callApp(app, 'POST', '/reviews', {
        cookie: owner.cookie,
        body: { cardId: card.id, rating: 3, durationMs: 1000 },
      }),
      'first grade',
    );
    const snapshot = JSON.parse(
      await (await callApp(app, 'GET', '/profile/export', { cookie: owner.cookie })).text(),
    ) as StudySnapshot;

    const broken = structuredClone(snapshot);
    broken.cards = [];
    const rejected = await applyStudySnapshot(broken);
    expect(rejected).toEqual({ ok: false, error: 'incoherent_snapshot' });
    const stillThere = JSON.parse(
      await (await callApp(app, 'GET', '/profile/export', { cookie: owner.cookie })).text(),
    ) as StudySnapshot;
    expect(stillThere.reviews.map((row) => row.cardId)).toEqual([card.id]);

    await db.delete(notes).where(eq(notes.userId, owner.userId));
    await db.delete(decks).where(eq(decks.userId, owner.userId));
    await db.delete(filteredDeck).where(eq(filteredDeck.userId, owner.userId));
    await db.delete(deckOptionsPreset).where(eq(deckOptionsPreset.userId, owner.userId));
    await db.delete(media).where(eq(media.userId, owner.userId));
    await db.delete(noteTypes).where(eq(noteTypes.userId, owner.userId));
    await db.delete(notificationSettings).where(eq(notificationSettings.userId, owner.userId));
    await db.delete(studyDayPolicy).where(eq(studyDayPolicy.userId, owner.userId));

    const restored = await applyStudySnapshot(snapshot);
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(restored.counts.reviews).toBe(1);
    expect(restored.counts.media).toBe(1);
    const again = await applyStudySnapshot(snapshot);
    expect(again).toEqual({ ok: false, error: 'target_not_empty' });

    const presets = await ok<{ name: string; newPerDay: number }[]>(
      await callApp(app, 'GET', '/deck-options', { cookie: owner.cookie }),
      'list presets',
    );
    expect(presets.map((row) => [row.name, row.newPerDay])).toEqual([['Rehearsal preset', 7]]);
    const filtered = await ok<{ name: string; cardLimit: number }[]>(
      await callApp(app, 'GET', '/filtered-decks', { cookie: owner.cookie }),
      'list filtered',
    );
    expect(filtered.map((row) => [row.name, row.cardLimit])).toEqual([['Cram rehearsal', 12]]);
    const studyDay = await ok<{ zone: string; rolloverMinute: number }>(
      await callApp(app, 'GET', '/profile/study-day', { cookie: owner.cookie }),
      'read study day',
    );
    expect(studyDay.zone).toBe('Europe/Berlin');
    expect(studyDay.rolloverMinute).toBe(120);
    const reminders = await ok<{ digestHour: number }>(
      await callApp(app, 'GET', '/profile/reminders', { cookie: owner.cookie }),
      'read reminders',
    );
    expect(reminders.digestHour).toBe(9);
    const roundTrip = await (await callApp(app, 'GET', '/profile/export', { cookie: owner.cookie })).text();
    expect(roundTrip).toContain(`/m/${ownedId}`);
    expect(roundTrip).not.toContain(`media/${ownedId}`);

    const second = await ok<{ card: { reps: number } }>(
      await callApp(app, 'POST', '/reviews', {
        cookie: owner.cookie,
        body: { cardId: card.id, rating: 3, durationMs: 800 },
      }),
      'second grade',
    );
    expect(second.card.reps).toBe(2);
    const afterGrade = JSON.parse(
      await (await callApp(app, 'GET', '/profile/export', { cookie: owner.cookie })).text(),
    ) as StudySnapshot;
    expect(afterGrade.reviews.map((row) => row.cardId).sort()).toEqual([card.id, card.id].sort());
    expect(afterGrade.reviews).toHaveLength(2);
    const strangerDecks = await ok<{ name: string }[]>(
      await callApp(app, 'GET', '/decks', { cookie: stranger.cookie }),
      'stranger decks',
    );
    expect(strangerDecks.map((row) => row.name)).toEqual(['Stranger deck stays']);

    let refusal = '';
    try {
      assertRehearsalDatabase('postgres://u:p@localhost:5432/neuronexus');
    } catch (error) {
      refusal = error instanceof Error ? error.message : '';
    }
    expect(refusal).toBe('refusing restore rehearsal against database "neuronexus"');
    expect(assertRehearsalDatabase('postgres://u:p@localhost:5432/neuronexus_test')).toBe('neuronexus_test');
  });

  test('a long-lived builtin id is remapped onto the live builtin name', async () => {
    const owner = await signUpAndCookie(app, uniqueEmail('builtin'));
    await ok(await callApp(app, 'GET', '/profile', { cookie: owner.cookie }), 'profile');
    const deck = await ok<{ id: string }>(
      await callApp(app, 'POST', '/decks', { cookie: owner.cookie, body: { name: 'Builtin deck' } }),
      'deck',
    );
    const card = await seedBasicCard(app, owner.cookie, { deckId: deck.id, front: 'front', back: 'back' });
    const liveId = newUuidV7();
    await db.insert(noteTypes).values({
      id: liveId,
      userId: null,
      name: 'Rehearsal Builtin',
      fields: [{ name: 'Front' }],
      templates: [],
      kind: 'basic',
      isBuiltin: true,
    });
    const snapshot = JSON.parse(
      await (await callApp(app, 'GET', '/profile/export', { cookie: owner.cookie })).text(),
    ) as StudySnapshot;
    const exportBuiltinId = newUuidV7();
    const builtin = snapshot.noteTypes.find((row) => row.name === 'Rehearsal Builtin');
    expect(builtin?.id).toBe(liveId);
    if (!builtin) return;
    builtin.id = exportBuiltinId;
    for (const note of snapshot.notes) note.noteTypeId = exportBuiltinId;

    await db.delete(notes).where(eq(notes.userId, owner.userId));
    await db.delete(decks).where(eq(decks.userId, owner.userId));
    await db.delete(noteTypes).where(eq(noteTypes.userId, owner.userId));

    const restored = await applyStudySnapshot(snapshot);
    expect(restored.ok).toBe(true);
    const [note] = await db.select({ noteTypeId: notes.noteTypeId }).from(notes).where(eq(notes.id, card.noteId));
    expect(note?.noteTypeId).toBe(liveId);
    const builtins = await db
      .select({ id: noteTypes.id })
      .from(noteTypes)
      .where(and(isNull(noteTypes.userId), eq(noteTypes.isBuiltin, true), eq(noteTypes.name, 'Rehearsal Builtin')));
    expect(builtins.map((row) => row.id)).toEqual([liveId]);
  });

  test('an export over the size cap returns 413 and no snapshot', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail('cap'));
    await ok(await callApp(app, 'GET', '/profile', { cookie }), 'profile');
    const deck = await ok<{ id: string }>(
      await callApp(app, 'POST', '/decks', { cookie, body: { name: 'Cap deck' } }),
      'deck',
    );
    await seedBasicCard(app, cookie, { deckId: deck.id, front: 'SECRETFRONT', back: 'back' });
    __setStudyExportMaxBytesForTests(80);
    try {
      const res = await callApp(app, 'GET', '/profile/export', { cookie });
      expect(res.status).toBe(413);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: 'export_too_large', maxBytes: 80 });
      expect(text).not.toContain('SECRETFRONT');
    } finally {
      __setStudyExportMaxBytesForTests(null);
    }
  });
});
