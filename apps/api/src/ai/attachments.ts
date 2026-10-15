// Chat composer attachments (images + inline text files).
//
// Wire/storage contract (mirrors the mentions pattern):
//   * The client sends `attachments` on the stream body: images reference an
//     ALREADY-uploaded media object by id only (presign→POST→finalize pipeline,
//     same as card images); text files carry their content inline.
//   * The server resolves images against the USER-SCOPED `media` table (token
//     + mime are never trusted from the client; foreign/unverified ids are
//     silently dropped) and persists a `MessageAttachment[]` snapshot on the
//     user row's `attachments` jsonb. The STORED `content` stays clean.
//   * Model-facing content is built at history/turn time: text files become an
//     `<attached_file>` block; images become multimodal `image_url` parts with
//     base64 data URLs (the gateway can't fetch a localhost `/m/...` URL).
//
// Degrade, never crash: vision off (CHAT_VISION='false'), an S3 read failure,
// an over-budget image, or an image older than the replay cap all collapse to
// a text placeholder — the turn always proceeds.

import { and, eq, inArray } from 'drizzle-orm';
import { db, media as mediaTable } from '@reomi/db';
import type { MessageAttachment, MessageAttachmentInput } from '@reomi/shared';
import { getObjectBytes } from '../storage.ts';
import { env } from '../env.ts';
import type { AgentContentPart } from './openai-client.ts';

/** Max attachments per message (server-side backstop; the body schema caps too). */
export const ATTACHMENTS_MAX = 4;
/** Inline text-file content cap (chars) — re-capped server-side. */
export const ATTACHMENT_TEXT_CHARS = 16_000;
/** Attachment display-name cap. */
const ATTACHMENT_NAME_CHARS = 120;
/** How many images (most recent first) replay as real image parts per request. */
export const IMAGE_PARTS_MAX = 4;
/** Per-image byte budget for a data-URL part (pre-base64). */
const IMAGE_PART_MAX_BYTES = 4 * 1024 * 1024;

/** True when image attachments are offered/replayed as vision parts. */
export function isVisionEnabled(): boolean {
  return env.ai.CHAT_VISION !== 'false';
}

function capName(name: string | undefined): string | undefined {
  const trimmed = name?.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, ATTACHMENT_NAME_CHARS);
}

/**
 * Resolve the wire attachments into the persisted snapshot. Images: ONE
 * user-scoped select over `media` (verified rows only) — foreign/missing/
 * unverified ids are dropped, token + mime come from the DB row. Text files:
 * name + content re-capped. Returns `null` when nothing survives.
 */
export async function resolveAttachments(
  userId: string,
  input: MessageAttachmentInput[] | undefined,
): Promise<MessageAttachment[] | null> {
  if (!input || input.length === 0) return null;
  const bounded = input.slice(0, ATTACHMENTS_MAX);
  const imageIds = bounded
    .filter((a): a is Extract<MessageAttachmentInput, { kind: 'image' }> => a.kind === 'image')
    .map((a) => a.mediaId);
  const mediaRows =
    imageIds.length > 0
      ? await db
          .select({ id: mediaTable.id, mime: mediaTable.mime })
          .from(mediaTable)
          .where(
            and(
              eq(mediaTable.userId, userId),
              inArray(mediaTable.id, imageIds),
              eq(mediaTable.verified, true),
            ),
          )
      : [];
  const mediaById = new Map(mediaRows.map((r) => [r.id, r]));

  const out: MessageAttachment[] = [];
  for (const a of bounded) {
    if (a.kind === 'image') {
      const row = mediaById.get(a.mediaId);
      if (!row) continue; // foreign / unverified / missing — dropped, never an error.
      out.push({
        kind: 'image',
        mediaId: row.id,
        token: `/m/${row.id}`,
        mime: row.mime,
        name: capName(a.name),
      });
    } else {
      const name = capName(a.name) ?? 'file.txt';
      const text = (a.text ?? '').slice(0, ATTACHMENT_TEXT_CHARS);
      if (text.trim().length === 0) continue;
      out.push({ kind: 'text', name, text });
    }
  }
  return out.length > 0 ? out : null;
}

/**
 * The model-facing TEXT block for a message's attachments: text files inline
 * (`<attached_file>`), plus a placeholder line for every image that is NOT
 * being sent as a real image part this request (vision off / over the replay
 * cap / failed to load).
 */
export function attachmentTextBlock(
  attachments: MessageAttachment[] | null | undefined,
  imageDataUrls: Map<string, string>,
): string {
  if (!attachments || attachments.length === 0) return '';
  const parts: string[] = [];
  for (const a of attachments) {
    if (a.kind === 'text') {
      parts.push(`<attached_file name="${a.name}">\n${a.text}\n</attached_file>`);
    } else if (!imageDataUrls.has(a.mediaId)) {
      // The media token rides along so the model can EMBED the image into a
      // card field (`![](/m/<uuid>)`) even when it can't see the pixels.
      parts.push(
        `[attached image: ${a.name ?? a.token} — embeddable in a card field as ![](${a.token})]`,
      );
    } else {
      // Visible image part — still surface its media token (the image_url data
      // URL carries pixels, not the reusable reference).
      parts.push(
        `[image "${a.name ?? a.token}" attached — embeddable in a card field as ![](${a.token})]`,
      );
    }
  }
  return parts.length > 0 ? `\n\n${parts.join('\n\n')}` : '';
}

/**
 * Build a user message's model-facing content: the (mention-annotated) text +
 * the attachment text block, plus `image_url` parts for images present in
 * `imageDataUrls`. Returns a plain string when there are no image parts (the
 * common case — and what every existing test asserts on).
 */
export function buildUserContent(
  textContent: string,
  attachments: MessageAttachment[] | null | undefined,
  imageDataUrls: Map<string, string>,
): string | AgentContentPart[] {
  const text = `${textContent}${attachmentTextBlock(attachments, imageDataUrls)}`;
  const imageParts: AgentContentPart[] = [];
  for (const a of attachments ?? []) {
    if (a.kind === 'image') {
      const url = imageDataUrls.get(a.mediaId);
      if (url) imageParts.push({ type: 'image_url', image_url: { url } });
    }
  }
  if (imageParts.length === 0) return text;
  return [{ type: 'text', text }, ...imageParts];
}

// ── Image bytes → data URL (with a test seam) ────────────────────────────────

type ImageLoader = (mediaId: string, mime: string) => Promise<string | null>;

async function loadImageDataUrl(mediaId: string, mime: string): Promise<string | null> {
  try {
    const bytes = await getObjectBytes(`media/${mediaId}`);
    if (bytes.length === 0 || bytes.length > IMAGE_PART_MAX_BYTES) return null;
    return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
  } catch {
    return null; // S3 unreachable / object gone — placeholder text instead.
  }
}

let imageLoader: ImageLoader = loadImageDataUrl;

/** Test seam: override the S3-backed image loader (NODE_ENV=test only). */
export function __setImageLoaderForTests(fake: ImageLoader | null): void {
  imageLoader = fake ?? loadImageDataUrl;
}

/**
 * Load data URLs for the LAST `IMAGE_PARTS_MAX` images across the replayed
 * history (chronological order — `rowsAttachments` oldest-first, the current
 * turn's attachments last). Older images degrade to text placeholders. Failures
 * are dropped (placeholder), never thrown.
 */
export async function loadImagePartsMap(
  rowsAttachments: (MessageAttachment[] | null | undefined)[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!isVisionEnabled()) return out;
  const images: { mediaId: string; mime: string }[] = [];
  for (const atts of rowsAttachments) {
    for (const a of atts ?? []) {
      if (a.kind === 'image') images.push({ mediaId: a.mediaId, mime: a.mime });
    }
  }
  const recent = images.slice(-IMAGE_PARTS_MAX);
  await Promise.all(
    recent.map(async ({ mediaId, mime }) => {
      const url = await imageLoader(mediaId, mime);
      if (url) out.set(mediaId, url);
    }),
  );
  return out;
}
