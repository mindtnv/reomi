import { describe, expect, test } from 'bun:test';
import { FALLBACK_EMAIL_FROM, passwordResetMessage, resolveEmailFrom } from './password-reset.ts';

describe('password reset identity', () => {
  test('an empty EMAIL_FROM keeps the historical mailbox', () => {
    expect(resolveEmailFrom(undefined)).toBe(FALLBACK_EMAIL_FROM);
    expect(resolveEmailFrom(null)).toBe(FALLBACK_EMAIL_FROM);
    expect(resolveEmailFrom('')).toBe(FALLBACK_EMAIL_FROM);
    expect(resolveEmailFrom('   ')).toBe(FALLBACK_EMAIL_FROM);
    expect(FALLBACK_EMAIL_FROM).toContain('noreply@neuronexus.app');
    expect(FALLBACK_EMAIL_FROM).not.toContain('reomi.ru');
  });

  test('a configured From address is used unchanged', () => {
    expect(resolveEmailFrom('Reomi <noreply@reomi.ru>')).toBe('Reomi <noreply@reomi.ru>');
  });

  test('the message names Reomi and links to WEB_ORIGIN', () => {
    const origin = 'https://app.reomi.ru';
    const message = passwordResetMessage({
      name: 'Ada',
      url: 'http://localhost:3000/api/auth/reset-password/token?token=abc+def',
      webOrigin: origin,
    });
    expect(message.subject).toBe('Reomi — сброс пароля');
    expect(message.subject).not.toContain('NeuroNexus');
    expect(message.text).toContain('Reomi');
    expect(message.text).toContain('Ada');
    const link = message.text.split('\n').find((line) => line.startsWith('Ссылка: '))!.slice('Ссылка: '.length);
    expect(link.startsWith(`${origin}/auth/reset-password`)).toBe(true);
    // `+` in a query is a space, same as the previous mailer. A real plus stays percent-encoded.
    expect(link).toContain('token=abc%20def');
  });

  test('a link that already starts at WEB_ORIGIN keeps that token once', () => {
    const origin = 'https://app.reomi.ru';
    const message = passwordResetMessage({
      name: null,
      url: `${origin}/auth/reset-password?token=ready`,
      webOrigin: origin,
    });
    const link = message.text.split('\n').find((line) => line.startsWith('Ссылка: '))!.slice('Ссылка: '.length);
    expect(link).toBe(`${origin}/auth/reset-password?token=ready`);
    expect(message.text).toContain('друг');
  });

  test('a Better Auth path token becomes one web reset link', () => {
    const origin = 'https://app.reomi.ru';
    const message = passwordResetMessage({
      name: 'Ada',
      url: 'https://api.reomi.ru/api/auth/reset-password/abc+def?callbackURL=https%3A%2F%2Fapp.reomi.ru%2Fauth%2Freset-password',
      webOrigin: origin,
    });
    const link = message.text.split('\n').find((line) => line.startsWith('Ссылка: '))!.slice('Ссылка: '.length);
    expect(link).toBe(`${origin}/auth/reset-password?token=abc%2Bdef`);
  });

  test('an explicit token is the one in the web link', () => {
    const origin = 'https://app.reomi.ru/';
    const message = passwordResetMessage({
      name: 'Ada',
      url: 'https://api.reomi.ru/api/auth/reset-password/from-path',
      token: 'from-arg',
      webOrigin: origin,
    });
    const link = message.text.split('\n').find((line) => line.startsWith('Ссылка: '))!.slice('Ссылка: '.length);
    expect(link).toBe('https://app.reomi.ru/auth/reset-password?token=from-arg');
  });

  test('a url without a token is not mailed', () => {
    expect(() =>
      passwordResetMessage({
        url: 'https://api.reomi.ru/api/auth/reset-password?callbackURL=https%3A%2F%2Fapp.reomi.ru',
        webOrigin: 'https://app.reomi.ru',
      }),
    ).toThrow(/missing a token/);
  });
});
