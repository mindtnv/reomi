// Pure helpers for the «Блокноты 2.0» N3 quiz player. DOM-free so they unit-test
// under `bun test` (the repo has no component-render harness). They cover the two
// load-bearing bits of the player that benefit from coverage: building the
// client→server answer payload from the local response map, and assembling the
// «слабые места → карточки» chat-prefill prompt from the wrong questions.
//
// Server scoring is authoritative (mcq/tf recomputed from `content_json`, `open`
// trusts the user's `{ selfCorrect }`); the player only COLLECTS responses and
// renders the server's verdict back. These helpers never decide correctness.

import type {
  QuizAttemptAnswerInput,
  QuizContent,
  QuizQuestion,
} from '@reomi/shared';

/**
 * One local response the player holds while a quiz is in progress. `value`'s
 * shape follows the question kind:
 *  - mcq → the chosen option index (number)
 *  - tf  → the chosen boolean
 *  - open → the human self-grade ({ selfCorrect }); the typed answer text is
 *    display-only and never sent (the server can't score it anyway).
 * An unanswered question is simply absent from the response map.
 */
export type QuizResponse =
  | { kind: 'mcq'; value: number }
  | { kind: 'tf'; value: boolean }
  | { kind: 'open'; selfCorrect: boolean };

/**
 * Build the POST /attempts body from the local response map. Only ANSWERED
 * questions are emitted (an absent/unanswered question counts as incorrect
 * server-side). The per-kind `answer` shape matches `QuizAttemptAnswerInput`:
 * number (mcq) | boolean (tf) | { selfCorrect } (open).
 */
export function buildAttemptAnswers(
  questions: QuizQuestion[],
  responses: Map<string, QuizResponse>,
): QuizAttemptAnswerInput[] {
  const out: QuizAttemptAnswerInput[] = [];
  for (const q of questions) {
    const r = responses.get(q.id);
    if (!r) continue;
    if (r.kind === 'mcq') out.push({ questionId: q.id, answer: r.value });
    else if (r.kind === 'tf') out.push({ questionId: q.id, answer: r.value });
    else out.push({ questionId: q.id, answer: { selfCorrect: r.selfCorrect } });
  }
  return out;
}

/**
 * The model answer text a player shows for a question, per kind:
 *  - mcq → the correct option's text (resolved via answerIndex)
 *  - tf  → a localized «Верно»/«Неверно» (caller passes both labels)
 *  - open → the stored answerText
 * Returns '' when the answer can't be resolved (defensive — a malformed quiz).
 */
export function modelAnswerText(
  q: QuizQuestion,
  tfLabels: { yes: string; no: string },
): string {
  if (q.kind === 'mcq') {
    if (q.options && typeof q.answerIndex === 'number') {
      return q.options[q.answerIndex] ?? '';
    }
    return '';
  }
  if (q.kind === 'tf') {
    if (typeof q.answer === 'boolean') return q.answer ? tfLabels.yes : tfLabels.no;
    return '';
  }
  return q.answerText ?? '';
}

/**
 * Build the «слабые места → карточки» chat-prefill prompt (Р8): a header line +
 * one bullet PER WRONG question carrying its prompt AND model answer, so the
 * agent makes targeted flashcards on exactly what the user missed. `wrongIds`
 * is the set of question ids the server marked incorrect. Returns null when
 * there's nothing wrong (the player hides the button). `header` is the localized
 * lead-in; `answerLabel` prefixes each model answer inline.
 */
export function buildWeakSpotsPrompt(
  quiz: QuizContent,
  wrongIds: Set<string>,
  opts: { header: string; answerLabel: string; tfYes: string; tfNo: string },
): string | null {
  const wrong = quiz.questions.filter((q) => wrongIds.has(q.id));
  if (wrong.length === 0) return null;
  const lines = wrong.map((q) => {
    const prompt = (q.prompt ?? '').replace(/\s+/g, ' ').trim();
    const answer = modelAnswerText(q, { yes: opts.tfYes, no: opts.tfNo })
      .replace(/\s+/g, ' ')
      .trim();
    return answer
      ? `- ${prompt}\n  ${opts.answerLabel} ${answer}`
      : `- ${prompt}`;
  });
  return `${opts.header}\n${lines.join('\n')}`;
}

/** Whether every question in the quiz has a local response (for the «finish» gate). */
export function allAnswered(
  questions: QuizQuestion[],
  responses: Map<string, QuizResponse>,
): boolean {
  return questions.length > 0 && questions.every((q) => responses.has(q.id));
}
