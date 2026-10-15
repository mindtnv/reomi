/** Empty EMAIL_FROM keeps the historical mailbox. The code must not invent noreply@reomi.ru. */
export const FALLBACK_EMAIL_FROM = 'NeuroNexus <noreply@neuronexus.app>';

export function resolveEmailFrom(raw: string | undefined | null): string {
  if (typeof raw !== 'string' || raw.trim() === '') return FALLBACK_EMAIL_FROM;
  return raw;
}

export function passwordResetMessage(input: {
  name?: string | null;
  url: string;
  webOrigin: string;
}): { subject: string; text: string } {
  const resetUrl = new URL('/auth/reset-password', input.webOrigin);
  const target = input.url.startsWith(input.webOrigin) ? input.url : resetUrl.toString();
  let token = '';
  try { token = new URL(input.url).searchParams.get('token') ?? ''; } catch { token = ''; }
  const link = `${target}${target.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
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
