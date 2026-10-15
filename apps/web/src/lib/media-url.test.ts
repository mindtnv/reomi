import { describe, expect, test } from 'bun:test';
import { mediaContentUrl, resolveMediaSrc, rewritePrivateMediaHtml } from './media-url';

const ID = '3f29c1a8-5b6e-4d2a-9c10-7e8f4a2b6d11';

describe('private media URLs', () => {
  test('a stored token resolves to the session-checked content route', () => {
    const url = resolveMediaSrc(`/m/${ID}`);
    expect(url).toBe(mediaContentUrl(ID));
    expect(url).toContain(`/media/${ID}/content`);
    expect(url.startsWith('http')).toBe(true);
    expect(url).not.toContain('/m/');
  });

  test('non-tokens are not rewritten into a media read', () => {
    expect(resolveMediaSrc('https://example.com/a.png')).toBe('https://example.com/a.png');
    expect(resolveMediaSrc('/m/not-a-uuid')).toBe('/m/not-a-uuid');
    expect(resolveMediaSrc(`/m/${ID}/extra`)).toBe(`/m/${ID}/extra`);
  });

  test('sanitized html rewrites only img tokens', () => {
    const html = `<p>see /m/${ID}</p><img alt="a" src="/m/${ID}" width="10"><img src='/m/${ID.toUpperCase()}'><img src="https://evil.test/x">`;
    const out = rewritePrivateMediaHtml(html);
    const content = mediaContentUrl(ID);
    expect(out).toContain(`src="${content}"`);
    expect(out).toContain(`src='${content}'`);
    expect(out).toContain(`see /m/${ID}`);
    expect(out).toContain('src="https://evil.test/x"');
    expect(out).not.toContain(`src="/m/${ID}"`);
  });
});
