import { describe, expect, test } from 'bun:test';
import {
  authFailureText,
  authFieldError,
  forgotPasswordOutcome,
  passwordResetRequestUrl,
} from './auth-recovery';

describe('password recovery client', () => {
  test('the forgot form posts to the Better Auth 1.6 reset route', () => {
    expect(passwordResetRequestUrl('https://api.reomi.ru')).toBe(
      'https://api.reomi.ru/api/auth/request-password-reset',
    );
    expect(passwordResetRequestUrl('http://localhost:3000/')).toBe(
      'http://localhost:3000/api/auth/request-password-reset',
    );
  });

  test('a 404 is a failed send, and only 200 or 204 count as sent', () => {
    expect(forgotPasswordOutcome(200)).toBe('sent');
    expect(forgotPasswordOutcome(204)).toBe('sent');
    expect(forgotPasswordOutcome(404)).toBe('failed');
    expect(forgotPasswordOutcome(400)).toBe('failed');
    expect(forgotPasswordOutcome(500)).toBe('failed');
    expect(forgotPasswordOutcome(429)).toBe('rate_limited');
  });

  test('known auth failures stay in Russian', () => {
    expect(
      authFailureText({
        code: 'INVALID_EMAIL_OR_PASSWORD',
        message: 'Invalid email or password',
        fallback: 'fallback',
      }),
    ).toBe('Неверный email или пароль.');
    expect(authFailureText({ message: 'Invalid token', fallback: 'fallback' })).toBe(
      'Ссылка устарела или неверна. Запроси сброс ещё раз.',
    );
    expect(authFailureText({ code: 'PASSWORD_TOO_SHORT', fallback: 'fallback' })).toBe(
      'Пароль должен быть не короче 8 символов.',
    );
    expect(authFailureText({ status: 429, message: 'rate_limited', fallback: 'fallback' })).toBe(
      'Слишком много попыток. Подожди и попробуй ещё раз.',
    );
    expect(authFailureText({ message: 'Invalid email', fallback: 'fallback' })).toBe(
      'Введи корректный email.',
    );
    expect(authFailureText({ message: 'something else', fallback: 'Оставь как есть' })).toBe(
      'Оставь как есть',
    );
  });

  test('empty fields are Russian, and sign-in still accepts a short password', () => {
    expect(authFieldError({ mode: 'sign-in', email: '', password: '' })).toBe('Введи email.');
    expect(authFieldError({ mode: 'sign-in', email: 'ada', password: 'x' })).toBe(
      'Введи корректный email.',
    );
    expect(authFieldError({ mode: 'sign-in', email: 'ada@reomi.ru', password: '' })).toBe(
      'Введи пароль.',
    );
    expect(authFieldError({ mode: 'sign-in', email: 'ada@reomi.ru', password: 'short' })).toBeNull();
    expect(authFieldError({ mode: 'sign-up', email: 'ada@reomi.ru', password: 'short' })).toBe(
      'Пароль должен быть не короче 8 символов.',
    );
    expect(authFieldError({ mode: 'forgot', email: '  ' })).toBe('Введи email.');
    expect(authFieldError({ mode: 'forgot', email: 'ada@reomi.ru' })).toBeNull();
    expect(authFieldError({ mode: 'reset', password: 'short', confirm: 'short' })).toBe(
      'Пароль должен быть не короче 8 символов.',
    );
    expect(authFieldError({ mode: 'reset', password: 'long-enough', confirm: 'other-value' })).toBe(
      'Пароли не совпадают.',
    );
    expect(authFieldError({ mode: 'reset', password: 'long-enough', confirm: 'long-enough' })).toBeNull();
  });
});
