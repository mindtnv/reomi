import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import { cardSources, db, sourceChunks, sources as sourcesTable } from '@reomi/db';
import { buildApp } from '../src/app.ts';
import { __resetAiClientForTests, __setAiClientForTests } from '../src/ai/openai-client.ts';
import { __resetPageReaderForTests, __setDnsLookupForTests, __setPageReaderForTests } from '../src/ai/page-reader.ts';
import { drainSourceIngest } from '../src/ai/source-ingest.ts';
import { sourceIngestWorkerState } from '../src/runtime-state.ts';
import { __setYoutubeFetchForTests, __setYoutubeTimeoutForTests } from '../src/ai/youtube-transcript.ts';
import { callApp, resetTestDb, seedBasicCard, signUpAndCookie, uniqueEmail } from './helpers.ts';

const app = buildApp();
const VIDEO = 'dQw4w9WgXcQ';
const CANONICAL = `https://www.youtube.com/watch?v=${VIDEO}`;
const PUBLIC = [{ address: '142.250.1.1', family: 4 }];

function player(body: unknown): string {
  return `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(body)};</script></html>`;
}

function captions(title = 'Never Gonna') {
  return {
    playabilityStatus: { status: 'OK' },
    videoDetails: { title },
    microformat: { playerMicroformatRenderer: { language: 'ru' } },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: [{
          baseUrl: 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&kind=asr',
          languageCode: 'en',
          kind: 'asr',
        }],
      },
    },
  };
}

const TIMEDTEXT = JSON.stringify({
  events: [
    { tStartMs: 12000, segs: [{ utf8: 'Hello' }] },
    { tStartMs: 65000, segs: [{ utf8: 'World' }] },
  ],
});

function installCaptions(): void {
  __setDnsLookupForTests(async () => PUBLIC);
  __setYoutubeFetchForTests(async (url) => {
    if (url.includes('fmt=json3')) return { status: 200, body: TIMEDTEXT };
    return { status: 200, body: player(captions()) };
  });
  __setAiClientForTests({
    async embed(texts: string[]) {
      return texts.map(() => {
        const vector = new Array<number>(1536).fill(0);
        vector[0] = 1;
        return vector;
      });
    },
  });
}

async function settle(): Promise<void> {
  await drainSourceIngest({ timeoutMs: 5000 });
  expect(sourceIngestWorkerState.snapshot()).toMatchObject({ active: 0, queued: 0 });
}

async function postUrl(cookie: string, url: string, title = url) {
  return callApp(app, 'POST', '/library/items', { cookie, body: { kind: 'url', title, url } });
}

describe('youtube library sources', () => {
  beforeEach(async () => {
    await resetTestDb();
    __setDnsLookupForTests(async () => PUBLIC);
  });

  afterEach(async () => {
    await drainSourceIngest({ timeoutMs: 1000 });
    __setYoutubeFetchForTests(null);
    __setYoutubeTimeoutForTests(null);
    __setDnsLookupForTests(null);
    __resetPageReaderForTests();
    __resetAiClientForTests();
  });

  test('a pasted watch link is stored canonically and indexed at the cue time', async () => {
    installCaptions();
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const created = await postUrl(cookie, `https://www.youtube.com/watch?v=${VIDEO}&t=44`);
    expect(created.status).toBe(200);
    const source = await created.json<{ id: string; kind: string; url: string }>();
    expect(source.kind).toBe('youtube');
    expect(source.url).toBe(CANONICAL);
    await settle();

    const [row] = await db.select().from(sourcesTable).where(eq(sourcesTable.id, source.id));
    expect(row!.status).toBe('ready');
    expect(row!.title).toBe('Never Gonna');
    expect(row!.language).toBe('en');
    const chunks = await db.select().from(sourceChunks).where(eq(sourceChunks.sourceId, source.id));
    expect(chunks[0]!.startSeconds).toBe(12);
    expect(chunks[0]!.text).toContain('0:12 Hello');

    const deck = await callApp(app, 'POST', '/decks', { cookie, body: { name: 'Deck' } });
    const deckId = (await deck.json<{ id: string }>()).id;
    const card = await seedBasicCard(app, cookie, { deckId, front: 'Cue?', back: 'Hello' });
    await db.insert(cardSources).values({
      userId,
      cardId: card.id,
      sourceId: source.id,
      sourceChunkId: chunks[0]!.id,
    });
    const links = await callApp(app, 'GET', `/cards/${card.id}/sources`, { cookie });
    const body = await links.json<{ items: { sourceKind: string; sourceUrl: string; startSeconds: number }[] }>();
    expect(body.items[0]).toMatchObject({ sourceKind: 'youtube', sourceUrl: CANONICAL, startSeconds: 12 });
  });

  test('a custom title stays, and shorts use the same canonical URL', async () => {
    installCaptions();
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const created = await postUrl(cookie, `https://www.youtube.com/shorts/${VIDEO}`, 'Lecture');
    expect(created.status).toBe(200);
    const source = await created.json<{ id: string; url: string }>();
    expect(source.url).toBe(CANONICAL);
    await settle();
    const [row] = await db.select({ title: sourcesTable.title, status: sourcesTable.status }).from(sourcesTable).where(eq(sourcesTable.id, source.id));
    expect(row).toEqual({ title: 'Lecture', status: 'ready' });
  });

  test('the same video pasted as youtu.be is a duplicate for that user only', async () => {
    installCaptions();
    const first = await signUpAndCookie(app, uniqueEmail('a'));
    const created = await postUrl(first.cookie, `https://youtu.be/${VIDEO}`);
    const source = await created.json<{ id: string }>();
    await settle();
    const again = await postUrl(first.cookie, `https://www.youtube.com/watch?v=${VIDEO}`);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'duplicate_source', existingSourceId: source.id });

    const second = await signUpAndCookie(app, uniqueEmail('b'));
    const other = await postUrl(second.cookie, `https://www.youtube.com/watch?v=${VIDEO}`);
    expect(other.status).toBe(200);
    expect((await other.json<{ id: string }>()).id).not.toBe(source.id);
  });

  test('an error row does not block the same URL', async () => {
    __setYoutubeFetchForTests(async () => ({
      status: 200,
      body: player({ playabilityStatus: { status: 'ERROR' } }),
    }));
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const failed = await postUrl(cookie, CANONICAL);
    const firstId = (await failed.json<{ id: string }>()).id;
    await settle();
    const [row] = await db.select({ status: sourcesTable.status, errorCode: sourcesTable.errorCode }).from(sourcesTable).where(eq(sourcesTable.id, firstId));
    expect(row).toEqual({ status: 'error', errorCode: 'video_unavailable' });

    installCaptions();
    const retry = await postUrl(cookie, `https://youtu.be/${VIDEO}`);
    expect(retry.status).toBe(200);
    expect((await retry.json<{ id: string }>()).id).not.toBe(firstId);
  });

  test('a playlist link is rejected and an ordinary page stays a url source', async () => {
    __setPageReaderForTests({
      async read(url: string) {
        return { url, title: 'Example', text: 'A public page.', links: [] };
      },
    });
    const { cookie, userId } = await signUpAndCookie(app, uniqueEmail());
    const playlist = await postUrl(cookie, 'https://www.youtube.com/playlist?list=PL123');
    expect(playlist.status).toBe(400);
    expect(await playlist.json()).toEqual({ error: 'invalid_url' });
    const page = await postUrl(cookie, 'https://example.com/notes', 'Notes');
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({ kind: 'url', url: 'https://example.com/notes' });
    const rows = await db.select({ kind: sourcesTable.kind }).from(sourcesTable).where(eq(sourcesTable.userId, userId));
    expect(rows.map((row) => row.kind)).toEqual(['url']);
  });

  test('missing captions, a private video, and a private caption host are honest errors', async () => {
    const calls: string[] = [];
    __setYoutubeFetchForTests(async (url) => {
      calls.push(url);
      if (calls.length === 1) {
        return { status: 200, body: player({ playabilityStatus: { status: 'OK' }, videoDetails: { title: 'Silent' }, captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } } }) };
      }
      return { status: 200, body: player({ playabilityStatus: { status: 'LOGIN_REQUIRED' } }) };
    });
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const silent = await postUrl(cookie, CANONICAL);
    await settle();
    const silentId = (await silent.json<{ id: string }>()).id;
    const [silentRow] = await db.select({ errorCode: sourcesTable.errorCode }).from(sourcesTable).where(eq(sourcesTable.id, silentId));
    expect(silentRow!.errorCode).toBe('no_subtitles');

    const hidden = await postUrl(cookie, 'https://www.youtube.com/watch?v=abcdefghijk');
    await settle();
    const hiddenId = (await hidden.json<{ id: string }>()).id;
    const [hiddenRow] = await db.select({ errorCode: sourcesTable.errorCode }).from(sourcesTable).where(eq(sourcesTable.id, hiddenId));
    expect(hiddenRow!.errorCode).toBe('video_unavailable');
    expect(calls.every((url) => !url.includes('timedtext'))).toBe(true);

    calls.length = 0;
    __setYoutubeFetchForTests(async (url) => {
      calls.push(url);
      return {
        status: 200,
        body: player({
          playabilityStatus: { status: 'OK' },
          videoDetails: { title: 'Trap' },
          captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ baseUrl: 'http://169.254.169.254/latest/meta-data', languageCode: 'en' }] } },
        }),
      };
    });
    const trap = await postUrl(cookie, 'https://www.youtube.com/watch?v=abcde123456');
    await settle();
    const trapId = (await trap.json<{ id: string }>()).id;
    const [trapRow] = await db.select({ errorCode: sourcesTable.errorCode }).from(sourcesTable).where(eq(sourcesTable.id, trapId));
    expect(trapRow!.errorCode).toBe('fetch_failed');
    expect(calls).toEqual(['https://www.youtube.com/watch?v=abcde123456']);
  });

  test('a timed-out video does not block the next source', async () => {
    installCaptions();
    __setYoutubeTimeoutForTests(20);
    __setYoutubeFetchForTests((_url, init) => new Promise((_resolve, reject) => {
      if (init.signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const { cookie } = await signUpAndCookie(app, uniqueEmail());
    const video = await postUrl(cookie, CANONICAL);
    const videoId = (await video.json<{ id: string }>()).id;
    const text = await callApp(app, 'POST', '/library/items', {
      cookie,
      body: { kind: 'text', title: 'Notes', text: 'A paragraph that can be indexed after the video times out.' },
    });
    const textId = (await text.json<{ id: string }>()).id;
    await settle();
    const rows = await db.select({ id: sourcesTable.id, status: sourcesTable.status, errorCode: sourcesTable.errorCode }).from(sourcesTable);
    expect(rows.find((row) => row.id === videoId)).toMatchObject({ status: 'error', errorCode: 'fetch_failed' });
    expect(rows.find((row) => row.id === textId)?.status).toBe('ready');
  });
});
