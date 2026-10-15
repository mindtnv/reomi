import { afterEach, expect, test } from 'bun:test';
import { __setDnsLookupForTests } from './page-reader.ts';
import { __setYoutubeFetchForTests, __setYoutubeTimeoutForTests, fetchYoutubeTranscript } from './youtube-transcript.ts';

const VIDEO = 'dQw4w9WgXcQ';
const PUBLIC = [{ address: '142.250.1.1', family: 4 }];

afterEach(() => {
  __setYoutubeFetchForTests(null);
  __setYoutubeTimeoutForTests(null);
  __setDnsLookupForTests(null);
});

function player(body: unknown): string {
  return `<html><script>var ytInitialPlayerResponse = ${JSON.stringify(body)};</script></html>`;
}

function okPlayer(tracks: { baseUrl: string; languageCode: string; kind?: string }[], language = 'ru'): unknown {
  return {
    playabilityStatus: { status: 'OK' },
    videoDetails: { title: 'Never Gonna' },
    microformat: { playerMicroformatRenderer: { language } },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } },
  };
}

test('manual captions in the content language win, and cue text keeps the clock', async () => {
  const calls: string[] = [];
  __setDnsLookupForTests(async () => PUBLIC);
  __setYoutubeFetchForTests(async (url) => {
    calls.push(url);
    if (url.includes('fmt=json3')) {
      return { status: 200, body: JSON.stringify({ events: [{ tStartMs: 12000, segs: [{ utf8: 'Hello' }] }, { tStartMs: 65000, segs: [{ utf8: 'World' }] }] }) };
    }
    return {
      status: 200,
      body: player(okPlayer([
        { baseUrl: 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en', languageCode: 'en' },
        { baseUrl: 'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=ru&kind=asr', languageCode: 'ru', kind: 'asr' },
      ])),
    };
  });
  const transcript = await fetchYoutubeTranscript(VIDEO);
  expect(transcript.title).toBe('Never Gonna');
  expect(transcript.language).toBe('en');
  expect(transcript.units[0]).toEqual({ text: '0:12 Hello', startSeconds: 12 });
  expect(transcript.units[1]).toEqual({ text: '1:05 World', startSeconds: 65 });
  expect(calls.some((url) => url.includes('lang=ru'))).toBe(false);
  expect(calls.some((url) => url.includes('lang=en') && url.includes('fmt=json3'))).toBe(true);
});

test('a private or deleted video does not request timedtext', async () => {
  const calls: string[] = [];
  __setDnsLookupForTests(async () => PUBLIC);
  __setYoutubeFetchForTests(async (url) => {
    calls.push(url);
    return { status: 200, body: player({ playabilityStatus: { status: 'LOGIN_REQUIRED' }, videoDetails: { title: 'Hidden' } }) };
  });
  await expect(fetchYoutubeTranscript(VIDEO)).rejects.toMatchObject({ code: 'video_unavailable' });
  expect(calls).toHaveLength(1);
  expect(calls[0]).toBe(`https://www.youtube.com/watch?v=${VIDEO}`);
});

test('an available video with no ru or en captions is no_subtitles', async () => {
  __setDnsLookupForTests(async () => PUBLIC);
  __setYoutubeFetchForTests(async () => ({
    status: 200,
    body: player(okPlayer([{ baseUrl: 'https://www.youtube.com/api/timedtext?lang=ja', languageCode: 'ja' }], 'ja')),
  }));
  await expect(fetchYoutubeTranscript(VIDEO)).rejects.toMatchObject({ code: 'no_subtitles' });
});

test('a caption URL on a private address is not fetched', async () => {
  const calls: string[] = [];
  __setDnsLookupForTests(async () => PUBLIC);
  __setYoutubeFetchForTests(async (url) => {
    calls.push(url);
    return {
      status: 200,
      body: player(okPlayer([{ baseUrl: 'http://169.254.169.254/latest/meta-data', languageCode: 'en' }])),
    };
  });
  await expect(fetchYoutubeTranscript(VIDEO)).rejects.toMatchObject({ code: 'fetch_failed' });
  expect(calls).toEqual([`https://www.youtube.com/watch?v=${VIDEO}`]);
});

test('a timed-out watch page is fetch_failed', async () => {
  __setDnsLookupForTests(async () => PUBLIC);
  __setYoutubeTimeoutForTests(20);
  __setYoutubeFetchForTests((_url, init) => new Promise((_resolve, reject) => {
    if (init.signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  }));
  await expect(fetchYoutubeTranscript(VIDEO)).rejects.toMatchObject({ code: 'fetch_failed' });
});
