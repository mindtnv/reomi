# Restore rehearsal

## Snapshot

`GET /profile/export` writes schemaVersion 1. The read is one repeatable-read, read-only transaction. The first statement is `select clock_timestamp()`, which pins the PostgreSQL snapshot. Later commits stay outside the file.

The file contains the account id, email, and name, the profile, the study-day policy, reminder choices, deck presets, decks, filtered decks, note types, notes, cards, reviews, and a media manifest. Global builtin note types are included. Push subscription endpoints and storage keys are left out.

Loss window. Commits that land after this snapshot are not in the file. A grade is included with its card state or not at all.

Delivery sets `content-disposition` to an attachment named `reomi-study-export.json`, `cache-control` to `no-store`, and `x-content-type-options` to `nosniff`. A snapshot larger than 32 MiB returns 413 `export_too_large` and no file body.

## Media

Image bytes stay in object storage. The snapshot lists each owned file and rebuilds its key as `media/<id>` on an empty account. It does not copy the bytes. A `/m/<uuid>` token with no owned row is listed in `missingMedia` with reason `not_owned`. A lost bucket is not reconstructed. R2-104 stays open.

## Dry run

`POST /profile/export/rehearse` rebuilds the caller snapshot and returns counts, byte size, schemaVersion, the loss window, the media note, the migration journal head, and elapsed milliseconds. It does not write and it does not return card text.

## Apply

The operator script is `apps/api/scripts/restore-rehearsal.ts`. Without `--apply` it prints the dry-run report for a file. With `--apply` it calls `applyStudySnapshot`.

The process database name must contain `test` or `rehearsal`. The production name `neuronexus` is refused. The refusal text is the database name only.

Apply locks the auth user, then inserts only when that account has no presets, decks, filtered decks, notes, cards, reviews, media, or owned note types. Profile, reminder, and study-day rows that already exist stay as they are. Missing rows are inserted from the file. Original ids are kept. The auth user must already exist. A second apply returns `target_not_empty`. An incoherent file returns `incoherent_snapshot` and writes nothing.

Run from the repo root.

```
NODE_ENV=test bun apps/api/scripts/restore-rehearsal.ts snapshot.json
NODE_ENV=test bun apps/api/scripts/restore-rehearsal.ts snapshot.json --apply
```

Grades go through the process database. This rehearsal uses `neuronexus_test`, then `POST /reviews`. It does not open a second database and it does not call production.

## Measured run

On 2026-10-16 the fixture apply in `neuronexus_test` returned `elapsedMs` 9. The fixture held one preset, one deck, one filtered deck, one note, one card, one review, and one media row. After apply, `POST /reviews` with rating 3 moved that card from 1 rep to 2 reps and stored a second review. The migration journal head in the report was `0044_study_day`.

## Rollback

There is no SQL migration. Roll back by reverting this API commit. Older clients ignore the added JSON fields. schemaVersion 1 inserts into the schema already created through `0044_study_day`. It does not run SQL and it does not roll SQL back.
