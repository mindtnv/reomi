import { createRequire } from 'node:module';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
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

const PUSH_HOST_SUFFIXES = [
  'fcm.googleapis.com',
  'push.services.mozilla.com',
  'push.apple.com',
  'notify.windows.com',
];

type LookupFn = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<Array<{ address: string; family: number }>>;

let lookupImpl: LookupFn = (hostname, options) => dnsLookup(hostname, options);

/** Tests inject DNS so a private answer is rejected before any push request. */
export function __setDnsLookupForTests(fn: LookupFn | null): void {
  lookupImpl = fn ?? ((hostname, options) => dnsLookup(hostname, options));
}

function ipv4Private(a: number, b: number, c: number, d: number): boolean {
  if ([a, b, c, d].some((part) => part > 255)) return true;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function parseDottedIpv4(host: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return null;
  return parts as [number, number, number, number];
}

function expandIpv6(raw: string): number[] | null {
  let text = raw.toLowerCase().replace(/^\[|\]$/g, '');
  if (text.includes('%')) return null;
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const v4 = parseDottedIpv4(dotted[2]!);
    if (!v4) return null;
    const hi = (v4[0] << 8) | v4[1];
    const lo = (v4[2] << 8) | v4[3];
    text = `${dotted[1]}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parseSide = (side: string): string[] | null => {
    if (side === '') return [];
    const groups = side.split(':');
    if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
    return groups;
  };
  const head = parseSide(halves[0] ?? '');
  if (!head) return null;
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    return head.map((group) => Number.parseInt(group, 16));
  }
  const tail = parseSide(halves[1] ?? '');
  if (!tail) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...Array.from({ length: missing }, () => '0'), ...tail]
    .map((group) => Number.parseInt(group, 16));
}

function embeddedV4Private(hi: number, lo: number): boolean {
  return ipv4Private((hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255);
}

function ipv6Private(groups: number[]): boolean {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number, number, number, number, number, number, number, number,
  ];
  if (groups.every((group) => group === 0) || (g6 === 0 && g7 === 1 && groups.slice(0, 6).every((group) => group === 0))) {
    return true;
  }
  if ((g0 & 0xfe00) === 0xfc00) return true;
  if ((g0 & 0xffc0) === 0xfe80) return true;
  if ((g0 & 0xffc0) === 0xfec0) return true;
  if ((g0 & 0xff00) === 0xff00) return true;
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return embeddedV4Private(g6, g7);
  }
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return embeddedV4Private(g6, g7);
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return embeddedV4Private(g6, g7);
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0x0001) return embeddedV4Private(g6, g7);
  if (g0 === 0x2002) return embeddedV4Private(g1, g2);
  if (g0 === 0x2001 && g1 === 0) return embeddedV4Private(g6 ^ 0xffff, g7 ^ 0xffff);
  return false;
}

/** Loopback, private, link-local, and the tunneled forms that hide them. */
export function isBlockedPushAddress(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  const v4 = parseDottedIpv4(bare);
  if (v4) return ipv4Private(v4[0], v4[1], v4[2], v4[3]);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(bare)) return true;
  if (!bare.includes(':')) return false;
  const groups = expandIpv6(bare);
  if (!groups) return true;
  return ipv6Private(groups);
}

function bareHost(host: string): string {
  return host.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
}

function pushHostAllowed(host: string): boolean {
  const bare = bareHost(host);
  return PUSH_HOST_SUFFIXES.some((suffix) => bare === suffix || bare.endsWith(`.${suffix}`));
}

function testLoopbackHost(host: string): boolean {
  const bare = bareHost(host);
  return process.env.NODE_ENV === 'test'
    && (bare === '127.0.0.1' || bare === 'localhost' || bare === '::1');
}

/** https endpoints on known push services. Exact loopback is allowed under test. */
export function pushEndpointAllowed(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol !== 'https:') return false;
  const host = bareHost(url.hostname);
  if (testLoopbackHost(host)) return true;
  if (
    host === 'localhost'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.endsWith('.internal')
    || host.endsWith('.home.arpa')
  ) return false;
  if (isBlockedPushAddress(host)) return false;
  if (host.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
  return pushHostAllowed(host);
}

async function resolvesToPublicHost(host: string): Promise<boolean> {
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookupImpl(host, { all: true, verbatim: true });
  } catch {
    return false;
  }
  return addresses.length > 0 && addresses.every((entry) => !isBlockedPushAddress(entry.address));
}

function guardedAgent(): https.Agent {
  return new https.Agent({
    keepAlive: false,
    lookup(hostname, options, callback) {
      const done = (typeof options === 'function' ? options : callback) as (
        err: Error | null,
        address?: string | Array<{ address: string; family: number }>,
        family?: number,
      ) => void;
      const all = typeof options === 'object' && options !== null && 'all' in options && Boolean(options.all);
      lookupImpl(hostname, { all: true, verbatim: true }).then((addresses) => {
        if (addresses.length === 0 || addresses.some((entry) => isBlockedPushAddress(entry.address))) {
          done(new Error('blocked push address'));
          return;
        }
        if (all) {
          done(null, addresses);
          return;
        }
        const first = addresses[0];
        if (!first) {
          done(new Error('blocked push address'));
          return;
        }
        done(null, first.address, first.family);
      }).catch((err: unknown) => {
        done(err instanceof Error ? err : new Error('lookup failed'));
      });
    },
  });
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
  const host = bareHost(new URL(subscription.endpoint).hostname);
  const loopback = testLoopbackHost(host);
  if (!loopback && !await resolvesToPublicHost(host)) return { ok: false, code: 'push_failed' };
  const agent = loopback ? loopbackAgent : guardedAgent();
  try {
    webpush.setVapidDetails(env.VAPID_SUBJECT, publicKey, privateKey);
    // web-push uses node:https, which does not follow redirects. A 3xx is push_failed.
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
      payload,
      { TTL: 60 * 60, agent },
    );
    return { ok: true };
  } catch (err) {
    const statusCode = typeof (err as { statusCode?: unknown }).statusCode === 'number'
      ? (err as { statusCode: number }).statusCode
      : undefined;
    if (statusCode === 404 || statusCode === 410) return { ok: false, code: 'gone', statusCode };
    return { ok: false, code: 'push_failed', statusCode };
  } finally {
    if (agent !== loopbackAgent) agent.destroy();
  }
}

export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}
