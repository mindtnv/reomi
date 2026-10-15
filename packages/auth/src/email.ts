import { resolveEmailFrom } from './password-reset.ts';

// Minimal email-sending layer. Two implementations:
//   - `ConsoleEmailProvider` — prints the email body to stdout (dev / CI).
//   - `ResendEmailProvider`  — posts to the Resend REST API (prod).
//
// BetterAuth's `sendResetPassword` / `sendVerificationEmail` callbacks call
// `sendEmail`, which picks the provider based on env:
//   RESEND_API_KEY set      → Resend
//   otherwise               → Console (so dev/CI doesn't need a network call)

export interface SendEmailInput {
  to: string;
  subject: string;
  /** Plain-text body. Always provided; HTML optional. */
  text: string;
  html?: string;
  /** Logical tag so provider dashboards can split traffic. */
  tag?: 'password-reset' | 'email-verification' | 'notification';
}

export interface EmailProvider {
  name: string;
  send(input: SendEmailInput): Promise<void>;
}

class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console';
  async send(input: SendEmailInput): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(
      `\n[email:console] → ${input.to}\n  subject: ${input.subject}\n  ${input.text.replace(/\n/g, '\n  ')}\n`,
    );
  }
}

class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}
  async send(input: SendEmailInput): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: this.from,
        to: input.to,
        subject: input.subject,
        text: input.text,
        html: input.html,
        tags: input.tag ? [{ name: 'tag', value: input.tag }] : undefined,
      }),
    });
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      throw new Error(`Resend API ${res.status}${resendDetail(raw)}`);
    }
  }
}

function resendDetail(raw: string): string {
  let detail = raw;
  try {
    const parsed = JSON.parse(raw) as { message?: unknown };
    if (typeof parsed.message === 'string') detail = parsed.message;
  } catch {
    detail = raw;
  }
  detail = detail.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]').trim().slice(0, 160);
  return detail ? `: ${detail}` : '';
}

let cached: EmailProvider | null = null;
let testSink: ((input: SendEmailInput) => void) | null = null;

export function __setEmailSinkForTests(sink: ((input: SendEmailInput) => void) | null): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('email test sink is only available under NODE_ENV=test');
  }
  testSink = sink;
}

export function getEmailProvider(): EmailProvider {
  if (cached) return cached;
  const apiKey = process.env.RESEND_API_KEY;
  const from = resolveEmailFrom(process.env.EMAIL_FROM);
  cached =
    apiKey && process.env.NODE_ENV !== 'test'
      ? new ResendEmailProvider(apiKey, from)
      : new ConsoleEmailProvider();
  return cached;
}

export async function sendEmail(input: SendEmailInput): Promise<void> {
  testSink?.(input);
  await getEmailProvider().send(input);
}
