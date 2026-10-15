// «Блокноты 2.0» N3 — quiz generation (structural validation) + attempts scoring.
//
// CONTRACT (read from apps/api/src/ai/artifacts.ts + modules/notebooks.ts):
//   * generateArtifact over a type='quiz' row: CAS pending→generating →
//     buildArtifactContext → bounded complete() → parseQuiz (defensive JSON +
//     STRUCTURAL validation: kind ∈ {mcq,tf,open}; mcq options 3..5 + answerIndex
//     in range; tf answer boolean; open answerText non-empty; prompt non-empty
//     ≤500; an invalid question is DROPPED; <3 valid ⇒ error('invalid_quiz')).
//     Surviving questions get FRESH server ids; a sourceChunkId outside the
//     sampled context is nulled. content_json set, content_md NULL.
//   * POST /notebooks/:id/artifacts {type:'quiz', questionCount?} is valid.
//   * POST .../attempts {answers}: quiz + status=ready required (else 400
//     invalid_attempt); unknown questionId → 400 invalid_attempt; mcq/tf scored
//     server-side (a forged `correct` in the body is IGNORED); open = the
//     client's {selfCorrect}; unanswered = incorrect; persists + echoes
//     {id, correct, total, answers}.
//   * GET .../attempts → last 10, newest-first. Foreign artifact → 404.
//
// The generation worker is driven synchronously via generateArtifact(id) over a
// directly-inserted quiz row (mirrors notebook-artifacts.test.ts).

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import {
  db,
  notebookArtifacts as artifactsTable,
  notebooks as notebooksTable,
  notebookSources as notebookSourcesTable,
  quizAttempts as attemptsTable,
  sourceChunks as sourceChunksTable,
  sources as sourcesTable,
} from '@reomi/db';
import type { QuizContent } from '@reomi/shared';
import { buildApp } from '../src/app.ts';
import {
  __resetAiClientForTests,
  __setAiClientForTests,
  type ChatMessage,
} from '../src/ai/openai-client.ts';
import { generateArtifact, parseQuiz } from '../src/ai/artifacts.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();

function installComplete(reply: string | ((m: ChatMessage[]) => string)): void {
  __setAiClientForTests({
    async complete(messages: ChatMessage[]): Promise<string> {
      return typeof reply === 'function' ? reply(messages) : reply;
    },
  });
}

async function freshNotebook(userId: string, title = 'NB'): Promise<string> {
  const [nb] = await db
    .insert(notebooksTable)
    .values({ userId, title })
    .returning({ id: notebooksTable.id });
  return nb!.id;
}

async function seedSource(
  userId: string,
  notebookId: string,
  chunks: string[],
): Promise<{ sourceId: string; chunkIds: string[] }> {
  const [src] = await db
    .insert(sourcesTable)
    .values({ userId, kind: 'pdf', title: 'Doc', status: 'ready', verified: true, chunkCount: chunks.length })
    .returning({ id: sourcesTable.id });
  const sourceId = src!.id;
  await db.insert(notebookSourcesTable).values({ userId, notebookId, sourceId });
  const chunkIds: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const [sc] = await db
      .insert(sourceChunksTable)
      .values({ userId, sourceId, position: i, text: chunks[i]!, embedded: true })
      .returning({ id: sourceChunksTable.id });
    chunkIds.push(sc!.id);
  }
  return { sourceId, chunkIds };
}

async function insertQuizArtifact(
  userId: string,
  notebookId: string,
  sourceIds: string[],
  status = 'pending',
): Promise<string> {
  const [row] = await db
    .insert(artifactsTable)
    .values({ userId, notebookId, type: 'quiz', status, title: 'Квиз', sourceIds })
    .returning({ id: artifactsTable.id });
  return row!.id;
}

function getArtifact(id: string) {
  return db.select().from(artifactsTable).where(eq(artifactsTable.id, id)).limit(1).then((r) => r[0]!);
}

// ── parseQuiz unit ─────────────────────────────────────────────────────────────

describe('parseQuiz — structural validation (unit)', () => {
  const allowed = new Set(['11111111-1111-4111-8111-111111111111']);

  test('a valid mix → fresh ids; bad question dropped; bad chunk nulled', () => {
    const raw = JSON.stringify({
      questions: [
        { kind: 'mcq', prompt: 'Q1', options: ['a', 'b', 'c'], answerIndex: 1, sourceChunkId: '11111111-1111-4111-8111-111111111111' },
        { kind: 'tf', prompt: 'Q2', answer: false },
        { kind: 'open', prompt: 'Q3', answerText: 'because' },
        // out-of-range answerIndex → DROPPED.
        { kind: 'mcq', prompt: 'Q4', options: ['a', 'b'], answerIndex: 5 },
        // bogus sourceChunkId → kept, but chunk nulled.
        { kind: 'tf', prompt: 'Q5', answer: true, sourceChunkId: 'deadbeef-dead-4ead-8ead-deaddeaddead' },
      ],
    });
    const quiz = parseQuiz(raw, allowed)!;
    expect(quiz).toBeTruthy();
    expect(quiz.questions.length).toBe(4); // Q4 dropped
    // Fresh server ids (uuid), distinct.
    const ids = quiz.questions.map((q) => q.id);
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
    // Q1 keeps the allowed chunk; Q5 has its bogus chunk nulled.
    expect(quiz.questions[0]!.sourceChunkId).toBe('11111111-1111-4111-8111-111111111111');
    expect(quiz.questions.find((q) => q.prompt === 'Q5')!.sourceChunkId).toBeUndefined();
  });

  test('<3 valid questions → null', () => {
    const raw = JSON.stringify({
      questions: [
        { kind: 'mcq', prompt: 'Q1', options: ['a', 'b', 'c'], answerIndex: 0 },
        { kind: 'tf', prompt: 'Q2', answer: true },
      ],
    });
    expect(parseQuiz(raw, allowed)).toBeNull();
  });

  test('broken JSON → null', () => {
    expect(parseQuiz('not json at all', allowed)).toBeNull();
    expect(parseQuiz('{"questions": [', allowed)).toBeNull();
  });

  test('mcq with too few / too many options dropped', () => {
    const raw = JSON.stringify({
      questions: [
        { kind: 'mcq', prompt: 'few', options: ['a', 'b'], answerIndex: 0 },
        { kind: 'mcq', prompt: 'many', options: ['a', 'b', 'c', 'd', 'e', 'f'], answerIndex: 0 },
        { kind: 'tf', prompt: 'ok1', answer: true },
        { kind: 'tf', prompt: 'ok2', answer: false },
        { kind: 'open', prompt: 'ok3', answerText: 'x' },
      ],
    });
    const quiz = parseQuiz(raw, allowed)!;
    // The two bad mcqs are dropped; 3 valid survive.
    expect(quiz.questions.map((q) => q.prompt).sort()).toEqual(['ok1', 'ok2', 'ok3']);
  });
});

// ── generation worker ──────────────────────────────────────────────────────────

describe('generateArtifact — quiz', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => __resetAiClientForTests());

  test('valid JSON → ready with content_json (server ids) + content_md NULL', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const { sourceId, chunkIds } = await seedSource(userId, nb, ['alpha', 'beta']);
    installComplete(
      JSON.stringify({
        questions: [
          { kind: 'mcq', prompt: 'What?', options: ['a', 'b', 'c'], answerIndex: 2, sourceChunkId: chunkIds[0] },
          { kind: 'tf', prompt: 'True?', answer: true },
          { kind: 'open', prompt: 'Explain', answerText: 'because' },
          // model-supplied id is IGNORED (server assigns fresh).
          { id: 'model-id-xyz', kind: 'tf', prompt: 'Also?', answer: false },
        ],
      }),
    );

    const id = await insertQuizArtifact(userId, nb, [sourceId]);
    await generateArtifact(id);

    const row = await getArtifact(id);
    expect(row.status).toBe('ready');
    expect(row.contentMd).toBeNull();
    const quiz = row.contentJson as QuizContent;
    expect(quiz.questions.length).toBe(4);
    // Server ids, not 'model-id-xyz'.
    expect(quiz.questions.every((q) => /^[0-9a-f-]{36}$/.test(q.id))).toBe(true);
    expect(quiz.questions.some((q) => q.id === 'model-id-xyz')).toBe(false);
    // The valid chunk id survived (it was in the sampled context).
    expect(quiz.questions[0]!.sourceChunkId).toBe(chunkIds[0]);
  });

  test('answerIndex out of range ⇒ that question dropped (others survive)', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const { sourceId } = await seedSource(userId, nb, ['alpha']);
    installComplete(
      JSON.stringify({
        questions: [
          { kind: 'mcq', prompt: 'bad', options: ['a', 'b', 'c'], answerIndex: 9 },
          { kind: 'tf', prompt: 'g1', answer: true },
          { kind: 'tf', prompt: 'g2', answer: false },
          { kind: 'open', prompt: 'g3', answerText: 'x' },
        ],
      }),
    );

    const id = await insertQuizArtifact(userId, nb, [sourceId]);
    await generateArtifact(id);

    const quiz = (await getArtifact(id)).contentJson as QuizContent;
    expect(quiz.questions.map((q) => q.prompt)).not.toContain('bad');
    expect(quiz.questions.length).toBe(3);
  });

  test('<3 valid questions ⇒ error invalid_quiz', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const { sourceId } = await seedSource(userId, nb, ['alpha']);
    installComplete(JSON.stringify({ questions: [{ kind: 'tf', prompt: 'only one', answer: true }] }));

    const id = await insertQuizArtifact(userId, nb, [sourceId]);
    await generateArtifact(id);

    const row = await getArtifact(id);
    expect(row.status).toBe('error');
    expect(row.errorCode).toBe('invalid_quiz');
  });

  test('broken JSON ⇒ error invalid_quiz', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const { sourceId } = await seedSource(userId, nb, ['alpha']);
    installComplete('here is your quiz: not actually json');

    const id = await insertQuizArtifact(userId, nb, [sourceId]);
    await generateArtifact(id);

    const row = await getArtifact(id);
    expect(row.status).toBe('error');
    expect(row.errorCode).toBe('invalid_quiz');
  });

  test('sourceChunkId outside the sampled context ⇒ nulled', async () => {
    const { userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const { sourceId } = await seedSource(userId, nb, ['alpha']);
    installComplete(
      JSON.stringify({
        questions: [
          { kind: 'tf', prompt: 'q1', answer: true, sourceChunkId: '00000000-0000-4000-8000-000000000000' },
          { kind: 'tf', prompt: 'q2', answer: false },
          { kind: 'open', prompt: 'q3', answerText: 'x' },
        ],
      }),
    );

    const id = await insertQuizArtifact(userId, nb, [sourceId]);
    await generateArtifact(id);

    const quiz = (await getArtifact(id)).contentJson as QuizContent;
    expect(quiz.questions[0]!.sourceChunkId).toBeUndefined();
  });
});

// ── attempts scoring ────────────────────────────────────────────────────────────

/** Insert a READY quiz with a fixed question set (known ids for scoring asserts). */
async function seedReadyQuiz(
  userId: string,
  notebookId: string,
  questions: QuizContent['questions'],
): Promise<string> {
  const [row] = await db
    .insert(artifactsTable)
    .values({
      userId,
      notebookId,
      type: 'quiz',
      status: 'ready',
      title: 'Квиз',
      sourceIds: [],
      contentJson: { questions },
    })
    .returning({ id: artifactsTable.id });
  return row!.id;
}

const Q_MCQ = { id: 'aaaaaaaa-0000-4000-8000-000000000001', kind: 'mcq' as const, prompt: 'mcq', options: ['a', 'b', 'c'], answerIndex: 1 };
const Q_TF = { id: 'aaaaaaaa-0000-4000-8000-000000000002', kind: 'tf' as const, prompt: 'tf', answer: true };
const Q_OPEN = { id: 'aaaaaaaa-0000-4000-8000-000000000003', kind: 'open' as const, prompt: 'open', answerText: 'model answer' };

describe('quiz attempts — server scoring', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => __resetAiClientForTests());

  test('mcq/tf scored server-side; open uses client self-grade; all-correct', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const artifactId = await seedReadyQuiz(userId, nb, [Q_MCQ, Q_TF, Q_OPEN]);

    const res = await callApp(app, 'POST', `/notebooks/${nb}/artifacts/${artifactId}/attempts`, {
      cookie,
      body: {
        answers: [
          { questionId: Q_MCQ.id, answer: 1 }, // correct
          { questionId: Q_TF.id, answer: true }, // correct
          { questionId: Q_OPEN.id, answer: { selfCorrect: true } }, // self-graded correct
        ],
      },
    });
    expect(res.status).toBe(200);
    const out = await res.json<{ correct: number; total: number; answers: { correct: boolean }[] }>();
    expect(out.total).toBe(3);
    expect(out.correct).toBe(3);
    expect(out.answers.every((a) => a.correct)).toBe(true);
  });

  test('wrong mcq + wrong tf + self-incorrect open ⇒ 0 correct', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const artifactId = await seedReadyQuiz(userId, nb, [Q_MCQ, Q_TF, Q_OPEN]);

    const res = await callApp(app, 'POST', `/notebooks/${nb}/artifacts/${artifactId}/attempts`, {
      cookie,
      body: {
        answers: [
          { questionId: Q_MCQ.id, answer: 0 }, // wrong (correct is 1)
          { questionId: Q_TF.id, answer: false }, // wrong (correct is true)
          { questionId: Q_OPEN.id, answer: { selfCorrect: false } },
        ],
      },
    });
    const out = await res.json<{ correct: number; total: number }>();
    expect(out.correct).toBe(0);
    expect(out.total).toBe(3);
  });

  test('the server does NOT trust a forged correctness (recompute wins)', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const artifactId = await seedReadyQuiz(userId, nb, [Q_MCQ, Q_TF, Q_OPEN]);

    // A malicious client tries to inject `correct:true` for a wrong mcq answer —
    // the route only reads `answer`, so the forged `correct` is ignored.
    const res = await callApp(app, 'POST', `/notebooks/${nb}/artifacts/${artifactId}/attempts`, {
      cookie,
      body: {
        answers: [
          { questionId: Q_MCQ.id, answer: 0, correct: true }, // wrong, but claims correct
          { questionId: Q_TF.id, answer: true },
          { questionId: Q_OPEN.id, answer: { selfCorrect: false } },
        ],
      },
    });
    expect(res.status).toBe(200);
    const out = await res.json<{ correct: number; answers: { questionId: string; correct: boolean }[] }>();
    // Only the tf is correct; the forged mcq stays wrong.
    expect(out.correct).toBe(1);
    const mcqVerdict = out.answers.find((a) => a.questionId === Q_MCQ.id)!;
    expect(mcqVerdict.correct).toBe(false);
  });

  test('unanswered question counts as incorrect', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const artifactId = await seedReadyQuiz(userId, nb, [Q_MCQ, Q_TF, Q_OPEN]);

    const res = await callApp(app, 'POST', `/notebooks/${nb}/artifacts/${artifactId}/attempts`, {
      cookie,
      body: { answers: [{ questionId: Q_MCQ.id, answer: 1 }] }, // only one answered
    });
    const out = await res.json<{ correct: number; total: number; answers: { questionId: string; answer: unknown; correct: boolean }[] }>();
    expect(out.total).toBe(3);
    expect(out.correct).toBe(1);
    // The two unanswered come back with answer null + correct false.
    const tf = out.answers.find((a) => a.questionId === Q_TF.id)!;
    expect(tf.answer).toBeNull();
    expect(tf.correct).toBe(false);
  });

  test('unknown questionId ⇒ 400 invalid_attempt', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const artifactId = await seedReadyQuiz(userId, nb, [Q_MCQ, Q_TF, Q_OPEN]);

    const res = await callApp(app, 'POST', `/notebooks/${nb}/artifacts/${artifactId}/attempts`, {
      cookie,
      body: { answers: [{ questionId: '99999999-9999-4999-8999-999999999999', answer: 1 }] },
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_attempt');
  });

  test('a NON-quiz artifact ⇒ 400 invalid_attempt', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const [art] = await db
      .insert(artifactsTable)
      .values({ userId, notebookId: nb, type: 'summary', status: 'ready', title: 'Обзор', sourceIds: [], contentMd: '# x' })
      .returning({ id: artifactsTable.id });

    const res = await callApp(app, 'POST', `/notebooks/${nb}/artifacts/${art!.id}/attempts`, {
      cookie,
      body: { answers: [] },
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_attempt');
  });

  test('a non-ready quiz ⇒ 400 invalid_attempt', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const [art] = await db
      .insert(artifactsTable)
      .values({ userId, notebookId: nb, type: 'quiz', status: 'pending', title: 'Квиз', sourceIds: [] })
      .returning({ id: artifactsTable.id });

    const res = await callApp(app, 'POST', `/notebooks/${nb}/artifacts/${art!.id}/attempts`, {
      cookie,
      body: { answers: [] },
    });
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toBe('invalid_attempt');
  });

  test('foreign artifact ⇒ 404', async () => {
    const a = await signUpAndCookie(app, uniqueEmail());
    const b = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(a.userId);
    const artifactId = await seedReadyQuiz(a.userId, nb, [Q_MCQ, Q_TF, Q_OPEN]);

    const res = await callApp(app, 'POST', `/notebooks/${nb}/artifacts/${artifactId}/attempts`, {
      cookie: b.cookie,
      body: { answers: [{ questionId: Q_MCQ.id, answer: 1 }] },
    });
    expect(res.status).toBe(404);
  });
});

describe('quiz attempts — history', () => {
  beforeEach(async () => {
    await resetTestDb();
  });
  afterEach(() => __resetAiClientForTests());

  test('GET returns the last 10, newest-first', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(userId);
    const artifactId = await seedReadyQuiz(userId, nb, [Q_MCQ, Q_TF, Q_OPEN]);

    // 12 attempts → list returns 10.
    for (let i = 0; i < 12; i++) {
      await callApp(app, 'POST', `/notebooks/${nb}/artifacts/${artifactId}/attempts`, {
        cookie,
        body: { answers: [{ questionId: Q_MCQ.id, answer: i % 3 }] },
      });
    }

    const res = await callApp(app, 'GET', `/notebooks/${nb}/artifacts/${artifactId}/attempts`, { cookie });
    expect(res.status).toBe(200);
    const out = await res.json<{ items: { createdAt: string }[] }>();
    expect(out.items.length).toBe(10);
    // Newest-first: created_at non-increasing.
    for (let i = 1; i < out.items.length; i++) {
      expect(new Date(out.items[i - 1]!.createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(out.items[i]!.createdAt).getTime(),
      );
    }

    // All 12 persisted (the route just caps the LIST).
    const all = await db.select().from(attemptsTable).where(eq(attemptsTable.userId, userId));
    expect(all.length).toBe(12);
  });

  test('GET history foreign artifact ⇒ 404', async () => {
    const a = await signUpAndCookie(app, uniqueEmail());
    const b = await signUpAndCookie(app, uniqueEmail());
    const nb = await freshNotebook(a.userId);
    const artifactId = await seedReadyQuiz(a.userId, nb, [Q_MCQ, Q_TF, Q_OPEN]);

    const res = await callApp(app, 'GET', `/notebooks/${nb}/artifacts/${artifactId}/attempts`, {
      cookie: b.cookie,
    });
    expect(res.status).toBe(404);
  });
});
