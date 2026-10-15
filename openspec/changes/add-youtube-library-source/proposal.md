# Proposal

## Why

A pasted YouTube link is stored as an ordinary web page. The page reader strips scripts, so the player payload and the caption track never become source text. Cards made from that row cannot open the spoken moment.

## What Changes

- A watch, youtu.be, shorts, embed, or live URL becomes `kind='youtube'` with the canonical `https://www.youtube.com/watch?v=<id>`.
- Ingest reads the watch page and one caption track through the existing public-host fetch guards. Manual captions win over auto-generated captions. The order inside a kind is the video language, then `ru`, then `en`.
- Cue text is chunked with the other document sources. `source_chunks.start_seconds` is the cue time. A card link opens `https://www.youtube.com/watch?v=<id>&t=<seconds>`.
- The same canonical URL for one user returns 409 `duplicate_source` with `existingSourceId` while a non-error row exists.
- No YouTube Data API key. Caption download on that API needs OAuth, so a key would not unlock the transcript. `YOUTUBE_FETCH_TIMEOUT_MS` defaults to 20000.

## Capabilities

### New Capabilities

- `youtube-library-source`: paste or assistant-add a YouTube video, index its captions with timestamps, and open a card citation at that time.

### Modified Capabilities

None. Library URL create, source ingest, and card source links keep their existing contracts for pdf, epub, url, and text.

## Impact

Additive migration `0042_youtube_source.sql` after `0041_study_reminders.sql`. It adds nullable `source_chunks.start_seconds` and partial unique index `sources_youtube_url_uq`. API, web library paste, card source links, and both locale dictionaries change. The API process needs outbound HTTPS to YouTube. A slow or blocked host fails that one source.

Out of scope. No in-app player. No rewrite of existing `kind='url'` rows that already point at YouTube. No playlist ingest. No YouTube Data API and no OAuth. No new MCP tool. `create_url_source` classifies the URL.
