import { createRequire } from 'node:module';
import https from 'node:https';
import { env } from '../env.ts';

const require = createRequire(import.meta.url);

type WebPushLib = {
  setVapidDetails(subject: string, publicKey: string, privateKey: string): void;
  sendNotification(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string | null,
    options?: { TTL?: number; agent?: https.Agent },
  ): Promise<{ statusCode?: number }>;
  generateVAPIDKeys(): { publicKey: string; privateKey: string };
};

const webpush = require('web-push') as WebPushLib;

const MAX_PLAINTEXT = 3072;
const loopbackAgent = new https.Agent({ rejectUnauthorized: false });

export type PushService = 'fcm' | 'mozilla' | 'apple' | 'other';

export type PushDelivery =
  | { ok: true }
  | { ok: false; code: 'push_disabled' | 'push_failed' | 'gone'; statusCode?: number };

export function pushConfigured(): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && validSubject(env.VAPID_SUBJECT));
}

export function validSubject(subject: string): boolean {
  try {
    const url = new URL(subject);
    return url.protocol === 'mailto:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function classifyPushService(endpoint: string): PushService {
  let host = '';
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return 'other';
  }
  if (host === 'fcm.googleapis.com' || host.endsWith('.fcm.googleapis.com')) return 'fcm';
  if (host === 'mozilla.com' || host.endsWith('.mozilla.com') || host.endsWith('.mozaws.net')) return 'mozilla';
  if (host === 'push.apple.com' || host.endsWith('.push.apple.com')) return 'apple';
  return 'other';
}

function isPrivateIp(host: string): boolean {
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const octets = v4.slice(1).map(Number);
    if (octets.some((part) => part > 255)) return true;
    const [a, b] = octets;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (!bare.includes(':')) return false;
  if (bare === '::1' || bare === '::') return true;
  if (bare.startsWith('fc') || bare.startsWith('fd') || bare.startsWith('fe80')) return true;
  if (bare.startsWith('::ffff:')) return isPrivateIp(bare.slice('::ffff:'.length));
  return false;
}

/** https endpoints only. Loopback is allowed under test so the local receiver can run. */
export function pushEndpointAllowed(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  const testLoopback = process.env.NODE_ENV === 'test'
    && (host === '127.0.0.1' || host === 'localhost' || host === '::1');
  if (testLoopback) return true;
  if (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host.endsWith('.home.arpa')
  ) return false;
  if (isPrivateIp(host)) return false;
  return true;
}

export function buildPushPayload(input: {
  title: string;
  body: string;
  badge?: number;
  kind: 'due_digest' | 'streak_warning';
}): string {
  const payload: { title: string; body: string; url: '/review'; badge?: number; kind: string } = {
    title: input.title.slice(0, 120),
    body: input.body,
    url: '/review',
    kind: input.kind,
  };
  if (typeof input.badge === 'number' && Number.isFinite(input.badge)) payload.badge = input.badge;
  let text = JSON.stringify(payload);
  if (text.length > MAX_PLAINTEXT) {
    payload.body = payload.body.slice(0, 240);
    text = JSON.stringify(payload);
  }
  return text.length > MAX_PLAINTEXT ? text.slice(0, MAX_PLAINTEXT) : text;
}

export async function deliverWebPush(
  subscription: { endpoint: string; p256dh: string; auth: string },
  payload: string,
): Promise<PushDelivery> {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey || !validSubject(env.VAPID_SUBJECT)) return { ok: false, code: 'push_disabled' };
  if (!pushEndpointAllowed(subscription.endpoint)) return { ok: false, code: 'push_failed' };
  if (payload.length > MAX_PLAINTEXT) return { ok: false, code: 'push_failed' };
  try {
    webpush.setVapidDetails(env.VAPID_SUBJECT, publicKey, privateKey);
    const host = new URL(subscription.endpoint).hostname.toLowerCase();
    const loopback = host === '127.0.0.1' || host === 'localhost';
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
      payload,
      { TTL: 60 * 60, ...(loopback ? { agent: loopbackAgent } : {}) },
    );
    return { ok: true };
  } catch (err) {
    const statusCode = typeof (err as { statusCode?: unknown }).statusCode === 'number'
      ? (err as { statusCode: number }).statusCode
      : undefined;
    if (statusCode === 404 || statusCode === 410) return { ok: false, code: 'gone', statusCode };
    return { ok: false, code: 'push_failed', statusCode };
  }
}

export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}
