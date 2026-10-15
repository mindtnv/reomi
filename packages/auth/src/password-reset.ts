/** Empty EMAIL_FROM keeps the historical mailbox. The code must not invent noreply@reomi.ru. */
export const FALLBACK_EMAIL_FROM = 'NeuroNexus <noreply@neuronexus.app>';

export function resolveEmailFrom(raw: string | undefined | null): string {
  if (typeof raw !== 'string' || raw.trim() === '') return FALLBACK_EMAIL_FROM;
  return raw;
}

/** Better Auth 1.6 puts the reset secret in the URL path and also passes it as `token`. */
export function passwordResetMessage(input: {
  name?: string | null;
  url: string;
  webOrigin: string;
  token?: string | null;
}): { subject: string; text: string } {
  const token = resetTokenFrom(input);
  if (!token) throw new Error('password reset is missing a token');
  const origin = input.webOrigin.replace(/\/+$/, '');
  const link = `${origin}/auth/reset-password?token=${encodeURIComponent(token)}`;
  return {
    subject: 'Reomi — сброс пароля',
    text: [
      `Привет, ${input.name ?? 'друг'}!`,
      '',
      'Мы получили запрос на сброс пароля в Reomi. Если это не вы — просто проигнорируйте письмо.',
      '',
      `Ссылка: ${link}`,
      '',
      'Ссылка работает 1 час.',
    ].join('\n'),
  };
}

function resetTokenFrom(input: { url: string; token?: string | null }): string {
  const explicit = input.token?.trim();
  if (explicit) return explicit;
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    return '';
  }
  const query = parsed.searchParams.get('token');
  if (query) return query;
  const marker = '/reset-password/';
  const at = parsed.pathname.indexOf(marker);
  if (at === -1) return '';
  const segment = parsed.pathname.slice(at + marker.length).split('/')[0] ?? '';
  if (!segment) return '';
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
