import { and, desc, eq } from 'drizzle-orm';
import { db, notebookArtifacts, quizAttempts } from '@reomi/db';
import { scoreQuizAttempt } from '../ai/artifacts';
import { StudyError } from './study-notes';

export interface StudyQuizAnswer { questionId: string; answer: number | boolean | { selfCorrect: boolean } }
const owner = (userId: string, id: string, notebookId?: string) => and(
  eq(notebookArtifacts.userId, userId), eq(notebookArtifacts.id, id),
  notebookId ? and(eq(notebookArtifacts.ownerKind, 'notebook'), eq(notebookArtifacts.notebookId, notebookId)) : eq(notebookArtifacts.ownerKind, 'source'),
);
const columns = { id: quizAttempts.id, correct: quizAttempts.correct, total: quizAttempts.total, answers: quizAttempts.answers, createdAt: quizAttempts.createdAt };

/** Lock the quiz while scoring and inserting, so regeneration/deletion cannot
 * replace its questions between validation and persistence. A live source is
 * deliberately not required: completed quizzes are independent study work. */
export async function submitStudyQuizAttempt(userId: string, id: string, answers: StudyQuizAnswer[], notebookId?: string) {
  return db.transaction(async tx => {
    const [artifact] = await tx.select().from(notebookArtifacts).where(owner(userId, id, notebookId)).for('update').limit(1);
    if (!artifact) throw new StudyError(404, 'not_found');
    const quiz = artifact.contentJson;
    if (artifact.type !== 'quiz' || artifact.status !== 'ready' || !quiz?.questions?.length) throw new StudyError(400, 'invalid_attempt');
    const scored = scoreQuizAttempt(quiz.questions, new Map(answers.map(answer => [answer.questionId, answer.answer])));
    if (!scored.ok) throw new StudyError(400, 'invalid_attempt');
    const [row] = await tx.insert(quizAttempts).values({ userId, artifactId: id,
      answers: scored.answers, correct: scored.correct, total: scored.total }).returning(columns);
    return row!;
  });
}
export async function listStudyQuizAttempts(userId: string, id: string, notebookId?: string) {
  const [artifact] = await db.select({ id: notebookArtifacts.id }).from(notebookArtifacts).where(owner(userId, id, notebookId)).limit(1);
  if (!artifact) throw new StudyError(404, 'not_found');
  const items = await db.select(columns).from(quizAttempts).where(and(eq(quizAttempts.userId, userId), eq(quizAttempts.artifactId, id)))
    .orderBy(desc(quizAttempts.createdAt), desc(quizAttempts.id)).limit(10);
  return { items };
}
