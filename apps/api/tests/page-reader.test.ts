// page-reader.ts unit tests — the `fetch_page` data source (deep research).
//
// No real network: fetch + DNS are injected via `__setPageFetchForTests` /
// `__setDnsLookupForTests`. Covers the SSRF guards (static hostname blocks,
// private-IP literals, private DNS resolution, per-hop redirect re-validation),
// the hand-rolled HTML→text extraction, the Exa /contents mapping, and the
// pagination cache (one crawl per page, however many slices).

import { afterEach, describe, expect, test } from 'bun:test';
import {
  DirectPageReader,
  ExaPageReader,
  extractOgImage,
  htmlToPage,
  readPageCached,
  __resetPageReaderForTests,
  __setDnsLookupForTests,
  __setPageFetchForTests,
  __setPageReaderForTests,
  type PageContent,
} from '../src/ai/page-reader.ts';

const PUBLIC_IP = [{ address: '93.184.216.34', family: 4 }];

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fn, calls };
}

function htmlResponse(html: string, headers: Record<string, string> = {}): Response {
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
  });
}

afterEach(() => {
  __setPageFetchForTests(null);
  __setDnsLookupForTests(null);
  __resetPageReaderForTests();
});

// ── htmlToPage (pure extraction) ──────────────────────────────────────────────

describe('htmlToPage', () => {
  test('extracts title, readable text, list bullets; strips scripts/styles/comments', () => {
    const page = htmlToPage(
      `<html><head><title> My&nbsp;Docs </title><style>.x{color:red}</style></head>
       <body><script>alert(1)</script><!-- hidden -->
       <h1>Intro</h1><p>Hello &amp; welcome.</p>
       <ul><li>first</li><li>second</li></ul></body></html>`,
      'https://docs.example.com/guide',
    );
    expect(page.title).toBe('My Docs');
    expect(page.text).toContain('Intro');
    expect(page.text).toContain('Hello & welcome.');
    expect(page.text).toContain('- first');
    expect(page.text).toContain('- second');
    expect(page.text).not.toContain('alert(1)');
    expect(page.text).not.toContain('color:red');
    expect(page.text).not.toContain('hidden');
  });

  test('collects absolute http(s) links, resolves relative ones, skips js:/mailto:/#', () => {
    const page = htmlToPage(
      `<a href="/api/reference">API</a>
       <a href="https://other.example.org/page">other</a>
       <a href="#section">anchor</a>
       <a href="javascript:void(0)">js</a>
       <a href="mailto:x@y.z">mail</a>
       <a href="/api/reference">dup</a>`,
      'https://docs.example.com/guide/intro',
    );
    expect(page.links).toEqual([
      'https://docs.example.com/api/reference',
      'https://other.example.org/page',
    ]);
  });

  test('decodes numeric + named entities', () => {
    const page = htmlToPage('<p>a &#60; b &#x3E; c &laquo;q&raquo;</p>', 'https://e.com/');
    expect(page.text).toBe('a < b > c «q»');
  });

  test('surfaces og:image as imageUrl (absolute), resolving a relative content URL', () => {
    const page = htmlToPage(
      `<head><meta property="og:image" content="/img/cover.jpg"><title>T</title></head><body>x</body>`,
      'https://docs.example.com/guide/intro',
    );
    expect(page.imageUrl).toBe('https://docs.example.com/img/cover.jpg');
  });

  test('no og:image ⇒ imageUrl undefined', () => {
    const page = htmlToPage('<head><title>T</title></head><body>x</body>', 'https://e.com/');
    expect(page.imageUrl).toBeUndefined();
  });
});

// ── extractOgImage (pure, attribute-ordering tolerant) ────────────────────────

describe('extractOgImage', () => {
  test('content-before-property ordering + absolute URL', () => {
    expect(
      extractOgImage('<meta content="https://cdn.x/c.png" property="og:image">', 'https://e.com/'),
    ).toBe('https://cdn.x/c.png');
  });
  test('twitter:image fallback', () => {
    expect(
      extractOgImage('<meta name="twitter:image" content="https://cdn.x/t.png">', 'https://e.com/'),
    ).toBe('https://cdn.x/t.png');
  });
  test('non-http(s) scheme is rejected', () => {
    expect(
      extractOgImage('<meta property="og:image" content="data:image/png;base64,AAAA">', 'https://e.com/'),
    ).toBeUndefined();
  });
  test('no matching meta ⇒ undefined', () => {
    expect(extractOgImage('<meta name="description" content="x">', 'https://e.com/')).toBeUndefined();
  });
});

// ── DirectPageReader — SSRF guards ────────────────────────────────────────────

describe('DirectPageReader — SSRF guards', () => {
  const reader = new DirectPageReader();

  test.each([
    'ftp://example.com/file',
    'file:///etc/passwd',
    'http://user:pass@example.com/',
    'http://localhost/admin',
    'http://foo.localhost/x',
    'http://printer.local/x',
    'http://metadata.internal/x',
    'http://127.0.0.1:8080/',
    'http://10.0.0.5/',
    'http://172.16.1.1/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://0.0.0.0/',
    'http://[::1]/',
    'http://[fc00::1]/',
    'http://[fe80::1]/',
    'http://[::ffff:10.0.0.1]/',
  ])('blocks %s without any fetch', async (url) => {
    const { fn, calls } = fakeFetch(() => htmlResponse('<p>nope</p>'));
    __setPageFetchForTests(fn);
    await expect(reader.read(url)).rejects.toThrow();
    expect(calls.length).toBe(0);
  });

  test('blocks a hostname that RESOLVES to a private address', async () => {
    const { fn, calls } = fakeFetch(() => htmlResponse('<p>nope</p>'));
    __setPageFetchForTests(fn);
    __setDnsLookupForTests(async () => [{ address: '10.1.2.3', family: 4 }]);
    await expect(reader.read('https://rebind.example.com/')).rejects.toThrow(/private address/);
    expect(calls.length).toBe(0);
  });

  test('blocks a redirect hop into a private target (re-validated per hop)', async () => {
    __setDnsLookupForTests(async () => PUBLIC_IP);
    const { fn, calls } = fakeFetch((url) => {
      if (url === 'https://docs.example.com/start') {
        return new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        });
      }
      return htmlResponse('<p>secret</p>');
    });
    __setPageFetchForTests(fn);
    await expect(reader.read('https://docs.example.com/start')).rejects.toThrow(/not allowed/);
    // Only the first hop was fetched — the private target never was.
    expect(calls.length).toBe(1);
  });

  test('follows a same-class public redirect and returns the final page', async () => {
    __setDnsLookupForTests(async () => PUBLIC_IP);
    const { fn } = fakeFetch((url) => {
      if (url.endsWith('/old')) {
        return new Response(null, { status: 301, headers: { location: '/new' } });
      }
      return htmlResponse('<title>New</title><p>moved here</p>');
    });
    __setPageFetchForTests(fn);
    const page = await reader.read('https://docs.example.com/old');
    expect(page.url).toBe('https://docs.example.com/new');
    expect(page.title).toBe('New');
    expect(page.text).toContain('moved here');
  });

  test('rejects unsupported content types (image/png)', async () => {
    __setDnsLookupForTests(async () => PUBLIC_IP);
    const { fn } = fakeFetch(
      () => new Response('binary', { status: 200, headers: { 'content-type': 'image/png' } }),
    );
    __setPageFetchForTests(fn);
    await expect(new DirectPageReader().read('https://docs.example.com/x.png')).rejects.toThrow(
      /unsupported content type/,
    );
  });

  test('plain-text pages pass through without HTML extraction', async () => {
    __setDnsLookupForTests(async () => PUBLIC_IP);
    const { fn } = fakeFetch(
      () =>
        new Response('line one\n\n\n\nline two', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
    );
    __setPageFetchForTests(fn);
    const page = await new DirectPageReader().read('https://docs.example.com/readme.txt');
    expect(page.text).toBe('line one\n\nline two');
    expect(page.links).toEqual([]);
  });

  test('identifies the direct reader as Reomi', async () => {
    __setDnsLookupForTests(async () => PUBLIC_IP);
    const { fn, calls } = fakeFetch(() => new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }));
    __setPageFetchForTests(fn);
    await new DirectPageReader().read('https://docs.example.com/agent');
    const headers = new Headers(calls[0]!.init?.headers);
    expect(headers.get('user-agent')).toBe('ReomiAgent/1.0 (study assistant; +https://github.com)');
    expect(headers.get('user-agent')).not.toContain('NeuroNexus');
  });
});

// ── ExaPageReader ─────────────────────────────────────────────────────────────

describe('ExaPageReader', () => {
  test('posts urls+text+extras to /contents with the api key; maps text/title/links', async () => {
    const { fn, calls } = fakeFetch(() =>
      Response.json({
        results: [
          {
            url: 'https://docs.example.com/guide',
            title: 'Guide',
            text: 'Deep   content   here.',
            extras: { links: ['https://docs.example.com/api', 'mailto:x@y.z'] },
          },
        ],
        statuses: [{ status: 'success' }],
      }),
    );
    __setPageFetchForTests(fn);
    const page = await new ExaPageReader('exa-key').read('https://docs.example.com/guide');
    expect(page.title).toBe('Guide');
    expect(page.text).toBe('Deep content here.');
    expect(page.links).toEqual(['https://docs.example.com/api']); // mailto filtered

    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe('https://api.exa.ai/contents');
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('exa-key');
    const body = JSON.parse(String(calls[0]!.init?.body)) as {
      urls: string[];
      text: { maxCharacters: number };
      extras: { links: number };
    };
    expect(body.urls).toEqual(['https://docs.example.com/guide']);
    expect(body.text.maxCharacters).toBe(10000);
    expect(body.extras.links).toBeGreaterThan(0);
  });

  test('maps an error status to a thrown error (the tool turns it into ok:false)', async () => {
    const { fn } = fakeFetch(() =>
      Response.json({ results: [], statuses: [{ status: 'error', error: { tag: 'CRAWL_NOT_FOUND' } }] }),
    );
    __setPageFetchForTests(fn);
    await expect(new ExaPageReader('k').read('https://gone.example.com/')).rejects.toThrow(
      /CRAWL_NOT_FOUND/,
    );
  });

  test('still rejects non-http(s) URLs before calling Exa', async () => {
    const { fn, calls } = fakeFetch(() => Response.json({}));
    __setPageFetchForTests(fn);
    await expect(new ExaPageReader('k').read('file:///etc/passwd')).rejects.toThrow();
    expect(calls.length).toBe(0);
  });
});

// ── readPageCached — pagination must not re-crawl ─────────────────────────────

describe('readPageCached', () => {
  test('second read of the same url is served from the cache (one crawl)', async () => {
    let reads = 0;
    const fake = {
      async read(url: string): Promise<PageContent> {
        reads += 1;
        return { url, title: 'T', text: 'cached text', links: [] };
      },
    };
    __setPageReaderForTests(fake);
    const a = await readPageCached('https://docs.example.com/long');
    const b = await readPageCached('https://docs.example.com/long');
    expect(a.text).toBe('cached text');
    expect(b.text).toBe('cached text');
    expect(reads).toBe(1);
  });

  test('throws "not configured" when the reader is forced off', async () => {
    __setPageReaderForTests(null);
    await expect(readPageCached('https://docs.example.com/')).rejects.toThrow(/not configured/);
  });
});
