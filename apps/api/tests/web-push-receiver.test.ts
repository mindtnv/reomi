import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPushPayload, deliverWebPush, generateVapidKeys } from '../src/reminders/web-push.ts';

const hits: { authorization: string; bytes: number }[] = [];
let server: ReturnType<typeof Bun.serve>;
let endpoint = '';

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reomi-push-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  const issued = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath,
    '-out', certPath,
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
    '-days', '1',
  ], { stdio: 'pipe' });
  if (issued.status !== 0) throw new Error(issued.stderr.toString() || 'openssl failed');

  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    tls: {
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
    },
    fetch: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/bounce') {
        hits.push({ authorization: 'redirect', bytes: 0 });
        return new Response(null, {
          status: 302,
          headers: { location: `https://127.0.0.1:${server.port}/stolen` },
        });
      }
      const body = new Uint8Array(await request.arrayBuffer());
      hits.push({
        authorization: request.headers.get('authorization') ?? '',
        bytes: body.byteLength,
      });
      return new Response(null, { status: 201 });
    },
  });
  endpoint = `https://127.0.0.1:${server.port}/push`;
});

afterAll(() => {
  server?.stop(true);
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
});

describe('local web push receiver', () => {
  test('web-push delivers a short VAPID fixture and refuses when the keys are absent', async () => {
    const keys = generateVapidKeys();
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    const auth = crypto.getRandomValues(new Uint8Array(16));
    const payload = buildPushPayload({
      title: 'Reomi',
      body: '1 card is ready. Open /review',
      badge: 1,
      kind: 'due_digest',
    });
    expect(payload.length).toBeLessThan(3072);
    expect(payload).not.toContain('firebase');

    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;
    process.env.VAPID_SUBJECT = 'https://app.reomi.ru';
    const sent = await deliverWebPush(
      { endpoint, p256dh: base64url(raw), auth: base64url(auth) },
      payload,
    );
    expect(sent).toEqual({ ok: true });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.authorization).toContain(keys.publicKey);
    expect(hits[0]!.authorization.startsWith('vapid ')).toBe(true);
    expect(hits[0]!.bytes).toBeGreaterThan(0);
    expect(hits[0]!.bytes).toBeLessThan(4096);

    delete process.env.VAPID_PUBLIC_KEY;
    delete process.env.VAPID_PRIVATE_KEY;
    const refused = await deliverWebPush(
      { endpoint, p256dh: base64url(raw), auth: base64url(auth) },
      payload,
    );
    expect(refused).toEqual({ ok: false, code: 'push_disabled' });
    expect(hits).toHaveLength(1);

    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;
    const before = hits.length;
    const redirected = await deliverWebPush(
      { endpoint: `https://127.0.0.1:${server.port}/bounce`, p256dh: base64url(raw), auth: base64url(auth) },
      payload,
    );
    expect(redirected).toMatchObject({ ok: false, code: 'push_failed', statusCode: 302 });
    expect(hits.slice(before)).toEqual([{ authorization: 'redirect', bytes: 0 }]);
  });
});
