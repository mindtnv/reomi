// Unit tests for the «Блокноты 2.0» N3 quiz-player pure helpers: building the
// attempt payload from local responses, resolving the model answer per kind, and
// assembling the «слабые места → карточки» prefill prompt. DOM-free.

import { describe, expect, test } from 'bun:test';
import type { QuizContent, QuizQuestion } from '@reomi/shared';
import {
  allAnswered,
  buildAttemptAnswers,
  buildWeakSpotsPrompt,
  modelAnswerText,
  type QuizResponse,
} from './quiz-player';

const Q_MCQ: QuizQuestion = {
  id: 'q1',
  kind: 'mcq',
  prompt: 'What is 2 + 2?',
  options: ['3', '4', '5'],
  answerIndex: 1,
};
const Q_TF: QuizQuestion = { id: 'q2', kind: 'tf', prompt: 'The sky is green.', answer: false };
const Q_OPEN: QuizQuestion = {
  id: 'q3',
  kind: 'open',
  prompt: 'Define entropy.',
  answerText: 'A measure of disorder.',
};

const QUESTIONS = [Q_MCQ, Q_TF, Q_OPEN];

describe('buildAttemptAnswers', () => {
  test('emits the per-kind answer shape, skipping unanswered questions', () => {
    const responses = new Map<string, QuizResponse>([
      ['q1', { kind: 'mcq', value: 1 }],
      ['q3', { kind: 'open', selfCorrect: true }],
      // q2 unanswered → omitted (counts incorrect server-side).
    ]);
    expect(buildAttemptAnswers(QUESTIONS, responses)).toEqual([
      { questionId: 'q1', answer: 1 },
      { questionId: 'q3', answer: { selfCorrect: true } },
    ]);
  });

  test('tf answers ride as a boolean', () => {
    const responses = new Map<string, QuizResponse>([['q2', { kind: 'tf', value: false }]]);
    expect(buildAttemptAnswers([Q_TF], responses)).toEqual([
      { questionId: 'q2', answer: false },
    ]);
  });

  test('empty responses → empty array', () => {
    expect(buildAttemptAnswers(QUESTIONS, new Map())).toEqual([]);
  });
});

describe('modelAnswerText', () => {
  const tf = { yes: 'True', no: 'False' };
  test('mcq → the correct option text', () => {
    expect(modelAnswerText(Q_MCQ, tf)).toBe('4');
  });
  test('tf → the localized boolean', () => {
    expect(modelAnswerText(Q_TF, tf)).toBe('False');
    expect(modelAnswerText({ ...Q_TF, answer: true }, tf)).toBe('True');
  });
  test('open → the stored answerText', () => {
    expect(modelAnswerText(Q_OPEN, tf)).toBe('A measure of disorder.');
  });
  test('malformed quiz → empty string (defensive)', () => {
    expect(modelAnswerText({ id: 'x', kind: 'mcq', prompt: 'p' }, tf)).toBe('');
    expect(modelAnswerText({ id: 'x', kind: 'tf', prompt: 'p' }, tf)).toBe('');
    expect(modelAnswerText({ id: 'x', kind: 'open', prompt: 'p' }, tf)).toBe('');
  });
  test('mcq with an out-of-range answerIndex → empty string', () => {
    expect(modelAnswerText({ ...Q_MCQ, answerIndex: 9 }, tf)).toBe('');
  });
});

describe('buildWeakSpotsPrompt', () => {
  const quiz: QuizContent = { questions: QUESTIONS };
  const opts = { header: 'Make cards:', answerLabel: 'Answer:', tfYes: 'True', tfNo: 'False' };

  test('one bullet per wrong question, with the model answer inline', () => {
    const prompt = buildWeakSpotsPrompt(quiz, new Set(['q1', 'q3']), opts);
    expect(prompt).toBe(
      'Make cards:\n- What is 2 + 2?\n  Answer: 4\n- Define entropy.\n  Answer: A measure of disorder.',
    );
  });

  test('a wrong question with no resolvable answer omits the answer line', () => {
    const bare: QuizContent = { questions: [{ id: 'q9', kind: 'open', prompt: 'No answer here' }] };
    const prompt = buildWeakSpotsPrompt(bare, new Set(['q9']), opts);
    expect(prompt).toBe('Make cards:\n- No answer here');
  });

  test('nothing wrong → null (the button hides)', () => {
    expect(buildWeakSpotsPrompt(quiz, new Set(), opts)).toBeNull();
  });
});

describe('allAnswered', () => {
  test('true only when every question has a local response', () => {
    const partial = new Map<string, QuizResponse>([['q1', { kind: 'mcq', value: 1 }]]);
    expect(allAnswered(QUESTIONS, partial)).toBe(false);
    const full = new Map<string, QuizResponse>([
      ['q1', { kind: 'mcq', value: 1 }],
      ['q2', { kind: 'tf', value: false }],
      ['q3', { kind: 'open', selfCorrect: true }],
    ]);
    expect(allAnswered(QUESTIONS, full)).toBe(true);
  });

  test('empty quiz → false', () => {
    expect(allAnswered([], new Map())).toBe(false);
  });
});
