// Private media display. Markup and API payloads keep the relative token
// `/m/<uuid>`. That token is not a capability: the browser loads the bytes
// from the API, which checks the Better Auth session and the owner. The
// content URL is stable so the browser's private cache can reuse the bytes.

import { apiBaseURL } from './api';

const MEDIA_TOKEN_RE =
  /^\/m\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function apiBase(): string {
  return apiBaseURL.replace(/\/+$/, '');
}

/** Session-checked bytes for one media id. */
export function mediaContentUrl(mediaId: string): string {
  return `${apiBase()}/media/${mediaId}/content`;
}

/**
 * Turn a stored `/m/<uuid>` token into the authenticated content URL.
 * Anything else is returned unchanged so non-media src values are not rewritten.
 */
export function resolveMediaSrc(src: string): string {
  const match = MEDIA_TOKEN_RE.exec(src.trim());
  if (!match?.[1]) return src;
  return mediaContentUrl(match[1].toLowerCase());
}

const IMG_TOKEN_SRC =
  /(<img\b[^>]*?\bsrc\s*=\s*)(["'])\/m\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\2/gi;

/**
 * Rewrite sanitized `<img src="/m/<uuid>">` to the authenticated content URL.
 * Runs after the allow-list sanitizer, which has already dropped every other
 * image source. Non-img text that mentions the token is left alone.
 */
export function rewritePrivateMediaHtml(html: string): string {
  return html.replace(IMG_TOKEN_SRC, (_match, prefix: string, quote: string, id: string) => {
    return `${prefix}${quote}${mediaContentUrl(id.toLowerCase())}${quote}`;
  });
}
