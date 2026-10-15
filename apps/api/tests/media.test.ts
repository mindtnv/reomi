import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { db, media } from '@reomi/db';
import { newUuidV7 } from '@reomi/shared';
import { buildApp } from '../src/app.ts';
import { env } from '../src/env.ts';
import {
  __setMediaObjectLengthForTests,
  __setMediaObjectReaderForTests,
} from '../src/storage.ts';
import { callApp, resetTestDb, seedBasicCard, signUpAndCookie, uniqueEmail } from './helpers.ts';
import { s3RoundTrip } from './s3-test-gate.ts';

const app = buildApp();

// Minimal valid 1x1 PNG — first bytes are the PNG magic number, so it passes the
// finalize magic-byte sniff. Used for the real round-trip.
const PNG_1X1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44,
  0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d,
  0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
  0x60, 0x82,
]);

type PresignBody = {
  mediaId: string;
  token: string;
  upload: { url: string; fields: Record<string, string> };
};

/** POST the presigned multipart form directly to S3. Returns the HTTP status. */
async function uploadToS3(
  upload: { url: string; fields: Record<string, string> },
  bytes: Uint8Array,
  contentType: string,
  fileType = contentType,
): Promise<number> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(upload.fields)) fd.append(k, v);
  // Allow the caller to mismatch the form Content-Type for the rejection test.
  fd.set('Content-Type', contentType);
  fd.append('file', new Blob([bytes], { type: fileType }));
  const res = await fetch(upload.url, { method: 'POST', body: fd });
  return res.status;
}

const OWNED_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x09, 0x09, 0x09,
]);

async function insertMedia(
  userId: string,
  verified: boolean,
  size = OWNED_BYTES.byteLength,
): Promise<string> {
  const id = newUuidV7();
  await db.insert(media).values({
    id,
    userId,
    s3Key: `media/${id}`,
    mime: 'image/png',
    size,
    verified,
  });
  return id;
}

async function fetchContent(
  id: string,
  cookie?: string,
  headers?: Record<string, string>,
): Promise<{ status: number; headers: Headers; bytes: Uint8Array }> {
  const res = await app.handle(
    new Request(`http://localhost/media/${id}/content`, {
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(headers ?? {}),
      },
    }),
  );
  return { status: res.status, headers: res.headers, bytes: new Uint8Array(await res.arrayBuffer()) };
}

describe('media', () => {
  beforeEach(async () => {
    await resetTestDb();
    __setMediaObjectReaderForTests(null);
    __setMediaObjectLengthForTests(null);
  });

  afterEach(() => {
    __setMediaObjectReaderForTests(null);
    __setMediaObjectLengthForTests(null);
  });

  test('POST /media/presign returns mediaId, token, and upload policy', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const res = await callApp(app, 'POST', '/media/presign', {
      cookie,
      body: { mime: 'image/png', size: 1024 },
    });
    expect(res.status).toBe(200);
    const body = await res.json<PresignBody>();
    expect(body.mediaId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(body.token).toBe(`/m/${body.mediaId}`);
    expect(typeof body.upload.url).toBe('string');
    expect(body.upload.fields['Content-Type']).toBe('image/png');
    // Key is ext-free `media/{uuid}` (C-1/A7) and carries no userId.
    expect(body.upload.fields.key).toBe(`media/${body.mediaId}`);
  });

  test('POST /media/presign rejects a disallowed mime → 400 bad_mime', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const res = await callApp(app, 'POST', '/media/presign', {
      cookie,
      body: { mime: 'application/pdf', size: 1024 },
    });
    expect(res.status).toBe(400);
    expect(await res.json<{ error: string }>()).toEqual({ error: 'bad_mime' });
  });

  test('POST /media/presign rejects an oversize declaration → 400 too_large', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const res = await callApp(app, 'POST', '/media/presign', {
      cookie,
      body: { mime: 'image/png', size: env.MAX_MEDIA_BYTES + 1 },
    });
    expect(res.status).toBe(400);
    expect(await res.json<{ error: string }>()).toEqual({ error: 'too_large' });
  });

  test('POST /media/presign rejects a zero-size declaration → 400 too_large', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const res = await callApp(app, 'POST', '/media/presign', {
      cookie,
      body: { mime: 'image/png', size: 0 },
    });
    expect(res.status).toBe(400);
    expect(await res.json<{ error: string }>()).toEqual({ error: 'too_large' });
  });

  test('media endpoints require auth', async () => {
    const res = await callApp(app, 'POST', '/media/presign', {
      body: { mime: 'image/png', size: 1024 },
    });
    expect(res.status).toBe(401);
  });

  s3RoundTrip('full presign → POST → finalize happy path', async () => {
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const presign = await (
      await callApp(app, 'POST', '/media/presign', {
        cookie,
        body: { mime: 'image/png', size: PNG_1X1.length },
      })
    ).json<PresignBody>();

    const uploadStatus = await uploadToS3(presign.upload, PNG_1X1, 'image/png');
    expect(uploadStatus).toBe(204);

    const finalize = await callApp(app, 'POST', `/media/${presign.mediaId}/finalize`, {
      cookie,
    });
    expect(finalize.status).toBe(200);
    const row = await finalize.json<{
      id: string;
      userId: string;
      s3Key: string;
      mime: string;
      size: number;
    }>();
    expect(row.id).toBe(presign.mediaId);
    expect(row.userId).toBe(userId);
    expect(row.s3Key).toBe(`media/${presign.mediaId}`);
    expect(row.mime).toBe('image/png');
    expect(row.size).toBe(PNG_1X1.length);

    // Presigned POST still writes while anonymous GetObject stays closed.
    const anonymousObject = await fetch(
      `${env.S3_PUBLIC_BASE_URL}/media/${presign.mediaId}`,
    );
    expect(anonymousObject.status).not.toBe(200);
    expect([401, 403, 404]).toContain(anonymousObject.status);

    // Idempotent: a second finalize returns the same row, not a duplicate.
    const again = await callApp(app, 'POST', `/media/${presign.mediaId}/finalize`, {
      cookie,
    });
    expect(again.status).toBe(200);
    expect((await again.json<{ id: string }>()).id).toBe(presign.mediaId);

    // The row shows up in the user's scoped list.
    const list = await (
      await callApp(app, 'GET', '/media', { cookie })
    ).json<{ items: Array<{ id: string }> }>();
    expect(list.items.map((m) => m.id)).toContain(presign.mediaId);
  });

  s3RoundTrip('finalize deletes the object + 400 when bytes are not a real image', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const presign = await (
      await callApp(app, 'POST', '/media/presign', {
        cookie,
        body: { mime: 'image/png', size: 8 },
      })
    ).json<PresignBody>();

    // Upload non-image bytes under the (signed) image/png Content-Type — the
    // policy only binds the type, not the body, so S3 accepts it; finalize's
    // magic-byte sniff is the real gate.
    const junk = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
    const uploadStatus = await uploadToS3(presign.upload, junk, 'image/png');
    expect(uploadStatus).toBe(204);

    const finalize = await callApp(app, 'POST', `/media/${presign.mediaId}/finalize`, {
      cookie,
    });
    expect(finalize.status).toBe(400);
    expect(await finalize.json<{ error: string }>()).toEqual({ error: 'bad_image' });

    // bad_image deletes BOTH the object (A5) and the pending claim row, so a
    // re-finalize finds no row → 404 not_found (the uuid is fully reclaimable).
    const retry = await callApp(app, 'POST', `/media/${presign.mediaId}/finalize`, {
      cookie,
    });
    expect(retry.status).toBe(404);
    expect(await retry.json<{ error: string }>()).toEqual({ error: 'not_found' });

    // No verified row was persisted.
    const list = await (
      await callApp(app, 'GET', '/media', { cookie })
    ).json<{ items: unknown[] }>();
    expect(list.items).toEqual([]);
  });

  s3RoundTrip('S3 rejects a Content-Type that does not match the signed policy', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const presign = await (
      await callApp(app, 'POST', '/media/presign', {
        cookie,
        body: { mime: 'image/png', size: PNG_1X1.length },
      })
    ).json<PresignBody>();
    // Signed for image/png; POST with image/jpeg → S3 403 (server-side bind).
    const uploadStatus = await uploadToS3(presign.upload, PNG_1X1, 'image/jpeg');
    expect(uploadStatus).toBe(403);
  });

  test('finalize on a never-uploaded id → 400 not_uploaded', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const presign = await (
      await callApp(app, 'POST', '/media/presign', {
        cookie,
        body: { mime: 'image/png', size: 1024 },
      })
    ).json<PresignBody>();
    // No upload happened — finalize finds no object.
    const res = await callApp(app, 'POST', `/media/${presign.mediaId}/finalize`, {
      cookie,
    });
    expect(res.status).toBe(400);
    expect(await res.json<{ error: string }>()).toEqual({ error: 'not_uploaded' });
  });

  s3RoundTrip(
    "cross-user integrity: B finalizing A's presigned uuid → 404; A can still finalize",
    async () => {
      const { cookie: aCookie, userId: aUserId } = await signUpAndCookie(app, uniqueEmail('a'));
      const { cookie: bCookie } = await signUpAndCookie(app, uniqueEmail('b'));

      // A presigns (claims the uuid under A) + uploads the real bytes.
      const presign = await (
        await callApp(app, 'POST', '/media/presign', {
          cookie: aCookie,
          body: { mime: 'image/png', size: PNG_1X1.length },
        })
      ).json<PresignBody>();
      expect(await uploadToS3(presign.upload, PNG_1X1, 'image/png')).toBe(204);

      // B tries to finalize A's presigned uuid. The uuid is bound to A at
      // presign, so B's finalize finds no row under B → 404. B cannot claim A's
      // bytes, and A's own finalize is NOT broken by a stolen unique key.
      const bFinalize = await callApp(
        app,
        'POST',
        `/media/${presign.mediaId}/finalize`,
        { cookie: bCookie },
      );
      expect(bFinalize.status).toBe(404);
      expect(await bFinalize.json<{ error: string }>()).toEqual({ error: 'not_found' });

      // A finalizes their own upload successfully (no s3_key collision from B).
      const aFinalize = await callApp(
        app,
        'POST',
        `/media/${presign.mediaId}/finalize`,
        { cookie: aCookie },
      );
      expect(aFinalize.status).toBe(200);
      expect((await aFinalize.json<{ userId: string }>()).userId).toBe(aUserId);

      // A sees their verified row; B sees nothing.
      const aList = await (
        await callApp(app, 'GET', '/media', { cookie: aCookie })
      ).json<{ items: Array<{ id: string }> }>();
      expect(aList.items.map((m) => m.id)).toContain(presign.mediaId);

      const bList = await (
        await callApp(app, 'GET', '/media', { cookie: bCookie })
      ).json<{ items: unknown[] }>();
      expect(bList.items).toEqual([]);
    },
  );

  test('GET /media excludes unverified (pending) presigned rows', async () => {
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    // Presign claims a pending (verified=false) row but does NOT finalize.
    await callApp(app, 'POST', '/media/presign', {
      cookie,
      body: { mime: 'image/png', size: 1024 },
    });
    // The list returns only verified rows, so the pending claim is hidden.
    const list = await (
      await callApp(app, 'GET', '/media', { cookie })
    ).json<{ items: unknown[] }>();
    expect(list.items).toEqual([]);
  });

  test('private read: owner receives bytes; anonymous and another user do not', async () => {
    const owner = await signUpAndCookie(app, uniqueEmail('owner'));
    const stranger = await signUpAndCookie(app, uniqueEmail('stranger'));
    const ownedId = await insertMedia(owner.userId, true);
    const foreignId = await insertMedia(stranger.userId, true);
    const pendingId = await insertMedia(owner.userId, false);
    const reads: string[] = [];
    const lengths: string[] = [];
    __setMediaObjectLengthForTests(async (key) => {
      lengths.push(key);
      if (key === `media/${ownedId}` || key === `media/${foreignId}`) return OWNED_BYTES.byteLength;
      return undefined;
    });
    __setMediaObjectReaderForTests(async (key) => {
      reads.push(key);
      if (key === `media/${ownedId}` || key === `media/${foreignId}`) return OWNED_BYTES;
      return null;
    });

    const anonymous = await fetchContent(ownedId);
    expect(anonymous.status).toBe(401);
    expect(Buffer.from(anonymous.bytes).equals(Buffer.from(OWNED_BYTES))).toBe(false);
    expect(reads).toEqual([]);

    const foreign = await fetchContent(ownedId, stranger.cookie);
    expect(foreign.status).toBe(404);
    expect(await new Response(foreign.bytes).json()).toEqual({ error: 'not_found' });
    expect(foreign.headers.get('cache-control')).toBe('no-store');
    expect(foreign.headers.get('location')).toBeNull();

    const pending = await fetchContent(pendingId, owner.cookie);
    expect(pending.status).toBe(404);
    expect(foreign.headers.get('cache-control')).toBe(pending.headers.get('cache-control'));
    expect(reads).toEqual([]);

    const missing = await fetchContent(newUuidV7(), owner.cookie);
    expect(missing.status).toBe(404);
    expect(await new Response(missing.bytes).json()).toEqual({ error: 'not_found' });

    const allowed = await fetchContent(ownedId, owner.cookie);
    expect(allowed.status).toBe(200);
    expect(Buffer.from(allowed.bytes).equals(Buffer.from(OWNED_BYTES))).toBe(true);
    expect(allowed.headers.get('content-type')).toBe('image/png');
    expect(allowed.headers.get('cache-control')).toBe('private, max-age=120, must-revalidate');
    expect(allowed.headers.get('cache-control')).not.toContain('public');
    expect(allowed.headers.get('vary')?.toLowerCase()).toBe('cookie');
    expect(allowed.headers.get('etag')).toBe(`"${ownedId}"`);
    expect(allowed.headers.get('location')).toBeNull();
    expect(reads).toEqual([`media/${ownedId}`]);
    expect(lengths).toEqual([`media/${ownedId}`]);

    const ownerSeesForeign = await fetchContent(foreignId, owner.cookie);
    expect(ownerSeesForeign.status).toBe(404);
    expect(reads).toEqual([`media/${ownedId}`]);

    const revalidated = await fetchContent(ownedId, owner.cookie, {
      'if-none-match': `"${ownedId}"`,
    });
    expect(revalidated.status).toBe(304);
    expect(revalidated.bytes.byteLength).toBe(0);
    expect(revalidated.headers.get('cache-control')).toBe('private, max-age=120, must-revalidate');
    expect(reads).toEqual([`media/${ownedId}`]);

    const weak = await fetchContent(ownedId, owner.cookie, {
      'if-none-match': `W/"${ownedId}"`,
    });
    expect(weak.status).toBe(304);
    expect(reads).toEqual([`media/${ownedId}`]);
    expect(lengths).toEqual([`media/${ownedId}`]);
  });

  test('private read refuses an over-cap declared size before storage', async () => {
    const owner = await signUpAndCookie(app, uniqueEmail('huge-row'));
    const id = await insertMedia(owner.userId, true, env.MAX_MEDIA_BYTES + 1);
    const calls: string[] = [];
    __setMediaObjectLengthForTests(async (key) => {
      calls.push(`head:${key}`);
      return OWNED_BYTES.byteLength;
    });
    __setMediaObjectReaderForTests(async (key) => {
      calls.push(`get:${key}`);
      return OWNED_BYTES;
    });
    const res = await fetchContent(id, owner.cookie);
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(calls).toEqual([]);
  });

  test('private read refuses an over-cap object length before buffering', async () => {
    const owner = await signUpAndCookie(app, uniqueEmail('huge-object'));
    const id = await insertMedia(owner.userId, true, 32);
    const reads: string[] = [];
    __setMediaObjectLengthForTests(async () => env.MAX_MEDIA_BYTES + 1);
    __setMediaObjectReaderForTests(async (key) => {
      reads.push(key);
      return OWNED_BYTES;
    });
    const res = await fetchContent(id, owner.cookie);
    expect(res.status).toBe(404);
    expect(await new Response(res.bytes).json()).toEqual({ error: 'not_found' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(reads).toEqual([]);
  });

  test('private read hides a storage failure as not_found', async () => {
    const owner = await signUpAndCookie(app, uniqueEmail('gone'));
    const id = await insertMedia(owner.userId, true);
    __setMediaObjectLengthForTests(async () => OWNED_BYTES.byteLength);
    __setMediaObjectReaderForTests(async () => {
      throw new Error('storage down');
    });
    const res = await fetchContent(id, owner.cookie);
    expect(res.status).toBe(404);
    expect(await new Response(res.bytes).json()).toEqual({ error: 'not_found' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  test('export keeps note tokens and does not publish foreign or public object URLs', async () => {
    const owner = await signUpAndCookie(app, uniqueEmail('export-owner'));
    const stranger = await signUpAndCookie(app, uniqueEmail('export-stranger'));
    await callApp(app, 'GET', '/profile', { cookie: owner.cookie });
    await callApp(app, 'GET', '/profile', { cookie: stranger.cookie });
    const ownedId = await insertMedia(owner.userId, true);
    const foreignId = await insertMedia(stranger.userId, true);
    const deck = await (
      await callApp(app, 'POST', '/decks', { cookie: owner.cookie, body: { name: 'D' } })
    ).json<{ id: string }>();
    await seedBasicCard(app, owner.cookie, {
      deckId: deck.id,
      front: `own ![](/m/${ownedId}) foreign ![](/m/${foreignId})`,
      back: 'answer',
    });

    const exported = await callApp(app, 'GET', '/profile/export', { cookie: owner.cookie });
    expect(exported.status).toBe(200);
    const body = JSON.stringify(await exported.json());
    expect(body).toContain(`/m/${ownedId}`);
    expect(body).toContain(`/m/${foreignId}`);
    expect(body).not.toContain(env.S3_PUBLIC_BASE_URL);
    expect(body).not.toContain('X-Amz-');
    expect(body).not.toContain(`media/${ownedId}`);
    expect(body).not.toContain(`media/${foreignId}`);
    expect(body).not.toContain(env.S3_SECRET_ACCESS_KEY);

    const strangerExport = JSON.stringify(
      await (await callApp(app, 'GET', '/profile/export', { cookie: stranger.cookie })).json(),
    );
    expect(strangerExport).not.toContain(ownedId);
    expect(strangerExport).not.toContain(env.S3_PUBLIC_BASE_URL);

    __setMediaObjectLengthForTests(async (key) =>
      key === `media/${ownedId}` ? OWNED_BYTES.byteLength : undefined,
    );
    __setMediaObjectReaderForTests(async (key) => (key === `media/${ownedId}` ? OWNED_BYTES : null));
    const asStranger = await fetchContent(ownedId, stranger.cookie);
    expect(asStranger.status).toBe(404);
    const asAnonymous = await fetchContent(foreignId);
    expect(asAnonymous.status).toBe(401);
    const asOwner = await fetchContent(ownedId, owner.cookie);
    expect(asOwner.status).toBe(200);
    const ownerForeign = await fetchContent(foreignId, owner.cookie);
    expect(ownerForeign.status).toBe(404);
  });
});
