import { expect, test } from 'bun:test';
import { smokeTarget } from './smoke-target';

test('local smoke builds a disposable account and a unique deck prefix', () => {
  const target = smokeTarget({}, 36, 'abc123');
  expect(target).toEqual({
    mode: 'local',
    email: 'e2e-10-abc123@example.com',
    password: 'e2e-10-abc123-password',
    name: 'e2e-10-abc123',
    deckName: 'e2e-10-abc123',
    question: 'e2e-10-abc123 question',
    answer: 'e2e-10-abc123 answer',
  });
  expect(target.password.length).toBeGreaterThan(8);
});

test('production smoke keeps the provided account and still prefixes created data', () => {
  const target = smokeTarget(
    { E2E_TARGET: 'prod', E2E_EMAIL: ' learner@example.com ', E2E_PASSWORD: 'secret-value' },
    36,
    'abc123',
  );
  expect(target.mode).toBe('prod');
  expect(target.email).toBe('learner@example.com');
  expect(target.password).toBe('secret-value');
  expect(target.deckName).toBe('e2e-10-abc123');
  expect(target.question).toBe('e2e-10-abc123 question');
  expect(target.answer).toBe('e2e-10-abc123 answer');
});

test('production smoke refuses to invent an account', () => {
  expect(() => smokeTarget({ E2E_TARGET: 'prod' }, 36, 'abc123')).toThrow(
    'prod smoke requires E2E_EMAIL and E2E_PASSWORD',
  );
  expect(() =>
    smokeTarget({ E2E_TARGET: 'prod', E2E_EMAIL: ' ', E2E_PASSWORD: 'secret-value' }, 36, 'abc123'),
  ).toThrow('prod smoke requires E2E_EMAIL and E2E_PASSWORD');
});
