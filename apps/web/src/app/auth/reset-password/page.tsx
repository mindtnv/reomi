'use client';

import { TextInput } from '@/components/design-system/primitives';


import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { apiErrorFromResponse } from '@/lib/api';
import { authFailureText, authFieldError } from '@/lib/auth-recovery';
const API_BASE =
  typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL
    ? process.env.NEXT_PUBLIC_API_URL
    : 'http://localhost:3000';
import { NNBtn, NNLogo } from '@/components/ui';
import { AuthFormFallback } from '@/components/route-fallbacks';
import { AppLink, useAppNavigation } from '@/components/navigation';

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<AuthFormFallback />}>
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const searchParams = useSearchParams();
  const router = useAppNavigation();
  const token = searchParams.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const fieldError = authFieldError({ mode: 'reset', password, confirm });
    if (fieldError) {
      setError(fieldError);
      return;
    }
    if (!token) {
      setError('В ссылке нет токена. Запроси сброс пароля ещё раз.');
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/auth/reset-password`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPassword: password, token }),
      });
      if (!res.ok) {
        const upstream = await apiErrorFromResponse(res, 'Ссылка устарела или неверна. Запроси сброс ещё раз.');
        const mapped = authFailureText({
          status: res.status,
          message: upstream.safeMessage,
          fallback: '',
        });
        if (res.status >= 500 && !mapped) throw upstream;
        throw new Error(mapped || 'Ссылка устарела или неверна. Запроси сброс ещё раз.');
      }
      setDone(true);
      setTimeout(() => router.replace('/auth/sign-in'), 1500);
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
      <h1 style={{ fontSize: 22, margin: 0, fontWeight: 600 }}>Новый пароль</h1>
      <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0 }}>
        {done
          ? 'Готово. Сейчас отправим тебя на вход…'
          : 'Придумай новый пароль, минимум 8 символов.'}
      </p>

      {!done && (
        <>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', letterSpacing: 0.3 }}>
              Новый пароль
            </span>
            <TextInput
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              style={inputStyle}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)', letterSpacing: 0.3 }}>
              Повтори пароль
            </span>
            <TextInput
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              style={inputStyle}
            />
          </label>
        </>
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

      {!done && (
        <NNBtn type="submit" variant="primary" size="lg" disabled={loading}>
          {loading ? '…' : 'Сохранить пароль'}
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
