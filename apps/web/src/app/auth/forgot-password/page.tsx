'use client';

/* eslint-disable react/forbid-elements -- #78 */

import { useState } from 'react';
import { apiErrorFromResponse } from '@/lib/api';
import { authFailureText, authFieldError, forgotPasswordOutcome, passwordResetRequestUrl } from '@/lib/auth-recovery';
const API_BASE =
  typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL
    ? process.env.NEXT_PUBLIC_API_URL
    : 'http://localhost:3000';
import { NNBtn, NNLogo } from '@/components/ui';
import { AppLink } from '@/components/navigation';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const fieldError = authFieldError({ mode: 'forgot', email });
    if (fieldError) {
      setError(fieldError);
      return;
    }
    setLoading(true);
    try {
      const redirectTo =
        typeof window !== 'undefined'
          ? `${window.location.origin}/auth/reset-password`
          : '/auth/reset-password';
      const res = await fetch(passwordResetRequestUrl(API_BASE), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), redirectTo }),
      });
      const outcome = forgotPasswordOutcome(res.status);
      if (outcome === 'rate_limited') {
        throw new Error(authFailureText({ status: res.status, fallback: 'Слишком много попыток. Подожди и попробуй ещё раз.' }));
      }
      if (outcome === 'failed') {
        const upstream = await apiErrorFromResponse(res, 'Не удалось отправить письмо.');
        const mapped = authFailureText({
          status: res.status,
          message: upstream.safeMessage,
          fallback: '',
        });
        if (res.status >= 500 && !mapped) throw upstream;
        throw new Error(mapped || 'Не удалось отправить письмо.');
      }
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Что-то пошло не так');
    } finally {
      setLoading(false);
    }
  }

  return (
    <form
      noValidate
      onSubmit={submit}
      style={{
        width: 'min(420px, 100%)',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 20,
        padding: 28,
        boxShadow: 'var(--shadow-lg)',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        fontFamily: 'var(--font-sans)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <NNLogo />
      </div>

      <h1 style={{ fontSize: 22, margin: 0, fontWeight: 600 }}>Сброс пароля</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0 }}>
        {sent
          ? 'Если аккаунт с таким email существует, мы отправили ссылку для сброса. Проверь почту — письмо обычно приходит в течение минуты.'
          : 'Введи email, который ты использовал при регистрации. Мы пришлём ссылку для восстановления.'}
      </p>

      {!sent && (
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)', letterSpacing: 0.3 }}>Email</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            autoComplete="email"
            style={inputStyle}
          />
        </label>
      )}

      {error && (
        <div
          style={{
            color: 'var(--rose-400)',
            fontSize: 13,
            background: 'var(--tone-rose-bg)',
            border: '1px solid var(--tone-rose-border)',
            borderRadius: 8,
            padding: '8px 12px',
          }}
        >
          {error}
        </div>
      )}

      {!sent && (
        <NNBtn type="submit" variant="primary" size="lg" disabled={loading}>
          {loading ? '…' : 'Отправить ссылку'}
        </NNBtn>
      )}

      <div style={{ fontSize: 13, color: 'var(--text-muted)', textAlign: 'center' }}>
        <AppLink href="/auth/sign-in" style={{ color: 'var(--accent-300)' }}>
          Назад к входу
        </AppLink>
      </div>
    </form>
  );
}

const inputStyle: React.CSSProperties = {
  background: 'var(--surface-2)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: '10px 12px',
  color: 'var(--text)',
  fontSize: 14,
  fontFamily: 'inherit',
  outline: 'none',
};
