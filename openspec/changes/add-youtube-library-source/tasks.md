# Tasks

## 1. Canonical URL and captions

- [x] 1.1 Write `packages/shared/src/youtube-source.test.ts` first. It failed with a missing module, then `parseYoutubeUrl`, `pickCaptionTrack`, `formatCueTime`, and the player/timedtext readers made it pass.
- [x] 1.2 Carry `startSeconds` through `chunkDocument` and cover it in `packages/shared/src/kb-chunk-document.test.ts`.

## 2. Ingest and duplicate URL

- [x] 2.1 Add additive migration `0042_youtube_source.sql` from origin/main head `0041_study_reminders`. Nullable `source_chunks.start_seconds` and partial unique index `sources_youtube_url_uq`.
- [x] 2.2 Classify YouTube on inline URL insert, fetch captions with the public-host guards, and map `no_subtitles`, `video_unavailable`, and `fetch_failed`.
- [x] 2.3 Return 409 `duplicate_source` with `existingSourceId` for one user. Allow another user. Allow a new row after `error`.

## 3. Citation

- [x] 3.1 Return `sourceKind`, `sourceUrl`, and `startSeconds` from `GET /cards/:id/sources`.
- [x] 3.2 Open a YouTube card link at `&t=`. Keep the existing `/library/book?chunk=original&pos=0&page=3` href.

## 4. Verification

- [x] 4.1 `bun run spec:validate` passes.
- [x] 4.2 `packages/shared/src/youtube-source.test.ts`, `packages/shared/src/kb-chunk-document.test.ts`, `apps/api/src/ai/youtube-transcript.test.ts`, and `apps/web/src/components/source-peek.test.tsx` pass without a database.
- [x] 4.3 `apps/api/tests/youtube-source.test.ts` passes on the migration chain.
- [x] 4.4 `bun run typecheck` passes.
