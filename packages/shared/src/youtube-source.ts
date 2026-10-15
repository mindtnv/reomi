export type YoutubeUrl =
  | { ok: true; videoId: string; canonicalUrl: string }
  | { ok: false; reason: 'not_youtube' }
  | { ok: false; reason: 'not_a_video' };

export type CaptionTrack = {
  languageCode: string;
  kind: 'manual' | 'asr';
  baseUrl: string;
};

export type TimedCue = { startSeconds: number; text: string };

export type PlayerCaptionState =
  | { ok: true; title: string; language?: string; tracks: CaptionTrack[] }
  | { ok: false; reason: 'video_unavailable' | 'unreadable' };

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'www.youtube-nocookie.com',
]);

export function parseYoutubeUrl(raw: string): YoutubeUrl {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: 'not_youtube' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'not_youtube' };
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0];
    return id && VIDEO_ID.test(id) ? canonical(id) : { ok: false, reason: 'not_a_video' };
  }
  if (!YOUTUBE_HOSTS.has(host)) return { ok: false, reason: 'not_youtube' };
  const pathId = /^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})(?:\/|$)/.exec(url.pathname)?.[1];
  if (pathId) return canonical(pathId);
  const watchId = url.searchParams.get('v');
  if (watchId && VIDEO_ID.test(watchId)) return canonical(watchId);
  return { ok: false, reason: 'not_a_video' };
}

function canonical(videoId: string): YoutubeUrl {
  return { ok: true, videoId, canonicalUrl: `https://www.youtube.com/watch?v=${videoId}` };
}

function primaryLanguage(code: string): string {
  return code.toLowerCase().split('-')[0] ?? code.toLowerCase();
}

/** Manual tracks first, then auto-generated. Within a kind, content language, then ru, then en. */
export function pickCaptionTrack(tracks: CaptionTrack[], contentLanguage?: string | null): CaptionTrack | null {
  const preferred = [...new Set(
    [contentLanguage, 'ru', 'en'].filter((code): code is string => Boolean(code)).map(primaryLanguage),
  )];
  for (const kind of ['manual', 'asr'] as const) {
    for (const language of preferred) {
      const hit = tracks.find((track) => track.kind === kind && primaryLanguage(track.languageCode) === language);
      if (hit) return hit;
    }
  }
  return null;
}

export function formatCueTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}

export function cuesFromTimedText(body: string): TimedCue[] {
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return cuesFromJson3(JSON.parse(trimmed));
    } catch {
      return [];
    }
  }
  return cuesFromXml(trimmed);
}

function cuesFromJson3(json: unknown): TimedCue[] {
  const events = Array.isArray((json as { events?: unknown }).events)
    ? (json as { events: unknown[] }).events
    : [];
  const cues: TimedCue[] = [];
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const start = (event as { tStartMs?: unknown }).tStartMs;
    if (typeof start !== 'number' || !Number.isFinite(start)) continue;
    const segs = Array.isArray((event as { segs?: unknown }).segs)
      ? (event as { segs: unknown[] }).segs
      : [];
    const text = segs
      .map((seg) => (seg && typeof seg === 'object' && typeof (seg as { utf8?: unknown }).utf8 === 'string'
        ? (seg as { utf8: string }).utf8
        : ''))
      .join('')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    cues.push({ startSeconds: Math.floor(start / 1000), text });
  }
  return cues;
}

function cuesFromXml(xml: string): TimedCue[] {
  const cues: TimedCue[] = [];
  for (const match of xml.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi)) {
    const start = /(?:^|\s)start="([^"]+)"/i.exec(match[1] ?? '')?.[1];
    const seconds = start == null ? Number.NaN : Number(start);
    if (!Number.isFinite(seconds)) continue;
    const text = decodeXml(match[2] ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    cues.push({ startSeconds: Math.floor(seconds), text });
  }
  return cues;
}

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function extractYtInitialPlayerResponse(html: string): unknown | null {
  const at = html.indexOf('ytInitialPlayerResponse');
  if (at < 0) return null;
  const brace = html.indexOf('{', at);
  if (brace < 0) return null;
  const json = sliceJsonObject(html, brace);
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function sliceJsonObject(source: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const char = source[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return null;
}

export function readPlayerCaptionState(player: unknown): PlayerCaptionState {
  if (!player || typeof player !== 'object') return { ok: false, reason: 'unreadable' };
  const record = player as {
    playabilityStatus?: { status?: unknown };
    videoDetails?: { title?: unknown };
    microformat?: { playerMicroformatRenderer?: { language?: unknown } };
    captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: unknown } };
  };
  const status = record.playabilityStatus?.status;
  if (status !== 'OK') {
    return { ok: false, reason: typeof status === 'string' ? 'video_unavailable' : 'unreadable' };
  }
  const title = typeof record.videoDetails?.title === 'string' ? record.videoDetails.title : '';
  const language = record.microformat?.playerMicroformatRenderer?.language;
  const rawTracks = record.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  const tracks: CaptionTrack[] = [];
  if (Array.isArray(rawTracks)) {
    for (const track of rawTracks) {
      if (!track || typeof track !== 'object') continue;
      const row = track as { baseUrl?: unknown; languageCode?: unknown; kind?: unknown };
      if (typeof row.baseUrl !== 'string' || typeof row.languageCode !== 'string') continue;
      tracks.push({
        languageCode: row.languageCode,
        kind: row.kind === 'asr' ? 'asr' : 'manual',
        baseUrl: row.baseUrl,
      });
    }
  }
  return {
    ok: true,
    title,
    ...(typeof language === 'string' && language ? { language } : {}),
    tracks,
  };
}
