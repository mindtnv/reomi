export function passwordResetRequestUrl(apiBase: string): string {
  return `${apiBase.replace(/\/+$/, '')}/api/auth/request-password-reset`;
}

export function forgotPasswordOutcome(status: number): 'sent' | 'rate_limited' | 'failed' {
  if (status === 200 || status === 204) return 'sent';
  if (status === 429) return 'rate_limited';
  return 'failed';
}

export function authFailureText(input: {
  status?: number;
  code?: string | null;
  message?: string | null;
  fallback: string;
}): string {
  const code = (input.code ?? '').toUpperCase();
  const message = (input.message ?? '').trim();
  if (input.status === 429 || code === 'RATE_LIMITED' || message === 'rate_limited') {
    return 'Слишком много попыток. Подожди и попробуй ещё раз.';
  }
  if (code === 'INVALID_EMAIL_OR_PASSWORD' || message === 'Invalid email or password') {
    return 'Неверный email или пароль.';
  }
  if (
    code === 'INVALID_TOKEN' ||
    code === 'TOKEN_EXPIRED' ||
    message === 'Invalid token' ||
    message === 'Token expired'
  ) {
    return 'Ссылка устарела или неверна. Запроси сброс ещё раз.';
  }
  if (code === 'PASSWORD_TOO_SHORT' || message === 'Password too short') {
    return 'Пароль должен быть не короче 8 символов.';
  }
  if (code === 'INVALID_EMAIL' || message === 'Invalid email') {
    return 'Введи корректный email.';
  }
  return input.fallback;
}

type AuthFieldMode = 'sign-in' | 'sign-up' | 'forgot' | 'reset';

export function authFieldError(input: {
  mode: AuthFieldMode;
  email?: string;
  password?: string;
  confirm?: string;
}): string | null {
  if (input.mode !== 'reset') {
    const email = (input.email ?? '').trim();
    if (!email) return 'Введи email.';
    if (!email.includes('@')) return 'Введи корректный email.';
  }
  if (input.mode === 'sign-in') {
    if (!(input.password ?? '')) return 'Введи пароль.';
    return null;
  }
  if (input.mode === 'forgot') return null;
  const password = input.password ?? '';
  if (password.length < 8) return 'Пароль должен быть не короче 8 символов.';
  if (input.mode === 'reset' && password !== (input.confirm ?? '')) return 'Пароли не совпадают.';
  return null;
}
