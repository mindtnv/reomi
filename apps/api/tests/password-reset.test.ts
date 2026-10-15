import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { __setEmailSinkForTests, type SendEmailInput } from '@reomi/auth/server';
import { buildApp } from '../src/app.ts';
import { callApp, resetTestDb, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();
const webOrigin = process.env.WEB_ORIGIN ?? 'http://localhost:3001';

function resetLink(text: string): string {
  const line = text.split('\n').find((row) => row.startsWith('Ссылка: '));
  if (!line) throw new Error('reset email has no link');
  return line.slice('Ссылка: '.length);
}

describe('password reset route', () => {
  const sent: SendEmailInput[] = [];

  beforeEach(async () => {
    await resetTestDb();
    sent.length = 0;
    __setEmailSinkForTests((input) => {
      sent.push(input);
    });
  });

  afterEach(() => {
    __setEmailSinkForTests(null);
  });

  test('request-password-reset mails one web link and that token changes the password', async () => {
    const email = uniqueEmail('reset');
    const oldPassword = 'testtest123';
    const nextPassword = 'new-password-1';
    await signUpAndCookie(app, email, oldPassword, 'Ada');

    const requested = await callApp(app, 'POST', '/api/auth/request-password-reset', {
      headers: { origin: webOrigin },
      body: { email, redirectTo: `${webOrigin}/auth/reset-password` },
    });
    expect(requested.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(email);
    expect(sent[0]!.subject).toBe('Reomi — сброс пароля');
    expect(sent[0]!.text).toContain('Reomi');
    expect(sent[0]!.text).toContain('Ada');

    const link = resetLink(sent[0]!.text);
    const token = new URL(link).searchParams.get('token');
    expect(link).toBe(`${webOrigin}/auth/reset-password?token=${encodeURIComponent(token ?? '')}`);
    expect(link).not.toContain('/api/auth/');
    expect(token).toBeTruthy();
    expect(link.split('token=')).toHaveLength(2);

    const reset = await callApp(app, 'POST', '/api/auth/reset-password', {
      body: { newPassword: nextPassword, token },
    });
    expect(reset.status).toBe(200);

    const oldSignIn = await callApp(app, 'POST', '/api/auth/sign-in/email', {
      body: { email, password: oldPassword },
    });
    expect(oldSignIn.status).toBe(401);
    const oldBody = await oldSignIn.json<{ code?: string }>();
    expect(oldBody.code).toBe('INVALID_EMAIL_OR_PASSWORD');

    const newSignIn = await callApp(app, 'POST', '/api/auth/sign-in/email', {
      body: { email, password: nextPassword },
    });
    expect(newSignIn.status).toBe(200);
  });

  test('an unknown email returns 200 and sends nothing', async () => {
    const requested = await callApp(app, 'POST', '/api/auth/request-password-reset', {
      headers: { origin: webOrigin },
      body: {
        email: uniqueEmail('missing'),
        redirectTo: `${webOrigin}/auth/reset-password`,
      },
    });
    expect(requested.status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  test('a bad reset token is rejected', async () => {
    const reset = await callApp(app, 'POST', '/api/auth/reset-password', {
      body: { newPassword: 'new-password-1', token: 'not-a-real-token' },
    });
    expect(reset.status).toBe(400);
    const body = await reset.json<{ code?: string; message?: string }>();
    expect(body.code).toBe('INVALID_TOKEN');
    expect(body.message).toBe('Invalid token');
  });
});
