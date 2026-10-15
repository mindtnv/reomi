import type { SourceUnit } from '@reomi/shared';
import {
  cuesFromTimedText,
  extractYtInitialPlayerResponse,
  formatCueTime,
  pickCaptionTrack,
  readPlayerCaptionState,
} from '@reomi/shared';
import { env } from '../env.ts';
import { assertPublicHost, validatePageUrl } from './page-reader.ts';

export class YoutubeFetchError extends Error {
  constructor(readonly code: 'fetch_failed' | 'video_unavailable' | 'no_subtitles') {
    super(code);
    this.name = 'YoutubeFetchError';
  }
}

type YoutubeResponse = { status: number; body: string; location?: string };
type YoutubeFetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<YoutubeResponse>;

let fetchImpl: YoutubeFetch | null = null;
let timeoutOverride: number | null = null;

export function __setYoutubeFetchForTests(fn: YoutubeFetch | null): void {
  fetchImpl = fn;
}
export function __setYoutubeTimeoutForTests(ms: number | null): void {
  timeoutOverride = ms;
}

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

// YouTube includes ytInitialPlayerResponse for a browser document and omits it for a bare client.
const YOUTUBE_HEADERS: Record<string, string> = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'accept-language': 'ru,en;q=0.9',
  accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
};

const MAX_BYTES = 2_000_000;
const MAX_REDIRECTS = 3;

export async function fetchYoutubeTranscript(videoId: string): Promise<{
  title: string;
  language?: string;
  units: SourceUnit[];
}> {
  const html = await youtubeGet(`https://www.youtube.com/watch?v=${videoId}`);
  const player = extractYtInitialPlayerResponse(html);
  if (!player) throw new YoutubeFetchError('fetch_failed');
  const state = readPlayerCaptionState(player);
  if (!state.ok) {
    throw new YoutubeFetchError(state.reason === 'video_unavailable' ? 'video_unavailable' : 'fetch_failed');
  }
  const track = pickCaptionTrack(state.tracks, state.language);
  if (!track) throw new YoutubeFetchError('no_subtitles');
  const timed = await youtubeGet(withJson3(track.baseUrl));
  const units = cuesFromTimedText(timed)
    .filter((cue) => cue.text.trim().length > 0)
    .map((cue) => ({
      text: `${formatCueTime(cue.startSeconds)} ${cue.text}`,
      startSeconds: cue.startSeconds,
    }));
  if (units.length === 0) throw new YoutubeFetchError('no_subtitles');
  return {
    title: state.title.trim(),
    language: track.languageCode,
    units,
  };
}

function withJson3(baseUrl: string): string {
  const url = validatePageUrl(baseUrl);
  url.searchParams.set('fmt', 'json3');
  return url.toString();
}

async function youtubeGet(raw: string): Promise<string> {
  let current = raw;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let url: URL;
    try {
      url = validatePageUrl(current);
    } catch {
      throw new YoutubeFetchError('fetch_failed');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!YOUTUBE_HOSTS.has(host)) throw new YoutubeFetchError('fetch_failed');
    try {
      await assertPublicHost(url);
    } catch {
      throw new YoutubeFetchError('fetch_failed');
    }
    const timeout = timeoutOverride ?? env.ai.YOUTUBE_FETCH_TIMEOUT_MS;
    const signal = AbortSignal.timeout(timeout);
    let response: YoutubeResponse;
    try {
      response = fetchImpl ? await fetchImpl(url.toString(), { signal, headers: YOUTUBE_HEADERS }) : await browserFetch(url, signal);
    } catch {
      throw new YoutubeFetchError('fetch_failed');
    }
    if (response.status >= 300 && response.status < 400) {
      if (!response.location || hop === MAX_REDIRECTS) throw new YoutubeFetchError('fetch_failed');
      current = new URL(response.location, url).toString();
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new YoutubeFetchError('fetch_failed');
    if (response.body.length > MAX_BYTES) throw new YoutubeFetchError('fetch_failed');
    return response.body;
  }
  throw new YoutubeFetchError('fetch_failed');
}

async function browserFetch(url: URL, signal: AbortSignal): Promise<YoutubeResponse> {
  const response = await fetch(url, { signal, headers: YOUTUBE_HEADERS, redirect: 'manual' });
  const location = response.headers.get('location') ?? undefined;
  if (response.status >= 300 && response.status < 400) {
    return { status: response.status, body: '', location };
  }
  const reader = response.body?.getReader();
  if (!reader) return { status: response.status, body: '', location };
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const step = await reader.read();
    if (step.done) break;
    size += step.value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new YoutubeFetchError('fetch_failed');
    }
    chunks.push(step.value);
  }
  const body = new TextDecoder().decode(concat(chunks, size));
  return { status: response.status, body, location };
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
