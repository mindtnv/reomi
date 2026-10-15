import { describe, expect, test } from 'bun:test';
import {
  cuesFromTimedText,
  extractYtInitialPlayerResponse,
  formatCueTime,
  parseYoutubeUrl,
  pickCaptionTrack,
  readPlayerCaptionState,
} from './youtube-source';

const ID = 'dQw4w9WgXcQ';
const CANONICAL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

describe('parseYoutubeUrl', () => {
  test('watch, youtu.be, and shorts canonicalize to the same watch URL', () => {
    expect(parseYoutubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12')).toEqual({
      ok: true,
      videoId: ID,
      canonicalUrl: CANONICAL,
    });
    expect(parseYoutubeUrl('https://youtu.be/dQw4w9WgXcQ')).toEqual({
      ok: true,
      videoId: ID,
      canonicalUrl: CANONICAL,
    });
    expect(parseYoutubeUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toEqual({
      ok: true,
      videoId: ID,
      canonicalUrl: CANONICAL,
    });
    expect(parseYoutubeUrl('https://www.youtube.com/embed/dQw4w9WgXcQ')).toEqual({
      ok: true,
      videoId: ID,
      canonicalUrl: CANONICAL,
    });
    expect(parseYoutubeUrl('https://www.youtube.com/live/dQw4w9WgXcQ')).toEqual({
      ok: true,
      videoId: ID,
      canonicalUrl: CANONICAL,
    });
  });

  test('a playlist and a non-YouTube URL are not videos', () => {
    expect(parseYoutubeUrl('https://www.youtube.com/playlist?list=PL123')).toEqual({
      ok: false,
      reason: 'not_a_video',
    });
    expect(parseYoutubeUrl('https://example.com/watch?v=dQw4w9WgXcQ')).toEqual({
      ok: false,
      reason: 'not_youtube',
    });
  });
});

describe('pickCaptionTrack', () => {
  const manualEn = { languageCode: 'en', kind: 'manual' as const, baseUrl: 'https://www.youtube.com/api/timedtext?lang=en' };
  const manualRu = { languageCode: 'ru', kind: 'manual' as const, baseUrl: 'https://www.youtube.com/api/timedtext?lang=ru' };
  const asrRu = { languageCode: 'ru', kind: 'asr' as const, baseUrl: 'https://www.youtube.com/api/timedtext?lang=ru&kind=asr' };
  const asrEn = { languageCode: 'en-US', kind: 'asr' as const, baseUrl: 'https://www.youtube.com/api/timedtext?lang=en' };
  const manualJa = { languageCode: 'ja', kind: 'manual' as const, baseUrl: 'https://www.youtube.com/api/timedtext?lang=ja' };

  test('manual captions beat auto-generated, then content language, ru, en', () => {
    expect(pickCaptionTrack([asrRu, manualEn], 'ru')).toEqual(manualEn);
    expect(pickCaptionTrack([manualEn, manualRu], 'en')).toEqual(manualEn);
    expect(pickCaptionTrack([manualEn, manualRu], 'ja')).toEqual(manualRu);
    expect(pickCaptionTrack([asrEn], 'ja')).toEqual(asrEn);
    expect(pickCaptionTrack([manualJa], 'ja')).toEqual(manualJa);
    expect(pickCaptionTrack([manualJa], 'en')).toBeNull();
  });
});

describe('timed text', () => {
  test('formatCueTime prints m:ss and h:mm:ss', () => {
    expect(formatCueTime(12)).toBe('0:12');
    expect(formatCueTime(65)).toBe('1:05');
    expect(formatCueTime(3723)).toBe('1:02:03');
  });

  test('json3 cues keep the start second and the spoken text', () => {
    const cues = cuesFromTimedText(
      JSON.stringify({
        events: [
          { tStartMs: 12000, segs: [{ utf8: 'Hello' }] },
          { tStartMs: 65000, segs: [{ utf8: 'World' }] },
        ],
      }),
    );
    expect(cues).toEqual([
      { startSeconds: 12, text: 'Hello' },
      { startSeconds: 65, text: 'World' },
    ]);
  });

  test('a player response names an unavailable video and its caption tracks', () => {
    const html = `<html><script>var ytInitialPlayerResponse = ${JSON.stringify({
      playabilityStatus: { status: 'OK' },
      videoDetails: { title: 'Never Gonna' },
      microformat: { playerMicroformatRenderer: { language: 'ru' } },
      captions: {
        playerCaptionsTracklistRenderer: {
          captionTracks: [{ baseUrl: 'https://www.youtube.com/api/timedtext?v=1', languageCode: 'en', kind: 'asr' }],
        },
      },
    })};</script></html>`;
    const player = extractYtInitialPlayerResponse(html);
    expect(readPlayerCaptionState(player)).toEqual({
      ok: true,
      title: 'Never Gonna',
      language: 'ru',
      tracks: [{ languageCode: 'en', kind: 'asr', baseUrl: 'https://www.youtube.com/api/timedtext?v=1' }],
    });
    expect(
      readPlayerCaptionState({ playabilityStatus: { status: 'LOGIN_REQUIRED' } }),
    ).toEqual({ ok: false, reason: 'video_unavailable' });
  });
});
