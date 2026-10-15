# Spec Delta

## Purpose

Store a YouTube video as a library source, index its captions with timestamps, and open a card citation at the spoken moment.

## ADDED Requirements

### Requirement: Canonical YouTube source
The system SHALL accept a YouTube watch URL, a `youtu.be` URL, a shorts URL, an embed URL, and a live URL through the existing library URL create and through `create_url_source`. The stored row SHALL use `kind='youtube'` and URL `https://www.youtube.com/watch?v=<id>`. Query parameters other than the video id, including `t`, SHALL NOT be stored. A YouTube host that does not contain an 11-character video id SHALL be rejected with 400 `invalid_url` and SHALL NOT insert a row. A non-YouTube http(s) URL SHALL remain `kind='url'`.

#### Scenario: Shorts and watch are one video
- **WHEN** the user pastes `https://www.youtube.com/shorts/dQw4w9WgXcQ`
- **THEN** the row kind is `youtube` and the stored URL is `https://www.youtube.com/watch?v=dQw4w9WgXcQ`

#### Scenario: Playlist
- **WHEN** the user pastes `https://www.youtube.com/playlist?list=PL123`
- **THEN** the response is 400 `invalid_url` and no source row exists

#### Scenario: Ordinary page
- **WHEN** the user pastes `https://example.com/notes`
- **THEN** the row kind is `url` and the stored URL is unchanged

### Requirement: Caption ingest
Ingest SHALL fetch the watch page and one caption track through `validatePageUrl` and `assertPublicHost`, plus a YouTube host allow-list. Manual captions SHALL be preferred over auto-generated captions. Within a kind, the video content language SHALL be preferred, then `ru`, then `en`. Cue text SHALL include a clock prefix, and each chunk SHALL keep `start_seconds` from the first cue in that chunk. The worker SHALL replace the source title with the fetched title only when the stored title is an http(s) URL. It SHALL set `language` from the chosen track when that column is null.

An available video with no preferred track, or with no cue text, SHALL end as `error` / `no_subtitles`. A playability status other than `OK` SHALL end as `error` / `video_unavailable` and SHALL NOT request timedtext. A timeout, an unreachable host, a missing player payload, or a caption URL that fails the public-host or allow-list check SHALL end as `error` / `fetch_failed`. That failure SHALL NOT stop a later source in the ingest queue. No YouTube Data API key SHALL be required. `YOUTUBE_FETCH_TIMEOUT_MS` SHALL default to 20000.

#### Scenario: Captions become chunks
- **WHEN** a video has an English auto-generated track and the pasted title is the watch URL
- **THEN** the source reaches `ready` when embeddings are available, the title is the player title, and a chunk contains `0:12` plus `start_seconds` 12 for a cue that starts at 12 seconds

#### Scenario: No subtitles
- **WHEN** the video is playable and has no manual or auto-generated track in the content language, Russian, or English
- **THEN** the source status is `error` and `errorCode` is `no_subtitles`

#### Scenario: Private video
- **WHEN** the player reports `LOGIN_REQUIRED`
- **THEN** the source `errorCode` is `video_unavailable` and timedtext is not requested

#### Scenario: Timeout leaves the queue usable
- **WHEN** the YouTube request exceeds the timeout and the user then adds a text source
- **THEN** the video `errorCode` is `fetch_failed` and the text source still reaches its normal terminal status

#### Scenario: Private caption host
- **WHEN** the selected caption URL is `http://169.254.169.254/latest/meta-data`
- **THEN** that URL is not fetched and the source `errorCode` is `fetch_failed`

### Requirement: One active video per user
The system SHALL reject a second non-error, non-deleting YouTube row with the same canonical URL for the same user with 409 `duplicate_source` and `existingSourceId`. Another user SHALL be allowed to store that URL. A row already in `error` or `deleting` SHALL NOT block a new insert of the same URL.

#### Scenario: Second paste
- **WHEN** the same user pastes the `youtu.be` form after the watch form of the same video has been stored
- **THEN** the response is 409 `duplicate_source` and `existingSourceId` is the first row

#### Scenario: Retry after failure
- **WHEN** the first attempt is `error` and the user pastes the same video again
- **THEN** a new row is created

### Requirement: Timestamp citation
`GET /cards/:id/sources` SHALL include `sourceKind`, `sourceUrl`, and `startSeconds` for a live YouTube chunk. The web SHALL open `https://www.youtube.com/watch?v=<id>&t=<seconds>` when `sourceKind` is `youtube` and `sourceUrl` is set, including when `locationAvailable` is false. A non-YouTube link SHALL stay on `/library/<sourceId>` with its existing query.

#### Scenario: Card link
- **WHEN** a card is linked to a YouTube chunk whose `start_seconds` is 12
- **THEN** the source payload reports `sourceKind` `youtube`, the canonical `sourceUrl`, and `startSeconds` 12, and the client href is `https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=12`
