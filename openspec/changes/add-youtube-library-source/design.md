# Design

## Context

`sources.kind` is text. `SOURCE_KINDS` is the application union. Inline create accepts `{ kind: 'url', title, url }` from the library form and from `create_url_source`. The worker claims `pending`, parses to units, writes `source_chunks`, then embeds or parks.

`readPageCached` cannot supply captions. It prefers Exa when `EXA_API_KEY` is set, and the direct reader drops script tags. Timedtext is XML or JSON, which that reader also rejects. The YouTube client therefore calls `validatePageUrl` and `assertPublicHost` itself and keeps a host allow-list.

A timestamp does not fit `page`. PDF pages and concept-map headings already use `page` and `heading`.

## Goals / Non-Goals

**Goals:**

- One canonical row per user and video while the row is not `error` or `deleting`.
- Caption text with a clock prefix, plus `start_seconds` for the link.
- One failed video leaves the ingest queue able to take the next source.
- No required API key.

**Non-Goals:**

- Playing the video inside Reomi.
- Migrating old `kind='url'` YouTube rows.
- Ingesting a playlist, a channel, or a clip that has no 11-character video id.
- OAuth or a YouTube Data API key.

## Decisions

1. Classify at insert. `parseYoutubeUrl` accepts watch, youtu.be, shorts, embed, and live. The stored URL is `https://www.youtube.com/watch?v=<id>` with `t` removed. A YouTube host without a video id is 400 `invalid_url`. Any other URL stays `kind='url'`.
2. Deduplicate on `(user_id, url)` where `kind='youtube'` and status is not `error` or `deleting`. The insert takes `pg_advisory_xact_lock(hashtextextended(userId || ':' || canonicalUrl, 940))`, then a savepoint, so a unique violation rolls back only that insert and returns the existing id.
3. Fetch `https://www.youtube.com/watch?v=<id>` with a browser user agent, read `ytInitialPlayerResponse`, and request the chosen track with `fmt=json3`. XML `<text start>` remains a fallback. Hosts are limited to youtube.com, www, m, music, and youtube-nocookie. Redirects are manual, at most 3, and each hop is checked again. Bodies stop at 2 MB.
4. `playabilityStatus.status` other than `OK` is `video_unavailable` and timedtext is not requested. `OK` with no preferred track, or cues with no text, is `no_subtitles`. Timeout, DNS failure, a non-public address, and a missing player object are `fetch_failed`.
5. The worker replaces `sources.title` only when the stored title matches `^https?://`. It sets `language` from the chosen track when the column is null. `chunkDocument` copies `startSeconds` from the first unit in the window and clears it on flush.
6. `GET /cards/:id/sources` returns `sourceKind`, `sourceUrl`, and `startSeconds`. The web builds `https://www.youtube.com/watch?v=<id>&t=<seconds>` and opens it with `noopener`. Other kinds stay on `/library/<id>`.

## Risks / Trade-offs

- YouTube can change the player HTML or block a datacenter address. The row becomes `fetch_failed`. The queue continues. A later paste works after the old row is `error`.
- Caption base URLs that leave the allow-list fail closed as `fetch_failed` even when the video itself loaded.
- The partial unique index does not rewrite older `kind='url'` rows. Two representations can exist until the user deletes the old page.

## Migration Plan

`0042_youtube_source.sql` is additive. Apply it with the committed chain. Rollback can leave the column and the index. Old writers ignore `start_seconds`. Deploy the API before web so citation fields are present when the client starts reading them.

## Open Questions

None.
