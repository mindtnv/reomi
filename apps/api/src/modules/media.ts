// Media upload: presign → direct POST to S3 → finalize (M2 Phase 2 + validation
// fix).
//
//   POST /media/presign       → validate {mime,size}, mint a uuid, INSERT a
//                               PENDING (verified=false) row CLAIMING the uuid
//                               under the caller, then presign a POST policy.
//   POST /media/:id/finalize  → SELECT the pending row by (id, userId) — 404 if
//                               it isn't the caller's (so B can't finalize A's
//                               presigned uuid). HEAD for real size + ranged GET
//                               for magic-byte sniff; on size/MIME mismatch
//                               DELETE the object + DELETE the row + 400 (plan
//                               A5); on a missing ContentLength → head_failed
//                               (400, object NOT deleted); else flip verified=true.
//   GET  /media               → list the caller's VERIFIED media rows.
//
// Trust boundary: bytes never flow through Bun (plan Decision A1). The presign
// policy binds size + Content-Type so S3 rejects oversize/wrong-type uploads
// server-side; finalize re-verifies the real bytes (HEAD reports the
// client-declared type, not a sniffed one — plan A6/C-4). SSRF is structurally
// impossible: every storage call targets a key the server itself derived
// (`media/{uuid}`), never a client-supplied URL. The uuid is bound to its owner
// AT PRESIGN (the pending-row insert), closing the cross-user finalize gap.

import { Elysia, t } from 'elysia';
import { and, desc, eq } from 'drizzle-orm';
import { db, media } from '@reomi/db';
import { MAX_MEDIA_BYTES, MEDIA_MIME_ALLOWLIST, newUuidV7 } from '@reomi/shared';
import { authPlugin } from '../auth-plugin.ts';
import { requestLogFromContext } from '../logger.ts';
import { env } from '../env.ts';
import { deleteObject, headSize, presignUpload, sniffMagic } from '../storage.ts';

// Allowed image MIME types — single source of truth in @reomi/shared
// (mirrored on the web pre-check). The server is the security boundary.
const ALLOWED_MIME = new Set<string>(MEDIA_MIME_ALLOWLIST);

// Hard upload ceiling: env override, falling back to the shared default.
const MAX_BYTES = Number.isFinite(env.MAX_MEDIA_BYTES) ? env.MAX_MEDIA_BYTES : MAX_MEDIA_BYTES;

/** Map a Postgres unique-violation (code 23505) to a clean 409 (defense in depth). */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

/** Ext-free, userId-free S3 key for a media uuid (plan C-1/A7). */
function keyFor(mediaId: string): string {
  return `media/${mediaId}`;
}

/**
 * Verify the first bytes are a real image of one of the allowed types
 * (plan A6/C-4). HEAD reports the client-set Content-Type, which is untrusted;
 * the magic bytes are the source of truth.
 *   PNG : 89 50 4E 47
 *   JPEG: FF D8 FF
 *   GIF : 47 49 46 ("GIF")
 *   WebP: 52 49 46 46 ("RIFF") .... 57 45 42 50 ("WEBP" at offset 8)
 */
function detectImageMime(bytes: Uint8Array): string | null {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

export const mediaModule = new Elysia({ prefix: '/media' })
  .use(authPlugin)
  // Mint a uuid, CLAIM it under the caller with a pending (verified=false) row,
  // then presign a POST policy. Binding the uuid to its owner here is what makes
  // a cross-user finalize impossible (finalize SELECTs by (id, userId)).
  .post(
    '/presign',
    async (context) => {
      const { user, body, status } = context;
      const log = requestLogFromContext(context);
      if (!ALLOWED_MIME.has(body.mime)) return status(400, { error: 'bad_mime' });
      if (body.size < 1 || body.size > MAX_BYTES) {
        return status(400, { error: 'too_large' });
      }

      const mediaId = newUuidV7();
      const key = keyFor(mediaId);

      // Claim the uuid: insert a pending row BEFORE presigning. The
      // client-declared mime/size are provisional — finalize overwrites them with
      // the sniffed mime + real HEAD size. The unique s3Key + (random) uuid make
      // a collision practically impossible; map one to a clean 409 anyway.
      try {
        await db.insert(media).values({
          id: mediaId,
          userId: user.id,
          s3Key: key,
          mime: body.mime,
          size: body.size,
          verified: false,
        });
      } catch (err) {
        if (isUniqueViolation(err)) return status(409, { error: 'media_conflict' });
        throw err;
      }

      // Cap on the policy is the global ceiling — the client-declared `size` is
      // just a fast pre-check; S3 enforces the real upper bound.
      const upload = await presignUpload(key, body.mime, MAX_BYTES);

      log.debug(
        { mediaId, userId: user.id, mime: body.mime, size: body.size },
        'media.presign',
      );

      return { mediaId, token: `/m/${mediaId}`, upload };
    },
    {
      auth: true,
      body: t.Object({
        mime: t.String({ maxLength: 128 }),
        size: t.Integer({ minimum: 0 }),
      }),
    },
  )
  // Verify the uploaded object and mark the (already-claimed) row verified.
  // SELECT by (id, userId): a uuid the caller didn't presign → 404, so user B
  // can NEVER finalize user A's presigned uuid. Idempotent: a second call on an
  // already-verified row returns it unchanged.
  .post(
    '/:id/finalize',
    async (context) => {
      const { user, params, status } = context;
      const log = requestLogFromContext(context);
      const mediaId = params.id;
      const key = keyFor(mediaId);

      // Ownership binding: only the pending row this user claimed at presign is
      // finalizable. Not found (never presigned, or presigned by another user)
      // → 404 (no information leak about which case it is).
      const [pending] = await db
        .select()
        .from(media)
        .where(and(eq(media.id, mediaId), eq(media.userId, user.id)))
        .limit(1);
      if (!pending) return status(404, { error: 'not_found' });

      // Idempotency: an already-verified row is returned as-is.
      if (pending.verified) return pending;

      // Real size via HEAD (plan C-4).
      let size: number | undefined;
      try {
        size = await headSize(key);
      } catch {
        // No object at the key (upload never happened / wrong id). The pending
        // row stays so a retry after the real upload still works.
        return status(400, { error: 'not_uploaded' });
      }
      // A missing ContentLength is a HEAD failure, NOT an over-cap object — do
      // NOT delete a possibly-good object (validation fix #4).
      if (size === undefined) {
        return status(400, { error: 'head_failed' });
      }
      // > ceiling (or empty) → delete the object + the pending row + 400 (A5).
      if (size < 1 || size > MAX_BYTES) {
        await deleteObject(key);
        await db.delete(media).where(and(eq(media.id, mediaId), eq(media.userId, user.id)));
        return status(400, { error: 'too_large' });
      }

      // Magic-byte sniff via ranged GET (plan C-4). Not a real image → delete the
      // object + the pending row + 400.
      const bytes = await sniffMagic(key);
      const sniffedMime = detectImageMime(bytes);
      if (!sniffedMime) {
        await deleteObject(key);
        await db.delete(media).where(and(eq(media.id, mediaId), eq(media.userId, user.id)));
        return status(400, { error: 'bad_image' });
      }

      // Mark verified, overwriting the provisional mime/size with the sniffed
      // mime + real HEAD size. `media.id === {uuid}` so `/m/{uuid}` maps 1:1.
      const [row] = await db
        .update(media)
        .set({ mime: sniffedMime, size, verified: true })
        .where(and(eq(media.id, mediaId), eq(media.userId, user.id)))
        .returning();

      log.info(
        { mediaId, userId: user.id, mime: sniffedMime, size },
        'media.finalize',
      );

      return row!;
    },
    {
      auth: true,
      params: t.Object({ id: t.String({ format: 'uuid' }) }),
    },
  )
  // List the caller's VERIFIED media, newest first. Pending (unverified) rows are
  // never surfaced — they're claims awaiting upload + finalize.
  .get(
    '/',
    async ({ user }) => {
      const rows = await db
        .select()
        .from(media)
        .where(and(eq(media.userId, user.id), eq(media.verified, true)))
        .orderBy(desc(media.createdAt));
      return { items: rows };
    },
    { auth: true },
  );
